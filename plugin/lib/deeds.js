// 自己做过的事 — an action log for the character.
//
// `memory/YYYY-MM-DD.md` records what OTHER people said. Nothing records what
// dafeiyu did on its own initiative: the 说说 it posted, the sticker it threw,
// the thing it said that landed well. Without that it cannot say "昨天那条说说
// 没人理" — it genuinely does not know.
//
// Deliberately not every message. A chat log would drown the signal; what
// matters for continuity is the actions that carried intent: posted, shared,
// kept something, said something it chose to say unprompted.

import fs from "node:fs";
import path from "node:path";
import { todayIn } from "./clock.js";

const MAX_ENTRIES = 40;
const MAX_NOTE = 60;

export function deedFile(workspaceDir) {
  return path.join(workspaceDir, "state", "deeds.json");
}

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.entries)) return raw;
  } catch { /* first run */ }
  return { version: 1, updated_at: new Date().toISOString(), entries: [] };
}

function save(file, data) {
  data.updated_at = new Date().toISOString();
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

const KIND_LABEL = {
  qzone: "发了说说",
  "qzone-like": "在空间点了赞",
  "qzone-comment": "在空间评论了",
  sticker: "发了表情",
  voice: "发了语音",
  spoke: "自己开口说了话",
  kept: "记住了一件事",
  drawn: "画了一张",
  browsed: "自己去逛了",
};

/**
 * Record one act.
 *
 * `ref` is an id when the action produced something addressable (a 说说 tid),
 * so a later turn can follow up on it instead of guessing.
 */
export function record(workspaceDir, { kind, note, ref = null, ok = true }) {
  const k = String(kind || "").trim();
  if (!k) return { ok: false, reason: "缺 kind" };
  const file = deedFile(workspaceDir);
  const data = load(file);

  data.entries.push({
    kind: k,
    note: note ? String(note).slice(0, MAX_NOTE) : null,
    ref: ref ? String(ref) : null,
    ok: ok !== false,
    at: new Date().toISOString(),
  });

  if (data.entries.length > MAX_ENTRIES) {
    data.entries = data.entries.slice(-MAX_ENTRIES);
  }
  save(file, data);
  return { ok: true, total: data.entries.length };
}

/** Today's acts, newest last. */
export function today(workspaceDir) {
  const day = todayIn();
  return load(deedFile(workspaceDir)).entries.filter((e) => String(e.at).startsWith(day));
}

/** The most recent acts regardless of day. */
export function recent(workspaceDir, limit = 8) {
  const all = load(deedFile(workspaceDir)).entries;
  return all.slice(-Math.max(1, Math.min(40, limit)));
}

/**
 * What to inject. Small and situational: a running list of everything would
 * read like a log file, so this names only what happened and when, and lets the
 * model decide whether any of it is worth bringing up.
 */
export function describe(workspaceDir) {
  const items = recent(workspaceDir, 6);
  if (!items.length) return "";
  const now = Date.now();
  const shown = items.map((e) => {
    const at = Date.parse(e.at);
    const mins = Number.isFinite(at) ? Math.floor((now - at) / 60000) : null;
    let when = "";
    if (mins !== null) {
      if (mins < 60) when = `${mins} 分钟前`;
      else if (mins < 24 * 60) when = `${Math.floor(mins / 60)} 小时前`;
      else when = `${Math.floor(mins / (24 * 60))} 天前`;
    }
    const label = KIND_LABEL[e.kind] || e.kind;
    const note = e.note ? `：${e.note}` : "";
    const failed = e.ok === false ? "（没成）" : "";
    return `  · ${when} ${label}${note}${failed}`;
  });
  return ["【本鱼最近做过的事】", shown.join("\n")].join("\n");
}
