/**
 * 她能改的那些参数。
 *
 * 不是插件配置。插件配置在 `openclaw.json` 里，那是用户的地盘，改坏了她
 * 自己都起不来。这里改的是**她自己工作区里的覆盖值**，只影响行为阈值，
 * 不影响代码怎么走。
 *
 * 三层结构，每一层谁负责：
 *
 *   插件代码      我改。她碰不到。
 *   openclaw.json 用户改。她碰不到。
 *   这些参数      她自己改。改坏了最坏是行为怪，不会崩。
 *
 * 为什么要有这一层
 * ----------------
 *
 * 2026-11-07 实测的那四个 bug 里，至少两个不是代码错，是**数值不合适**：
 * 熔断阈值 2、习惯阈值 3、兴趣冷却……这类东西我定的时候只能猜。真正每天
 * 被她撞上的是她自己，她知道「2 太低」比我知道得准。
 *
 * 但她没有手去调，只能写进 note_self，而那个地方没人读。
 *
 * 硬边界
 * ------
 *
 * - 只能调白名单里的键，别的键写不进去。
 * - 每个键有上下限。她说 0 就是 0，但不能说 -5 或 100000。
 * - 改动写进 `state/tuning.json`，**不写 openclaw.json**。
 * - 每次改都留一条审计（`state/tuning-log.ndjson`），谁改的、改前改后。
 */

import fs from "node:fs";
import path from "node:path";

const FILE = "tuning.json";
const LOG = "tuning-log.ndjson";
const VERSION = 1;

/**
 * 白名单：她能调的东西，以及每条的范围。
 *
 * `why` 是写给**她**看的：让她知道这个数动大会发生什么。没有这句，
 * 调参数就变成了试数字。
 */
export const TUNABLE = Object.freeze({
  "habit.threshold": {
    min: 1, max: 10, type: "int", default: 3,
    why: "同一个人要纠正你几次才算一条规矩。调小更容易形成规矩，也更容易被一两句话带偏。",
  },
  "habit.minSessionsForAuto": {
    min: 1, max: 6, type: "int", default: 2,
    why: "一条规矩要在几个不同会话里出现才允许生效。1 表示一个会话里说够了就算。",
  },
  "curiosity.surfacePull": {
    min: 0.3, max: 0.9, type: "float", default: 0.55,
    why: "好奇心多强才浮出水面。调低更容易想起没弄明白的事，但也会更容易被琐事打断。",
  },
  "curiosity.freshDays": {
    min: 1, max: 30, type: "int", default: 5,
    why: "一件没弄明白的事能挂几天。过了就淡掉。",
  },
  "workspace.habitCap": {
    min: 0.2, max: 0.9, type: "float", default: 0.5,
    why: "同一件事连着被选中，最多能压多少分。调大更容易换事，也更容易什么都提不起劲。",
  },
  "workspace.streakNotice": {
    min: 2, max: 20, type: "int", default: 5,
    why: "同一件事连着几轮之后会提一句。",
  },
  "interest.halfLifeDays": {
    min: 7, max: 365, type: "int", default: 90,
    why: "兴趣多久淡一半。太长会有一堆早就不在意的东西还挂着。",
  },
  "revisit.maxDays": {
    min: 1, max: 60, type: "int", default: 10,
    why: "多久以前说过的话还值得翻出来。太长会翻很久以前的旧账。",
  },
  "drive.threshold": {
    min: 1, max: 10, type: "int", default: 3,
    why: "连着几轮没做成事才开始有压力。调小更容易被催，调大更容易一直闲着。",
  },
  "autonomy.threshold": {
    min: 0.05, max: 0.9, type: "float", default: 0.25,
    why: "候选项要到多少分才值得被说出来。",
  },
});

function dir(workspaceDir) {
  return path.join(workspaceDir, "state");
}

function file(workspaceDir) {
  return path.join(dir(workspaceDir), FILE);
}

function nowIso() {
  return new Date().toISOString();
}

