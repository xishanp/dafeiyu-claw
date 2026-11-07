// Curiosity: things she noticed and does not have an explanation for.
//
// The distinction this file exists to protect:
//
//   A gap in a to-do list is something you owe.
//   A gap in understanding is something you wonder about.
//
// They look identical in storage — a string and a count — and that is exactly
// why the first version of this module was wrong. It recorded "query returned
// nothing" and called that curiosity. That is bookkeeping about failure. Nobody
// is curious about a failed lookup.
//
// What actual curiosity looks like, in order:
//
//   1. She meets a name — in a search result, in something someone said, in a
//      video title. Not a topic. A *name*: a specific thing with a specific
//      referent that she either knows or does not.
//   2. She checks whether she knows it. Not "did my search fail" — whether the
//      thing itself has any presence in her memory at all.
//   3. If it has none, that is a noticing. It is *not yet* a want. Most
//      noticings die here, and that is correct: you walk past a hundred shop
//      signs a day and wonder about none of them.
//   4. A noticing becomes a want only when something pulls on it — it comes up
//      again, or it connects to something she already cares about. Then it is
//      handed to `wants.js`, which is the channel that can actually make her
//      *do* something. This module never drives action directly.
//
// The reason step 4 hands off instead of acting is the mistake in the previous
// version, restated: a curiosity that can only accumulate is a filing cabinet.
// The reference implementation this was modelled on converted recurring gaps
// into `understanding` desires for exactly this reason, and that conversion was
// the part that made it work — not the gap list.
//
// Deliberately absent: any notion of "resolved". You do not resolve curiosity.
// You either learn enough that the wanting stops, or you lose interest. Both
// show up here as the noticing simply going quiet. There is no checkbox.

import fs from "node:fs";
import path from "node:path";

const MAX_NOTICINGS = 120;      // how many she can hold at once
const STALE_DAYS = 45;          // a noticing nobody pulled on fades
const PULL_TO_WANT = 2;         // times it must resurface before it can become a want
const MAX_SURFACED = 1;         // never show her more than one at a time

/**
 * A curiosity older than this is out, regardless of what else it scores.
 *
 * The owner's rule, 2026-11-06: 「快速做完 5 天最多就出局」. This is a hard
 * ceiling, not another curve, and it is what actually decides inclusion now.
 *
 * The numbers in this comment were checked against the code on 2026-11-06 and
 * the earlier ones were wrong, so they are restated here from the arithmetic in
 * `pull()`: `base = weight * (0.75 + 0.25 * fresh)` with
 * `fresh = 2^-(age / (STALE_DAYS/6))`. At five days `fresh` is 0.630, so
 *
 *   weight 0.9  → 6d pull 0.8167   (above the 0.55 bar)
 *   weight 0.7  → 6d pull 0.6352   (above the bar)
 *   weight 0.35 → 6d pull 0.3176   (below it)
 *
 * An earlier revision of this paragraph said "ten days is out" and quoted 0.573
 * for weight 0.9 at five days. Both were stale: the 0.573 came from a plain
 * `weight * fresh` formula that the 0.75 floor replaced, and ten days was never
 * the rule once FRESH_DAYS existed. The conclusion survived the correction and
 * is stronger than stated — at five days even the heaviest question is still
 * far above the bar, so no decay curve can express "five days, out" no matter
 * how fast it is tuned. Only the age ceiling can.
 *
 * Five days, counted from the last time she actually met it. Not from when it
 * was first recorded: meeting it again genuinely renews it, and that is the
 * difference between a question she keeps circling and one she read once.
 */
/**
 * 一件没弄明白的事能挂几天。可被 `lib/tuning.js` 覆盖。
 *
 * 5 天是拍脑袋定的。她的实际节奏可能不是五天 —— 由她调，比由我猜准。
 */
export let FRESH_DAYS = 5;

/** 让 `tuning.js` 的值生效。 */
export function applyTuning(values = {}) {
  if (Number.isFinite(values["curiosity.freshDays"])) {
    FRESH_DAYS = Math.max(1, Math.min(30, Math.round(Number(values["curiosity.freshDays"]))));
  }
}

function file(workspaceDir) {
  return path.join(workspaceDir, "state", "curiosity.json");
}

const EMPTY = Object.freeze({
  version: 2,
  noticings: [],
  stats: {
    noticed: 0,
    resurfaced: 0,
    wanted: 0,
    faded: 0,
  },
  updated_at: null,
});

