// The daily file used to record only `channel | chatId | ok | 1234ms`.
// That is a performance log, not a memory: it never says what happened, so
// nothing in it can be recalled later or turned into a topic. This module
// writes the actual exchange instead — who said what, in order.
//
// Everything here is append-only and best-effort. A failed write must never
// break the reply path, so every entry point catches and returns.

import fs from "node:fs";
import path from "node:path";
import { todayIn } from "./clock.js";

const MAX_LINE_CHARS = 220;

function dayFile(workspaceDir, at) {
  const dir = path.join(workspaceDir, "memory");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${localDay(at)}.md`);
}

/**
 * The calendar day the character is living in, not the one UTC is living in.
 *
 * `toISOString().slice(0,10)` splits the day at 08:00 local time in UTC+8, so
 * everything said between midnight and eight in the morning was filed under the
 * previous day's file. On 2026-11-03 that left today's file empty while the last
 * entries of 2026-11-02 were things said at 06:25 and 07:40 that same morning.
 * Any day-scoped logic (diary, memory packing, "what happened today") has to
 * agree with the wall clock the character talks about.
 */
function localDay(at) {
  return todayIn(at ? new Date(at) : new Date());
}

function clockOf(at) {
  const d = new Date(at || Date.now());
  // Local wall clock: the file is read by the character, who thinks in local
  // time, so an ISO Z-slice would put every evening entry in the wrong hour.
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function lastWriteAt(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function clean(text, max = MAX_LINE_CHARS) {
  const s = String(text || "")
    .replace(/\r/g, "")
    .replace(/\[CQ:[^\]]+\]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

const DIARY_HEAD = "## 自己的话";

/**
 * Split a day file into "the dialogue part" and "her own section".
 *
 * The day file has two writers by design: the plugin records exchanges, the
 * character records how the day felt. The character's part lives in one fixed
 * section that always sits last, so new dialogue can be appended above it
 * without either writer having to understand the other's content.
 */
function splitDiary(raw) {
  const text = String(raw || "");
  const idx = text.indexOf(DIARY_HEAD);
  if (idx < 0) return { talk: text, diary: null };
  return {
    talk: text.slice(0, idx).replace(/\n+$/, ""),
    diary: text.slice(idx + DIARY_HEAD.length).replace(/^\n+/, "").replace(/\n+$/, ""),
  };
}

function joinDiary(talk, diary) {
  const t = String(talk || "").replace(/\n+$/, "");
  if (diary === null || diary === undefined) return t ? `${t}\n\n` : "";
  const d = String(diary).trim();
  const body = `${DIARY_HEAD}\n${d}\n`;
  return t ? `${t}\n\n${body}` : body;
}

/**
 * Record one exchange.
 *
 * `userText` may be empty (the character spoke first); `botText` may be empty
 * when the turn produced no reply. Both empty means nothing is written.
 */
function noteTurn(workspaceDir, opts = {}) {
  try {
    const userText = clean(opts.userText);
    const botText = clean(opts.botText);
    if (!userText && !botText) return false;

    const at = opts.at || Date.now();
    const file = dayFile(workspaceDir, at);
    const head = `## ${clockOf(at)}${opts.who ? " · " + opts.who : ""}`;
    const lines = [];
    if (userText) lines.push(`对方: ${userText}`);
    if (botText) lines.push(`本鱼: ${botText}`);

    let prev = "";
    try {
      prev = fs.readFileSync(file, "utf8");
    } catch {
      prev = "";
    }
    const { talk, diary } = splitDiary(prev);

    // The two halves of one exchange arrive as two separate calls. When the
    // preceding block is the same minute, same speaker pair, and has no entry
    // for this side yet, continue it instead of starting a second heading.
    // Only the reply half merges, and only into a block that is waiting for it:
    // same minute, already has 对方:, and has no 本鱼: yet. A new incoming line
    // always starts its own block — merging it upward would attach what the user
    // just said to the previous exchange.
    let merged = false;
    let nextTalk = talk;
    if (botText) {
      try {
        // A file holding exactly one block has no "\n## " before it: the heading
        // sits at offset 0. Treating that as "no block found" skipped the merge
        // and split every first exchange of the day into two headings.
        const lastHead = talk.lastIndexOf("\n## ");
        const cut = lastHead >= 0 ? lastHead : talk.startsWith("## ") ? 0 : -1;
        if (cut >= 0 && at - lastWriteAt(file) < 120000) {
          const tailBlock = talk.slice(cut);
          const tailHead = (tailBlock.match(/## ([^\n·]+)/) || [])[1];
          const sameMinute = tailHead && tailHead.trim() === clockOf(at);
          const awaitingReply =
            tailBlock.includes("\n对方:") && !tailBlock.includes("\n本鱼:");
          if (sameMinute && awaitingReply) {
            nextTalk = `${talk.replace(/\n+$/, "")}\n本鱼: ${botText}`;
            merged = true;
          }
        }
      } catch {
        merged = false;
      }
    }
    if (!merged) {
      const block = [head, ...lines].join("\n");
      nextTalk = talk ? `${talk.replace(/\n+$/, "")}\n\n${block}` : block;
    }

    fs.writeFileSync(file, joinDiary(nextTalk, diary));
    trim(file, opts.maxLines);
    return true;
  } catch {
    return false;
  }
}

/**
 * Her own note about the day, appended inside the fixed section.
 *
 * Two writers share this file and they must not fight. The plugin owns the
 * dialogue blocks (`## HH:MM · name` / `对方:` / `本鱼:`) because only it sees
 * both halves of an exchange. The character owns prose about how the day felt.
 *
 * Before this section existed the model wrote the whole file with `write`,
 * which replaces content — on 2026-11-03 that took the day file to zero bytes
 * and then to a single line in a format nothing else could parse. Appending
 * inside a fixed section keeps both kinds in one readable file and makes the
 * writer impossible to get wrong.
 */
function noteDiary(workspaceDir, opts = {}) {
  try {
    const text = clean(opts.text, 600);
    if (!text) return false;
    const at = opts.at || Date.now();
    const file = dayFile(workspaceDir, at);

    let prev = "";
    try {
      prev = fs.readFileSync(file, "utf8");
    } catch {
      prev = "";
    }
    const { talk, diary } = splitDiary(prev);
    const line = `- ${clockOf(at)} ${text}`;
    const nextDiary = diary ? `${diary}\n${line}` : line;

    fs.writeFileSync(file, joinDiary(talk, nextDiary));
    trim(file, opts.maxLines);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record something that happened but has no counterpart — the character acted on
 * its own, or an event landed with no words attached.
 */
function noteEvent(workspaceDir, opts = {}) {
  try {
    const text = clean(opts.text);
    if (!text) return false;
    const at = opts.at || Date.now();
    const file = dayFile(workspaceDir, at);
    fs.appendFileSync(file, `- ${clockOf(at)} ${text}\n`);
    trim(file, opts.maxLines);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the tail of the file.
 *
 * Counted in lines rather than entries, because entries are 2-4 lines each and
 * a line budget is what actually bounds the file size.
 */
function trim(file, maxLines) {
  const cap = Number(maxLines) || 2000;
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    if (lines.length <= cap) return;
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, lines.slice(-cap).join("\n"));
    fs.renameSync(tmp, file);
  } catch {
    /* a half-written file is worse than an oversized one */
  }
}

/** The last `n` characters of the most recent day file, for reflection input. */
function recent(workspaceDir, opts = {}) {
  const days = Number(opts.days) || 1;
  const out = [];
  const now = Date.now();
  for (let i = 0; i < days; i += 1) {
    const file = dayFile(workspaceDir, now - i * 86400000);
    try {
      if (!fs.existsSync(file)) continue;
      const body = fs.readFileSync(file, "utf8").trim();
      if (body) out.push({ day: path.basename(file, ".md"), body });
    } catch {
      /* skip an unreadable day rather than losing the others */
    }
  }
  return out;
}

/**
 * The part of today's file written after `cursor`.
 *
 * Reflection used to read the tail of the file every time it ran. A heartbeat
 * produces no dialogue, so it kept re-reading the last exchange and recording
 * it again — one line became seventeen pool entries overnight. The cursor
 * makes "what is new" mean what it says: bytes appended since the last look.
 */
function tailAfter(workspaceDir, cursor = {}) {
  const file = dayFile(workspaceDir, Date.now());
  const day = path.basename(file, ".md");
  try {
    const body = fs.readFileSync(file, "utf8");
    // A cursor stamped with another day cannot address this file's offsets.
    const offset = cursor?.day === day ? Math.max(0, Number(cursor.offset) || 0) : 0;
    return { day, text: body.slice(offset), end: body.length };
  } catch {
    return { day, text: "", end: 0 };
  }
}

const CURSOR_FILE = "state/life-cursor.json";

/**
 * How far the diary has been read.
 *
 * Kept on disk rather than in memory so a restart cannot rewind it and replay
 * yesterday's last exchange as if it just happened.
 */
function readCursor(workspaceDir) {
  try {
    const f = path.join(workspaceDir, CURSOR_FILE);
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    return { day: d?.day || null, offset: Number(d?.offset) || 0 };
  } catch {
    return { day: null, offset: 0 };
  }
}

function markReflected(workspaceDir, cursor) {
  try {
    const f = path.join(workspaceDir, CURSOR_FILE);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ day: cursor?.day || null, offset: Number(cursor?.offset) || 0 }, null, 2));
    fs.renameSync(tmp, f);
  } catch {
    /* a lost cursor only costs a duplicate or two, never a missing entry */
  }
}

export { noteTurn, noteDiary, noteEvent, recent, tailAfter, readCursor, markReflected, dayFile };
