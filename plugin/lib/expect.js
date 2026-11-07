/**
 * 预测层 —— 行动之前先写一句「我以为会怎样」，事后再比对。
 *
 * 为什么要有这个东西
 * ------------------
 *
 * `lib/outcome-feedback.js` 已经把结果变成了情绪：成了 +happy，没成 +down。
 * 那只做到「记账」。记账本身不改变判断 —— 一次失败只是让她难过一点，
 * 下次遇到同一件事，她的选择依据没有任何变化。
 *
 * 真正改变判断的是**误差**：我以为是 A，实际是 B，差多少。这个差值才是
 * 可以拿去修正模型的东西。没有它，再多的结果记录也只是在同一个地方
 * 反复确认同一个世界。
 *
 * 所以这里只有两件事：
 *
 *   1. `predict()`  行动前记一条，写明期望
 *   2. `settle()`   结果到达时配对，算出惊讶值
 *
 * 不做什么
 * --------
 *
 * - 不自动决定预测什么。调用方说预测哪件事。
 * - 不改情绪。`surprise` 交回给 outcome-feedback 决定怎么用。
 * - 不做「预测必须准确」的要求。猜错是常态，猜对才有问题 ——
 *   一直猜对说明预测没有信息量，只是把已知的事又说了一遍。
 *
 * 状态文件
 * --------
 *
 * `state/expectations.json`
 *
 *   { version, open: [...], resolved: [...] }
 *
 * `open` 是按时间排的未结算预期，`resolved` 只留最近一批，不给它无限长。
 */

import fs from "node:fs";
import path from "node:path";

const VERSION = 1;
const MAX_OPEN = 20;        // 没结算的不该无限堆积
const MAX_RESOLVED = 100;   // 结算历史留够看趋势就行
const MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;  // 6 小时内算同一次行动

function file(workspaceDir) {
  return path.join(workspaceDir, "state", "expectations.json");
}

function nowIso() {
  return new Date().toISOString();
}

function load(workspaceDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(workspaceDir), "utf8"));
    return {
      version: raw?.version ?? VERSION,
      open: Array.isArray(raw?.open) ? raw.open : [],
      resolved: Array.isArray(raw?.resolved) ? raw.resolved : [],
    };
  } catch {
    // 没有文件不是错误。第一次运行就是没有文件。
    return { version: VERSION, open: [], resolved: [] };
  }
}

