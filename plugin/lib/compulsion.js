// Compulsion — "have I been picking the same thing over and over?"
//
// Why this exists
// ---------------
// Measured 2026-11-06: she wrote the fifty-third version of one question about
// rice acreage. On version forty-one she had already written the conclusion —
// 「落点就一句话……中间的年份这层不公开，故事停在这儿」 — and then kept going
// for twelve more versions. She was not confused about whether it was done. She
// had said it was done. Nothing in the system could act on that.
//
// The diary named the mechanism herself:
//   「四十个版本划下来……我不是在往前挖，是在同一个地方反复摔。」
//
// Three things were each independently pointing her back at it:
//   1. COGNITION.md §7 step 1: 「手上有没做完的」→ 接着做，别重新开一个
//   2. self.md injection: the newest 12 entries were twelve "第 N 版" lines
//   3. activity-inject: the same `shoot / used=draw` line sixteen wakes running
//
// None of them could see the others. This module is the part that can see the
// streak, and only the streak. It does not decide what to do about it.
//
// What this module deliberately does NOT do
// ----------------------------------------
// It does not read text and guess whether two entries are "about the same
// thing". That was attempted before and it failed for a measurable reason: CJK
// bigram overlap over her own 12 newest self-entries scored 0.034, against
// 0.036 for a control window of older entries — indistinguishable. A detector
// that cannot separate the case from the control is not a detector.
//
// So the signals here are all things that were *explicitly recorded*:
//   - candidate keys (`gap:draw`, `want:<id>`, `curiosity:<id>`)
//   - the version counter she writes in her own prose (「第 N 版」)
//
// The second one is not a heuristic dressed up as a fact. When she writes
// 「第五十三版」 she is stating, in her own words, that this is her fifty-third
// attempt. Reading that is not inferring; it is listening.

import fs from "node:fs";
import path from "node:path";

const STATE_FILE = "compulsion.json";
const HISTORY_MAX = 40;

/**
 * How many times a key may win before it counts as a loop.
 *
 * Owner raised this from 4 to 2 on 2026-11-06: 「重复两三次自动熔断」. The
 * argument for the lower number is the observed case — 20 straight wakes on two
 * targets — where the fourth pick was already two picks past the point a person
 * would have noticed. Waiting for four guarantees at least four repeats before
 * anything reacts.
 */
export const STREAK_ALARM = 2;

/** How many of her own newest entries may carry 「第 N 版」 before it is a streak. */
export const VERSION_ALARM = 3;

function file(workspaceDir) {
  return path.join(workspaceDir, "state", STATE_FILE);
}

function empty() {
  return { version: 1, updated_at: null, picks: [], counts: {} };
}

/**
 * How many times this exact id has been picked, ever.
 *
 * `picks` cannot answer this. It is capped at HISTORY_MAX=40, so a target she
 * has been on for an hour pushes its own early entries out of the window and
 * starts looking new again. Measured 2026-11-06: the history held exactly 40
 * picks spanning 10:15→15:04, which meant the very next wake would begin
 * discarding the evidence of the loop while the loop was still running.
 *
 * `counts` is a separate, uncapped tally keyed by exact id. It only grows, and
 * it is what "picked twice already" has to mean if the rule is going to survive
 * more than forty turns.
 */
export function pickCount(data, candidateId) {
  const id = String(candidateId || "").trim();
  if (!id) return 0;
  const counts = data && typeof data.counts === "object" ? data.counts : null;
  if (!counts) return 0;
  return Math.max(0, Number(counts[id] ?? 0));
}

/**
 * Every id that has been picked at least `n` times **recently**.
 *
 * This used to read `counts`, which is the lifetime tally and never decays.
 * With STREAK_ALARM = 2 that made the cutoff permanent: any candidate offered
 * twice was out forever, and nothing ever brought it back.
 *
 * Measured 2026-11-07 12:11: all twelve candidates were in `counts` with >= 2,
 * so `rankNow` returned an empty list and the wake injected nothing at all —
 * no proposal, no rest, just silence. From outside that reads as "she did not
 * want to do anything". The truth was that she was allowed to do nothing.
 * The `counts` docstring already said it was "how many times has this exact
 * thing been offered"; using it as a brake was the mistake, not the number.
 *
 * Three of those twelve had been picked exactly twice and would never have
 * been offered a third time. `gap:try` reached 2 because an internal
 * `internal-session-effects` turn recorded a pick 17 seconds after the real
 * wake — two records of one decision.
 *
 * So the brake is now a window, and the window expires. A thing she genuinely
 * kept coming back to still melts; a thing that had its turn an hour ago does
 * not stay buried for the rest of the day.
 */
