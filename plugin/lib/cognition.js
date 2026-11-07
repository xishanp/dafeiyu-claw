// 一轮认知 — one cognitive cycle, in one place.
//
// Why this file exists
// --------------------
// By 2026-11-04 the plugin had six separate candidate sources, each in its own
// try/catch inside `index.js`: emotion, goal, aspiration, unresolved topic,
// M4 proposals, self card. Every one of them read its own files, none of them
// knew the others existed, and the result was assembled by pushing into an
// array. That is a pile of parts that happens to work, not a design.
//
// Measured consequence: the pool had no notion of "what is new". Every source
// described a standing condition (a starving direction, a stalled goal, a mood
// above baseline). Nothing described an EVENT — "this changed since last time".
// So the competition kept re-ranking the same standing conditions, and the only
// defence against repetition was habituation, which is a penalty system, not
// awareness.
//
// Both projects studied on 2026-11-04 have the same hole and both say so:
//   lingshu  autonomy.py:319 — explore() is opt-in, "默认链路零行为变更"
//   dafeiyu  index.js:12    — 自定义自动刷定时器; autonomous = the choice made
//                             after the timer fires, not the firing itself
//
// The fix is not a seventh source. It is a first phase: OBSERVE, which produces
// a single snapshot including deltas, then NOTICE, which turns deltas into
// candidates. A standing condition that has not changed is worth less than a
// thing that just changed, and until now the code could not express that.
//
// The cycle
// ---------
//   observe  →  snapshot: what is true right now, plus what changed
//   notice   →  candidates: snapshot turned into things worth thinking about
//   compete  →  one winner, by score, with habituation
//   record   →  what won, why, and what was ignored (so the next round knows)
//
// Every phase is pure except `record`, which appends. No phase may write a
// decision the others disagree with — `record` stores what `compete` returned.
//
// What this file does NOT do
// --------------------------
// No prompt rewriting, no outbound action, no permissions. It reads state and
// produces one line of intent. The character still decides what to do with it.

import fs from "node:fs";
import path from "node:path";

import * as attention from "./workspace.js";
import * as revisit from "./revisit.js";
import * as interest from "./interest.js";
import * as selfState from "./self.js";
import * as proposals from "./proposals.js";
import * as goalsLib from "./goals.js";
import * as curiosity from "./curiosity.js";

// --------------------------------------------------------------------- config

const EVENT_FILE = "events.json";
const MAX_EVENTS = 200;
const EVENT_LOOKBACK_MS = 72 * 3600 * 1000;

// How much an event outranks a standing condition.
//
// This is the number that makes the whole design work, so it is stated once and
// explained: a delta is worth about one step of habituation more than a
// baseline. Too high and every tiny change drowns out real business; too low
// and the pool is back to re-ranking standing conditions.
const EVENT_BONUS = 0.18;

const DEFAULT_SUBJECT = "self";

// ------------------------------------------------------------------ utilities

function nowIso() {
  return new Date().toISOString();
}

function readJson(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object") return raw;
  } catch { /* missing or corrupt */ }
  return null;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function daysSince(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 86400000;
}

function statePath(workspaceDir, name) {
  return path.join(workspaceDir, "state", name);
}

// ------------------------------------------------------------------- OBSERVE

/**
 * Read everything once, into one snapshot.
 *
 * Before this existed, six callers each opened their own files; a single turn
 * read `goals.json` twice and `emotion.json` once, and nothing could compare one
 * reading against another. One read also means the snapshot is internally
 * consistent — the goal and the aspiration cannot disagree about how many goals
 * are done, because they come from the same parse.
 *
 * Values are NOT interpreted here. `observe` answers "what is on disk", and
 * `notice` decides what that means. Keeping them apart is what stops a new
 * source from smuggling its own opinion into the pool.
 */
