// Decide — the four things a candidate can become.
//
// The point of this module
// ------------------------
// Without it the only two states are "act" and "do nothing because nothing woke
// me". That is not a decision, it is a coin. The four actions give silence a
// shape:
//
//   do     go ahead
//   defer  not now, but remember to reconsider
//   skip   I saw it and I am choosing not to
//   close  this thread is finished; stop offering it
//
// `skip` and `close` are the ones with no equivalent today. Both are recorded,
// neither costs quota — the source of that rule is dsh-dafeiyu-life
// dm-autoreply.mjs:442, where marking a message seen deliberately does NOT
// consume a send allowance. The reason it matters: if declining costs the same
// as sending, the system learns to hoard its allowance and never declines.
//
// Hard gates come first, in a fixed order
// ---------------------------------------
// 1. contact boundary (the person said stop)
// 2. unresolved previous send (we do not know if it arrived)
// 3. familiarity floor for reaching out unprompted
// 4. quiet hours
// 5. budget
//
// The order is not cosmetic. A boundary check that runs after a budget check
// will one day send a message to someone who asked not to be contacted, because
// the budget happened to allow it. Cheap, absolute checks go first.
//
// Nothing here calls a model. Every rule is decidable from stored facts.

/** Fixed gate names, so a rejection reason is greppable later. */
export const GATES = Object.freeze({
  BOUNDARY: "boundary-stop",
  UNRESOLVED: "unresolved-send",
  TOO_DISTANT: "too-distant",
  QUIET_HOURS: "quiet-hours",
  BUDGET: "budget-exhausted",
  ALREADY_TALKED: "already-talked-recently",
  UNSCORED: "unscored",
});

/** A direct instruction to stop contacting. */
const DIRECT_RE = /(?:不要|别|停止|请勿|不许)(?:再|继续)?(?:给我)?(?:发私信|私信我|发消息|找我)/u;

/** Someone else being talked about — the tell that we are reading a quote. */
const THIRD_PARTY_RE = /(?:别人|朋友|他|她|有人|某人|引用|举例|比如)/u;

/** The conversation is being called off. */
const CLOSED_RE = /(?:再见|拜拜|不聊了|到此为止|别再回复|话题结束|不想说了)/u;

const DEFAULTS = {
  familiarityFloor: 0.35, // below this, never reach out unprompted
  quietStartHour: 0,      // 00:00
  quietEndHour: 6,        // 06:00
  talkGapMinutes: 30,     // do not speak twice inside half an hour
  maxPerDay: 15,
  deferMinutes: 45,
};

/**
 * Detect "stop contacting me" in someone's own words.
 *
 * The third-person guard is not a nicety. Without it:
 *   「他说不想聊」     → 读成「这个人让我别说了」   (错)
 *   「我朋友说别发私信给我」→ 同上                    (错)
 * 两句都是在转述别人，不是指令。把它们当成指令，人将从一个没要求它退开的人那里退开。
 *
 * Position matters, not mere presence. An earlier version only asked "does a
 * third-person word appear anywhere", then tested for a directive separately —
 * so 「我朋友说别发私信」 contained a matching directive and the guard was
 * defeated by the very sentence it existed for. The rule is now: if the third
 * party is named BEFORE the directive, the directive is being quoted.
 *
 * Bias: when in doubt, miss the instruction rather than invent one. Failing to
 * notice someone asking for silence costs one unwanted message; wrongly
 * withdrawing costs the relationship. Source for that trade-off: dsh-fish
 * lib/refuse.js, whose comments record two real misreads and conclude 宁可少算.
 */
export function detectBoundary(text) {
  const s = String(text || "");
  if (!s.trim()) return "";

  const direct = DIRECT_RE.exec(s);
  if (direct) {
    const third = THIRD_PARTY_RE.exec(s);
    // Third party named earlier in the sentence → we are quoting, not being told.
    if (third && third.index < direct.index) return "";
    return "stop";
  }

  if (CLOSED_RE.test(s)) return "closed";
  return "";
}

/** Is `hour` inside quiet hours? Handles the midnight-wrapping case. */
export function inQuietHours(hour, start = DEFAULTS.quietStartHour, end = DEFAULTS.quietEndHour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end; // wraps past midnight
}

/**
 * Choose an action for one candidate.
 *
 * `ctx` carries the world state the caller resolved:
 *   hour               0..23 local
 *   familiarity        number, 0..1, for reach_out candidates
 *   boundary           'stop' | 'closed' | ''
 *   unresolvedSend     true if a previous send to this target never confirmed
 *   minutesSinceTalk   minutes since last spoke to this target
 *   spokeToday         count already sent today
 *   budgetExhausted    true if this wake has spent its allowance
 *   phase              'productive' | 'dormant' | ...
 */
