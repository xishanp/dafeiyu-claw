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
  const recur = Math.min(1, Math.sqrt(seen) / 2);          // 1→0.5, 4→1
  const moved = Math.max(0, Math.min(1, Number(noticing.moved ?? 0)));
  const age = daysSince(noticing.last_seen_at);
  const fresh = age >= STALE_DAYS ? 0 : Math.max(0, 1 - age / STALE_DAYS);

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
    const base = weight * (0.75 + 0.25 * fresh);
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
      return Math.min(1, base + 0.30 * recur);
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
  const ready = open.filter((n) => !n.want_id && pull(n) >= minPull);
  // Always an array. Returning null for "nothing" and an array for
  // "something" makes every caller test the shape instead of the length,
  // and one of them will get it wrong.
  if (!ready.length) return [];
  return ready.slice(0, Math.max(1, Math.min(MAX_SURFACED, budget)));
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
  let target = data.noticings.find((n) => n.id === topicOrId || n.topic === k);
  // Fall back to a contains-match so she can name a fragment ("2.45GHz") of a
  // longer entry ("为什么不直接烤 非用 2.45GHz") rather than retyping it. Only
  // when exactly one entry matches — an ambiguous fragment must not silently
  // drop two records at once.
  if (!target && k.length >= 3) {
    const hits = data.noticings.filter((n) => n.topic.includes(k) || k.includes(n.topic));
    if (hits.length === 1) target = hits[0];
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
