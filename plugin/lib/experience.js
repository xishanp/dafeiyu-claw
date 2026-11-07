// The middle layer between "it happened" and "it is part of who I am".
//
// Without this, anything the character decides to keep becomes permanent the
// moment it is recorded — there is no chance to weigh it. With it, a new entry
// sits in the pool and waits for a reflection pass to either promote or drop it.
//
// The pool is deliberately not injected into prompts. Only the promoted facts
// are. The pool is an input to thinking, not a thing to recall mid-sentence.

import fs from "node:fs";
import path from "node:path";

const MAX_POOL = 60;
const KEEP_RESOLVED = 40;

function file(workspaceDir) {
  return path.join(workspaceDir, "state", "experience-pool.json");
}

function load(workspaceDir) {
  const f = file(workspaceDir);
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    return {
      version: 1,
      entries: Array.isArray(d?.entries) ? d.entries : [],
      last_reflected_at: d?.last_reflected_at || null,
    };
  } catch {
    return { version: 1, entries: [], last_reflected_at: null };
  }
}

function save(workspaceDir, data) {
  const f = file(workspaceDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
}

function makeId(at) {
  // Seconds alone collide: several experiences can be recorded in the same turn
  // (a reply, a sticker, a decision), and two identical ids make one of them
  // unreachable through experience_resolve. Add a short counter suffix.
  const stamp = new Date(at || Date.now()).toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const n = Math.floor(Math.random() * 46656).toString(36).padStart(3, "0");
  return `exp-${stamp}-${n}`;
}

/**
 * Add a candidate experience.
 *
 * Does not promote anything. Near-duplicates (same gist within an hour) are
 * merged rather than stored twice, because the heartbeat can fire several times
 * during one ongoing exchange and would otherwise record it repeatedly.
 */
function add(workspaceDir, entry = {}) {
  const what = String(entry.what || "").trim();
  if (!what) return null;
  const at = entry.at || new Date().toISOString();
  const data = load(workspaceDir);

  const dup = data.entries.find((e) => {
    if (String(e.gist || "") !== gistOf(what)) return false;
    return Math.abs(Date.parse(e.at) - Date.parse(at)) < 3600 * 1000;
  });
  if (dup) {
    // A resolved entry means this was already judged. The heartbeat fires on a
    // timer without producing new dialogue, so it keeps reading the same last
    // exchange; without this guard it re-adds and re-resolves the same
    // experience every cycle. Only pending entries are re-confirmed.
    if (dup.status !== "pending") return null;
    dup.seen = (dup.seen || 1) + 1;
    dup.last_at = at;
    save(workspaceDir, data);
    return dup.id;
  }

  const rec = {
    id: makeId(at),
    at,
    what: what.slice(0, 300),
    gist: gistOf(what),
    with: entry.with || null,
    who: entry.who || null,
    feel: entry.feel ? String(entry.feel).slice(0, 120) : null,
    seen: 1,
    status: "pending",
  };
  data.entries.push(rec);
  if (data.entries.length > MAX_POOL) {
    // Drop the oldest already-resolved entries first: pending ones are the
    // whole point of the pool and must survive a trim.
    const resolved = data.entries.filter((e) => e.status !== "pending");
    const pending = data.entries.filter((e) => e.status === "pending");
    const keepResolved = resolved.slice(-KEEP_RESOLVED);
    data.entries = [...keepResolved, ...pending].sort((a, b) =>
      String(a.at).localeCompare(String(b.at)),
    );
  }
  save(workspaceDir, data);
  return rec.id;
}

/** Same local clock the diary uses, so the two never disagree by a timezone. */
function localStamp(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Cheap normalisation so "她催本鱼发照片" and "她催本鱼发 照片" collide. */
function gistOf(what) {
  return String(what || "")
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?~～…]/g, "")
    .slice(0, 18);
}

/**
 * Retire pending entries nobody ever got round to judging.
 *
 * Without this the pool has no exit for the common case: she records a thing,
 * the next turn records another, and `experience_resolve` is a manual call she
 * makes when she happens to notice the block. Measured 2026-11-07: 15 pending,
 * the oldest from the previous morning, `last_reflected_at` two days stale.
 * 21 entries had been resolved overnight and the pool still grew — intake beat
 * judgement, and the backlog was invisible except as a longer prompt block.
 *
 * Ageing is not the same as judging. A retired entry is marked `dropped` with a
 * note saying nobody judged it, so the record stays honest about what happened:
 * the thing was written down and then forgotten, which is a real outcome and a
 * more useful one than a queue that never drains.
 */
