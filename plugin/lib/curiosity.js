// Curiosity: the questions she has run into and has not answered yet.
//
// Ported from dsh-brainagent's `curiosity-drive.ts` (Noncommercial License,
// personal use). The design there is right and the reason is worth keeping:
//
//   knowledge gaps are recorded when recall comes back empty
//
// Not "things I have not read yet" — that is a backlog, and a backlog is
// finite and feels like chores. A *gap* is a place where she reached for
// something and found nothing there. That is the only version of curiosity
// that regenerates itself: the more she knows, the more edges show up.
//
// What the original got wrong for our case, and what changed here:
//
// 1. `maxGaps = 15`. Too small to feel like curiosity; it becomes a to-do
//    list of five things. Raised to 200, and eviction is by *weakest
//    confidence*, not oldest — an old gap that keeps getting re-encountered is
//    the most interesting one there is.
//
// 2. The original only watched one signal (empty hippocampus recall). One
//    source in a system that produces four kinds of ignorance means the gap
//    list is almost always empty. Four inputs now feed it, each attributed, so
//    the injection can say *why* it came up instead of asserting a mood.
//
// 3. No decay. A gap encountered twice a year ago is not a live question.
//    `urgency()` folds encounter count against recency, so a gap she keeps
//    hitting floats and one she stopped hitting sinks without being deleted.
//
// 4. Gaps were never closed except by exact topic match. There is a `resolved`
//    state with a note now, because "I found out" and "I stopped caring" are
//    different endings and conflating them teaches the wrong thing.
//
// Storage is one JSON file, written atomically, capped. Every mutation is
// cheap: this runs inside hooks that must not stall a turn.

import fs from "node:fs";
import path from "node:path";

const FILE = "curiosity.json";
const VERSION = 1;

/** Cap. Generous on purpose: a short list turns curiosity into a chore list. */
const MAX_GAPS = 200;

/** Below this, a mention was too weak to call a gap. Matches the original. */
const MIN_CONFIDENCE = 0.3;

/**
 * A gap that has not been touched in this long still exists, but stops being
 * proposed. Kept (not deleted) because the whole point is that she can come
 * back to it: the interesting ones are the ones that keep resurfacing.
 */
const STALE_DAYS = 120;

/** How many open gaps the injector may ever show at once. One is enough. */
const PROPOSE_LIMIT = 1;

/**
 * Confidence assigned per source.
 *
 * These are not arbitrary. `recall` is the strongest possible signal: she went
 * looking and the shelf was empty. `question` is next: she said out loud that
 * she did not know. `search` is weaker because a search she *did* run means
 * she was already working on it. `browse` is weakest: noticing a word she does
 * not recognise is a nudge, not a felt gap.
 */
const SOURCE_CONFIDENCE = Object.freeze({
  recall: 0.7,
  question: 0.65,
  search: 0.4,
  browse: 0.35,
});

/** Domains, mirroring the original's taxonomy closely enough to be readable. */
const DOMAINS = Object.freeze([
  "knowledge",
  "person",
  "method",
  "place",
  "event",
  "word",
]);

function nowIso() {
  return new Date().toISOString();
}

function filePath(workspaceDir) {
  return path.join(workspaceDir, "state", FILE);
}

function emptyState() {
  return {
    version: VERSION,
    gaps: [],
    stats: {
      detected: 0,
      encounters: 0,
      resolved: 0,
      proposed: 0,
      evicted: 0,
    },
    updated_at: nowIso(),
  };
}

/**
 * Load, tolerating every kind of damage.
 *
 * A corrupt curiosity file must never break a heartbeat. The cost of starting
 * over is a handful of forgotten questions; the cost of throwing inside
 * `after_tool_call` is a broken turn.
 */
