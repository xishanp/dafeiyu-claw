import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as of from "../lib/outcome-feedback.js";
import * as self from "../lib/self.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};
const agoMin = (m) => new Date(Date.now() - m * 60000).toISOString();

function writeOutcomes(ws, records) {
  fs.writeFileSync(
    path.join(ws, "state", "outcomes.json"),
    JSON.stringify({ version: 1, records }),
  );
}

// ---- 结果回到感受 ---------------------------------------------------------

test("feedback: 做成一件事高兴一点，无聊感降一点", () => {
  const ws = tmp();
  writeOutcomes(ws, [{ at: agoMin(5), key: "a", measured: "success" }]);
  const r = of.settle(ws);
  assert.equal(r.count, 1);
  assert.ok(r.deltas.happy > 0, "该高兴");
  assert.ok(r.deltas.bored < 0, "该少一点无聊");
});

test("feedback: 没做成会难一点，而且比做成的影响大", () => {
  const ws = tmp();
  writeOutcomes(ws, [{ at: agoMin(5), key: "a", measured: "failure" }]);
  const r = of.settle(ws);
  assert.ok(r.deltas.down > 0, "该低落");
  // 同一件事，失败带来的量级要大于成功带来的
  const ws2 = tmp();
  writeOutcomes(ws2, [{ at: agoMin(5), key: "b", measured: "success" }]);
  const ok = of.settle(ws2);
  assert.ok(r.deltas.down > Math.abs(ok.deltas.happy), "失败比成功重");
});

test("feedback: 没回音算轻的难受，不算失败", () => {
  const ws = tmp();
  writeOutcomes(ws, [{ at: agoMin(5), key: "a", measured: "silent" }]);
  const r = of.settle(ws);
  assert.ok(r.deltas.down > 0);
  const ws2 = tmp();
  writeOutcomes(ws2, [{ at: agoMin(5), key: "a", measured: "failure" }]);
  const fail = of.settle(ws2);
  assert.ok(r.deltas.down < fail.deltas.down, "没回音比明确失败轻");
});

test("feedback: 结算过的不再重算 —— 同一批不产生第二次情绪", () => {
  const ws = tmp();
  writeOutcomes(ws, [
    { at: agoMin(30), key: "a", measured: "success" },
    { at: agoMin(20), key: "b", measured: "failure" },
  ]);
  const first = of.settle(ws);
  assert.ok(first.count > 0);
  of.commit(ws, first.newest);

  const second = of.settle(ws);
  assert.equal(second.count, 0, "不该重算旧账");
  assert.deepEqual(second.deltas, {});
});

test("feedback: 有新结果时才再动一次", () => {
  const ws = tmp();
  const t1 = "2026-11-07T01:00:00.000Z";
  const t2 = "2026-11-07T02:00:00.000Z";

  writeOutcomes(ws, [{ at: t1, key: "a", measured: "success" }]);
  const first = of.settle(ws);
  assert.equal(first.count, 1);
  of.commit(ws, first.newest);

  // 追加一条更新的
  writeOutcomes(ws, [
    { at: t1, key: "a", measured: "success" },
    { at: t2, key: "b", measured: "failure" },
  ]);
  const second = of.settle(ws);
  assert.equal(second.count, 1, "只算新那条");
  assert.equal(second.breakdown.failure, 1);
  assert.equal(second.breakdown.success, 0, "旧的不该被重算");
});

test("feedback: 一条记录都没有时安静，不报错", () => {
  const ws = tmp();
  const r = of.settle(ws);
  assert.equal(r.count, 0);
  assert.deepEqual(r.deltas, {});
});

test("feedback: 全是 uncertain 时不动情绪", () => {
  const ws = tmp();
  writeOutcomes(ws, [
    { at: agoMin(10), key: "a", measured: "uncertain" },
    { at: agoMin(5), key: "b", measured: "uncertain" },
  ]);
  const r = of.settle(ws);
  // uncertain 只轻微压一点，不该有 happy/bored 那种大动作
  assert.ok(!r.deltas.happy, "没结果不该让人高兴");
  assert.ok(!r.deltas.bored, "没结果不该改变无聊感");
});

test("feedback: 一堆成功也不会把情绪推到天上", () => {
  const ws = tmp();
  writeOutcomes(
    ws,
    Array.from({ length: 20 }, (_, i) => ({ at: agoMin(30 - i), key: `k${i}`, measured: "success" })),
  );
  const r = of.settle(ws);
  for (const [k, v] of Object.entries(r.deltas)) {
    assert.ok(Math.abs(v) <= 0.25, `${k} 增量 ${v} 超了上限`);
  }
});

test("feedback: 游标只前进不回退", () => {
  const ws = tmp();
  writeOutcomes(ws, [{ at: agoMin(5), key: "a", measured: "success" }]);
  const r = of.settle(ws);
  of.commit(ws, r.newest);
  const before = of.settle(ws).count;
  of.commit(ws, agoMin(100)); // 一个更早的时间
  const after = of.settle(ws).count;
  assert.equal(before, 0);
  assert.equal(after, 0, "不该因为回退游标而重算");
});