export function observe(workspaceDir) {
  const effects = readJson(statePath(workspaceDir, "effects.json")) ?? {};
  const deeds = readJson(statePath(workspaceDir, "deeds.json")) ?? {};
  const topics = readJson(statePath(workspaceDir, "topics.json")) ?? {};
  // 真实文件里的键是 `open_topics`（见 lib/topics.js:28）。这里读 `topics`
  // 读到的是 undefined，这个字段就永远是空数组 —— 于是「悬着的事」这个
  // 候选从来没进过竞争，self 卡也算不出还有几件事没落地。
  // 2026-11-07 实测：文件里 6 条 open，快照读到 0 条。
  const openTopics = Array.isArray(topics.open_topics)
    ? topics.open_topics
    : Array.isArray(topics.topics) ? topics.topics : [];
  const events = readJson(statePath(workspaceDir, EVENT_FILE)) ?? {};
  // 好奇心池和经验池也是候选来源 —— 不只是另外两块要单独注入的文字。
  //
  // 之前这里是割裂的：这两个池子各自在自己的注入块里出现，从不参与
  // `compete`。于是「她碰到一个没弄明白的名字」和「手上那件事」永远比不了
  // 孰轻孰重 —— 一个靠固定位置插入提示词，一个靠评分，两套标准。
  //
  // 读文件失败就是空数组：一个池子坏掉不该让整轮快照崩。
  const curiosityRaw = readJson(statePath(workspaceDir, "curiosity.json")) ?? {};
  const experienceRaw = readJson(statePath(workspaceDir, "experience-pool.json")) ?? {};

  let goals = { aspirations: [], goals: [] };
  try { goals = goalsLib.load(workspaceDir); } catch { /* optional */ }

  // The self card is refreshed here, not in the caller. If it were refreshed
  // later the snapshot could carry a card that predates the effects it just
  // read, and the two halves of the cycle would disagree about the same week.
  let self = null;
  try {
    selfState.describeFresh(workspaceDir);
    self = selfState.load(workspaceDir);
  } catch { /* optional */ }

  return {
    at: nowIso(),
    effects: Array.isArray(effects.entries) ? effects.entries : [],
    deeds: Array.isArray(deeds.entries) ? deeds.entries : [],
    topics: openTopics,
    goals,
    self,
    events: Array.isArray(events.events) ? events.events : [],
    // Only what is still alive. `faded` and `dropped` are settled history and
    // have no business competing for this turn's attention.
    //
    // Each one carries its `pull` score computed once here, so the scoring rule
    // stays in `curiosity.pull` — recomputing it in `notice` would be a second
    // implementation that drifts.
    curious: (Array.isArray(curiosityRaw.noticings) ? curiosityRaw.noticings : [])
      .filter((n) => n && n.status === "open" && !n.want_id)
      .map((n) => ({ ...n, pullScore: curiosity.pull(n) })),
    pending: (Array.isArray(experienceRaw.entries) ? experienceRaw.entries : [])
      .filter((e) => e && e.status === "pending"),
  };
}

// -------------------------------------------------------------------- NOTICE

/** Which emotion is actually up, if any. */
function readAffect() {
  return null; // replaced by the caller: emotion lives in the host closure
}

/**
 * Turn the snapshot into candidates.
 *
 * This is where every source becomes equal. Each branch returns zero or one
 * candidate, they all go into one array, and from `compete` onward nothing knows
 * where a candidate came from. That is the whole point of merging the six
 * scattered try/catches: a candidate is a candidate.
 */
