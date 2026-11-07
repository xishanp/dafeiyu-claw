import fs from "node:fs";
import path from "node:path";

/**
 * M3 · Workspace competition.
 *
 * Problem: every heartbeat stuffed emotion + clock + topics + yesterday's digest
 * into the prompt all at once, and the model decided what to look at. In
 * practice the strongest emotion won every time, so the same kind of thought
 * kept resurfacing while real but quieter business never got a turn.
 *
 * Fix: build the candidates in code, score them, inject only the winner plus
 * one line saying why the others lost. Habituation stops a single candidate
 * from winning forever.
 *
 * This module is pure scoring — it reads and writes one small state file and
 * never touches the prompt itself, so removing the hook reverts everything.
 */

export function attentionFile(workspaceDir) {
  return path.join(workspaceDir, "state", "attention.json");
}

const RECENT_LIMIT = 24; // keep a rolling window; 6 is what scoring looks at
const HABIT_LOOKBACK = 6;
const HABIT_STEP = 0.2;
/**
 * 惩罚上限。可以被外部覆盖 —— 见 `lib/tuning.js`。
 *
 * 为什么是可变的：0.5 是我拍的。真正每天撞上它的是她，她更知道
 * 「压太多什么都提不起劲」还是「压不够一直在转」。
 */
let HABIT_CAP = 0.5;

/** 让 `tuning.js` 的值生效。不认识这个键就当没调过。 */
export function applyTuning(values = {}) {
  if (Number.isFinite(values["workspace.habitCap"])) {
    HABIT_CAP = Math.max(0.2, Math.min(0.9, Number(values["workspace.habitCap"])));
  }
  if (Number.isFinite(values["workspace.streakNotice"])) {
    STREAK_NOTICE = Math.max(2, Math.min(20, Math.round(Number(values["workspace.streakNotice"]))));
  }
}

/**
 * Below this, say nothing.
 *
 * Habituation only works when there is something else to win. Measured with a
 * single candidate present: scores went 0.679 → 0.479 → 0.279 → 0.179 and then
 * stuck, because the only competitor was itself — so the same 24-character
 * sentence was injected on every heartbeat, ten rounds running. That is the
 * "same thought resurfacing" this module exists to remove, just spelled
 * differently.
 *
 * A worn-down winner means "nothing worth raising right now", and silence is the
 * honest output. The record is not advanced in that case, so the candidate is not
 * punished for a turn in which nothing was delivered.
 */
export const MIN_INJECT_SCORE = 0.25;

/**
 * 前两名差多少算「分不出轻重」。
 *
 * 0.05 不是随手定的：习惯化每步扣 0.2、封顶 0.5，两个真实候选之间的分数
 * 差通常落在 0.05–0.4 之间。0.05 以内意味着「下一轮随便哪个多一点就能
 * 翻过来」，那才是真的在犹豫。
 */
export const CONTESTED_GAP = 0.05;

/**
 * 连着这么多轮同一个赢家，值得说一句。
 *
 * 可被 `lib/tuning.js` 覆盖（`workspace.streakNotice`）。
 * 5 是估的 —— 她更知道自己几轮算"卡住"。
 */
export let STREAK_NOTICE = 5;

/** Marker for a turn that deliberately said nothing. Never scores. */
export const SILENCE_KEY = "__silence__";

/**
 * Kinds that are not worth a line on their own.
 *
 * A background direction ("弄明白自己是怎么运作的") is a lens, not business. With
 * it as the only candidate there is nothing to compete against, so injecting it
 * is not a decision — it is noise, repeated every heartbeat forever.
 *
 * Measured with the sole-aspiration state: a 7-round cycle of three identical
 * lines then four silent rounds, which at 5-15 minute heartbeats is the same
 * sentence dozens of times a day. Competition needs competitors; with one there
 * is no competition, and silence is the honest output.
 *
 * These kinds still win normally when real business is present alongside them.
 */
const SOLO_SILENT_KINDS = new Set(["aspiration", "affect"]);

function nowIso() {
  return new Date().toISOString();
}