// ---- 自画像看成绩 ---------------------------------------------------------

test("self: 分得清「做得多」和「做得成」", () => {
  const ws = tmp();
  writeOutcomes(ws, [
    { at: agoMin(10), key: "a", measured: "failure" },
    { at: agoMin(9), key: "b", measured: "failure" },
    { at: agoMin(8), key: "c", measured: "success" },
  ]);
  fs.writeFileSync(
    path.join(ws, "state", "effects.json"),
    JSON.stringify({ entries: [{ at: agoMin(5), ref: "/tmp/x", verified: true }] }),
  );
  fs.writeFileSync(path.join(ws, "state", "deeds.json"), JSON.stringify({ entries: [] }));
  const s = self.refresh(ws);
  assert.equal(s.ability.hit_ok, 1);
  assert.equal(s.ability.hit_no, 2);
  assert.ok(Math.abs(s.ability.hit_rate - 1 / 3) < 1e-9);
});

test("self: 一次都没试过时是 null，不是 0", () => {
  const ws = tmp();
  writeOutcomes(ws, []);
  fs.writeFileSync(
    path.join(ws, "state", "effects.json"),
    JSON.stringify({ entries: [{ at: agoMin(5), ref: "/tmp/x", verified: true }] }),
  );
  fs.writeFileSync(path.join(ws, "state", "deeds.json"), JSON.stringify({ entries: [] }));
  const s = self.refresh(ws);
  assert.equal(s.ability.hit_rate, null, "没试过 ≠ 全失败");
  assert.equal(s.ability.tried_recent, 0);
});

test("self: 试得太少时不在那句话里报成绩", () => {
  const ws = tmp();
  writeOutcomes(ws, [
    { at: agoMin(10), key: "a", measured: "success" },
    { at: agoMin(9), key: "b", measured: "success" },
  ]);
  fs.writeFileSync(
    path.join(ws, "state", "effects.json"),
    JSON.stringify({ entries: [{ at: agoMin(5), ref: "/tmp/x", verified: true }] }),
  );
  fs.writeFileSync(path.join(ws, "state", "deeds.json"), JSON.stringify({ entries: [] }));
  const s = self.refresh(ws);
  assert.ok(!/成了|只成了/.test(s.line), "两条不足以说命中率");
});

// ---- 成绩只数真做了的，不数记账 -------------------------------------------

test("self: 归档一条经验不算做成了一件事", () => {
  const ws = tmp();
  writeOutcomes(ws, [
    // 真的做了并成功的
    { at: agoMin(30), key: "real:1", kind: "effect", measured: "success" },
    // experience_resolve 记的 success —— 归档动作，不是产出
    { at: agoMin(20), key: "exp:1", kind: "experience", measured: "success",
      detail: { via: "experience_resolve", decision: "drop" } },
    { at: agoMin(19), key: "exp:2", kind: "experience", measured: "success",
      detail: { via: "experience_resolve", decision: "keep" } },
    // 真的失败
    { at: agoMin(10), key: "real:2", kind: "effect", measured: "failure" },
  ]);
  fs.writeFileSync(
    path.join(ws, "state", "effects.json"),
    JSON.stringify({ entries: [{ at: agoMin(5), ref: "/tmp/x", verified: true }] }),
  );
  fs.writeFileSync(path.join(ws, "state", "deeds.json"), JSON.stringify({ entries: [] }));

  const s = self.refresh(ws);
  assert.equal(s.ability.tried_recent, 2, "只算真的那两条");
  assert.equal(s.ability.hit_ok, 1);
  assert.equal(s.ability.hit_no, 1);
  assert.ok(Math.abs(s.ability.hit_rate - 0.5) < 1e-9);
});

test("self: 全是记账动作时不报命中率", () => {
  const ws = tmp();
  writeOutcomes(ws, [
    { at: agoMin(20), key: "exp:1", kind: "experience", measured: "success",
      detail: { via: "experience_resolve", decision: "keep" } },
    { at: agoMin(19), key: "exp:2", kind: "experience", measured: "success",
      detail: { via: "experience_resolve", decision: "drop" } },
    { at: agoMin(18), key: "exp:3", kind: "experience", measured: "success",
      detail: { via: "experience_resolve", decision: "drop" } },
    { at: agoMin(17), key: "exp:4", kind: "experience", measured: "success",
      detail: { via: "experience_resolve", decision: "keep" } },
    { at: agoMin(16), key: "exp:5", kind: "experience", measured: "success",
      detail: { via: "experience_resolve", decision: "keep" } },
  ]);
  fs.writeFileSync(
    path.join(ws, "state", "effects.json"),
    JSON.stringify({ entries: [{ at: agoMin(5), ref: "/tmp/x", verified: true }] }),
  );
  fs.writeFileSync(path.join(ws, "state", "deeds.json"), JSON.stringify({ entries: [] }));

  const s = self.refresh(ws);
  assert.equal(s.ability.tried_recent, 0, "记账不算试过");
  assert.equal(s.ability.hit_rate, null);
  assert.ok(!/成了/.test(s.line), "不该凭记账说自己成了几件");
});
