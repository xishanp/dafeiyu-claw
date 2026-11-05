import assert from "node:assert/strict";
import test from "node:test";

import * as decide from "../lib/decide.js";

test("detectBoundary: 直接指令识别为 stop", () => {
  assert.equal(decide.detectBoundary("不要给我发私信"), "stop");
  assert.equal(decide.detectBoundary("别再发消息了"), "stop");
  assert.equal(decide.detectBoundary("请勿私信我"), "stop");
});

test("detectBoundary: 第三人称守卫——引用别人不算", () => {
  assert.equal(decide.detectBoundary("他说不想聊"), "");
  assert.equal(decide.detectBoundary("我朋友说别发私信给我"), "");
  assert.equal(decide.detectBoundary("有人告诉我不要私信"), "");
});

test("detectBoundary: 结束语识别为 closed", () => {
  assert.equal(decide.detectBoundary("再见"), "closed");
  assert.equal(decide.detectBoundary("不聊了"), "closed");
  assert.equal(decide.detectBoundary("到此为止吧"), "closed");
});

test("detectBoundary: 普通对话不误判", () => {
  assert.equal(decide.detectBoundary("今天吃了什么"), "");
  assert.equal(decide.detectBoundary(""), "");
  assert.equal(decide.detectBoundary("这个视频不错"), "");
});

test("inQuietHours: 0-6 点", () => {
  assert.equal(decide.inQuietHours(0), true);
  assert.equal(decide.inQuietHours(3), true);
  assert.equal(decide.inQuietHours(5), true);
  assert.equal(decide.inQuietHours(6), false);
  assert.equal(decide.inQuietHours(14), false);
});

test("inQuietHours: 跨午夜区间", () => {
  assert.equal(decide.inQuietHours(23, 22, 7), true);
  assert.equal(decide.inQuietHours(2, 22, 7), true);
  assert.equal(decide.inQuietHours(12, 22, 7), false);
});

test("choose: boundary stop 优先于一切", () => {
  const r = decide.choose(
    { kind: "reach_out", score: 0.9 },
    { boundary: "stop", budgetExhausted: true, hour: 3 },
  );
  assert.equal(r.kind, "skip");
  assert.equal(r.reason, decide.GATES.BOUNDARY);
});

test("choose: 未确认发送一律不重试", () => {
  const r = decide.choose(
    { kind: "reach_out", score: 0.9 },
    { unresolvedSend: true, hour: 14, familiarity: 0.8 },
  );
  assert.equal(r.kind, "skip");
  assert.equal(r.reason, decide.GATES.UNRESOLVED);
});

test("choose: 关系太远不主动搭话", () => {
  const r = decide.choose(
    { kind: "reach_out", score: 0.9 },
    { hour: 14, familiarity: 0.2 },
  );
  assert.equal(r.kind, "skip");
  assert.equal(r.reason, decide.GATES.TOO_DISTANT);
});

test("choose: 关系够近但深夜 → defer 而非 skip", () => {
  const r = decide.choose(
    { kind: "reach_out", score: 0.9 },
    { hour: 3, familiarity: 0.8 },
  );
  assert.equal(r.kind, "defer");
  assert.equal(r.reason, decide.GATES.QUIET_HOURS);
});

test("choose: 刚说过话 → defer", () => {
  const r = decide.choose(
    { kind: "reach_out", score: 0.9 },
    { hour: 14, familiarity: 0.8, minutesSinceTalk: 5 },
  );
  assert.equal(r.kind, "defer");
  assert.equal(r.reason, decide.GATES.ALREADY_TALKED);
});

test("choose: dormant 且分数低 → rest，不是硬做", () => {
  const r = decide.choose(
    { kind: "topic", score: 0.3 },
    { hour: 14, phase: "dormant", minutesSinceTalk: 999 },
  );
  assert.equal(r.kind, "rest");
});