export function load(workspaceDir) {
  try {
    const raw = fs.readFileSync(filePath(workspaceDir), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return emptyState();
    const gaps = Array.isArray(data.gaps) ? data.gaps.filter(isGap) : [];
    const stats = data.stats && typeof data.stats === "object" ? data.stats : {};
    return {
      version: VERSION,
      gaps,
      stats: {
        detected: Number(stats.detected ?? 0),
        encounters: Number(stats.encounters ?? 0),
        resolved: Number(stats.resolved ?? 0),
        proposed: Number(stats.proposed ?? 0),
        evicted: Number(stats.evicted ?? 0),
      },
      updated_at: data.updated_at || nowIso(),
    };
  } catch {
    return emptyState();
  }
}

function isGap(g) {
  return (
    g &&
    typeof g === "object" &&
    typeof g.id === "string" &&
    typeof g.topic === "string" &&
    g.topic.trim().length > 0 &&
    typeof g.status === "string"
  );
}

/**
 * Atomic-ish save: write beside, then rename.
 *
 * `rename` is atomic on the same filesystem, so a crash mid-write leaves the
 * previous file intact rather than a truncated one. The original used the same
 * approach (`atomicWrite`); the reason is worth stating because a naive
 * `writeFileSync` here would eventually eat the whole gap list.
 */
export function save(workspaceDir, data) {
  const target = filePath(workspaceDir);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const body = JSON.stringify(
      { ...data, version: VERSION, updated_at: nowIso() },
      null,
      2,
    );
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, target);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing useful to do */
    }
  }
}

