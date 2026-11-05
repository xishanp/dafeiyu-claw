// 抖音上做过什么 — a per-video ledger so the character cannot act twice.
//
// The failure this prevents is concrete: replying to the same person twice in a
// row, or liking a video it already liked. On a real account that reads as a bot
// or as someone who forgot the conversation, and it cannot be undone.
//
// Deliberately NOT in memory/YYYY-MM-DD.md. The diary is chronological prose —
// "who said what, and what I said back". Finding "did I already comment on this
// video" in there means reading the whole day and doing fuzzy text matching on
// Chinese sentences. The question is ById, so the store is keyed ById.
//
// Shape:
//   videoId -> { liked, likedAt, comments: [{ at, text, replyTo }], watchedAt }
//
// Keyed by the numeric aweme id, which the page exposes on
// [data-e2e="feed-active-video"][data-e2e-vid]. One video can carry several
// comments (a new top-level one, then replies to different people), so comments
// is a list, not a single flag.

import fs from "node:fs";
import path from "node:path";

const FILE = "douyin.json";
const APPROVAL_FILE = "douyin-approved.json";
const MAX_VIDEOS = 400;
const MAX_COMMENTS_PER_VIDEO = 12;
// How long an approved line stays typeable. Long enough to fix a selector and
// retry, short enough that a stale approval cannot be reused tomorrow.
const APPROVAL_TTL_MS = 10 * 60 * 1000;

export function logFile(workspaceDir) {
  return path.join(workspaceDir, "state", FILE);
}

function empty() {
  return { version: 1, updated_at: new Date().toISOString(), videos: {} };
}

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && raw.videos && typeof raw.videos === "object") {
      return raw;
    }
  } catch {
    /* first run, or a corrupted file we must not crash on */
  }
  return empty();
}

