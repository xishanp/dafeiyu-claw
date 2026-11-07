/**
 * 回访 —— 她说过的那些话，后来有没有再被提起。
 *
 * 这个模块把 11-05 那份一次性诊断（`state/sleeping.json`）变成运行时的一部分。
 * 那份诊断的结论是：
 *
 *   112 句自己的话，100 句后来再没被提起过。
 *
 * 也就是说，她写下来的东西基本没有被自己回看过。这不是「记忆不够」，
 * 是「记忆写进去了但不流动」。一个只会写、不回看的记忆，跟日志文件没区别。
 *
 * 这里做三件事：
 *
 *   1. 找出哪些旧的话**一直没回来**（`cold()`）
 *   2. 找出哪些**正在被反复提起**（`warm()`）
 *   3. 让「冷掉的那句」有机会重新进候选池（`resurface()` 返回一条候选）
 *
 * 不做什么
 * --------
 *
 * - 不判断「她应该在意什么」。只用「后来有没有提到过」这个事实。
 * - 不伪造关联。`related()` 只做字面重合，不猜语义。
 * - 不因为冷就喊她回来。冷久了的直接放过，只有**恰好过了一段时间**的
 *   那一批才值得重新提一次 —— 翻三个月前的旧账是骚扰，不是记忆。
 *
 * 判据照抄 11-05 那份诊断，一个字没改，这样新旧数据可比：
 *
 *   一条自己的话 vs 它之后所有日记/facts/self：
 *   5-gram 重合 < 25% 且重合不到 2 段，算后来没被提起过。
 */

import fs from "node:fs";
import path from "node:path";

const FILE = "revisit.json";
const VERSION = 1;

/** 5-gram 重合率低于这个数，算没被提起过。诊断里用的就是这个值。 */
const COLD_RATIO = 0.25;
/** 至少要有这么多段重合，才算真的回过访。 */
const MIN_MATCHES = 2;

/** 太新的不值得翻（她自己还没走远），太老的也不必挖（早过去了）。 */
const RESURFACE_MIN_DAYS = 1;
const RESURFACE_MAX_DAYS = 10;

/** 一句话最多留多长。日记行有长的，但候选池只需要开头那点意思。 */
const MAX_TEXT = 120;

function file(workspaceDir) {
  return path.join(workspaceDir, "state", FILE);
}

function nowIso() {
  return new Date().toISOString();
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`);
  fs.renameSync(tmp, p);
}

// ------------------------------------------------------------------ 5-gram

/** 切成 5-gram。中文按字，英文按词先归一。和诊断脚本同一口径。 */
export function grams(text) {
  const s = String(text ?? "")
    .replace(/[，。！？、；：“”‘’（）《》【】…—,.!?;:"'()\[\]<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const out = new Set();
  if (!s) return out;
  for (let i = 0; i + 5 <= s.length; i += 1) out.add(s.slice(i, i + 5));
  // 短句本身当一个 gram，否则两个字的话永远匹配不上任何东西
  if (s.length < 5) out.add(s);
  return out;
}

/** a 有多少比例出现在 b 里。 */
export function overlap(a, b) {
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return { ratio: 0, matches: 0 };
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return { ratio: hit / ga.size, matches: hit };
}

// -------------------------------------------------------------- 收集与判定

/**
 * 从日记里取出「她自己的话」。
 *
 * 只认带说话标记的行（主动、说了、回复、发出去…），跳过工具日志和
 * 系统行。诊断脚本里 `machine_lines_skipped` 就是这些。
 */
// 日记行可能是 `- 10:00 | tool | ...`、`## 标题`、`| 表格 |` 等。
// 所以先剥掉列表符号和时分，再看剩下开头像不像机器记录。
// 上一版写成 `-{2,}`（要求两个连字符），于是 `- 10:00 | tool` 这种
// 带单个 `-` 的列表项漏了过去，被当成她说的话。
const MACHINE = /^(?:\||\[|#|>|probe\b|event\b|tool\b|exec\b|write\b|edit\b|--+)/i;
const OWN_VOICE = /主动|说了|讲了|回复|发出去|开口|跟.{0,6}说|告诉|聊到|提了/;

/** 所有日记日文件的日期，升序。判定「有没有之后」用它，不用说过话的日子。 */
function diaryDays(workspaceDir) {
  try {
    return fs.readdirSync(path.join(workspaceDir, "memory"))
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .map((n) => n.replace(".md", ""))
      .sort();
  } catch {
    return [];
  }
}

function ownLines(workspaceDir, { since = null } = {}) {
  const dir = path.join(workspaceDir, "memory");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort();
  } catch {
    return [];
  }

  const out = [];
  for (const name of names) {
    const day = name.replace(".md", "");
    if (since && day < since) continue;
    let text = "";
    try { text = fs.readFileSync(path.join(dir, name), "utf8"); } catch { continue; }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      // 剥掉列表符号和时分，再判机器行。
      const stripped = line.replace(/^[-*+]\s*/, "").replace(/^\d{2}:\d{2}\s*/, "").trim();
      if (!stripped || MACHINE.test(stripped)) continue;
      if (!OWN_VOICE.test(stripped)) continue;
      const body = stripped;
      if (body.length < 8) continue;
      out.push({ day, text: body.slice(0, 240) });
    }
  }
  return out;
}

/** 后面所有日子（含 facts / self）拼成一大段，用来判断有没有再被提起。 */
function laterCorpus(workspaceDir, afterDay) {
  const parts = [];
  const dir = path.join(workspaceDir, "memory");
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(n)) continue;
      if (n.replace(".md", "") <= afterDay) continue;
      try { parts.push(fs.readFileSync(path.join(dir, n), "utf8")); } catch { /* skip */ }
    }
  } catch { /* 没有日记目录 */ }

  for (const sub of ["facts", "self"]) {
    const d = path.join(dir, sub);
    try {
      for (const n of fs.readdirSync(d)) {
        if (!n.endsWith(".md")) continue;
        try { parts.push(fs.readFileSync(path.join(d, n), "utf8")); } catch { /* skip */ }
      }
    } catch { /* 没有这个子目录 */ }
  }
  return parts.join("\n");
}

