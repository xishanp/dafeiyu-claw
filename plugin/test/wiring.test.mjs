import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const INDEX = path.join(import.meta.dirname, "..", "index.js");
const COGNITION = path.join(import.meta.dirname, "..", "lib", "cognition.js");

/**
 * 接线顺序的静态检查。
 *
 * 2026-11-07 09:39 实测：`interoception.compute` 那段被插在了
 * `const result = cognition.cycle(...)` 之前，于是每一轮都报
 * `Cannot access 'result' before initialization`。
 *
 * 单元测试测不到这个：`lib/interoception.js` 单独跑一百次都是对的，
 * 坏的是它在 `index.js` 里的**位置**。而那个位置只有真正跑一轮才会暴露，
 * 一轮要等到下一次心跳。
 *
 * 所以这里直接读源码，检查定义必须先于使用。粗糙，但正是它能抓住的
 * 那一类错：顺序错、插错地方、改动时被挪走。
 */
const src = fs.readFileSync(INDEX, "utf8");

const posOf = (needle) => {
  const i = src.indexOf(needle);
  assert.ok(i >= 0, `源码里找不到：${needle}`);
  return i;
};

test("wiring: 内感知必须在 before_prompt_build 里，不能放进 cycle 所在的函数", () => {
  // 2026-11-07 踩了两次：
  //   09:39 放进 runWorkspaceCompetition、排在 cycle 之前 → Cannot access 'result'
  //   09:50 挪到 cycle 之后、仍在那个函数里      → parts is not defined
  //
  // 根因不是顺序，是作用域：`parts` 是 before_prompt_build 的局部变量，
  // runWorkspaceCompetition 看不到它。注入长度只有 parts 知道。
  const bpbAt = posOf('api.on("before_prompt_build"');
  const compAt = posOf('function runWorkspaceCompetition(');
  const interoAt = posOf("interoception.compute(target.workspaceDir, {");
  assert.ok(
    interoAt > bpbAt && interoAt < compAt,
    `interoception.compute 必须在 before_prompt_build 内、runWorkspaceCompetition 之前（实际 ${interoAt}，区间 ${bpbAt}–${compAt}）`,
  );
});

test("wiring: 内感知读的是 lastCycle，不是局部 result", () => {
  // 换变量名是那次修复的核心：runWorkspaceCompetition 把结果存进闭包变量，
  // before_prompt_build 再读它。直接引用 `result` 会跨不了作用域。
  const interoAt = posOf("interoception.compute(target.workspaceDir, {");
  const tail = src.slice(interoAt, interoAt + 800);
  assert.ok(tail.includes("lastCycle"), "内感知应该读 lastCycle");
  assert.ok(!/\bresult\?\.ranked\b/.test(tail), "不该再直接引用 result");
});

test("wiring: lastCycle 必须先声明，再在 cycle 里赋值", () => {
  // 声明在使用之前。这一条是为了防止又一次 TDZ —— 只是这次换了个变量。
  const declAt = posOf("let lastCycle = null;");
  const assignAt = posOf("lastCycle = result;");
  assert.ok(declAt < assignAt, `lastCycle 声明(${declAt})必须早于赋值(${assignAt})`);
});

test("wiring: 预测结算在 cycle 之前（它不依赖 result）", () => {
  const cycleAt = posOf("const result = cognition.cycle(target.workspaceDir, {");
  const settleAt = posOf("const ex = expectLayer.settle(target.workspaceDir, {");
  assert.ok(settleAt < cycleAt, "预测结算刻意排在 cycle 前，让新情绪进这一轮的判断");
});

test("wiring: 中途重算必须在 note_effect 的工具体里", () => {
  const noteEffectAt = posOf('factory("note_effect"');
  const recalcAt = posOf('probe("mid-cycle-recalc"');
  assert.ok(recalcAt > noteEffectAt, "中途重算应该在 note_effect 之后触发");
});

