// Relations: familiarity per person and per group.
// Familiarity is NOT message count. It grows from meaningful signals:
//   - repeat contact on different days (novelty decayed)
//   - self-disclosure (they told us personal things)
//   - emotional weight (they were happy/sad at us)
//   - reciprocity (we remembered something about them)
// And it decays when contact stops.

import fs from "node:fs";
import path from "node:path";
import { todayIn } from "./clock.js";

const FILE_VERSION = 1;
// 每天不联系就掉多少亲密度。
//
// 原值 0.004/天——一个月才掉 0.12，等于不掉。而且（更关键）`applyDecay` 只在
// `touch()` 里被调用，也就是只有对方先开口才会跑。一个再也不说话的人，衰减
// 一次都不会执行，数值永远停在原地。2026-11-04 实测：安奈 152 次互动涨到
// 0.947，此后不再出现，一个月后仍然是 0.947。
//
// 目标（2026-11-04 用户定的）：0.9 的人断联 7 天要落到 0.4 左右。
// （0.9 - 0.4）/ 7 = 0.0714/天。取 0.07。
//
// 对照：
//   0.9 断 7 天  → 0.41
//   0.5 断 7 天  → 0.02（地板，也就是彻底成陌生人）
//   0.2 断 3 天  → 0.02
// 这意味着「普通群友」几乎一停止说话就消失。这是刻意的：熟悉度本来就是会被
// 时间收回的东西，而 0.07/天 比之前的 0.012 快六倍——一周不理人，关系就该回到
// 「认识而已」。底线 0.02 保证记录不归零，名字和笔记都还在。
const FAMILIARITY_DECAY_PER_DAY = 0.07;

// 互动到多少次之后开始递减收益。
//
// 没有这个上限时，每条消息加 0.012 × weight（默认 0.35 = +0.0042），
// 152 条就是 +0.64。话多的人和真熟人涨得一样快，这不是亲密度，是发言量。
//
// 2026-11-04 两次收紧：100 → 50 → 25。每次收紧都是「再难一倍」。
// 现在一个群友要聊到 25 条以后才开始按残值涨，而残值本身也擦过两次。
const DIMINISHING_AFTER = 25;

// 超过门槛后每条只加原来的多少。
//
// 0.15 → 0.075 → 0.0375。和上面的门槛一起收紧，两层同时加倍才能真的变难；
// 只动一个参数的话，另一层会把效果吐回去。
const DIMINISHING_FACTOR = 0.0375;

// 每条消息的基值。
//
// 0.012 → 0.006。这是三个参数里影响面最大的一个：它同时管新人开头涨得快不快。
// 0.006 × 0.35 = 每条 +0.0021，一条闲聊抬不到 0.01，得真聊一阵才看得出熟。
const FAMILIARITY_GAIN = 0.006;

// 跨天奖励也减半：每天第一次见面 +0.04 → +0.02（+ weight×0.015）。
// 不然天天来打个招呼就能坐上高位，那是签到，不是交情。
const DAY_BONUS_BASE = 0.02;
const DAY_BONUS_WEIGHTED = 0.015;

export function relationsFile(workspaceDir) {
  return path.join(workspaceDir, "state", "relations.json");
}

export function loadRelations(workspaceDir) {
  const file = relationsFile(workspaceDir);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object") {
    data = { version: FILE_VERSION, updated_at: new Date().toISOString(), people: {}, groups: {} };
  }
  if (!data.people || typeof data.people !== "object") data.people = {};
  if (!data.groups || typeof data.groups !== "object") data.groups = {};
  return { file, data };
}

