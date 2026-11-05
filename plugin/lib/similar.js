// Character n-gram similarity: a second retrieval path that needs no embedding.
//
// There is no embedding provider configured on this machine (checked
// 2026-11-05: workbuddy and litellm both answer "not proxied" for
// /v1/embeddings), so true semantic search is unavailable. That does not mean
// recall has to stay limited to exact keyword matching. Character n-grams
// capture a real signal that BM25 misses: two passages using different words for
// the same thing still share most of their character sequences, because Chinese
// builds related meanings from overlapping morphemes.
//
// What this is not: it does not understand. Two sentences making the same point
// with different vocabulary may share only a common character or two, and this
// will miss that. It is a cheap improvement over nothing, and it is honest about
// what it does.
//
// The implementation deliberately avoids per-call index building. Her corpus is
// around 100 KB today; at that size a scan is fast, but recomputing n-grams on
// every recall would still be wasteful during a burst of tool calls. Gram sets
// are cached by file mtime so an unchanged diary costs nothing.

import fs from "node:fs";
import path from "node:path";

// Bigrams turned out to be too strict for this corpus. Measured on a live
// install: a multi-character query scored 0.087 against the diary line that
// contains those same characters separately, because the terms never appear
// adjacent. Trigrams scored 0. Unigrams scored 0.306 and found the right line.
//
// So we mix both and weight unigrams lower. Unigrams alone match almost any
// Chinese sentence through common characters (的, 是, 一)； bigrams alone miss
// paraphrases. Together they behave like a lenient keyword match, which is
// exactly the gap BM25 leaves when word order differs.
const WEIGHTS = [0.4, 0.6]; // index 0 = unigram, 1 = bigram
const CACHE = new Map();

function grams(text) {
  const s = String(text || "")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "")
    .toLowerCase();
  const out = new Map();
  for (let n = 1; n <= 2; n++) {
    for (let i = 0; i <= s.length - n; i++) {
      // Prefix by n so "的" (unigram) and "的确" (bigram) do not collide.
      const g = `${n}:${s.slice(i, i + n)}`;
      out.set(g, (out.get(g) || 0) + 1);
    }
  }
  return out;
}

function cosine(a, b) {
  if (!a.size || !b.size) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [g, ca] of a) {
    na += ca * ca;
    const cb = b.get(g);
    if (cb) dot += ca * cb;
  }
  for (const cb of b.values()) nb += cb * cb;
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

function listDocs(workspaceDir) {
  const dir = path.join(workspaceDir, "memory");
  const docs = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return docs;
  }
  for (const name of names) {
    const f = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    const key = `${f}:${st.mtimeMs}`;
    let entry = CACHE.get(key);
    if (!entry) {
      let raw = "";
      try {
        raw = fs.readFileSync(f, "utf8");
      } catch {}
      // One doc per non-trivial line, so a hit points at a sentence rather than
      // a whole day. A day-sized doc would score high on almost any query that
      // shares one topic and bury the specific line.
      const lines = raw
        .split("\n")
        .map((l) => l.replace(/^\s*-?\s*/, "").trim())
        .filter((l) => l.length >= 8 && !/^#/.test(l));
      entry = {
        file: f,
        name,
        lines: lines.map((text, i) => ({ text, grams: grams(text), i })),
      };
      CACHE.delete(key);
      CACHE.set(key, entry);
      if (CACHE.size > 64) CACHE.delete(CACHE.keys().next().value);
    }
    docs.push(entry);
  }
  return docs;
}

/**
 * Rank her own writing against a query by character overlap.
 *
 * @param {string} workspaceDir
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {number} [opts.minScore]  below this the match is noise
 * @returns {Array<{text,file,line,score}>}
 */
export function search(workspaceDir, query, { limit = 6, minScore = 0.18 } = {}) {
  const q = grams(query);
  if (!q.size) return [];
  const hits = [];
  for (const doc of listDocs(workspaceDir)) {
    for (const line of doc.lines) {
      const s = cosine(q, line.grams);
      if (s < minScore) continue;
      hits.push({ text: line.text, file: doc.name, line: line.i, score: Number(s.toFixed(3)) });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  // One hit per distinct sentence: the same sentence can appear in two docs
  // after a copy-paste, and showing it twice wastes a slot.
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const k = h.text.slice(0, 40);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

export function stats(workspaceDir) {
  const docs = listDocs(workspaceDir);
  return {
    docs: docs.length,
    lines: docs.reduce((s, d) => s + d.lines.length, 0),
    cache: CACHE.size,
  };
}