test("choose: dormant 但分数高 → do", () => {
  const r = decide.choose(
    { kind: "topic", score: 0.7 },
    { hour: 14, phase: "dormant", minutesSinceTalk: 999 },
  );
  assert.equal(r.kind, "do");
});

test("choose: 超预算 → skip", () => {
  const r = decide.choose(
    { kind: "topic", score: 0.9 },
    { hour: 14, budgetExhausted: true, minutesSinceTalk: 999 },
  );
  assert.equal(r.kind, "skip");
  assert.equal(r.reason, decide.GATES.BUDGET);
});

test("choose: 每日上限 → skip", () => {
  const r = decide.choose(
    { kind: "topic", score: 0.9 },
    { hour: 14, spokeToday: 15, minutesSinceTalk: 999 },
  );
  assert.equal(r.kind, "skip");
});

test("decide: 空列表 → rest", () => {
  const r = decide.decide([], { hour: 14 });
  assert.equal(r.kind, "rest");
  assert.equal(r.reason, "nothing-worth-doing");
});

test("decide: 只看排名第一的候选", () => {
  const ranked = [
    { kind: "topic", score: 0.8, id: "a" },
    { kind: "reach_out", score: 0.7, id: "b", familiarity: 0.1 },
  ];
  const r = decide.decide(ranked, { hour: 14, familiarity: 0.8, minutesSinceTalk: 999 });
  assert.equal(r.candidate.id, "a");
  assert.equal(r.kind, "do");
});

test("choose: 没有分数的候选不算候选（曾经的 bug：默认 do）", () => {
  for (const c of [{}, { kind: "topic" }, { kind: "topic", score: 0 },
                   { kind: "topic", score: NaN }, { kind: "topic", score: null }]) {
    const r = decide.choose(c, { hour: 14, minutesSinceTalk: 999 });
    assert.equal(r.kind, "skip", `候选 ${JSON.stringify(c)} 应被 skip`);
    assert.equal(r.reason, decide.GATES.UNSCORED);
  }
});

test("choose: 有正常分数照常 do", () => {
  const r = decide.choose({ kind: "topic", score: 0.5 }, { hour: 14, minutesSinceTalk: 999 });
  assert.equal(r.kind, "do");
});

test("社交闸门不该拦内部动作（2026-11-05 真机错误）", () => {
  // 12:20:13 实测：候选是 exp（想明白一件事），决策却是 defer
  // 理由 "already-talked-recently" —— 想事情不影响别人说话
  const ctx = { hour: 14, minutesSinceTalk: 10, spokeToday: 13 };
  for (const kind of ["experience", "pressure"]) {
    const r = decide.choose({ kind, score: 0.4 }, ctx);
    assert.equal(r.kind, "do", `${kind} 是内部动作，不该被社交闸门拦住`);
  }
  for (const kind of ["topic", "reach_out"]) {
    const r = decide.choose({ kind, score: 0.4 }, { ...ctx, familiarity: 0.8 });
    assert.equal(r.kind, "defer", `${kind} 是社交动作，刚说过话应 defer`);
  }
});

test("深夜也不拦内部动作", () => {
  const ctx = { hour: 3, minutesSinceTalk: 999, spokeToday: 0 };
  assert.equal(decide.choose({ kind: "experience", score: 0.5 }, ctx).kind, "do");
  assert.equal(decide.choose({ kind: "topic", score: 0.5 }, ctx).kind, "defer");
});

test("spokeToday 上限只管社交，不管内部", () => {
  const ctx = { hour: 14, minutesSinceTalk: 999, spokeToday: 99 };
  assert.equal(decide.choose({ kind: "pressure", score: 0.5 }, ctx).kind, "do");
  assert.equal(decide.choose({ kind: "topic", score: 0.5 }, ctx).kind, "skip");
});

test("budgetExhausted 对任何类型都生效", () => {
  const ctx = { hour: 14, minutesSinceTalk: 999, spokeToday: 0, budgetExhausted: true };
  assert.equal(decide.choose({ kind: "experience", score: 0.5 }, ctx).kind, "skip");
});
