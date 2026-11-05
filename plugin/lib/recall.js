// 想起来 — walking edges, backwards, when something makes you think of it.
//
// Where this sits
// ---------------
// edges.js stores "A is a condition for B". consolidate.js writes those edges
// while distilling experience. This file is the only one that *uses* them, and
// it is the reason the other two exist: an edge nobody ever walks is a note in a
// drawer.
//
// The model is chain.py:281 `walk` — depth-first over a bounded fan-out, every
// hop carrying its condition, resource budgets enforced, results ranked by
// accumulated strength rather than path length. Two deliberate differences:
//
//   1. **We walk IN, not OUT.** chain.py:11 walks forward along dependency
//      direction ("基础 → 应用") because it is answering "what follows from
//      this". We are answering "what made this the way it is", which is the
//      reverse. The reverse adjacency is trivial and the semantics are cleaner
//      than mixing both directions and guessing.
//
//   2. **max_depth is 2, not 5.** chain.py can afford 5 because its graph is
//      dense and hand-curated. Ours is sparse and timer-written; at depth 5 a
//      single wrong edge contaminates four more hops. Depth 2 answers "what led
//      to this" and "what led to that", which is as far as the evidence goes.
//
// Honest limit
// ------------
// This is not memory recall in the human sense and should not be described as
// such. It is a bounded reverse traversal of a small table of stated
// conditions. When the table is empty — which it is today — it returns nothing,
// and that is the correct answer, not a bug.

import * as edges from "./edges.js";

const MAX_DEPTH = 2;
const MAX_NODES = 24;
const MAX_RESULTS = 6;

// chain.py blends strength multiplicatively along the path. Same idea: a chain
// of two 0.5 edges is worth 0.25, which correctly loses to one 0.85 edge.
const DECAY = 0.85;

/**
 * Walk backwards from `node`, collecting the strongest simple paths.
 *
 * Returns `[{ nodes, weight, depth, conditions }]` sorted by weight, ties
 * broken toward the shorter path (Occam, but only as a tie-break — chain.py:23
 * notes it deliberately ranks by strength first for retrieval).
 */
function walkIn(workspaceDir, node, opts = {}) {
  const start = String(node || "").trim();
  if (!start) return [];

  const maxDepth = Math.max(1, Math.min(Number(opts.maxDepth) || MAX_DEPTH, MAX_DEPTH));
  const limit = Math.max(1, Math.min(Number(opts.limit) || MAX_RESULTS, MAX_RESULTS));
  const types = Array.isArray(opts.types) && opts.types.length ? opts.types : null;

  const results = [];
  let visitedCount = 0;

  // Explicit stack rather than recursion: depth is bounded at 2 but the node
  // budget is what actually stops us, and an explicit queue makes that visible.
  const stack = [{ node: start, path: [start], weight: 1, conditions: [] }];

  while (stack.length) {
    const cur = stack.pop();
    if (cur.path.length - 1 >= maxDepth) continue;
    if (visitedCount >= MAX_NODES) break;

    let incoming;
    try {
      incoming = edges.neighbours(workspaceDir, cur.node, {
        direction: "in",
        types,
        limit: 12,
      });
    } catch {
      break;
    }

    for (const e of incoming) {
      visitedCount += 1;
      if (visitedCount >= MAX_NODES) break;

      // Simple paths only. A cycle in a memory graph is a contradiction, and
      // following it would produce the same node twice at decreasing weight.
      if (cur.path.includes(e.from)) continue;

      const w = Math.round(cur.weight * edges.weightOf(e) * DECAY * 1e6) / 1e6;
      const path = [...cur.path, e.from];
      const conditions = [...cur.conditions, { from: e.from, to: e.to, condition: e.condition || "" }];

      results.push({ nodes: path, weight: w, depth: path.length - 1, conditions });

      if (path.length - 1 < maxDepth) {
        stack.push({ node: e.from, path, weight: w, conditions });
      }
    }
  }

  return results
    .sort((a, b) => (b.weight - a.weight) || (a.depth - b.depth))
    .slice(0, limit);
}

/**
 * Render a recall result for a prompt.
 *
 * Every hop's condition is printed. An edge whose condition was never written
 * shows as 未声明 rather than being dropped, so the reader can tell "linked but
 * unexplained" from "not linked at all".
 */
function render(results) {
  if (!results?.length) return "";
  const lines = [];
  for (const r of results) {
    const chain = [...r.nodes].reverse().join(" → ");
    const conds = r.conditions
      .filter((c) => c.condition)
      .map((c) => c.condition);
    const condText = conds.length ? `（因为：${conds.join("；")}）` : "（未声明条件）";
    lines.push(`  · ${chain}${condText}`);
  }
  return ["【想到这个，是连着这些的】", ...lines].join("\n");
}

/**
 * Convenience: recall straight to a prompt string.
 *
 * Returns "" when there is nothing — an empty section in the prompt is worse
 * than no section, because it teaches the reader that the heading means nothing.
 */
function describe(workspaceDir, node, opts = {}) {
  try {
    return render(walkIn(workspaceDir, node, opts));
  } catch {
    return "";
  }
}

export { walkIn, render, describe, MAX_DEPTH, MAX_NODES, MAX_RESULTS, DECAY };
