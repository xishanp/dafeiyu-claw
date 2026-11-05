import fs from "node:fs";
import path from "node:path";

import * as goals from "./goals.js";
import * as effects from "./effect-ledger.js";

/**
 * M4 · Metacognitive proposals.
 *
 * The gap this closes: the system cannot tell that it is stuck. Measured
 * 2026-11-04: `experience-pool.json` held 34 entries with status `dropped`, and
 * nothing ever looked at them again. A thought that was abandoned stayed
 * abandoned, silently, forever.
 *
 * Hard rule, taken from the spec: **bias, never preempt.** A proposal may only
 * be pushed into M3's candidate pool. It can never bypass competition and inject
 * itself — otherwise this module becomes a nag that talks over everything.
 *
 * Every proposal must carry `wants`: what to actually do about it. "You are
 * stuck" alone is not a proposal, it is a mood.
 */

const DAY = 86400_000;

/** Goal untouched this long counts as stalled. Matches goals.STALE_HOURS. */
const STALLED_AFTER_DAYS = 2;

/** Same dropped thought seen this many times means it is genuinely unresolved. */
const REPEAT_THRESHOLD = 3;

/** No production for this many days is a real dry spell, not a slow afternoon. */
const DRY_SPELL_DAYS = 3;

/** Below this share of world-directed goals, it is circling itself. */
const WORLD_SHARE_MIN = 0.25;

function nowIso() {
  return new Date().toISOString();
}

function daysSince(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / DAY;
}

function experienceFile(workspaceDir) {
  return path.join(workspaceDir, "state", "experience-pool.json");
}

