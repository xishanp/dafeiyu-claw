// Topics: what has been talked about, what is still open, what went stale.
// A topic opens when it appears, gains heat on mention, decays over time,
// and closes when heat drops below a threshold or it is resolved.

import fs from "node:fs";
import path from "node:path";

const FILE_VERSION = 1;
const MAX_TOPICS = 120;
const HEAT_DECAY_PER_HOUR = 0.045;
const CLOSE_THRESHOLD = 0.06;

export function topicsFile(workspaceDir) {
  return path.join(workspaceDir, "state", "topics.json");
}

export function loadTopics(workspaceDir) {
  const file = topicsFile(workspaceDir);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object") {
    data = { version: FILE_VERSION, updated_at: new Date().toISOString(), open_topics: [], closed: [] };
  }
  if (!Array.isArray(data.open_topics)) data.open_topics = [];
  if (!Array.isArray(data.closed)) data.closed = [];
  return { file, data };
}

export function saveTopics(file, data) {
  data.version = FILE_VERSION;
  data.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, "")
    .slice(0, 40);
}

function decayAll(data) {
  const now = Date.now();
  for (const t of data.open_topics) {
    const last = t.last_at ? Date.parse(t.last_at) : now;
    const hours = Math.max(0, (now - last) / 3600000);
    if (hours < 0.05) continue;
    t.heat = Math.max(0, (t.heat ?? 0) * Math.exp(-HEAT_DECAY_PER_HOUR * hours));
  }
}

/**
 * Mention a topic.
 * @param {object} o
 * @param {string} o.topic       topic label, short
 * @param {string} [o.personId]
 * @param {string} [o.groupId]
 * @param {number} [o.heat]      how strongly it came up, 0..1
 */
export function mention(workspaceDir, o = {}) {
  const label = String(o.topic || "").trim().slice(0, 40);
  if (!label) return { ok: false };
  const key = normalizeKey(label);
  const { file, data } = loadTopics(workspaceDir);
  decayAll(data);

  const now = new Date().toISOString();
  let t = data.open_topics.find((x) => x.key === key);

  if (!t) {
    t = {
      key,
      label,
      heat: 0,
      mentions: 0,
      opened_at: now,
      last_at: now,
      people: [],
      groups: [],
      status: "open",
    };
    data.open_topics.push(t);
  }

  t.mentions += 1;
  t.last_at = now;
  // Diminishing returns: the 20th mention adds less than the 2nd.
  const gain = (o.heat ?? 0.5) * (1 / Math.sqrt(t.mentions));
  t.heat = Math.min(1, (t.heat ?? 0) + gain);
  t.label = label;
  t.status = "open";

  if (o.personId && !t.people.includes(o.personId)) t.people.push(o.personId);
  if (o.groupId && !t.groups.includes(o.groupId)) t.groups.push(o.groupId);

  // Close stale topics, keep the list bounded.
  const kept = [];
  for (const x of data.open_topics) {
    if (x.key !== key && (x.heat ?? 0) < CLOSE_THRESHOLD) {
      x.status = "closed";
      x.closed_at = now;
      data.closed.push({ key: x.key, label: x.label, mentions: x.mentions, opened_at: x.opened_at, closed_at: now });
    } else {
      kept.push(x);
    }
  }
  data.closed = data.closed.slice(-200);
  data.open_topics = kept
    .sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0))
    .slice(0, MAX_TOPICS);

  saveTopics(file, data);
  return { ok: true, topic: t };
}

/** Mark a topic resolved (someone answered the open question). */
export function resolveTopic(workspaceDir, label) {
  const key = normalizeKey(label);
  const { file, data } = loadTopics(workspaceDir);
  const idx = data.open_topics.findIndex((x) => x.key === key);
  if (idx === -1) return { ok: false };
  const t = data.open_topics[idx];
  t.status = "resolved";
  t.resolved_at = new Date().toISOString();
  data.closed.push({
    key: t.key, label: t.label, mentions: t.mentions,
    opened_at: t.opened_at, closed_at: t.resolved_at, resolved: true,
  });
  data.closed = data.closed.slice(-200);
  data.open_topics.splice(idx, 1);
  saveTopics(file, data);
  return { ok: true, topic: t };
}

/** Hottest open topics, decay applied at read time. */
export function hotTopics(workspaceDir, limit = 6) {
  const { file, data } = loadTopics(workspaceDir);
  decayAll(data);
  saveTopics(file, data); // persist the decay so it does not compound
  return data.open_topics
    .filter((t) => (t.heat ?? 0) >= CLOSE_THRESHOLD)
    .sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0))
    .slice(0, limit);
}

/**
 * Topics that are still open but have not been touched in a while.
 * These are the natural "by the way, about that thing" openers.
 */
export function staleButOpen(workspaceDir, opts = {}) {
  const { minHours = 6, maxHours = 24 * 14, limit = 3 } = opts;
  const { data } = loadTopics(workspaceDir);
  const now = Date.now();
  return data.open_topics
    .filter((t) => {
      const hours = (now - Date.parse(t.last_at)) / 3600000;
      return hours >= minHours && hours <= maxHours && (t.heat ?? 0) > 0.08;
    })
    .sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0))
    .slice(0, limit);
}

/** Persona hint listing what is still dangling. */
export function describeTopics(workspaceDir) {
  const hot = hotTopics(workspaceDir, 4);
  if (!hot.length) return "";
  const bits = hot.map((t) => `${t.label}(${t.heat.toFixed(2)})`);
  const stale = staleButOpen(workspaceDir, { minHours: 12, limit: 2 });
  let s = `【最近聊到的】${bits.join("、")}`;
  if (stale.length) s += `\n【还悬着的】${stale.map((t) => t.label).join("、")}`;
  return s;
}