export function notice(snapshot, opts = {}) {
  const {
    affect = null,      // { name, value } — already translated to Chinese
    extra = [],         // M4 proposals
    now = Date.now(),
    // 只有 `revisit` 那一支需要读盘（回访数据不在 snapshot 里，它一天才算一次）。
    // 其余候选都从 snapshot 来，保持纯函数。传 null 时那一支直接跳过。
    workspaceDir = null,
  } = opts;

  const out = [];
  const add = (c) => { if (c) out.push(c); };
  const s = snapshot;

  // --- 1. someone is talking ------------------------------------------------
  if (opts.userTurn?.text) {
    add({
      key: "user_turn",
      kind: "user_turn",
      salience: 0.95,
      label: "有人说话",
      text: `有人刚跟你说话：${String(opts.userTurn.text).slice(0, 60)}`,
    });
  }

  // --- 2. the oldest active goal -------------------------------------------
  const activeGoals = (s.goals?.goals ?? []).filter((g) => g?.status === "active");
  if (activeGoals.length) {
    let staleIds = new Set();
    try { staleIds = new Set(goalsLib.staleGoals.sync?.(null) ?? []); } catch { /* ignore */ }

    // Staleness is computed here rather than via goals.staleGoals() because the
    // snapshot already has the goals; calling back into the module would re-read
    // the file this snapshot just read.
    const withAge = activeGoals.map((g) => ({
      ...g,
      days: daysSince(g.last_advanced_at ?? g.created_at) ?? 0,
    }));
    const stale = withAge.filter((g) => g.days >= 2);
    const pick = stale.sort((a, b) => b.days - a.days)[0] ?? withAge[0];
    add({
      key: `goal:${pick.id}`,
      kind: "goal",
      salience: 0.55,
      label: "手上那件事",
      exempt: pick.days >= 2,
      text: `手上那件事：${String(pick.title ?? "").slice(0, 40)}`,
    });
  }

  // --- 3. the starving direction -------------------------------------------
  //
  // Gated on having a history, and the gate is not cosmetic: `goals.load()`
  // returns four default aspirations at 0.5 on a fresh install, so without this
  // a brand-new workspace immediately reports "a direction has not moved" about
  // a direction that has never had the chance to move. That is the module
  // inventing a complaint, which is the one thing it must not do.
  //
  // `hasHistory` means at least one verified production or one deed. A workspace
  // with neither has not done anything yet, and that is not a starving
  // direction — it is the beginning.
  // A goal the character actually wrote counts as a reason to speak, even with
  // no production yet: someone said "I want to make this", and the starving
  // direction is a fair comment on that. What must not happen is a complaint
  // about directions nobody ever chose — that is the default-aspirations case.
  const userGoals = (s.goals?.goals ?? []).filter((g) => g?.status !== "done" && g?.status !== "released");
  const hasHistory = s.effects.some((e) => e?.verified === true)
    || s.deeds.length > 0
    || userGoals.length > 0;
  const aspirations = Array.isArray(s.goals?.aspirations) ? s.goals.aspirations : [];
  if (hasHistory && aspirations.length) {
    const finished = new Map();
    for (const g of s.goals?.goals ?? []) {
      if (g?.status === "done" && g.serves) {
        finished.set(g.serves, (finished.get(g.serves) ?? 0) + 1);
      }
    }
    let worst = null;
    for (const a of aspirations) {
      const score = (Number(a.value) || 0) + (finished.get(a.id) ?? 0) * 0.15;
      if (!worst || score < worst.score) worst = { ...a, score };
    }
    if (worst) {
      // Pressure, not value. A direction that produces gets fed and goes quiet;
      // one that never produces starves and gets louder. Measured 2026-11-04:
      // the inverted version made the most-neglected direction the quietest,
      // so it was never chosen and the neglect became permanent.
      const pressure = 1 - clamp01(worst.value);
      add({
        key: `aspiration:${worst.id}`,
        kind: "aspiration",
        salience: 0.4 + 0.4 * pressure,
        label: "那条志向",
        text: `有个方向一直没怎么往前走：${String(worst.title ?? "").slice(0, 40)}`,
      });
    }
  }

  // --- 4. the oldest unresolved topic --------------------------------------
  //
  // 门槛 12 小时 → 2 小时。2026-11-07 实测：
  //
  //   15 条 open_topics，全部落在 0.4–9.4 小时之间，
  //   过 0.5 天（12 小时）门槛的：0 条。
  //
  // 也就是说这个来源在生产里**从来没产出过候选**。当初定 0.5 天是为了
  // 避免“刚说完的话立刻被翻出来”，但代价是“九小时前没聊完的事也不算”，
  // 而那正是这个话题池存在的理由。
  //
  // 2 小时是折中：足够让她不在一轮之内重复自己，又短到当天的事当天能回来。
  // 真正的防重复不靠这道门 —— `recent` 窗口已经会把刚选过的压下去。
  const TOPIC_MIN_HOURS = 2;
  const TOPIC_MIN_HEAT = 0.25;
  const openTopics = s.topics.filter((t) => t?.state !== "closed");
  if (openTopics.length) {
    const aged = openTopics
      .map((t) => ({ ...t, days: daysSince(t.lastAt ?? t.last_at ?? t.createdAt) }))
      .filter((t) => t.days !== null && t.days * 24 >= TOPIC_MIN_HOURS)
      // 热度也要够。只按「放了多久」排序，结果就是最老的最响 ——
      // 2026-11-07 实测：过了 2 小时门槛的 8 条里，heat 全是 0.11–0.12，
      // 那些是早就不重要、只是没人关掉的话题。放得久不等于还重要。
      //
      // 0.25 是「还值得提」的下限。话题的 heat 每小时代谢，
      // 掉到 0.12 说明已经凉透了，再提就是翻旧账。
      .filter((t) => {
        const h = t.heat;
        // 没有 heat 字段的老数据不因此被排斥。
        return h == null || Number(h) >= TOPIC_MIN_HEAT;
      })
      .sort((a, b) => b.days - a.days);
    if (aged.length) {
      const t = aged[0];
      // 0.35 base, +0.06/day, capped at 6 days → max 0.71. Capped on purpose:
      // an uncapped topic took 14 of 20 heartbeats, which is the single-source
      // dominance this whole module exists to stop, just with a different source.
      add({
        key: `topic:${t.key ?? t.label}`,
        kind: "unresolved",
        salience: 0.35 + 0.06 * Math.min(t.days, 6),
        label: "悬着的事",
        text: `还悬着的一件事：${String(t.label ?? t.key ?? "").slice(0, 40)}`,
      });
    }
  }

  // --- 4a. 她在追的那类事，正好撞上了一个新东西 -----------------------------
  //
  // 这是兴趣真正起作用的地方：不是让她「记住自己喜欢什么」，而是让
  // **跟她的兴趣贴得上的候选获得一点加成**。
  //
  // 加成幅度故意小（最多 +0.10）。兴趣应该提高概率，不该决定结果 ——
  // 一个 0.58 的东西如果因为贴兴趣就在 0.30 的东西上面，那不是兴趣，
  // 那是一条硬规则，而硬规则会让她只会做同一件事。
  if (workspaceDir) {
    try {
      const pool = [];
      for (const c of out) {
        const text = `${c.text ?? ""} ${c.label ?? ""}`;
        const a = interest.affinity(workspaceDir, text, { now });
        if (a.score > 0.08) {
          c.salience = Math.min(1, Number(c.salience ?? 0) + 0.10 * a.score);
          c.interestedIn = a.matched[0]?.name ?? null;
          pool.push({ key: c.key, to: a.matched[0]?.name ?? null, score: a.score });
        }
      }
      // 留在候选本身身上，不挂在数组上。
      //
      // 挂数组是错的：`rank()` 会 `candidates.map(...)` 出一个新数组，
      // 属性在拷贝时丢掉，于是下游永远看不到。实测 2026-11-07：
      // 加成算出来了，`interested` 却读成 none。
      //
      // 每个候选自己带 `interestedIn`，`rank` 的展开会把它带过去。
      if (pool.length) diagnoseInterest(pool);
    } catch { /* 兴趣数据坏了不该拦住这一轮 */ }
  }

  // --- 4b. 一句旧话，后来再没提起 -----------------------------------------
  //
  // 这是 `state/revisit.json` 的读者。那份数据原本是 11-05 的一次性诊断
  // （`sleeping.json`），结论是「112 句自己的话，100 句后来再没被提起过」。
  // 诊断完就没人看它了 —— 又一份写完不读的表。
  //
  // 现在它进候选池。只挑**刚好隔了几天**的：太新她自己还没走远，
  // 太旧翻出来是骚扰。一天最多一条，`resurface` 自己会返回 null。
  //
  // salience 0.42：能赢过志向（0.29 附近）和自画像，赢不过真实对话和
  // 还有热度的话题。它的位置是「安静的时候会想起来」，不是「打断任何人」。
  try {
    const back = workspaceDir ? revisit.resurface(workspaceDir, { now }) : null;
    if (back) {
      add({
        key: back.key,
        kind: "revisit",
        salience: back.salience,
        label: back.label,
        text: back.line,
      });
    }
  } catch { /* 没有数据就没有这条 */ }

  // --- 5. the self card -----------------------------------------------------
  if (s.self?.line) {
    // Phase weights, highest first. `dormant` outranks `stuck`: if the whole
    // thing stopped, a starving direction is moot. `productive` scores lowest
    // because doing well is not a reason to interrupt.
    const boost = { dormant: 0.68, stuck: 0.62, steady: 0.38, productive: 0.3 };
    add({
      key: "self:state",
      kind: "self_state",
      salience: boost[s.self.phase] ?? 0.38,
      label: "自己的状态",
      text: s.self.line,
    });
  }

  // --- 6. what changed since last time -------------------------------------
  //
  // The phase nothing else had. An event is a fact about a TRANSITION, not
  // about a state: "produced nothing for 3 days and then produced something",
  // "a goal stopped moving", "an old topic was touched again".
  //
  // Without this, every candidate described standing conditions, so the pool
  // ranked the same things forever and habituation was the only brake.
  for (const c of noticeEvents(s, { now })) add(c);

  // --- 7. M4 proposals, as ordinary candidates -----------------------------
  // "Bias, never preempt": a proposal that cannot lose would be an injection.
  for (const c of extra) add(c);

  // --- 8. 好奇心：她碰到但没弄明白的东西 --------------------------------
  //
  // 进竞争之前，这些只能在自己的注入块里出现，位置是固定的；于是「碰到一个
  // 没弄明白的名字」永远和「手上那件事」比不了轻重 —— 一个靠排版，一个靠评分。
  //
  // 分数来源：`pull()` 已经是它自己的量，直接当 salience。门槛仍由
  // `curiosity.propose` 把关（新鲜期 + 0.55）；这里只把已经过线的那些放进
  // 竞场，不重新发明一遍阈值。
  //
  // 一次最多进 2 条：池子里可能同时有好几个过线的，全都堆进候选会把别的
  // 来源扑死，而「好几个都值得问」不等于「这一轮要说好几件」。
  const curiousReady = (s.curious ?? [])
    .map((n) => ({ n, p: Number(n.pullScore) || 0 }))
    .filter((x) => x.p >= 0.55)
    .sort((a, b) => b.p - a.p)
    .slice(0, 2);
  for (const { n, p } of curiousReady) {
    add({
      key: `curious:${n.id}`,
      kind: "curious",
      // pull 最高接近 1，但一个没弄明白的名字不该和「有人刚问你话」(0.95)平起
      // 平坐。压到 0.62 顶部：它能赢过志向和自画像，赢不过真实对话。
      salience: Math.min(0.62, 0.30 + 0.35 * p),
      label: "没弄明白的",
      text: `有件事你还没弄明白：${String(n.display ?? n.topic ?? "").slice(0, 40)}`,
    });
  }

  // --- 9. 经验池：写下来了但还没定性的 -----------------------------------
  //
  // `pending` 是「发生过、还没想清楚算不算数」。它不是待办，但它确实占着
  // 一件事没结，所以该和别的东西比一次，而不是固定排在提示词某一行。
  //
  // 只取最老的一条：最新的那条往往就是这一轮刚记下的，每轮都提没意义。
  const oldestPending = (s.pending ?? [])
    .slice()
    .sort((a, b) => Date.parse(a.at ?? "") - Date.parse(b.at ?? ""))[0];
  if (oldestPending) {
    const ageDays = daysSince(oldestPending.at) ?? 0;
    add({
      key: `pending:${oldestPending.id}`,
      kind: "pending",
      // 0.34 起，越放越重（最多 +0.12）：一件没结的事拖久了才值得提。
      // 顶部 0.46 —— 低于好奇心顶部，因为「没弄明白」比「没归类」更驱动人。
      salience: 0.34 + 0.06 * Math.min(ageDays, 2),
      label: "还没定性的",
      text: `有件事你记下了，还没想过它算不算数：${String(oldestPending.what ?? "").slice(0, 40)}`,
    });
  }

  return out;
}