export const MELT_WINDOW_MS = 3 * 60 * 60 * 1000;

export function overPicked(data, n = STREAK_ALARM, { withinMs = MELT_WINDOW_MS, now = Date.now() } = {}) {
  const picks = data && Array.isArray(data.picks) ? data.picks : [];
  const since = Number(now) - Number(withinMs);
  const recent = {};
  for (const p of picks) {
    const t = Date.parse(p?.at ?? "");
    if (!Number.isFinite(t) || t < since) continue;
    const id = String(p?.id ?? "");
    if (!id) continue;
    recent[id] = (recent[id] || 0) + 1;
  }
  const out = new Set();
  for (const [id, c] of Object.entries(recent)) {
    if (c >= n) out.add(id);
  }
  return out;
}

function load(workspaceDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(workspaceDir), "utf8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.picks)) return raw;
  } catch { /* first run, or unreadable — a fresh history is not an error */ }
  return empty();
}

/** The raw pick history, for callers that need the sequence and not a summary. */
export function loadPicks(workspaceDir) {
  return load(workspaceDir).picks || [];
}

/**
 * The whole state, not just the rolling window.
 *
 * `loadPicks` returns the array and drops `counts`, which is the one field the
 * meltdown has to read. Two callers needing two different shapes from the same
 * file is how the detector's halves drifted apart once already, so the full
 * state gets its own named accessor rather than making callers guess.
 */
export function loadState(workspaceDir) {
  return load(workspaceDir);
}

function save(workspaceDir, data) {
  const f = file(workspaceDir);
  const tmp = `${f}.tmp`;
  data.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, f);
}

/**
 * Normalise a candidate id down to "which kind of thing is this".
 *
 * `want:want-mw4bfcbp-lni` and `want:want-mw4aaj9c-rak` are two different
 * wants, but twelve wakes spent on wants that are all "go look up an acreage
 * figure" are one streak in behavioural terms. The prefix is what survives
 * that: it answers "what sort of move did she make", which is the question a
 * streak detector can actually answer honestly.
 *
 * `curiosity:<noticingId>` keeps the noticing id, because a curiosity streak is
 * usually the *same* noticing resurfacing, and that is worth distinguishing
 * from six different noticings.
 */
export function streakKey(candidateId) {
  const id = String(candidateId || "").trim();
  if (!id) return "";
  const i = id.indexOf(":");
  if (i < 0) return id;
  const kind = id.slice(0, i);
  const rest = id.slice(i + 1);

  // Which kinds are "the subject" and which are "the behaviour"?
  //
  // `curiosity` and `exp` both name a specific thing. Two different `exp:*`
  // entries are two different pieces of work — she could stop one and start
  // another without that being a loop, and equally she could loop on one of
  // them forever. Collapsing them to the bare kind erased that distinction.
  //
  // Measured 2026-11-06, and this was the bug the熔断 could not see:
  //   exp:exp-20261106093804-92a   → "exp"
  //   exp:exp-20261106093825-27u   → "exp"     (different work, same key)
  // Then `rotation()` compared precise ids and found no cycle, while `stalled`
  // matched `c.id` against the collapsed key and never matched at all. 24 wakes
  // on one target, no cutoff, because the two halves of the detector were
  // speaking different languages.
  if (kind === "curiosity" || kind === "exp") return `${kind}:${rest}`;

  // For want/topic/gap/person/pressure the prefix is the behaviour: two
  // different wants are still "she keeps picking wants", and that IS the
  // pattern worth cutting.
  return kind;
}

/** Append one wake's pick. Called once per turn that resolved to `do`. */
export function recordPick(workspaceDir, candidateId, at = new Date().toISOString()) {
  const id = String(candidateId || "").trim();
  if (!id) return { ok: false, reason: "没有 candidateId" };
  const data = load(workspaceDir);
  const key = streakKey(id);
  data.picks.push({ id, key, at });
  if (data.picks.length > HISTORY_MAX) data.picks = data.picks.slice(-HISTORY_MAX);

  // The uncapped tally. Same write, different lifetime: `picks` is a rolling
  // window for pattern detection, `counts` is the permanent record of "how many
  // times has this exact thing been offered". Meltdown reads `counts`.
  if (typeof data.counts !== "object" || data.counts === null) data.counts = {};
  data.counts[id] = Math.max(0, Number(data.counts[id] ?? 0)) + 1;

  save(workspaceDir, data);
  return {
    ok: true,
    key,
    streak: currentStreak(data.picks),
    count: data.counts[id],
  };
}

