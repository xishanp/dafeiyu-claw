// 固化 — turning "it happened" into "this is now known".
//
// The gap this fills
// ------------------
// experience.js:5 says the pool exists so a new entry "waits for a reflection
// pass to either promote or drop it". index.js:2002 / :2036 / :2809 all refer to
// "the same reflection pass". Measured on 2026-11-04:
//
//     state/experience-pool.json
//       entries:              47   (kept 25 / dropped 22)
//       last_reflected_at:    null  ← never written by anything
//     grep last_reflected_at lib/ index.js
//       experience.js:27   read
//       experience.js:30   default value
//       — no writer anywhere
//
// So the pass was designed, named in three comments, and never built. The pool
// has been accumulating for days. `kept` and `dropped` are a judgement that
// never reaches anything: nothing is distilled, nothing is connected.
//
// What this does
// --------------
// Reads kept-but-unconsolidated entries, distils each into one fact line, and
// records the edges between them where a relation is actually visible. Then
// advances `last_reflected_at` so the next pass starts from there.
//
// What this refuses to do
// -----------------------
//   · It never writes memory/facts/self.md — that file is hers to write. This
//     writes only facts/learned.md, which is machine-owned and labelled so.
//   · It never deletes a pool entry. chain.py:164 retires rather than removes,
//     and the same rule applies: the raw experience stays traceable.
//   · It never invents an edge. `condition` is empty unless the entry itself
//     stated one. edges.js renders empty as 未声明 rather than guessing.
//   · It never runs when there is nothing new. An idle pass writes nothing at
//     all — not an empty section, not a touched timestamp.

import fs from "node:fs";
import path from "node:path";

import * as experience from "./experience.js";
import * as edges from "./edges.js";

// Bounded so one pass can never flood the prompt.
const MAX_PER_PASS = 5;

// A fact line longer than this is not a fact, it is the experience again.
const MAX_FACT_CHARS = 110;

const LEARNED_HEADING = "# 想明白的事（机器整理，不是她自己写的）";
const REJECTED_HEADING = "## 推翻过的";

function learnedFile(workspaceDir) {
  return path.join(workspaceDir, "memory", "facts", "learned.md");
}

function readLearned(workspaceDir) {
  try {
    return fs.readFileSync(learnedFile(workspaceDir), "utf8");
  } catch {
    return "";
  }
}

