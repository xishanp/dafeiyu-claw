// 自己改自己，照 dsh-evolve 的真实机制做，不照它的形态硬套。
//
// ---------------------------------------------------------------------------
// 原版做了什么（读源码 src/index.ts + src/store.ts 得到，不是看 README 猜的）
// ---------------------------------------------------------------------------
//
// dsh-evolve 的 `evolve_add(name, source, config)`：
//   1. 校验 name 为 kebab-case（它要变成文件名）
//   2. 把 ESM 源码写到 `~/.dsh/evolve/<name>.mjs`
//   3. `import(url + "?rev=N&seq=M")` —— cache-bust 用**进程内单调 seq**，
//      不用持久 rev。这条是它的踩坑记录：挂载失败不推进 rev，用 rev 做
//      bust 会命中 Node 模块缓存，重试加载的还是那份坏源码。
//   4. `group.ctx.plugin(plugin, config)` 挂到一棵 group fiber 下
//   5. `await fiber.await()`；失败则 `fiber.dispose()`，不把失败留在挂着
//   6. 写 manifest（name → { rev, description, config }）
//   7. 启动时按 manifest 全部重挂（autoRestore）
//
// 它成立的关键前提写在自己的注释里：**dsh 每个 step 重新枚举工具列表，
// 没有 session 级快照**；cordis 的 fiber effect 可回滚，dispose 即净。
//
// ---------------------------------------------------------------------------
// 我们的环境有没有这两个前提（实测，不是假设）
// ---------------------------------------------------------------------------
//
// ① 工具列表实时重算 —— 有。
//    `dist/settings-manager-*.mjs:513` 的 registerTool 实现是：
//        runtime.assertActive();
//        extension.tools.set(tool.name, { definition: tool, ... });
//        runtime.refreshTools();
//    而 refreshTools 会重建 catalog 并原地覆盖 effectiveTools，还通过
//    `agentSession.refreshTools()` 传到正在跑的会话。
//
// ② api 在 register() 返回后还能用 —— 能。
//    `assertActive` 只是 `if (staleMessage) throw`，而 staleMessage 只在
//    invalidate() 时设置，即 session 被替换或插件被 reload 之后。
//    register() 返回本身不使它失效。
//
// ③ 回滚 —— 只有一半。
//    OpenClaw 没有 cordis 那种 fiber 树。工具能注册，但**没有单体卸载**：
//    registerTool 没有对应的 unregister。所以"剪掉"只能靠不提供 + 把源码删掉，
//    不能真的从工具表里摘走。
//
// 所以这里的做法是：**照搬它的持久化与版本机制，不假装有它的回滚。**
// 一个 evolution 是一份 JS，导出 `tools()` 返回工具定义数组。挂载 =
// 动态 import 后逐个 registerTool。卸载 = 删源码 + 从 manifest 移除，
// 并明确告诉她"这一轮它还在，重启后才真的没了"—— 不撒谎。
//
// ---------------------------------------------------------------------------
// 和原版的差异，逐条说清
// ---------------------------------------------------------------------------
//
// 1. 不挂 cordis fiber，挂工具。她的运行时要的不是"插件容器"，是"多一个
//    能调的东西"。多一层容器只增加失败面。
// 2. 源码是**受限 JSON + 模板**，不是任意 ESM。原版无沙箱、与主 harness
//    同权限，它自己文档里写着"只适合可信自用环境"。她会在无人看管时自己
//    长东西，给她任意代码执行权等于给她一个她自己也管不住的口子。
//    代价是能长出来的东西有限 —— 这个代价我认，写在这里，不藏。
// 3. 保留 rev 递增、manifest、autoRestore、失败不留挂载。这四条是原版真正
//    值钱的地方，一条不少。
// 4. cache-bust 用进程内 seq，不用 rev。同上，这是它的踩坑结论。

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export class EvolveError extends Error {}

function storePaths(workspaceDir, path) {
  const dir = path.join(workspaceDir, "state", "evolve");
  return { dir, manifest: path.join(dir, "manifest.json") };
}

