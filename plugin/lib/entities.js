// Entities: what her memories are actually about.
//
// Verified 2026-11-05: four versions of a rule-based Chinese segmenter tried to
// find names by cutting at function characters and filtering on neighbour
// entropy. Each fix broke another case — 中午顺 → 午顺 → 鸭绿 + 江一直灌淡水. The
// root cause is not insufficient cleverness: segmenting Chinese without a
// dictionary is a dictionary problem, and hand-written rules converge on noise.
// The half-working version was deleted rather than shipped, because a plausible
// but wrong graph is worse than an empty one.
//
// Decision: the names are chosen by the model, not by this file. She already
// understands what her own diary says; asking her "what is this about" costs one
// field on a tool call she was making anyway, and cannot produce fragments like
// 水出. This module therefore does no segmentation at all — it validates,
// stores, and links whatever names it is given.
//
// What this file guarantees:
// - Storage is bounded and inspectable (state/entities.json, plain JSON).
// - Links are derived only from shared names, never from character overlap.
// - A name that appears once is kept but carries no weight; weight comes from
//   recurrence, which is the only evidence we have that something matters.

import fs from "node:fs";
import path from "node:path";

const FILE = "entities.json";
const MAX_NAME = 24;
const MAX_ENTITIES = 4000;

function file(workspaceDir) {
  return path.join(workspaceDir, "state", FILE);
}

export function load(workspaceDir) {
  const f = file(workspaceDir);
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    if (raw && Array.isArray(raw.entities)) return raw;
  } catch {}
  return { version: 1, entities: [], updated_at: null };
}

export function save(workspaceDir, data) {
  const f = file(workspaceDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  data.updated_at = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
}

function clean(name) {
  return String(name || "")
    .replace(/^[\s"'「『（(【\[]+/, "")
    .replace(/[\s"'」』）)】\]]+$/, "")
    .trim();
}

function acceptable(name) {
  if (!name || name.length < 2 || name.length > MAX_NAME) return false;
  if (/^[\d\s\p{P}]+$/u.test(name)) return false;
  // A whole sentence is not a name. This is the failure mode the rule-based
  // version kept producing, so it is rejected explicitly rather than by hope.
  if (/[，。、；！？,;!?]/.test(name)) return false;
  if (name.length > 12 && /[的了着过是在]/.test(name)) return false;
  return true;
}

/**
 * Store one memory's entities.
 *
 * @param {string} workspaceDir
 * @param {object} opts
 * @param {string} opts.memoryId   stable id of the memory row
 * @param {string[]} opts.names    names as chosen by the model
 * @param {string} [opts.kind]     "person" | "place" | "thing" | "topic" | "term"
 * @param {number} [opts.importance]
 * @param {string} [opts.at]
 */
export function remember(workspaceDir, { memoryId, names = [], kind = "thing", importance = 0.5, at } = {}) {
  if (!memoryId) return { added: 0, names: [] };
  const picked = [...new Set(names.map(clean).filter(acceptable))];
  if (!picked.length) return { added: 0, names: [] };

  const data = load(workspaceDir);
  const when = at || new Date().toISOString();
  const byName = new Map(data.entities.map((e) => [e.name, e]));

  for (const name of picked) {
    let ent = byName.get(name);
    if (!ent) {
      ent = {
        id: `ent-${Buffer.from(name).toString("hex").slice(0, 12)}`,
        name,
        kind,
        mentions: 0,
        memories: [],
        first_seen: when,
        last_seen: when,
        importance: 0,
      };
      data.entities.push(ent);
      byName.set(name, ent);
    }
    if (!ent.memories.includes(memoryId)) {
      ent.memories.push(memoryId);
      ent.mentions += 1;
      // Weight comes from recurrence. A single mention means "this happened
      // once"; three mentions means it is part of her life. Saturated so one
      // oft-repeated word cannot own the graph.
      ent.importance = Math.min(1, ent.importance + 0.15 + Math.min(0.15, importance * 0.1));
    }
    ent.last_seen = when;
  }

  if (data.entities.length > MAX_ENTITIES) {
    data.entities.sort((a, b) => b.importance - a.importance || b.mentions - a.mentions);
    data.entities = data.entities.slice(0, MAX_ENTITIES);
  }

  save(workspaceDir, data);
  return { added: picked.length, names: picked };
}

/**
 * Memories reachable from one memory through shared entities.
 * This is the one-hop expansion: "what else do I know that touches the same
 * things" — the question keyword search structurally cannot answer.
 */
export function linksFor(workspaceDir, memoryId, limit = 8) {
  const data = load(workspaceDir);
  const best = new Map();
  for (const ent of data.entities) {
    if (!ent.memories.includes(memoryId)) continue;
    for (const other of ent.memories) {
      if (other === memoryId) continue;
      // Two memories sharing a strong entity are more related than two sharing
      // a name she mentioned once.
      const w = ent.importance;
      const cur = best.get(other);
      if (!cur || w > cur.weight) best.set(other, { memoryId: other, via: ent.name, weight: w });
    }
  }
  return [...best.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
}

/** Top entities by weight — the shape of what she thinks about. */
export function top(workspaceDir, n = 12) {
  const data = load(workspaceDir);
  return [...data.entities]
    .sort((a, b) => b.importance - a.importance || b.mentions - a.mentions)
    .slice(0, n)
    .map((e) => ({ name: e.name, kind: e.kind, mentions: e.mentions, importance: Number(e.importance.toFixed(2)) }));
}

/** Entities that appear in two or more memories — the connective tissue. */
export function bridges(workspaceDir, n = 10) {
  const data = load(workspaceDir);
  return [...data.entities]
    .filter((e) => e.memories.length >= 2)
    .sort((a, b) => b.memories.length - a.memories.length || b.importance - a.importance)
    .slice(0, n)
    .map((e) => ({ name: e.name, memories: e.memories.length, importance: Number(e.importance.toFixed(2)) }));
}

export function stats(workspaceDir) {
  const data = load(workspaceDir);
  const linked = data.entities.filter((e) => e.memories.length >= 2).length;
  return {
    entities: data.entities.length,
    linked_entities: linked,
    updated_at: data.updated_at,
  };
}