function save(file, data) {
  data.updated_at = new Date().toISOString();
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function key(videoId) {
  const k = String(videoId || "").trim();
  return k || null;
}

// Trim to size, oldest first. A ledger that grows forever eventually costs more
// than it saves.
function prune(data) {
  const ids = Object.keys(data.videos);
  if (ids.length <= MAX_VIDEOS) return data;
  const scored = ids
    .map((id) => {
      const v = data.videos[id] || {};
      const at = v.likedAt || v.watchedAt || (v.comments?.[0]?.at) || "";
      return { id, at: String(at) };
    })
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  const drop = scored.slice(0, scored.length - MAX_VIDEOS);
  for (const d of drop) delete data.videos[d.id];
  return data;
}

export function loadLog(workspaceDir) {
  return load(logFile(workspaceDir));
}

export function getVideo(workspaceDir, videoId) {
  const k = key(videoId);
  if (!k) return null;
  const data = loadLog(workspaceDir);
  return data.videos[k] || null;
}

/**
 * What has already been done on this video.
 *
 * Returns the same shape whether or not the video is known, so callers never
 * have to guard for null.
 */
export function status(workspaceDir, videoId) {
  const k = key(videoId);
  if (!k) {
    return { videoId: null, known: false, liked: false, comments: [] };
  }
  const v = getVideo(workspaceDir, k);
  if (!v) {
    return { videoId: k, known: false, liked: false, comments: [] };
  }
  const comments = Array.isArray(v.comments) ? v.comments : [];
  return {
    videoId: k,
    known: true,
    liked: v.liked === true,
    comments,
  };
}
/**
 * Should this comment be blocked?
 *
 * One reason only: this exact text already went out on this video. The same
 * person saying something new is a new thing to answer, so there is deliberately
 * no per-addressee cooldown — that would gag the character in a live exchange.
 *
 * The text comparison ignores whitespace and is exact otherwise. A near-miss
 * rewording slips through; that is the acceptable trade, because the failure
 * worth blocking is sending the identical line twice.
 */
export function checkComment(workspaceDir, videoId, text, replyTo = null) {
  const s = status(workspaceDir, videoId);
  const norm = (v) => String(v || "").replace(/\s+/g, " ").trim();
  const body = norm(text);
  if (!body) return { ok: false, reason: "empty" };
  if (!s.videoId) return { ok: true, reason: null };

  const dup = s.comments.find((c) => norm(c?.text) === body);
  if (dup) {
    return {
      ok: false,
      reason: "duplicate",
      at: dup.at || null,
      replyTo: dup.replyTo || null,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Record a sent comment. Only call this AFTER the page confirmed it went out —
 * a ledger that records attempts will block a legitimate retry.
 */
export function noteComment(workspaceDir, videoId, { text, replyTo = null, title = null } = {}) {
  const k = key(videoId);
  const body = String(text || "").replace(/\s+/g, " ").trim();
  if (!k) return { ok: false, reason: "no-video-id" };
  if (!body) return { ok: false, reason: "empty" };

  const file = logFile(workspaceDir);
  const data = load(file);
  const v = data.videos[k] || { comments: [] };
  if (!Array.isArray(v.comments)) v.comments = [];
  if (!v.watchedAt) v.watchedAt = new Date().toISOString();
  if (title && !v.title) v.title = String(title).slice(0, 60);

  v.comments.push({
    at: new Date().toISOString(),
    text: body,
    replyTo: replyTo ? String(replyTo).slice(0, 40) : null,
  });
  if (v.comments.length > MAX_COMMENTS_PER_VIDEO) {
    v.comments = v.comments.slice(-MAX_COMMENTS_PER_VIDEO);
  }
  v.lastCommentAt = new Date().toISOString();
  data.videos[k] = v;

  save(file, prune(data));
  return { ok: true, videoId: k, total: v.comments.length };
}

export function noteLike(workspaceDir, videoId, { title = null } = {}) {
  const k = key(videoId);
  if (!k) return { ok: false, reason: "no-video-id" };

  const file = logFile(workspaceDir);
  const data = load(file);
  const v = data.videos[k] || { comments: [] };
  if (!Array.isArray(v.comments)) v.comments = [];
  v.liked = true;
  v.likedAt = v.likedAt || new Date().toISOString();
  if (!v.watchedAt) v.watchedAt = new Date().toISOString();
  if (title && !v.title) v.title = String(title).slice(0, 60);
  data.videos[k] = v;

  save(file, prune(data));
  return { ok: true, videoId: k };
}

/**
 * A one-line summary for the prompt: what this character already did here.
 *
 * Wording matters — this text is injected into the character's context, so it
 * must read like something it remembers, not like a database row.
 */
export function describeStatus(workspaceDir, videoId) {
  const s = status(workspaceDir, videoId);
  if (!s.known) return "";
  const bits = [];
  if (s.liked) bits.push("这条已经点过赞了");
  if (s.comments.length) {
    const who = s.comments.map((c) => (c.replyTo ? `回过${c.replyTo}` : "自己发过评论"));
    const uniq = [...new Set(who)];
    bits.push(uniq.slice(0, 3).join("、"));
  }
  return bits.join("；");
}

/**
 * A short-lived ticket for one approved line.
 *
 * This is the other half of the duplicate guard. `douyin_act` decides the line
 * is allowed; this ticket is what lets the character actually type it. Without
 * the ticket the browser gate refuses the keystrokes, so a line can never reach
 * the page without passing the dedupe check first.
 *
 * Keyed by the normalized text, not by order of arrival: the gate sees exactly
 * the string that will land in the box, so it can ask "was THIS line approved".
 */
export function approveLine(workspaceDir, videoId, { text, replyTo = null } = {}) {
  const k = key(videoId);
  const body = String(text || "").replace(/\s+/g, " ").trim();
  if (!k) return { ok: false, reason: "no-video-id" };
  if (!body) return { ok: false, reason: "empty" };

  const file = path.join(workspaceDir, "state", APPROVAL_FILE);
  let data = { version: 1, entries: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && Array.isArray(raw.entries)) data = raw;
  } catch {
    /* first run */
  }

  const now = Date.now();
  // Drop anything expired on every write so the file cannot grow into a pile of
  // dead tickets nobody will ever clean up.
  data.entries = data.entries.filter((e) => {
    const t = Date.parse(e?.at || "");
    return Number.isFinite(t) && now - t < APPROVAL_TTL_MS;
  });
  data.entries.push({
    at: new Date(now).toISOString(),
    videoId: k,
    text: body,
    replyTo: replyTo ? String(replyTo).trim() : null,
  });
  if (data.entries.length > 20) data.entries = data.entries.slice(-20);

  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return { ok: true };
}

/**
 * Is this exact line approved right now?
 *
 * Consumed on use: a ticket buys one attempt. If the send failed for a layout
 * reason the character calls `douyin_act` again, which is the correct place to
 * re-check for a duplicate rather than replaying a spent ticket.
 */
export function consumeLine(workspaceDir, text) {
  const body = String(text || "").replace(/\s+/g, " ").trim();
  if (!body) return { ok: false, reason: "empty" };

  const file = path.join(workspaceDir, "state", APPROVAL_FILE);
  let data = { version: 1, entries: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && Array.isArray(raw.entries)) data = raw;
  } catch {
    return { ok: false, reason: "no-approval" };
  }

  const now = Date.now();
  const live = data.entries.filter((e) => {
    const t = Date.parse(e?.at || "");
    return Number.isFinite(t) && now - t < APPROVAL_TTL_MS;
  });
  const idx = live.findIndex(
    (e) => String(e?.text || "").replace(/\s+/g, " ").trim() === body,
  );
  if (idx < 0) {
    data.entries = live;
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    } catch { /* best effort */ }
    return { ok: false, reason: "no-approval" };
  }

  const hit = live[idx];
  live.splice(idx, 1);
  data.entries = live;

  // Keep a short trail of lines that actually reached the page.
  //
  // The ticket itself is one-shot and consumed here, so by the time
  // douyin_record runs there is normally nothing left to compare against — and
  // a record with nothing to check it against is exactly how "I typed it" got
  // reported as "I posted it" on 2026-11-03. This trail is that missing
  // evidence: it proves keystrokes happened, so the ledger entry has something
  // real behind it. It is NOT proof the send button was pressed — the page is
  // the only authority on that, and the skill tells her to look there.
  data.sent = Array.isArray(data.sent) ? data.sent : [];
  data.sent.push({
    at: new Date(now).toISOString(),
    videoId: hit.videoId || null,
    text: body,
  });
  data.sent = data.sent.filter((e) => {
    const t = Date.parse(e?.at || "");
    return Number.isFinite(t) && now - t < APPROVAL_TTL_MS;
  }).slice(-12);

  data.updated_at = new Date().toISOString();
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch { /* best effort */ }
  return { ok: true, videoId: hit.videoId || null, replyTo: hit.replyTo || null };
}

/**
 * Did this exact line reach the page recently?
 *
 * Answers only "was it typed into the live editor", never "was it posted".
 * The caller must still confirm in the page before claiming a comment exists.
 */
export function typedRecently(workspaceDir, text) {
  const body = String(text || "").replace(/\s+/g, " ").trim();
  if (!body) return false;
  const file = path.join(workspaceDir, "state", APPROVAL_FILE);
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  const now = Date.now();
  const sent = Array.isArray(data?.sent) ? data.sent : [];
  return sent.some((e) => {
    const t = Date.parse(e?.at || "");
    if (!Number.isFinite(t) || now - t >= APPROVAL_TTL_MS) return false;
    return String(e?.text || "").replace(/\s+/g, " ").trim() === body;
  });
}

/**
 * Is this exact line already typed for this video?
 *
 * `typedRecently()` answers whether ANY typing happened. The input gate needs
 * the narrower question: has this line already been entered on THIS video.
 * A repeat call is idempotency, not a task failure: the comment may already be
 * sitting in the editor or already posted. Returning that distinction lets the
 * gate suppress a second insertion without telling the character to redo work.
 */
export function typedLineRecently(workspaceDir, videoId, text) {
  const k = key(videoId);
  const body = String(text || "").replace(/\s+/g, " ").trim();
  if (!k || !body) return false;
  const file = path.join(workspaceDir, "state", APPROVAL_FILE);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  const now = Date.now();
  return (Array.isArray(data?.sent) ? data.sent : []).some((e) => {
    const at = Date.parse(e?.at || "");
    return Number.isFinite(at) && now - at < APPROVAL_TTL_MS
      && key(e?.videoId) === k
      && String(e?.text || "").replace(/\s+/g, " ").trim() === body;
  });
}

export { APPROVAL_TTL_MS };