/**
 * How many of the recent picks share the newest pick's key.
 *
 * This used to count only *consecutive* picks and stop at the first different
 * one. That break was the reason the loop survived every earlier fix, and the
 * arithmetic is worth writing down:
 *
 *   04:38  curiosity  x4   (alarm at the 4th)
 *   04:43  horizon    x1   <- the alarm's only action: pick something else
 *   04:44  curiosity  x1   <- comes back, counter now reset to 1
 *
 * Breaking the streak reset the counter, so the detector's one response —
 * "choose a different candidate this time" — guaranteed it could happen again.
 * Four picks, one interruption, four picks, forever. Nothing ever removed the
 * thing being repeated.
 *
 * The window was the fix for that, and it introduced a worse bug: it counted
 * every pick of the key inside the window, not the run at the end. Measured
 * 2026-11-06 on the real history — 20 wakes alternating between exactly two
 * targets — the window held 6 of each and reported a streak of 6. Two keys
 * alternating therefore read as a 6-strong streak, `stalled` demoted whichever
 * one was newest to a quarter weight, and the other one won the next wake,
 * which demoted *it* next time. The demotion was manufacturing the oscillation
 * it was supposed to break.
 *
 * So: walk backwards from the newest pick and stop at the first key that
 * differs. A true run of one key still counts, and an A/B alternation counts as
 * 1 — which is what it is. The window is kept only as a bound on how far back
 * the run may reach, so that a thing she genuinely returned to after a long gap
 * is not still being punished for last week.
 */
export function currentStreak(picks, { window = 12 } = {}) {
  const list = Array.isArray(picks) ? picks : [];
  if (!list.length) return 0;
  const key = list[list.length - 1].key;
  const tail = list.slice(-Math.max(1, window));
  let n = 0;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    if (tail[i].key !== key) break;
    n += 1;
  }
  return n;
}

/**
 * The streak as it stands right now, plus the candidate ids involved.
 *
 * `since` is when the streak started, which is what makes the report usable in
 * a sentence: "this same sort of thing, since 01:44".
 */
export function streak(workspaceDir) {
  const data = load(workspaceDir);
  const picks = data.picks || [];
  if (!picks.length) return { key: null, length: 0, since: null, ids: [] };
  const key = picks[picks.length - 1].key;
  // Count the run at the end, not every occurrence in the window. Same rule as
  // `currentStreak`, so the number reported in the prompt and the number used
  // for demotion cannot disagree — and so that an A/B alternation is reported
  // as the run of 1 that it actually is.
  const tail = picks.slice(-12);
  const run = [];
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    if (tail[i].key !== key) break;
    run.unshift(tail[i]);
  }
  return {
    key,
    length: run.length,
    since: run[0]?.at ?? null,
    ids: [...new Set(run.map((p) => p.id))],
  };
}

/**
 * Count how many of her newest self-entries announce a version number.
 *
 * Reads `memory/self/self.md` the same way the injector does, so the number
 * here and the number she actually sees agree. Counting the tail rather than
 * the whole file is deliberate: 「第 53 版」 from last week is history, but
 * 「第 53 版」 in the last twelve lines is what she is looking at right now.
 */
export function versionRun(workspaceDir, { tail = 12 } = {}) {
  let body = "";
  try {
    const raw = fs.readFileSync(path.join(workspaceDir, "memory", "self", "self.md"), "utf8");
    const idx = raw.indexOf("## 本鱼写过的");
    if (idx >= 0) body = raw.slice(idx + "## 本鱼写过的".length);
  } catch { return { count: 0, numbers: [], newest: null }; }

  const entries = body.split(/\n(?=- )/).map((s) => s.trim()).filter(Boolean).slice(-tail);
  const re = /第\s*([0-9]{1,3}|[一二三四五六七八九十百]{1,6})\s*版/g;
  const numbers = [];
  for (const e of entries) {
    re.lastIndex = 0;
    const m = re.exec(e);
    if (m) numbers.push(m[1]);
  }
  return {
    count: numbers.length,
    numbers,
    newest: numbers.length ? numbers[numbers.length - 1] : null,
  };
}

