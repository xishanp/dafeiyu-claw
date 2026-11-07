import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as expect from "../lib/expect.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "expect-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

test("expect: 没有预测过的时候，精度是 null 不是 0", () => {
  const ws = tmp();
  const a = expect.accuracy(ws);
  assert.equal(a.count, 0);
  // 0 会被读成「准度为零」，实际意思是「还没数据」。这两个必须分开。
  assert.equal(a.hitRate, null, "没有数据时 hitRate 必须是 null");
});

test("expect: 猜中九成、结果成了，惊讶很小", () => {
  const ws = tmp();
  expect.predict(ws, { key: "k1", what: "发这条能成", expect: 0.9 });
  const r = expect.settle(ws, {
    records: [{ key: "k1", measured: "success", at: iso(1000) }],
  });
  assert.equal(r.settled.length, 1);
  assert.equal(r.settled[0].surprise, 0.1);
});

test("expect: 猜中九成、结果没成，惊讶很大", () => {
  const ws = tmp();
  expect.predict(ws, { key: "k1", what: "发这条能成", expect: 0.9 });
  const r = expect.settle(ws, {
    records: [{ key: "k1", measured: "failure", at: iso(1000) }],
  });
  assert.equal(r.settled[0].surprise, 0.9);
});

test("expect: 惊讶是对称的，方向不影响大小", () => {
  // 以为九成会成、结果没成（0.9）和 以为只有一成会成、结果成了（0.9）
  // 说明的是同一件事：模型错了，而且错得一样多。
  const ws = tmp();
  expect.predict(ws, { key: "a", what: "", expect: 0.9 });
  expect.predict(ws, { key: "b", what: "", expect: 0.1 });
  const r = expect.settle(ws, {
    records: [
      { key: "a", measured: "failure", at: iso(1000) },
      { key: "b", measured: "success", at: iso(1000) },
    ],
  });
  const sa = r.settled.find((x) => x.key === "a").surprise;
  const sb = r.settled.find((x) => x.key === "b").surprise;
  assert.equal(sa, sb, `对称误差应相等，实际 ${sa} vs ${sb}`);
});

test("expect: 没回音不算猜错，预期留在 open 继续等", () => {
  // silent 是「不知道结果」，不是「结果不好」。把它算成失误会让惊讶值
  // 一路虚高，最后她对每一次沉默都当成失败。
  const ws = tmp();
  expect.predict(ws, { key: "k1", what: "", expect: 0.8 });
  const r = expect.settle(ws, {
    records: [{ key: "k1", measured: "silent", at: iso(1000) }],
  });
  assert.equal(r.settled.length, 0, "silent 不该结算");
  assert.equal(expect.accuracy(ws).open, 1, "应该还挂在 open 里");
});

test("expect: 结果早于预测的不配对", () => {
  const ws = tmp();
  expect.predict(ws, { key: "k1", what: "", expect: 0.5, at: iso(0) });
  const r = expect.settle(ws, {
    records: [{ key: "k1", measured: "success", at: iso(-5000) }],
  });
  assert.equal(r.settled.length, 0, "旧结果不该用来结算新预期");
});

test("expect: 六小时之外的结果不配对", () => {
  const ws = tmp();
  expect.predict(ws, { key: "k1", what: "", expect: 0.5, at: iso(-7 * 3600 * 1000) });
  const r = expect.settle(ws, {
    records: [{ key: "k1", measured: "success", at: iso(-6.5 * 3600 * 1000) }],
  });
  assert.equal(r.settled.length, 0, "太久以前的对不上同一次行动");
});

test("expect: key 不同的不配对", () => {
  const ws = tmp();
  expect.predict(ws, { key: "k1", what: "", expect: 0.5 });
  const r = expect.settle(ws, {
    records: [{ key: "k2", measured: "success", at: iso(1000) }],
  });
  assert.equal(r.settled.length, 0);
});

test("expect: 同一件事再预测一次会覆盖，不是插两条", () => {
  const ws = tmp();
  expect.predict(ws, { key: "k1", what: "第一次估", expect: 0.2 });
  expect.predict(ws, { key: "k1", what: "改主意了", expect: 0.8 });
  const r = expect.settle(ws, {
    records: [{ key: "k1", measured: "success", at: iso(1000) }],
  });
  assert.equal(r.settled.length, 1, "应该只结算一条");
  assert.equal(r.settled[0].expect, 0.8, "应该用后来那次预测");
});

test("expect: 没估分时记下 guessed=false，不和真的估了0.5混淆", () => {
  const ws = tmp();
  const r = expect.predict(ws, { key: "k1", what: "" });
  assert.equal(r.expect, 0.5);
  assert.equal(r.guessed, false, "没估过不能假装估过");
});

test("expect: 没有 key 就拒绝，不写垃圾数据", () => {
  const ws = tmp();
  const r = expect.predict(ws, { key: "  ", what: "某个东西" });
  assert.equal(r.ok, false);
  assert.equal(expect.accuracy(ws).open, 0);
});

test("expect: 猜中率高时能看出来（这是要警惕的信号）", () => {
  // 一直猜对说明她只在有把握的事上下注，预测退化成记账。
  // 这个数本身不该报警，但必须算得出来。
  const ws = tmp();
  for (let i = 0; i < 5; i += 1) expect.predict(ws, { key: `k${i}`, what: "", expect: 0.95 });
  expect.settle(ws, {
    records: [0, 1, 2, 3, 4].map((i) => ({ key: `k${i}`, measured: "success", at: iso(1000) })),
  });
  const a = expect.accuracy(ws);
  assert.equal(a.count, 5);
  assert.equal(a.hitRate, 1);
});

test("expect: 结算后从 open 移走，不会重复结算", () => {
  const ws = tmp();
  expect.predict(ws, { key: "k1", what: "", expect: 0.9 });
  const first = expect.settle(ws, {
    records: [{ key: "k1", measured: "failure", at: iso(1000) }],
  });
  assert.equal(first.settled.length, 1);
  // 同一批记录再来一次，不该再结算一次。
  const second = expect.settle(ws, {
    records: [{ key: "k1", measured: "failure", at: iso(1000) }],
  });
  assert.equal(second.settled.length, 0, "已经结算过的不能再算一遍");
});

test("expect: 状态能存能读", () => {
  const ws = tmp();
  expect.predict(ws, { key: "k1", what: "存一下", expect: 0.7 });
  const raw = JSON.parse(fs.readFileSync(path.join(ws, "state", "expectations.json"), "utf8"));
  assert.equal(raw.open.length, 1);
  assert.equal(raw.open[0].key, "k1");
  assert.equal(raw.open[0].expect, 0.7);
});

test("expect: 空目录不是错误", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "expect-empty-"));
  const r = expect.settle(ws, { records: [] });
  assert.deepEqual(r.settled, []);
});
