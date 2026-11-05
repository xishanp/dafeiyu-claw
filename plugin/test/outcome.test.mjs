import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as intent from "../lib/intent.js";
import * as outcome from "../lib/outcome.js";

function tmpWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "outcome-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
}

test("record: 拒绝非法 measured", () => {
  const ws = tmpWs();
  const r = outcome.record(ws, { key: "k", measured: "很好" });
  assert.equal(r.ok, false);
});

test("record: success 抬高 prior，failure 压低", () => {
  const ws = tmpWs();
  outcome.record(ws, { key: "k", kind: "topic", measured: "success" });
  outcome.record(ws, { key: "k", kind: "topic", measured: "success" });
  const up = intent.outcomesFor(ws, "k");
  assert.equal(up.successes, 2);

  outcome.record(ws, { key: "j", kind: "topic", measured: "failure" });
  const down = intent.outcomesFor(ws, "j");
  assert.equal(down.failures, 1);
});

test("record: uncertain 不记成败", () => {
  const ws = tmpWs();
  outcome.record(ws, { key: "u", kind: "reach_out", measured: "uncertain" });
  const o = intent.outcomesFor(ws, "u");
  assert.equal(o.successes, 0);
  assert.equal(o.failures, 0);
});

test("unresolvedFor: 最后一条 uncertain 则阻塞", () => {
  const ws = tmpWs();
  outcome.record(ws, { key: "x", kind: "reach_out", measured: "uncertain" });
  assert.equal(outcome.unresolvedFor(ws, "x"), true);

  // 后续确认成功则解除
  outcome.record(ws, { key: "x", kind: "reach_out", measured: "success" });
  assert.equal(outcome.unresolvedFor(ws, "x"), false);
});

test("agrees: 声称成功但实测 silent → 不一致", () => {
  assert.equal(outcome.agrees({ claimed: "发出去了", measured: "silent" }), false);
});

test("agrees: 声称成功且实测成功 → 一致", () => {
  assert.equal(outcome.agrees({ claimed: "发出去了", measured: "success" }), true);
});

test("agrees: 没有声称 → null", () => {
  assert.equal(outcome.agrees({ claimed: null, measured: "success" }), null);
});

test("silent 被记成失败（供打分降权）", () => {
  const ws = tmpWs();
  outcome.record(ws, { key: "s", kind: "reach_out", measured: "silent" });
  assert.equal(intent.outcomesFor(ws, "s").failures, 1);
});

test("alreadyJudged: 判过就不再重复记", () => {
  const ws = tmpWs();
  const key = "exp:x1";
  assert.equal(outcome.alreadyJudged(ws, key), false);
  outcome.record(ws, { key, kind: "experience", measured: "success" });
  assert.equal(outcome.alreadyJudged(ws, key), true);
  // 再记一次不应发生，模拟调用方的守卫
  if (!outcome.alreadyJudged(ws, key)) {
    outcome.record(ws, { key, kind: "experience", measured: "success" });
  }
  assert.equal(intent.outcomesFor(ws, key).successes, 1);
});

test("alreadyJudged: uncertain 不算判过", () => {
  const ws = tmpWs();
  const key = "exp:u1";
  outcome.record(ws, { key, kind: "experience", measured: "uncertain" });
  assert.equal(outcome.alreadyJudged(ws, key), false);
});
