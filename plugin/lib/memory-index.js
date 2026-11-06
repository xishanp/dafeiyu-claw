// Memory index over <workspace>/memory/**.md
// Builds an in-memory inverted index, persisted to state/memory-index.json.
// Handles Chinese via bigrams, so 「吃什么」 finds 「白米饭」 through synonyms
// and 「火锅」 finds 「火锅」 directly.

import fs from "node:fs";
import path from "node:path";
import { tokenize, expandQuery, score, idf, normalizeQuery } from "./text.js";

const INDEX_VERSION = 2;
const MAX_LINE_CHARS = 400;

function walk(dir, out, depth = 0) {
  if (depth > 4) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(p, out, depth + 1);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(p);
    }
  }
  return out;
}

function readLines(file, root) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rel = path.relative(root, file);
  const out = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.length > MAX_LINE_CHARS) return; // skip huge blobs, they poison matching
    out.push({
      file: rel,
      line: i + 1,
      text: line.length > 300 ? line.slice(0, 300) + "…" : line,
      raw: line,
    });
  });
  return out;
}

/** Parse our own fact line format: "- ISO | about: X | importance: 0.8 | text" */
function parseMeta(raw) {
  const meta = { about: null, importance: 0.5, at: null, body: raw.replace(/^[-*]\s*/, "") };
  const iso = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/.exec(meta.body);
  if (iso) {
    meta.at = iso[1];
    meta.body = meta.body.slice(iso[1].length).replace(/^\s*\|\s*/, "");
  }
  const about = /about:\s*([^|]+)/.exec(meta.body);
  if (about) {
    meta.about = about[1].trim();
    meta.body = meta.body.replace(/\|\s*about:[^|]+/, "").trim();
  }
  const imp = /importance:\s*([\d.]+)/.exec(meta.body);
  if (imp) {
    const n = Number(imp[1]);
    if (Number.isFinite(n)) meta.importance = Math.min(1, Math.max(0, n));
    meta.body = meta.body.replace(/\|\s*importance:[\d.]+/, "").trim();
  }
  meta.body = meta.body.replace(/^\|\s*/, "").replace(/\s*\|\s*$/, "").trim();
  return meta;
}

export function buildIndex(workspaceDir) {
  const memoryDir = path.join(workspaceDir, "memory");
  const files = walk(memoryDir, []);
  const docs = [];
  const df = new Map();

  for (const file of files) {
    for (const rec of readLines(file, workspaceDir)) {
      // Skip our own noise lines: pure timestamp/status rows from the daily log.
      const bare = rec.raw.replace(/^[-*]\s*/, "");
      if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*\|\s*(local|feishu|openclaw-weixin|webchat|telegram|qq)\s*\|/.test(bare)) {
        continue;
      }
      const meta = parseMeta(rec.raw);
      const toks = tokenize(`${meta.body} ${meta.about || ""} ${rec.file}`);
      if (!toks.size) continue;
      const docId = docs.length;
      docs.push({ id: docId, ...rec, meta, toks });
      for (const t of toks.keys()) df.set(t, (df.get(t) || 0) + 1);
    }
  }

  return {
    version: INDEX_VERSION,
    built_at: new Date().toISOString(),
    total: docs.length,
    files: files.map((f) => path.relative(workspaceDir, f)),
    // Persisted form uses plain objects, not Maps.
    docs: docs.map((d) => ({
      file: d.file, line: d.line, text: d.text, raw: d.raw,
      meta: d.meta, toks: Object.fromEntries(d.toks),
    })),
    df: Object.fromEntries(df),
  };
}

export function loadIndex(workspaceDir, { rebuildIfStale = true } = {}) {
  const file = path.join(workspaceDir, "state", "memory-index.json");
  let idx = null;
  try {
    idx = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    idx = null;
  }
  if (idx && idx.version === INDEX_VERSION) {
    return { file, index: hydrate(idx), stale: isStale(workspaceDir, idx) };
  }
  if (!rebuildIfStale) return { file, index: null, stale: true };
  const fresh = buildIndex(workspaceDir);
  saveIndex(file, fresh);
  return { file, index: hydrate(fresh), stale: false };
}

function hydrate(idx) {
  return {
    ...idx,
    docs: idx.docs.map((d) => ({ ...d, toks: new Map(Object.entries(d.toks || {})) })),
    df: new Map(Object.entries(idx.df || {})),
  };
}

export function dehydrate(idx) {
  return {
    ...idx,
    docs: idx.docs.map((d) => ({ ...d, toks: Object.fromEntries(d.toks) })),
    df: Object.fromEntries(idx.df),
  };
}

export function saveIndex(file, idx) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const plain = idx.docs && idx.docs[0] && idx.docs[0].toks instanceof Map ? dehydrate(idx) : idx;
  fs.writeFileSync(tmp, JSON.stringify(plain) + "\n");
  fs.renameSync(tmp, file);
}

function isStale(workspaceDir, idx) {
  if (!idx.built_at) return true;
  const built = Date.parse(idx.built_at);
  const memoryDir = path.join(workspaceDir, "memory");
  for (const f of walk(memoryDir, [])) {
    try {
      if (fs.statSync(f).mtimeMs > built) return true;
    } catch {}
  }
  return false;
}

/**
 * Search the index.
 * Returns scored hits with recency and importance boosting.
 */
export function search(workspaceDir, query, opts = {}) {
  const { limit = 8, about = null, minScore = 0.06 } = opts;
  const { file, index, stale } = loadIndex(workspaceDir);

  if (stale) {
    const fresh = buildIndex(workspaceDir);
    saveIndex(file, fresh);
    return searchWith(hydrate(fresh), query, { limit, about, minScore, rebuilt: true });
  }
  return searchWith(index, query, { limit, about, minScore, rebuilt: false });
}

function searchWith(index, query, { limit, about, minScore, rebuilt }) {
  if (!index || !index.total) return { hits: [], rebuilt, total: 0 };
  const normalized = normalizeQuery(query);
  const originalTokens = tokenize(normalized);
  const qTokens = expandQuery(originalTokens, normalized);
  const now = Date.now();

  const hits = [];
  for (const doc of index.docs) {
    if (about && doc.meta?.about && doc.meta.about !== about) continue;
    let s = score(qTokens, doc.toks, index.df, index.total, {
      raw: doc.raw,
      queryText: String(query || "").trim(),
      originalTokens,
      docKeys: doc.keysCache,
    });
    if (s < minScore) continue;

    // Recency: newer facts matter more, but never zero out old ones.
    const at = doc.meta?.at ? Date.parse(doc.meta.at) : null;
    if (at && Number.isFinite(at)) {
      const days = Math.max(0, (now - at) / 86400000);
      s *= 0.75 + 0.25 * Math.exp(-days / 90);
    }
    // Importance boost.
    const imp = typeof doc.meta?.importance === "number" ? doc.meta.importance : 0.5;
    s *= 0.8 + 0.4 * imp;

    hits.push({ score: s, ...doc });
  }

  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, limit), rebuilt, total: index.total };
}
