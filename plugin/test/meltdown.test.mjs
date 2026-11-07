import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as compulsion from "../lib/compulsion.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "melt-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};

// ---------------------------------------------------------------------------
// 独立计次：不能靠 picks 窗口

test("counts: 挑过就累加，和 picks 是两套", () => {
  const ws = tmp();
  compulsion.recordPick(ws, "curiosity:n-1");
  compulsion.recordPick(ws, "curiosity:n-1");
  const data = compulsion.loadState(ws);
  assert.equal(compulsion.pickCount(data, "curiosity:n-1"), 2);
});

test("counts: picks 被挤出去之后，counts 还在", () => {
  // 这是 picks 窗口解决不了的那个洞。实测 2026-11-06 历史正好 40 条，
  // 也就是下一轮开始丢最早的证据 —— 而环还在跑。
  const ws = tmp();
  compulsion.recordPick(ws, "curiosity:n-target");
  for (let i = 0; i < 60; i++) compulsion.recordPick(ws, `curiosity:n-noise-${i}`);

  const data = compulsion.loadState(ws);
  assert.equal(data.picks.length, 40, "窗口仍然被限制在 40");
  assert.ok(
    !data.picks.some((p) => p.id === "curiosity:n-target"),
    "目标已经被挤出窗口",
  );
  assert.equal(
    compulsion.pickCount(data, "curiosity:n-target"),
    1,
    "但计数还在 —— 这是钥匙",
  );
});

test("counts: 不同的 id 分开数", () => {
  const ws = tmp();
  compulsion.recordPick(ws, "exp:exp-01");
  compulsion.recordPick(ws, "exp:exp-01");
  compulsion.recordPick(ws, "exp:exp-02");
  const data = compulsion.loadState(ws);
  assert.equal(compulsion.pickCount(data, "exp:exp-01"), 2);
  assert.equal(compulsion.pickCount(data, "exp:exp-02"), 1);
});

// ---------------------------------------------------------------------------
// overPicked：谁该熔断

test("overPicked: 挑过两次的就该切", () => {
  const ws = tmp();
  compulsion.recordPick(ws, "curiosity:n-a");
  compulsion.recordPick(ws, "curiosity:n-a");
  compulsion.recordPick(ws, "curiosity:n-b");
  const over = compulsion.overPicked(compulsion.loadState(ws));
  assert.ok(over.has("curiosity:n-a"));
  assert.ok(!over.has("curiosity:n-b"), "只挑过一次的不切");
});

test("overPicked: 阈值就是 STREAK_ALARM=2", () => {
  assert.equal(compulsion.STREAK_ALARM, 2, "用户定的数：做两次就熔断");
  const ws = tmp();
  compulsion.recordPick(ws, "x:1");
  assert.equal(compulsion.overPicked(compulsion.loadState(ws)).has("x:1"), false);
  compulsion.recordPick(ws, "x:1");
  assert.equal(compulsion.overPicked(compulsion.loadState(ws)).has("x:1"), true);
});

test("overPicked: 没有历史时返回空集，不炸", () => {
  const ws = tmp();
  assert.equal(compulsion.overPicked(compulsion.loadState(ws)).size, 0);
});

test("counts: 老文件没有 counts 字段也能读", () => {
  // 真实 state/compulsion.json 现在是 {version, updated_at, picks}，
  // 没有 counts。读的时候不能抛。
  const ws = tmp();
  fs.writeFileSync(
    path.join(ws, "state", "compulsion.json"),
    JSON.stringify({ version: 1, updated_at: null, picks: [{ id: "a", key: "a", at: "2026-11-06T00:00:00Z" }] }),
  );
  const data = compulsion.loadState(ws);
  assert.equal(compulsion.pickCount(data, "a"), 0, "老文件没有 counts，当成 0");
  assert.equal(compulsion.overPicked(data).size, 0);
});

test("counts: 老文件写入时会补出 counts", () => {
  const ws = tmp();
  fs.writeFileSync(
    path.join(ws, "state", "compulsion.json"),
    JSON.stringify({ version: 1, updated_at: null, picks: [] }),
  );
  compulsion.recordPick(ws, "curiosity:n-new");
  const data = compulsion.loadState(ws);
  assert.equal(typeof data.counts, "object");
  assert.equal(data.counts["curiosity:n-new"], 1);
});
