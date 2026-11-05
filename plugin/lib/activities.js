// Activity kinds: what she can actually do, and which ones she has not tried.
//
// Why this file exists.
//
// Read 2026-11-05, from `beijingwahw/dsh-proactive` `src/curiosity-engine.ts`.
// That engine generates exploration proposals from `KnowledgeGap`:
//
//   reason: 'unexplored' | 'low-experience' | 'high-failure' | 'topological'
//
// It never invents an interest. It measures where its own experience is thin and
// points at the thinnest part. Three provider calls supply the numbers:
// getExposure(), getExperienceCounts(), getFailureRates().
//
// Copying that here requires one thing that does not exist yet: a fixed
// vocabulary of activity types to count against. Their task types are work units
// (`gen-*`, `review-*`) assigned by a dispatcher. She has no dispatcher, so the
// vocabulary has to be hers.
//
// Enumerated from her own diary on 2026-11-05 (all 7 days, verb frequency):
//
//   刷到 42 · 画了 30 · 写了 11 · 量了 7 · 看了 7 · 查了 6 · 翻了 5
//   数了 4 · 刷了 4 · 算了 3 · 画完 3 · 问过 2 · 试了 2 · 记了 2
//
// Grouped into the kinds below. Two notes on reading that list:
//
// - 刷到 is almost entirely passive — "刷到一条讲哈雷彗星的", a video that came
//   past her. It is not something she chose to do, so it counts as exposure in
//   the `scroll` kind but must not be scored as production.
// - Everything before 2026-11-03 shows zero for these verbs because the tools
//   were not wired yet. The table starts counting from then; the gap engine
//   already ignores kinds with no exposure at all by treating them as
//   `unexplored`, which is the correct reading.

import fs from "node:fs";
import path from "node:path";

const FILE = "activity-kinds.json";

/**
 * The vocabulary. `verbs` are matched against diary text to attribute an entry
 * to a kind; `made` marks kinds that produce something she can point at later,
 * which is how production is told apart from consumption.
 */
export const KINDS = {
  lookup: {
    label: "查一件事",
    verbs: ["查", "搜", "问过", "找到"],
    made: false,
    ease: 0.9,
    hint: "弄明白一个具体的为什么",
  },
  draw: {
    label: "画点东西",
    verbs: ["画了", "画完", "画"],
    made: true,
    ease: 0.8,
    hint: "手上出图，不用等人要",
  },
  shoot: {
    label: "拍一张",
    verbs: ["拍了", "拍了一张"],
    made: true,
    ease: 0.95,
    hint: "拍自己、拍窗外、拍手上的东西",
  },
  count: {
    label: "数/量一遍",
    verbs: ["数了", "量了", "算了"],
    made: false,
    ease: 0.85,
    hint: "把一件事算清楚、量到底",
  },
  scroll: {
    label: "刷一会儿",
    verbs: ["刷到", "刷了"],
    made: false,
    ease: 0.95,
    hint: "看别人做的东西，被动也算",
  },
  read: {
    label: "读点东西",
    verbs: ["读了", "翻了", "看了"],
    made: false,
    ease: 0.8,
    hint: "书、长文、别人的旧帖子",
  },
  write: {
    label: "写一段",
    verbs: ["写了", "记了"],
    made: true,
    ease: 0.6,
    hint: "不只是记日记，是写出点成篇的东西",
  },
  try: {
    label: "试个新的",
    verbs: ["试了"],
    made: true,
    ease: 0.5,
    hint: "没用过的工具、没走过的路、没吃过的东西",
  },
  talk: {
    label: "找人聊",
    verbs: ["问过", "说了"],
    made: false,
    ease: 0.7,
    hint: "主动起话头，不是回话",
  },
  make: {
    label: "做个东西",
    verbs: ["拼了", "做了", "改了"],
    made: true,
    ease: 0.55,
    hint: "除了画和写，动手做出一个物件",
  },
  tidy: {
    label: "收拾一遍",
    verbs: ["整理了", "收拾", "归了"],
    // Cleaning does not make a new thing, it reorders what exists. Marking it
    // `made` put it behind every non-producing kind in tie-breaks, which hid
    // the gap that most needed showing.
    made: false,
    ease: 0.9,
    hint: "自己的文件、记忆、桌面、以前的作品",
  },
  idle: {
    label: "什么都不干",
    // These verbs were empty in the first version, which made this kind
    // undetectable: classify() returned null for every line, the counter stayed
    // at zero, and zero exposure reads as `unexplored`, so novelty pinned at 1.0
    // forever. The single least-eventful activity became the system's top
    // recommendation on every single wake.
    verbs: ["待着", "发呆", "什么都没干", "没干", "坐着", "睡到", "睡了一"],
    made: false,
    ease: 1,
    // Never proposed, only counted.
    //
    // Verified 2026-11-05 on the first live turn: she was told "you have never
    // done nothing", the engine chose `do`, and she answered NO_REPLY — which is
    // exactly doing nothing. But doing nothing leaves no observable trace, so
    // exposure never rose and the identical suggestion returned on the next
    // wake. The recommendation bypassed its own measurement: a permanent loop
    // wearing the costume of curiosity.
    //
    // "Doing nothing is a legitimate choice" is a permission and belongs in the
    // prompt. It is not a proposal, because a proposal that cannot be observed
    // as completed can never be resolved.
    proposable: false,
    hint: "坐着、听外面的声音、睡着。这一条和其他一样正当",
  },
};

