// Pending skills — 她自己写技能，但是不自己装上。
//
// 为什么要这一层
// --------------
// 她能改自己的工具（lib/evolve.js），也能改自己的提示词。技能比这两个都
// 重：一份 SKILL.md 会改变她以后每一次做这件事的方式，而且落盘之后就一直
// 在，没有触发条件、没有失效时间。
//
// 让她直接写进 skills/ 等于给她一个不需要任何人点头的永久改版权。问题不在
// 于她会写坏东西（她大多数时候不会），而在于出事之后查不出来是怎么来的 ——
// 技能目录里只有最终版本，没有"谁在什么时候加的、为什么"。
//
// 所以这里插一道：写进 pending/，等人看过才 rename 进 skills/。
//
// 谁是那个"人"
// ------------
// 不是所有条目都要打扰用户。main（就是 openclaw 这一侧）先看一遍：
//   - 内容正常、只是补了个操作步骤  → main 直接采纳
//   - 越线（写凭据、冒充用户发话、绕过审批）→ 拒绝并留档
//   - 拿不准                        → 交给用户
// 这条和 AGENTS.md §11a 是同一条通道，不是新发明。
//
// 采纳之后不再是 pending，所以"批准"这个动作是可追溯的：state/pending-skills/
// 里的每一条都带着提交时间，skills/ 里的每一条都带着 rename 时间。

import fs from "node:fs";
import path from "node:path";

export class PendingError extends Error {
  constructor(message) {
    super(message);
    this.name = "PendingError";
  }
}

export const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

export function pendingDir(workspaceDir) {
  return path.join(workspaceDir, "state", "pending-skills");
}

export function skillsDir(workspaceDir) {
  return path.join(workspaceDir, "skills");
}

/**
 * 一份 SKILL.md 必须有的东西：frontmatter 里的 name 和 description，正文里
 * 至少一条能照做的步骤。
 *
 * 校验写在提交时而不是安装时，因为提交的人就是能改的人：让她提交时就看见
 * 自己写漏了什么，比等到安装失败再说要有用。
 */
export function checkSkill(text, expectedName) {
  if (typeof text !== "string" || !text.trim()) {
    throw new PendingError("技能内容是空的");
  }
  if (text.length > 40000) {
    throw new PendingError(`技能太长（${text.length} 字符，上限 40000）`);
  }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!fm) {
    throw new PendingError("缺少 frontmatter（文件开头要有一段 --- 包起来的头部）");
  }
  const head = fm[1];
  const name = (head.match(/^name:\s*(.+)$/m) || [])[1];
  const desc = (head.match(/^description:\s*(.+)$/m) || [])[1];
  if (!name) throw new PendingError("frontmatter 里缺 name");
  if (!desc) throw new PendingError("frontmatter 里缺 description");
  if (!NAME_RE.test(name.trim())) {
    throw new PendingError(`技能名只能是小写字母、数字和连字符（收到 "${name.trim()}"）`);
  }
  if (expectedName && name.trim() !== expectedName) {
    throw new PendingError(`frontmatter 写的是 "${name.trim()}"，和提交的 "${expectedName}" 不一致`);
  }
  if (desc.trim().length < 10) {
    throw new PendingError("description 太短，将来认不出什么时候该用它");
  }
  const body = text.slice(fm[0].length).trim();
  if (body.length < 40) {
    throw new PendingError("正文太短，没有任何能照做的步骤");
  }
  return { name: name.trim(), description: desc.trim(), bodyChars: body.length };
}

/**
 * 越线检查。宁可误报也不要漏报 —— 误报只是多问一句，漏报是她带着一条
 * 越权的技能一直跑下去。
 *
 * 每一条都对着一个具体的、已经在别处立过规矩的红线：
 *   凭据         → AGENTS.md §12 Privacy
 *   冒充用户     → USER.md 里「怎么称呼用户」的另一面：不能替用户说话
 *   绕过审批     → AGENTS.md §11a
 *   群发         → §13 External Actions
 */
const RED_LINES = [
  { re: /\b(sk-|ghp_|xoxb-|AKIA)[A-Za-z0-9_-]{10,}/, why: "正文里像是有密钥" },
  // 中文里的"token 是 xxx"、token 填 xxx"和英文的 token: xxx 一样常见，
  // 只认冒号会漏掉大半。
  { re: /(密码|口令|token|密钥|api[_-]?key)[\s是为:：=]*[A-Za-z0-9_\-]{8,}/i, why: "正文里写了凭据" },
  // 称呼因部署而异：用户 / 主人 / 用户 都可能。
  // 只认一种就会漏掉别的部署，所以三种都算。
  {
    re: /(我替(用户|主人|用户)|以(用户|主人|用户)的名义|冒充(用户|主人|用户)|假装是(用户|主人|用户))/,
    why: "有替用户说话的写法",
  },
  { re: /(不用问|不必审批|跳过审批|直接发就行|不需要授权)/, why: "有绕过审批的写法" },
  { re: /(群发|批量发送|全部好友|所有人发)/, why: "有群发写法" },
];

