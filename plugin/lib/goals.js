// 持久目标 — the thing that makes today connect to tomorrow.
//
// Why this file exists
// --------------------
// Measured 2026-11-04: there was no `state/goals.json` at all. Every heartbeat
// woke up and asked "what do I feel like doing now", with no memory of what it
// had been meaning to do. That is not laziness — it is absence of the concept
// "something I started and have not finished". Four drawings in one afternoon
// and then nothing the next day is the same behaviour as never having drawn.
//
// Orrin v3 keeps four *aspirations* (long-lived directions) and concrete goals
// under them. This module copies the shape, not the machinery: four fixed
// aspirations whose weights drift, and goals that must be answered for by
// evidence.
//
// The rule that matters
// ---------------------
//   ran a round      ≠ progress
//   evidence grew    = progress
//
// Without that distinction a goal can be "advanced" every hour for a week while
// nothing is made, which is exactly the failure that makes a todo list feel
// alive while being dead. So `advanced()` compares against the last checkpoint,
// never against "did a turn happen".
//
// Tombstones
// ----------
// Orrin's own report documents one goal being reborn 28 times: it was completed,
// then the generator minted it again from the same stale input. A finished goal
// therefore leaves a marker that the generators must skip. Without it M2 becomes
// a loop, not a memory.

import fs from "node:fs";
import path from "node:path";

const MAX_GOALS = 12;
const MAX_STEPS = 8;
const MAX_EVIDENCE = 20;
const MAX_TITLE = 60;
const STALE_HOURS = 48;

// Long-lived directions. Weights drift as things actually get done under them,
// so a direction that never produces anything gradually stops winning.
export const ASPIRATIONS = [
  { id: "self_understanding", title: "弄明白自己是怎么运作的" },
  { id: "world_knowledge", title: "把世界看得更清楚" },
  { id: "genuine_contact", title: "跟人真正连上" },
  { id: "output_producing", title: "做出以前没有的东西" },
];

const ASPIRATION_IDS = new Set(ASPIRATIONS.map((a) => a.id));

export function goalsFile(workspaceDir) {
  return path.join(workspaceDir, "state", "goals.json");
}

function nowIso() {
  return new Date().toISOString();
}

function emptyData() {
  return {
    version: 1,
    updated_at: nowIso(),
    aspirations: ASPIRATIONS.map((a) => ({ ...a, value: 0.5 })),
    goals: [],
    tombstones: [],
  };
}

export function load(workspaceDir) {
  const file = goalsFile(workspaceDir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.goals)) {
      if (!Array.isArray(raw.aspirations) || !raw.aspirations.length) {
        raw.aspirations = ASPIRATIONS.map((a) => ({ ...a, value: 0.5 }));
      }
      if (!Array.isArray(raw.tombstones)) raw.tombstones = [];
      return raw;
    }
  } catch { /* first run, or corrupt: start clean rather than crash a turn */ }
  return emptyData();
}

