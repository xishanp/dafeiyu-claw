/**
 * 内感知 —— 她对自己当前状态的读法。
 *
 * 这不是情绪。情绪是「高兴 / 无聊 / 低落」，回答的是「我感觉怎么样」。
 * 内感知回答的是另外几个问题：现在脑子满不满、有多不确定、有没有事情
 * 卡着没动、是不是在几件事之间犹豫、这些是在变好还是变坏。
 *
 * 为什么要分开
 * ------------
 *
 * 情绪系统已经存在，而且它只影响语气 —— `bored 0.736` 的实际效果是
 * 说话更敷衍一点，而不是「闲得难受，得找点事干」。那条链路是对的：
 * 情绪本来就该影响怎么说，不该决定做什么。
 *
 * 但「做什么」之前缺一个东西：对当前处境的判断。同一件事，脑子满的时候
 * 该放下，空的时候可以接；事情卡了三天和刚开头，处理方式不一样。这些
 * 不是情绪，是状态，而系统此前完全没有读它。
 *
 * 现在做什么、不做什么
 * --------------------
 *
 * **只算，不用。** 这一版把五个数算出来写进 probe，不参与任何决策。
 *
 * 理由不是保守，是上一轮的教训：这套系统里有四个机制曾经「装好了但
 * 从来没跑」。在真实数据上确认这些数真的会动、动了有意义之前，把它们
 * 接进打分只会多一条可能一直返回常数的路径。
 *
 * 攒够两周数据、确认每个数都出现过有意义的变化之后，再决定哪个进决策。
 */

import fs from "node:fs";
import path from "node:path";

const VERSION = 1;
const FILE = "interoception.json";

/** 与 workspace.js 的注入门槛保持一致。两边不同步时这个数会立刻失真。 */
const INJECT_FLOOR = 0.25;

function file(workspaceDir) {
  return path.join(workspaceDir, "state", FILE);
}