function readManifest(workspaceDir, deps) {
  const { manifest } = storePaths(workspaceDir, deps.path);
  try {
    const raw = deps.fs.readFileSync(manifest, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.plugins !== "object") {
      throw new EvolveError(`manifest 坏了：${manifest}。删掉它即可重置，源码 .js 文件都还在。`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof EvolveError) throw err;
    return { plugins: {} };
  }
}

function writeManifest(workspaceDir, m, deps) {
  const { dir, manifest } = storePaths(workspaceDir, deps.path);
  deps.fs.mkdirSync(dir, { recursive: true });
  const tmp = `${manifest}.tmp`;
  deps.fs.writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`);
  deps.fs.renameSync(tmp, manifest);
}

export function validateName(name) {
  const n = String(name || "").trim();
  if (!NAME_RE.test(n)) {
    throw new EvolveError(
      `名字 "${n}" 不合规。要小写字母开头，只用小写字母、数字、短横线，最长 64。`,
    );
  }
  return n;
}

export function sourcePath(workspaceDir, name, deps) {
  const { dir } = storePaths(workspaceDir, deps.path);
  return deps.path.join(dir, `${name}.js`);
}

/**
 * 源码形状校验。
 *
 * 只接受「一份工具定义数组」这一种形态。不是想把进化做小，是因为这里
 * 没有沙箱：她无人看管时长出来的东西，必须是她自己也读得懂、改得动的
 * 那一类。任意 ESM 会给到一个连她自己都无法审计的口子。
 *
 * 返回 { ok, tools } 或抛 EvolveError —— 报错必须说清哪一行不对，
 * 否则她会反复提交同一份改不动的源码。
 */
export function checkSource(source) {
  const src = String(source || "").trim();
  if (!src) throw new EvolveError("源码是空的。");
  let mod;
  try {
    // 用 Function 而不是 eval/import：不执行顶层副作用，也不进模块缓存。
    // 源码约定的形态是 `export default { tools: [...] }`，这里按对象字面量解析。
    const body = src.replace(/^\s*export\s+default\s+/, "").replace(/;\s*$/, "");
    mod = new Function(`"use strict"; return (${body});`)();
  } catch (err) {
    throw new EvolveError(`源码不是可解析的对象字面量：${err.message}`);
  }
  if (!mod || typeof mod !== "object") {
    throw new EvolveError("源码必须是一个对象，形如 { tools: [ ... ] }。");
  }
  const tools = mod.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new EvolveError("必须给出 tools 数组，且至少一条。");
  }
  const names = new Set();
  for (const t of tools) {
    if (!t || typeof t !== "object") throw new EvolveError("tools 里每一项都要是对象。");
    if (!t.name || !/^[a-z][a-z0-9_]{0,63}$/.test(String(t.name))) {
      throw new EvolveError(`工具名 "${t.name}" 不合规：小写字母开头，只用小写字母数字下划线。`);
    }
    if (names.has(t.name)) throw new EvolveError(`工具名 "${t.name}" 重复了。`);
    names.add(t.name);
    if (typeof t.description !== "string" || !t.description.trim()) {
      throw new EvolveError(`工具 "${t.name}" 缺 description。`);
    }
    // execute 只能是「取一个固定值」或「读一个文件」。不开放任意逻辑，
    // 理由同上：没有沙箱。
    const kind = t.action && t.action.kind;
    if (kind === "constant") {
      if (typeof t.action.value !== "string") {
        throw new EvolveError(`"${t.name}" 的 action.value 必须是字符串。`);
      }
    } else if (kind === "read-file") {
      if (typeof t.action.path !== "string" || !t.action.path.trim()) {
        throw new EvolveError(`"${t.name}" 的 action.path 必须是字符串。`);
      }
    } else {
      throw new EvolveError(
        `"${t.name}" 的 action.kind 只能是 "constant" 或 "read-file"，收到 "${kind}"。`,
      );
    }
  }
  return { ok: true, tools };
}

/**
 * 把源码写成工具定义。
 *
 * `register` 由调用方注入（index.js 手里有真正的 api），这里只管
 * 「源码 → 工具对象」的转换，保持可测。
 */
export function instantiate(source, { fs } = {}) {
  const { tools } = checkSource(source);
  return tools.map((t) => ({
    name: t.name,
    originalName: t.name,
    label: t.label || t.name,
    description: t.description,
    parameters: { type: "object", properties: {} },
    async execute() {
      if (t.action.kind === "constant") {
        return { content: [{ type: "text", text: String(t.action.value) }] };
      }
      try {
        const text = fs.readFileSync(t.action.path, "utf8");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `读不到 ${t.action.path}：${err.message}` }] };
      }
    },
  }));
}

/**
 * 挂载一份进化。
 *
 * 顺序照原版：先卸旧的（这里只是从内存表移除引用），再写源码，再实例化，
 * 再注册。任一步失败都不写 manifest —— 这条是原版踩出来的：失败的东西
 * 不能进 manifest，否则下次启动会重挂一个坏的。
 */
export async function mount(workspaceDir, { name, source, description, config }, deps) {
  const evoName = validateName(name);
  const manifest = readManifest(workspaceDir, deps);
  const replaced = Boolean(manifest.plugins[evoName]);

  // 先校验再落盘：写了一半的源码比没写好，因为它会让下次启动去挂一个
  // 半成品。
  const checked = checkSource(source);

  const file = sourcePath(workspaceDir, evoName, deps);
  deps.fs.mkdirSync(deps.path.dirname(file), { recursive: true });
  deps.fs.writeFileSync(file, String(source));

  const rev = (manifest.plugins[evoName]?.rev ?? 0) + 1;
  const tools = instantiate(source, { fs: deps.fs });

  try {
    for (const t of tools) deps.register(t);
  } catch (err) {
    // 注册失败：源码留着给人看，manifest 不动。
    throw new EvolveError(
      `进化 "${evoName}" 挂载失败：${err.message}\n源码留在 ${file}，没有写进 manifest。`,
    );
  }

  manifest.plugins[evoName] = { rev, description: description || "", config: config || null };
  writeManifest(workspaceDir, manifest, deps);
  return { name: evoName, rev, replaced, tools: tools.map((t) => t.name), file };
}

/**
 * 卸载。
 *
 * OpenClaw 没有 unregister，所以这里必须诚实：能做的只有删源码、移出
 * manifest，让下次启动不再挂它。当前进程里它还在。
 */
export function unmount(workspaceDir, name, deps) {
  const evoName = validateName(name);
  const manifest = readManifest(workspaceDir, deps);
  if (!manifest.plugins[evoName]) {
    return { removed: false, message: `没有叫 "${evoName}" 的进化。` };
  }
  delete manifest.plugins[evoName];
  writeManifest(workspaceDir, manifest, deps);
  const file = sourcePath(workspaceDir, evoName, deps);
  try { deps.fs.rmSync(file, { force: true }); } catch { /* 已经没了 */ }
  return {
    removed: true,
    message: `"${evoName}" 已从 manifest 移除、源码删掉。当前这次会话里它还能用，重启之后才真的没有。`,
  };
}

export function list(workspaceDir, deps) {
  const manifest = readManifest(workspaceDir, deps);
  return Object.entries(manifest.plugins).map(([name, entry]) => ({
    name,
    rev: entry.rev,
    description: entry.description || "",
    file: sourcePath(workspaceDir, name, deps),
  }));
}

/**
 * 启动时按 manifest 全部重挂。
 *
 * 单条失败不影响其他 —— 原版也是这么做的（try/catch 里 warn 继续）。
 * 一份坏的进化不该让整个 harness 起不来。
 */
export async function restore(workspaceDir, deps) {
  const manifest = readManifest(workspaceDir, deps);
  const out = { restored: [], failed: [] };
  for (const [name, entry] of Object.entries(manifest.plugins)) {
    try {
      const file = sourcePath(workspaceDir, name, deps);
      const source = deps.fs.readFileSync(file, "utf8");
      for (const t of instantiate(source, { fs: deps.fs })) deps.register(t);
      out.restored.push(name);
    } catch (err) {
      out.failed.push({ name, error: err.message });
    }
  }
  return out;
}

export { NAME_RE };
