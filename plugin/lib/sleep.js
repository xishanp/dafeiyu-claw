// Nightly consolidation: turning a day of events into relations.
//
// The insight this implements came from reading a real diary back. One entry
// compared two unrelated subjects and drew the same conclusion about both —
// "where a thing is says more about it than the thing itself". That single
// sentence contained a relation between two domains, stated plainly and then
// lost, because edges.json only grew from a sibling-similarity match between
// experience entries. The system was storing prose and throwing away the
// structure inside it.
//
// Doing this at the point of writing would mean asking her to categorise every
// thought, which is exactly the stiffness that made the old heartbeat prompt
// produce nothing but explanations. So relations are extracted in one pass,
// later, from prose she already wrote for her own reasons.
//
// Two rules that keep this honest:
// - Only what she actually said. No inferred relations, no "these are probably
//   related because the words overlap". A missing edge costs nothing; a
//   fabricated one corrupts recall for weeks.
// - The pass is idempotent. It records which diary days it has covered, so a
//   restart cannot double-write the same night.

import fs from "node:fs";
import path from "node:path";

const FILE = "consolidation.json";
const MIN_PAIR = 6;

function file(workspaceDir) {
  return path.join(workspaceDir, "state", FILE);
}

function load(workspaceDir) {
  try {
    return JSON.parse(fs.readFileSync(file(workspaceDir), "utf8"));
  } catch {
    return { version: 1, days: {}, relations: [], last_run: null };
  }
}

function save(workspaceDir, data) {
  const f = file(workspaceDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  data.last_run = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
}

/** Read one day's diary lines, with a stable id per line. */
export function diaryLines(workspaceDir, day) {
  const f = path.join(workspaceDir, "memory", `${day}.md`);
  let raw = "";
  try {
    raw = fs.readFileSync(f, "utf8");
  } catch {
    return [];
  }
  const out = [];
  let i = 0;
  for (const line of raw.split("\n")) {
    // Headings, timestamps alone, and blank lines are structure, not content.
    // Counting them would let a "relation" land between a heading and an
    // unrelated sentence, which reads as a link she never made.
    if (/^\s*#/.test(line)) continue;
    if (/^\s*-?\s*\d{1,2}:\d{2}\s*$/.test(line)) continue;
    const s = line.replace(/^\s*-\s*/, "").trim();
    if (s.length < MIN_PAIR) continue;
    out.push({ id: `${day}#${i}`, text: s, day });
    i += 1;
  }
  return out;
}

/**
 * Store relations she named herself.
 *
 * @param {string} workspaceDir
 * @param {object} opts
 * @param {string} opts.day         "2026-11-05"
 * @param {Array<{from:string,to:string,relation:string}>} opts.pairs
 * @returns {{stored:number, skipped:number}}
 */
export function rememberRelations(workspaceDir, { day, pairs = [] } = {}) {
  const data = load(workspaceDir);
  let stored = 0;
  let skipped = 0;
  const knownLines = new Set(diaryLines(workspaceDir, day).map((l) => l.id));

  for (const p of pairs) {
    const from = String(p?.from || "").trim();
    const to = String(p?.to || "").trim();
    const relation = String(p?.relation || "").trim();
    // Both ends must be real lines from that day. Anything else is the model
    // paraphrasing, and a relation between two things that were never written
    // is exactly the fabrication this pass must not produce.
    if (!knownLines.has(from) || !knownLines.has(to) || !relation) {
      skipped += 1;
      continue;
    }
    if (from === to) {
      skipped += 1;
      continue;
    }
    const key = [from, to].sort().join("|");
    if (data.relations.some((r) => r.key === key && r.relation === relation)) {
      skipped += 1;
      continue;
    }
    data.relations.push({
      key,
      from,
      to,
      relation: relation.slice(0, 40),
      day,
      at: new Date().toISOString(),
    });
    stored += 1;
  }

  data.days[day] = { at: new Date().toISOString(), pairs: pairs.length, stored };
  save(workspaceDir, data);
  return { stored, skipped };
}

/** Mark a day as reviewed even when it produced no relations. */
export function markDay(workspaceDir, day) {
  const data = load(workspaceDir);
  if (!data.days[day]) data.days[day] = { at: new Date().toISOString(), pairs: 0, stored: 0 };
  save(workspaceDir, data);
}

export function pendingDays(workspaceDir, lookback = 3) {
  const data = load(workspaceDir);
  const out = [];
  const now = new Date();
  for (let i = 1; i <= lookback; i++) {
    const d = new Date(now.getTime() - i * 86400000);
    const day = d.toISOString().slice(0, 10);
    if (data.days[day]) continue;
    if (!fs.existsSync(path.join(workspaceDir, "memory", `${day}.md`))) continue;
    out.push(day);
  }
  return out;
}

export function relationsFor(workspaceDir, day) {
  const data = load(workspaceDir);
  return data.relations.filter((r) => !day || r.day === day);
}

export function stats(workspaceDir) {
  const data = load(workspaceDir);
  return {
    relations: data.relations.length,
    days_reviewed: Object.keys(data.days).length,
    last_run: data.last_run,
    pending: pendingDays(workspaceDir),
  };
}