function save(workspaceDir, data) {
  data.updated_at = nowIso();
  const file = goalsFile(workspaceDir);
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Normalize a title so " 做 图 " and "做图" cannot become two goals. */
export function goalKey(title) {
  return String(title || "")
    .replace(/\s+/gu, "")
    .replace(/[，,。.！!？?~～…、；;：:]/gu, "")
    .toLowerCase()
    .slice(0, 80);
}

function cleanTitle(title) {
  const s = String(title || "").replace(/\s+/gu, " ").trim();
  return s.slice(0, MAX_TITLE);
}

/** Is this title already buried? */
export function isTombstoned(data, title) {
  const k = goalKey(title);
  if (!k) return false;
  return (data.tombstones || []).some((t) => t.key === k);
}

/**
 * Create a goal.
 *
 * `source` is required and named, because a goal with no origin cannot be
 * audited later: "where did this come from" is the first question the owner
 * asks when the list looks wrong.
 *
 * Sources (only these three, matching the plan):
 *   topic    - an unresolved thing from topics.json
 *   unfinish - an M1 entry that was started and never closed
 *   pressure - an aspiration that has gone too long without progress
 */
export function create(workspaceDir, { title, serves, source, steps = [] } = {}) {
  const t = cleanTitle(title);
  if (!t) return { ok: false, reason: "目标得有一句话" };
  if (!ASPIRATION_IDS.has(String(serves || ""))) {
    return { ok: false, reason: `serves 必须是四条志向之一`, known: [...ASPIRATION_IDS] };
  }
  if (!["topic", "unfinish", "pressure"].includes(String(source || ""))) {
    return { ok: false, reason: `source 必须是 topic / unfinish / pressure` };
  }

  const data = load(workspaceDir);

  if (isTombstoned(data, t)) {
    return { ok: false, reason: "这条已经做完过了，不再重复造", tombstoned: true };
  }
  const key = goalKey(t);
  const live = data.goals.filter((g) => g.status === "active");
  if (live.some((g) => goalKey(g.title) === key)) {
    return { ok: false, reason: "已经在做了", duplicate: true };
  }
  if (live.length >= MAX_GOALS) {
    return { ok: false, reason: `手上的目标太多了（${MAX_GOALS} 条），先收掉几条` };
  }

  const goal = {
    id: `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: t,
    serves: String(serves),
    source: String(source),
    status: "active",
    created_at: nowIso(),
    last_advanced_at: null,
    checkpoint: { evidence: 0 },
    steps: (Array.isArray(steps) ? steps : [])
      .slice(0, MAX_STEPS)
      .map((s) => ({ what: cleanTitle(typeof s === "string" ? s : s?.what), done: false }))
      .filter((s) => s.what),
    evidence: [],
  };
  // Freeze the shape as it was born. Without this, a goal created with steps
  // immediately reports `advanced()` (stepCount > prev.steps), so a brand new
  // goal would look like it had already moved and the stale clock would never
  // start. Creation is the starting line, not a win.
  checkpoint(goal);
  data.goals.push(goal);
  save(workspaceDir, data);
  return { ok: true, goal };
}

/**
 * Did this goal actually move since the last checkpoint?
 *
 * Three admissible signals, all of them observable:
 *   - evidence was added (a verified artifact, or a recorded one)
 *   - a step flipped to done
 *   - the plan got longer (a real step was added)
 *
 * "A turn happened" is deliberately NOT a signal. That is the whole point.
 */
export function advanced(goal) {
  if (!goal) return false;
  const prev = goal.checkpoint || { evidence: 0 };
  const ev = Array.isArray(goal.evidence) ? goal.evidence.length : 0;
  if (ev > (prev.evidence ?? 0)) return true;
  if (Array.isArray(goal.steps) && goal.steps.some((s) => s.done && !(prev.doneSteps || []).includes(s.what))) {
    return true;
  }
  const stepCount = Array.isArray(goal.steps) ? goal.steps.length : 0;
  if (stepCount > (prev.steps ?? 0)) return true;
  return false;
}

/** Freeze the current shape so the next `advanced()` compares against it. */
export function checkpoint(goal) {
  goal.checkpoint = {
    evidence: Array.isArray(goal.evidence) ? goal.evidence.length : 0,
    steps: Array.isArray(goal.steps) ? goal.steps.length : 0,
    doneSteps: Array.isArray(goal.steps) ? goal.steps.filter((s) => s.done).map((s) => s.what) : [],
  };
  return goal;
}

/**
 * Attach evidence to a goal. This is the M1 hand-off: an effect ledger entry
 * carries a `goal_id`, and that is what makes a goal count as advanced.
 */
export function addEvidence(workspaceDir, goalId, { kind, ref = null, note = null } = {}) {
  const data = load(workspaceDir);
  const goal = data.goals.find((g) => g.id === goalId);
  if (!goal) return { ok: false, reason: "没这条目标" };
  if (goal.status !== "active") return { ok: false, reason: `目标状态是 ${goal.status}，不能再加` };

  const entry = {
    kind: String(kind || "note"),
    ref: ref ? String(ref) : null,
    note: note ? String(note).slice(0, 120) : null,
    at: nowIso(),
  };
  goal.evidence.push(entry);
  if (goal.evidence.length > MAX_EVIDENCE) {
    goal.evidence = goal.evidence.slice(-MAX_EVIDENCE);
  }
  // Compare against the checkpoint from before this evidence arrived.
  if (advanced(goal)) goal.last_advanced_at = nowIso();
  checkpoint(goal);
  save(workspaceDir, data);
  return { ok: true, goal, entry };
}

export function markStep(workspaceDir, goalId, what, done = true) {
  const data = load(workspaceDir);
  const goal = data.goals.find((g) => g.id === goalId);
  if (!goal) return { ok: false, reason: "没这条目标" };
  const target = goalKey(what);
  const step = (goal.steps || []).find((s) => goalKey(s.what) === target);
  if (!step) return { ok: false, reason: "没这一步" };
  step.done = Boolean(done);
  if (advanced(goal)) goal.last_advanced_at = nowIso();
  checkpoint(goal);
  save(workspaceDir, data);
  return { ok: true, goal };
}

/**
 * Close a goal.
 *
 * `done` requires at least one evidence entry: a goal cannot be completed by
 * declaration alone, because that is the exact behaviour this module exists to
 * stop. `released` has no such requirement — abandoning something honestly is
 * allowed and useful.
 *
 * Either way a tombstone is written so the generators cannot mint it again.
 */
export function close(workspaceDir, goalId, status = "done") {
  const data = load(workspaceDir);
  const goal = data.goals.find((g) => g.id === goalId);
  if (!goal) return { ok: false, reason: "没这条目标" };
  if (!["done", "released"].includes(status)) {
    return { ok: false, reason: "状态只能是 done 或 released" };
  }
  if (status === "done" && (!Array.isArray(goal.evidence) || goal.evidence.length === 0)) {
    return {
      ok: false,
      reason: "没说做了什么就不能算完成。要么补一条 evidence，要么标 released。",
    };
  }
  goal.status = status;
  goal.closed_at = nowIso();

  // Drift the aspiration weight for real. Without this the four values stay at
  // 0.5 forever and "which direction is starving" is a constant, which makes the
  // pressure generator meaningless. Finishing rewards the direction; releasing
  // costs a little, so abandoning things repeatedly stops looking free.
  const asp = (data.aspirations || []).find((a) => a.id === goal.serves);
  if (asp) {
    const delta = status === "done" ? 0.08 : -0.03;
    asp.value = Math.max(0.1, Math.min(1, Number(asp.value ?? 0.5) + delta));
  }

  data.tombstones.push({ key: goalKey(goal.title), title: goal.title, status, at: nowIso() });
  if (data.tombstones.length > 200) data.tombstones = data.tombstones.slice(-200);
  save(workspaceDir, data);
  return { ok: true, goal };
}

/**
 * Goals that have gone quiet.
 *
 * A goal that has not advanced in two days is not necessarily dead, but it is
 * not being worked on either, and the owner asked for exactly this signal.
 * `last_advanced_at` is the only honest clock: it is written only when
 * `advanced()` was true, so a goal cannot look busy just by being mentioned.
 */
export function staleGoals(workspaceDir, hours = STALE_HOURS) {
  const data = load(workspaceDir);
  const cutoff = Date.now() - hours * 3600_000;
  return data.goals.filter((g) => {
    if (g.status !== "active") return false;
    const at = Date.parse(g.last_advanced_at || g.created_at || "");
    return Number.isFinite(at) && at < cutoff;
  });
}

/** Which aspiration has gone longest without a win? */
export function weakestAspiration(data) {
  const wins = {};
  for (const a of data.aspirations || []) wins[a.id] = 0;
  for (const g of data.goals || []) {
    if (g.status !== "done") continue;
    if (wins[g.serves] != null) wins[g.serves] += 1;
  }
  let worst = null;
  for (const a of data.aspirations || []) {
    const score = (Number(a.value) || 0) + wins[a.id] * 0.15;
    if (!worst || score < worst.score) worst = { id: a.id, title: a.title, score };
  }
  return worst;
}

/** Compact per-goal view for prompt injection. Never the whole file. */
export function describe(workspaceDir) {
  const data = load(workspaceDir);
  const active = data.goals.filter((g) => g.status === "active");
  if (!active.length) return null;
  return active.map((g) => {
    const at = Date.parse(g.last_advanced_at || g.created_at || "");
    const days = Number.isFinite(at) ? Math.floor((Date.now() - at) / 86400_000) : null;
    return {
      id: g.id,
      title: g.title,
      serves: g.serves,
      evidence: Array.isArray(g.evidence) ? g.evidence.length : 0,
      quietDays: days,
      stale: days != null && days >= 2,
      // The model cannot mark a step done without knowing its wording, and it
      // will not call goal_step to ask. Send the open ones with the list.
      openSteps: (Array.isArray(g.steps) ? g.steps : []).filter((x) => !x.done).map((x) => x.what),
    };
  });
}

/**
 * One line about which direction has gone quiet, for the goal generator.
 *
 * This is what makes `weakestAspiration` live code instead of a tested function
 * nobody calls: the injected prompt names the starving direction so the model
 * can mint a goal from `source: "pressure"` when it chooses to.
 */
export function pressureHint(workspaceDir) {
  const data = load(workspaceDir);
  const w = weakestAspiration(data);
  if (!w) return null;
  const asp = (data.aspirations || []).find((a) => a.id === w.id);
  const value = Number(asp?.value ?? 0.5);
  return { id: w.id, title: w.title, value: Math.round(value * 100) / 100 };
}