function writeLearned(workspaceDir, text) {
  const f = learnedFile(workspaceDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/**
 * Distil one experience into a single line.
 *
 * The rule: keep what would still be true tomorrow, drop what only describes
 * the moment. `resolve_note` is the highest-value input — it is the sentence
 * where she said why this mattered, which is exactly the reusable part.
 *
 * Returns "" when nothing survives, in which case the entry is still marked
 * consolidated (so it is not retried forever) but produces no fact.
 */
function distill(entry) {
  const note = String(entry.resolve_note || "").trim();
  const what = String(entry.what || "").trim();

  const source = note || what;
  if (!source) return "";

  // Strip the framing words that make a note unreadable once out of context.
  // Only whole words: an earlier version used `^(就是|这|那)` and truncated
  // 「这句话本鱼认」into 「句本鱼认」, eating the first character of a word that
  // was carrying meaning. 这/那 alone are too short to strip safely.
  let line = source
    .replace(/^(就是|这个|那个|这件事|那件事|当时)\s*/, "")
    .replace(/\s+/g, "")
    .replace(/[。；;]+$/, "")
    .trim();

  if (!line) return "";
  return line.length > MAX_FACT_CHARS ? `${line.slice(0, MAX_FACT_CHARS)}…` : line;
}

/**
 * Subjects named in the entry text, verbatim.
 *
 * Only things the text actually wrote: 「quoted」, @mentions, 《titles》. This is
 * the whole evidence base for linking — no stemming, no synonyms, no embedding
 * similarity. If two entries do not literally name the same subject, they are
 * not linked by this pass, however related they feel.
 */
function subjectsOf(entry) {
  const text = `${String(entry.what || "")}\n${String(entry.resolve_note || "")}`;
  const out = new Set();
  for (const m of text.matchAll(/「([^」]{2,20})」/g)) out.add(m[1].trim());
  for (const m of text.matchAll(/@([\w\u4e00-\u9fa5-]{1,20})/g)) out.add(`@${m[1]}`);
  for (const m of text.matchAll(/《([^》]{2,30})》/g)) out.add(m[1].trim().slice(0, 20));
  return [...out].filter(Boolean);
}

/**
 * Find an evidence-backed relation from this entry back to one already known.
 *
 * An earlier version of this function looked for `text.includes(other.gist)`.
 * That could never fire: `gist` is the first 18 characters of `what`, so it is
 * a truncated sentence fragment like 「对方说「自主意识」本鱼回了「画出来了」, which by
 * construction appears in its own entry and in no other. It reported zero edges
 * over 25 real entries, and because zero edges is also the correct answer on a
 * fresh table, the failure was invisible.
 *
 * What replaced it links on a **shared named subject** — the same 「term」,
 * @person or 《title》 appearing in both. The relation is `similar`, and the
 * condition is the subject itself, so the edge reads "these are about the same
 * thing, namely X". That is a fact about the text, not an inference about
 * causality, and it is the strongest claim this data can support.
 *
 * Causal and sequential links are still recognised, but only when the connective
 * is explicit and directly follows the subject. Anything vaguer returns nothing.
 */
function inferRelation(entry, known) {
  const mine = subjectsOf(entry);
  if (!mine.length) return null;

  const what = String(entry.what || "");

  for (const other of [...known].reverse()) {
    const theirs = subjectsOf(other);
    const shared = mine.find((s) => theirs.includes(s));
    if (!shared) continue;

    // Explicit connective right after the subject turns a shared-subject link
    // into something stronger. Both forms are checked on `what`, where the
    // narration actually lives, not on the distilled note.
    //
    // The skip-over matters: a subject is usually written in quotes, so the
    // character immediately after it is 」 or 」 or 」 rather than 所以. An earlier
    // version matched directly on the next characters and therefore recognised
    // no connectives at all whenever the subject was quoted, which is most of
    // the time — every link degraded silently to `similar`.
    const idx = what.indexOf(shared);
    const after = idx >= 0 ? what.slice(idx + shared.length) : "";
    const tail = after.replace(/^[\s」』》）)"”'’]+/, "").slice(0, 6);
    if (/^(所以|因此|于是|结果)/.test(tail)) {
      return { from: other.id, to: entry.id, type: "causal", condition: shared };
    }
    if (/^(之后|后来|然后|接着)/.test(tail)) {
      return { from: other.id, to: entry.id, type: "sequential", condition: shared };
    }

    return { from: other.id, to: entry.id, type: "similar", condition: shared };
  }
  return null;
}

/**
 * Run one consolidation pass.
 *
 * Returns a receipt describing what actually happened, because "ran without
 * error" and "did something" are different claims and the caller needs to tell
 * them apart:
 *
 *   { ran:false, reason:"nothing_new" }        — no kept entries waiting
 *   { ran:true, facts:2, edges:1, skipped:1 }  — what was actually written
 */
function pass(workspaceDir, opts = {}) {
  const at = opts.at || new Date().toISOString();
  const pool = experience.load(workspaceDir);

  // Selection is by `consolidated_at` alone, never by comparing timestamps
  // against `last_reflected_at`. An earlier version filtered on
  // `resolved_at > last_reflected_at`, which looked equivalent and was not:
  // the pass takes the last MAX_PER_PASS entries and then advances the marker
  // to now, so every entry it skipped was permanently older than the marker and
  // could never be selected again. The backlog froze at 20 out of 25 and no
  // error was raised anywhere. `consolidated_at` is per-entry and idempotent,
  // so it cannot have this failure.
  const waiting = pool.entries
    .filter((e) => e.status === "kept")
    .filter((e) => !e.consolidated_at)
    .slice(-MAX_PER_PASS);

  if (!waiting.length) {
    return { ran: false, reason: "nothing_new", facts: 0, edges: 0 };
  }

  // Known = everything consolidated before this pass, used as candidate anchors
  // for relations. Bounded to the recent tail; an edge to something from a month
  // ago would need real evidence, which we do not have.
  const known = pool.entries
    .filter((e) => e.consolidated_at && e.status === "kept")
    .slice(-20);

  const facts = [];
  const madeEdges = [];
  let skipped = 0;

  for (const entry of waiting) {
    const line = distill(entry);
    if (line) {
      facts.push({ id: entry.id, at: entry.resolved_at || entry.at, line });
    } else {
      skipped += 1;
    }

    const rel = inferRelation(entry, known);
    if (rel) {
      try {
        const id = edges.add(workspaceDir, { ...rel, source: entry.id });
        if (id) madeEdges.push(id);
      } catch { /* an edge failure must not lose the fact */ }
    }

    // Marked either way. A fact-less entry is still judged; retrying it every
    // pass forever would be a loop, not diligence.
    entry.consolidated_at = at;
  }

  if (facts.length) {
    const existing = readLearned(workspaceDir);
    const header = existing.trim()
      ? ""
      : [
          LEARNED_HEADING,
          "",
          "这一份不是本鱼自己写的。是把「发生过、并且决定留下」的事整理成的短句，",
          "按时间排。原文还在 state/experience-pool.json 里，这里只是提炼。",
          "",
          "",
        ].join("\n");

    const body = facts
      .map((f) => {
        const d = new Date(f.at);
        const stamp = Number.isNaN(d.getTime())
          ? ""
          : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return `- ${stamp} ${f.line}`;
      })
      .join("\n");

    const next = existing.trim()
      ? `${existing.trimEnd()}\n${body}\n`
      : `${header}${body}\n`;
    writeLearned(workspaceDir, next);
  }

  pool.last_reflected_at = at;
  experience.save(workspaceDir, pool);

  return {
    ran: true,
    reason: facts.length ? "distilled" : "no_fact_text",
    facts: facts.length,
    edges: madeEdges.length,
    skipped,
    at,
  };
}

/**
 * Overturn one distilled fact.
 *
 * Why this exists: COGNITION.md tells her 「觉得不对了，现在就能推翻」, and until
 * this function there was no way to do it — the promise was in the prompt and
 * nowhere in the code. A capability that is announced but absent is worse than
 * none, because it makes the character believe it has judgement while every
 * path it tries dead-ends.
 *
 * Semantics:
 *   · The line moves, it does not vanish. Rejected lines sit under
 *     「推翻过的」 with her reason, so the record shows that she once disagreed.
 *   · Injection reads only the live section, so an overturned line stops
 *     appearing without being destroyed.
 *   · `index` is 1-based over the live `- ` lines, which is what she can count
 *     from the prompt.
 */
function reject(workspaceDir, { index, reason = "", at = new Date().toISOString() } = {}) {
  const n = Number(index);
  if (!Number.isFinite(n) || n < 1) return { ok: false, error: "index 要从 1 数" };

  const text = readLearned(workspaceDir);
  if (!text.trim()) return { ok: false, error: "清单还是空的" };

  const lines = text.split("\n");
  const liveIdx = [];
  let inRejected = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === REJECTED_HEADING) inRejected = true;
    if (!inRejected && lines[i].startsWith("- ")) liveIdx.push(i);
  }

  if (n > liveIdx.length) {
    return { ok: false, error: `只有 ${liveIdx.length} 条，没有第 ${n} 条` };
  }

  const at_line = liveIdx[n - 1];
  const body = lines[at_line].slice(2).trim();
  lines.splice(at_line, 1);

  const note = String(reason || "").replace(/\s+/g, " ").trim().slice(0, 100);
  const entry = `- ~~${body}~~${note ? `　理由是：${note}` : ""}`;

  const rejIdx = lines.findIndex((l) => l.trim() === REJECTED_HEADING);
  if (rejIdx === -1) {
    lines.push("", REJECTED_HEADING, "", entry);
  } else {
    // Append at the end of the rejected block, keeping the section contiguous.
    let insertAt = lines.length;
    for (let i = rejIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("- ") || lines[i].trim() === "") insertAt = i + 1;
      else break;
    }
    lines.splice(insertAt, 0, entry);
  }

  writeLearned(workspaceDir, lines.join("\n"));
  return { ok: true, rejected: body.slice(0, 60), remaining: liveIdx.length - 1 };
}