export function choose(candidate, ctx = {}, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const c = candidate || {};
  const gates = [];

  // 1. Absolute boundaries first.
  if (ctx.boundary === "stop") {
    return { kind: "skip", reason: GATES.BOUNDARY, gates: [...gates, GATES.BOUNDARY] };
  }
  if (ctx.boundary === "closed") {
    return { kind: "close", reason: "thread-closed", gates: ["thread-closed"] };
  }

  // 2. Unknown delivery state. Never retry, never guess.
  if (ctx.unresolvedSend === true) {
    return { kind: "skip", reason: GATES.UNRESOLVED, gates: [...gates, GATES.UNRESOLVED] };
  }

  // 3. Reaching out unprompted requires standing.
  if (c.kind === "reach_out") {
    const fam = Number(ctx.familiarity ?? 0);
    if (fam < cfg.familiarityFloor) {
      return { kind: "skip", reason: GATES.TOO_DISTANT, gates: [...gates, GATES.TOO_DISTANT] };
    }
  }

  // Which candidates actually reach another person?
  //
  // This distinction was missing until 2026-11-05, and its absence produced a
  // wrong answer in the first live test that mattered. At 12:20:13 the chosen
  // candidate was `exp:…n46` — "think about what that experience amounts to", an
  // entirely internal act — and the decision came back `defer` with reason
  // `already-talked-recently`, because she had spoken to someone ten minutes
  // earlier. Thinking cannot disturb a conversation. She ignored the defer and
  // resolved the experience ten seconds later, which is the clearest possible
  // signal that the gate was not just too strict but meaningless in that place.
  //
  // The three pacing gates below exist for one purpose: do not annoy people.
  // They must therefore only guard candidates that would actually reach someone.
  // Applying "do not speak twice in 30 minutes" to "sit and think about this"
  // is not caution, it is a category error, and it teaches the character that
  // its own reasons are noise.
  const SOCIAL_KINDS = new Set(["reach_out", "topic"]);
  const social = SOCIAL_KINDS.has(c.kind);

  // 4. Hours that belong to other people. Internal work is fine at 3am.
  if (social && inQuietHours(ctx.hour, cfg.quietStartHour, cfg.quietEndHour)) {
    return { kind: "defer", reason: GATES.QUIET_HOURS, gates: [...gates, GATES.QUIET_HOURS],
             until: cfg.quietEndHour };
  }

  // 5. Budget. Two different limits, deliberately kept apart:
  //    - `budgetExhausted` is this wake's tool allowance; it applies to anything.
  //    - `spokeToday` counts speech, so it only bounds social candidates.
  if (ctx.budgetExhausted === true) {
    return { kind: "skip", reason: GATES.BUDGET, gates: [...gates, GATES.BUDGET] };
  }
  if (social && Number(ctx.spokeToday ?? 0) >= cfg.maxPerDay) {
    return { kind: "skip", reason: GATES.BUDGET, gates: [...gates, GATES.BUDGET] };
  }

  // 6. Just spoke. Not a rejection — a delay. Social only, for the reason above.
  if (social && Number(ctx.minutesSinceTalk ?? Infinity) < cfg.talkGapMinutes) {
    return { kind: "defer", reason: GATES.ALREADY_TALKED, gates: [...gates, GATES.ALREADY_TALKED],
             minutes: cfg.deferMinutes };
  }

  // 7. A candidate with no score is not a candidate.
  //
  // Verified 2026-11-05: `Number(undefined ?? 0)` is 0, but the earlier version
  // only compared `score < 0.4` inside the dormant branch, so a candidate with
  // a missing or NaN score fell straight through to `do`. An unranked thing was
  // therefore treated as worth doing — the loudest possible default for the
  // quietest possible input. Refusing here is the only safe reading: if the
  // scorer could not produce a number, nothing is known about this candidate.
  const rawScore = c.score;
  const score = Number(rawScore);
  if (rawScore == null || !Number.isFinite(score) || score <= 0) {
    return { kind: "skip", reason: GATES.UNSCORED, gates: [...gates, GATES.UNSCORED] };
  }

  // 8. Low energy with nothing pressing: resting is a real answer.
  //
  // This is the one branch that exists purely to avoid "always finds something".
  // In dormant phase a weak candidate should become rest, not a half-hearted
  // attempt — the source for this is dsh-fish's observation that a constant
  // probability produces identical behaviour on day 3 and day 27.
  //
  // EXCEPT going out. Measured 2026-11-06: `wander:out` scored 0.34 when she was
  // not already stuck, and this branch turned it into `rest` in dormant phase —
  // so the one state where she has the most spare time was the one state where
  // wandering was least available. That is backwards twice over: it is the
  // opposite of what the owner asked for, and rest on a low score is meant to
  // stop half-hearted work, not to stop leaving the house.
  //
  // Going out is cheap, needs no follow-through, and is the only thing that puts
  // new material in front of her. It does not qualify as "half-hearted attempt".
  const IS_GOING_OUT = c.kind === "wander" || c.kind === "horizon";
  if (ctx.phase === "dormant" && score < 0.4 && !IS_GOING_OUT) {
    return { kind: "rest", reason: "low-energy-low-stakes", gates: [] };
  }

  return { kind: "do", reason: null, gates: [] };
}

/**
 * Decide for a whole ranked list.
 *
 * Returns at most one action — the system does one thing per wake, not five.
 * That constraint is what keeps this from becoming a batch executor.
 */
export function decide(ranked, ctx = {}, opts = {}) {
  const top = Array.isArray(ranked) && ranked.length ? ranked[0] : null;

  // Nothing worth doing is not the same as nowhere to go.
  //
  // This used to be one line: no candidates -> `rest / nothing-worth-doing`.
  // But a candidate list can only ever contain things that can be scored, and
  // "go see what is out there" is not one of those — there is no value to put
  // on it that is not a guess about how much a stranger's afternoon is worth.
  // So whenever the list emptied, the only answer the system had was sleep.
  //
  // Measured 2026-11-06: that is exactly what the owner kept seeing. Idle was
  // rendered as rest, and rest reads as nothing happening, which is what
  // prompted 「他再发现没有可以弄的话，不应该是开探索未知事物吗」.
  //
  // The fallback is supplied by the caller rather than built here, because only
  // the caller knows whether there is anywhere left to go. `whenEmpty` is that
  // answer, already resolved to a concrete direction.
  if (!top) {
    if (opts.whenEmpty) {
      return { kind: "do", reason: "nothing-else-there-is-to-do", candidate: opts.whenEmpty, gates: [] };
    }
    return { kind: "rest", reason: "nothing-worth-doing", candidate: null, gates: [] };
  }
  const action = choose(top, ctx, opts);
  return { ...action, candidate: top };
}