export function saveRelations(file, data) {
  data.version = FILE_VERSION;
  data.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function blankPerson(id, name) {
  return {
    id,
    name: name || null,
    familiarity: 0.05,
    trust: 0.3,
    interactions: 0,
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    distinct_days: 0,
    last_day: null,
    disclosures: 0,
    last_topic: null,
    notes: [],
    sentiment: 0,
  };
}

function blankGroup(id, name) {
  return {
    id,
    name: name || null,
    familiarity: 0.05,
    interactions: 0,
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    distinct_days: 0,
    last_day: null,
    members_seen: [],
    last_topic: null,
    sentiment: 0,
  };
}

const dayOf = (iso) => (typeof iso === "string" ? todayIn(new Date(iso)) : todayIn());

function applyDecay(rec) {
  // Measure silence from the later of (last message, last accounting). Without
  // the second term the same interval is charged on every heartbeat; without the
  // first, someone who just spoke would still be charged for older silence.
  const spoke = Date.parse(rec.last_seen || "") || 0;
  const checked = Date.parse(rec.decay_checked_at || "") || 0;
  const from = Math.max(spoke, checked) || Date.now();
  const days = Math.max(0, (Date.now() - from) / 86400000);
  if (days < 1) return rec;
  rec.familiarity = Math.max(0.02, rec.familiarity - FAMILIARITY_DECAY_PER_DAY * days);
  // Old positive sentiment fades toward neutral, but negative sticks longer.
  const pull = rec.sentiment >= 0 ? 0.06 : 0.02;
  rec.sentiment = rec.sentiment * (1 - Math.min(0.6, pull * days));

  // Move the accounting clock forward, or the same silence is charged again
  // every beat.
  //
  // This was a real bug, not a theoretical one: `decayAll` runs on the heartbeat,
  // and `applyDecay` computed elapsed time from `last_seen` without updating it.
  // A record 10 days quiet got charged 10 days' worth on every tick — the probe
  // log showed two runs and the damage was already in the data.
  //
  // The fix uses a SEPARATE field. Writing `last_seen = now` also worked, but it
  // destroyed the meaning of that field: every record ended up claiming the
  // person spoke today, which is false and would have quietly corrupted anything
  // later that asks 「上次说话是什么时候」. `decay_checked_at` records only "when
  // was this silence last accounted for", and is recomputed as the remainder so
  // that no elapsed time is lost to rounding.
  rec.decay_checked_at = new Date(Date.now() - (days % 1) * 86400000).toISOString();
  return rec;
}

/**
 * Decay every record that has been quiet, regardless of who spoke.
 *
 * This is the missing half of applyDecay. Until it existed, decay ran only
 * inside `touch()`, so it required the person to show up in order to be
 * forgotten — a record could not age while it sat untouched. Absence, which is
 * exactly when forgetting should happen, wrote nothing.
 *
 * Called from the heartbeat. Reads every person and group, decays, writes back
 * only if something actually moved, so an idle beat stays silent.
 */
export function decayAll(workspaceDir) {
  const { file, data } = loadRelations(workspaceDir);
  const before = new Map();
  const snap = (rec) => `${rec.familiarity ?? 0}|${rec.sentiment ?? 0}`;

  for (const rec of Object.values(data.people || {})) {
    before.set(rec.id, snap(rec));
    applyDecay(rec);
  }
  for (const rec of Object.values(data.groups || {})) {
    before.set(rec.id, snap(rec));
    applyDecay(rec);
  }

  const moved = [...Object.values(data.people || {}), ...Object.values(data.groups || {})]
    .filter((rec) => before.get(rec.id) !== snap(rec));

  if (!moved.length) return { changed: 0, people: 0, groups: 0 };

  data.updated_at = new Date().toISOString();
  saveRelations(file, data);
  return { changed: moved.length, people: (data.people && Object.keys(data.people).length) || 0, groups: 0 };
}

/**
 * Record one inbound-triggered interaction.
 * @param {object} o
 * @param {string} o.personId
 * @param {string} [o.personName]
 * @param {string} [o.groupId]
 * @param {string} [o.groupName]
 * @param {number} [o.weight]      base weight 0..1 from message quality
 * @param {number} [o.sentiment]   -1..1 affect direction toward us
 * @param {boolean} [o.disclosure] they revealed something personal
 */
export function touch(workspaceDir, o = {}) {
  const { file, data } = loadRelations(workspaceDir);
  const now = new Date();
  const today = todayIn(now);
  const weight = clamp(o.weight ?? 0.35, 0, 1);
  const sentiment = clamp(o.sentiment ?? 0, -1, 1);
  const changed = [];

  if (o.personId) {
    let p = data.people[o.personId];
    if (!p) {
      p = blankPerson(o.personId, o.personName);
      changed.push(`new person ${o.personId}`);
    } else {
      applyDecay(p);
      if (o.personName && p.name !== o.personName) p.name = o.personName;
    }
    p.interactions += 1;
    p.last_seen = now.toISOString();
    if (p.last_day !== today) {
      p.last_day = today;
      p.distinct_days += 1;
      // First contact of a new day is worth more than the 10th message in a row,
      // but not much more — see DAY_BONUS_* for why it was halved.
      p.familiarity = clamp(p.familiarity + DAY_BONUS_BASE + weight * DAY_BONUS_WEIGHTED, 0, 1);
    }
    // Diminishing returns past DIMINISHING_AFTER. A chatty stranger and a real
    // acquaintance must not climb the same slope; without this the only thing
    // familiarity measured was message count. See the constants for the numbers.
    const gainScale = p.interactions > DIMINISHING_AFTER ? DIMINISHING_FACTOR : 1;
    p.familiarity = clamp(p.familiarity + weight * FAMILIARITY_GAIN * gainScale, 0, 1);
    if (o.disclosure) {
      p.disclosures += 1;
      p.trust = clamp(p.trust + 0.05 * gainScale, 0, 1);
      p.familiarity = clamp(p.familiarity + 0.03 * gainScale, 0, 1);
    }
    p.sentiment = clamp(p.sentiment * 0.9 + sentiment * 0.3, -1, 1);
    // Familiarity and trust grow together but trust lags.
    p.trust = clamp(p.trust + (p.familiarity - p.trust) * 0.15, 0, 1);
    if (o.topic) p.last_topic = o.topic;
    data.people[o.personId] = p;
  }

  if (o.groupId) {
    let g = data.groups[o.groupId];
    if (!g) {
      g = blankGroup(o.groupId, o.groupName);
      changed.push(`new group ${o.groupId}`);
    } else {
      applyDecay(g);
      if (o.groupName && g.name !== o.groupName) g.name = o.groupName;
    }
    g.interactions += 1;
    g.last_seen = now.toISOString();
    if (g.last_day !== today) {
      g.last_day = today;
      g.distinct_days += 1;
      g.familiarity = clamp(g.familiarity + 0.03, 0, 1);
    }
    g.familiarity = clamp(g.familiarity + weight * 0.008, 0, 1);
    g.sentiment = clamp(g.sentiment * 0.92 + sentiment * 0.25, -1, 1);
    if (o.personId && !g.members_seen.includes(o.personId)) {
      g.members_seen.push(o.personId);
      if (g.members_seen.length > 200) g.members_seen = g.members_seen.slice(-200);
    }
    if (o.topic) g.last_topic = o.topic;
    data.groups[o.groupId] = g;
  }

  if (changed.length || o.personId || o.groupId) saveRelations(file, data);
  return { file, data, changed };
}

/** Remember a durable note about someone. */
export function addNote(workspaceDir, personId, text) {
  if (!personId || !text) return { ok: false };
  const { file, data } = loadRelations(workspaceDir);
  const p = data.people[personId] || blankPerson(personId);
  p.notes.push({ at: new Date().toISOString(), text: String(text).slice(0, 300) });
  if (p.notes.length > 40) p.notes = p.notes.slice(-40);
  data.people[personId] = p;
  saveRelations(file, data);
  return { ok: true };
}

/** People we actually know, most familiar first. */
export function topPeople(workspaceDir, limit = 10) {
  const { data } = loadRelations(workspaceDir);
  return Object.values(data.people)
    .sort((a, b) => b.familiarity - a.familiarity)
    .slice(0, limit);
}

export function getRelation(workspaceDir, id) {
  const { data } = loadRelations(workspaceDir);
  return data.people[id] || data.groups[id] || null;
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** How should the persona treat this person? Returns a natural-language hint. */
export function describeRelation(rel) {
  if (!rel) return null;
  const f = rel.familiarity ?? 0;
  let who;
  if (f > 0.75) who = "很熟的老朋友";
  else if (f > 0.5) who = "聊得来的人";
  else if (f > 0.28) who = "认识的人";
  else if (f > 0.12) who = "刚认识";
  else who = "不太熟的";
  const bits = [`${who}（熟悉度 ${f.toFixed(2)}）`];
  if (rel.disclosures > 2) bits.push("跟本鱼说过不少自己的事");
  if (rel.sentiment < -0.25) bits.push("之前有过不愉快");
  else if (rel.sentiment > 0.3) bits.push("对本鱼挺友善");
  if (rel.notes?.length) {
    const last = rel.notes[rel.notes.length - 1];
    bits.push(`记着：${last.text}`);
  }
  return bits.join("，");
}