/**
 * Deltas, as candidates.
 *
 * Only transitions that are actually visible in the snapshot are produced here;
 * nothing is invented. A quiet system yields nothing, which is the correct
 * answer — `commit` records it as such.
 */
export function noticeEvents(snapshot, opts = {}) {
  const { now = Date.now() } = opts;
  const out = [];
  const s = snapshot;
  const seen = new Set((s.events ?? []).map((e) => e.key));

  // production started after a gap
  const effectStamps = s.effects
    .filter((e) => e?.verified === true)
    .map((e) => Date.parse(e.at ?? ""))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (effectStamps.length) {
    const last = effectStamps[effectStamps.length - 1];
    const gapDays = (now - last) / 86400000;
    // Just made something after having made nothing for a while. The upper
    // bound matters: an effect from a month ago is history, not news.
    if (gapDays >= 0.4 && gapDays <= 7) {
      const before = effectStamps.filter((t) => t < last);
      const prev = before[before.length - 1];
      const quiet = prev ? (last - prev) / 86400000 : null;
      if (quiet === null || quiet >= 2) {
        const key = `event:produced:${new Date(last).toISOString().slice(0, 13)}`;
        if (!seen.has(key)) {
          out.push({
            key,
            kind: "event",
            salience: 0.5 + EVENT_BONUS,
            label: "刚做出东西",
            text: quiet
              ? `空了 ${Math.round(quiet)} 天，刚做出来一样东西`
              : "刚做出来一样东西",
          });
        }
      }
    }
  }

  // a goal that just stopped moving (crossed the 2-day line since last cycle)
  for (const g of s.goals?.goals ?? []) {
    if (g?.status !== "active") continue;
    const days = daysSince(g.last_advanced_at ?? g.created_at);
    if (days === null) continue;
    if (days >= 2 && days < 3) {
      const key = `event:goal-stall:${g.id}`;
      if (!seen.has(key)) {
        out.push({
          key,
          kind: "event",
          salience: 0.48 + EVENT_BONUS,
          label: "目标停了",
          text: `「${String(g.title ?? "").slice(0, 24)}」停下来了，两天没动`,
        });
      }
    }
  }

  // a topic that was touched again after a long silence
  for (const t of s.topics) {
    if (t?.state === "closed") continue;
    const last = daysSince(t.lastAt ?? t.last_at ?? t.createdAt);
    if (last === null) continue;
    const touch = Date.parse(t.reopenedAt ?? "");
    if (Number.isFinite(touch) && (now - touch) / 86400000 < 1) {
      const key = `event:topic-back:${t.key ?? t.label}`;
      if (!seen.has(key)) {
        out.push({
          key,
          kind: "event",
          salience: 0.44 + EVENT_BONUS,
          label: "旧事回来了",
          text: `又提起「${String(t.label ?? t.key ?? "").slice(0, 30)}」了`,
        });
      }
    }
  }

  return out;
}

