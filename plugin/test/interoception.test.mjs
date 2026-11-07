import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as intero from "../lib/interoception.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "intero-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

test("intero: 什么都没发生的时候四个数都是 0", () => {
  const ws = tmp();
  const s = intero.compute(ws, {});
  assert.equal(s.current.load, 0);
  assert.equal(s.current.uncertain, 0);
  assert.equal(s.current.blocked, 0);
  assert.equal(s.current.conflict, 0);
});

test("intero: 注入量涨了，负荷跟着涨", () => {
  const ws = tmp();
  const low = intero.compute(ws, { injectedChars: 3000 });
  const high = intero.compute(ws, { injectedChars: 20000 });
  assert.ok(high.current.load > low.current.load,
    `20000 字符应比 3000 更满，实际 ${high.current.load} vs ${low.current.load}`);
});

test("intero: 负荷封顶在 1", () => {
  const ws = tmp();
  const s = intero.compute(ws, { injectedChars: 999999 });
  assert.equal(s.current.load, 1);
});

test("intero: 没有预测样本时，不确定是 0 但标记为未知", () => {
  // 「不知道有多不确定」和「确定」都写成 0 会让这个数失去意义。
  // 必须有办法区分，否则统计上会误以为她很确定。
  const ws = tmp();
  const s = intero.compute(ws, { expectAccuracy: { count: 0, avgSurprise: null } });
  assert.equal(s.current.uncertain, 0);
  assert.equal(s.detail.uncertainKnown, false, "没有样本时必须是 known:false");
  assert.equal(s.detail.uncertainSamples, 0);
});

test("intero: 有预测样本时，不确定反映平均惊讶", () => {
  const ws = tmp();
  const s = intero.compute(ws, { expectAccuracy: { count: 8, avgSurprise: 0.6 } });
  assert.equal(s.current.uncertain, 0.6);
  assert.equal(s.detail.uncertainKnown, true);
  assert.equal(s.detail.uncertainSamples, 8);
});

test("intero: 目标三天没推进才算卡住", () => {
  const ws = tmp();
  const goals = {
    goals: [
      { id: "a", status: "active", last_progress_at: daysAgo(1) },   // 昨天动过，不算
      { id: "b", status: "active", last_progress_at: daysAgo(5) },   // 卡了
      { id: "c", status: "done", last_progress_at: daysAgo(30) },    // 已完成，不算
    ],
  };
  const s = intero.compute(ws, { goals });
  assert.equal(s.detail.goalsActive, 2, "只算 active 的，done 不算");
  assert.equal(s.detail.goalsStale, 1, "只有 b 该算卡住");
  assert.equal(s.current.blocked, 0.5, "两件里卡了一件，应是 0.5");
});

test("intero: 一个目标都没有时，受阻是 0 不是 1", () => {
  const ws = tmp();
  const s = intero.compute(ws, { goals: { goals: [] } });
  assert.equal(s.current.blocked, 0, "没目标不等于全卡住");
});

test("intero: 前两名差很小才算纠结", () => {
  const ws = tmp();
  const close = intero.compute(ws, {
    ranked: [{ score: 0.60 }, { score: 0.58 }],
  });
  const far = intero.compute(ws, {
    ranked: [{ score: 0.60 }, { score: 0.10 }],
  });
  assert.ok(close.current.conflict > far.current.conflict,
    `差 0.02 应比差 0.5 更纠结，实际 ${close.current.conflict} vs ${far.current.conflict}`);
  assert.equal(close.detail.contested, true, "差 0.02 应标记为 contested");
  assert.equal(far.detail.contested, false);
});

test("intero: 只有一个候选时不纠结", () => {
  const ws = tmp();
  const s = intero.compute(ws, { ranked: [{ score: 0.9 }] });
  assert.equal(s.current.conflict, 0, "只有一个选项谈不上犹豫");
  assert.equal(s.detail.topGap, null);
});

test("intero: 趋势要在第二次数之后才有意义", () => {
  const ws = tmp();
  const first = intero.compute(ws, { injectedChars: 3000 });
  assert.equal(first.trend.load, "flat", "第一次没有可比的上一轮");
  const second = intero.compute(ws, { injectedChars: 24000 });
  assert.equal(second.trend.load, "up", "从少到多应是 up");
});

test("intero: 变化很小的时候趋势算平的", () => {
  const ws = tmp();
  intero.compute(ws, { injectedChars: 12000 });
  const s = intero.compute(ws, { injectedChars: 12500 });
  assert.equal(s.trend.load, "flat", "小波动不该报方向");
});

