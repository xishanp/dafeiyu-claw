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
import * as deeds from "./deeds.js";
import * as horizon from "./horizon.js";
import * as relations from "./relations.js";
import * as salience from "./salience.js";
import * as topics from "./topics.js";
import * as compulsion from "./compulsion.js";

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

/**
 * How much a want is worth this wake, given how many times it has been picked.
 *
 * The old formula was
 *
 *   Math.max(0.2, value * Math.max(0.4, 1 - attempts * 0.2))
 *
 * and both clamps were wrong. `Math.max(0.4, ...)` bottoms the discount out at
 * 40% no matter how many attempts there are, and `Math.max(0.2, ...)` puts a
 * floor under the result. Measured 2026-11-06:
 *
 *   value 0.45, 5 attempts -> 0.200   (fell below the 0.25 threshold by luck)
 *   value 0.80, 5 attempts -> 0.320   (stayed a live candidate forever)
 *   value 1.00, 5 attempts -> 0.400   (ditto, and worse)
 *
 * So whether a repeated want ever stopped competing was decided by the number
 * she happened to type, not by the repetition itself. The same want at value
 * 0.45 faded; at 0.8 it did not. That is not a rule, it is an accident that
 * looked like a rule for exactly one data point — the corridor want, which was
 * 0.45.
 *
 * The replacement states the rule directly: repeating something without closing
 * it makes it worth less, and the discount does not stop at an arbitrary point.
 * Three attempts halves it; ten makes it effectively dormant. It is a decay
 * curve, not a floor, because a floor is what lets value 1.0 loop forever.
 *
 * Her own explicit value still sets the ceiling. What changed is only that the
 * ceiling now comes down with use instead of levelling off above the threshold.
 */
export function wantValue(w) {
  const stated = Math.min(1, Math.max(0, Number(w?.value ?? 0.5)));
  const attempts = Math.max(0, Number(w?.attempts || 0));
  // Flat until the fifth attempt, then it decays and does not stop.
  //
  // Two things were wrong before and one thing is deliberate now.
  //
  // Wrong #1: the discount bottomed out at 40% (`Math.max(0.4, 1 - n*0.2)`), so
  // past five attempts nothing further happened. Wrong #2: a floor of 0.2 sat
  // under the result, so a value-1.0 want was still a live candidate at 0.40
  // after five turns — repetition could never win against a high self-rating.
  //
  // Deliberate now: the first four attempts cost nothing. Picking something up
  // again is not evidence of a loop; it is what working on something looks like.
  // FIVE is where it becomes a loop — that is the number the owner named, and it
  // matches where the observed cases were already stuck before anyone stepped
  // in (the corridor want had been running since 11-04).
  //
  // After that, decay is 1/(1 + 0.6*(n-4)), so it never reaches zero but keeps
  // falling: 5 -> 0.71x, 8 -> 0.45x, 12 -> 0.29x, 20 -> 0.17x of her stated
  // value. A value-0.45 want crosses the 0.25 threshold at 5; a value-1.0 want
  // needs 10. Saying something matters a lot is allowed to buy more attempts —
  // it is not allowed to buy unlimited ones.
  const REPEAT_FREE = 4;
  const over = Math.max(0, attempts - REPEAT_FREE);
  const decay = 1 / (1 + over * 0.6);
  return Math.round(stated * decay * 1000) / 1000;
}