/** Normalise a topic so "Foo Bar" and "Foo  bar " collapse to one gap. */
export function normaliseTopic(topic) {
  return String(topic ?? "")
    .toLowerCase()
    .replace(/[「」『』"'“”‘’《》〈〉【】\[\]()（）]/g, "")
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[。，、；：！？…,.!?;:]+$/g, "")
    .trim()
    .slice(0, 80);
}

function hashId(topic) {
  // Stable id so the same topic always lands on the same gap even if the
  // file is rebuilt. djb2, because a collision here costs nothing.
  let h = 5381;
  for (let i = 0; i < topic.length; i++) {
    h = ((h << 5) + h + topic.charCodeAt(i)) >>> 0;
  }
  return `gap-${h.toString(36)}`;
}

function daysSince(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 86_400_000;
}

/**
 * Record that she ran into something she does not know.
 *
 * Repeat encounters are the whole mechanism: information-gap theory says
 * curiosity is strongest at a *moderate* gap, and what produces a moderate gap
 * is having bumped into the edge more than once. So a second sighting is worth
 * more than a first, and confidence climbs with each one, capped at 1.
 *
 * Returns the gap that was touched, or null when the mention was too weak.
 * Never throws.
 */
export function note(workspaceDir, topic, opts = {}) {
  try {
    const clean = normaliseTopic(topic);
    if (!clean || clean.length < 2) return null;

    const source = String(opts.source || "").trim();
    const base = Number(SOURCE_CONFIDENCE[source] ?? opts.confidence ?? 0.4);
    if (!Number.isFinite(base) || base < MIN_CONFIDENCE) return null;

    const data = load(workspaceDir);
    const id = hashId(clean);
    const at = nowIso();

    const existing = data.gaps.find((g) => g.id === id);
    if (existing) {
      // Reopened if it had been resolved: running into it again after "finding
      // out" means the answer did not stick, which is itself informative.
      if (existing.status !== "open") {
        existing.status = "open";
        existing.resolved_at = null;
        existing.resolve_note = null;
      }
      existing.times_encountered = Number(existing.times_encountered ?? 1) + 1;
      existing.last_encountered = at;
      existing.confidence = Math.min(1, Number(existing.confidence ?? 0.4) + 0.1);
      // Prefer the better-cased spelling, not the first one seen. Measured on
      // real douyin titles: `DeepSeek` in the title, `deepseek` in the hashtag,
      // and the gap was created from whichever arrived first. A proper noun
      // rendered as `deepseek` in a prompt looks like a typo and reads as a
      // word she does not know the shape of.
      if (opts.display) {
        const prev = String(existing.display || "");
        const next = String(opts.display).trim().slice(0, 80);
        if (next && betterCased(prev, next)) existing.display = next;
      }
      if (source && !existing.sources.includes(source)) existing.sources.push(source);
      if (opts.context && !existing.contexts.includes(opts.context)) {
        existing.contexts.push(String(opts.context).slice(0, 120));
        existing.contexts = existing.contexts.slice(-5);
      }
      data.stats.encounters += 1;
      data.stats.detected += 0;
      save(workspaceDir, data);
      return existing;
    }

    const gap = {
      id,
      topic: clean,
      display: String(opts.display || topic).trim().slice(0, 80),
      domain: DOMAINS.includes(opts.domain) ? opts.domain : "knowledge",
      confidence: Math.min(1, base),
      sources: source ? [source] : [],
      contexts: opts.context ? [String(opts.context).slice(0, 120)] : [],
      found_at: at,
      last_encountered: at,
      times_encountered: 1,
      status: "open",
      resolved_at: null,
      resolve_note: null,
      proposed_count: 0,
      last_proposed_at: null,
    };

    data.gaps.push(gap);
    data.stats.detected += 1;

    // Evict weakest, not oldest. An old gap that keeps coming up is the most
    // alive thing in the list, so age alone must never be the reason it dies.
    const open = data.gaps.filter((g) => g.status === "open");
    if (open.length > MAX_GAPS) {
      open.sort((a, b) => Number(a.confidence) - Number(b.confidence));
      const weakest = open[0];
      weakest.status = "dropped";
      weakest.resolve_note = "evicted: lowest confidence";
      data.stats.evicted += 1;
    }

    save(workspaceDir, data);
    return gap;
  } catch {
    return null;
  }
}

/**
 * How much this gap wants attention, 0..1.
 *
 * Encounter count is the main term — the original's `timesEncountered` — but
 * raw count alone lets an ancient gap outrank a live one forever. The recency
 * factor is what makes the list feel like it is about *now*. Square-root on
 * the count so the fifth sighting still matters without the thirtieth
 * swamping everything else.
 */
export function urgency(gap) {
  // Exported, so it is callable with anything. A null here used to throw inside
  // `stats()`, which is called from a tool; a tool that throws mid-turn is a
  // broken turn, not a wrong number. Zero is the honest answer for "not a gap".
  if (!gap || typeof gap !== "object") return 0;
  const n = Math.max(1, Number(gap.times_encountered ?? 1));
  const count = Math.min(1, Math.sqrt(n) / 4); // 1→0.25, 4→0.5, 16→1
  const age = daysSince(gap.last_encountered);
  const fresh = age >= STALE_DAYS ? 0 : Math.max(0, 1 - age / STALE_DAYS);
  const conf = Math.max(0, Math.min(1, Number(gap.confidence ?? 0.4)));
  // Never proposed: small bonus, because an unasked question is unserved.
  const unasked = Number(gap.proposed_count ?? 0) === 0 ? 0.08 : 0;
  return Math.min(1, 0.42 * count + 0.30 * fresh + 0.28 * conf + unasked);
}

/** Every open gap, ranked. Unbudgeted, for tools that want the whole picture. */
export function gaps(workspaceDir, opts = {}) {
  // Callers pass `undefined` freely; `null` arrives from parsed JSON that had
  // the key and no value. Both mean "no options", and neither is worth a throw
  // on a hot path.
  if (!opts || typeof opts !== "object") opts = {};
  const data = load(workspaceDir);
  const limit = Number(opts.limit ?? 50);
  return data.gaps
    .filter((g) => g.status === "open")
    .filter((g) => daysSince(g.last_encountered) <= STALE_DAYS)
    .map((g) => ({ ...g, urgency: urgency(g) }))
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, Math.max(1, limit));
}

/**
 * The one gap worth mentioning right now, or null.
 *
 * One, deliberately: a prompt that lists five open questions is a prompt that
 * says "do your homework". The whole difference between curiosity and a
 * backlog is that a person follows one thread at a time.
 *
 * `budget` mirrors lib/activities.js — callers that dispatch a single thing
 * per wake pass 1, and the budget is honoured as a hard cap rather than a
 * probability, because a probabilistic injector is impossible to reason about
 * when a turn does not mention anything.
 */