function load(workspaceDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(workspaceDir), "utf8"));
    return { version: VERSION, values: raw?.values && typeof raw.values === "object" ? raw.values : {} };
  } catch {
    return { version: VERSION, values: {} };
  }
}

function save(workspaceDir, data) {
  fs.mkdirSync(dir(workspaceDir), { recursive: true });
  const tmp = `${file(workspaceDir)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`);
  fs.renameSync(tmp, file(workspaceDir));
}

function audit(workspaceDir, row) {
  try {
    fs.mkdirSync(dir(workspaceDir), { recursive: true });
    fs.appendFileSync(
      path.join(dir(workspaceDir), LOG),
      `${JSON.stringify({ at: nowIso(), ...row })}\n`,
    );
  } catch { /* 审计写不进去不该挡住这次改动 */ }
}

/** 当前生效的值：她调过的优先，没调过的用默认。 */
export function current(workspaceDir) {
  const d = load(workspaceDir);
  const out = {};
  for (const [key, spec] of Object.entries(TUNABLE)) {
    const v = d.values[key];
    out[key] = v == null ? spec.default : v;
  }
  return out;
}

/** 只取一个值。取不到就返回默认 —— 调用方不需要处理 undefined。 */
export function get(workspaceDir, key) {
  const spec = TUNABLE[key];
  if (!spec) return undefined;
  const v = load(workspaceDir).values[key];
  return v == null ? spec.default : v;
}

/**
 * 改一个值。
 *
 * 拒绝的情况都会说清楚原因，而且理由是可执行的 —— 她需要知道
 * 是「这个键不能改」还是「这个数超范围了」，两者下一步完全不同。
 */
export function set(workspaceDir, key, value, { by = "self", reason = "" } = {}) {
  const spec = TUNABLE[key];
  if (!spec) {
    return {
      ok: false,
      reason: `「${key}」不在能调的名单里。能调的只有：${Object.keys(TUNABLE).join("、")}`,
    };
  }

  const n = Number(value);
  if (!Number.isFinite(n)) return { ok: false, reason: `「${key}」要一个数字，收到的是 ${JSON.stringify(value)}` };

  const v = spec.type === "int" ? Math.round(n) : Math.round(n * 1000) / 1000;
  if (v < spec.min || v > spec.max) {
    return {
      ok: false,
      reason: `「${key}」只能落在 ${spec.min} 到 ${spec.max} 之间，${v} 超了。${spec.why}`,
    };
  }

  const d = load(workspaceDir);
  const before = d.values[key] == null ? spec.default : d.values[key];
  d.values[key] = v;
  save(workspaceDir, d);
  audit(workspaceDir, { key, before, after: v, by, reason: String(reason || "").slice(0, 200) });

  return { ok: true, key, before, after: v };
}

/** 还原一条到默认。 */
export function reset(workspaceDir, key, { by = "self" } = {}) {
  const spec = TUNABLE[key];
  if (!spec) return { ok: false, reason: `没有「${key}」这一条` };
  const d = load(workspaceDir);
  const before = d.values[key];
  delete d.values[key];
  save(workspaceDir, d);
  audit(workspaceDir, { key, before: before ?? spec.default, after: spec.default, by, reason: "reset" });
  return { ok: true, key, before: before ?? spec.default, after: spec.default };
}

/** 最近几次改动。给她自己看，也给我看。 */
export function history(workspaceDir, { limit = 10 } = {}) {
  try {
    const rows = fs.readFileSync(path.join(dir(workspaceDir), LOG), "utf8")
      .split("\n").filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    return rows.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

/** 给她看的清单：能改什么、现在是多少、为什么这个数重要。 */
export function describe(workspaceDir) {
  const cur = current(workspaceDir);
  return Object.entries(TUNABLE).map(([key, spec]) => ({
    key,
    value: cur[key],
    default: spec.default,
    range: `${spec.min}–${spec.max}`,
    why: spec.why,
  }));
}

export const CONSTANTS = Object.freeze({ VERSION, FILE });
