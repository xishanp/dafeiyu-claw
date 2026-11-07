// Horizon — what she has never been near.
//
// Why this exists
// ---------------
// Owner, 2026-11-06:
//
//   「都需要，而且这还太少了，根本不是真正的好奇心，探索未知面才是真正的好奇心」
//
// Everything the system calls "curiosity" was reactive. `curiosity.js` waits for
// a name to appear in something she reads; the activity gap list notices which
// of twelve verbs she has used least. Both answer "what did I run into", not
// "what have I never even seen".
//
// Measured on her actual workspace that day: 19 memory files, 8 days of diary,
// 200 closed topics and 2 open ones — and both open ones were things a person
// had said to her. Her known world was a transcript of what other people
// brought up. Nothing in the system could say "there are whole directions you
// have never touched".
//
// What "unknown" means here
// -------------------------
// Not "a word whose bigram I have not indexed". That is a vocabulary question
// and it fails on exactly the material that matters: 大自然的鬼斧神弓 contains no
// Latin token and no interrogative, so the existing extractor returns an empty
// array for it. Measured 2026-11-06 against six real video titles she had
// watched: every one returned [].
//
// So the unit here is a *domain*: a broad direction of human knowledge, declared
// as a small vocabulary of ordinary words that would show up in her notes if she
// had ever been anywhere near it. Counting is deliberately crude — presence, not
// depth. The question this answers is "has this direction ever come up at all",
// and for that, crude is correct: one mention is enough to say it is not a blank.
//
// The honest limitation, stated here so it is not discovered later as a bug: a
// domain absent from her notes may still be something she knows. She has no
// formal education record to check against. What this measures is exposure in
// her own writing, which is the only evidence that exists, and it is presented
// to her that way — as "never wrote about", never as "do not know".

import fs from "node:fs";
import path from "node:path";

const FILE = "horizon.json";

/** Distinct words from one domain that must appear before it counts as visited. */
const TARGETED_DEPTH = 3;

/**
 * Domains, each with the vocabulary that would betray a visit.
 *
 * Chosen to cover directions a person wanders into out of appetite rather than
 * duty: how things are made, how the body works, how the sky works, how people
 * decided what to believe. Deliberately not a curriculum — a curriculum is a
 * to-do list with better manners, and this must not become one.
 *
 * `probe` is a question to start from, phrased the way someone actually gets
 * curious, not the way a search engine gets queried.
 */