function nowIso() {
  return new Date().toISOString();
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function unit(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round3(v) {
  return Math.round(Number(v) * 1000) / 1000;
}

/**
 * 认知负荷：这一轮脑子里装了多少东西。
 *
 * 用注入的字符数对比一个参考量，而不是对比硬上限 —— 硬上限是「会不会
 * 被截断」，参考量是「这个量算不算多」。40000 字符的上限下，一万字
 * 不会截断，但已经很多了。
 *
 * 参考量取 12000：这是实测里一次普通注入（含记忆、工具、人格）的量级。
 * 超过它开始算满，两倍就是满。
 */
function loadOf(input) {
  const chars = Number(input?.injectedChars ?? 0);
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return unit(chars / 24000);
}

/**
 * 不确定性：最近这些预测准不准。
 *
 * 直接用平均惊讶值。没有预测过的时候返回 0，但 `known: false` ——
 * 「不知道有多不确定」和「确定」不是一回事，不能都写成 0。
 */
function uncertainOf(expectAccuracy) {
  const a = expectAccuracy || {};
  if (a.count === 0 || a.avgSurprise == null) {
    return { value: 0, known: false, samples: 0 };
  }
  return { value: unit(a.avgSurprise), known: true, samples: a.count };
}

/**
 * 受阻：有几件事卡着没动。
 *
 * 判据不是「创建了多久」，是「最近一次推进有多久以前」。一件事放了十天
 * 但昨天动过，不算卡；一件事三天没碰，算。
 */
function blockedOf(goalState, now = Date.now()) {
  const goals = Array.isArray(goalState?.goals) ? goalState.goals : [];
  const active = goals.filter((g) => {
    const s = String(g?.status ?? "").toLowerCase();
    return s === "active" || s === "open" || s === "";
  });
  const stale = active.filter((g) => {
    const t = Date.parse(String(g?.last_progress_at ?? g?.updated_at ?? g?.created_at ?? ""));
    if (!Number.isFinite(t)) return false;
    return now - t > 3 * 86400000;
  });
  return {
    active: active.length,
    stale: stale.length,
    value: active.length ? unit(stale.length / active.length) : 0,
  };
}

/**
 * 纠结：候选之间分得多近。
 *
 * 不是「有几个候选」—— 十件差很多事的时候一点不纠结。纠结是前两名
 * 差得太小，选哪个都说得过去，那才是犹豫。
 *
 * 用分数方差会更像「整体分散程度」，但那个数在只有一个候选时没有意义，
 * 而且和她实际要做的判断（选哪个）对不上。前两名差距直接就是那个判断。
 */
/**
 * 分差 → 纠结程度。
 *
 * 差 0.05 以内算难分，差 0.3 以上算毫无悬念，中间线性过渡。
 */
function conflictFromGap(gap) {
  if (!Number.isFinite(gap)) return { value: 0, gap: null, contested: false };
  const value = unit((0.3 - Math.max(0, gap)) / 0.3);
  return { value, gap: round3(gap), contested: gap < 0.05 };
}

/**
 * 从广播里读前两名分差。
 *
 * 这是广播的第一个真实读者。之前它每轮都写一份文件，但没有任何代码读，
 * 而我这边又在 `compute()` 里拿 `ranked` 重算同一个 gap —— 同一件事算了
 * 两遍，两份结果还可能不一致。
 *
 * 广播里的 `gap` 就是拼注入文本时用的那个数。读它，等于承认「这一轮的
 * 结论」只有一个来源。
 *
 * 广播缺失（第一轮、文件坏、cycle 没跑）时返回 null，由调用方回退。
 */
function conflictFromBroadcast(broadcast) {
  if (!broadcast || typeof broadcast !== 'object') return null;
  // winner 为 null 表示没有赢家，也谈不上犹豫。
  if (!broadcast.winner) return { value: 0, gap: null, contested: false };
  const gap = Number(broadcast.gap);
  if (!Number.isFinite(gap)) return null;
  const r = conflictFromGap(gap);
  // 广播自己已经判过 contested，以它为准 —— 门槛改动只该改一个地方。
  return { ...r, contested: Boolean(broadcast.contested ?? r.contested) };
}

function conflictOf(ranked) {
  if (!Array.isArray(ranked) || ranked.length < 2) {
    return { value: 0, gap: null, contested: false };
  }
  return conflictFromGap(Number(ranked[0]?.score ?? 0) - Number(ranked[1]?.score ?? 0));
}

/**
 * 趋势：跟上一轮比，是在变好还是变坏。
 *
 * 只报方向，不给数值判断。一个「负荷 0.62」本身说明不了什么，
 * 「负荷从 0.41 涨到 0.62」才有意义。
 */
function trendOf(prev, cur) {
  const keys = ["load", "uncertain", "blocked", "conflict"];
  const out = {};
  for (const k of keys) {
    const a = Number(prev?.[k] ?? 0);
    const b = Number(cur?.[k] ?? 0);
    const d = round3(b - a);
    out[k] = Math.abs(d) < 0.08 ? "flat" : d > 0 ? "up" : "down";
  }
  return out;
}

/**
 * 算一次。
 *
 * 输入全部由调用方传进来，这个函数不读盘。这样它可以被单独测试，
 * 也让「这些数是怎么来的」在调用点一眼可见。
 */
export function compute(workspaceDir, input = {}, { now = Date.now() } = {}) {
  const ranked = Array.isArray(input?.ranked) ? input.ranked : [];
  const load = loadOf(input);
  const uncertain = uncertainOf(input?.expectAccuracy);
  const blocked = blockedOf(input?.goals, now);
  // 优先读广播。没有广播才回退到自己算 —— 回退是为了让单元测试和第一轮
  // 还能工作，不是为了留两条并行路径：有广播时一定用广播。
  const fromBroadcast = conflictFromBroadcast(input?.broadcast);
  const conflict = fromBroadcast ?? conflictOf(ranked);

  const current = {
    load: round3(load),
    uncertain: round3(uncertain.value),
    blocked: round3(blocked.value),
    conflict: round3(conflict.value),
  };

  const prev = readJson(file(workspaceDir), null);
  const trend = prev ? trendOf(prev.current, current) : { load: "flat", uncertain: "flat", blocked: "flat", conflict: "flat" };

  const snap = {
    version: VERSION,
    at: nowIso(),
    current,
    trend,
    detail: {
      injectedChars: Number(input?.injectedChars ?? 0),
      uncertainKnown: uncertain.known,
      uncertainSamples: uncertain.samples,
      goalsActive: blocked.active,
      goalsStale: blocked.stale,
      topGap: conflict.gap,
      contested: conflict.contested,
      // 广播里有 counts.candidates 和 counts.aboveFloor，差就是被压下去的数量。
      // 只看广播时不数 ranked，两个来源不混用。
      suppressed: fromBroadcast
        ? Math.max(0, Number(input.broadcast?.counts?.candidates ?? 0) - Number(input.broadcast?.counts?.aboveFloor ?? 0))
        : ranked.filter((c) => Number(c?.score ?? 0) < INJECT_FLOOR).length,
      conflictSource: fromBroadcast ? 'broadcast' : 'ranked',
    },
  };

  try {
    fs.mkdirSync(path.dirname(file(workspaceDir)), { recursive: true });
    fs.writeFileSync(file(workspaceDir), `${JSON.stringify(snap, null, 2)}\n`, "utf8");
  } catch { /* 写不进去不该让这一轮停下 */ }

  return snap;
}

/** 读上一次的快照。没有就是 null，不是空对象。 */
export function read(workspaceDir) {
  const d = readJson(file(workspaceDir), null);
  return d && typeof d === "object" ? d : null;
}

/**
 * 一句话描述。
 *
 * 只在真的有话说的时候返回。四个数都低的时候返回空字符串 —— 平静不需
 * 要被告知，说了反而像在体检。
 */
export function describe(workspaceDir) {
  const s = read(workspaceDir);
  if (!s?.current) return "";
  const c = s.current;
  const parts = [];
  if (c.load >= 0.7) parts.push("这会儿脑子里东西有点多");
  if (c.uncertain >= 0.6) parts.push("最近老猜不准");
  if (c.conflict >= 0.6) parts.push("手边几件事分不出轻重");
  if (c.blocked >= 0.6) parts.push("有几件卡了很久没动");
  return parts.length ? `${parts.join("，")}。` : "";
}

export const CONSTANTS = Object.freeze({ VERSION, INJECT_FLOOR });
