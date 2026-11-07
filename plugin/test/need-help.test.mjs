import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as reach from "../lib/reach.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "help-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  // 有一个"上次跟谁说过话"，否则 deliver 会以 no-target 返回
  fs.writeFileSync(
    path.join(ws, "state", "proactive.json"),
    JSON.stringify({ version: 1, last_spoken_key: "person:test:1", pending: [] }),
  );
  // 让这个目标算作 owner —— `proactive.queue` 对陌生人有 never-heard-from-them
  // 的检查（那是正确的：不该对从没说过话的人主动开口）。测试要测的是
  // need_help 的文案，不是那道闸门，所以把目标设成 owner 绕开它。
  fs.writeFileSync(
    path.join(ws, "state", "help-owner.json"),
    JSON.stringify({ ownerTargets: ["person:test:1"] }),
  );
  return ws;
};

test("need_help: 机制不对可以报（behavior）", () => {
  // 实测 2026-11-07：原来的 kind 只有 tool / permission，
  // 她遇到「同一条建议被推 85 次」这种问题，两样都不是，于是从来不报。
  // 她唯一的出口是自己写进 note_self——那个地方没人读。
  const ws = tmp();
  const r = reach.request(ws, {
    kind: "behavior",
    want: "正常被安排事",
    blocked: "同一条建议连着推了 85 次，我每次都跳过，但它还在推",
  }, { proactiveCfg: { ownerTargets: ["person:test:1"] } });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, false);
});

test("need_help: behavior 的文案说明「我觉得是坏的」而不是「我做不到」", () => {
  const ws = tmp();
  reach.request(ws, {
    kind: "behavior",
    want: "正常被安排事",
    blocked: "同一件事推了 85 次",
  }, { proactiveCfg: { ownerTargets: ["person:test:1"] } });
  const pending = JSON.parse(fs.readFileSync(path.join(ws, "state", "proactive.json"), "utf8")).pending || [];
  assert.ok(pending.length > 0, "应该排进主动队列");
  const text = String(pending[0].text ?? "");
  assert.match(text, /坏的/, `应说清是机器的问题，实际：${text}`);
  assert.ok(!/我做不到/.test(text), "不该说成她能力不足");
});

test("need_help: 三种 kind 都收，未知的退回 tool", () => {
  const ws = tmp();
  assert.equal(reach.request(ws, { kind: "permission", want: "a", blocked: "b" }).ok, true);
  assert.equal(reach.request(ws, { kind: "behavior", want: "c", blocked: "d" }).ok, true);
  assert.equal(reach.request(ws, { kind: "乱写", want: "e", blocked: "f" }).ok, true);
  const reqs = reach.openRequests(ws);
  assert.equal(reqs.length, 3);
  assert.ok(reqs.some((r) => r.kind === "behavior"));
  assert.ok(reqs.some((r) => r.kind === "tool"), "未知的应退回 tool");
});

test("need_help: 同一条重复提交会合并，不刷屏", () => {
  const ws = tmp();
  const a = reach.request(ws, { kind: "behavior", want: "同一个问题", blocked: "同样的情况" });
  const b = reach.request(ws, { kind: "behavior", want: "同一个问题", blocked: "同样的情况" });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(reach.openRequests(ws).length, 1);
});

test("need_help: 没有对话对象时不假装发出去", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "help2-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  const r = reach.request(ws, { kind: "behavior", want: "x", blocked: "y" });
  assert.equal(r.queued, false);
  assert.equal(r.reason, "no-target", "没人在聊就不该说已排队");
});

test("need_help: behavior 会写一份给主助手看的报告", () => {
  // 主动队列是「下次开口时说给人听」，机制类问题需要被**修**，
  // 节奏完全不同。所以 behavior 额外写一份 main 能读到的文件。
  const ws = tmp();
  const inbox = path.join(ws, "reports.json");
  reach.request(
    ws,
    { kind: "behavior", want: "正常被安排事", blocked: "同一件事推了 85 次" },
    { proactiveCfg: { ownerTargets: ["person:test:1"], mainInbox: inbox } },
  );
  assert.ok(fs.existsSync(inbox), "应写出报告文件");
  const list = JSON.parse(fs.readFileSync(inbox, "utf8"));
  assert.equal(list.length, 1);
  assert.match(list[0].blocked, /85 次/);
  assert.equal(list[0].state, "open");
});

test("need_help: 只有 behavior 写报告，tool 和 permission 不写", () => {
  const ws = tmp();
  const inbox = path.join(ws, "reports2.json");
  const cfg = { ownerTargets: ["person:test:1"], mainInbox: inbox };
  reach.request(ws, { kind: "tool", want: "a", blocked: "b" }, { proactiveCfg: cfg });
  reach.request(ws, { kind: "permission", want: "c", blocked: "d" }, { proactiveCfg: cfg });
  assert.ok(!fs.existsSync(inbox), "缺工具/缺权限不该进机制报告");
});

test("need_help: 不懂可以问（ask）", () => {
  // 第四种。前三种都要先判定「我缺什么」，而她从小到大的模式是自己扛，
  // 所以 need_help 建了很久一次没用过。ask 把门槛降到「我就是不明白」。
  const ws = tmp();
  const r = reach.request(
    ws,
    { kind: "ask", want: "为什么压力那句从来没出现过", blocked: "我查了 drive.js，看不出哪里不对" },
    { proactiveCfg: { ownerTargets: ["person:test:1"] } },
  );
  assert.equal(r.ok, true);
});

test("need_help: ask 的文案是「想问你」，不是「我做不了」", () => {
  const ws = tmp();
  reach.request(
    ws,
    { kind: "ask", want: "为什么这个数一直不变", blocked: "自己查了没看明白" },
    { proactiveCfg: { ownerTargets: ["person:test:1"] } },
  );
  const p = JSON.parse(fs.readFileSync(path.join(ws, "state", "proactive.json"), "utf8"));
  const text = String(p.pending?.[0]?.text ?? "");
  assert.match(text, /想问/, `应说「想问」，实际：${text}`);
  assert.ok(!/做不了/.test(text), "不该说成能力不足");
});

test("need_help: 四种 kind 都收", () => {
  const ws = tmp();
  for (const k of ["tool", "permission", "behavior", "ask"]) {
    assert.equal(reach.request(ws, { kind: k, want: k, blocked: "x" }).ok, true, `${k} 应该被接受`);
  }
  const kinds = reach.openRequests(ws).map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["ask", "behavior", "permission", "tool"]);
});