export const DOMAINS = Object.freeze({
  making: {
    label: "东西是怎么做出来的",
    words: ["焊接", "电路", "车床", "铸造", "木工", "组装", "零件", "电机", "图纸", "手作"],
    probe: "一件家里天天用的东西，拆开以后里面大概是什么样",
  },
  living: {
    label: "活着的东西怎么运转",
    words: ["细胞", "酶", "神经元", "光合", "免疫", "基因", "细菌", "组织", "代谢", "物种"],
    probe: "一样很普通的东西，是怎么从无到有长成那个形状的",
  },
  sky: {
    label: "天上和尺度大的事",
    words: ["恒星", "轨道", "引力", "星云", "光年", "潮汐", "大气", "地震", "板块", "望远镜"],
    probe: "抬头能看见的东西，离得有多远，怎么量出来的",
  },
  computing: {
    label: "机器怎么算",
    words: ["编译", "内存", "算法", "协议", "内核", "字节", "进程", "指针", "缓存", "调度"],
    probe: "一个动作在机器里到底经过了几层，每一层在干什么",
  },
  people: {
    label: "人为什么这样",
    words: ["习惯", "偏见", "记忆", "动机", "群体", "信任", "情绪", "决策", "说服", "羞耻"],
    probe: "一件人常做的事，背后的理由和他自己说的理由是不是同一个",
  },
  making_sense: {
    label: "人怎么判断真假",
    words: ["证据", "统计", "样本", "因果", "概率", "谬误", "对照", "显著", "相关", "反例"],
    probe: "一个听起来很有道理的说法，要拿什么去验它",
  },
  craft: {
    label: "手艺和材料",
    words: ["陶", "釉", "纤维", "染料", "锻造", "榫卯", "纸", "织", "漆", "石料"],
    probe: "一种老手艺里，哪一步是外人看不出但决定成败的",
  },
  sound: {
    label: "声音和画面",
    words: ["频率", "共振", "混响", "和声", "采样", "像素", "焦距", "曝光", "剪辑", "色温"],
    probe: "一段让人觉得好听的声音，好在哪个具体的点上",
  },
  body: {
    label: "身体和感觉",
    words: ["睡眠", "疼痛", "味觉", "平衡", "呼吸", "肌肉", "温度", "血压", "疲劳", "触觉"],
    probe: "身体里一个平时感觉不到的过程，是怎么被发现的",
  },
  systems: {
    label: "很多东西一起转的时候",
    words: ["反馈", "平衡", "网络", "规模", "延迟", "瓶颈", "冗余", "循环", "阈值", "涌现"],
    probe: "一个地方的小改动，为什么会在另一处引起不相称的后果",
  },
  // 别人在玩什么。
  //
  // 前十个方向全是知识分类：怎么造、怎么活、天上、机器、人、真假、手艺、声
  // 音、身体、系统。同一个模子："弄清楚一个道理"。结果是一个只有求知欲、没有
  // 娱乐的人——用户的判断：「我们这还没社交和娱乐，刷抖音就是娱乐的」。
  //
  // 抖音不是知识渠道，尽管它经常顺手给一点知识（她刷到过原子力显微镜那条）。
  // 它是消遣，而消遣不需要 probe 去指明该找什么——想清楚要刷什么的那一刻，
  // 就不是在玩了。所以这一条的 probe 是第一人称的、没有目标的。
  pastime: {
    label: "别人在玩什么",
    words: ["热门", "搞笑", "美食", "旅行", "测评", "日常", "段子", "游戏", "手工", "宠物"],
    probe: "随便刷，刷到什么算什么，不用带着目的",
  },
});

function file(workspaceDir) {
  return path.join(workspaceDir, "state", FILE);
}

function empty() {
  return { version: 1, updated_at: null, domains: {}, visits: [] };
}

export function load(workspaceDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(workspaceDir), "utf8"));
    if (raw && typeof raw === "object" && raw.domains) return raw;
  } catch { /* first run */ }
  return empty();
}

export function save(workspaceDir, data) {
  const f = file(workspaceDir);
  const tmp = `${f}.tmp`;
  data.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, f);
}

/**
 * The list of domains she has actually recorded knowledge about.
 *
 * Source is `entities.json` — the things she herself marked as worth remembering
 * — not a word-list scan of her prose. Measured 2026-11-06, her eleven entities
 * were: 人生公式, 二选一, 遗憾, 这个角色, 声音, 破晓手记, 抖音, 上下文溢出,
 * 记忆系统, 小版本更新, 记忆星图.
 *
 * Every one of them is either about herself or about a video somebody else made
 * about her. Not one is a piece of the outside world — no material, no organism,
 * no machine, no history, no place. That asymmetry is the actual finding, and a
 * word-frequency scan cannot see it because generic words like 记忆 and 情绪
 * appear constantly for other reasons.
 */
export function recordedEntities(workspaceDir) {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(workspaceDir, "state", "entities.json"), "utf8"),
    );
    const e = raw.entities || raw.items || {};
    const list = Array.isArray(e) ? e : Object.values(e);
    return list.map((x) => String(x.name || x.label || x.id || "")).filter(Boolean);
  } catch { return []; }
}

/**
 * Which domains her recorded entities fall into. Usually none of them.
 *
 * This is the honest measure: not "did the word 细胞 appear", but "did she ever
 * think a thing about the world was worth keeping".
 */