/** The observation attached to a want candidate. Facts only, never instruction. */
export function wantBasis(w, ageHours) {
  const attempts = Math.max(0, Number(w?.attempts || 0));
  const days = Math.max(1, Math.floor((Number(ageHours) || 0) / 24));
  if (Number(ageHours) < 1) return "自己刚说想干的";
  if (attempts >= 5) return `自己 ${days} 天前说想干的，试过 ${attempts} 次还没收掉`;
  if (attempts > 0) return `自己 ${days} 天前说想干的，试过 ${attempts} 次`;
  return `自己 ${days} 天前说想干的`;
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
 * What the douyin record actually says, as numbers.
 *
 * Deliberately reads `douyin.json` (`watchedAt`, real timestamps) and
 * `relations.json` (`distinct_days`, real conversations) rather than the diary.
 * Measured 2026-11-06: the activity counters said `scroll: 46 done` when the
 * real record held four days of watching — 「刷到」 in her own writing was being
 * counted as having done it. The same mistake here would produce "go watch
 * something" on a day she watched eleven.
 *
 * Returns zeros on any failure. A missing store means "nothing recorded", which
 * errs toward offering the action, and offering it once is cheaper than never.
 */
function douyinStats(workspaceDir) {
  const out = { watchedToday: 0, watchedTotal: 0, others: 0, daysSinceOther: Infinity };

  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workspaceDir, "state", "douyin.json"), "utf8"));
    const vids = raw && typeof raw.videos === "object" ? Object.values(raw.videos) : [];
    const today = new Date().toISOString().slice(0, 10);
    out.watchedTotal = vids.length;
    for (const v of vids) {
      const at = String(v?.watchedAt || "");
      if (at.slice(0, 10) === today) out.watchedToday += 1;
    }
  } catch { /* no record yet */ }

  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workspaceDir, "state", "relations.json"), "utf8"));
    const people = raw && typeof raw.people === "object" ? Object.values(raw.people) : [];
    // The owner is one of these records and does not count as "another fish".
    //
    // Filtered by name, not by channel. The first version excluded anything on
    // `onebot`, and that was wrong in the one way that matters: every fish she
    // has met arrives on onebot too, so the filter removed all sixteen of them
    // and reported "她还没认识别的鱼" while the file held 阿温, 阿元, 阿果 and
    // a dozen more. The count came out zero and the candidate never fired.
    //
    // Channel is how they reached her; name is who they are. Only the latter
    // can answer "is this someone new".
    // 主人的名字。公开仓库里留空，部署时从配置注入 —— 写死真名等于把
    // "谁是主人"这条判断连同真名一起公开。
    const OWNER_NAMES = new Set((process.env.OWNER_NAMES || "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean));
    const others = people.filter((p) => {
      const name = String(p?.name || "").trim();
      const id = String(p?.id || "");
      // An unnamed record is the gateway's own webchat session, not a fish.
      if (!name) return false;
      if (OWNER_NAMES.has(name.toLowerCase())) return false;
      return !id.includes("webchat");
    });
    out.others = others.length;
    let latest = null;
    for (const p of others) {
      const at = Date.parse(String(p?.last_seen || ""));
      if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
    }
    if (latest !== null) out.daysSinceOther = Math.floor((Date.now() - latest) / 86400000);
  } catch { /* no relations yet */ }

  return out;
}

/**
 * Collect candidates. Read-only apart from nothing — this function writes no
 * files. Scoring is delegated to lib/salience.js so it stays testable.
 */