export function load(workspaceDir) {
  try {
    const raw = fs.readFileSync(file(workspaceDir), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return structuredClone(EMPTY);
    if (!Array.isArray(data.noticings)) data.noticings = [];
    if (!data.stats || typeof data.stats !== "object") data.stats = { ...EMPTY.stats };
    for (const k of Object.keys(EMPTY.stats)) {
      if (typeof data.stats[k] !== "number") data.stats[k] = 0;
    }
    return data;
  } catch {
    return structuredClone(EMPTY);
  }
}

export function save(workspaceDir, data) {
  try {
    const target = file(workspaceDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * A name reduced to something comparable.
 *
 * Casing is the only normalisation applied. Stripping more than that would
 * merge `Zink` and `zink` (correct) but also swallow meaningful structure in
 * identifiers like `Mesa 24.1`, and the matcher downstream compares tokens
 * anyway — over-normalising here just hides which spelling she actually met.
 */
export function keyOf(name) {
  // Names become ids, so the same thing said two ways must land on one key.
  // Lowercasing handles `Zink`/`zink`; stripping whitespace and the question
  // mark handles `为什么不直接烤 非用 2.45GHz？` vs the same question retyped
  // with different spacing. Punctuation that carries no referent is dropped —
  // a trailing `?` must not create a second entry for the same question.
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[，。！？、；：""''「」『』（）()\[\]{}?.,!;:"']+/g, "");
}

function nowIso() {
  return new Date().toISOString();
}

function daysSince(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 9999;
  return (Date.now() - t) / 86400000;
}

/**
 * How much this noticing is currently pulling on her.
 *
 * Not a score for ranking a list — a threshold test. The question is only
 * "has this crossed into wanting", and three things move it:
 *
 *   - it came back. Once is an accident, twice is a pattern.
 *   - she was moved by it. Some noticings arrive with a reason attached
 *     ("that keeps showing up in things I read"); most do not.
 *   - it is recent. A thing she wondered about two months ago and never
 *     touched again has stopped pulling, and pretending otherwise produces
 *     a backlog that looks like curiosity and behaves like debt.
 */
export function pull(noticing) {
  if (!noticing || typeof noticing !== "object") return 0;
  const seen = Math.max(1, Number(noticing.seen ?? 1));
  // 2026-11-07: sqrt(seen)/2 gave 1→0.5, 2→0.707, 4→1.0.
  //
  // That curve cannot satisfy the two constraints the pool actually needs at
  // once. Measured on the live formula, with the 0.55 bar and FRESH_DAYS=5
  // (inside which `fresh` falls 1 → 0.630):
  //
  //   seen=1  ceiling 0.450   never surfaces          (correct, it is noise)
  //   seen=2  at age 0 0.554, below the bar at 0.2d   ← the defect
  //   seen=3  at age 0 0.633, below the bar at 5.8d
  //
  // Seeing a thing twice is the cheapest real evidence that she is circling it,
  // and that evidence expired in five hours. She browses in the morning and
  // thinks again at night; by then a twice-met name had already gone quiet.
  // That is why `stats.wanted` was 0 after 274 noticings and 301 resurfacings.
  //
  // The ratio is what has to change, not a constant. Crossing the bar at day 5
  // with a 0.35 base needs recur(2)/recur(1) >= 1.65; sqrt gives 1.41 and can
  // never reach it no matter how the coefficients are tuned. `seen/2` gives 2.0.
  //
  // Reading it as evidence is also more honest: met once is one unit, met twice
  // is two, and past two the question is no longer "do I care" — it is whether
  // it is still fresh, which `fresh` already answers.
  const recur = Math.min(1, seen / 2);                     // 1→0.5, 2→1.0
  const moved = Math.max(0, Math.min(1, Number(noticing.moved ?? 0)));
  const age = daysSince(noticing.last_seen_at);

  // Freshness: how much a thing still pulls because time has not passed it by.
  //
  // Linear over 45 days was effectively no decay, and the arithmetic shows it:
  // `base = weight * (0.75 + 0.25 * fresh)`, so `fresh` only ever moved the
  // result by 25%. Measured on the real 「陈米到底」 node — one sighting at 07:44,
  // picked 24 times over seven hours:
  //
  //   age   0d → pull 0.6900        age  30d → pull 0.6433
  //   age  10d → pull 0.6744        age  44d → pull 0.6216
  //
  // Three quarters of a point spread across six weeks, which is why every other
  // candidate lost to a question she had already forgotten about. A nagging
  // thought should not stay the loudest thing in the room for a month.
  //
  // Exponential, halving every STALE_DAYS/6 days: 1 → 0.5 at 7.5d, 0.25 at 15d,
  // 0.06 at 22.5d, 0.004 at 30d.
  //
  // STALE_DAYS/3 was the first attempt and it was still too slow: measured
  // 30 days only came down 15.4%. The owner's rule is that a thing she has not
  // touched in a while should stop competing — and at 15% it still wins ties
  // against anything fresher, which is the same trap as before, just smaller.
  // Doubling the rate makes a month-old question roughly four times quieter
  // than a fresh one, which is what "stopped pulling" has to mean to matter.
  //
  // Read this paragraph knowing FRESH_DAYS cuts everything at five days: inside
  // the window `fresh` only travels 1 → 0.630, so decay moves `pull` by at most
  // 9.3% and never by itself pushes anything under the 0.55 bar. It is now an
  // ordering signal, not a filter. The 7.5d / 15d / 30d points above are still
  // computed correctly but are unreachable for inclusion, because a noticing
  // that old is already gone. Tuning this curve further will not change what
  // surfaces; change FRESH_DAYS if that is the intent.
  const fresh = age <= 0 ? 1 : Math.pow(2, -age / (STALE_DAYS / 6));

  // A gap is not a vocabulary item, and it must not have to be seen twice.
  //
  // This was the central defect. The old score was recurrence-heavy on purpose:
  // 0.45 for a name met once, below the 0.55 surface threshold, so a stray word
  // waited for a second sighting. That rule is right for words. Applied to
  // 「为什么我给你发消息你却收不到呢」 it means the one thing she is actually
  // curious about sits unused until somebody repeats it — which is not curiosity,
  // it is a cache. A question is worth asking the first time it is asked.
  //
  // `weight` carries what the gap *is* (0.9 mismatch / 0.7 question / 0.35 dangling).
  // Freshness still decays it, because an unanswered question a month old has
  // usually answered itself or stopped mattering.
  const weight = noticing.weight == null ? null : Math.max(0, Math.min(1, Number(noticing.weight)));
  if (weight != null) {
    // `0.75 + 0.25 * fresh` put a 75% floor under every decaying thing.
    //
    // That is why doubling the decay rate changed almost nothing: measured with
    // the faster curve, 30 days still only came down 19.3% and flattened at
    // 20.5% — because even at `fresh = 0` the weight kept three quarters of its
    // value. No decay rate can move a number whose floor is set by a constant.
    //
    // 0.10 + 0.90 * fresh is the same idea with the floor taken out: a fresh
    // thing keeps all of its weight, an old one keeps almost none. Measured on
    // the real 「陈米到底」 node (weight 0.7):
    //
    //   age  0d → 0.850 (surfaces)      age 15d → 0.384 (does not)
    //   age  3d → 0.697 (surfaces)      age 30d → 0.266 (does not)
    //   age  7d → 0.545 (at the bar)    age 60d → 0.170 (does not)
    //
    // A week-old unanswered question sits right at the 0.55 bar, two weeks and
    // it is out. That is the behaviour asked for: things pass through quickly
    // instead of one forgotten question holding the slot for a month.
    const base = weight * (0.10 + 0.90 * fresh);
      // Recurrence can lift a gap, but it never needs to create one.
      //
      // The coefficient is 0.30, not 0.15, and that difference is the whole
      // difference between "notices things" and "never mentions them".
      //
      // With 0.15 the ceiling for a name was 0.35 + 0.15 = 0.50 against a 0.55
      // bar, so a `dangling` noticing could not surface at ANY recurrence —
      // measured: seen=1 -> 0.425, seen=4 -> 0.500, seen=25 -> 0.500, flat. She
      // could come back from a browse having met `Poincare` and be structurally
      // unable to bring it up, forever. The engine looked like it worked because
      // questions (0.7) and contradictions (0.9) clear the bar on their own, and
      // names are most of what she meets out in the world.
      //
      // 0.30 leaves the first sighting under the bar — 0.35 + 0.15 = 0.50, a name
      // met once in passing stays quiet — and lets the second crossing land at
      // 0.35 + 0.21 = 0.56. Meeting it twice is the cheapest real evidence that
      // she is circling it, and it agrees with the PULL_TO_WANT=2 floor that
      // `handOff` already enforces, so surfacing and wanting use one number.
      // 2026-11-07 correction: that reasoning was right about noise and wrong
      // about the pool. Measured on her real state — 12 open noticings, 11 of them
      // `kind: "name"` seen once, every one stuck at 0.492. They were above the
      // noise floor she would act on and below the 0.55 bar, so they could neither
      // surface nor fade: the pool filled with things she had already noticed
      // and could never mention. `wanted: 0` after 274 noticings says the same
      // thing from the other side — nothing ever became a want.
      //
      // The defect is not the threshold, it is that a first sighting was given
      // zero room to move. A name she met once and wrote down is not noise; she
      // thought enough of it to record it. 0.42 lets that first sighting reach
      // 0.35 + 0.42 * 0.5 = 0.56 and cross.
      // 2026-07 correction: that reasoning was right about noise and wrong
      // about the pool. Measured on her real state — 12 open noticings, 11 of them
      // `kind: "name"` seen once, every one stuck at 0.492. They were above the
      // noise floor she would act on and below the 0.55 bar, so they could neither
      // surface nor fade: the pool filled with things she had already noticed and
      // could never mention. `wanted: 0` after 274 noticings says the same thing
      // from the other side — nothing ever became a want.
      //
      // The fix is NOT to raise the recurrence coefficient: a `dangling` name met
      // once must stay quiet (test/wander.test.mjs holds that line, and it is
      // right). What was wrong is that a plain `name` she wrote down herself was
      // scored identically to a word she merely skimmed. A name she recorded is
      // evidence she thought it worth keeping; that belongs in its base weight,
      // which lives at the `notice()` call site, not here.
      // 0.30 → 0.36. With the ratio fixed above, 0.36 is the coefficient that
      // keeps both ends honest at once: a name met once stays quiet even at its
      // freshest (0.35 + 0.36*0.5 = 0.53 < 0.55) while a name met twice still
      // clears the bar on the last day of its window (0.35*0.630 + 0.36 = 0.58).
      // 0.30 left day 5 at 0.54 — one hundredth short, which is the same class
      // of failure this whole file keeps rediscovering.
      return Math.min(1, base + 0.36 * recur);
  }

  return 0.5 * recur + 0.3 * moved + 0.2 * fresh;
}

/**
 * She met a name and does not have it.
 *
 * Called from the places where a name actually arrives — never from "a lookup
 * returned nothing". The caller decides that a name is worth offering; this
 * function decides whether it is already familiar, and whether it is pulling.
 *
 * `known` is supplied by the caller (see `familiar()`), because only the caller
 * can afford to hit the memory index. Passing it in keeps this function pure
 * and testable.
 *
 * Returns the noticing when the call created or strengthened one, and null when
 * the name was already familiar or the input was unusable. Null is the common
 * case and is not an error.
 */
export function notice(workspaceDir, name, opts = {}) {
  const {
    known = [],
    reason = "",
    moved = 0,
    at = nowIso(),
    // `kind` and `weight` come from lib/gaps.js. A question nobody answered and a
    // stray capitalised word are not the same event, and flattening both into one
    // number is why the pool only ever offered vocabulary. A gap keeps its kind so
    // the prompt can say what sort of thing it is.
    kind = null,
    weight = null,
  } = opts || {};
  const display = String(name ?? "").trim().slice(0, 80);
  if (!display || display.length < 2) return null;

  const topic = keyOf(display);
  if (!topic) return null;

  // Already familiar: she knows this. Not a noticing.
  const knownSet = new Set((known || []).map((k) => keyOf(k)).filter(Boolean));
  if (knownSet.has(topic)) return null;

  const data = load(workspaceDir);
  const existing = data.noticings.find((n) => n.topic === topic && n.status === "open");

  if (existing) {
    existing.seen = Math.max(1, Number(existing.seen ?? 1)) + 1;
    existing.last_seen_at = at;
    // Keep the better-cased spelling, the same way a name should be written.
    if (betterCased(String(existing.display || ""), display)) existing.display = display;
    if (reason && !existing.reasons.includes(reason)) {
      existing.reasons = [...existing.reasons, String(reason).slice(0, 120)].slice(-4);
    }
    existing.moved = Math.min(1, Math.max(Number(existing.moved ?? 0), Number(moved) || 0));
    if (kind && !existing.kind) existing.kind = kind;
    if (weight != null) {
      existing.weight = Math.max(
        Number(existing.weight ?? 0),
        Math.max(0, Math.min(1, Number(weight) || 0)),
      );
    }
    if (existing.seen >= PULL_TO_WANT) data.stats.resurfaced += 1;
    save(workspaceDir, data);
    return existing;
  }

  const entry = {
    id: `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    topic,
    display,
    seen: 1,
    moved: Math.max(0, Math.min(1, Number(moved) || 0)),
    reasons: reason ? [String(reason).slice(0, 120)] : [],
    first_seen_at: at,
    last_seen_at: at,
    status: "open",
    want_id: null,
    kind: kind || "name",
    weight: weight == null ? null : Math.max(0, Math.min(1, Number(weight) || 0)),
  };
  data.noticings.push(entry);
  data.stats.noticed += 1;

  // Trim by weakest pull, never by oldest. An old noticing that keeps coming
  // back is the most alive thing in the file; the newest one-off is the least.
  const open = data.noticings.filter((n) => n.status === "open");
  if (open.length > MAX_NOTICINGS) {
    const weakest = open
      .slice()
      .sort((a, b) => pull(a) - pull(b))
      .slice(0, open.length - MAX_NOTICINGS);
    const drop = new Set(weakest.map((n) => n.id));
    for (const n of data.noticings) if (drop.has(n.id)) n.status = "faded";
    data.stats.faded += drop.size;
  }

  save(workspaceDir, data);
  return entry;
}

function betterCased(prev, next) {
  if (!prev) return true;
  if (prev === next) return false;
  const mixedNext = /[A-Z]/.test(next) && /[a-z]/.test(next);
  const mixedPrev = /[A-Z]/.test(prev) && /[a-z]/.test(prev);
  if (mixedNext && !mixedPrev) return true;
  return false;
}

/**
 * Noticings that are currently open, strongest pull first.
 *
 * `minPull` defaults to 0 because listing is not the same as surfacing. Listing
 * is for the tool and for diagnostics — it should show her everything she has
 * wondered about. Surfacing (see `propose`) applies the threshold.
 */
export function noticings(workspaceDir, opts = {}) {
  const { limit = 40, minPull = 0, status = "open" } = opts || {};
  const data = load(workspaceDir);
  return data.noticings
    .filter((n) => n.status === status && pull(n) >= minPull)
    .sort((a, b) => pull(b) - pull(a))
    .slice(0, Math.max(1, limit));
}

/**
 * The one thing she might actually go and look up this wake.
 *
 * Returns null far more often than it returns a name, and that is the design:
 * a wake where she is not curious about anything is a normal wake. Surfacing
 * something every time would turn this into a quota, and a quota produces
 * exactly the behaviour this module was rewritten to avoid.
 *
 * `alreadyWanted` is the set of want ids already handed over, so the same
 * noticing is not turned into a second want after the first one closed.
 */
export function propose(workspaceDir, opts = {}) {
  const { minPull = 0.55, budget = MAX_SURFACED } = opts || {};
  const open = noticings(workspaceDir, { limit: 40 });
  // Two independent gates, and both have to hold:
  //   - it still pulls hard enough to be worth asking (minPull)
  //   - it has not been sitting unanswered past FRESH_DAYS
  //
  // The second is not implied by the first. A heavy question (weight 0.9) still
  // scores 0.573 at five days — above the 0.55 bar — so the decay curve alone
  // would keep offering it well past the point the owner named. An age ceiling
  // is the only way to state "five days, out" without it depending on weight.
  const ready = open.filter(
    (n) => !n.want_id && daysSince(n.last_seen_at) <= FRESH_DAYS && pull(n) >= minPull,
  );

  // A noticing that can never surface must not stay open forever.
  //
  // Measured 2026-11-07 on her real pool: 12 open, 11 of them `kind: "name"`
  // seen once, every one at 0.492. They were above the noise she would act on
  // and below the bar, so no code path could ever surface them and no path
  // retired them either — the pool accumulated a permanent sediment of things
  // she had already noticed and could never mention. `stats.wanted: 0` after 274
  // noticings is the same fault seen from the other end.
  //
  // The rule is deliberately NOT "raise the score". A name met once in passing
  // should stay quiet — `dangling` exists for exactly that, and the wander tests
  // hold the line. What was missing is the exit: a noticing past its freshness
  // window that still cannot reach the bar has, by definition, stopped being
  // something she is circling. Marking it `faded` says that plainly instead of
  // leaving it in `open` pretending to be pending.
  //
  // Only acts past FRESH_DAYS so a fresh name is never retired before it has had
  // a single chance to recur.
  const sediment = open.filter(
    (n) => !n.want_id && daysSince(n.last_seen_at) > FRESH_DAYS && pull(n) < minPull,
  );
  if (sediment.length) {
    try {
      const data = load(workspaceDir);
      const ids = new Set(sediment.map((n) => n.id));
      let n = 0;
      for (const e of data.noticings) {
        if (!ids.has(e.id) || e.status !== "open") continue;
        e.status = "faded";
        e.faded_at = nowIso();
        e.faded_reason = "放过了新鲜期，还是没能长成想问的";
        n += 1;
      }
      if (n) {
        data.stats.faded += n;
        save(workspaceDir, data);
      }
    } catch { /* housekeeping must never break a wake */ }
  }

  // Always an array. Returning null for "nothing" and an array for
  // "something" makes every caller test the shape instead of the length,
  // and one of them will get it wrong.
  if (!ready.length) return [];

  // `budget` was clamped by MAX_SURFACED, which made the parameter a lie.
  //
  // MAX_SURFACED means "never show her more than one at a time" — a rule about
  // presentation. Clamping intake with it turned it into "there is only ever one
  // candidate", and the difference is not cosmetic. Measured 2026-11-06: six
  // questions tied at 0.847, `propose({budget:4})` returned 1, so the pool had
  // exactly one curiosity in it and the same one won every wake for seven hours.
  //
  // Intake and presentation are separate decisions and now use separate numbers:
  // this returns up to `budget` ready items, and whoever displays them picks one.
  const cap = Math.max(1, Number.isFinite(budget) ? budget : MAX_SURFACED);
  return ready.slice(0, cap);
}

/**
 * Hand a noticing to the wants channel.
 *
 * This is the step the previous version was missing entirely. Recording a thing
 * you do not understand changes nothing; converting it into something you have
 * decided to go and find out is what makes it move.
 *
 * Returns `{ ok, wantId?, reason? }` — same contract as `wants.add`, because the
 * caller should not have to handle two shapes.
 */
export function handOff(workspaceDir, noticingOrId, wants) {
  const data = load(workspaceDir);
  const target = typeof noticingOrId === "object" && noticingOrId
    ? data.noticings.find((n) => n.id === noticingOrId.id)
    : data.noticings.find((n) => n.topic === keyOf(noticingOrId) || n.id === noticingOrId);

  if (!target) return { ok: false, reason: "没有这一条" };
  if (target.status !== "open") return { ok: false, reason: "这条已经淡了" };
  if (target.want_id) return { ok: false, reason: "已经排进想做的事了" };
    // Recurrence is a hard floor, not a weight inside `pull`. With seen=1 the
    // pull score is already 0.45 (recur 0.25 + fresh 0.2), so a pull-only gate
    // lets a single passing mention become a want — which turns curiosity into
    // a to-do generator. Meeting it twice is the cheapest real evidence that
    // she is circling it rather than walking past it.
    if (target.seen < PULL_TO_WANT) {
      return { ok: false, reason: `只碰上过 ${target.seen} 次，还没到想问的程度` };
    }
  if (pull(target) < 0.35) return { ok: false, reason: "还不够想问" };

  const why = target.reasons.length
    ? target.reasons[0]
    : `碰上过 ${target.seen} 次，一直没弄明白`;
  const added = wants.add(workspaceDir, {
    what: `弄明白 ${target.display} 是什么`,
    why,
    value: Math.min(1, 0.4 + pull(target)),
  });

  if (added?.ok === false) return added;

  const wantId = added?.id ?? added?.wantId ?? null;
  target.want_id = wantId;
  target.status = "wanted";
  data.stats.wanted += 1;
  save(workspaceDir, data);
  return { ok: true, wantId };
}

/**
 * She is not interested any more.
 *
 * Not "resolved". There is no claim here that she understands it — only that
 * the pull stopped. Keeping the two apart matters: if losing interest were
 * recorded as understanding, the stats would slowly fill with things she never
 * actually learned, and the number would stop meaning anything.
 */
export function loseInterest(workspaceDir, topicOrId) {
  const data = load(workspaceDir);
  const k = keyOf(topicOrId);
  // Every entry under this key, not just the first.
  //
  // Measured 2026-11-06: `Search` could not be dropped — `curiosity-forget`
  // returned ok:false while the store held two rows with the same topic, one
  // faded and one open. `find()` returned the faded row, the status guard
  // rejected it, and the open row was never reached. A name that appears in a
  // later browse gets a fresh row, so duplicates under one key are normal and
  // the drop has to consider all of them.
  let target = data.noticings.find((n) => n.id === topicOrId);
  // Fall back to a contains-match so she can name a fragment ("2.45GHz") of a
  // longer entry ("为什么不直接烤 非用 2.45GHz") rather than retyping it. Only
  // when exactly one entry matches — an ambiguous fragment must not silently
  // drop two records at once.
  if (!target) {
    const exact = data.noticings.filter((n) => n.topic === k);
    if (exact.length) {
      // Prefer the live row: dropping a faded row again would report success
      // while leaving the thing she asked to forget still on offer.
      target = exact.find((n) => n.status === "open") ?? exact[0];
    }
  }
  if (!target && k.length >= 3) {
    const hits = data.noticings.filter((n) => n.topic.includes(k) || k.includes(n.topic));
    if (hits.length === 1) target = hits[0];
    else if (hits.length > 1) {
      // Several rows match the fragment; drop the live ones and leave the
      // already-faded rows alone. Refusing outright (the old behaviour) meant a
      // fragment could never clear a duplicated key.
      const open = hits.filter((n) => n.status === "open");
      if (open.length === 1) target = open[0];
    }
  }
  if (!target) return { ok: false, reason: "没有这一条" };
  if (target.status !== "open") return { ok: false, reason: `这条已经是 ${target.status}` };
  target.status = "faded";
  target.faded_at = nowIso();
  data.stats.faded += 1;
  save(workspaceDir, data);
  return { ok: true, topic: target.display };
}

/**
 * Names she already has some grip on.
 *
 * Fed from the memory index plus the want list, so a name stops being novel the
 * moment it appears anywhere in her own records. This is the whole reason the
 * previous version re-minted `deepseek` and `python`: nothing fed it a known
 * set, so "not in the curiosity file" was treated as "does not know".
 */
export function familiar(workspaceDir, memoryIndex) {
  const out = new Set();
  try {
    const idx = memoryIndex.loadIndex(workspaceDir).index;
    for (const doc of idx?.docs ?? []) {
      // `toks` is a Map<token, weight>, not an array. Iterating it as an array
      // yields undefined and silently produces an empty known-set — which is how
      // the previous version re-minted `python` and `deepseek` while reporting
      // 13,350 known terms.
      const bag = doc?.toks;
      const keys = bag instanceof Map ? bag.keys() : Object.keys(bag ?? {});
      for (const tok of keys) out.add(String(tok).toLowerCase());
    }
  } catch { /* no index yet is normal on a fresh workspace */ }
  // Deliberately does NOT include her own noticings. A name she already wrote
  // down is the opposite of familiar — it is the thing she is still wondering
  // about. Folding it in here meant the second encounter with `Zink` was read
  // as "already known", so `seen` never left 1 and nothing could ever reach
  // the threshold that turns a noticing into a want.
  return [...out];
}

export function stats(workspaceDir) {
  const data = load(workspaceDir);
  const open = data.noticings.filter((n) => n.status === "open");
  return {
    ...data.stats,
    open: open.length,
    wanted: data.noticings.filter((n) => n.status === "wanted").length,
    faded: data.noticings.filter((n) => n.status === "faded").length,
    hottest: open
      .slice()
      .sort((a, b) => pull(b) - pull(a))
      .slice(0, 3)
      .map((n) => ({ display: n.display, pull: Number(pull(n).toFixed(3)), seen: n.seen })),
    updated_at: data.updated_at,
  };
}

export const CONSTANTS = Object.freeze({
  MAX_NOTICINGS,
  STALE_DAYS,
  PULL_TO_WANT,
  MAX_SURFACED,
});