/**
 * 重算一遍。结果写 `state/revisit.json`。
 *
 * 这个操作会读全部日记，所以不放在每轮跑 —— 由心跳的整理时隙调用，
 * 一天一次足够。
 */
export function scan(workspaceDir, { since = null } = {}) {
  const lines = ownLines(workspaceDir, { since });
  const active = [];
  let neverRevisited = 0;

  // 最后一天的话没有"之后"可言。
  //
  // 两个坑叠在一起：
  //
  //   1. `laterCorpus` 会读 facts/ 和 self/，返回**永远不为空**，所以上一版
  //      用 `!corpus` 判断「没有之后」，那个分支一次都走不到。
  //   2. 改成看 `lines` 里最大的 day 也不对 —— `lines` 只含「她说过话的日子」，
  //      如果最近三天她一句话没说，那个"最新"会停在三天前，于是三天前那句
  //      也被当成没有之后。实测就出在这里：11-02 说过话、11-03 到 11-07
  //      都是纯工作日记，结果 11-02 被判成"没有可比的"。
  //
  // 正确判据：**日记里存在比它更晚的日文件**。看文件，不看说过的话。
  const allDays = diaryDays(workspaceDir);
  const latestDay = allDays.length ? allDays[allDays.length - 1] : "";

  for (const item of lines) {
    const hasLater = item.day < latestDay;
    if (!hasLater) {
      active.push({ ...item, text: item.text.slice(0, MAX_TEXT), ratio: null, matches: 0 });
      continue;
    }
    const corpus = laterCorpus(workspaceDir, item.day);
    const { ratio, matches } = overlap(item.text, corpus);
    const cold = ratio < COLD_RATIO && matches < MIN_MATCHES;
    if (cold) neverRevisited += 1;
    active.push({
      ...item,
      text: item.text.slice(0, MAX_TEXT),
      ratio: Math.round(ratio * 1000) / 1000,
      matches,
      cold,
    });
  }

  const data = {
    version: VERSION,
    updated_at: nowIso(),
    rule: "一条自己的话 vs 它之后所有日记/facts/self：5-gram 重合 <25% 且重合不到 2 段，算后来没被提起过。",
    total: active.length,
    never_revisited: neverRevisited,
    revisit_rate: active.length ? Math.round(((active.length - neverRevisited) / active.length) * 1000) / 1000 : null,
    lines: active,
  };
  writeJson(file(workspaceDir), data);
  return data;
}

export function load(workspaceDir) {
  const d = readJson(file(workspaceDir), null);
  return d && Array.isArray(d.lines) ? d : null;
}

/** 一直没回来过的那些。 */
export function cold(workspaceDir, { limit = 20 } = {}) {
  const d = load(workspaceDir);
  if (!d) return [];
  return d.lines.filter((x) => x.cold).slice(-Math.max(1, limit));
}

/** 被反复提起的那些 —— 这些是她真正在意的东西的证据。 */
export function warm(workspaceDir, { limit = 10 } = {}) {
  const d = load(workspaceDir);
  if (!d) return [];
  return d.lines
    .filter((x) => x.ratio != null && !x.cold && x.ratio >= 0.5)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, Math.max(1, limit));
}

/**
 * 挑一条值得重新想起来的。
 *
 * 只挑**刚好隔了几天**的：太新她自己还没走远，太旧翻出来是骚扰。
 * 一天只给一条，返回 null 是常态。
 */
export function resurface(workspaceDir, { now = Date.now() } = {}) {
  const d = load(workspaceDir);
  if (!d) return null;

  const candidates = d.lines.filter((x) => {
    if (!x.cold) return false;
    const t = Date.parse(`${x.day}T12:00:00Z`);
    if (!Number.isFinite(t)) return false;
    const days = (now - t) / 86400000;
    return days >= RESURFACE_MIN_DAYS && days <= RESURFACE_MAX_DAYS;
  });
  if (!candidates.length) return null;

  // 取最久的那个：离现在最远但仍然在窗口内，说明它真的没被碰过。
  candidates.sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const pick = candidates[0];
  return {
    key: `revisit:${pick.day}:${pick.text.slice(0, 16)}`,
    kind: "revisit",
    day: pick.day,
    text: pick.text,
    salience: 0.42,
    label: "想起来过的",
    line: `前几天你说过一句话，后来一直没再提：${pick.text.slice(0, 50)}`,
  };
}

/** 给内感知用的两个数。 */
export function stats(workspaceDir) {
  const d = load(workspaceDir);
  if (!d) return { total: 0, neverRevisited: 0, revisitRate: null, updated_at: null };
  return {
    total: d.total ?? 0,
    neverRevisited: d.never_revisited ?? 0,
    revisitRate: d.revisit_rate ?? null,
    updated_at: d.updated_at ?? null,
  };
}

export const CONSTANTS = Object.freeze({
  VERSION, COLD_RATIO, MIN_MATCHES, RESURFACE_MIN_DAYS, RESURFACE_MAX_DAYS,
});
