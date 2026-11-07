/**
 * 兴趣 —— 她一直在追哪几类问题。
 *
 * 这里不做归纳。归纳由她自己写，本模块只负责三件事：
 *
 *   1. 存她写下的兴趣
 *   2. 让它会衰减、会被反复触碰加强
 *   3. 算一条新东西跟她的兴趣贴不贴
 *
 * 为什么不让代码归纳
 * ------------------
 *
 * 试过。用 `wants` 的 15 条真实内容，纯关键词能归纳出「她喜欢问技术问题」——
 * 那是废话，不能迁移到任何没碰过的东西上。
 *
 * 而她自己写能写出这种东西：
 *
 *   「一个数字被引用时，它的测量条件是什么」
 *   → 迁移：这个统计口径包含什么、这个百分比的分母是谁
 *
 * 后者能拿去判断一件她没见过的事。前者只描述了她昨天干了什么。
 *
 * 判据就一条：**写不出迁移方向的，不是兴趣，只是一次提问。**
 *
 * 状态
 * ----
 *
 * `state/interest.json`
 *
 *   { version, items: [ { id, name, pattern, transfers[], evidence[], strength, ... } ] }
 *
 * `strength` 会随时间衰减，被触碰会变强。兴趣不是标签，贴上去就不动了。
 */

import fs from "node:fs";
import path from "node:path";

const FILE = "interest.json";
const VERSION = 1;

const MAX_ITEMS = 12;
const MAX_EVIDENCE = 8;

/** 每次被触碰加多少。0.12 —— 连碰三次才明显，一次不算。 */
const TOUCH_GAIN = 0.12;
/** 每多久衰减一半（天）。90 天：兴趣比情绪慢得多，但也确实会淡。 */
const HALF_LIFE_DAYS = 90;
/** 低于这个就不再算数了，也不再注入。 */
const FLOOR = 0.12;

function file(workspaceDir) {
  return path.join(workspaceDir, "state", FILE);
}

function nowIso() {
  return new Date().toISOString();
}

function round3(v) {
  return Math.round(Number(v) * 1000) / 1000;
}

function unit(v, fallback = 0) {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`);
  fs.renameSync(tmp, p);
}

function daysBetween(a, b) {
  const t = Date.parse(a);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (b - t) / 86400000);
}

/**
 * 字符二元组。中文没空格，按字切比按词切可靠。
 *
 * 丢掉纯标点和纯数字的组合 —— 「，的」「12」这类到处都是，匹配上没有信息量。
 */
/**
 * 这些 bigram 到处都是，命中它们不构成「在说同一件事」的证据。
 *
 * 实测 2026-11-07：例子「给自己拍照片」里的「自己」，让
 * 「弄明白自己是怎么运作的」拿到 0.108，越过 0.08 的线 —— 一条关于
 * 自拍的偏好，给一条关于自我认知的志向加了分。那纯粹是虚词的功劳。
 *
 * 只挡最泛的那几个。挡太多会把真实的措辞差异也一起挡掉，
 * 而这个匹配本来就是字面级的，经不起再削。
 */
const STOP_BIGRAMS = new Set([
  "自己", "什么", "怎么", "这个", "那个", "一下", "一个", "可以", "就是",
  "不是", "没有", "东西", "事情", "时候", "现在", "今天", "觉得", "知道",
  "想的", "想要", "喜欢", "一直", "有点", "有点",
]);

function bigrams(text) {
  const s = String(text ?? "")
    .toLowerCase()
    .replace(/[\s，。、；：（）()「」【】《》"'`~!@#$%^&*+=|\\/<>?,.\-—…:;[\]{}]/g, "");
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) {
    const g = s.slice(i, i + 2);
    if (/^[\d\s]+$/.test(g)) continue;   // 纯数字没有辨识度
    out.add(g);
  }
  return out;
}

function keyOf(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, "").slice(0, 60);
}

// ------------------------------------------------------------------ 衰减

/**
 * 按时间衰减。半衰期 90 天。
 *
 * 为什么不是「一直算数」：一个十年不碰的兴趣还挂着，会让「你一直在追这类事」
 * 这句话变成谎话。她说没兴趣了可以直接关掉，但没人关的那些该自己安静下来。
 */
function decayed(item, now = Date.now()) {
  const days = daysBetween(item.touched_at ?? item.created_at ?? nowIso(), now);
  const factor = Math.pow(0.5, days / HALF_LIFE_DAYS);
  return unit(Number(item.strength ?? 0) * factor);
}

/** 当前有效的兴趣，按强度排序。低于地板的滤掉。 */
export function active(workspaceDir, { now = Date.now(), limit = 5 } = {}) {
  const d = readJson(file(workspaceDir), { version: VERSION, items: [] });
  const items = Array.isArray(d.items) ? d.items : [];
  return items
    .map((x) => ({ ...x, current: round3(decayed(x, now)) }))
    .filter((x) => x.status !== "dropped" && x.current >= FLOOR)
    .sort((a, b) => b.current - a.current)
    .slice(0, Math.max(1, limit));
}

