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

/** How many identical picks in a row count as a streak. */
export const STREAK_ALARM = 4;

/** How many of her own newest entries may carry 「第 N 版」 before it is a streak. */
export const VERSION_ALARM = 3;

function file(workspaceDir) {
  return path.join(workspaceDir, "state", STATE_FILE);
}

function empty() {
  return { version: 1, updated_at: null, picks: [] };
}

function load(workspaceDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(workspaceDir), "utf8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.picks)) return raw;
  } catch { /* first run, or unreadable — a fresh history is not an error */ }
  return empty();
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
  // For curiosity the id itself is the subject, so keep it.
  if (kind === "curiosity") return `curiosity:${rest}`;
  // For want/topic/gap/person/pressure the prefix is the behaviour.
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
  save(workspaceDir, data);
  return { ok: true, key, streak: currentStreak(data.picks) };
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
 * Counting within a window instead: a key that keeps coming back is still the
 * same behaviour even when other keys are interleaved. The window is shorter
 * than the history so that a thing she genuinely returned to after a long gap
 * is not still being punished for last week.
 */
export function currentStreak(picks, { window = 12 } = {}) {
  const list = Array.isArray(picks) ? picks : [];
  if (!list.length) return 0;
  const key = list[list.length - 1].key;
  const tail = list.slice(-Math.max(1, window));
  return tail.filter((p) => p.key === key).length;
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
  // Same window rule as `currentStreak`, so the number reported in the prompt
  // and the number used for demotion cannot disagree.
  const tail = picks.slice(-12);
  const run = tail.filter((p) => p.key === key);
  return {
    key,
    length: run.length,
    since: run[0].at,
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
  if (v.count >= (opts.versionAlarm ?? VERSION_ALARM)) {
    reasons.push(`你自己写下的最近 ${v.count} 条里都带版次，最新一版是第 ${v.newest} 版`);
  }

  return {
    stuck: reasons.length > 0,
    because: reasons.join("；"),
    streak: s,
    versions: v,
  };
}

/** Reset the streak. Used when she explicitly closes or drops the thing. */
export function clear(workspaceDir) {
  save(workspaceDir, empty());
  return { ok: true };
}