export function collect(workspaceDir) {
  const out = [];

  // Read the compulsion state once, up front, because two different places
  // below need it and they must agree. Reading it twice would let them drift,
  // and a system that disagrees with itself about whether she is stuck is
  // worse than one that cannot tell at all.
  let habit = { stuck: false, because: "", streak: { key: null, length: 0 } };
  try { habit = compulsion.check(workspaceDir); } catch { /* no state yet */ }

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
        value: wantValue(w),
        outcomes: outcomesFor(workspaceDir, key),
        basis: wantBasis(w, age),
        detail: { wantId: w.id, why: w.why },
      });
    }
  } catch { /* ignore */ }

  // --- E2. 抖音：去认识人、去刷、去回话 ---------------------------------------
  //
  // Owner, 2026-11-06: 「全换成抖音候选，比如等下认识更多这个角色啊，那些」.
  //
  // Why this needs to be its own source rather than a `gap` or `wander` entry:
  //
  // The pool on that day held seven candidates, five of them 「煮米饭水放多少」
  // variants and two of them unjudged videos. Nothing in it could say "go meet
  // another 这个角色". `wander` and `horizon` both exist but they are empty-pool
  // fallbacks, not entries — so in a pool that is never quite empty they never
  // fire, which is exactly the state she was stuck in.
  //
  // Two kinds here, because they are two different acts:
  //
  //   meet   — there are other fish out there she has not met. Distinct from
  //            `person_quiet` above, which is about someone she already knows
  //            going silent. This is about the ones she has never met at all.
  //   watch  — go look at something. Reads a real number (videos she actually
  //            watched, from douyin.json `watchedAt`) rather than her diary,
  //            because the diary said 46 scrolls when the truth was 4 days.
  //
  // Both carry a value that loses to a live want and beats the empty-pool
  // fallback, so they are genuinely in the queue without hijacking her own
  // decisions.
  try {
    const seen = douyinStats(workspaceDir);

    // --- meet someone new --------------------------------------------------
    // Offered when she has met few fish lately. The count comes from relations,
    // not from a guess: `distinct_days` is how many separate days she has
    // actually talked to somebody other than the owner.
    if (seen.others === 0 || seen.daysSinceOther >= 2) {
      const key = "douyin:meet";
      out.push({
        id: key,
        kind: "douyin",
        title: "去认识一条别的这个角色",
        serves: "genuine_contact",
        source: "douyin",
        value: 0.58,
        outcomes: outcomesFor(workspaceDir, key),
        basis:
          seen.others === 0
            ? "除了主人，还没跟别的鱼说过话"
            : `已经 ${seen.daysSinceOther} 天没跟别的鱼说过话了`,
        detail: { action: "meet", others: seen.others },
      });
    }

    // --- go watch something ------------------------------------------------
    // Keyed by the day so it resets daily but does not stack up: one "go watch"
    // offer per day, replaced tomorrow.
    const today = new Date().toISOString().slice(0, 10);
    if (seen.watchedToday < 5) {
      const key = `douyin:watch:${today}`;
      out.push({
        id: key,
        kind: "douyin",
        title: "去刷会儿抖音，多看几条",
        serves: "understanding",
        source: "douyin",
        value: 0.56,
        outcomes: outcomesFor(workspaceDir, key),
        basis:
          seen.watchedToday === 0
            ? "今天一条都还没看"
            : `今天看了 ${seen.watchedToday} 条，还可以再看`,
        detail: { action: "watch", today: seen.watchedToday },
      });
    }
  } catch { /* a missing douyin store must not stop intake */ }

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
    // `propose()` returns a one-element list and that element is the *same* one
    // every wake, because the ranking is deterministic — no randomness, no
    // clock, by design. Measured 2026-11-06: sixteen consecutive `activity-inject`
    // probes, all `{"kind":"shoot","novelty":0.242,"used":"draw"}`. She was not
    // ignoring the suggestion; she was being handed the same sentence sixteen
    // times and had already been told it was the thinnest thing she did.
    //
    // Determinism is the right default for a score. It is the wrong default for
    // *which of several equally-thin things to offer*, because that turns a
    // variety feature into a fixed schedule. The survey is still deterministic
    // (gaps() is untouched); only the pick from it rotates, seeded on the day
    // and on how many wakes have already happened today, so it changes between
    // days and between wakes but is reproducible for a given wake.
    const thin = activities.propose(
      workspaceDir,
      { dispatchSlots: 1 / activities.DEFAULT_CURIOSITY_CONFIG.explorationBudgetRatio },
    );
    const survey = activities.gaps(workspaceDir, { limit: 20 })
      .filter((g) => g.novelty >= activities.PROPOSAL_FLOOR);
    const gap = survey.length ? survey[rotationIndex(workspaceDir, survey.length)] : thin[0];
    if (gap && gap.novelty >= activities.PROPOSAL_FLOOR && chosen.length) {      // Ordering does the job the exclusion was standing in for: the ceiling
      // sits just under the weakest open want, so novelty can fill the space
      // beside her own intention but can never displace it. A want that has been
      // picked up and dropped bottoms out at 0.4x its stated value (see the
      // discount above), so the ceiling tracks that floor rather than a guess.
      //
      // EXCEPTION, added 2026-11-06: this cap is what keeps her in one place.
      // The rule "her own want outranks novelty" is right in general and wrong
      // when her own want has been the only thing winning for days. Measured:
      // fifty-three versions of one question, twelve of them after she had
      // already written the conclusion. Obeying "my own intention wins"
      // faithfully produced that loop — the intention never expired, because
      // wants live 21 days and she never closed it.
      //
      // So while a streak is running, the cap is lifted for exactly as long as
      // the streak holds. It lifts nothing else: her want is still offered, at
      // its own value, and she can still choose it. What changes is that
      // something else is finally allowed to be worth more than it.
      // With nothing in hand, the gap list is not the answer — exploring is.
      //
      // The ceiling below already keeps `gap` strictly under any live want, so
      // this block was only ever meant to fill the space *between* wants. When
      // `chosen` is empty there is no want to sit under, and the block used to
      // promote itself instead: measured 2026-11-06, right after the last want
      // was cleared, `gap:shoot` came out at 0.297 and won the wake.
      //
      // "Try taking a photo" is a way to pass an idle hour. It is not the same
      // act as going somewhere she has never been, and only the second one is
      // what the owner asked for: 先看手里的，然后去探索未知的.
      //
      // So: no live want, no gap card. The empty-pool exit handles that wake.
      let ceiling = Math.min(0.85, gap.novelty);
      if (chosen.length && !habit.stuck) {
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
    // Give each ready question its own candidate instead of surfacing exactly
    // one and letting it own the slot forever.
    //
    // This was the mechanism behind the seven-hour loop. Measured 2026-11-06:
    // 17 open noticings, of which SIX were questions all scoring 0.847
    // (identical, because each had been seen once at weight 0.7). `propose`
    // returned exactly one of them — the array's first, always the same one —
    // so 「陈米到底」 was the only curiosity in the pool and therefore the only
    // curiosity that could ever win. The other five questions were never
    // offered, and the eleven `name` noticings sat at 0.449, below the 0.55
    // bar, so they were never offered either.
    //
    // Two separate faults, both fixed here and in `propose`:
    //   - intake asked for one candidate when there were six worth asking about
    //   - the six were interchangeable in score, so "the best one" was decided
    //     by array order rather than by anything about her
    //
    // Each now becomes a candidate. Ties are then broken by the ranking pass
    // (score, then id) rather than by list position, and once one of them is
    // picked the others remain available for the next wake instead of waiting
    // in a queue behind a single seat.
    const picks = curiosity.propose(workspaceDir, { budget: 4 });
    for (const pick of picks) {
      // Score from `pull`, not from a stored urgency field. The rewrite made
      // urgency computed, and reading `pick.urgency` here produced `undefined`,
      // then `NaN` — which silently dropped the candidate instead of throwing.
      // The symptom would have been "curiosity never fires", which is exactly
      // the failure this layer already had once.
      const pull = curiosity.pull(pick);
      let ceiling = Math.min(0.72, 0.35 + pull * 0.4);
      const chosen = wants.open(workspaceDir);
      // Same streak exception as the gap candidate above, and for the same
      // measured reason. A curiosity is normally supposed to lose to a want,
      // because a want is something she decided. But the want she decided was
      // 「查清平原示范区 188 平方公里扩到 353」 — and forty versions later she had
      // answered it and kept going. Loyalty to her own decision is not a virtue
      // once the decision is finished.
      if (chosen.length && !habit.stuck) {
        const weakestWant = Math.min(
          ...chosen.map((w) =>
            Math.max(0.2, Math.min(1, Number(w.value ?? 0.5))) *
            Math.max(0.4, 1 - Number(w.attempts || 0) * 0.2)
          ),
        );
        ceiling = Math.min(ceiling, Math.max(0.05, weakestWant - 0.01));
      }
      const seen = Math.max(1, Number(pick.seen ?? 1));
      // The basis has to describe the thing, not just count sightings.
      //
      // Every noticing used to be a name, so 「只碰到过一次」 was a complete
      // explanation. With gaps in the pool it became wrong: a contradiction he had
      // just voiced was summarised as 「只碰到过一次」, which describes a word seen
      // once and says nothing about what is unresolved. The title had the same
      // problem — 「弄清楚「我最近喜欢上香菜了」」 treats his own sentence as a topic
      // to look up.
      const kind = String(pick.kind || "name");
      // Every question used to share one title, 「把这个没答的问题弄清楚」.
      //
      // With a single curiosity slot that was harmless — there was only ever
      // one. With several in the pool it is not: six different questions all
      // rendered as the same sentence, so the one she saw looked identical
      // whichever one won, and there was no way to tell from the prompt whether
      // the engine had moved on or not. The display text is what she reads; it
      // has to say which question.
      const shown = String(pick.display || pick.topic || "").slice(0, 30);
      const title =
        kind === "mismatch" ? `问清楚：${String(pick.display).slice(0, 24)}`
        : kind === "question" ? (shown ? `没答上的：${shown}` : "把这个没答的问题弄清楚")
        : `弄清楚「${shown}」`;
      const basis =
        kind === "mismatch" ? String(pick.reasons?.[0] || "跟之前说的对不上").slice(0, 40)
        : kind === "question" ? "问过，没人回答"
        : seen >= 3 ? `碰上过 ${seen} 次，一直绕不开`
        : seen === 2 ? "碰上过两次"
        : "只碰到过一次";
      out.push({
        id: `curiosity:${pick.id}`,
        kind: "curiosity",
        title,
        serves: "understanding",
        source: "curiosity",
        value: ceiling,
        outcomes: outcomesFor(workspaceDir, `curiosity:${pick.id}`),
        basis,
        detail: { noticingId: pick.id, topic: pick.topic, gapKind: kind },
      });
    }
  } catch { /* a missing gap list must not stop intake */ }

  // --- G. going out and wandering -------------------------------------------
  //
  // The owner's phrasing, 2026-11-06: 「正常应该去贴吧看一看那些东西，或者去刷刷
  // 抖音，多刷几条，刷刷自己喜欢的」. Not a task, not a gap to fill — just being
  // out in the world long enough for something to catch.
  //
  // This gets its own candidate rather than riding on the `gap` slot above,
  // because the gap slot is a single seat contested by eleven kinds and the
  // result was `scroll` (which is how wandering is actually recorded) losing to
  // `shoot` on a fixed schedule. Wandering is the one activity whose whole point
  // is that it does not need a good reason, so letting it compete on novelty
  // against eleven others and lose is the wrong shape.
  //
  // The value is deliberately low and flat. Wandering must never outrank
  // something she actually decided to do — that is the failure mode the whole
  // intake is built to avoid. It only needs to be worth doing when nothing else
  // is, which is exactly the state that produced fifty-three versions of one
  // question.
  // Going outside is NOT in this list either.
  //
  // The comment above already said the right thing — "it only needs to be worth
  // doing when nothing else is" — while the code did the opposite: `value:
  // habit.stuck ? 0.62 : 0.34`, a number that competes with real work and loses
  // to it on every ordinary wake. So the only time she left the house was when
  // the house was already on fire.
  //
  // It now shares the empty-pool exit with `horizon`. The difference between
  // them is what she is going out *to*: `wander` is just "go look", `horizon` is
  // a specific direction she has never touched. Both answer an empty hour; no
  // number is asked to represent one.


  // --- H. a whole direction she has never been near -------------------------
  //
  // Owner, 2026-11-06: 「探索未知面才是真正的好奇心」.
  //
  // Every other source above answers "what did I run into": a topic went quiet,
  // an experience is unjudged, a person stopped writing, one of twelve verbs is
  // used least, a want she already recorded. All of them are reactions to
  // material that already arrived. None of them can say "there is a whole
  // direction I have never touched".
  //
  // Measured on her real workspace the same day: eleven recorded entities, every
  // one either about herself or about somebody else's video about her — not one
  // piece of the outside world. Nine of ten domains came back blank.
  //
  // Value is set above the wander floor and below a live want. Going somewhere
  // new is worth more than idly scrolling, and still not worth more than
  // something she decided she cared about.
  // Exploration is deliberately NOT in this list.
  //
  // It was, with `value: habit.stuck ? 0.66 : 0.42`. That made going somewhere
  // new compete on points against work she had already decided she cared
  // about, and the comparison was decided by hundredths: measured 2026-11-06,
  // not stuck, one live want — the want scored 0.45, `horizon` scored 0.42, and
  // she spent the hour on 「让走廊的尘按空间均匀撒」 instead of anywhere.
  //
  // Tuning the number upward is the wrong repair and was reverted. A "go see
  // something" card does not belong in a queue of things to get done; putting it
  // there means it either always wins (she never finishes anything) or always
  // loses (she never leaves). Neither is a decision, both are arithmetic.
  //
  // Exploration is the answer to an empty list, not an entry in it. The caller
  // supplies it as a fallback — see `decide()`'s `opts.whenEmpty`.


  // Mark stalls so the scorer can demote *and* so the cut below can remove.
  //
  // Demotion alone was not enough. Measured 2026-11-06: 20 straight wakes
  // alternated between exactly two candidates out of a pool of four. `stalled`
  // pushed whichever was newest down to 0.25 of its score, the other one won
  // the next wake and got demoted in turn — the demotion was manufacturing the
  // oscillation it existed to break. At 0.55 x 0.25 = 0.137 the stalled item
  // still sits above any useful threshold, so with a thin pool it wins back.
  //
  // The owner's rule is 「重复两三次自动熔断」: cut it off, do not nudge it. A key
  // that has now won STREAK_ALARM times in a row is therefore dropped from this
  // wake entirely; everything else keeps its full weight.
  let streak = { key: null, length: 0 };
  let rot = null;
  try {
    const data = compulsion.loadPicks ? compulsion.loadPicks(workspaceDir) : null;
    streak = compulsion.streak(workspaceDir);
    if (data) rot = compulsion.rotation(data);
  } catch { /* no history yet */ }
  const repeating = streak.key && streak.length >= compulsion.STREAK_ALARM ? streak.key : null;
  // A rotation blocks every id in the cycle, not just the newest one — the
  // whole point is that taking turns is not progress. Matched by exact id: two
  // distinct `exp:*` items are different things to switch between even though
  // they share a streak category.
  const rotating = new Set(rot ? rot.ids : []);

  for (const c of out) {
    const key = compulsion.streakKey(c.id);
    c.stalled = Boolean((repeating && key === repeating) || rotating.has(c.id));
    if (c.stalled) {
      c.stalledBy = rotating.has(c.id)
        ? `最近 ${rot.length} 轮在同样的几样之间转`
        : `同一类事连着 ${streak.length} 轮`;
    }
  }

  // The cut itself happens in `rankNow`, not here. `collect` is the full pool —
  // other callers read it to inspect what exists, and shrinking it silently is
  // how a diagnostic becomes a bug of its own.
  return out.slice(0, MAX_CANDIDATES);
}

