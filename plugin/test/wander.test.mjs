import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as curiosity from "../lib/curiosity.js";
import * as deeds from "../lib/deeds.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "wander-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};
const now = () => new Date().toISOString();
const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();

test("wander: 只见过一次的名字静着，不会一看到就冒出来", () => {
  const n = { kind: "dangling", weight: 0.35, seen: 1, moved: 0, last_seen_at: now() };
  assert.ok(curiosity.pull(n) < 0.55, "第一次不该浮现");
});

test("wander: 见过两次的名字能浮现（回归）", () => {
  // 曾经的 bug：0.35×1.0 + 0.15×1.0 = 0.50，永远够不到 0.55。
  // 结果是出去逛完碰到的名字一次都提不起来，无论碰多少次。
  const n = { kind: "dangling", weight: 0.35, seen: 2, moved: 0, last_seen_at: now() };
  assert.ok(curiosity.pull(n) >= 0.55, `第二次应浮现，实际 ${curiosity.pull(n).toFixed(3)}`);
});

test("wander: 见过很多次也不会超过 1", () => {
  const n = { kind: "dangling", weight: 0.35, seen: 100, moved: 0, last_seen_at: now() };
  const p = curiosity.pull(n);
  assert.ok(p <= 1, `pull 应封顶 1，实际 ${p}`);
});

test("wander: 很久以前见过的会淡下去", () => {
  const n = { kind: "dangling", weight: 0.35, seen: 2, moved: 0, last_seen_at: ago(60) };
  assert.ok(curiosity.pull(n) < 0.55, "两个月前的不该还拉着她");
});

test("wander: 问题第一次就浮现，不用等第二次", () => {
  const n = { kind: "question", weight: 0.7, seen: 1, moved: 0, last_seen_at: now() };
  assert.ok(curiosity.pull(n) >= 0.55);
});

test("wander: 矛盾第一次就浮现", () => {
  const n = { kind: "mismatch", weight: 0.9, seen: 1, moved: 0, last_seen_at: now() };
  assert.ok(curiosity.pull(n) >= 0.55);
});

test("wander: 逛完会留下一条 deed", () => {
  const ws = tmp();
  deeds.record(ws, { kind: "browsed", note: "douyin_record · 1 个没见过的", ref: "douyin_record" });
  const d = deeds.describe(ws);
  assert.match(d, /自己去逛了/);
});

test("wander: 什么也没看到也是一次出门", () => {
  const ws = tmp();
  deeds.record(ws, { kind: "browsed", note: "douyin_record", ref: "douyin_record" });
  assert.match(deeds.describe(ws), /自己去逛了/);
});

test("wander: 同一个名字逛两次才算认识，不是一见就喊", () => {
  const ws = tmp();
  const a = curiosity.notice(ws, "Poincaré", { known: [] });
  assert.equal(a.seen, 1);
  assert.equal(curiosity.propose(ws, { budget: 1 }).length, 0, "第一次不该浮现");
  const b = curiosity.notice(ws, "Poincaré", { known: [] });
  assert.equal(b.seen, 2);
  assert.equal(curiosity.propose(ws, { budget: 1 }).length, 1, "第二次应浮现");
});

test("wander: 认识的词不会被当成没见过的", () => {
  const ws = tmp();
  assert.equal(curiosity.notice(ws, "Vulkan", { known: ["Vulkan"] }), null);
});
