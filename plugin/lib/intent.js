// Intent — where a wish comes from before it becomes a goal.
//
// Why this exists
// ---------------
// Measured 2026-11-05: `lib/goals.js` had 363 lines — create / close /
// markStep / addEvidence / describe / pressureHint — and `state/goals.json` had
// never existed once. Every turn injected an empty goal list and an empty
// pressure hint. The machinery was tested, wired, and never fed.
//
// The missing piece was not storage but intake: nothing ever answered "what is
// a candidate in the first place". A goal system with no source is a ledger
// nobody writes to.
//
// The rule this module holds to
// -----------------------------
// A candidate must be traceable to something that actually happened:
//
//   topic       an open topic that went quiet while still hot
//   experience  a pooled experience nobody has judged yet
//   relation    a familiar person who has gone unusually quiet
//   pressure    an aspiration that has produced nothing for a long time
//
// There is no "invent something interesting" source. A generator that mints
// wishes from nothing produces exactly the behaviour this whole effort is
// trying to avoid: a machine that always finds something to do.
//
// Every candidate carries `basis` — a short human-readable reason. If a goal
// appears in the list and nobody can say why, the intake is lying.

import fs from "node:fs";
import path from "node:path";

import * as experience from "./experience.js";
import * as goals from "./goals.js";
import * as wants from "./wants.js";
import * as activities from "./activities.js";
import * as curiosity from "./curiosity.js";
import * as relations from "./relations.js";
import * as salience from "./salience.js";
import * as topics from "./topics.js";

const MAX_CANDIDATES = 8;

export function outcomesFile(workspaceDir) {
  return path.join(workspaceDir, "state", "intent-outcomes.json");
}

function nowIso() {
  return new Date().toISOString();
}

function hoursSince(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 3600_000;
}

/** Track record per candidate key. This is what makes `prior` real. */
export function loadOutcomes(workspaceDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(outcomesFile(workspaceDir), "utf8"));
    if (raw && typeof raw === "object" && raw.keys) return raw;
  } catch { /* first run */ }
  return { version: 1, keys: {} };
}

