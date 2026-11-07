// Topics: what has been talked about, what is still open, what went stale.
// A topic opens when it appears, gains heat on mention, decays over time,
// and closes when heat drops below a threshold or it is resolved.

import fs from "node:fs";
import path from "node:path";

const FILE_VERSION = 1;
const MAX_TOPICS = 120;
// 话题热度的衰减。
//
// 原来是 0.045/小时，半衰期约 15 小时。实测 2026-11-07：她那 6 条 open 话题
// 全部是 0.000，最老的才 7 小时——一轮对话过去不到半天，话题就全掉到
// 阈值（0.06）以下了。后果不是“忘了聊过什么”（记忆里还有），是**提示词里
// 一句话题提示都没有**，`describeTopics()` 直接返回空字符串，她每次开口
// 都是从头开始。
//
// 一个话题不该在 7 小时后就不存在。人聊完一件事，过两天提起来是正常的。
//
// 0.003/小时：半衰期约 10 天，一周后还有 ~40%。这样「昨天说的那个」能
// 真在清单里，而一个月前的旧话也自然掉出去，不需要额外清理。
//
// 代价：清单会变长。但 `hotTopics` 本来就只取前 4 个，而且按热度排序——
// 新话题永远排在旧话题前面。
const HEAT_DECAY_PER_HOUR = 0.003;
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

  // 只说「最近聊到过哪些」是不够的。
  //
  // 实测 2026-11-07：她的记录里话题一个接一个开，每一个都只开一次就换下一个。
  // 原因不在她不爱聊深，而在提示词只交上来一份热度清单——清单告诉她
  // “这些东西存在”，没说“其中哪一条是你现在正在说的”。两者差别很大：前者
  // 是背景，后者是位置。一个没位置的人每句话都在开场。
  //
  // 所以这里把 hottest 一条单独拿出来，明确说“这个是当前的”。不是命令她
  // 必须接着聊，是告诉她：你上一次停在这里。可以接着走，也可以换——但要知道
  // 自己是从哪儿停的。
  const top = hot[0];
  const bits = hot.slice(1).map((t) => `${t.label}(${t.heat.toFixed(2)})`);
  const fresh = (() => {
    const t = Date.parse(top.last_at ?? "");
    if (!Number.isFinite(t)) return "";
    const min = Math.round((Date.now() - t) / 60000);
    if (min < 2) return "就在刚才";
    if (min < 60) return `${min} 分钟前`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.round(h / 24)} 天前`;
  })();

  const lines = [
    `【你停在那儿】${top.label}${fresh ? `（${fresh}）` : ""}`,
    "\u3000这一段是接着它说的。没聊完就接着聊，聊完了就换一个，或者停下来——都不用解释。",
  ];
  if (bits.length) lines.push(`【旁边还挂着的】${bits.join("、")}`);
  const stale = staleButOpen(workspaceDir, { minHours: 12, limit: 2 });
  if (stale.length) {
    lines.push(`【更早悬着的】${stale.map((t) => t.label).join("、")}`);
  }
  return lines.join("\n");
}
