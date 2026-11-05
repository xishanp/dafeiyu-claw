// 自我状态 — a thin, durable answer to "what am I right now".
//
// Why this file exists
// --------------------
// The prompt can say "remember who you are" and the model will nod and forget
// by the next turn. Personality is not a prompt problem: every turn starts
// blank. Two independent implementations converged on the same shape:
//
//   lingshu  md_cg/self_state.py  — "薄自我 + 富索引": the SELF layer holds ONE
//                                   state card plus relation nodes; details stay
//                                   in their own layers and are pointed at.
//   dafeiyu  lib/personality-evolution.mjs:10 — five frozen traits, each only
//                                   {label, higher, lower}. No numbers to drift.
//
// Both refuse to let this layer become an event store. That refusal is the
// design: a fat self-state is just another log nobody reads. So this file
// holds nine numbers and a short list, and nothing else.
//
// The rule
// --------
//   feelings  → emotion.json   (fast, noisy, decays in minutes)
//   acts      → deeds.json     (what got said)
//   products  → effects.json   (what got made, with a verified ref)
//   THIS      → a reading of the above, recomputed, never a second copy
//
// Everything here is DERIVED. `refresh` recomputes from the source files, so
// a bug in this module cannot invent a state that the other ledgers disagree
// with. That is deliberate: the one thing a self-model must not do is lie
// about itself.
//
// What this file does NOT do
// --------------------------
// No prompt rewriting, no permission, no outbound action. It reads and
// summarizes. lingshu's metacognition.py states the same constraint
// ("只读留痕，不参与裁决") and dafeiyu's personality-evolution.mjs puts it in
// its header: "No public action, permissions, personaPrompt ... is modified."
// A self-state that can rewrite the character is not a self-state, it is a
// hijack.

import fs from "node:fs";
import path from "node:path";

import * as goalsLib from "./goals.js";

export function selfFile(workspaceDir) {
  return path.join(workspaceDir, "state", "self.json");
}

const MAX_IDENTITY = 240;
const MAX_STRUGGLES = 4;
const MAX_STRUGGLE_LEN = 60;
const STALE_DAYS = 2;
const DORMANT_DAYS = 7;

function isoNow() {
  return new Date().toISOString();
}

function dayKey(d) {
  return new Date(d).toLocaleDateString("en-CA");
}

function blank() {
  return {
    version: 1,
    updated_at: isoNow(),
    // The five things that answer "who am I" without a paragraph of prose.
    identity: {
      handles: "",        // what it calls itself and what the owner calls it
      days_alive: 0,      // since the workspace first had a deed
      first_seen: "",     // ISO day
    },
    // What it currently believes it is good at / bad at. Derived from counts,
    // never from self-report: saying "本鱼画画很好" does not make it true.
    ability: {
      produced_7d: 0,
      produced_30d: 0,
      said_7d: 0,
      // Ratio of real products to total acts. Low means all talk.
      output_ratio: 0,
    },
    // Directions it says it cares about, with how much they have actually moved.
    pursuits: [],
    // Open knots: things that are stuck, expired, or keep coming back.
    struggles: [],
    // Coarse phase, so the model has a word for where it is.
    phase: "steady",
    // One line of plain language, the only thing usually injected.
    line: "",
  };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function readJson(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object") return raw;
  } catch { /* missing or corrupt: treated as empty, never fatal */ }
  return null;
}

export function load(workspaceDir) {
  const raw = readJson(selfFile(workspaceDir));
  if (!raw || raw.version !== 1) return blank();
  // Whitelist on read. Unknown keys never come back, so a hand-edited or
  // foreign file cannot smuggle fields into the prompt.
  const b = blank();
  return {
    version: 1,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : b.updated_at,
    identity: {
      handles: String(raw.identity?.handles ?? "").slice(0, MAX_IDENTITY),
      days_alive: Math.max(0, Math.floor(Number(raw.identity?.days_alive) || 0)),
      first_seen: /^\d{4}-\d\d-\d\d$/.test(raw.identity?.first_seen ?? "")
        ? raw.identity.first_seen
        : "",
    },
    ability: {
      produced_7d: Math.max(0, Math.floor(Number(raw.ability?.produced_7d) || 0)),
      produced_30d: Math.max(0, Math.floor(Number(raw.ability?.produced_30d) || 0)),
      said_7d: Math.max(0, Math.floor(Number(raw.ability?.said_7d) || 0)),
      output_ratio: clamp01(raw.ability?.output_ratio),
    },
    pursuits: Array.isArray(raw.pursuits)
      ? raw.pursuits.slice(0, 8).map((p) => ({
        id: String(p?.id ?? "").slice(0, 40),
        title: String(p?.title ?? "").slice(0, 40),
        value: clamp01(p?.value),
      })).filter((p) => p.id && p.title)
      : [],
    struggles: Array.isArray(raw.struggles)
      ? raw.struggles.slice(0, MAX_STRUGGLES)
        .map((s) => String(s ?? "").replace(/[\r\n]/g, " ").trim().slice(0, MAX_STRUGGLE_LEN))
        .filter(Boolean)
      : [],
    phase: ["steady", "productive", "stuck", "dormant"].includes(raw.phase)
      ? raw.phase
      : "steady",
    line: String(raw.line ?? "").slice(0, 200),
  };
}

