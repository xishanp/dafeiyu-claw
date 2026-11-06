// 边界：被明确要求别发了，就不能再主动开口。
//
// 这些用例锁的是一条曾经只存在于注释和测试里的规则。`decide.detectBoundary`
// 写好了、六条测试全过、probe.log 里一次边界记录都没有——因为生产代码
// 从来没有调用它。单元测试只证明函数自己算得对，证明不了它接在链路上。
// 所以这里测的是接线：noteBoundary → take 被挡 → 对方再说话 → 放行。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as proactive from "../lib/proactive.js";
import * as decide from "../lib/decide.js";

function ws() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dafeiyu-boundary-"));
  fs.mkdirSync(path.join(d, "state"), { recursive: true });
  return d;
}

const KEY = "person:onebot:12345";
// quiet hours 归零、ownerTargets 豁免身份检查：这些用例只关于边界，
// 不该因为跑测试时的钟点而失败。
const CFG = { ownerTargets: [KEY], quietHoursStart: 0, quietHoursEnd: 0, enabled: true };

test("边界：没说过就别挡", () => {
  const d = ws();
  assert.equal(proactive.boundaryFor(d, KEY), null);
});

test("边界：说「不要给我发私信」被记成 stop", () => {
  const d = ws();
  assert.equal(decide.detectBoundary("不要给我发私信"), "stop");
  proactive.noteBoundary(d, KEY, "stop");
  const b = proactive.boundaryFor(d, KEY);
  assert.equal(b.kind, "stop");
});

test("边界：有边界时 take 挡下，且不删队列", () => {
  const d = ws();
  proactive.queue(d, { target: KEY, kind: "greet", text: "在吗" }, CFG);
  assert.equal(proactive.pendingFor(d, KEY, CFG).length, 1);

  proactive.noteBoundary(d, KEY, "stop");
  assert.equal(proactive.take(d, KEY, CFG), null);
  // 挡下不等于丢弃：想说的话还在，等对方再开口就能发。
  assert.equal(proactive.pendingFor(d, KEY, CFG).length, 1);
});

test("边界：对方再说话就解除，然后能发", () => {
  const d = ws();
  proactive.queue(d, { target: KEY, kind: "greet", text: "在吗" }, CFG);
  proactive.noteBoundary(d, KEY, "stop");
  proactive.clearBoundary(d, KEY);
  const rec = proactive.take(d, KEY, CFG);
  assert.equal(rec.text, "在吗");
});

test("边界：closed 六小时后自己失效", () => {
  const d = ws();
  proactive.noteBoundary(d, KEY, "closed");
  const file = path.join(d, "state", "proactive.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.targets[KEY].boundary_at = new Date(Date.now() - 7 * 3600e3).toISOString();
  fs.writeFileSync(file, JSON.stringify(data));
  // 说「拜拜」不代表要求永久安静，所以这条会留在 TTL 上。
  assert.equal(proactive.boundaryFor(d, KEY), null);
});

test("边界：stop 七天内仍然生效", () => {
  const d = ws();
  proactive.noteBoundary(d, KEY, "stop");
  const file = path.join(d, "state", "proactive.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.targets[KEY].boundary_at = new Date(Date.now() - 6 * 24 * 3600e3).toISOString();
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(proactive.boundaryFor(d, KEY).kind, "stop");
});

test("边界：拒绝不认识的 kind，不写脏状态", () => {
  const d = ws();
  assert.equal(proactive.noteBoundary(d, KEY, "whatever"), false);
  assert.equal(proactive.boundaryFor(d, KEY), null);
});

test("回复窗口：对方刚说话，不算主动开口", () => {
  const d = ws();
  // 30 分钟窗口内 = 正在对话，回复不该消耗主动发言额度。
  proactive.noteActivity(d, KEY);
  const w = proactive.isReplyWindow(d, KEY, CFG);
  assert.equal(w.inWindow, true);
  assert.ok(w.waitedMin < 1);
});

test("回复窗口：对方沉默超过窗口才算主动", () => {
  const d = ws();
  proactive.noteActivity(d, KEY);
  // 把上一次来信推到两小时前。
  const file = path.join(d, "state", "proactive.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.targets[KEY].last_inbound_at = new Date(Date.now() - 2 * 3600e3).toISOString();
  fs.writeFileSync(file, JSON.stringify(data));
  const w = proactive.isReplyWindow(d, KEY, CFG);
  assert.equal(w.inWindow, false);
  assert.ok(w.waitedMin > 100);
});

test("回复窗口：从没说过话时不算在窗口内", () => {
  const d = ws();
  // 没有记录 = 不可能是「正在回答」，按主动开口处理。
  const w = proactive.isReplyWindow(d, KEY, CFG);
  assert.equal(w.inWindow, false);
  assert.equal(w.waitedMin, null);
});