// ------------------------------------------------------------------- COMPETE

/**
 * Score, habituate, pick one.
 *
 * Delegates to `workspace.compete` so there is exactly one scoring rule in the
 * codebase. A second implementation here would drift, and two scorers that
 * disagree is worse than one that is wrong.
 */
export function compete(workspaceDir, candidates, affect = null) {
  if (!candidates.length) return { winner: null, ranked: [], reason: "empty" };

  // Call the scorer directly rather than `workspace.compete`.
  //
  // `compete` builds candidates from an input object and THEN appends `extra`.
  // Passing our finished candidates as `extra` would score them twice — once
  // derived from the input, once from the array — and the habituation counter
  // would advance twice per round for the same key. Using `rank` plus the same
  // floor/silence rules keeps one scoring implementation without the double
  // count.
  const data = attention.load(workspaceDir);
  const ranked = attention.rank(data, candidates, affect);
  const winner = ranked[0];

  if (!winner || winner.score < attention.MIN_INJECT_SCORE) {
    // Record the silence so the window advances.
    //
    // First version returned without touching `recent`, reasoning that a
    // non-delivery should not punish a candidate. Measured over 30 rounds: the
    // same three wins stayed in the window, `seen` froze at 3, the score held at
    // 0.179 and it went silent permanently. Trading "repeats" for "never speaks
    // again" is not a fix. Must match workspace.js's own handling.
    attention.noteSilence(workspaceDir);
    return { winner: null, runnerUp: null, ranked, reason: "below_floor" };
  }

  attention.noteWin(workspaceDir, winner);
  // 连击要读写完 recent 之后的状态，不然数的还是上一轮。
  const streak = attention.streakOf(attention.load(workspaceDir));
  return { winner, runnerUp: ranked[1] ?? null, ranked, streak };
}

