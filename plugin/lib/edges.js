// 边的表 — what connects to what, and under what condition.
//
// Why a separate file from experience/graph
// -----------------------------------------
// LINGSHU (FuRongJun-1999/dsh-memory) states the thesis in md_cg/chain.py:1-17:
//
//     「因果链就是条件链」
//     causal = 条件依赖因果：A 是 B 成立的条件（B 依赖 A 成立）
//     方向 = 依赖方向（基础 → 应用）
//
// and then the line that makes it usable rather than decorative:
//
//     每步标注条件，链 = 条件序列
//
// That is the whole idea. An edge is not "these two are related" — it is
// "A is a condition for B". Without the condition an edge is a co-occurrence
// and carries no inference. With it, a chain of edges is an answer to
// "under what circumstances does this happen".
//
// So every edge in this file MUST carry a `condition`. When nobody wrote one,
// the edge stores an empty string and every reader is required to render it as
// 未声明 rather than silently defaulting. chain.py:132 (`edge_condition`) does
// the same and explains why: a default would make an unwritten condition look
// like a deliberate one.
//
// What this file deliberately does NOT copy
// -----------------------------------------
// chain.py is a traversal engine over a graph that already exists (573 lines,
// including DFS with budgets, reverse adjacency, Pareto labels). We have no
// graph yet — copying the walker first would be validating an empty table.
// This file is the storage layer only: add, retire, list, lookup.
//
// The one traversal we do implement is `neighbours`, which is deliberately
// bounded and shallow. Deeper walking belongs to recall.js, which is built on
// top of this, not inside it.

import fs from "node:fs";
import path from "node:path";

// Relation types and their propagation weights.
//
// Copied from md_cg/chain.py:31-52 verbatim, including the ordering of the
// dict, because the numbers are the documented output of 激活引擎 v0.1 §14 and
// re-deriving them would be inventing evidence we do not have. Only the subset
// we actually use is kept: reference/correlational/cyclic/opposite are omitted
// on purpose, because chain.py:54-57 explains that weak undirected relations
// dilute a causal chain into "mentioned alongside", and we have no need for
// them yet.
const EDGE_WEIGHTS = {
  causal: 0.85,
  similar: 0.75,
  hierarchical: 0.7,
  part_of: 0.7,
  applies_to: 0.7,
  sequential: 0.6,
};

// chain.py:53 — the default set for retrieval: causal / sequential / applies_to.
// Same three, same reasoning: "有语义方向" relations only.
const DEFAULT_TYPES = ["causal", "sequential", "applies_to"];

const DEFAULT_EDGE_WEIGHT = 0.5;

// chain.py uses max_depth=5 for walking. We are not walking (that is recall),
// but the same number bounds how many edges one node may accumulate per
// consolidation pass, which is the equivalent runaway risk at write time.
const MAX_EDGES_PER_PASS = 5;

// Hard ceiling on the table. 6000 edges at ~120 bytes each is under 1 MB, and
// anything past this is a runaway loop rather than a growing memory.
const MAX_EDGES = 6000;

function edgesFile(workspaceDir) {
  return path.join(workspaceDir, "state", "edges.json");
}

function blank() {
  return { version: 1, edges: [] };
}

function load(workspaceDir) {
  try {
    const d = JSON.parse(fs.readFileSync(edgesFile(workspaceDir), "utf8"));
    return {
      version: 1,
      edges: Array.isArray(d?.edges) ? d.edges : [],
    };
  } catch {
    return blank();
  }
}

function save(workspaceDir, data) {
  const f = edgesFile(workspaceDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, f);
}