function saveOutcomes(workspaceDir, data) {
  const file = outcomesFile(workspaceDir);
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function outcomesFor(workspaceDir, key) {
  const d = loadOutcomes(workspaceDir);
  const rec = d.keys?.[key];
  return {
    successes: Number(rec?.successes ?? 0),
    failures: Number(rec?.failures ?? 0),
  };
}

/**
 * Record what actually happened, so the next score knows.
 *
 * `uncertain` deliberately increments neither counter: it is not evidence of
 * success and not evidence of failure. Counting it as failure would teach the
 * system to stop trying anything whose receipt it cannot see, which is most of
 * the interesting things.
 */
export function recordOutcome(workspaceDir, key, kind) {
  const d = loadOutcomes(workspaceDir);
  if (!d.keys) d.keys = {};
  const rec = d.keys[key] || { successes: 0, failures: 0, at: null };
  if (kind === "success") rec.successes = Number(rec.successes ?? 0) + 1;
  else if (kind === "failure") rec.failures = Number(rec.failures ?? 0) + 1;
  else if (kind === "silent") rec.failures = Number(rec.failures ?? 0) + 1;
  rec.last_kind = String(kind);
  rec.at = nowIso();
  d.keys[key] = rec;
  saveOutcomes(workspaceDir, d);
  return rec;
}

/**
 * Collect candidates. Read-only apart from nothing — this function writes no
 * files. Scoring is delegated to lib/salience.js so it stays testable.
 */
export function collect(workspaceDir) {
  const out = [];

  // --- A. open topics that went quiet while still warm ---------------------
  //
  // `staleButOpen` already encodes "hot enough to matter, quiet long enough to
  // be worth returning to". Reusing it keeps the definition of "dangling" in
  // one place instead of growing a second one here that disagrees.
  try {
    for (const t of topics.staleButOpen(workspaceDir, { minHours: 24, limit: 4 })) {
      const key = `topic:${t.key}`;
      out.push({
        id: key,
        kind: "topic",
        title: `接着聊「${String(t.label || "").slice(0, 40)}」`,
        serves: "genuine_contact",
        source: "topic",
        value: Math.min(1, Math.max(0.2, Number(t.heat ?? 0))),
        outcomes: outcomesFor(workspaceDir, key),
        basis: `话题 heat ${Number(t.heat ?? 0).toFixed(2)}，${Math.floor(hoursSince(t.last_at))} 小时没再提`,
        detail: { topicKey: t.key, people: t.people || [] },
      });
    }
  } catch { /* a corrupt topics file must not stop intake */ }

  // --- B. pooled experiences nobody has judged -----------------------------
  //
  // An unjudged experience is the closest thing to a real open question: it
  // already happened, and the only thing missing is a decision about it.
  try {
    for (const e of experience.pending(workspaceDir).slice(0, 3)) {
      const key = `exp:${e.id}`;
      out.push({
        id: key,
        kind: "experience",
        title: `想想「${String(e.gist || e.what || "").slice(0, 36)}」到底算什么`,
        serves: "self_understanding",
        source: "unfinish",
        value: 0.55,
        outcomes: outcomesFor(workspaceDir, key),
        basis: `经验池里 ${Math.floor(hoursSince(e.at))} 小时前的一条还没定性`,
        detail: { experienceId: e.id },
      });
    }
  } catch { /* ignore */ }

  // --- C. a familiar person gone unusually quiet ---------------------------
  //
  // Threshold is familiarity, not recency alone: silence from a stranger is
  // normal and chasing it is the failure mode. Only someone already familiar
  // enough that silence is a change gets a candidate.
  try {
    const all = relations.loadRelations(workspaceDir);
    const people = all?.data?.people ?? all?.people ?? {};
    const list = Object.values(people);
    const quiet = list
      .filter((r) => Number(r.familiarity ?? 0) >= 0.35 && Number(r.familiarity ?? 0) <= 0.95)
      .filter((r) => hoursSince(r.last_seen) >= 48)
      .sort((a, b) => Number(b.familiarity) - Number(a.familiarity))
      .slice(0, 2);
    for (const r of quiet) {
      const key = `person:${r.id}`;
      out.push({
        id: key,
        kind: "reach_out",
        title: `找${r.name || "那个人"}说句话`,
        serves: "genuine_contact",
        source: "unfinish",
        value: Math.min(0.9, Number(r.familiarity ?? 0.5)),
        outcomes: outcomesFor(workspaceDir, key),
        basis: `熟悉度 ${Number(r.familiarity ?? 0).toFixed(2)}，${Math.floor(hoursSince(r.last_seen) / 24)} 天没说话`,
        detail: { personId: r.id },
      });
    }
  } catch { /* ignore */ }

  // --- D. an aspiration starved of output ---------------------------------
  //
  // Only offered when the direction is genuinely low. Without the guard this
  // source fires every hour and becomes the default, which turns the whole
  // intake back into a scheduler.
  try {
    const press = goals.pressureHint(workspaceDir);
    if (press && Number(press.value) <= 0.35) {
      const key = `pressure:${press.id}`;
      out.push({
        id: key,
        kind: "pressure",
        title: `给「${press.title}」做点什么`,
        serves: press.id,
        source: "pressure",
        value: 0.5,
        outcomes: outcomesFor(workspaceDir, key),
        basis: `这条方向权重只有 ${Number(press.value).toFixed(2)}，一直没出东西`,
        detail: { aspiration: press.id },
      });
    }
  } catch { /* ignore */ }

  // --- E. something she said she wanted to do -------------------------------
  //
  // The only intake path whose content came from her rather than from her
  // circumstances. Everything above is a description of what happened to her:
  // a topic went quiet, an experience is unjudged, a person stopped writing, a
  // direction is starved. Choosing among those is choosing a reaction.
  //
  // This path exists because measured 2026-11-05: twenty consecutive diary
  // entries contained only four kinds of activity — looking something up,
  // drawing, photographing, scrolling — and the intake code had no way to
  // produce a fifth. She was not uncreative; there was no slot for anything she
  // invented.
  //
  // Value is whatever she set it to, discounted by how long it has sat and by
  // how many times she has picked it up without finishing. A want that keeps
  // getting chosen and never gets done is not a want any more, and the scorer
  // should see that rather than an optimistic constant.
  try {
    for (const w of wants.open(workspaceDir).slice(0, 3)) {
      const key = `want:${w.id}`;
      const age = hoursSince(w.at);
      const attempts = Number(w.attempts || 0);
      out.push({
        id: key,
        kind: "want",
        title: String(w.what || "").slice(0, 60),
        serves: "own_inclination",
        source: "herself",
        value: Math.max(0.2, Math.min(1, Number(w.value ?? 0.5)) * Math.max(0.4, 1 - attempts * 0.2)),
        outcomes: outcomesFor(workspaceDir, key),
        basis: age < 1
          ? "自己刚说想干的"
          : `自己 ${Math.floor(age / 24) || 1} 天前说想干的${attempts ? `，试过 ${attempts} 次` : ""}`,
        detail: { wantId: w.id, why: w.why },
      });
    }
  } catch { /* ignore */ }

  // --- F. a kind of thing she has never done --------------------------------
  //
  // Ported from `beijingwahw/dsh-proactive` `curiosity-engine.ts`. That engine
  // does not invent interests; it measures where its own experience is thin and
  // points at the thinnest part, from four gap reasons — unexplored,
  // low-experience, high-failure, topological.
  //
  // Measured on her own diary 2026-11-05, across 7 days: draw 65, scroll 45,
  // lookup 16, make 15, count 14, read 11, write 8, talk 6, shoot 2, try 2,
  // tidy 0, idle 0. The last two had never happened once. That is the concrete
  // shape of "只会那几样" — not a preference, a hole.
  //
  // Only one gap is offered per wake, and only when nothing she chose herself
  // is waiting. A novelty suggestion must never outrank her own stated want;
  // if it did, the system would be back to assigning her tasks, just with
  // better arithmetic.
  try {
    // A gap candidate is always offered; it is only ever ranked below her own
    // wants, never hidden by them.
    //
    // This used to be `if (!chosen.length) { ...add gap... }` — gaps existed only
    // when she had no wants at all. The intent in the original comment was
    // right ("a novelty suggestion must never outrank her own stated want"),
    // but it was implemented as exclusion rather than as ordering. Measured
    // 2026-11-05: `collect()` returned exactly one candidate for a whole
    // afternoon, because one want was open. Having a single thing to think about
    // is the same starvation that emptied the kind pool, just quieter.
    const chosen = wants.open(workspaceDir);
    const gap = activities.propose(workspaceDir)[0];
    if (gap && gap.novelty >= activities.PROPOSAL_FLOOR) {
      // Ordering does the job the exclusion was standing in for: the ceiling
      // sits just under the weakest open want, so novelty can fill the space
      // beside her own intention but can never displace it. A want that has been
      // picked up and dropped bottoms out at 0.4x its stated value (see the
      // discount above), so the ceiling tracks that floor rather than a guess.
      let ceiling = Math.min(0.85, gap.novelty);
      if (chosen.length) {
        const weakestWant = Math.min(
          ...chosen.map((w) =>
            Math.max(0.2, Math.min(1, Number(w.value ?? 0.5))) *
            Math.max(0.4, 1 - Number(w.attempts || 0) * 0.2)
          ),
        );
        // Strictly below, so a tie never hands the wake to novelty.
        ceiling = Math.min(ceiling, Math.max(0.05, weakestWant - 0.01));
      }
      out.push({
        id: `gap:${gap.kind}`,
        kind: "gap",
        title: `试试${gap.label}`,
        serves: "own_inclination",
        source: "novelty",
        value: ceiling,
        outcomes: outcomesFor(workspaceDir, `gap:${gap.kind}`),
        basis: gap.reason === "unexplored"
          ? `这一类从来没干过（${gap.hint}）`
          : gap.reason === "mature"
            ? `干过 ${gap.exposure} 次，最近没怎么碰（${gap.hint}）`
            : `干过 ${gap.exposure} 次，比别的少得多（${gap.hint}）`,
        detail: { kind: gap.kind, hint: gap.hint },
      });
    }
  } catch { /* ignore */ }

  // --- a question she has not answered -------------------------------------
  //
  // Distinct from the `gap` candidate above, and the distinction is the same
  // one that killed the "看过没追" attempt: `gap` is about what she has not
  // been *doing*, this is about what she has not been *understanding*.
  //
  // Ranked ceiling is tied to the want ceiling for the same reason: her own
  // stated intention wins ties. Curiosity loses to a want on purpose — a want
  // is something she decided, a gap is something that happened to her.
  try {
    const pick = curiosity.propose(workspaceDir, { budget: 1, markProposed: false })[0];
    if (pick) {
      let ceiling = Math.min(0.72, 0.35 + pick.urgency * 0.4);
      const chosen = wants.open(workspaceDir);
      if (chosen.length) {
        const weakestWant = Math.min(
          ...chosen.map((w) =>
            Math.max(0.2, Math.min(1, Number(w.value ?? 0.5))) *
            Math.max(0.4, 1 - Number(w.attempts || 0) * 0.2)
          ),
        );
        ceiling = Math.min(ceiling, Math.max(0.05, weakestWant - 0.01));
      }
      const times = Number(pick.times_encountered ?? 1);
      out.push({
        id: `curiosity:${pick.id}`,
        kind: "curiosity",
        title: `弄清楚「${pick.display}」`,
        serves: "understanding",
        source: "curiosity",
        value: ceiling,
        outcomes: outcomesFor(workspaceDir, `curiosity:${pick.id}`),
        basis:
          times >= 2
            ? `撞到过 ${times} 次，每次都没想起来`
            : pick.sources.includes("question")
              ? `你自己说过不知道`
              : `碰到过，一直没往下想`,
        detail: { gapId: pick.id, topic: pick.topic },
      });
    }
  } catch { /* a missing gap list must not stop intake */ }

  // Mark stalls so the scorer can demote instead of delete.
  for (const c of out) {
    c.stalled = false;
  }

  return out.slice(0, MAX_CANDIDATES);
}

/** Collect + rank in one call. Returns {ranked, do, below, threshold}. */
export function rankNow(workspaceDir, opts = {}) {
  return salience.rank(collect(workspaceDir), opts);
}

/**
 * Turn a candidate into a real goal.
 *
 * Deliberately routes through `goals.create` instead of writing the file here:
 * creation already owns duplicate detection, tombstones, and the 12-goal cap,
 * and a second writer would eventually disagree with it.
 */
export function materialize(workspaceDir, candidate) {
  if (!candidate) return { ok: false, reason: "没有候选" };
  const r = goals.create(workspaceDir, {
    title: candidate.title,
    serves: candidate.serves,
    source: candidate.source,
  });
  if (r.ok) r.candidateId = candidate.id;
  return r;
}