/**
 * The candidate ids that have been taking turns, if the tail is a strict rotation.
 *
 * A/B alternation is a loop that a run-length counter cannot see. Measured
 * 2026-11-06: 20 straight wakes ping-ponged between two candidates out of a
 * pool of four. Run-length read 1 every time, so nothing ever tripped, and the
 * behaviour was identical to being stuck — same two things, nothing new.
 *
 * This works on exact ids, not on `streakKey` categories. Category identity is
 * the right unit for a plain run (twelve different acreage wants are one streak
 * of the same move) but the wrong one here: several distinct `exp:*` items share
 * the key `exp`, so blocking by key would take out the whole pool and leave
 * nothing to switch to. Alternation is about *these exact two things*, so it is
 * tracked by id.
 *
 * Detected by asking whether the recent tail is built from a repeating short
 * pattern. Two ids alternating period 2, three rotating period 3; both are the
 * same failure and neither is progress. The period must be short (<= 4) and the
 * pattern must repeat enough times that chance is not a plausible account.
 */
export function rotation(picks, { window = 12, maxPeriod = 4, minRepeats = 2 } = {}) {
  const list = Array.isArray(picks) ? picks : [];
  const tail = list.slice(-Math.max(1, window));
  if (tail.length < 4) return null;
  const ids = tail.map((p) => p.id);

  for (let period = 2; period <= Math.min(maxPeriod, Math.floor(ids.length / 2)); period += 1) {
    // Compare the tail against itself shifted by `period`. A rotation of that
    // length matches everywhere except the first `period` entries, which have
    // nothing to their left.
    let match = 0;
    let total = 0;
    for (let i = period; i < ids.length; i += 1) {
      total += 1;
      if (ids[i] === ids[i - period]) match += 1;
    }
    const cycle = ids.slice(-period);
    const distinct = new Set(cycle).size;
    const repeats = Math.floor(ids.length / period);

    // Demand exactness was wrong, and the real history shows why.
    //
    // 2026-11-06, last 12 picks: 9 of 10 comparisons matched at period 2. The
    // one mismatch was a different `exp:*` and nothing else — she is plainly
    // alternating between two things, and one substitution in the middle does
    // not change that. Requiring 10/10 made the detector return null on a
    // perfect-looking loop, so the ring ran 24 more wakes untouched.
    //
    // The bar is now "at most one break per cycle", floored at 1 so a two-cycle
    // still cannot pass on a single lucky comparison. A single substitution is
    // noise; two breaks mean it is not a rotation.
    const allowedBreaks = Math.max(1, Math.floor(repeats / 2));
    const breaks = total - match;
    if (
      total > 0 &&
      breaks <= allowedBreaks &&
      distinct === period &&
      repeats >= minRepeats
    ) {
      // Name every id that participated, not just the last cycle. A rotation
      // blocks all of them because taking turns is not progress, and blocking
      // only the tail would let the earlier member come straight back.
      const involved = [...new Set(ids)];
      return { period, ids: cycle, keys: cycle.map(streakKey), length: ids.length, involved };
    }
  }
  return null;
}

/**
 * One combined reading of "is she going round in circles".
 *
 * Returns `{ stuck, because, streak, versions }`. `because` is a short line
 * suitable for putting in a prompt; it is written as an observation, never as
 * an instruction, because the one thing this must not become is a scheduler
 * that tells her to stop thinking.
 */
export function check(workspaceDir, opts = {}) {
  const s = streak(workspaceDir);
  const v = versionRun(workspaceDir, opts);
  const reasons = [];

  if (s.length >= (opts.streakAlarm ?? STREAK_ALARM) && s.key) {
    reasons.push(`最近 ${s.length} 轮都在做同一类事（${s.key}）`);
  }
  // A strict rotation is the other shape of the same loop, and run-length alone
  // cannot see it. See `rotation()` for the measured case.
  let rot = null;
  try {
    const data = load(workspaceDir);
    rot = rotation(data.picks || []);
  } catch { /* no history */ }
  if (rot) {
    reasons.push(`最近 ${rot.length} 轮就在 ${rot.keys.join(" / ")} 这几样之间转`);
  }

  if (v.count >= (opts.versionAlarm ?? VERSION_ALARM)) {
    reasons.push(`你自己写下的最近 ${v.count} 条里都带版次，最新一版是第 ${v.newest} 版`);
  }

  return {
    stuck: reasons.length > 0,
    because: reasons.join("；"),
    streak: s,
    versions: v,
    rotation: rot,
  };
}

/** Reset the streak. Used when she explicitly closes or drops the thing. */
export function clear(workspaceDir) {
  save(workspaceDir, empty());
  return { ok: true };
}
