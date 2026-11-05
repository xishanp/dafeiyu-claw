// Salience — "how much is this worth doing right now"
//
// Pure functions only. No filesystem, no clock reads, no randomness. Same input,
// same output. That is not stylistic tidiness: a scoring function that reads the
// clock cannot be unit-tested against a fixed scenario, and one that writes to
// disk cannot be rolled back. Everything stateful lives in the caller.
//
// Where the formula comes from
// ----------------------------
// `dsh-proactive` src/goal-engine.ts:949 scores a goal as:
//
//     priority = valueScore * prior * demote
//
//   prior  = (successes + α) / (successes + failures + 2α)     α = 1
//   demote = stalled ? 0.25 : 1
//
// Two properties of that shape are worth keeping, and both are easy to lose:
//
// 1. The prior is Laplace-smoothed, so zero attempts yields 0.5 — not 0. A
//    brand-new thing is not punished for being new. Without the smoothing,
//    `successes / (successes + failures)` divides by zero on the first attempt
//    and every goal starts life looking impossible.
//
// 2. Stalling demotes rather than deletes. 0.25 keeps a quiet goal in the queue
//    at a quarter weight. Deleting it is how a system loses the ability to
//    resume anything, which is the failure this whole module exists to fix.
//
// Multiplication, not a weighted sum, is deliberate: a goal with zero value or
// zero prior should score zero, not "two thirds of a good score".
//
// What is NOT here
// ----------------
// No model call, no novelty heuristic, no "curiosity" number. A score the
// character cannot reason about is just a lever nobody can see. Everything in
// this file is arithmetic over facts the caller already verified.

/** Laplace prior over a goal's own track record. Zero attempts → 0.5. */
export function priorOf(outcomes = {}, alpha = 1) {
  const a = Math.max(0, Number(alpha));
  const s = Math.max(0, Number(outcomes.successes ?? 0));
  const f = Math.max(0, Number(outcomes.failures ?? 0));
  if (a === 0) {
    if (s + f === 0) return 0;
    return s / (s + f);
  }
  return (s + a) / (s + f + 2 * a);
}

/**
 * Score one candidate.
 *
 * `value` is the caller's judgement of worth (0..1).
 * `outcomes` is this exact thing's history: {successes, failures}.
 * `stalled` means it has gone quiet without progress.
 * `urgency` is an optional multiplier for time-decaying things; defaults to 1.
 */
export function scoreCandidate(candidate, opts = {}) {
  const value = clamp01(candidate?.value);
  if (value <= 0) return 0;

  const prior = priorOf(candidate?.outcomes ?? {}, opts.alpha ?? 1);
  if (prior <= 0) return 0;

  const demote = candidate?.stalled ? (opts.stallDemote ?? 0.25) : 1;
  const urgency = Number.isFinite(opts.urgency) ? Math.max(0, opts.urgency) : 1;

  return round3(value * prior * demote * urgency);
}

/**
 * Rank candidates and split them into "worth doing" and "not now".
 *
 * The threshold is not decoration. A system with no threshold always finds
 * something to do, which is precisely the定时任务 behaviour this is meant to
 * avoid. Returning an empty `do` list is a valid, correct outcome.
 */
export function rank(candidates, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 0.25;
  const limit = Number.isFinite(opts.limit) ? opts.limit : 3;

  const scored = (Array.isArray(candidates) ? candidates : [])
    .map((c) => ({ ...c, score: scoreCandidate(c, opts) }))
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));

  return {
    ranked: scored,
    do: scored.filter((c) => c.score >= threshold).slice(0, limit),
    below: scored.filter((c) => c.score < threshold),
    threshold,
  };
}

/**
 * How long to hold back after an attempt, as a multiplier on the next score.
 *
 * Four outcomes, and the fourth is the one that matters:
 *
 *   success   → no penalty, this path works
 *   silent    → 0.6, it went out and nobody answered
 *   failure   → 1.0, it did not work; try a different path, not this one
 *   uncertain → Infinity, do not retry at all
 *
 * `uncertain` exists because "I clicked send and never got a receipt" is not
 * "it failed". Retrying could deliver the same message twice to the same
 * person. One missing message costs less than one duplicate.
 *
 * This is lifted from dsh-douyin-agent autonomous-share.mjs:192, which learned
 * it against a real click-without-receipt case.
 */
export const OUTCOME_PENALTY = Object.freeze({
  success: 0,
  silent: 0.6,
  failure: 1,
  uncertain: Infinity,
});

/** Apply an outcome's penalty to a raw score. Infinity collapses to 0. */
export function applyPenalty(score, outcomeKind) {
  const p = OUTCOME_PENALTY[outcomeKind];
  if (p === undefined) return round3(score);
  if (!Number.isFinite(p)) return 0;
  const factor = p === 0 ? 1 : 1 - p;
  return round3(Math.max(0, score) * Math.max(0, factor));
}

/** Time-decayed freshness, halving every `halfLifeHours`. */
export function freshness(hoursAgo, halfLifeHours = 24) {
  const h = Number(hoursAgo);
  if (!Number.isFinite(h) || h < 0) return 1;
  const hl = Number(halfLifeHours);
  if (!Number.isFinite(hl) || hl <= 0) return 0;
  return Math.pow(2, -h / hl);
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}