function file(workspaceDir) {
  return path.join(workspaceDir, "state", FILE);
}

function load(workspaceDir) {
  try {
    const d = JSON.parse(fs.readFileSync(file(workspaceDir), "utf8"));
    if (d && typeof d.kinds === "object") return d;
  } catch {}
  return { version: 1, kinds: {}, updated_at: null };
}

function save(workspaceDir, data) {
  const f = file(workspaceDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
}

function emptyStat() {
  return { exposure: 0, done: 0, failed: 0, noted: 0, suggested: 0, last_at: null };
}

/** Attribute one diary line to a kind, if it names an activity. */
export function classify(line) {
  const s = String(line || "");
  if (!s.trim()) return null;
  // Longest verb first so "查明白" is not read as "查".
  const hits = [];
  for (const [kind, def] of Object.entries(KINDS)) {
    for (const v of def.verbs) {
      if (s.includes(v)) hits.push({ kind, verb: v, len: v.length });
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.len - a.len);
  return hits[0].kind;
}

/**
 * Rebuild counts from the diary.
 *
 * Reading the source of truth beats maintaining a separate counter that can
 * drift. Diary files are small and this runs at most once per wake.
 */
export function scan(workspaceDir, { days = 14 } = {}) {
  const dir = path.join(workspaceDir, "memory");
  const data = load(workspaceDir);
  const previous = data.kinds || {};
  const kinds = {};
  for (const k of Object.keys(KINDS)) {
    // Carry forward what `note()` recorded. Wiping every counter here meant a
    // kind she explicitly logged could lose its entry the next time the diary
    // was scanned, so the number she saw depended on which function ran last.
    // Diary counts are authoritative for exposure; manual notes keep whatever
    // the diary cannot see (a failure, an attempt that produced nothing).
    const prev = previous[k] || {};
    kinds[k] = {
      exposure: 0,
      done: 0,
      failed: Number(prev.failed) || 0,
      noted: Number(prev.noted) || 0,
      last_at: prev.last_at || null,
    };
  }

  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
  } catch {
    return data;
  }
  names.sort();
  const recent = names.slice(-days);

  for (const name of recent) {
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    const day = name.replace(".md", "");
    for (const line of raw.split("\n")) {
      const s = line.replace(/^\s*-?\s*/, "").trim();
      if (s.length < 6 || /^#/.test(s)) continue;
      const kind = classify(s);
      if (!kind) continue;
      // 刷到 is something that passed her by, not something she did. Count the
      // exposure so the kind is not "unexplored", but never count it as output.
      const passive = s.includes("刷到");
      kinds[kind].exposure += 1;
      if (!passive) kinds[kind].done += 1;
      if (!kinds[kind].last_at || `${day}` > kinds[kind].last_at) kinds[kind].last_at = day;
    }
  }

  data.kinds = kinds;
  data.updated_at = new Date().toISOString();
  save(workspaceDir, data);
  return data;
}

/** Record a finished attempt, so scoring does not have to wait for a diary edit. */
export function markSuggested(workspaceDir, kind, { persist = true } = {}) {
  const data = load(workspaceDir);
  if (!data.kinds[kind]) return { ok: false };
  if (persist) {
    const st = data.kinds[kind];
    // Observation only — this does not feed the score.
    //
    // curiosity-engine has no "times suggested" counter; its scarcity term tracks
    // completed explorations (`recordExploration`). Keeping a record of what was
    // offered is useful for reading back what happened, but letting it move the
    // ranking is a mechanism they do not have and I should not have invented.
    // Date-gated so a per-minute heartbeat does not write sixty times a day.
    const today = new Date().toISOString().slice(0, 10);
    const lastDay = String(st.suggested_at || "").slice(0, 10);
    if (lastDay !== today) {
      st.suggested = (Number(st.suggested) || 0) + 1;
      st.suggested_at = new Date().toISOString();
      save(workspaceDir, data);
    }
  }
  return { ok: true, suggested: Number(data.kinds[kind].suggested) || 0 };
}

/**
 * The kind with the most use, for contrast in the prompt.
 *
 * "你画了 65 次，收拾一次都没干过" is a fact about her. "去收拾一下" is an
 * instruction. Keeping the comparison means the gap arrives as an observation
 * rather than an assignment.
 */
export function mostUsed(workspaceDir) {
  const data = load(workspaceDir);
  const kinds = data.kinds || {};
  let top = null;
  for (const [kind, v] of Object.entries(kinds)) {
    if (!KINDS[kind]) continue;
    const n = Number(v.exposure) || 0;
    if (!top || n > top.exposure) top = { kind, exposure: n, label: KINDS[kind].label };
  }
  return top && top.exposure > 0 ? top : null;
}

/**
 * Summary line for the prompt: how many kinds are tracked, which one dominates.
 *
 * Dropped during the rewrite to curiosity-engine's shape and restored here — the
 * model and the injector both read it, so removing it silently broke callers.
 */
export function stats(workspaceDir) {
  const data = load(workspaceDir);
  const kinds = data.kinds || {};
  const entries = Object.entries(kinds).filter(([k]) => KINDS[k]);
  const tracked = entries.filter(([, v]) => (v.exposure || 0) > 0).length;
  let top = null;
  for (const [kind, v] of entries) {
    if (!top || (v.exposure || 0) > (top.exposure || 0)) top = { kind, ...v };
  }
  return {
    tracked,
    top: top ? { kind: top.kind, label: KINDS[top.kind].label, exposure: top.exposure || 0 } : null,
    kinds,
  };
}

export function note(workspaceDir, kind, { ok = true } = {}) {
  if (!KINDS[kind]) return { ok: false, reason: "没有这个类型" };
  const data = load(workspaceDir);
  const stat = data.kinds[kind] || emptyStat();
  stat.exposure += 1;
  stat.noted = (Number(stat.noted) || 0) + 1;
  if (ok) stat.done += 1;
  else stat.failed += 1;
  stat.last_at = new Date().toISOString().slice(0, 10);
  data.kinds[kind] = stat;
  save(workspaceDir, data);
  return { ok: true };
}

/**
 * Lowest novelty score still worth showing her.
 *
 * curiosity-engine has no such floor — `proposeExplorations()` returns whatever
 * `scanKnowledgeGaps()` found, cut only by budget. The floor exists here because
 * their consumer is a dispatcher that acts on every proposal, and ours is a
 * sentence in a prompt she may or may not follow. Printing a weak suggestion
 * every wake trains her to ignore the line.
 *
 * 0.7 was the first value and it was too high. Measured 2026-11-05T14:00: she
 * tidied once that afternoon, so `tidy` moved from `unexplored` (0.7) to
 * `low-experience` (0.405) and the only candidate in the pool was cut. She did
 * the thing and the system stopped suggesting things — the opposite of the
 * intent. 0.2 keeps low-exposure kinds alive without letting noise through.
 *
 * Keep this as one named constant. The value lived inline at two call sites
 * (`index.js` and `lib/intent.js`) and they would drift apart on the next edit.
 */
export const PROPOSAL_FLOOR = 0.2;

/** Defaults from curiosity-engine.ts DEFAULT_CURIOSITY_CONFIG. */
export const DEFAULT_CURIOSITY_CONFIG = {
  explorationBudgetRatio: 0.3,
  lowExperienceThreshold: 2,
  highFailureRateThreshold: 0.5,
  noveltyUnknownWeight: 0.5,
  noveltyExposureWeight: 0.3,
  noveltyScarcityWeight: 0.2,
};

/**
 * Which kinds are knowledge gaps, scored exactly as `curiosity-engine` scores them.
 *
 * Ported from beijingwahw/dsh-proactive src/curiosity-engine.ts
 * `scanKnowledgeGaps()` (878-line file; this is the part that decides what gets
 * proposed). Their engine cannot be installed here — dsh-proactive is a Cordis
 * plugin for a different runtime — so the algorithm is transcribed rather than
 * imported. The published npm build (0.3.2) predates this file entirely, which
 * makes the GitHub source the only reference.
 *
 * Three things were wrong in my first implementation, all from writing it myself
 * instead of following theirs:
 *
 * 1. `exposureScore` runs the other way. Theirs is `exposureCount / maxExposure`
 *    — proportional, so "never seen" scores 0. I had used normalised exposure as
 *    a scarcity term (1 − norm), which inverted the meaning.
 *
 * 2. `scarcityScore` is `1 / (1 + explorationCount)` — smooth and unbounded,
 *    decaying with every real exploration. I had invented a saturating
 *    `1 − min(1, suggested/4)` over *suggestions*, a different quantity.
 *
 * 3. `explorationCount` counts *completions* (`recordExploration` is called when
 *    the exploration finishes), not suggestions. Counting suggestions meant the
 *    score moved while nothing had happened.
 *
 * Their rule for what even enters the pool is the sharpest difference:
 *
 *     if (experienceCount === 0) reason = 'unexplored';
 *     else if (failureRate >= 0.5) reason = 'high-failure';
 *     else if (experienceCount < 2)    reason = 'low-experience';
 *     if (!reason) continue;
 *
 * Two completions and the kind leaves the candidate pool permanently. There is no
 * tier above "low-experience" — done twice is done. My version kept every kind in
 * play with an `unexplored`/`thin` label, which is why `draw` (65 sessions) could
 * still surface.
 */
export function gaps(workspaceDir, { limit = 3, exclude = [], dispatchSlots = 1 } = {}) {
  const cfg = { ...DEFAULT_CURIOSITY_CONFIG };
  const data = load(workspaceDir);
  const kinds = data.kinds || {};

  // Their provider.getExposure() returns every known task type, including ones
  // with zero occurrences. Ours can only know types already observed in the
  // diary, so the twelve enumerations stand in for the exposure key set.
  const exposure = {};
  for (const kind of Object.keys(KINDS)) {
    exposure[kind] = (kinds[kind] && kinds[kind].exposure) || 0;
  }
  const maxExposure = Math.max(1, ...Object.values(exposure));

  const scored = [];
  for (const [kind, def] of Object.entries(KINDS)) {
    if (exclude.includes(kind)) continue;
    // No observable footprint => never proposed. See the `idle` entry.
    if (def.proposable === false) continue;

    const st = kinds[kind] || emptyStat();
    const exposureCount = exposure[kind] || 0;
    const experienceCount = Number(st.done) || 0;
    const failureRate = exposureCount ? (Number(st.failed) || 0) / exposureCount : 0;
    // Their `recordExploration()` increments `explorationCounts` when an
    // exploration *finishes* — never at proposal time. The diary is the record of
    // what finished, so completions are the honest source for this term.
    //
    // The first version counted suggestions instead (`suggested`, once per day).
    // That moved the score while nothing had happened, and it was a quantity
    // their engine does not have at all.
    const explorationCount = experienceCount;

    // THE ONE PLACE THIS DELIBERATELY DIVERGES FROM curiosity-engine.
    //
    // Their line is `if (!reason) continue` — two completions and the kind is
    // gone from the pool forever. That is correct for what they built: a
    // dispatcher draining a work queue, where a task twice done is a task
    // closed. It is wrong for a character who is supposed to have a life.
    //
    // Measured 2026-11-05: all twelve kinds had done >= 2, so `gaps()` returned
    // an empty array and `activity-inject` logged 79 consecutive empties from
    // 08:29 onward. She then spent a day re-digging one question twenty times.
    // Her own diary named it: 「没别的事可做」.
    //
    // Doing more of a thing must not make it vanish from her imagination. So a
    // mature kind stays in the pool, ranked below the thin ones. It is not
    // "done", it is "whatever she feels like".
    let reason = null;
    if (experienceCount === 0) reason = "unexplored";
    else if (failureRate >= cfg.highFailureRateThreshold) reason = "high-failure";
    else if (experienceCount < cfg.lowExperienceThreshold) reason = "low-experience";
    else reason = "mature";

    // Mature kinds get a novelty that decays with use but never reaches zero:
    // 0.35 at the threshold, floored at 0.12 however many times she has done it.
    // A floor, not a slope to nothing, because "I have drawn 71 times" is not a
    // reason to never draw again — it is a reason to draw sooner or later.
    const matureNovelty = Math.max(0.12, 0.35 - 0.02 * (experienceCount - cfg.lowExperienceThreshold));

    const unknownScore =
      reason === "unexplored"
        ? 1
        : reason === "low-experience"
          ? 0.6
          : reason === "high-failure"
            ? 0.4
            : matureNovelty;
    // The exposure term was calibrated on a pool that structurally could not
    // contain mature kinds, so every member had a small exposure and
    // `exposureCount / maxExposure` served as a tiebreaker among fresh things.
    //
    // Now that mature kinds are allowed in, that same term does the opposite of
    // what it is named for: `draw` has 72 exposures against a max of 72, so it
    // scored a full 0.3 and outranked `tidy` (3 completions) — the most-repeated
    // activity promoted above the least-repeated one, in a feature whose entire
    // purpose is variety. Measured 2026-11-05 immediately after adding the mature
    // tier.
    //
    // Zeroing it for mature kinds only. For `unexplored` and `low-experience`
    // the value is untouched, so behaviour inside the original engine's domain is
    // bit-for-bit what it was.
    const exposureScore = reason === "mature" ? 0 : exposureCount / maxExposure;
    const scarcityScore = 1 / (1 + explorationCount);
    const noveltyScore =
      unknownScore * cfg.noveltyUnknownWeight +
      exposureScore * cfg.noveltyExposureWeight +
      scarcityScore * cfg.noveltyScarcityWeight;

    scored.push({
      kind,
      label: def.label,
      hint: def.hint,
      made: def.made,
      exposure: exposureCount,
      done: experienceCount,
      failed: Number(st.failed) || 0,
      ease: def.ease ?? 0.5,
      reason,
      // How long since the diary last recorded this kind. `null` when unknown,
      // never a guess: the wording downstream changes based on this, and an
      // invented number would make the sentence false.
      restedDays: st.last_at
        ? Math.max(0, Math.floor((Date.now() - Date.parse(`${String(st.last_at).slice(0, 10)}T00:00:00Z`)) / 86400000))
        : null,
      novelty: Number(noveltyScore.toFixed(3)),
    });
  }

  // Documented contract: descending novelty. Without the sort, selection follows
  // insertion order and scarcity decay can never push an explored kind out.
  scored.sort((a, b) => b.novelty - a.novelty);

  return limit > 0 ? scored.slice(0, limit) : scored;
}

/**
 * The budgeted view, mirroring their `proposeExplorations()`.
 *
 * Two separate concerns, kept separate the way curiosity-engine keeps them:
 *
 *   scanKnowledgeGaps()  — every gap, ranked. No budget.
 *   proposeExplorations() — at most `budget` of them.
 *
 * The first version fused these, so any caller asking "show me all the gaps"
 * silently got a budgeted slice and read an empty list as "no gaps exist".
 *
 * Their budget is `floor(dispatchSlots * explorationBudgetRatio * healthFactor)`.
 * That is sized for a dispatcher handing out many slots per cycle. She wakes with
 * one intention per heartbeat, and `floor(1 * 0.3)` is 0 — transcribed verbatim,
 * the module would never propose anything. Passing dispatchSlots = 1/ratio keeps
 * the ratio meaningful as "how often a wake may be spent on a gap".
 */
export function propose(workspaceDir, { dispatchSlots = 1 / DEFAULT_CURIOSITY_CONFIG.explorationBudgetRatio, healthScore = 1, exclude = [] } = {}) {
  const cfg = DEFAULT_CURIOSITY_CONFIG;
  const healthFactor = Math.max(0.2, Math.min(1, healthScore));
  const budget = Math.floor(dispatchSlots * cfg.explorationBudgetRatio * healthFactor);
  if (budget <= 0) return [];
  return gaps(workspaceDir, { limit: budget, exclude });
}