function normType(v) {
  const t = String(v || "").trim().toLowerCase();
  return EDGE_WEIGHTS[t] ? t : "applies_to";
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

/** chain.py:119 `edge_weight` — base × confidence, rounded, clamped to [0,1]. */
function weightOf(edge) {
  const base = EDGE_WEIGHTS[normType(edge?.type)] ?? DEFAULT_EDGE_WEIGHT;
  return Math.round(base * clamp01(edge?.confidence) * 1e6) / 1e6;
}

/**
 * Add one edge. Idempotent on (from, to, type): a second consolidation that
 * rediscovers the same relation reinforces it (seen++, confidence up a little)
 * instead of creating a parallel edge. chain.py does not need this because its
 * graph is written by a different pipeline; ours is written by a pass that runs
 * on a timer and will absolutely rediscover the same things.
 */
function add(workspaceDir, edge = {}) {
  const from = String(edge.from || "").trim();
  const to = String(edge.to || "").trim();
  if (!from || !to || from === to) return null;

  const type = normType(edge.type);
  // An empty condition is stored as "" and is meaningful: it says nobody wrote
  // one. Never substitute a guess here.
  const condition = String(edge.condition ?? "").trim().slice(0, 200);
  const data = load(workspaceDir);
  const now = new Date().toISOString();

  const dup = data.edges.find(
    (e) => e.from === from && e.to === to && e.type === type && !e.retired_at,
  );
  if (dup) {
    dup.seen = (dup.seen || 1) + 1;
    dup.last_at = now;
    // Reinforcement is capped below 1 so a repeatedly-rediscovered edge never
    // becomes more certain than a freshly verified one.
    dup.confidence = Math.min(0.95, clamp01(dup.confidence) + 0.05);
    if (condition && !dup.condition) dup.condition = condition;
    save(workspaceDir, data);
    return dup.id;
  }

  const rec = {
    id: `edge-${Date.parse(now).toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    from,
    to,
    type,
    condition,
    confidence: clamp01(edge.confidence ?? 1),
    seen: 1,
    at: now,
    last_at: now,
    source: String(edge.source || "").slice(0, 80) || null,
  };
  data.edges.push(rec);

  if (data.edges.length > MAX_EDGES) {
    // Retire-then-trim: keep live edges, drop the oldest already-retired ones.
    // Never silently discard a live edge to make room — that would lose a real
    // relation to save a byte, which is the opposite of what this table is for.
    const live = data.edges.filter((e) => !e.retired_at);
    const dead = data.edges.filter((e) => e.retired_at);
    data.edges = [...live, ...dead.slice(-Math.floor(MAX_EDGES * 0.1))];
  }

  save(workspaceDir, data);
  return rec.id;
}

/**
 * Retire, never delete.
 *
 * chain.py:164 `adjacency(skip_archived=True)` does exactly this — a retired
 * node keeps existing and can be restored, it is only excluded from traversal.
 * Same contract here: `retired_at` is a marker, the row stays readable.
 */
function retire(workspaceDir, id, reason = "") {
  const data = load(workspaceDir);
  const e = data.edges.find((x) => x.id === id);
  if (!e || e.retired_at) return false;
  e.retired_at = new Date().toISOString();
  if (reason) e.retire_reason = String(reason).slice(0, 120);
  save(workspaceDir, data);
  return true;
}

/** Live edges touching `node`, optionally filtered by direction and type. */
function neighbours(workspaceDir, node, opts = {}) {
  const id = String(node || "").trim();
  if (!id) return [];
  const dir = opts.direction === "in" || opts.direction === "out" ? opts.direction : "both";
  const types = Array.isArray(opts.types) && opts.types.length
    ? opts.types.map(normType)
    : null;
  const limit = Math.max(1, Math.min(Number(opts.limit) || 20, 100));

  return load(workspaceDir)
    .edges.filter((e) => {
      if (e.retired_at) return false;
      if (types && !types.includes(e.type)) return false;
      if (dir === "out") return e.from === id;
      if (dir === "in") return e.to === id;
      return e.from === id || e.to === id;
    })
    .sort((a, b) => weightOf(b) - weightOf(a))
    .slice(0, limit);
}

/** Everything pointing at `to`, for "why does this hold". */
function conditionsFor(workspaceDir, node, limit = 10) {
  return neighbours(workspaceDir, node, { direction: "in", types: DEFAULT_TYPES, limit })
    .map((e) => ({
      from: e.from,
      type: e.type,
      condition: e.condition || "",
      weight: weightOf(e),
    }));
}

/**
 * Render edges for a prompt.
 *
 * chain.py:353 `explain` renders where a condition is missing as 「（未声明条件）」
 * rather than omitting it. We keep that: an edge with an unwritten condition is
 * still evidence that a link exists, and hiding the gap would make the whole
 * table look better-evidenced than it is.
 */
function describe(workspaceDir, node, limit = 6) {
  const list = neighbours(workspaceDir, node, { limit });
  if (!list.length) return "";
  const lines = list.map((e) => {
    const cond = e.condition ? `条件是：${e.condition}` : "（未声明条件）";
    return `  · ${e.from} →[${e.type}] ${e.to}　${cond}`;
  });
  return ["【这些事之间的牵连】", ...lines].join("\n");
}

function stats(workspaceDir) {
  const { edges } = load(workspaceDir);
  const live = edges.filter((e) => !e.retired_at);
  const byType = {};
  for (const e of live) byType[e.type] = (byType[e.type] || 0) + 1;
  return {
    total: edges.length,
    live: live.length,
    retired: edges.length - live.length,
    byType,
    withoutCondition: live.filter((e) => !e.condition).length,
  };
}

/**
 * Group live edges by condition.
 *
 * Why not just list the edges: measured 2026-11-04, the table held 7 edges of
 * which 6 shared the condition 「自主意识」and pointed from the same source. A raw
 * dump is six near-identical lines that look like noise, and noise gets
 * skipped, which is worse than not injecting at all.
 *
 * Grouped, the same data says something a single edge cannot: *this subject came
 * up six separate times*. That is the shape of a thing worth knowing — a topic
 * that keeps returning — and it is exactly what the character said would make
 * the whole system useful (「想不起来的事被拱出来」).
 *
 * Only groups with >= 2 members are returned. A lone edge is a mention, not a
 * pattern, and dressing it up as a cluster would inflate weak evidence.
 */
function clusters(workspaceDir, opts = {}) {
  const minSize = Math.max(2, Number(opts.minSize) || 2);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 3, 8));
  const { edges } = load(workspaceDir);
  const live = edges.filter((e) => !e.retired_at && e.condition);

  const groups = new Map();
  for (const e of live) {
    const key = e.condition;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const out = [];
  for (const [condition, list] of groups) {
    if (list.length < minSize) continue;
    // Collect the distinct nodes this condition touches, minus the shared
    // source, so the count reflects separate facts rather than the same fact
    // counted once per edge.
    const froms = new Set(list.map((e) => e.from));
    const tos = new Set(list.map((e) => e.to));
    const sharedSource = froms.size === 1 ? [...froms][0] : null;
    const nodes = [...new Set([...froms, ...tos])].filter((n) => n !== sharedSource);
    out.push({
      condition,
      size: list.length,
      nodes,
      types: [...new Set(list.map((e) => e.type))],
    });
  }

  return out.sort((a, b) => b.size - a.size).slice(0, limit);
}

/**
 * Render clusters for a prompt.
 *
 * Wording matters here. The line must say what the data actually supports:
 * “this subject came up N times”, not “these things are related” — the edges
 * are `similar`, which only claims a shared subject, and a stronger phrasing
 * would be an inference the table cannot back.
 *
 * Returns "" when nothing reached the cluster threshold. Same rule as
 * consolidate.describe: an empty heading teaches the reader that headings mean
 * nothing.
 */
function describeClusters(workspaceDir, opts = {}) {
  let groups;
  try {
    groups = clusters(workspaceDir, opts);
  } catch {
    return "";
  }
  if (!groups.length) return "";

  const lines = groups.map((g) => {
    const kind = g.types.length === 1 && g.types[0] === "similar" ? "同一个话题" : "连着";
    return `  · 「${g.condition}」——${kind}，前后碰上 ${g.size} 次`;
  });
  return [
    "【回头碰上的事】",
    ...lines,
    "不是要你现在做什么。只是这几件事反复出现，你心里有个数。",
  ].join("\n");
}

export {
  EDGE_WEIGHTS,
  DEFAULT_TYPES,
  DEFAULT_EDGE_WEIGHT,
  MAX_EDGES_PER_PASS,
  MAX_EDGES,
  edgesFile,
  load,
  save,
  weightOf,
  add,
  retire,
  neighbours,
  conditionsFor,
  describe,
  clusters,
  describeClusters,
  stats,
  normType,
};