function loadExperience(workspaceDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(experienceFile(workspaceDir), "utf8"));
    return Array.isArray(raw?.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

/**
 * Normalize a thought so "这个一直没想明白" and "这个一直没想明白。" count as one.
 * Repeats are the whole signal here, so sloppy matching would either invent
 * repetition or miss it.
 */
export function thoughtKey(s) {
  return String(s || "")
    .replace(/\s+/gu, "")
    .replace(/[，,。.！!？?~～…、；;：:""''（）()]/gu, "")
    .toLowerCase();
}

// ------------------------------------------------------------------ checks
//
// Each check returns a proposal or null. A check that lacks the data to judge
// must return null rather than guess: firing on an empty workspace would make
// the module noisy from day one and train the reader to ignore it.

/**
 * A goal that has not moved in two days.
 *
 * `wants` differs by age on purpose. A two-day gap usually means "pick it back
 * up"; a week-old one more often means "this is not going to happen". Saying
 * both at once would be advice nobody can act on.
 */
export function checkStalledGoal(workspaceDir) {
  const stale = goals.staleGoals(workspaceDir, STALLED_AFTER_DAYS * 24);
  if (!stale.length) return null;
  // The oldest one: if several are stuck, the oldest is the one being avoided.
  const g = stale.sort(
    (a, b) => daysSince(a.last_advanced_at || a.created_at) < daysSince(b.last_advanced_at || b.created_at) ? 1 : -1,
  )[0];
  const days = Math.floor(daysSince(g.last_advanced_at || g.created_at));
  const wants = days >= 5
    ? `要么换个法子推一步，要么就用 goal_close 标 released 放掉它`
    : `用 goal_step 记一步，哪怕是拆小一点的一步`;
  return {
    kind: "stalled_goal",
    key: `proposal:stalled_goal:${g.id}`,
    salience: 0.58,
    text: `「${g.title}」已经 ${days} 天没动过了。${wants}。`,
    wants,
    evidence: { goalId: g.id, days },
  };
}

/** A dropped thought that keeps coming back. */
export function checkUnresolvedRepeat(workspaceDir) {
  const entries = loadExperience(workspaceDir);
  if (!entries.length) return null;

  const groups = new Map();
  for (const e of entries) {
    if (e.status !== "dropped") continue;
    const k = thoughtKey(e.gist || e.what);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }

  let worst = null;
  for (const [k, list] of groups) {
    if (list.length < REPEAT_THRESHOLD) continue;
    if (!worst || list.length > worst.list.length) worst = { key: k, list };
  }
  if (!worst) return null;

  const sample = worst.list[worst.list.length - 1];
  const shown = String(sample.gist || sample.what || "").slice(0, 40);
  // wants is written once and appended to text. Writing the same advice twice is
  // how the two drift apart — the first version did exactly that and the injected
  // line ended up saying what was wrong without saying what to do.
  const wants = `用 experience_resolve 收掉它（留或者丢），别再挂着`;
  return {
    kind: "unresolved_repeat",
    key: `proposal:unresolved_repeat:${worst.key.slice(0, 24)}`,
    salience: 0.6,
    text: `「${shown}」这件事你丢下 ${worst.list.length} 次了，要么想明白要么承认它不重要。${wants}。`,
    wants,
    evidence: { count: worst.list.length, gist: shown },
  };
}

/** Days with no produced object at all. */
export function checkEmptyProduction(workspaceDir) {
  const rows = effects.all(workspaceDir);
  if (!rows.length) return null; // no history yet: not a dry spell, just young
  const last = rows
    .map((e) => Date.parse(e.at))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  if (!Number.isFinite(last)) return null;
  const days = (Date.now() - last) / DAY;
  if (days < DRY_SPELL_DAYS) return null;
  return {
    kind: "empty_production",
    key: "proposal:empty_production",
    salience: 0.62,
    text: `已经 ${Math.floor(days)} 天没做出东西了，光在想。挑一件小的先做出来——画一张、写一段、查一个具体问题。`,
    wants: `挑一件小的先做出来——画一张、写一段、查一个具体问题`,
    evidence: { days: Math.floor(days) },
  };
}

/**
 * Almost everything is turned inward.
 *
 * Measured over goals, not deeds: `deeds` are all speaking actions (sticker,
 * qzone, voice) and carry no direction, so they cannot answer this question.
 * Requires at least 4 goals before judging — one goal is not a ratio.
 */
export function checkWorldStarved(workspaceDir) {
  const data = goals.load(workspaceDir);
  const list = (data.goals || []).filter((g) => g.serves);
  if (list.length < 4) return null;

  const world = list.filter((g) => g.serves === "world_knowledge").length;
  const share = world / list.length;
  if (share >= WORLD_SHARE_MIN) return null;

  const self = list.filter((g) => g.serves === "self_understanding").length;
  return {
    kind: "world_starved",
    key: "proposal:world_starved",
    salience: 0.5,
    text: `手头 ${list.length} 件事里只有 ${world} 件是朝外的，其余 ${self} 件都在琢磨自己。挑一个跟自己无关的题目去查——外面的东西，不是自己的东西。`,
    wants: `挑一个跟自己无关的题目去查——外面的东西，不是自己的东西`,
    evidence: { total: list.length, world, self, share: Number(share.toFixed(2)) },
  };
}

const CHECKS = [
  checkStalledGoal,
  checkUnresolvedRepeat,
  checkEmptyProduction,
  checkWorldStarved,
];

/**
 * Run every check. Returns proposals, never throws.
 *
 * A check that crashes must not take down the turn or suppress the other three,
 * so each is isolated.
 */
export function collect(workspaceDir, opts = {}) {
  const out = [];
  for (const check of CHECKS) {
    try {
      const p = check(workspaceDir, opts);
      if (p && p.text) out.push(p);
    } catch { /* one broken check is not a broken module */ }
  }
  return out;
}

/**
 * Proposals as M3 candidates.
 *
 * This is the ONLY way a proposal reaches the prompt: the caller merges these
 * into the competition pool. `exempt` is false so habituation applies — a
 * proposal that keeps losing should fade rather than nag every heartbeat.
 */
export function asCandidates(proposals) {
  return proposals.map((p) => ({
    key: p.key,
    kind: p.kind,
    salience: p.salience,
    text: p.text,
    exempt: false,
    wants: p.wants,
  }));
}

/** One-line digest for logging; never injected verbatim. */
export function summarize(proposals) {
  if (!proposals.length) return "";
  return proposals.map((p) => `${p.kind}(${p.salience})`).join(", ");
}

export { nowIso };