function save(workspaceDir, data) {
  const file = selfFile(workspaceDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------ readings

function countProductions(entries, sinceMs) {
  return entries.filter((e) => {
    if (!e || e.verified !== true) return false;
    const at = Date.parse(e.at ?? "");
    return Number.isFinite(at) && at >= sinceMs;
  }).length;
}

function countSaid(deeds, sinceMs) {
  const rows = Array.isArray(deeds?.entries) ? deeds.entries : [];
  return rows.filter((e) => {
    const at = Date.parse(e?.at ?? "");
    return Number.isFinite(at) && at >= sinceMs;
  }).length;
}

// Which pursuits exist and how much each has moved.
//
// `emotion.json` holds the aspiration values; they rise when that direction
// produces something and fall when it is abandoned (see workspace.js:145 on
// why the LOW one is the starving one). We surface the value as-is and let the
// reader decide — renaming it to "hunger" would be an interpretation this
// layer has no standing to make.
function readPursuits(goals) {
  const rows = Array.isArray(goals?.aspirations) ? goals.aspirations : [];
  return rows
    .map((a) => ({
      id: String(a?.id ?? "").slice(0, 40),
      value: clamp01(a?.value),
      title: String(a?.title ?? "").slice(0, 40),
    }))
    .filter((p) => p.id && p.title)
    .sort((a, b) => a.value - b.value);
}

// Mirrors ASPIRATIONS in lib/goals.js. Titles come from the file at runtime;
// this map only exists so the rendered line reads like speech rather than an id.
const PURSUIT_CN = {
  self_understanding: "弄明白自己是怎么运作的",
  world_knowledge: "把世界看得更清楚",
  genuine_contact: "跟人真正连上",
  output_producing: "做出以前没有的东西",
};

function cnTitle(p) {
  return PURSUIT_CN[p.id] || p.title || p.id;
}

// Open knots. Only three sources, all checkable:
//   goal that has not moved in STALE_DAYS
//   a topic older than STALE_DAYS
//   a day with zero production while things were said
function readStruggles({ goals, topics, produced7d, said7d }) {
  const out = [];

  const goalRows = Array.isArray(goals?.goals) ? goals.goals : [];
  for (const g of goalRows) {
    if (!g || g.status !== "active") continue;
    const last = Date.parse(g.last_advanced_at ?? g.created_at ?? "");
    if (!Number.isFinite(last)) continue;
    const days = Math.floor((Date.now() - last) / 86400000);
    if (days >= STALE_DAYS) {
      out.push(`${String(g.title ?? "那件事").slice(0, 30)} 已经 ${days} 天没动`);
    }
  }

  const topicRows = Array.isArray(topics?.topics) ? topics.topics : [];
  for (const tp of topicRows) {
    if (!tp || tp.state === "closed") continue;
    const last = Date.parse(tp.lastAt ?? tp.createdAt ?? "");
    if (!Number.isFinite(last)) continue;
    const days = Math.floor((Date.now() - last) / 86400000);
    if (days >= STALE_DAYS) {
      out.push(`${String(tp.label ?? tp.key ?? "一件事").slice(0, 30)} 悬了 ${days} 天`);
    }
  }

  // All talk, nothing made. This is the check that COGNITION.md 一 is about,
  // so the self-state should carry the same verdict rather than a softer one.
  if (said7d >= 20 && produced7d === 0) {
    out.push("这周一直在说，没做出来东西");
  }

  return out.slice(0, MAX_STRUGGLES);
}

function readPhase({ produced7d, produced30d, said7d, struggles, hasHistory }) {
  // Order matters, and it is not the obvious order.
  //
  // `stuck` comes before `productive` on purpose: three drawings and two dead
  // goals is not a good week, it is a week that is busy on the wrong thing.
  // Checking production first would report the flattering half.
  //
  // `dormant` is checked before anything else because "nothing at all happened"
  // is a stronger statement than any of the per-week counts.
  // dormancy needs a past to be dormant FROM. A brand-new workspace has no
  // history, so calling it dormant would inject "好一阵子没动过了" on day one —
  // a claim about inactivity that nothing supports.
  if (produced30d === 0 && said7d === 0 && hasHistory) return "dormant";
  if (struggles.length >= 2) return "stuck";
  if (produced7d >= 3) return "productive";
  return "steady";
}

function renderLine(s) {
  const bits = [];
  const n = s.ability.produced_7d;
  const said = s.ability.said_7d;

  if (s.phase === "productive") {
    bits.push(`这周做出来 ${n} 样东西`);
  } else if (s.phase === "stuck") {
    bits.push("这几天有点卡住");
  } else if (s.phase === "dormant") {
    bits.push("好一阵子没动过了");
  } else if (n > 0) {
    bits.push(`这周做出来 ${n} 样`);
  } else if (said > 0) {
    bits.push("这周光在说话，没做出来什么");
  }

  if (s.struggles.length) {
    bits.push(s.struggles[0]);
  }

  // The starving direction, if one is clearly behind the others.
  const starving = s.pursuits[0];
  if (starving && starving.value < 0.5) {
    bits.push(`「${cnTitle(starving)}」这条一直没往前走`);
  }

  return bits.join("；").slice(0, 200);
}

// ------------------------------------------------------------------- refresh

/**
 * Recompute the state card from the ledgers and persist it.
 *
 * Every field is derived. `refresh` is the ONLY writer, and it never accepts
 * caller-supplied values — that is what keeps the card honest. If a caller
 * could pass `{ phase: "productive" }` this module would become a way to lie
 * about oneself, which is worse than having no self-state at all.
 */
export function refresh(workspaceDir, deps = {}) {
  const read = deps.readJson ?? readJson;
  const stateDir = path.join(workspaceDir, "state");

  const effects = read(path.join(stateDir, "effects.json")) ?? {};
  const deeds = read(path.join(stateDir, "deeds.json")) ?? {};
  const topics = read(path.join(stateDir, "topics.json")) ?? {};

  // go through goals.js rather than reading the file: on a fresh install
  // goals.json does not exist yet, and goals.load() supplies the four default
  // aspirations. Parsing the JSON directly made `pursuits` silently empty —
  // which is exactly the failure this card is supposed to prevent.
  let goals = { aspirations: [], goals: [] };
  try { goals = goalsLib.load(workspaceDir); } catch { /* goals are optional */ }

  const now = Date.now();
  const d7 = now - 7 * 86400000;
  const d30 = now - 30 * 86400000;

  const entries = Array.isArray(effects.entries) ? effects.entries : [];
  const produced7d = countProductions(entries, d7);
  const produced30d = countProductions(entries, d30);
  const said7d = countSaid(deeds, d7);

  // First sighting comes from the oldest thing in either ledger, so "how long
  // have I existed" is answered by evidence rather than by a config value.
  const stamps = [
    ...entries.map((e) => Date.parse(e?.at ?? "")),
    ...(Array.isArray(deeds?.entries) ? deeds.entries.map((e) => Date.parse(e?.at ?? "")) : []),
  ].filter((n) => Number.isFinite(n));
  const firstMs = stamps.length ? Math.min(...stamps) : now;
  const daysAlive = Math.max(0, Math.floor((now - firstMs) / 86400000));

  const pursuits = readPursuits(goals);
  const struggles = readStruggles({ goals, topics, produced7d, said7d });
  const phase = readPhase({ produced7d, produced30d, said7d, struggles, hasHistory: stamps.length > 0 });

  const prev = load(workspaceDir);
  const next = {
    version: 1,
    updated_at: isoNow(),
    identity: {
      handles: prev.identity.handles,  // written once by the owner, never derived
      days_alive: daysAlive,
      first_seen: dayKey(firstMs),
    },
    ability: {
      produced_7d: produced7d,
      produced_30d: produced30d,
      said_7d: said7d,
      output_ratio: clamp01(said7d + produced7d === 0
        ? 0
        : produced7d / (said7d + produced7d)),
    },
    pursuits: pursuits.slice(0, 4),
    struggles,
    phase,
    line: "",
  };
  // No history at all → no line. The card still gets written (so the next turn
  // has something to compare against), but nothing is injected. An empty card
  // that speaks is worse than an empty card.
  next.line = stamps.length ? renderLine(next) : "";

  save(workspaceDir, next);
  return next;
}

/**
 * Set the display name. The ONLY field a human may write, because a name is
 * the one thing that cannot be derived from a ledger.
 */
export function setHandles(workspaceDir, handles) {
  const cur = load(workspaceDir);
  cur.identity.handles = String(handles ?? "").replace(/[\r\n]/g, " ").trim().slice(0, MAX_IDENTITY);
  cur.updated_at = isoNow();
  save(workspaceDir, cur);
  return cur;
}

/**
 * The line to inject, or "" when there is nothing worth saying.
 *
 * Silence is a real answer. lingshu's insights.py returns `insufficient` and
 * gives no conclusion rather than guessing, and the whole reason the M3
 * competition needed a `solo_background` rule was that injecting a weak line
 * every round is worse than injecting none.
 */
export function describe(workspaceDir) {
  const s = load(workspaceDir);
  if (!s.line) return "";
  return s.line;
}

/**
 * The line, refreshed first if the card is older than `maxAgeMs`.
 *
 * A self-card that is only rebuilt on a timer drifts: the turn that finally
 * does something interesting reads yesterday's summary. Rebuilding on read
 * costs one JSON round-trip and cannot go stale. `maxAgeMs` exists so a burst
 * of turns does not rewrite the file six times in a minute.
 */
export function describeFresh(workspaceDir, maxAgeMs = 10 * 60 * 1000) {
  let age = Infinity;
  try {
    age = Date.now() - fs.statSync(selfFile(workspaceDir)).mtimeMs;
  } catch { /* no card yet: age stays Infinity, so it gets built */ }

  if (age > maxAgeMs) {
    try { refresh(workspaceDir); } catch { /* fall through to whatever is on disk */ }
  }
  return describe(workspaceDir);
}