// -------------------------------------------------------------------- RECORD

/**
 * Persist what happened, and why.
 *
 * Two things get written:
 *   events.json  — the deltas that were noticed this round, so the next round
 *                  does not raise them again (dedupe lives in `seen`)
 *   plus the competition's own `recent` window, which `attention.compete`
 *                  already maintains
 *
 * Recording the IGNORED candidates matters as much as recording the winner: a
 * proposal that lost five times in a row is evidence, and without a record
 * there is no way to tell "never raised" from "raised and dismissed".
 */
export function record(workspaceDir, { awarded = [], at = nowIso() } = {}) {
  if (!awarded.length) return 0;
  const file = statePath(workspaceDir, EVENT_FILE);
  const data = readJson(file) ?? { version: 1, events: [] };
  const events = Array.isArray(data.events) ? data.events : [];

  const existing = new Set(events.map((e) => e.key));
  let added = 0;
  for (const c of awarded) {
    if (!c?.key || existing.has(c.key)) continue;
    events.push({ key: c.key, kind: c.kind, label: c.label ?? "", at });
    existing.add(c.key);
    added += 1;
  }

  // Trim by age first, then by count. A pure count trim would let a busy week
  // evict the only evidence of what happened in a quiet one.
  const cutoff = Date.parse(at) - EVENT_LOOKBACK_MS;
  const fresh = events.filter((e) => {
    const t = Date.parse(e.at ?? "");
    return Number.isFinite(t) && t >= cutoff;
  });

  writeJsonAtomic(file, {
    version: 1,
    updated_at: at,
    events: fresh.slice(-MAX_EVENTS),
  });
  return added;
}

