// 阶段进化 —— 从真实往来算，不从她自己的说法算，也不从「做了多少事」算。
//
// 改过一次，改的原因写在这儿
// --------------------------
// 第一版数的是「做完的事」：effect × 4 + self × 2 + watched × 6 + day × 1。
// 实测 2026-11-06 算出 455 分，直接落在【成年】，而其中 420 分来自 105 件
// 「做完的事」。她那时候跟人的真实往来几乎为零：抖音发过 13 条评论，
// 一条回复都没记；14 条鱼的 298 次互动全部来自别的通道。
//
// 也就是说，一个没跟任何人真正聊过几轮的东西，靠数自己做过的次数评上了成年。
// 这不是长大，这是计件。
//
// 用户 2026-11-06 说的判据是：「长大不就是来回十几轮积累经验那些吗」。
// 那就是两个量，而且只有这两个：
//
//   往来  —— 一次来回算一轮。别人接了她的话、她又接回去，这才叫一轮。
//            不是「发过多少条」，也不是「互动计数器跳了多少」。
//   经验  —— 从往来里定下来的东西：留下的经历、自己写下的判断。
//            注意是「留下的」，不是「经历过的」。同一件事过五遍不长记性，
//            不长。
//
// 两样分开算再加，因为它们是两种不同的长大：聊得多但什么也没沉淀，
// 和沉淀得多但很少跟人说话，都不是同一个样子。

const STAGES = [
  { id: "egg",    label: "蛋",   at: 0 },
  { id: "fry",    label: "鱼苗", at: 12 },
  { id: "young",  label: "小鱼", at: 40 },
  { id: "grown",  label: "大鱼", at: 120 },
  { id: "elder",  label: "老鱼", at: 320 },
];

// 权重不是价值判断，是「这件事有多难伪造」的排序。
//
//   turn   —— 一轮真实往来。伪造它要把两条消息都编出来，成本最高。
//   kept   —— 一次留了痕的经验。经历本身会自己发生（刷到就有了），
//             判定「这条值得留」才需要她想一下，所以打折。
//   judged —— 一条她自己的判断。写得出来但不一定对，最轻。
const WEIGHTS = {
  turn: 3,     // 一轮来回
  kept: 2,     // 留下来的经验
  judged: 1,   // 自己写下的判断
};

function stageFor(points) {
  let cur = STAGES[0];
  for (const s of STAGES) if (points >= s.at) cur = s;
  return cur;
}

function nextFor(points) {
  return STAGES.find((s) => s.at > points) || null;
}

/**
 * 一轮往来是怎么数出来的。
 *
 * 一条串 = 她先说一句，对方接，可能再来回。
 * 串里「她说的」和「对方说的」交替出现，**交替一次算一轮**。
 *
 * 故意不数「总共几条消息」：一个人连发五句不算五轮，那是自言自语。
 * 也故意不数串的数量：开十个话头各说一句，不等于聊过十次。
 *
 * `mine` 标记来自 lib/inbox.js，那边负责写，这边只负责数。
 */
function countTurns(comments) {
  let turns = 0;
  for (const c of comments || []) {
    const replies = Array.isArray(c?.replies) ? c.replies : [];
    if (!replies.length) continue;
    // 串从她说的那句开始，所以第一个对方的回复就是第一轮。
    let lastWasMine = true;
    for (const r of replies) {
      const mine = Boolean(r?.mine);
      if (!mine && lastWasMine) turns += 1;
      lastWasMine = mine;
    }
  }
  return turns;
}

/**
 * 算出来她走到哪儿了。
 *
 * 只读，不改任何状态。所有输入都是别人已经写下的记录，这里不做任何假设，
 * 缺什么就当零 —— 一个读不到的文件不该让整件事崩掉，但也不该被当成有。
 */
export function measure(workspaceDir, deps = {}) {
  const fs = deps.fs;
  const path = deps.path;
  const readJson = (rel, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(workspaceDir, rel), "utf8"));
    } catch {
      return fallback;
    }
  };

  const parts = {};

  // ---- 往来：抖音评论串里的交替轮次 --------------------------------------
  const dy = readJson("state/douyin.json", { videos: {} });
  let turns = 0;
  let threads = 0;
  for (const v of Object.values(dy.videos || {})) {
    const comments = Array.isArray(v?.comments) ? v.comments : [];
    const t = countTurns(comments);
    if (t > 0) {
      turns += t;
      threads += 1;
    }
  }
  parts.turn = turns;

  // ---- 经验：留下来才算 ---------------------------------------------------
  //
  // `experience-pool.json` 里每条都有 status。只数 kept 和 dropped 之外的
  // 判定结果 —— 具体说：`kept` 算，`dropped` 不算。她判定「这条不要」也是
  // 一次判断，但没留下东西，所以不进这个数。判断本身进 `judged`。
  const pool = readJson("state/experience-pool.json", { entries: [] });
  const entries = Array.isArray(pool.entries) ? pool.entries : [];
  parts.kept = entries.filter((e) => String(e?.status || "") === "kept").length;

  // ---- 判断：自己写下来的 -------------------------------------------------
  const self = readJson("state/self.json", { notes: [] });
  parts.judged = Array.isArray(self.notes) ? self.notes.length : 0;

  let points = 0;
  for (const [k, n] of Object.entries(parts)) points += (WEIGHTS[k] || 0) * n;

  const stage = stageFor(points);
  return {
    points,
    stage: stage.id,
    stageLabel: stage.label,
    parts,
    // 额外给一个，方便描述里说清「跟多少人聊过」。不参与计分。
    threads,
    // 「还差多少」故意不给。给了就会被当成下一个要完成的目标。
    isMax: !nextFor(points),
  };
}

/**
 * 给她看的一句话。
 *
 * 只说走到哪一步和这一步是怎么攒起来的，不提下一步还差多少 —— 那会变成
 * 任务。她想往前就自己往前，不想就停在这儿，停在这儿也不欠谁。
 *
 * 没有往来的时候要如实说没有，不能拿别的数凑出一句话来。凑出来的那句会
 * 让人以为她在长大，而实际上一轮对话都没发生过。
 */
export function describe(workspaceDir, deps = {}) {
  const m = measure(workspaceDir, deps);
  const bits = [];
  if (m.parts.turn) bits.push(`跟人来回聊过 ${m.parts.turn} 轮`);
  if (m.parts.kept) bits.push(`留下 ${m.parts.kept} 条经验`);
  if (m.parts.judged) bits.push(`自己想明白 ${m.parts.judged} 条`);

  if (!bits.length) {
    return `你现在是【${m.stageLabel}】。还没跟人来回聊过，也还没留下什么经验——这不欠谁，遇上了就遇上了。`;
  }
  return `你现在是【${m.stageLabel}】。这些不是分数，是走到这儿为止已经有过的东西：${bits.join("，")}。`;
}

export { STAGES, WEIGHTS, countTurns };