export function propose(workspaceDir, opts = {}) {
  if (!opts || typeof opts !== "object") opts = {};
  const budget = Math.max(0, Number(opts.budget ?? PROPOSE_LIMIT));
  if (budget <= 0) return [];
  const ranked = gaps(workspaceDir, { limit: Math.min(budget, PROPOSE_LIMIT) });
  if (opts.markProposed !== false && ranked.length > 0) {
    try {
      const data = load(workspaceDir);
      for (const pick of ranked) {
        const g = data.gaps.find((x) => x.id === pick.id);
        if (!g) continue;
        g.proposed_count = Number(g.proposed_count ?? 0) + 1;
        g.last_proposed_at = nowIso();
      }
      data.stats.proposed += ranked.length;
      save(workspaceDir, data);
    } catch {
      /* proposing without recording the count is survivable */
    }
  }
  return ranked;
}

/**
 * Close a gap.
 *
 * `how` separates two endings that the original collapsed into one:
 *   "found"  — she learned the answer
 *   "dropped"— she decided she does not care
 * Both stop the question; only one counts as knowledge. Keeping them apart
 * matters because `found` is the only one that can be checked later, and
 * `dropped` is the honest exit that stops the list becoming guilt.
 */
export function resolve(workspaceDir, topicOrId, how = "found", note = null) {
  try {
    const key = String(topicOrId ?? "").trim();
    if (!key) return null;
    const clean = normaliseTopic(key);
    const data = load(workspaceDir);
    const gap = data.gaps.find(
      (g) => g.id === key || g.id === hashId(clean) || normaliseTopic(g.display) === clean,
    );
    if (!gap) return null;
    const status = how === "dropped" ? "dropped" : "resolved";
    if (gap.status === status) return gap;
    gap.status = status;
    gap.resolved_at = nowIso();
    gap.resolve_note = note ? String(note).slice(0, 200) : null;
    if (status === "resolved") data.stats.resolved += 1;
    save(workspaceDir, data);
    return gap;
  } catch {
    return null;
  }
}

/**
 * Is `next` a better spelling of the same term than `prev`?
 *
 * Deliberately crude: an uppercase letter anywhere means the writer cared
 * about the shape. `DeepSeek` beats `deepseek`; `DEEPSEEK` does not beat
 * `DeepSeek` (shouting is not better casing), and neither beats an equal
 * alternative. Only ever upgrades, never downgrades.
 */
function betterCased(prev, next) {
  if (!prev) return true;
  if (prev === next) return false;
  const mixedNext = /[A-Z]/.test(next) && /[a-z]/.test(next);
  const mixedPrev = /[A-Z]/.test(prev) && /[a-z]/.test(prev);
  const upperNext = next === next.toUpperCase() && /[A-Z]/.test(next);
  const upperPrev = prev === prev.toUpperCase() && /[A-Z]/.test(prev);
  if (mixedNext && !mixedPrev) return true;
  if (upperNext && !mixedNext && !upperPrev && !mixedPrev) return true;
  return false;
}

/** Terms she already knows, so the browse source stops re-minting them. */
export function knownTerms(workspaceDir) {
  try {
    const data = load(workspaceDir);
    const out = new Set();
    for (const g of data.gaps) {
      // Both the normalised topic and the display form: a term recorded as
      // `deepseek` must also suppress a later `DeepSeek`.
      if (g.topic) out.add(String(g.topic).toLowerCase());
      if (g.display) out.add(String(g.display).toLowerCase());
    }
    return [...out];
  } catch {
    return [];
  }
}

/** Diagnostics, for the tool and for selfcheck. */
export function stats(workspaceDir) {
  const data = load(workspaceDir);
  const open = data.gaps.filter((g) => g.status === "open");
  return {
    ...data.stats,
    open: open.length,
    dropped: data.gaps.filter((g) => g.status === "dropped").length,
    stale: open.filter((g) => daysSince(g.last_encountered) > STALE_DAYS).length,
    hottest: open
      .map((g) => ({ topic: g.display, urgency: Number(urgency(g).toFixed(3)) }))
      .sort((a, b) => b.urgency - a.urgency)
      .slice(0, 3),
    updated_at: data.updated_at,
  };
}

export const CONSTANTS = Object.freeze({
  MAX_GAPS,
  MIN_CONFIDENCE,
  STALE_DAYS,
  PROPOSE_LIMIT,
  SOURCE_CONFIDENCE,
  DOMAINS,
});