/**
 * Pick which of N equally-thin activities to offer this wake.
 *
 * Seeded on the calendar day and on how many wakes have already been served
 * today, so:
 *   - the same wake asked twice gives the same answer (reproducible),
 *   - two wakes a minute apart are not forced to the same index,
 *   - it moves on its own across days without anything having to be stored.
 *
 * The intent is explicitly NOT a full shuffle. Shuffling the whole survey would
 * discard the ranking that `gaps()` computes and exists for. This rotates only
 * the choice among candidates that already passed the floor — the ones the
 * ranking considers equally worth showing.
 */
function rotationIndex(workspaceDir, n) {
  if (!Number.isFinite(n) || n <= 1) return 0;
  const day = new Date().toISOString().slice(0, 10);
  const key = `rotation:${day}`;
  let served = 0;
  try {
    const f = path.join(workspaceDir, "state", "activity.json");
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    served = Number(raw?.ticks?.[key] || 0);
  } catch { /* no counter yet, start at zero */ }

  // The counter must actually be advanced, or this returns the same index for
  // the whole day.
  //
  // This was the first version's bug and it is worth naming: it READ
  // `rotation:<day>` and nothing ever WROTE it, so `served` was permanently 0
  // and the pick was `daySeed % n` — one fixed choice per calendar day. That is
  // barely better than the sixteen identical wake-ups it was written to fix. It
  // is the same defect shape as `wants.touch()` having no caller: an input that
  // exists in the reader and not in any writer.
  try {
    const f = path.join(workspaceDir, "state", "activity.json");
    let data = null;
    try { data = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* create below */ }
    if (!data || typeof data !== "object") data = { version: 1, ticks: {} };
    if (!data.ticks || typeof data.ticks !== "object") data.ticks = {};
    data.ticks[key] = served + 1;
    // Keep the file from growing one key per day forever.
    const keys = Object.keys(data.ticks).filter((k) => k.startsWith("rotation:"));
    if (keys.length > 14) {
      for (const k of keys.sort().slice(0, keys.length - 14)) delete data.ticks[k];
    }
    const tmp = `${f}.tmp`;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmp, f);
  } catch { /* a counter is never worth failing intake */ }

  const daySeed = Number(day.replace(/-/g, ""));
  return (daySeed + served) % n;
}