test("intero: 快照能存能读", () => {
  const ws = tmp();
  intero.compute(ws, { injectedChars: 8000 });
  const r = intero.read(ws);
  assert.ok(r, "应该能读回来");
  assert.equal(typeof r.current.load, "number");
});

test("intero: 没有快照时 read 返回 null 不是空对象", () => {
  const ws = tmp();
  assert.equal(intero.read(ws), null);
});

test("intero: 平静的时候不开口", () => {
  // 四个数都低时不输出任何描述。平静不需要被告知。
  const ws = tmp();
  intero.compute(ws, {});
  assert.equal(intero.describe(ws), "");
});

test("intero: 负荷高的时候会说出来", () => {
  const ws = tmp();
  intero.compute(ws, { injectedChars: 20000 });
  assert.ok(intero.describe(ws).includes("多"), `应提到东西多，实际：${intero.describe(ws)}`);
});

test("intero: 同时卡着好几件事都会说", () => {
  const ws = tmp();
  intero.compute(ws, {
    injectedChars: 20000,
    expectAccuracy: { count: 5, avgSurprise: 0.8 },
    goals: { goals: [{ id: "a", status: "active", last_progress_at: daysAgo(10) }] },
    ranked: [{ score: 0.5 }, { score: 0.49 }],
  });
  const d = intero.describe(ws);
  assert.ok(d.length > 0);
  // 不该只说一句 —— 四个数都高的时候，只有一句描述等于丢信息
  assert.ok(d.split("，").length >= 3, `应该至少说三件事，实际：${d}`);
});

test("intero: 写盘失败不会抛出", () => {
  // 一个只读目录。这个函数不该因为存不下就中断整轮。
  const ws = "/proc/nonexistent-workspace-should-fail";
  const s = intero.compute(ws, { injectedChars: 5000 });
  assert.equal(typeof s.current.load, "number", "即使存不下也要返回结果");
});

test("intero: 有广播时用广播的 gap，不自己从 ranked 重算", () => {
  // 这是广播的第一个真实读者。之前它每轮写文件但没人读，
  // 内感知又拿 ranked 重算同一个数 —— 同一件事算两遍。
  const ws = tmp();
  const s = intero.compute(ws, {
    broadcast: { winner: { key: "a" }, gap: 0.42, contested: false, counts: { candidates: 5, aboveFloor: 2 } },
    // ranked 故意给一个完全不同的分差，如果用了它，结果会不一样
    ranked: [{ score: 0.9 }, { score: 0.89 }],
  });
  assert.equal(s.detail.conflictSource, "broadcast", "应该用广播");
  assert.equal(s.detail.topGap, 0.42, `gap 应从广播来，实际 ${s.detail.topGap}`);
});

test("intero: 广播说 contested 就是 contested，不看自己算的", () => {
  const ws = tmp();
  const s = intero.compute(ws, {
    broadcast: { winner: { key: "a" }, gap: 0.02, contested: false, counts: { candidates: 2, aboveFloor: 2 } },
    ranked: [{ score: 0.5 }, { score: 0.499 }],
  });
  // 广播判 false，就按 false —— 门槛只该在一个地方定义
  assert.equal(s.detail.contested, false, "以广播为准");
});

test("intero: 没有广播时回退到 ranked，并标出来源", () => {
  const ws = tmp();
  const s = intero.compute(ws, {
    broadcast: null,
    ranked: [{ score: 0.6 }, { score: 0.58 }],
  });
  assert.equal(s.detail.conflictSource, "ranked");
  assert.equal(s.detail.contested, true);
});

test("intero: 广播里没有赢家时不纠结", () => {
  const ws = tmp();
  const s = intero.compute(ws, {
    broadcast: { winner: null, gap: null, contested: false, counts: { candidates: 3, aboveFloor: 0 } },
    ranked: [{ score: 0.5 }, { score: 0.49 }],
  });
  assert.equal(s.current.conflict, 0, "没赢家谈不上犹豫");
});

test("intero: 广播的 suppressed 用 counts 之差，不数 ranked", () => {
  const ws = tmp();
  const s = intero.compute(ws, {
    broadcast: { winner: { key: "a" }, gap: 0.4, contested: false, counts: { candidates: 7, aboveFloor: 2 } },
    ranked: [],
  });
  assert.equal(s.detail.suppressed, 5, "7 个候选里 2 个过线，5 个被压");
});
