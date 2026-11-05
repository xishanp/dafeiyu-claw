// 记仇本 — the grudge ledger.
//
// `relations.json` only stores numbers: familiarity 0.87, sentiment -0.2. Numbers
// cannot say "你上次说本鱼笨". The persona already claims to remember slights,
// but with no backing data that claim was unbacked: every "本鱼记得" was a line
// the model invented on the spot.
//
// This keeps the actual words. Deliberately tiny — a few short quotes per person,
// capped, oldest dropped first. It is a grudge book, not a transcript: if it grew
// into a log it would be useless to quote from and expensive to inject.

import fs from "node:fs";
import path from "node:path";

const MAX_PER_PERSON = 6;
const MAX_TEXT = 42;

export function grudgeFile(workspaceDir) {
  return path.join(workspaceDir, "state", "grudges.json");
}

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && raw.people && typeof raw.people === "object") return raw;
  } catch { /* first run */ }
  return { version: 1, updated_at: new Date().toISOString(), people: {} };
}

function save(file, data) {
  data.updated_at = new Date().toISOString();
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Record something a person said that is worth holding onto.
 *
 * `kind` decides how it reads later:
 *   slight  — they said something cutting; worth sulking about
 *   promise —他们答应过什么，可以拿来催
 *   moment  — 一句好笑或好听的，留着回味
 */
export function remember(workspaceDir, { personKey, text, kind = "moment", weight = 0.5 }) {
  const key = String(personKey || "").trim();
  const body = String(text || "").trim();
  if (!key || !body) return { ok: false, reason: "缺 personKey 或 text" };

  const file = grudgeFile(workspaceDir);
  const data = load(file);
  const rec = data.people[key] || { name: null, items: [] };
  if (!Array.isArray(rec.items)) rec.items = [];

  // Same line said twice should not eat two slots.
  const trimmed = body.slice(0, MAX_TEXT);
  const dup = rec.items.find((i) => i.text === trimmed);
  if (dup) {
    dup.count = (dup.count || 1) + 1;
    dup.at = new Date().toISOString();
    data.people[key] = rec;
    save(file, data);
    return { ok: true, deduped: true, total: rec.items.length };
  }

  rec.items.push({
    text: trimmed,
    kind: ["slight", "promise", "moment"].includes(kind) ? kind : "moment",
    weight: Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 0.5,
    at: new Date().toISOString(),
    count: 1,
  });

  // Oldest first out. A grudge book that never forgets is a database, not a
  // person — and it would grow past what is worth injecting.
  if (rec.items.length > MAX_PER_PERSON) {
    rec.items = rec.items.slice(-MAX_PER_PERSON);
  }
  data.people[key] = rec;
  save(file, data);
  return { ok: true, total: rec.items.length };
}

/** Everything held about one person, newest last. */
export function list(workspaceDir, personKey) {
  const data = load(grudgeFile(workspaceDir));
  const rec = data.people[personKey];
  return Array.isArray(rec?.items) ? rec.items : [];
}

/**
 * The line injected into the prompt.
 *
 * Only surfaces when the person is familiar enough that remembering would be in
 * character. Quoting a near-stranger's words back at them reads as creepy, not
 * warm, so `familiarity` gates it rather than the ledger alone.
 */
export function describe(workspaceDir, personKey, { familiarity = 0 } = {}) {
  if (!personKey) return "";
  if (familiarity < 0.35) return "";
  const items = list(workspaceDir, personKey);
  if (!items.length) return "";

  const kinds = { slight: "记着的", promise: "答应过的", moment: "留着的" };
  const shown = items.slice(-3).map((i) => {
    const tag = kinds[i.kind] || "记着的";
    const day = String(i.at || "").slice(5, 10);
    return `  · [${tag}]「${i.text}」${day ? `（${day}）` : ""}`;
  });
  return [
    "【本鱼记着的事】",
    shown.join("\n"),
    "想提就提一句，不想提也不用硬塞。翻旧账要有分寸。",
  ].join("\n");
}