test("wiring: 广播在 cycle 内部，跟着结果一起产出", () => {
  // 这段在 lib/cognition.js，不在 index.js。第一次写这条时读错了文件，
  // 测试立刻失败 —— 这正是它该做的事。
  const cog = fs.readFileSync(COGNITION, "utf8");
  const bc = cog.indexOf("attention-broadcast.json");
  const cyc = cog.indexOf("export function cycle(workspaceDir, opts = {})");
  assert.ok(bc > 0 && cyc > 0, "两个锚点都要能找到");
  assert.ok(bc > cyc, "broadcast 应该写在 cycle 里");
});

test("wiring: 记账工具不算产出，不能被记成 deed", () => {
  // 实测 2026-11-07：
  //   03:25:08  autonomy 推「去刷抖音」
  //   03:25:20  note_self 写下 78 字
  //   03:25:23  drive-record acted: true → idle 清零
  //
  // `drive.pressure()` 要求 idle >= 3 才注入「你挂着件事一直没去弄」。
  // idle 每轮被这些工具清掉，那句压力永远说不出来。
  // 外面看是「她只说不做」，机制上是「说被算成了做」。
  const bookkeeping = [
    "note_self",
    "note_diary",
    "dafeiyu_interest",
    "dafeiyu_expect",
  ];
  const at = src.indexOf("const BOOKKEEPING_TOOLS = new Set([");
  assert.ok(at > 0, "应该有 BOOKKEEPING_TOOLS 这一组");
  const end = src.indexOf("]);", at);
  const block = src.slice(at, end);
  for (const name of bookkeeping) {
    assert.ok(block.includes(`"${name}"`), `${name} 应该在记账工具名单里`);
  }
});

test("wiring: deed 记录同时排除只读和记账两类", () => {
  const line = src.includes("!READ_ONLY_TOOLS.has(name) && !BOOKKEEPING_TOOLS.has(name)");
  assert.ok(line, "记录 deed 前必须同时挡掉只读和记账两类工具");
});

test("wiring: 读得到插件源码，写不进去", () => {
  // 这是「能诊断、不能自改」的边界，两条都必须成立：
  //   ① read 不在 FS_TOOLS 里 → 她能读自己的代码（否则看不到原因）
  //   ② write/edit/apply_patch 在 FS_TOOLS 里且 scope 到工作区 → 改不了
  //
  // 少任何一条都会坏掉一半：只给写就变成自我编辑；只给读但挡了读，
  // 她就永远只能看到现象，看不到原因。
  assert.ok(src.includes('const FS_TOOLS = new Set(["write", "edit", "apply_patch"]);'),
    "FS_TOOLS 应该只包含写类工具");
  assert.ok(!/FS_TOOLS = new Set\(\[[^\]]*"read"/.test(src),
    "read 不该被 FS_TOOLS 拦住 —— 她需要能读代码");
});

test("wiring: 提示词里说清了「插件代码能读不能改」", (t) => {
  // 光把权限开对没用 —— 她得知道自己能读。上一版 AGENTS.md 只写了
  // 「/extensions 不能动」，于是她把整片区域当成禁区，从来不去看。
  // AGENTS.md 是运行时工作区的文件，不在这个仓库里。
  // 别人克隆下来本来就没有它 —— 那种情况下这条测试无从检查，
  // 跳过比失败更诚实：失败会让人以为仓库坏了。
  const agents = path.join(
    import.meta.dirname, "..", "..", "..", "workspace-dafeiyu", "AGENTS.md",
  );
  if (!fs.existsSync(agents)) {
    t.diagnostic("skip: 没有 workspace-dafeiyu/AGENTS.md（独立克隆的正常情况）");
    return;
  }
  const text = fs.readFileSync(agents, "utf8");
  assert.ok(text.includes("但是能看"), "要明说「不能改」不等于「不能读」");
  assert.ok(/dafeiyu-core/.test(text), "要给出插件代码的路径");
  assert.ok(text.includes("dafeiyu_tune"), "要告诉她数值类问题自己能调");
  assert.ok(/need_help/.test(text) && /behavior/.test(text), "要告诉她代码类问题报出去");
});
