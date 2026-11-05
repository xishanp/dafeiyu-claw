// Wants: the things she decided, on her own time, that she wants to do.
//
// Verified 2026-11-05, reading lib/intent.js back to its own header:
//
//   There is no "invent something interesting" source. A generator that mints
//   candidates from nothing produces noise that scores well.
//
// That refusal was correct about *inventing*. It left the system with four
// intake paths and every one of them passive: a topic going quiet, an
// unjudged experience, a person who has been silent, a starved aspiration. She
// could only ever choose among things that had already happened to her. Which is
// why every wake produced the same four outputs — look something up, draw
// something, take a photo, scroll — and then explain the result. Nothing in the
// loop ever came from her.
//
// The distinction that was missing: *invent* is not the only alternative to
// *passive*. A want she writes down herself, in her own words, from her own
// reasons, at the end of a turn she was already taking, is neither passive input
// nor a fabricated number. It is her own output becoming her own input on the
// next wake — the loop closing on itself instead of on a scheduler.
//
// Design constraints, and why each exists:
//
// - It must cost nothing extra. This is not a new model call; it rides on a
//   turn that is already happening. A separate "think of a want" job would just
//   be another prompt to follow.
// - It must decay. A want from three weeks ago is not a want, it is a chore. An
//   undecided want that keeps coming up gets demoted by outcome scoring, which
//   already exists and already works.
// - It must be droppable. She has to be able to say "I no longer want this"
//   without it counting as a failure. Otherwise the pool becomes a backlog of
//   obligations and she will do them out of guilt, which is the exact behaviour
//   this replaces.
// - It must not be required. Waking with no wants is a legitimate state and
//   must not default to "find something". That default is what produced the
//   sighing.

import fs from "node:fs";
import path from "node:path";

const FILE = "wants.json";
const MAX_OPEN = 12;
const DECAY_DAYS = 21;

function file(workspaceDir) {
  return path.join(workspaceDir, "state", FILE);
}

function load(workspaceDir) {
  try {
    const d = JSON.parse(fs.readFileSync(file(workspaceDir), "utf8"));
    if (d && Array.isArray(d.wants)) return d;
  } catch {}
  return { version: 1, wants: [] };
}

function save(workspaceDir, data) {
  const f = file(workspaceDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
}

function nowIso() {
  return new Date().toISOString();
}

function daysSince(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

/**
 * Record a want.
 *
 * @param {string} workspaceDir
 * @param {object} opts
 * @param {string} opts.what    what she wants to do, in her own words
 * @param {string} [opts.why]   why, optional — the reason she would give
 * @param {number} [opts.value] how much she wants it, 0..1
 * @returns {{ok:boolean, id?:string, reason?:string}}
 */
export function add(workspaceDir, { what, why = "", value = 0.5 } = {}) {
  const text = String(what || "").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "没说想干什么" };
  if (text.length > 120) return { ok: false, reason: "太长，一句话说清" };

  const data = load(workspaceDir);

  // Same want written twice is one want. Compare on a loose key so "去看那个
  // 视频" and "去看那个视频。" do not both survive.
  const key = text.replace(/[。！？.!?\s]/g, "");
  if (data.wants.some((w) => w.status === "open" && w.key === key)) {
    return { ok: false, reason: "这条已经记着了" };
  }

  const open = data.wants.filter((w) => w.status === "open");
  if (open.length >= MAX_OPEN) {
    return { ok: false, reason: `手里已经攒了 ${open.length} 件没做的，先做完或者放掉几件` };
  }

  const id = `want-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  data.wants.push({
    id,
    key,
    what: text,
    why: String(why || "").slice(0, 160),
    value: Math.max(0, Math.min(1, Number(value) || 0.5)),
    status: "open",
    at: nowIso(),
    attempts: 0,
  });
  save(workspaceDir, data);
  return { ok: true, id };
}

/** Mark it done, or let it go. Both are clean endings. */
export function close(workspaceDir, id, outcome = "done") {
  const data = load(workspaceDir);
  const w = data.wants.find((x) => x.id === id);
  if (!w) return { ok: false, reason: "没有这一条" };
  if (w.status !== "open") return { ok: false, reason: "这条已经结了" };
  w.status = outcome === "dropped" ? "dropped" : "done";
  w.closed_at = nowIso();
  save(workspaceDir, data);
  return { ok: true, status: w.status };
}

/**
 * Open wants, freshest first, with old ones filtered out.
 *
 * A want that is still open after DECAY_DAYS is retired rather than shown.
 * Showing it forever is how a pool of desires turns into a list of debts.
 */
export function open(workspaceDir) {
  const data = load(workspaceDir);
  let changed = false;
  for (const w of data.wants) {
    if (w.status === "open" && daysSince(w.at) > DECAY_DAYS) {
      w.status = "expired";
      w.closed_at = nowIso();
      changed = true;
    }
  }
  if (changed) save(workspaceDir, data);
  return data.wants
    .filter((w) => w.status === "open")
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export function get(workspaceDir, id) {
  return load(workspaceDir).wants.find((w) => w.id === id) || null;
}

/** Note that a want was picked up but not finished. Keeps it in play. */
export function touch(workspaceDir, id) {
  const data = load(workspaceDir);
  const w = data.wants.find((x) => x.id === id);
  if (!w) return { ok: false };
  w.attempts = (w.attempts || 0) + 1;
  w.last_attempt = nowIso();
  save(workspaceDir, data);
  return { ok: true, attempts: w.attempts };
}

export function stats(workspaceDir) {
  const data = load(workspaceDir);
  const by = {};
  for (const w of data.wants) by[w.status] = (by[w.status] || 0) + 1;
  return { total: data.wants.length, open: by.open || 0, by };
}
