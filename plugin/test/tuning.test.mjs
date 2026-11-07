import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tuning from "../lib/tuning.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tune-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};

test("tuning: 白名单外的键改不了，理由列出能改哪些", () => {
  const ws = tmp();
  const r = tuning.set(ws, "plugin.code", 1);
  assert.equal(r.ok, false);
  assert.match(r.reason, /不在能调的名单/);
  assert.match(r.reason, /habit\.threshold/);
});

test("tuning: 超范围的拒绝，理由说清范围和后果", () => {
  const ws = tmp();
  const r = tuning.set(ws, "workspace.habitCap", 5);
  assert.equal(r.ok, false);
  assert.match(r.reason, /0\.2/);
  assert.match(r.reason, /提不起劲|换事/);
});

test("tuning: 正常改动能生效", () => {
  const ws = tmp();
  const r = tuning.set(ws, "habit.threshold", 2);
  assert.equal(r.ok, true);
  assert.equal(r.before, 3);
  assert.equal(r.after, 2);
  assert.equal(tuning.get(ws, "habit.threshold"), 2);
});

test("tuning: 整数键会取整", () => {
  const ws = tmp();
  tuning.set(ws, "habit.threshold", 2.7);
  assert.equal(tuning.get(ws, "habit.threshold"), 3);
});

test("tuning: 没调过的返回默认值", () => {
  const ws = tmp();
  assert.equal(tuning.get(ws, "habit.threshold"), 3);
  assert.equal(tuning.get(ws, "curiosity.surfacePull"), 0.55);
});

test("tuning: 不存在的键 get 返回 undefined 不崩", () => {
  const ws = tmp();
  assert.equal(tuning.get(ws, "不存在"), undefined);
});

test("tuning: 每次改都留审计", () => {
  const ws = tmp();
  tuning.set(ws, "habit.threshold", 2, { by: "self", reason: "被推太多次" });
  const h = tuning.history(ws);
  assert.equal(h.length, 1);
  assert.equal(h[0].key, "habit.threshold");
  assert.equal(h[0].before, 3);
  assert.equal(h[0].after, 2);
  assert.equal(h[0].by, "self");
  assert.match(h[0].reason, /推太多次/);
});

test("tuning: reset 还原默认并留审计", () => {
  const ws = tmp();
  tuning.set(ws, "habit.threshold", 2);
  const r = tuning.reset(ws, "habit.threshold");
  assert.equal(r.ok, true);
  assert.equal(tuning.get(ws, "habit.threshold"), 3);
  const h = tuning.history(ws);
  assert.equal(h.length, 2);
  assert.equal(h[1].reason, "reset");
});

test("tuning: 非数字的值被拒", () => {
  const ws = tmp();
  const r = tuning.set(ws, "habit.threshold", "很多");
  assert.equal(r.ok, false);
  assert.match(r.reason, /数字/);
});

test("tuning: 空 workspace 读默认不报错", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tune-empty-"));
  assert.equal(tuning.get(ws, "workspace.habitCap"), 0.5);
  assert.deepEqual(tuning.history(ws), []);
});

test("tuning: describe 列出全部可调项，带范围和大意", () => {
  const ws = tmp();
  const rows = tuning.describe(ws);
  assert.ok(rows.length >= 8);
  for (const r of rows) {
    assert.ok(r.key && r.why, `${r.key} 要有一句 why`);
    assert.ok(r.range.includes("–"), "要有范围");
  }
});

test("tuning: 改完能真的驱动 workspace", async () => {
  const ws = tmp();
  const attention = await import("../lib/workspace.js");
  tuning.set(ws, "workspace.streakNotice", 2);
  attention.applyTuning(tuning.current(ws));
  assert.equal(attention.STREAK_NOTICE, 2, "streakNotice 应该跟着变");
});