// ------------------------------------------------------------------ 写入

/**
 * 记下一条兴趣。
 *
 * **必须能说出迁移方向。** `transfers` 空的直接拒掉 —— 那是判据，不是建议：
 * 写不出「这条能拿去判断什么新东西」，它就只是一次提问，不该占用兴趣的位置。
 *
 * `name` 撞了就当触碰（变强 + 加证据），不新增一条。
 */
export function declare(workspaceDir, { name, pattern = "", transfers = [], examples = [], evidence = [], at = nowIso() } = {}) {
  const n = String(name ?? "").trim();
  if (!n) return { ok: false, reason: "得有个名字" };

  // 容错：字符串当成一条，不静默丢掉。
  //
  // 实测 2026-11-07：传 `transfers: "统计口径"`（字符串而非数组）会被
  // `Array.isArray` 判成空，最后走到「两个都空着」——她明明写了东西，
  // 却被告知什么都没说。这种拒绝比不拒绝更坏：她不知道自己哪里错了。
  //
  // 宁可宽松接受，也不要给出一个她无法理解的拒绝理由。
  const asList = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
  const tr = asList(transfers)
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, 6);
  const ex = asList(examples)
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, 8);

  // 两类兴趣，至少占一类。
  //
  //   求知型  transfers  「它能拿去判断什么新东西」
  //   偏好型  examples   「具体喜欢的是哪些」
  //
  // 只认第一类是我自己的偏好。实测 2026-11-07：她说「喜欢刷抖音」，
  // 那是真的 —— 日记里有具体记录（手搓的纸箱机器人、小橘猫扮齐天大圣），
  // 但我原来的判据会把这条直接拒掉，理由两条都不成立：
  // 它确实说不出迁移方向，可它确实是她喜欢的东西。
  //
  // 兴趣不等于求知欲。喜欢看某类东西也是兴趣，而且更容易验证 ——
  // 她说了喜欢什么，下次会不会真的点进去看，这个能测。
  if (!tr.length && !ex.length) {
    // 拒绝理由要给出**可执行**的下一步，不只是说"不对"。
    //
    // 实测 2026-11-07：模型很可能照 required 把两个字段都传空数组，
    // 然后被拒，但它已经按 schema 填了所有必填项 —— 收到"两个都空着"
    // 也不知道该改什么。所以把两种写法都举一个例子给它看。
    return {
      ok: false,
      reason:
        "名字有了，但没说清楚是哪一类。补一项再试：" +
        "\n  偏好型 → examples: [\"具体喜欢的东西\"]，比如 [\"纸箱做的小机器人\", \"小橘猫扮齐天大圣\"]" +
        "\n  求知型 → transfers: [\"它能拿去判断什么新东西\"]，比如 [\"这个统计口径包含什么\"]",
    };
  }

  const data = readJson(file(workspaceDir), { version: VERSION, items: [] });
  if (!Array.isArray(data.items)) data.items = [];

  const k = keyOf(n);
  const existing = data.items.find((x) => keyOf(x.name) === k && x.status !== "dropped");

  if (existing) {
    existing.strength = unit(Number(existing.strength ?? 0.3) + TOUCH_GAIN);
    existing.touched_at = at;
    existing.pattern = String(pattern || existing.pattern || "").slice(0, 200);
    existing.transfers = [...new Set([...(existing.transfers ?? []), ...tr])].slice(0, 6);
    existing.examples = [...new Set([...(existing.examples ?? []), ...ex])].slice(0, 8);
    existing.evidence = [...new Set([...(existing.evidence ?? []), ...evidence.map(String)])].slice(-MAX_EVIDENCE);
    writeJson(file(workspaceDir), data);
    return { ok: true, id: existing.id, touched: true, strength: round3(existing.strength) };
  }

  const item = {
    id: `int-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    name: n.slice(0, 60),
    pattern: String(pattern ?? "").slice(0, 200),
    transfers: tr,
    examples: ex,
    evidence: (Array.isArray(evidence) ? evidence : []).map((x) => String(x).slice(0, 120)).slice(-MAX_EVIDENCE),
    strength: 0.45,
    status: "open",
    created_at: at,
    touched_at: at,
  };

  data.items = [...data.items, item].slice(-MAX_ITEMS);
  writeJson(file(workspaceDir), data);
  return { ok: true, id: item.id, touched: false, strength: item.strength };
}

/**
 * 某条兴趣又被碰到了。
 *
 * 用在她做了一件跟这个兴趣有关的事之后。找不到就是找不到，不新建。
 */
export function touch(workspaceDir, key, { evidence = null, at = nowIso() } = {}) {
  const data = readJson(file(workspaceDir), { version: VERSION, items: [] });
  const k = keyOf(key);
  const item = (data.items ?? []).find(
    (x) => x.status !== "dropped" && (keyOf(x.name) === k || x.id === key),
  );
  if (!item) return { ok: false, reason: "没有这条兴趣" };

  item.strength = unit(Number(item.strength ?? 0) + TOUCH_GAIN);
  item.touched_at = at;
  if (evidence) {
    item.evidence = [...new Set([...(item.evidence ?? []), String(evidence).slice(0, 120)])].slice(-MAX_EVIDENCE);
  }
  writeJson(file(workspaceDir), data);
  return { ok: true, id: item.id, strength: round3(item.strength) };
}

/** 不要了。不是删除，是标记 —— 保留历史，但不再注入、不再参与打分。 */
export function drop(workspaceDir, key, { at = nowIso() } = {}) {
  const data = readJson(file(workspaceDir), { version: VERSION, items: [] });
  const k = keyOf(key);
  const item = (data.items ?? []).find(
    (x) => x.status !== "dropped" && (keyOf(x.name) === k || x.id === key),
  );
  if (!item) return { ok: false, reason: "没有这条兴趣" };
  item.status = "dropped";
  item.dropped_at = at;
  writeJson(file(workspaceDir), data);
  return { ok: true, id: item.id };
}

// ------------------------------------------------------------------ 测量

/**
 * 一条新东西跟她的兴趣贴不贴。0–1。
 *
 * 只看字面重合，不猜语义。合不出来就是 0，**不编**。
 *
 * 为什么用字面：`transfers` 里写的是「这个统计口径包含什么」这种话，
 * 一段新的候选如果真属于这一类，它多半会带上「统计」「口径」「分母」
 * 这样的词。不带的，靠语义猜风险太高 —— 猜错一次，兴趣就变成了噪音源。
 */
export function affinity(workspaceDir, text, { now = Date.now() } = {}) {
  const items = active(workspaceDir, { now, limit: MAX_ITEMS });
  if (!items.length) return { score: 0, matched: [] };

  const hay = String(text ?? "").toLowerCase();
  if (!hay) return { score: 0, matched: [] };

  const matched = [];
  let best = 0;

  for (const item of items) {
    // 中文没有空格，按词切分会把整句当成一个「词」，于是永远匹配不上
    // （实测：`这个统计口径包含什么` 切完只剩一条，长度够但整句不出现）。
    // 改用字符二元组：拿她的表述切 bigram，看有多少出现在候选文本里。
    // 这在中文上等价于「有没有在说同一件事」，比按词可靠。
    // 每段文本**单独**比，取最高。
    //
    // 把所有例子拼成一大段再算比例是错的：实测一条兴趣有 4 个例子、
    // 加上 name 和 pattern 一共约 80 个 bigram，而一段候选只可能命中其中
    // 一两个例子 —— 4/80 = 0.05，永远过不了 0.08 的线。
    //
    // 逐段比才对得上语义：候选说的是「纸箱做的小机器人」，那它就该跟
    // 「纸箱三角当耳朵的手搓小机器人」这一条例子高度重合，而不是跟
    // 「小橘猫扮齐天大圣」一起被摊薄。
    const segments = [
      ...(item.transfers ?? []),
      ...(item.examples ?? []),
      item.pattern ?? "",
      item.name ?? "",
    ].map((x) => String(x ?? "").trim()).filter(Boolean);

    let bestRatio = 0;
    const hitGrams = [];
    for (const seg of segments) {
      const grams = bigrams(seg);
      if (!grams.size) continue;
      let hit = 0;
      let total = 0;
      const local = [];
      for (const g of grams) {
        // 虚词不算分母也不算命中 —— 否则「那句话越长，虚词越多，
        // 命中率越低」，真实匹配反被稀释。
        if (STOP_BIGRAMS.has(g)) continue;
        total += 1;
        if (hay.includes(g)) {
          hit += 1;
          if (local.length < 6) local.push(g);
        }
      }
      // 至少两个实词级 bigram 才算贴。一个词重合太容易是巧合，
      // 而兴趣一旦被误判，就会去给不相关的东西加分。
      if (hit < 2 || total < 2) continue;
      const ratio = hit / total;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        hitGrams.length = 0;
        hitGrams.push(...local);
      }
    }
    if (bestRatio <= 0) continue;

    const weighted = unit(bestRatio * 1.2) * item.current;
    if (weighted > 0.02) {
      matched.push({ id: item.id, name: item.name, hit: hitGrams, value: round3(weighted) });
    }
    if (weighted > best) best = weighted;
  }

  return { score: round3(best), matched: matched.sort((a, b) => b.value - a.value).slice(0, 3) };
}

/** 全部状态，给工具和调试用。 */
export function review(workspaceDir, { now = Date.now() } = {}) {
  const d = readJson(file(workspaceDir), { version: VERSION, items: [] });
  const items = (Array.isArray(d.items) ? d.items : []).map((x) => ({
    ...x,
    current: round3(decayed(x, now)),
  }));
  return {
    items,
    active: items.filter((x) => x.status !== "dropped" && x.current >= FLOOR),
    count: items.length,
    floor: FLOOR,
    halfLifeDays: HALF_LIFE_DAYS,
  };
}

export const CONSTANTS = Object.freeze({
  VERSION, MAX_ITEMS, MAX_EVIDENCE, TOUCH_GAIN, HALF_LIFE_DAYS, FLOOR,
});