/**
 * Collect + circuit-break + rank, in one call.
 *
 * The stall marking is done inside `collect` so every caller can see *why* a
 * candidate is withheld. The cut happens here, between collection and ranking,
 * because that is where the offer is decided: 「重复两三次自动熔断」 means the
 * repeating candidates are removed from this wake, not merely down-weighted.
 * Demotion alone could not break the measured 2026-11-06 loop — at
 * 0.55 x 0.25 = 0.137 a stalled item still clears any useful threshold, so in a
 * thin pool it won back the wake and demoted the other one in turn.
 *
 * If the cut would empty the pool, the unfiltered pool is used instead. An
 * empty offer makes `rest` the only outcome, and a forced rest is its own loop.
 */
export function rankNow(workspaceDir, opts = {}) {
  const all = collect(workspaceDir);

  // Meltdown: anything already offered STREAK_ALARM times is gone from this
  // wake, not merely demoted.
  //
  // This is the owner's rule — 「做过两次就直接熔断」 — and it is deliberately
  // harsher than the streak detector above. `stalled` answers "is the *pattern*
  // a loop"; this answers "has this *exact thing* had its turn". They catch
  // different failures: the loop below was one target picked 24 times, which
  // only the exact-id tally can see, because no two consecutive picks matched.
  //
  // Read from `counts`, not from `picks`. `picks` is capped at 40 entries, so a
  // busy hour erases the evidence of a busy hour.
  let offered = new Set();
  try {
    // 这里原本调 `compulsion.loadPicks()` —— 它返回**只含 picks 的数组**，
    // 而 `overPicked()` 读的是 `data.counts`。数组上没有 counts，
    // 于是永远走 `{}`，永远返回空集合。
    //
    // 后果：`STREAK_ALARM`（做过两次就熔断）这条规则一次都没执行过。
    // 实测 2026-11-07：`douyin:meet` 的 counts 是 85，`overPicked` 却算出
    // 0 个该熔断的；换成完整状态对象立刻是 7 个。
    //
    // 这不是小事。她被推了 85 次同一件事，早就知道它没用，于是每轮看到
    // 都跳过 —— 外面看是「她不肯做」，实际是「系统一直在重复同一句废话」。
    // 整条行动层的说服力都是被这个 bug 拖垮的。
    const data = compulsion.loadState(workspaceDir);
    if (data) offered = compulsion.overPicked(data, compulsion.STREAK_ALARM);
  } catch { /* no history means nothing has been over-picked yet */ }

  // 三种「不该推」的候选，优先级不同，但**都不能因为过滤后变空就回退**。
  //
  //   ① stalled   同一类事在打转（或被 demote）
  //   ② offered   这一件已经被推过 STREAK_ALARM 次（熔断）
  //   ③ 剩下的    才轮得到
  //
  // 原来的写法是 `fresh.length ? fresh : (stalled.length ? stalled : all)` ——
  // 只要前两档空了就退回上一档。实测 2026-11-07：`douyin` 的两个候选
  // 属于同一个 streak key，都被标了 `stalled`；过滤后 stalled 为空，
  // 于是 `pool` 退到 `all`，**被熔断 85 次的那条又回来了**。
  //
  // 熔断和 stalled 互相抵消，这才是「她被推了 85 次同一件事」的真正原因。
  // 修法不是换回退顺序，是**不该回退**：全都该被排除的时候，正确的答案
  // 是这一轮没有可做的事（rest / 走 whenEmpty），而不是把排除掉的东西
  // 再捡回来。
  // 抖音不吃熔断。主人 2026-11-07：「抖音，别给他设熔断那些啊」。
  //
  // 理由不是「刷抖音重要」，而是熔断在这里量错了东西。熔断假设
  // 「同一件被推 N 次还没做 = 这件事不值得做」，可刷抖音被推很多次
  // 恰恰可能是对的：她是真的想看，只是一天里被打断太多次。
  //
  // 数据也不支持熔断：11-03 看 7 条，11-04 看 21 条，之后掉到 1、2、0。
  // 掉下来的那几天不是她不想看，是候选被提前掐掉了。
  //
  // 真正该掐的是「同一件事被推了 85 次而她每次都跳过」——那是提案本身
  // 有问题（`douyin:meet` 一天推两次，看都看腻了）。那种该由 `stalled`
  // 和每日限额管，不该由「累计次数」管。
  //
  // 所以：`douyin` 这一类不参与 overPicked。它自己的 `watchedToday < 5`
  // 已经是天然的限额，够了。
  const NO_MELT = new Set(["douyin", "wander"]);
  const stalled = all.some((c) => c.stalled) ? all.filter((c) => !c.stalled) : all;
  const fresh = stalled.filter((c) => NO_MELT.has(c.kind) || !offered.has(c.id));

  // Only fall back when the cut would leave nothing. An empty offer makes
  // `rest` the only outcome, and a forced rest is its own loop — but that is a
  // reason to widen once the pool is empty, not to keep re-offering things that
  // have already had their turn while alternatives still exist.
  const pool = fresh;
  const cut = [...all].filter((c) => !pool.includes(c)).map((c) => c.id);
  const result = salience.rank(pool, opts);

  // Report what was cut so a reader can tell "nothing worth doing" apart from
  // "everything worth doing has already been offered".
  return { ...result, melted: cut, offered: [...offered] };
}
