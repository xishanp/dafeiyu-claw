import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as compulsion from "../lib/compulsion.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "stuck-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};

test("stuck: counts 能读出每件被推了几次", () => {
  // 这是她能拿出证据的唯一来源。没有它，报告里只能写「感觉有点怪」。
  const ws = tmp();
  for (let i = 0; i < 5; i += 1) compulsion.recordPick(ws, "douyin:meet");
  const st = compulsion.loadState(ws);
  assert.equal(st.counts["douyin:meet"], 5);
});

test("stuck: overPicked 用完整状态才算得对", () => {
  const ws = tmp();
  for (let i = 0; i < 3; i += 1) compulsion.recordPick(ws, "a:b");
  const st = compulsion.loadState(ws);
  assert.ok(compulsion.overPicked(st, 2).has("a:b"));
  // 只传 picks 数组读不出 counts —— 这个差异正是之前那个 bug
  assert.equal(compulsion.overPicked(compulsion.loadPicks(ws), 2).size, 0);
});

test("stuck: check 能说出在打转", () => {
  const ws = tmp();
  for (let i = 0; i < 4; i += 1) compulsion.recordPick(ws, "same:thing");
  const r = compulsion.check(ws);
  assert.equal(r.stuck, true);
  assert.match(r.because, /同一类事|轮/);
});

test("stuck: 没历史时不误报", () => {
  const ws = tmp();
  const r = compulsion.check(ws);
  assert.equal(r.stuck, false);
});
