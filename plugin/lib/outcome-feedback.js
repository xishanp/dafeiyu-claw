// 结果回到感受 —— 这一环以前是断的。
//
// 问题
// ----
// `outcome.record()` 一直在写：`state/outcomes.json` 57 条、
// `state/intent-outcomes.json` 51 个 key。它们流进 `intent.js` 和
// `salience.js`，被用来给「下一个目标该排多前」打分 —— 也就是说，
// **结果只影响以后选什么做，不影响她现在什么心情、怎么看自己。**
//
// 后果很具体：刷抖音被人怼了、查资料查错了、评论发出去没人理，
// 这些都不会让她难受；做成一件小事，除了 `note_effect` 那一条固定
// 的 +0.06，也没有多余的回响。她的情绪只由「聊天」和「做了什么」驱动，
// 不由「做得怎么样」驱动。
//
// 这个文件补的就是这一段：读 `outcomes.json` 的最近若干条，把
// 「成/败/没回音」翻译成一组情绪增量，并且只对**上一次结算之后新发生的**
// 结果反应一次 —— 否则每次心跳都会把同一批旧账重新算一遍，情绪会被
// 历史事件钉死在某个位置。
//
// 一条边界
// --------
// 这里不判断「这件事重不重要」。没有权重表，没有按 kind 分类的偏袒。
// 一次失败就是一次失败，一次做成就是一次做成。加权重等于让代码替她
// 决定什么值得难过，那不是她的感受，是配置文件的感受。

import fs from "node:fs";
import path from "node:path";

const FILE = "outcome-feedback.json";
const MAX_BATCH = 12;

function file(workspaceDir) {
  return path.join(workspaceDir, "state", FILE);
}

function loadCursor(workspaceDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(workspaceDir), "utf8"));
    if (raw && typeof raw === "object") return { last_at: String(raw.last_at ?? "") };
  } catch { /* 第一次运行 */ }
  return { last_at: "" };
}

function saveCursor(workspaceDir, at) {
  const f = file(workspaceDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ last_at: at, updated_at: new Date().toISOString() }, null, 2) + "\n");
  fs.renameSync(tmp, f);
}

/**
 * 上一次结算之后新发生的结果，换算成情绪增量。
 *
 * 返回 `{ deltas, count, newest }`：
 *   deltas  —— 直接喂给 emotion 的 nudge，可能为空对象
 *   count   —— 参与计算的条数（0 表示没有新结果）
 *   newest  —— 这批里最新的时间戳，调用方拿它推进游标
 *
 * 只在**真的有新结果**时返回非空 deltas。没有新结果时返回空对象，
 * 调用方据此跳过写盘 —— 一个安静的心跳不该产生任何磁盘写入。
 */