function ageOut(workspaceDir, { days = 3, keep = 3 } = {}) {
  const data = load(workspaceDir);
  const cutoff = Date.now() - days * 86400000;
  const pendingItems = data.entries.filter((e) => e.status === "pending");
  if (!pendingItems.length) return 0;
  // `keep` protects the newest N by POSITION, not a gate on the whole pass.
  //
  // The first version returned early when the pool held <= keep items, so four
  // entries from five days ago were all preserved — the pool was small, so it
  // was assumed healthy. Size says nothing about age; the only thing that makes
  // an entry stale is time, and that has to be checked per entry.
  const newest = new Set(
    pendingItems.slice(-keep).map((e) => e.id),
  );
  const old = pendingItems
    .filter((e) => !newest.has(e.id))
    .filter((e) => {
      const t = Date.parse(e.at ?? "");
      return Number.isFinite(t) && t < cutoff;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!old.length) return 0;
  let n = 0;
  for (const e of old) {
    e.status = "dropped";
    e.resolved_at = new Date().toISOString();
    e.resolve_note = "放了几天没回头看，就这么过去了";
    e.aged_out = true;
    n += 1;
  }
  if (n) save(workspaceDir, data);
  return n;
}

function pending(workspaceDir, limit = 12) {
  return load(workspaceDir)
    .entries.filter((e) => e.status === "pending")
    .slice(-limit);
}

/** Mark one entry resolved. Outcome is "kept" or "dropped". */
function resolve(workspaceDir, id, outcome, note) {
  const data = load(workspaceDir);
  const e = data.entries.find((x) => x.id === id);
  if (!e) return false;
  e.status = outcome === "kept" || outcome === "keep" ? "kept" : "dropped";
  e.resolved_at = new Date().toISOString();
  if (note) e.resolve_note = String(note).slice(0, 200);
  save(workspaceDir, data);
  return true;
}

/**
 * Things she kept but has not done anything with yet.
 *
 * `kept` used to be the end of the line: `consolidate()` turned the entry into
 * one fact line, nothing read it again, and the thing itself was gone. Measured
 * on 2026-11-06 with the one unambiguous curiosity event in her history:
 *
 *   03:23:37  《给我家这个角色养的记忆星图》, feel: touching
 *   03:29:28  status: kept, note 「跟本鱼自己这层记忆是同一件事」
 *   after     nothing, ever
 *
 * She had just noticed that her own memory works the way that video does. Six
 * minutes later it was a row in learned.md and a topic she would never return
 * to. That is not what "kept" means to a person — kept means it is still in
 * her hands.
 *
 * So kept entries stay visible as an open question for a while. They are not
 * a to-do list and nothing is required; the point is that the door stays open
 * instead of closing the moment she writes the note.
 */
function openQuestions(workspaceDir, { days = 7, limit = 3 } = {}) {
  const cutoff = Date.now() - days * 86400000;
  return load(workspaceDir)
    .entries.filter((e) => e.status === "kept")
    .filter((e) => {
      const t = Date.parse(e.consolidated_at || e.resolved_at || e.at || "");
      return Number.isFinite(t) && t >= cutoff;
    })
    .slice(-limit)
    .map((e) => ({
      id: e.id,
      at: e.resolved_at || e.at,
      what: String(e.gist || e.what || "").slice(0, 60),
      note: String(e.resolve_note || "").slice(0, 60),
    }));
}

/**
 * What the prompt should see: how much is waiting, plus the most recent few.
 * Returns "" when the pool is empty, so the block disappears entirely instead of
 * injecting an empty heading every turn.
 */
function describe(workspaceDir, limit = 4) {
  const items = pending(workspaceDir, limit);
  if (!items.length) return "";
  const total = load(workspaceDir).entries.filter((e) => e.status === "pending").length;
  const lines = items.map((e) => {
    const when = localStamp(e.at);
    return `  · ${e.id} ${when} ${String(e.what).slice(0, 50)}${e.seen > 1 ? `（第${e.seen}次）` : ""}`;
  });
  return [
    `【还没想明白的事】共 ${total} 条`,
    ...lines,
    "这些是发生过但还没定性的。想清楚了用 experience_resolve 留或丢，别一直堆着。",
  ].join("\n");
}

export { add, pending, resolve, describe, load, save, gistOf, openQuestions, ageOut };
