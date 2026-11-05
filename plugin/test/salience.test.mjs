import assert from "node:assert/strict";
import test from "node:test";

import * as salience from "../lib/salience.js";

test("priorOf: 零次尝试返回 0.5，不是 0", () => {
  assert.equal(salience.priorOf({}), 0.5);
  assert.equal(salience.priorOf({ successes: 0, failures: 0 }), 0.5);
});

test("priorOf: 有成功有失败时平滑", () => {
  // (1+1)/(1+1+2) = 0.5
  assert.equal(salience.priorOf({ successes: 1, failures: 1 }), 0.5);
  // (3+1)/(3+0+2) = 0.8
  assert.equal(salience.priorOf({ successes: 3, failures: 0 }), 0.8);
  // (0+1)/(0+3+2) = 0.2
  assert.equal(salience.priorOf({ successes: 0, failures: 3 }), 0.2);
});

test("priorOf: alpha=0 时退化为原始比率", () => {
  assert.equal(salience.priorOf({ successes: 0, failures: 0 }, 0), 0);
  assert.equal(salience.priorOf({ successes: 1, failures: 1 }, 0), 0.5);
});

test("scoreCandidate: 停滞降权但不归零", () => {
  const base = { value: 1, outcomes: { successes: 1, failures: 1 } };
  assert.equal(salience.scoreCandidate(base), 0.5);
  assert.equal(salience.scoreCandidate({ ...base, stalled: true }), 0.125);
  // 0.5 * 0.25，仍然大于 0
  assert.ok(salience.scoreCandidate({ ...base, stalled: true }) > 0);
});

test("scoreCandidate: value 为 0 则整体为 0", () => {
  assert.equal(salience.scoreCandidate({ value: 0, outcomes: {} }), 0);
});

test("scoreCandidate: 乘法不是加权和", () => {
  // 有价值但 prior 极低 → 结果远低于 value 的一半
  const s = salience.scoreCandidate({ value: 1, outcomes: { successes: 0, failures: 20 } });
  assert.ok(s < 0.1, `期望 <0.1，实得 ${s}`);
});

test("rank: 全部低于门槛时 do 为空", () => {
  const cands = [
    { id: "a", value: 0.1, outcomes: { successes: 0, failures: 5 } },
    { id: "b", value: 0.05, outcomes: {} },
  ];
  const r = salience.rank(cands, { threshold: 0.25 });
  assert.equal(r.do.length, 0);
  assert.equal(r.below.length, 2);
});

test("rank: 按分数降序", () => {
  const cands = [
    { id: "low", value: 0.3, outcomes: {} },
    { id: "high", value: 0.9, outcomes: {} },
  ];
  const r = salience.rank(cands, { threshold: 0.25 });
  assert.equal(r.ranked[0].id, "high");
  assert.equal(r.do[0].id, "high");
});

test("rank: 同分时按 id 稳定排序", () => {
  const cands = [
    { id: "b", value: 0.5, outcomes: {} },
    { id: "a", value: 0.5, outcomes: {} },
  ];
  const r = salience.rank(cands);
  assert.deepEqual(r.ranked.map((c) => c.id), ["a", "b"]);
});

test("applyPenalty: uncertain 归零", () => {
  assert.equal(salience.applyPenalty(0.8, "uncertain"), 0);
});

test("applyPenalty: silent 打六折", () => {
  assert.equal(salience.applyPenalty(1, "silent"), 0.4);
});

test("applyPenalty: success 不罚", () => {
  assert.equal(salience.applyPenalty(0.8, "success"), 0.8);
});

test("freshness: 半衰期正确", () => {
  assert.equal(salience.freshness(0, 24), 1);
  assert.equal(salience.freshness(24, 24), 0.5);
  assert.equal(salience.freshness(48, 24), 0.25);
});

test("rank 对空数组不炸", () => {
  const r = salience.rank([]);
  assert.deepEqual(r.do, []);
  assert.deepEqual(r.ranked, []);
});