/**
 * 兴趣加成的旁路记录。
 *
 * 不挂在候选数组上 —— `rank()` 会造新数组，属性会丢。这里只留一份
 * 进程内的最近一次，供 probe 读。它不参与任何判断。
 */
let lastInterestHits = [];
function diagnoseInterest(pool) {
  lastInterestHits = pool;
}
export function interestHits() {
  return lastInterestHits;
}

/**
 * 把调过的行为数值转发给 workspace。
 *
 * `index.js` 不直接 import workspace（它通过这里拿 `compete`），
 * 所以调参也要从这里过一道，免得为了一个赋值去加一条新的依赖边。
 */
export function applyTuning(values = {}) {
  return attention.applyTuning(values);
}

// --------------------------------------------------------------------- CYCLE

/**
 * One full pass. This is the only function `index.js` needs to call.
 *
 * Returns `{ line, winner, ranked, observed, reason }`:
 *   line  — the sentence to inject, or "" for silence
 *   reason — why there was silence, when there was (for probes, not the model)
 */
export function cycle(workspaceDir, opts = {}) {
  const snapshot = observe(workspaceDir);
  const candidates = notice(snapshot, { ...opts, workspaceDir });

  const result = compete(workspaceDir, candidates, opts.affect ?? null);
  const line = attention.render(result);

  // Record every event-shaped candidate that was considered, not only the
  // winner. An event that lost should not be raised again next round — that is
  // the difference between noticing something and nagging about it.
  const events = candidates.filter((c) => c.kind === "event");
  if (events.length) {
    try { record(workspaceDir, { awarded: events }); } catch { /* never fail a turn */ }
  }

  // 广播：这一轮注意力的结论，给别的模块读。
  //
  // 之前竞争只产出一行注入文本，别的系统（内感知、情绪、主动）想知道
  // 「她这轮在想什么」只能自己去重算一遍，或者干脆不知道。于是所谓
  // 「全局工作空间」只是一个人均看不见的局部变量。
  //
  // `broadcast` 是那一份公开的结论：谁赢了、赢多少、有没有犹豫、连着
  // 几轮了。写进状态文件，任何模块都能读同一个事实，不必各自猜。
  //
  // 只写结论，不写候选全表 —— 全表会让读的人重新排一遍，那就又分裂了。
  const broadcast = {
    at: nowIso(),
    winner: result.winner
      ? {
          key: result.winner.key,
          kind: result.winner.kind,
          label: result.winner.label ?? "",
          score: Number(result.winner.score ?? 0),
          why: result.winner.why ?? null,
        }
      : null,
    contested: Boolean(result.runnerUp?.contested),
    gap: result.runnerUp
      ? Math.round(((result.winner?.score ?? 0) - (result.runnerUp?.score ?? 0)) * 1000) / 1000
      : null,
    streak: result.streak ?? null,
    reason: result.reason ?? null,
    counts: {
      candidates: candidates.length,
      aboveFloor: (result.ranked ?? []).filter((c) => Number(c?.score ?? 0) >= attention.MIN_INJECT_SCORE).length,
    },
  };
  try {
    writeJsonAtomic(statePath(workspaceDir, "attention-broadcast.json"), broadcast);
  } catch { /* 广播失败不该让这一轮停 */ }

  return {
    line,
    winner: result.winner ?? null,
    runnerUp: result.runnerUp ?? null,
    ranked: result.ranked ?? [],
    reason: result.reason ?? null,
    broadcast,
    observed: {
      goals: (snapshot.goals?.goals ?? []).length,
      topics: snapshot.topics.length,
      events: (snapshot.events ?? []).length,
      phase: snapshot.self?.phase ?? null,
      candidates: candidates.length,
    },
  };
}
