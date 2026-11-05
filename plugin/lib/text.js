// Tokenization + scoring for Chinese/English mixed text, no external deps.
// CJK has no spaces, so we index character bigrams plus latin words.

const CJK = /[\u4e00-\u9fff]/;
const CJK_RUN = /[\u4e00-\u9fff]+/g;
const WORD = /[a-z0-9_']+/g;

// Small synonym table so 「吃什么」 can reach 「米饭/火锅/奶茶」.
// Keys are query-side intents; values are corpus-side words that should match.
const SYNONYMS = {
  吃: ["饭", "菜", "火锅", "奶茶", "外卖", "零食", "好吃", "难吃", "早餐", "午饭", "晚饭", "食堂", "咖啡"],
  食物: ["吃", "饭", "菜", "火锅", "奶茶", "外卖", "零食"],
  喝: ["奶茶", "咖啡", "可乐", "水", "饮料"],
  宠物: ["猫", "狗", "鱼", "仓鼠", "兔子"],
  动物: ["猫", "狗", "鱼", "鸟", "兔子"],
  游戏: ["打游戏", "王者", "原神", "我的世界", "steam", "手游", "联机"],
  学习: ["作业", "考试", "上课", "老师", "学校", "复习", "成绩", "课程"],
  学校: ["上课", "老师", "作业", "考试", "教室", "宿舍"],
  工作: ["上班", "加班", "老板", "同事", "项目", "工资"],
  睡觉: ["睡", "困", "熬夜", "起床", "失眠", "午睡"],
  音乐: ["歌", "听歌", "歌手", "专辑", "演唱会"],
  电影: ["电影", "剧", "追剧", "动漫", "动画"],
  家人: ["爸", "妈", "父母", "哥", "姐", "弟", "妹", "爷爷", "奶奶"],
  朋友: ["同学", "同桌", "室友", "朋友"],
  喜欢: ["爱", "中意", "偏好", "最爱", "讨厌"],
  情绪: ["难过", "开心", "生气", "委屈", "焦虑", "压力"],
  手机: ["安卓", "苹果", "iphone", "安卓机"],
  电脑: ["mac", "笔记本", "台式", "linux", "windows"],
};

function addToken(map, tok, weight = 1) {
  if (!tok) return;
  map.set(tok, (map.get(tok) || 0) + weight);
}

/**
 * Tokenize into a Map<token, weight>.
 * CJK runs become overlapping bigrams; single chars and short runs also kept.
 */
export function tokenize(text) {
  const out = new Map();
  const s = String(text || "").toLowerCase();
  if (!s) return out;

  for (const w of s.match(WORD) || []) {
    if (w.length < 2) continue;
    addToken(out, w);
  }

  for (const run of s.match(CJK_RUN) || []) {
    if (run.length === 1) {
      addToken(out, run, 0.6);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) addToken(out, run.slice(i, i + 2));
    // Whole short phrase is a strong signal on its own.
    if (run.length <= 4) addToken(out, run, 1.5);
  }
  return out;
}

/** Expand query tokens with synonyms, giving them a lower weight. */
export function expandQuery(queryMap, queryText) {
  const out = new Map(queryMap);
  const src = String(queryText || "");

  // Match synonyms against the raw query text, not only exact tokens.
  // 「吃什么」 tokenizes to 吃什/什么, so an exact-key lookup misses 吃.
  for (const [key, alts] of Object.entries(SYNONYMS)) {
    const hit = queryMap.has(key) || (src && src.includes(key));
    if (!hit) continue;
    for (const alt of alts) {
      for (const [t, w] of tokenize(alt)) {
        if (!out.has(t)) out.set(t, w * 0.45);
      }
    }
  }
  return out;
}

/** Inverse document frequency over a token -> docCount map. */
export function idf(token, df, total) {
  const n = df.get(token) || 0;
  if (n === 0) return 0;
  return Math.log(1 + total / n);
}

const QUESTION_WORDS = ["请问", "我想知道", "什么", "怎么", "为什么", "为啥", "哪些", "哪个", "哪里", "是不是", "有没有", "多少"];
const TRAILING_PARTICLES = /[吗呢吧啊呀嘛的了哦喔诶]+$/;

/**
 * Normalize a natural-language query before tokenizing.
 * 「吃什么」 -> 「吃」 so the intent word survives, and so synonym expansion
 * keys on 吃 rather than on the useless bigram 吃什/什么.
 */
export function normalizeQuery(text) {
  let s = String(text || "").trim();
  if (!s) return "";
  for (const w of QUESTION_WORDS) s = s.split(w).join("");
  s = s.replace(TRAILING_PARTICLES, "");
  s = s.replace(/[?？。！!，,、；;：:]+/g, " ").trim();
  return s || String(text || "").trim();
}

/** True when a token is a single CJK character. */
const SINGLE_CJK = /^[\u4e00-\u9fff]$/;

/**
 * Score query/doc overlap.
 * Asymmetric by design: the query is short and may expand through synonyms,
 * so the denominator counts original intent only and expansion can only help.
 */
export function score(queryMap, docMap, df, total, opts = {}) {
  if (!queryMap.size || !docMap.size) return 0;

  let dNorm = 0;
  for (const [, dw] of docMap) dNorm += dw * dw;
  if (!dNorm) return 0;

  const docKeys = opts.docKeys || [...docMap.keys()];
  const raw = (opts.raw || "").toLowerCase();
  const original = opts.originalTokens || null;

  let matched = 0;
  let denom = 0;

  for (const [t, qw] of queryMap) {
    const idfW = df ? Math.max(0.35, idf(t, df, total)) : 1;
    const w = qw * idfW;
    const isOriginal = !original || original.has(t);
    if (isOriginal) denom += w;

    const direct = docMap.get(t);
    if (direct) {
      matched += w * Math.min(1.5, direct) * (isOriginal ? 1 : 0.8);
      continue;
    }

    // Single chars cannot match bigram-indexed docs directly.
    if (SINGLE_CJK.test(t)) {
      let best = 0;
      for (const k of docKeys) {
        if (k.includes(t)) best = Math.max(best, docMap.get(k));
      }
      if (best) {
        matched += w * 0.55 * (isOriginal ? 1 : 0.8);
        continue;
      }
    }

    // Synonym word present in the raw line.
    if (!isOriginal && raw && raw.includes(t)) {
      matched += w * 0.6;
    }
  }

  if (!denom) return 0;

  // Coverage, damped by how spread out the document is.
  const coverage = matched / denom;
  const spread = 1 / Math.sqrt(1 + Math.max(0, docMap.size - 8) * 0.02);
  let s = coverage * spread;

  if (raw && opts.queryText && opts.queryText.length >= 2) {
    if (raw.includes(opts.queryText.toLowerCase())) s += 0.4;
  }
  return s;
}

export function isCjkOnly(text) {
  const s = String(text || "").replace(/[\s\p{P}]/gu, "");
  return s.length > 0 && [...s].every((c) => CJK.test(c));
}