export function load(workspaceDir) {
  const file = attentionFile(workspaceDir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.recent)) {
      return { version: 1, updated_at: raw.updated_at ?? nowIso(), recent: raw.recent };
    }
  } catch { /* first run: start clean rather than break a turn */ }
  return { version: 1, updated_at: nowIso(), recent: [] };
}

function save(workspaceDir, data) {
  data.updated_at = nowIso();
  const file = attentionFile(workspaceDir);
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** How many of the last HABIT_LOOKBACK winners shared this key. */
export function recentCount(data, key, lookback = HABIT_LOOKBACK) {
  const recent = Array.isArray(data?.recent) ? data.recent : [];
  return recent.slice(-lookback).filter((r) => r?.key === key).length;
}


/**
 * Build the candidate list from whatever the caller actually has.
 *
 * Every candidate carries the same shape so scoring is uniform:
 *   { key, kind, salience, text, exempt? }
 * `key` must be stable across turns for habituation to work — use the goal id,
 * the aspiration id, the topic key, never the rendered sentence.
 */
export function buildCandidates(input = {}) {
  const {
    userTurn = null,      // { text } when someone just spoke
    goal = null,          // active goal { id, title, stale }
    aspiration = null,    // weakest aspiration { id, title, value }
    affect = null,        // strongest emotion { name, value }
    unresolved = null,    // oldest open topic { key, label, days }
    selfState = null,     // { line, phase } from lib/self.js — optional
  } = input;

  const out = [];

  if (userTurn?.text) {
    out.push({
      key: "user_turn",
      kind: "user_turn",
      salience: 0.95,
      label: "有人说话",
      text: `有人刚跟你说话：${String(userTurn.text).slice(0, 60)}`,
    });
  }

  if (goal?.id && goal?.title) {
    out.push({
      key: `goal:${goal.id}`,
      kind: "goal",
      salience: 0.55,
      label: "手上那件事",
      // A stalled goal is the one case that must not be habituated away: the
      // whole point of noticing it is that ignoring it is what has been
      // happening.
      exempt: Boolean(goal.stale),
      text: `手上那件事：${goal.title}`,
    });
  }

  if (aspiration?.id) {
    const v = clamp01(aspiration.value ?? 0.5);
    // Pressure, not value. `value` RISES when that direction produces something
    // (done +0.08) and FALLS when it is abandoned (-0.03), so a LOW value is the
    // starving direction. Scoring it as `0.4 + 0.4 * v` therefore gave the most
    // neglected direction the weakest voice — exactly inverted: the worse it got,
    // the less likely it was to ever be chosen, and the drift became permanent.
    const pressure = 1 - v;
    out.push({
      key: `aspiration:${aspiration.id}`,
      kind: "aspiration",
      salience: 0.4 + 0.4 * pressure,
      label: "那条志向",
      text: `有个方向一直没怎么往前走：${aspiration.title}`,
    });
  }

  // Emotion is deliberately NOT a candidate.
  //
  // Measured 2026-11-04 19:42: with no goal and no open topic, "平静" at 0.657
  // won the competition uncontested and the prompt got the line
  // 「你现在的情绪：平静」— nine characters that tell the model nothing it can
  // act on. Mood is a lens on what to do, not a thing to do; injecting it alone
  // reproduces the original problem (mood drives every turn) under a new name.
  //
  // So it only participates as a tie-breaker below, and only when real business
  // exists. No business, no injection.

  if (unresolved?.key || unresolved?.label) {
    const days = Math.max(0, Number(unresolved.days ?? 0));
    out.push({
      key: `topic:${unresolved.key ?? unresolved.label}`,
      kind: "unresolved",
      // 0.35 base, +0.06/day, capped at 6 days → max 0.71.
      //
      // Was +0.1/day capped at 10 (max 1.00). Measured: with one six-day-old
      // topic present, it beat a 0.55 goal every round and took 14 of 20
      // heartbeats — the single-source dominance this module exists to stop,
      // just with a different source winning. A candidate must not outrank
      // everything else by so much that habituation (max 0.5) can never move it.
      salience: 0.35 + 0.06 * Math.min(days, 6),
      label: "悬着的事",
      text: `还悬着的一件事：${unresolved.label ?? unresolved.key}`,
    });
  }

  // The self card, as a candidate rather than a permanent injection.
  //
  // It belongs in the pool because "where am I" competes with "what should I do
  // about it": a week that produced nothing is worth raising, and a week that
  // produced a lot is not news. Injecting it unconditionally gave the same line
  // every turn, which is the M3 problem all over again.
  //
  // Salience follows the phase. `stuck` and `dormant` are the two states the
  // character cannot notice by itself (COGNITION.md §八: blind spots do not
  // announce themselves), so they score high. `productive` scores low on
  // purpose — doing well is not a reason to interrupt.
  if (selfState?.line) {
    // `dormant` outranks `stuck`: "nothing has happened for a month" makes every
    // other candidate moot, including the one about a starving direction — a
    // direction cannot starve if the whole thing stopped.
    const phaseBoost = { dormant: 0.68, stuck: 0.62, steady: 0.38, productive: 0.3 };
    out.push({
      key: "self:state",
      kind: "self_state",
      salience: phaseBoost[selfState.phase] ?? 0.38,
      label: "自己的状态",
      text: selfState.line,
    });
  }

  return out;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Score every candidate, apply habituation, return the ranking.
 *
 * Habituation is a plain subtraction, capped, so a candidate that keeps winning
 * eventually falls below something that has not had a turn. Exempt candidates
 * skip it entirely.
 */
export function rank(data, candidates, affect = null) {
  const scored = candidates.map((c) => {
    const seen = c.exempt ? 0 : recentCount(data, c.key);
    const penalty = Math.min(HABIT_CAP, seen * HABIT_STEP);
    return {
      ...c,
      seen,
      penalty,
      // 原始分。保留下来是为了事后能说清「它本来是 0.85，被压到 0.35」，
      // 而不是只看到压完的结果。没有这个数，`why` 就只能说「分数低」，
      // 而那等于什么都没说。
      salience: c.salience,
      score: Math.max(0, c.salience - penalty),
    };
  });
  // Mood nudges but never decides: a +0-0.12 bump, always smaller than the gap
  // between two real candidates. It cannot manufacture a winner on its own.
  const mood = clamp01(affect?.value ?? 0);
  if (mood > 0) {
    for (const c of scored) {
      if (c.kind === "affect") continue;
      c.score = Math.min(1, c.score + 0.12 * mood);
    }
  }

  // Tie-break order, and it is not arbitrary:
  //   1. higher score
  //   2. an EVENT beats a standing condition — "something just changed" is a
  //      more useful thing to think about than "this has been true for days"
  //   3. lower `seen` — the thing that has been chosen less gets the slot
  //   4. key, only as a final stabiliser so the output is deterministic
  //
  // Without step 2 the only way an event could win was by out-scoring a
  // standing condition numerically, which put the whole weight of the design on
  // one constant. Without step 3, a tie went to whichever key sorted first —
  // `self:state` beat `aspiration:*` alphabetically, which is not a reason.
  const kindRank = (k) => (k === "event" ? 0 : k === "user_turn" ? 1 : 2);
  scored.sort((a, b) => b.score - a.score
    || kindRank(a.kind) - kindRank(b.kind)
    || a.seen - b.seen
    || a.key.localeCompare(b.key));

  // 每个候选为什么排在这儿。
  //
  // 之前只有分数，没有理由。分数能排序，但排完之后看不出原因 —— 一个
  // 被习惯化压到 0.3 的东西，和一个本来就只有 0.3 的东西，分数一样而
  // 情况完全不同。前者是「她最近老想这个，该歇歇」，后者是「这件事本来
  // 就不重要」。把这两种混在一起，`runnerUp` 那句「XX 这轮先放着」就
  // 变成了一句没有信息量的话。
  //
  // 这里只写分数说得出来的那部分。真正的原因（她为什么在意这件事）不在
  // 算术里，不能假装算出来。
  const top = scored[0]?.score ?? 0;
  for (let i = 0; i < scored.length; i += 1) {
    const c = scored[i];
    if (i === 0) {
      c.why = c.penalty > 0.1
        ? `最想动的，但已经被压掉了 ${c.penalty.toFixed(2)}`
        : "最想动的";
      continue;
    }
    const gap = top - c.score;
    // 差得太小的时候标一下。这不是给她的信息，是给 `render` 用的：
    // 用「XX 这轮先放着」的口气描述一个几乎平手的第二名是错的 ——
    // 那听起来像已经决定了，实际是还没决定。
    if (gap < CONTESTED_GAP) c.contested = true;
    if (c.penalty >= 0.2 && c.penalty > gap) {
      // 压掉的部分比差距还大 —— 它本来能赢，是被重复惩罚挡住的。
      c.why = `本来够，最近想太多了（压掉 ${c.penalty.toFixed(2)}）`;
    } else if (gap < 0.05) {
      c.why = "就差一点";
    } else if (c.score < MIN_INJECT_SCORE) {
      c.why = "没什么劲";
    } else {
      c.why = "这轮排后面";
    }
  }

  return scored;
}

/** Pick one winner and record it so the next turns can habituate. */
export function compete(workspaceDir, input = {}) {
  const data = load(workspaceDir);
  // `extra` is how M4 proposals enter the pool. They are ordinary candidates
  // from this point on — scored, habituated, and able to lose. A proposal that
  // cannot lose would be an injection, which is exactly what the spec forbids.
  const candidates = [...buildCandidates(input), ...(Array.isArray(input.extra) ? input.extra : [])];
  if (!candidates.length) return { winner: null, ranked: [] };

  // One lone background signal is not a thought worth raising.
  if (candidates.length === 1 && SOLO_SILENT_KINDS.has(candidates[0].kind)) {
    return { winner: null, ranked: [], reason: "solo_background" };
  }

  const ranked = rank(data, candidates, input.affect);
  const winner = ranked[0];

  if (winner.score < MIN_INJECT_SCORE) {
    // Nothing strong enough to be worth a line — but the turn still happened, and
    // that has to be recorded.
    //
    // First version returned here without touching `recent`, on the reasoning
    // that a non-delivery should not punish the candidate. Measured over 30
    // rounds: the window stayed frozen on the same three wins, `seen` stayed at 3,
    // the score stayed at 0.179 and it went silent forever. Trading "repeats ten
    // times" for "never speaks again" is not a fix.
    //
    // Recording a silence marker makes the window advance, so the candidate's own
    // wins age out of the lookback and it becomes eligible again after a rest.
    // The marker's key matches no real candidate, so it never scores.
    noteSilence(workspaceDir);
    return { winner: null, runnerUp: null, ranked, reason: "below_floor" };
  }

  noteWin(workspaceDir, winner);
  // noteWin 已经把这一轮写进 recent，所以连击要读**写完之后**的状态。
  const streak = streakOf(load(workspaceDir));
  return { winner, runnerUp: ranked[1] ?? null, ranked, streak };
}

/**
 * The text to inject: the winner, plus at most one line about what lost.
 *
 * Deliberately one line. A full ranking table would just recreate the original
 * problem — everything in view at once, model picks for itself.
 */
/**
 * Advance the window without a winner.
 *
 * Extracted from `compete` so `lib/cognition.js` can reuse the rule instead of
 * copying it. A second copy would drift, and two modules disagreeing about when
 * to advance the habituation window is a bug that only shows up as "it suddenly
 * repeats itself" weeks later.
 */
export function noteSilence(workspaceDir) {
  const data = load(workspaceDir);
  data.recent = [...data.recent, { key: SILENCE_KEY, kind: "silence", at: nowIso() }].slice(
    -RECENT_LIMIT,
  );
  save(workspaceDir, data);
}

/** Record a winner in the habituation window. Same reason as `noteSilence`. */
export function noteWin(workspaceDir, winner) {
  const data = load(workspaceDir);
  data.recent = [...data.recent, { key: winner.key, kind: winner.kind, at: nowIso() }].slice(
    -RECENT_LIMIT,
  );
  save(workspaceDir, data);
}

// How to mention the thing that lost, per kind.
//
// The old wording was always 「${label}，这轮先放着。」, which read badly for
// anything that was not a task: a self-card saying "14 things this week" got
// answered with 「那条志向，这轮先放着」, which sounds like talking to itself
// about someone else. Mentioning the runner-up is useful — it tells the model
// what it decided NOT to do — but the sentence has to fit what it is naming.
/**
 * 同一个东西连着赢了几轮。
 *
 * 不是「出现次数」—— `recentCount` 数的是最近 6 条窗口里它出现了几次。
 * 这里问的是另一个问题：**是不是从来没人跟它换过班**。
 *
 * 六次里赢三次（穿插着别人）是正常偏好；连着赢六次是卡住了 ——
 * 那说明候选池里已经没有能挑战它的东西，而不是它真的最重要。
 *
 * 只报数，不改行为。要不要因此换一个，是她的判断，不是代码的判断。
 */
export function streakOf(data) {
  const recent = Array.isArray(data?.recent) ? data.recent : [];
  // 从最新往前数，遇到不同的就停。silence 不计入连击，但也不打断 ——
  // 一轮没说话不代表念头换了。
  let key = null;
  let n = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const k = recent[i]?.key;
    if (!k || k === SILENCE_KEY) continue;
    if (key == null) { key = k; n = 1; continue; }
    if (k !== key) break;
    n += 1;
  }
  return { key, count: n };
}

const RUNNER_UP_NOTE = {
  aspiration: (label) => `${label}这轮先搁着`,
  goal: (label) => `${label}待会儿再说`,
  unresolved: (label) => `${label}回头再处理`,
  proposal: (label) => `「${label}」这轮先不动`,
  event: (label) => `${label}的事记下了`,
  self_state: () => "",
  affect: () => "",
};

export function render(result) {
  const { winner, runnerUp, streak } = result ?? {};
  if (!winner) return "";
  const lines = [winner.text];
  // 连着好几轮都是同一件的，说一句。
  //
  // 不是催她换。恰恰相反 —— 连续六轮同一个东西，可能是她真的在推进它，
  // 也可能是候选池空了没有对手。这两种从外面看一模一样，她自己才知道
  // 是哪一种。所以只陈述事实，不给建议。
  if (streak && streak.count >= STREAK_NOTICE) {
    lines.push(`（这件事已经连着 ${streak.count} 轮是你最想动的。）`);
  }
  if (runnerUp) {
    // Use the candidate's own short label. Deriving it by splitting `text` on a
    // colon worked only for the built-in sentences — a proposal has no colon, so
    // the whole 40-character proposal got crammed inside the parentheses
    // followed by 「先放着」, which read as dismissive of the thing most stuck.
    const label = runnerUp.label || runnerUp.kind;
    const note = RUNNER_UP_NOTE[runnerUp.kind];
    // Some kinds should not be mentioned at all: naming a mood or the self card
    // as "the thing set aside" is noise, not context.
    let text = note ? note(label) : `${label}这轮先放着`;
    // 说清楚是「不重要」还是「想太多了」。
    //
    // 这两句对她的下一步完全不同：前者可以不放在心上，后者意味着这件事
    // 本身还重要，只是这一轮该让给别人。没有这句区分，runnerUp 的那行字
    // 读起来像「这件事不重要」，会让她真的把它放下。
    if (runnerUp.contested) text = `${label}也差不多想，两个都行`;
    else if (runnerUp.why === "就差一点") text = `${label}也差一点，这轮先让给你`;
    else if (String(runnerUp.why || "").startsWith("本来够")) {
      text = `${label}还想接着弄，但这轮先歇一下`;
    }
    if (text) lines.push(`（${text}。）`);
  }
  return lines.join("\n");
}