/** How many live facts there are (the number she can index against). */
function liveCount(workspaceDir) {
  const text = readLearned(workspaceDir);
  let inRejected = false;
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === REJECTED_HEADING) inRejected = true;
    if (!inRejected && line.startsWith("- ")) n += 1;
  }
  return n;
}

/** What a prompt sees. Empty when nothing has ever been distilled. */
/**
 * What a prompt sees.
 *
 * Two problems with a plain `slice(-limit)`, both measured on 2026-11-04:
 *
 *   1. **It only ever shows today.** With 25 distilled facts written in one
 *      afternoon, the last 5 happened to all be about drawing, so the section
 *      read "everything I ever understood was about art". That is a sampling
 *      artifact presented as a memory.
 *
 *   2. **It grows without bound.** No char budget meant the section's size was
 *      a function of how long the lines were, not of what the prompt could
 *      afford.
 *
 * So: spread the picks across the whole timeline, always keep the newest one
 * (recent matters most), and stop at a char budget.
 */
const DESCRIBE_CHAR_BUDGET = 700;

function describe(workspaceDir, limit = 6) {
  const text = readLearned(workspaceDir);
  if (!text.trim()) return "";

  // Live section only. Everything under 「推翻过的」 must stop appearing the
  // moment it is overturned — including it here would make `fact_reject` look
  // like it did nothing, and a rejection the character can still see is not a
  // rejection. Verified by test: reject → describe must no longer contain it.
  let inRejected = false;
  const all = [];
  for (const line of text.split("\n")) {
    if (line.trim() === REJECTED_HEADING) inRejected = true;
    if (inRejected) continue;
    if (line.trim().startsWith("- ")) all.push(line);
  }
  if (!all.length) return "";

  // Temporal spread: walk the whole list at an even stride instead of taking
  // the tail. len <= limit keeps everything, so a short history is unaffected.
  let picked;
  if (all.length <= limit) {
    picked = all;
  } else {
    const stride = (all.length - 1) / (limit - 1);
    picked = [];
    for (let i = 0; i < limit - 1; i++) {
      picked.push(all[Math.round(i * stride)]);
    }
    // The newest line is always included and always last: "what I just worked
    // out" is the one most likely to be relevant to this turn.
    picked.push(all[all.length - 1]);
  }

  // Char budget, applied from the newest backwards so the most recent survive
  // a trim. Trimmed-off lines are dropped, not truncated mid-sentence.
  const kept = [];
  let used = 0;
  for (let i = picked.length - 1; i >= 0; i--) {
    const line = picked[i].trim();
    if (used + line.length + 1 > DESCRIBE_CHAR_BUDGET && kept.length) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  if (!kept.length) return "";

  const total = all.length;
  const shown = kept.length;
  const hint = total > shown ? `（共 ${total} 条，这里 ${shown} 条）` : "";
  return [`【想明白的事】${hint}`, ...kept].join("\n");
}

/** Count of kept entries not yet consolidated — the backlog. */
function backlog(workspaceDir) {
  const pool = experience.load(workspaceDir);
  return pool.entries.filter((e) => e.status === "kept" && !e.consolidated_at).length;
}

export { pass, describe, backlog, distill, inferRelation, subjectsOf, reject, liveCount, learnedFile, MAX_PER_PASS };
