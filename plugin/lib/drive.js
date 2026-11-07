// An urge has to cost something, or it is only a suggestion.
//
// The measured problem
// --------------------
// 2026-11-06: `urges` (the only path from a feeling to an action) was dead for
// its entire life because `if (urges.length)` tested an object. Fixing that made
// the block print `【这会儿的劲头】想干点什么就去干` — and that is all it ever
// did. She could read it and sit still, correctly, because nothing anywhere
// treated idling as a consequence.
//
// The owner asked the same thing three ways that night: 「它根本不会拿情绪做
// 事」/「情绪能驱动事件」/「它都没法完成」. The gap was not the hint text. It was
// that a strong feeling and no action were allowed to coexist forever.
//
// What this module does
// ---------------------
// Counts consecutive turns where a strong feeling was live and the turn produced
// no deed. Past a threshold, the feeling is expressed as a penalty on her next
// wake instead of an invitation: `bored` keeps climbing even though she just
// idled, `down` deepens, `calm` drains. Sitting still stops being free.
//
// What this module deliberately does NOT do
// -----------------------------------------
// It never forces a tool call, never rewrites her reply, and never names a
// specific action. A character that is told "you must call browsed now" produces
// compliance, not intent, and the difference shows in the text. What it changes
// is how the *next* moment feels when nothing happened in this one.
//
// It also only counts turns where nobody was talking to her. Idling mid-
// conversation is called listening, and charging for it would make her restless
// while someone is mid-sentence.

import fs from "node:fs";
import path from "node:path";

const FILE_VERSION = 1;
const MAX_IDLE = 20;

export function driveFile(workspaceDir) {
  return path.join(workspaceDir, "state", "drive.json");
}

function load(workspaceDir) {
  try {
    const raw = fs.readFileSync(driveFile(workspaceDir), "utf8");
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object") return null;
    return d;
  } catch {
    return null;
  }
}