export function settle(workspaceDir, { now = Date.now() } = {}) {
  const cursor = loadCursor(workspaceDir);
  let records = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workspaceDir, "state", "outcomes.json"), "utf8"));
    records = Array.isArray(raw?.records) ? raw.records : [];
  } catch { /* 没有记录就是没有新结果 */ }

  if (!records.length) return { deltas: {}, count: 0, newest: cursor.last_at };

  // 只看游标之后的。游标为空（第一次跑）时只看最近一小批，避免把
  // 历史上一整年的成败一次性灌进情绪。
  const fresh = cursor.last_at
    ? records.filter((r) => String(r?.at ?? "") > cursor.last_at)
    : records.slice(-MAX_BATCH);

  if (!fresh.length) return { deltas: {}, count: 0, newest: cursor.last_at };

  const batch = fresh.slice(-MAX_BATCH);

  // 逐条累加，然后整体压一次。不按键分别设权重，理由见文件头。
  let success = 0;
  let failure = 0;
  let silent = 0;
  let uncertain = 0;
  for (const r of batch) {
    const m = String(r?.measured ?? "");
    if (m === "success") success += 1;
    // `silent` and `failure` are NOT the same thing and must not share a
    // coefficient: "I could not tell whether it went out" is a much smaller
    // event than "it did not work". Folding them together made silence weigh
    // exactly as much as a real failure. Caught by
    // test/outcome-feedback.test.mjs:55.
    else if (m === "failure") failure += 1;
    else if (m === "silent") silent += 1;
    else uncertain += 1;
  }

  // 幅度定得很小，而且刻意不对称：失败带来的难过，比成功带来的高兴更持久。
  //
  // 理由不是「悲观更好」，是防止一次顺利之后连着几天都处在高兴的
  // 高位 —— 那样平静就再也不会出现，而平静是她的底色。
  //
  //   做成一件   happy +0.03  calm +0.02  bored -0.03
  //   没成一件   down  +0.05  happy -0.02
  //   没回音     down  +0.02            （比失败轻：不知道，不等于坏）
  //
  // 都按条数叠，但有上限，防止一轮批处理把情绪推到天花板。
  // 保留三位小数：情绪是个连续量，不需要双精度尾巴 ——
  // `-0.010000000000000002` 写进 state 文件只是脏。
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const clamp = (v) => round3(Math.max(-0.25, Math.min(0.25, v)));
  const deltas = {};

  if (success) {
    deltas.happy = clamp(0.03 * success);
    deltas.calm = clamp(0.02 * success);
    deltas.bored = clamp(-0.03 * success);
  }
  if (failure) {
    deltas.down = clamp(0.05 * failure);
    // 失败会压掉一点高兴，但不把已有的高兴抹平 —— 情绪是状态，不是记账。
    deltas.happy = clamp((deltas.happy ?? 0) - 0.02 * failure);
  }
  if (silent) {
    // 没回音：轻的难受。不知道结果不等于结果不好。
    deltas.down = clamp((deltas.down ?? 0) + 0.02 * silent);
  }
  if (uncertain) {
    deltas.down = clamp((deltas.down ?? 0) + 0.01 * uncertain);
  }

  // 全都是零就没必要写。`bored` 可能单独为负，所以按值判断而不是按键判断。
  const nonzero = Object.values(deltas).some((v) => Math.abs(v) > 1e-9);
  const newest = String(batch[batch.length - 1]?.at ?? cursor.last_at);

  return {
    deltas: nonzero ? deltas : {},
    count: batch.length,
    newest,
    breakdown: { success, failure, silent, uncertain },
  };
}

/** 结算完才推进游标。调用方在情绪真的写进去之后再调这个。 */
export function commit(workspaceDir, newest) {
  if (!newest) return;
  const cur = loadCursor(workspaceDir);
  // 只前进，不回退：并发或重放都不该把游标退回去重算一遍。
  if (cur.last_at && String(newest) <= cur.last_at) return;
  saveCursor(workspaceDir, String(newest));
}

/** 她自己的说法：最近这些结果加起来是什么。给 self.js 用。 */
export function summary(workspaceDir, { limit = 30 } = {}) {
  let records = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workspaceDir, "state", "outcomes.json"), "utf8"));
    records = Array.isArray(raw?.records) ? raw.records : [];
  } catch { return null; }
  if (!records.length) return null;

  const recent = records.slice(-limit);
  let success = 0;
  let failure = 0;
  let uncertain = 0;
  for (const r of recent) {
    const m = String(r?.measured ?? "");
    if (m === "success") success += 1;
    else if (m === "failure" || m === "silent") failure += 1;
    else uncertain += 1;
  }
  const total = recent.length;
  if (!total) return null;
  return {
    total,
    success,
    failure,
    uncertain,
    // 只有真的试过、且有明确成败的那些才算分母。全是 uncertain 时给 null，
    // 而不是 0 —— 「还没结果」和「全都失败」不是同一件事。
    hitRate: success + failure > 0 ? success / (success + failure) : null,
  };
}