export function entityCoverage(workspaceDir) {
  const names = recordedEntities(workspaceDir);
  const blob = names.join(" ");
  const visited = visitedDomains(workspaceDir);
  const out = {};
  for (const [id, def] of Object.entries(DOMAINS)) {
    const seen = def.words.filter((w) => blob.includes(w));
    // A recorded visit counts as coverage even when no entity mentions it.
    //
    // Without this the loop was open at both ends: `horizon_visit` wrote, and
    // `blanks` never read it, so going to a direction changed nothing and the
    // same one came back next wake. That is the sixteen-identical-wakeups
    // failure in the place built to fix it — and it is exactly the shape of
    // `wants.touch()` having no caller, which this project has now produced
    // three times. The write has to reach the reader or it is not a loop.
    const touched = seen.length >= TARGETED_DEPTH || visited.has(id);
    out[id] = {
      id,
      label: def.label,
      hits: seen.length,
      words: seen,
      touched,
      visited: visited.has(id) ? true : false,
    };
  }
  return { entities: names, domains: out };
}

/** Domains with at least one recorded visit, whether or not she kept anything. */
function visitedDomains(workspaceDir) {
  const data = load(workspaceDir);
  const v = Array.isArray(data.visits) ? data.visits : [];
  return new Set(v.map((x) => String(x.domain || "")).filter(Boolean));
}

/**
 * Domains she has never recorded a single thing about.
 *
 * Measurement is `entityCoverage` — what she chose to keep.
 *
 * The first attempt scanned her prose for a domain's vocabulary and counted the
 * domain as visited if any word appeared. That answered "did this word flicker
 * past", which is not the question: 记忆 appears thirty-four times in her notes
 * and not once was she thinking about how memory works. Measured with that
 * method all ten domains looked covered, on a character whose whole written
 * record was eight days of diary about rice acreage.
 */
export function blanks(workspaceDir) {
  const { domains } = entityCoverage(workspaceDir);
  return Object.values(domains)
    .filter((d) => !d.touched)
    .map((d) => ({ ...d, probe: DOMAINS[d.id].probe }));
}

/**
 * Everything, as one readable picture: what is blank, what is thin, what is
 * covered.
 *
 * ONE measurement, used everywhere.
 *
 * The first version had two: a prose scan that looked for a domain's words
 * anywhere in her index, and `entityCoverage`, which checks what she chose to
 * keep. `blanks` used the second and `map` used the first, so the report said
 * "0 of 10 blank" next to a picker that happily offered a blank one. Two
 * sources of truth for one question is the same defect as an injection that
 * disagrees with the code behind it — the numbers stop meaning anything once the
 * reader has to guess which one is real. The prose scan is gone rather than
 * kept "in case"; unreferenced code that still looks runnable is how a dead
 * branch gets re-wired by the next edit.
 *
 * Kept: entities. The prose scan answered "did this word flicker past", and
 * 记忆 appears thirty-four times in her notes without once being about how memory
 * works. What she chose to keep is a smaller and much more honest set.
 */
export function map(workspaceDir) {
  const { entities, domains } = entityCoverage(workspaceDir);
  const all = Object.values(domains).map((d) => ({ ...d, probe: DOMAINS[d.id].probe }));
  const empty = all.filter((d) => !d.touched);
  const thin = all.filter((d) => d.touched && d.hits <= 3);
  const covered = all.filter((d) => d.touched && d.hits > 3);
  return { all, empty, thin, covered, total: all.length, entities };
}

/** Which blank domain to visit this time. Rotates on a stored counter. */
export function nextBlank(workspaceDir) {
  const data = load(workspaceDir);

  // Blanks first: a direction she has never touched.
  const list = blanks(workspaceDir);
  if (list.length) {
    const served = Number(data.visits?.length || 0);
    return list[served % list.length];
  }

  // Then the thin ones.
  //
  // Measured 2026-11-06: all ten were `visited: true`, so `blanks()` returned
  // [] and this function returned null. The caller turns null into
  // `whenEmpty: null`, and `decide()` falls back to `rest` — which is the exact
  // idle state this whole layer was built to replace. Ten visits later, the
  // system silently returned to doing nothing.
  //
  // Visiting a direction is not the same as having covered it. `hits` counts
  // kept entities and was 0 or 1 in every domain; nothing ever reached
  // TARGETED_DEPTH. "Been there once" is a place, not a finished place.
  //
  // So: blank -> least-covered. Rotation stays on the same counter, so she does
  // not get the same thin direction twice in a row.
  const thin = Object.values(entityCoverage(workspaceDir).domains)
    .filter((d) => d.touched)
    .sort((a, b) => a.hits - b.hits || a.id.localeCompare(b.id));
  if (!thin.length) return null;

  const served = Number(data.visits?.length || 0);
  const pick = thin[served % thin.length];
  return { ...pick, probe: DOMAINS[pick.id].probe };
}