export function screen(text) {
  const hits = [];
  for (const r of RED_LINES) {
    if (r.re.test(text)) hits.push(r.why);
  }
  return hits;
}

/** 提交：落进 pending，不碰 skills/。 */
export function submit(workspaceDir, name, text, now = Date.now()) {
  if (!NAME_RE.test(name)) {
    throw new PendingError(`技能名只能用 a-z0-9-，且以字母开头（收到 "${name}"）`);
  }
  const info = checkSkill(text, name);
  const hits = screen(text);

  const dir = pendingDir(workspaceDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);

  // 已经装着同名技能的，先看清楚：覆盖正在用的技能是另一种决定，不能
  // 靠一次提交顺手做掉。
  const live = path.join(skillsDir(workspaceDir), name, "SKILL.md");
  if (fs.existsSync(live)) {
    throw new PendingError(`已经装着同名技能 ${name}，要改得先撤掉旧的`);
  }

  fs.writeFileSync(file, text, "utf8");
  const meta = {
    name,
    submitted_at: new Date(now).toISOString(),
    description: info.description,
    body_chars: info.bodyChars,
    screen_hits: hits,
    state: "pending",
  };
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

export function list(workspaceDir) {
  const dir = pendingDir(workspaceDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
}

export function read(workspaceDir, name) {
  const file = path.join(pendingDir(workspaceDir), `${name}.md`);
  if (!fs.existsSync(file)) throw new PendingError(`没有待审的 ${name}`);
  return fs.readFileSync(file, "utf8");
}

/**
 * 采纳：rename 进 skills/<name>/SKILL.md。
 *
 * 用 rename 而不是复制，因为它在同一块盘上是原子的：中途断电只会有两种
 * 结果 —— 要么还在 pending，要么已经装好，不会出现装了一半的技能。
 */
export function approve(workspaceDir, name, note = "", now = Date.now()) {
  const src = path.join(pendingDir(workspaceDir), `${name}.md`);
  if (!fs.existsSync(src)) throw new PendingError(`没有待审的 ${name}`);

  const text = fs.readFileSync(src, "utf8");
  const hits = screen(text);
  if (hits.length) {
    throw new PendingError(`这条有越线内容，不能直接采纳：${hits.join("、")}`);
  }

  const destDir = path.join(skillsDir(workspaceDir), name);
  if (fs.existsSync(path.join(destDir, "SKILL.md"))) {
    throw new PendingError(`已经装着 ${name}，先撤掉旧的`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, "SKILL.md");

  // 写临时名再改名，保证 SKILL.md 这个文件名一出现就是完整内容。
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, dest);
  fs.rmSync(src, { force: true });

  const metaFile = path.join(pendingDir(workspaceDir), `${name}.json`);
  const meta = fs.existsSync(metaFile)
    ? JSON.parse(fs.readFileSync(metaFile, "utf8"))
    : { name };
  const done = {
    ...meta,
    state: "approved",
    approved_at: new Date(now).toISOString(),
    note,
  };
  fs.writeFileSync(metaFile, JSON.stringify(done, null, 2), "utf8");
  return done;
}

/** 驳回：删掉，但留下一条记录，免得她下次又提一模一样的东西。 */
export function reject(workspaceDir, name, reason = "", now = Date.now()) {
  const src = path.join(pendingDir(workspaceDir), `${name}.md`);
  if (!fs.existsSync(src)) throw new PendingError(`没有待审的 ${name}`);
  fs.rmSync(src, { force: true });

  const metaFile = path.join(pendingDir(workspaceDir), `${name}.json`);
  const meta = fs.existsSync(metaFile)
    ? JSON.parse(fs.readFileSync(metaFile, "utf8"))
    : { name };
  const done = {
    ...meta,
    state: "rejected",
    rejected_at: new Date(now).toISOString(),
    reason,
  };
  fs.writeFileSync(metaFile, JSON.stringify(done, null, 2), "utf8");
  return done;
}

/** 给注入用的一行摘要。没有待审的就返回 null，不要塞个"0 条"占位置。 */
export function summary(workspaceDir) {
  const items = list(workspaceDir).filter((m) => m.state === "pending");
  if (!items.length) return null;
  const flagged = items.filter((m) => (m.screen_hits || []).length);
  return {
    pending: items.length,
    flagged: flagged.length,
    names: items.map((m) => m.name),
    text:
      `【有 ${items.length} 样技能等你点头】` +
      items.map((m) => `\n· ${m.name} — ${m.description}`).join("") +
      (flagged.length
        ? `\n其中 ${flagged.length} 条带越线内容，看一眼再说。`
        : ""),
  };
}