function save(workspaceDir, data) {
  const file = driveFile(workspaceDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Which feeling is live enough to demand something, in the same order and with
 * the same thresholds `urges` uses in index.js.
 *
 * Kept here rather than imported so the rule can be tested without booting the
 * whole plugin. The thresholds must stay in step with index.js; the test asserts
 * they do.
 */
export const LIVE_FEELING = {
  down: (d) => (d.down > 0.45 || d.wronged > 0.3),
  bored: (d) => d.bored > 0.42,
  curious: (d) => d.curious > 0.66,
  happy: (d) => d.happy > 0.62 || d.excited > 0.55,
};

export function strongestFeeling(dimensions = {}) {
  const order = ["down", "bored", "curious", "happy"];
  for (const key of order) {
    try {
      if (LIVE_FEELING[key](dimensions)) return key;
    } catch { /* a malformed dimension value must not break the scan */ }
  }
  return null;
}

/**
 * Record one finished turn.
 *
 * `acted` is true when this turn left a deed behind. `addressed` is true when a
 * person was talking to her — those turns are never counted as idling.
 */
export function record(workspaceDir, { feeling, acted, addressed = false, at = new Date() } = {}) {
  const prev = load(workspaceDir) || { version: FILE_VERSION, idle: 0, by: null, history: [] };
  const data = {
    version: FILE_VERSION,
    idle: Number(prev.idle || 0),
    by: prev.by ?? null,
    last_at: prev.last_at ?? null,
    history: Array.isArray(prev.history) ? prev.history.slice(-MAX_IDLE) : [],
  };

  // A conversation turn resets the counter. Being talked to is not idling, and
  // the feeling was not "unspent" — it was aimed at a person.
  if (addressed) {
    data.idle = 0;
    data.by = null;
  } else if (acted) {
    data.idle = 0;
    data.by = null;
    data.history.push({ at: at.toISOString(), feeling, acted: true });
  } else if (feeling) {
    data.idle += 1;
    data.by = feeling;
    data.history.push({ at: at.toISOString(), feeling, acted: false });
  }
  // No feeling and no action: leave the counter alone. A quiet turn with nothing
  // pulling at her is not evidence of avoidance.
  data.history = data.history.slice(-MAX_IDLE);
  data.last_at = at.toISOString();
  save(workspaceDir, data);
  return data;
}

/**
 * How much the unspent feeling should cost right now.
 *
 * Zero below the threshold: two idle turns is an afternoon, not a pattern.
 * Grows with the streak so the pressure is proportional to what actually
 * accumulated, and capped so a long absence cannot produce a single punishing
 * jump when she comes back.
 */
export function pressure(workspaceDir, { threshold = 3 } = {}) {
  const d = load(workspaceDir);
  const idle = Number(d?.idle || 0);
  if (idle < threshold) {
    return { idle, feeling: d?.by ?? null, level: 0, lines: [] };
  }
  // 3 idle -> +1 unit, 6 -> +2, 9 -> +3, capped at 4.
  const steps = Math.min(4, Math.floor(idle / threshold));
  const feeling = d?.by ?? null;
  return {
    idle,
    feeling,
    level: steps,
    lines: describePressure(feeling, idle, steps),
  };
}

const WHAT = {
  bored: "闲得发慌",
  curious: "心里挂着件事没去弄",
  down: "堵着，又什么都没干",
  happy: "心里亮着，却一直没动",
};

function describePressure(feeling, idle, steps) {
  if (!feeling) return [];
  const what = WHAT[feeling] || "有点什么压着";
  // PROACTIVE.md says 「什么都不干和其他条一样正当」 and that rule stays true.
  // What it does not cover is wanting something and never going to get it — the
  // body being idle is fine, the want going unfed is not. Both statements have
  // to survive in the same prompt, so this one names the difference instead of
  // contradicting the other.
  const lines = [
    `【第 ${idle} 轮了】`,
    `${what}，已经连着 ${idle} 轮醒来没往那个方向走一步。`,
  ];
  if (steps >= 2) {
    lines.push(
      "发呆本身没问题——真没什么想干的，坐着是对的。",
      "但现在不是没想干的，是想了没去。这两件事不一样：前者歇着，后者憋着。",
    );
  } else {
    lines.push("真不想动就算了。只是别把「想去」和「没去」当成一回事。");
  }
  return lines;
}

/**
 * What the unspent feeling costs, as an actual change to the emotion state.
 *
 * This is the part that makes the hint a consequence instead of a suggestion.
 * Text alone can be read and ignored; a feeling that keeps climbing while she
 * sits still cannot. Applied by the caller on each wake, before the prompt is
 * built, so the number she reads has already moved.
 *
 * Scaled by streak so the first idle turn is free: one quiet wake is an
 * afternoon, not a failure.
 */
export function penalty(workspaceDir, { threshold = 3 } = {}) {
  const p = pressure(workspaceDir, { threshold });
  if (p.level <= 0) return { apply: false, deltas: {} };
  // The live feeling deepens; comfort drains. Capped small per wake (0.04-0.16)
  // so the climb is felt over several wakes rather than spiking once.
  const strength = Math.min(0.16, 0.04 * p.level);
  const deltas = {};
  if (p.feeling === "bored") {
    deltas.bored = strength;
    deltas.calm = -strength * 0.5;
  } else if (p.feeling === "curious") {
    // Curiosity that goes unfed turns into a low pull rather than more curiosity:
    // letting it keep rising would reward idling with a stronger urge.
    deltas.curious = -strength * 0.5;
    deltas.down = strength * 0.6;
  } else if (p.feeling === "down") {
    deltas.down = strength;
    deltas.happy = -strength * 0.6;
  } else if (p.feeling === "happy") {
    // Wanting to be seen and not going out fades rather than intensifies.
    deltas.happy = -strength;
    deltas.down = strength * 0.4;
  }
  return { apply: true, deltas, feeling: p.feeling, level: p.level };
}

/**
 * What to inject, or "" when nothing is owed.
 */
export function describe(workspaceDir, opts = {}) {
  const p = pressure(workspaceDir, opts);
  return p.lines.length ? p.lines.join("\n") : "";
}

export function status(workspaceDir) {
  const d = load(workspaceDir);
  return {
    idle: Number(d?.idle || 0),
    feeling: d?.by ?? null,
    last_at: d?.last_at ?? null,
  };
}