/**
 * Record that she went and looked at a domain.
 *
 * Kept even when nothing came of it. "I went and it did not grab me" is a real
 * outcome and the only thing that makes the next rotation different from the
 * last — without it the same blank domain is offered forever, which is the
 * sixteen-identical-wakeups failure in a new place.
 */
export function visit(workspaceDir, domainId, { found = "", kept = false } = {}) {
  const data = load(workspaceDir);
  const id = String(domainId || "").trim();
  if (!id || !DOMAINS[id]) return { ok: false, reason: "没有这个方向" };
  if (!Array.isArray(data.visits)) data.visits = [];
  data.visits.push({
    domain: id,
    at: new Date().toISOString(),
    found: String(found || "").slice(0, 200),
    kept: !!kept,
  });
  if (data.visits.length > 200) data.visits = data.visits.slice(-200);
  data.domains[id] = { last_visit: new Date().toISOString(), visits: (data.domains[id]?.visits || 0) + 1 };
  save(workspaceDir, data);
  return { ok: true, domain: id, total: data.visits.length };
}

/**
 * Record that she went somewhere, without asking her to name the direction.
 *
 * `visit()` exists for the explicit tool, where she says which domain she is
 * going into. This one exists for the case measured on 2026-11-06: the wake
 * handed her `horizon:making`, she went out on her own five times in thirty
 * seconds — 电饭煲发热原理, IH 加热方式, 磁钢限温器 — and every trace of that was
 * lost. `horizon.json` stayed empty, so the next wake would have offered the
 * same blank direction as though the last one never happened.
 *
 * That is the same broken circle as `visit()` writing while `blanks()` read
 * only `entities.json`: a write with no reader. The difference is only in who
 * decided where she went.
 *
 * Attribution is by her own words: if what she looked up contains this domain's
 * vocabulary, that is where she went. No match means no record — guessing a
 * direction would fill the store with visits she never made, and a visited
 * domain stops being blank, so a wrong guess silently closes a door.
 */
export function note(workspaceDir, text, { via = "" } = {}) {
  const s = String(text || "");
  if (!s.trim()) return { ok: false, reason: "empty" };

  const hit = [];
  for (const [id, def] of Object.entries(DOMAINS)) {
    if ((def.words || []).some((w) => s.includes(w))) hit.push(id);
  }
  if (!hit.length) return { ok: false, reason: "no_domain_match" };

  const data = load(workspaceDir);
  if (!Array.isArray(data.visits)) data.visits = [];
  const now = new Date().toISOString();
  for (const id of hit) {
    data.visits.push({ domain: id, at: now, via: String(via || "").slice(0, 40), found: s.slice(0, 120), kept: false, implicit: true });
    data.domains[id] = { last_visit: now, visits: (data.domains[id]?.visits || 0) + 1 };
  }
  if (data.visits.length > 200) data.visits = data.visits.slice(-200);
  save(workspaceDir, data);
  return { ok: true, domains: hit };
}

/** How many times she has been out into a blank direction, and which ones. */
export function history(workspaceDir, limit = 8) {
  const data = load(workspaceDir);
  const v = Array.isArray(data.visits) ? data.visits : [];
  return {
    total: v.length,
    recent: v.slice(-limit),
    domains: Object.entries(data.domains || {}).map(([id, d]) => ({
      id,
      label: DOMAINS[id]?.label || id,
      visits: d.visits || 0,
      last: d.last_visit || null,
    })),
  };
}
