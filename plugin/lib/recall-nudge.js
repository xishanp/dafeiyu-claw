// Yesterday, handed over without being asked.
//
// The measured problem
// --------------------
// 2026-11-06: eight day files, 139,729 characters of her own writing, and zero
// characters of it injected on any wake. `recall_about` exists and she had
// called it zero times in the whole probe log. A memory that requires a search
// query to reach is a memory you only find when you already remember it.
//
// Why not just inject the diary
// -----------------------------
// The tail of a day file is not all hers. The same file carries machine lines
// (`| fail |`), dialogue blocks (`对方:` / `本鱼:`) and an agent log. Injecting
// the raw tail would put system noise in front of her and call it memory.
//
// So this reads only the `## 自己的话` section, which is written by `note_diary`
// and by nothing else. Provenance decides what counts as remembering.
//
// Why three lines and not the day
// -------------------------------
// COGNITION's own rule is that the newest change matters more than the standing
// state, and a full day would be 13k characters competing with everything else.
// Three lines is enough to restore the thread — "what was I in the middle of" —
// which is the thing a wake actually loses.

import fs from "node:fs";
import path from "node:path";

const DIARY_HEAD = "## 自己的话";
const MAX_LINES = 3;
const MAX_LINE_CHARS = 110;

// A morning wake is not the same event as a mid-conversation turn.
//
// Measured problems, both real:
//
// 1. 2026-11-06 morning: every wake from 00:00 to 01:55 carried COGNITION, a few
//    indexes, and ZERO characters of diary. She woke up each day having forgotten
//    the day before — not because the file was missing (31 entries existed) but
//    because three lines cannot reconstruct "what was I in the middle of".
//
// 2. Three lines is right for a live turn: the person in front of her matters
//    more than yesterday. It is wrong for the first wake after a night, when
//    yesterday IS the context and there is no person to attend to.
//
// So the size is chosen by why she is awake, not by a constant. Kept modest even
// at the largest setting: the diary competes with COGNITION for the same window.
const WAKE_PROFILE = {
  // First wake of a new day, or a long gap: restore the thread.
  morning: { lines: 10, chars: 130 },
  // Ordinary turn while someone is talking.
  turn: { lines: MAX_LINES, chars: MAX_LINE_CHARS },
};

/**
 * Which profile fits this wake.
 *
 * `resume` is passed by the caller because only it knows the session history; a
 * gap in hours is inferred here from the diary file's own day.
 */
function profileFor(opts = {}) {
  if (opts.profile) return WAKE_PROFILE[opts.profile] ?? WAKE_PROFILE.turn;
  if (opts.morning === true) return WAKE_PROFILE.morning;
  return WAKE_PROFILE.turn;
}

function dayFile(workspaceDir, d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return path.join(workspaceDir, "memory", `${y}-${m}-${day}.md`);
}

function diaryOf(raw) {
  const idx = String(raw || "").indexOf(DIARY_HEAD);
  if (idx < 0) return "";
  return String(raw).slice(idx + DIARY_HEAD.length).replace(/^\n+/, "").trim();
}

/**
 * The last few things she wrote in her own section, from the most recent day
 * that has one.
 *
 * Walking backwards over days rather than only reading yesterday on purpose:
 * a quiet day produces no diary section, and "yesterday was empty" should not
 * mean "nothing to carry". The first day with content is the real yesterday.
 */
export function lastWritten(workspaceDir, { days = 3, now = new Date(), profile, morning, lines: lineCount, chars: charCount } = {}) {
  const prof = profileFor({ profile, morning });
  const wantLines = Number(lineCount ?? prof.lines);
  const wantChars = Number(charCount ?? prof.chars);
  for (let i = 1; i <= days; i++) {
    const d = new Date(now.getTime() - i * 86400000);
    const file = dayFile(workspaceDir, d);
    if (!fs.existsSync(file)) continue;
    let raw = "";
    try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
    const body = diaryOf(raw);
    if (!body) continue;

    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      // Machine lines and dialogue blocks are not her diary even inside the
      // section, if one ever leaks in.
      .filter((l) => !/\|\s*(fail|ok)\s*\|/.test(l))
      .filter((l) => !/^-\s*(对方|本鱼)\s*:/.test(l))
      .map((l) => l.replace(/^-\s*/, "").replace(/\s+/g, " ").trim())
      .filter((l) => l.length > 8);

    if (!lines.length) continue;
    return {
      day: `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      total: lines.length,
      lines: lines.slice(-wantLines).map((l) => (l.length > wantChars ? l.slice(0, wantChars) + "…" : l)),
    };
  }
  return null;
}

export function describe(workspaceDir, opts = {}) {
  const got = lastWritten(workspaceDir, opts);
  if (!got) return "";
  const more = got.total > got.lines.length
    ? `（昨天一共 ${got.total} 条，这里是你最后写的几条）`
    : "";
  return [
    `【${got.day} 你最后写的】`,
    ...got.lines.map((l) => `  · ${l}`),
    more,
    "不用接着做。只是别当成没发生过。",
  ].filter(Boolean).join("\n");
}