function save(workspaceDir, data) {
  const dir = path.join(workspaceDir, "state");
  fs.mkdirSync(dir, { recursive: true });
  const trimmed = {
    version: VERSION,
    open: data.open.slice(-MAX_OPEN),
    resolved: data.resolved.slice(-MAX_RESOLVED),
  };
  fs.writeFileSync(file(workspaceDir), `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
  return trimmed;
}

/**
 * 把任何输入压成 0–1。预测值统一用这个尺度，才能和结果比。
 *
 * null / undefined 必须先挡掉：`Number(null)` 是 0，不是 NaN，所以只查
 * `Number.isFinite` 会把「没估」悄悄读成「估了 0%」，然后 `guessed` 变成
 * true，整条预测就成了一条「我确定这事不会成」的断言。
 * 由 test/expect.test.mjs「没估分时记下 guessed=false」抓住。
 */
function unit(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/**
 * 行动之前，记一条预期。
 *
 * `key` 是这件事的标识，必须和结果记录里的 `key` 对得上，否则配不了对。
 * `expect` 是她自己估的 0–1：这事有多可能成。不填就退回 0.5 ——
 * 明确说「我不知道」比假装有个准确数字好，而 0.5 就是这个意思。
 */
export function predict(workspaceDir, { key, what, expect = null, at = nowIso() } = {}) {
  const k = String(key ?? "").trim();
  if (!k) return { ok: false, reason: "没有 key，配不上结果" };

  const e = unit(expect);
  const data = load(workspaceDir);

  // 同一件事重复预测会互相打架。后来的覆盖前面的：她改主意了。
  const existing = data.open.findIndex((x) => x.key === k);
  const entry = {
    key: k,
    what: String(what ?? "").slice(0, 200),
    expect: e == null ? 0.5 : e,
    guessed: e != null,          // 分得清「估了 0.5」和「没估，默认 0.5」
    at,
  };
  if (existing >= 0) data.open[existing] = entry;
  else data.open.push(entry);

  save(workspaceDir, data);
  return { ok: true, key: k, expect: entry.expect, guessed: entry.guessed };
}

/**
 * 结果到了，配对结算。
 *
 * `outcomes.json` 里的 `measured` 是 success / failure / silent / unknown。
 * 这里只把 success 和 failure 当已知结果；silent 和 unknown 不动预期，
 * 让她继续等 —— 「没回音」不是「猜错了」，把它算成误差会污染惊讶值。
 *
 * 返回值里的 `surprise` 是 0–1 的绝对差：
 *
 *   0.0  完全猜中
 *   0.5  猜成一半
 *   1.0  完全相反
 *
 * 注意 0.9 和 0.1 的 surprise 一样大。误差是对称的，"我以为是九成却
 * 没成" 和 "我以为只有一成却成了" 同样说明模型错了。
 */
export function settle(workspaceDir, { records = [], now = Date.now() } = {}) {
  const data = load(workspaceDir);
  if (!data.open.length) return { settled: [], surprise: null };

  const out = [];
  const stillOpen = [];

  for (const exp of data.open) {
    const hit = (records || []).find((r) => {
      if (String(r?.key ?? "") !== exp.key) return false;
      const t = Date.parse(String(r?.at ?? ""));
      if (!Number.isFinite(t)) return false;
      if (t < Date.parse(exp.at)) return false;            // 结果不能早于预测
      return now - t <= MATCH_WINDOW_MS;
    });

    if (!hit) {
      stillOpen.push(exp);
      continue;
    }

    const measured = String(hit?.measured ?? "");
    // silent / unknown 不是结果，是「还不知道」。原样留着。
    if (measured !== "success" && measured !== "failure") {
      stillOpen.push(exp);
      continue;
    }

    const actual = measured === "success" ? 1 : 0;
    const surprise = Math.abs(exp.expect - actual);
    out.push({
      key: exp.key,
      what: exp.what,
      expect: exp.expect,
      guessed: exp.guessed,
      actual,
      measured,
      surprise: Math.round(surprise * 1000) / 1000,
      at: exp.at,
      resolved_at: hit.at,
    });
  }

  if (out.length) {
    data.open = stillOpen;
    data.resolved = [...data.resolved, ...out];
    save(workspaceDir, data);
  }

  const avg = out.length
    ? Math.round((out.reduce((s, x) => s + x.surprise, 0) / out.length) * 1000) / 1000
    : null;

  return { settled: out, surprise: avg };
}

/**
 * 她最近的预测准不准。
 *
 * `hitRate` 不是准确率 —— 是「猜中」的比例，误差 < 0.2 算猜中。
 * 这个数低不代表她笨，代表她在猜她还不懂的东西，那是对的。
 * 真正该担心的是它**一直很高**：说明她只在有把握的事上下注，
 * 那样预测就退化成记账了。
 */
export function accuracy(workspaceDir, { limit = 30 } = {}) {
  const data = load(workspaceDir);
  const recent = data.resolved.slice(-Math.max(1, limit));
  if (!recent.length) {
    return { count: 0, hitRate: null, avgSurprise: null, open: data.open.length, note: "还没有结算过的预测" };
  }
  const hits = recent.filter((x) => x.surprise < 0.2).length;
  const avg = recent.reduce((s, x) => s + x.surprise, 0) / recent.length;
  return {
    count: recent.length,
    hitRate: Math.round((hits / recent.length) * 1000) / 1000,
    avgSurprise: Math.round(avg * 1000) / 1000,
    open: data.open.length,
  };
}


/**
 * 读 `outcomes.json` 里的原始记录。
 *
 * `outcome-feedback.js` 内部也读同一个文件，但那段逻辑包在它自己的函数里，
 * 没有导出。与其把 settle 的入参改成一个隐式的全局读取，不如在这里给一个
 * 明确的读取函数，让调用方看得到数据是从哪来的。
 *
 * 读不到就是没有记录。文件不存在、JSON 坏了、结构不对 —— 都是空数组，
 * 都不是错误。这个文件是记账用的，不能因为一笔账写坏了就让整轮停掉。
 */
export function readOutcomes(workspaceDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workspaceDir, "state", "outcomes.json"), "utf8"));
    return Array.isArray(raw?.records) ? raw.records : [];
  } catch {
    return [];
  }
}

export const CONSTANTS = Object.freeze({ VERSION, MAX_OPEN, MAX_RESOLVED, MATCH_WINDOW_MS });
