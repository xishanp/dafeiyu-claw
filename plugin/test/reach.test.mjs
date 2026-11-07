import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as curiosity from "../lib/curiosity.js";
import * as proactive from "../lib/proactive.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "reach-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();

const CFG = {
  enabled: true, replyWindowMinutes: 30, bufferMinutes: 2, maxSilenceHours: 0,
  cooldownMinutes: 15, quietHoursStart: 0, quietHoursEnd: 0,
  requireValue: false, unlimited: false, impulseTtlHours: 6, timeZone: "Asia/Shanghai",
};

/** 造一个「有人跟她说过话」的真实前置状态，否则 proactive 会拒发（no-target）。 */
function seedTarget(ws, key = "person:onebot:10001") {
  const f = path.join(ws, "state", "proactive.json");
  let d = { version: 1, history: [], pending: [], skipped: {}, targets: {} };
  try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* 新工作区 */ }
  d.targets = d.targets || {};
  // 推到 10 分钟前：刚说完话 2 分钟内 proactive 会拒绝主动开口（防打断），
  // 而这里要测的是「排队」这件事本身，不是那道 buffer 门。
  d.targets[key] = { last_inbound_at: new Date(Date.now() - 10 * 60000).toISOString() };
  fs.writeFileSync(f, JSON.stringify(d));
  return key;
}

function seedCuriosity(ws, over = {}) {
  const n = {
    id: "n-1", topic: "esp32", display: "esp32", seen: 2, moved: 0.3,
    reasons: ["在 douyin 的结果里看到"], first_seen_at: iso(1), last_seen_at: iso(0.2),
    status: "open", want_id: null, kind: "name", weight: 0.7,
    ...over,
  };
  fs.writeFileSync(
    path.join(ws, "state", "curiosity.json"),
    JSON.stringify({
      version: 2, noticings: [n],
      stats: { noticed: 1, resurfaced: 0, wanted: 0, faded: 0 },
      updated_at: iso(0),
    }),
  );
  return n;
}

// ---- 第一根：好奇心要能出现 -----------------------------------------------

test("reach: 够格的好奇心会被 propose 交出来", () => {
  const ws = tmp();
  seedCuriosity(ws);
  const out = curiosity.propose(ws, { minPull: 0.55 });
  assert.equal(out.length, 1, "该交出来一条");
  assert.equal(out[0].display, "esp32");
});

test("reach: 不够格的不交", () => {
  const ws = tmp();
  seedCuriosity(ws, { seen: 1, moved: 0, weight: 0.35 });
  const out = curiosity.propose(ws, { minPull: 0.55 });
  assert.equal(out.length, 0, "只见过一次不该冒出来");
});

test("reach: 交出来之后能变成想做的事", () => {
  const ws = tmp();
  seedCuriosity(ws);
  const wants = { add: () => ({ id: "w-1" }) };
  const r = curiosity.handOff(ws, "esp32", wants);
  assert.equal(r.ok, true, "该被交出去");
  const after = JSON.parse(fs.readFileSync(path.join(ws, "state", "curiosity.json"), "utf8"));
  assert.equal(after.noticings[0].want_id, "w-1", "该记下它变成了哪条心愿");
});

// ---- 第三根：缺东西能开口 -------------------------------------------------

test("reach: need_help 的内容能排进待发队列", () => {
  const ws = tmp();
  seedTarget(ws);
  const r = proactive.queue(
    ws,
    {
      target: "person:onebot:10001",
      kind: "need-help",
      source: "need_help",
      value: 0.85,
      text: "用户，有个事我做不了：没有播放声音的工具。想的是给自己弄个嗓子。",
    },
    CFG,
  );
  assert.equal(r.queued, true, "该排进去");
  assert.equal(r.impulse.kind, "need-help");
  assert.ok(r.impulse.value >= 0.8, "缺东西该排得靠前");
});

test("reach: 同一句求助不会排两遍", () => {
  const ws = tmp();
  seedTarget(ws);
  const text = "用户，有个事我做不了：没有播放声音的工具。";
  proactive.queue(ws, { target: "person:onebot:10001", kind: "need-help", value: 0.85, text }, CFG);
  const second = proactive.queue(ws, { target: "person:onebot:10001", kind: "need-help", value: 0.85, text }, CFG);
  assert.equal(second.queued, false);
  assert.equal(second.reason, "duplicate");
});

test("reach: 没有可以说话的对象时不会假装排进去了", () => {
  const ws = tmp();
  // 故意不 seedTarget
  const r = proactive.queue(ws, { kind: "need-help", value: 0.9, text: "求助" }, CFG);
  assert.equal(r.queued, false);
  assert.equal(r.reason, "no-target", "该如实说没地方发");
});

test("reach: 空文本不排队", () => {
  const ws = tmp();
  const r = proactive.queue(ws, { kind: "need-help", value: 0.9, text: "   " }, {});
  assert.equal(r.queued, false);
});

test("reach: 排进去的东西真的能取出来", () => {
  const ws = tmp();
  seedTarget(ws);
  proactive.queue(
    ws,
    { target: "person:onebot:10001", kind: "need-help", value: 0.85, text: "用户，缺个语音工具。" },
    CFG,
  );
  const taken = proactive.take(ws, "person:onebot:10001", CFG);
  assert.ok(taken, "该取得到");
  assert.match(String(taken.text ?? taken.impulse?.text ?? ""), /缺个语音工具/);
});

// ---- need_help 的完整路径（抽到 lib/reach.js 之后可独立测）-----------------

test("reach: request 会同时留档和排队", async () => {
  const { default: _, ...unused } = {};
  const reach = await import("../lib/reach.js");
  const ws = tmp();
  seedTarget(ws);
  const r = reach.request(
    ws,
    { kind: "tool", want: "给自己弄个嗓子", blocked: "没有播放声音的工具" },
    { proactiveCfg: CFG },
  );
  assert.equal(r.ok, true);
  assert.equal(r.queued, true, "该排进队列");
  const saved = JSON.parse(fs.readFileSync(path.join(ws, "state", "capability-requests.json"), "utf8"));
  assert.equal(saved.requests.length, 1);
  assert.equal(saved.requests[0].want, "给自己弄个嗓子");
});

test("reach: 没有 target 时仍然留档，但如实说没发出去", async () => {
  const reach = await import("../lib/reach.js");
  const ws = tmp();
  const r = reach.request(
    ws,
    { kind: "tool", want: "想要个口子", blocked: "进不去" },
    { proactiveCfg: CFG },
  );
  assert.equal(r.ok, true, "文件还是该写");
  assert.equal(r.queued, false);
  assert.equal(r.reason, "no-target");
  const saved = JSON.parse(fs.readFileSync(path.join(ws, "state", "capability-requests.json"), "utf8"));
  assert.equal(saved.requests.length, 1);
});

test("reach: 同一条不会记两遍，但会再试着发一次", async () => {
  const reach = await import("../lib/reach.js");
  const ws = tmp();
  // 第一次：没有 target
  const first = reach.request(ws, { kind: "tool", want: "X", blocked: "Y" }, { proactiveCfg: CFG });
  assert.equal(first.queued, false);
  // 现在有 target 了，再提一次同一个
  seedTarget(ws);
  const second = reach.request(ws, { kind: "tool", want: "X", blocked: "Y" }, { proactiveCfg: CFG });
  assert.equal(second.duplicate, true, "不该重复记");
  assert.equal(second.queued, true, "但该补发");
  const saved = JSON.parse(fs.readFileSync(path.join(ws, "state", "capability-requests.json"), "utf8"));
  assert.equal(saved.requests.length, 1, "文件里只有一条");
});

test("reach: 话说不全就不办", async () => {
  const reach = await import("../lib/reach.js");
  const ws = tmp();
  const r = reach.request(ws, { kind: "tool", want: "有想法", blocked: "" }, { proactiveCfg: CFG });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "incomplete");
});

test("reach: openRequests 能列出还没处理的", async () => {
  const reach = await import("../lib/reach.js");
  const ws = tmp();
  seedTarget(ws);
  reach.request(ws, { kind: "tool", want: "缺 A", blocked: "卡住" }, { proactiveCfg: CFG });
  const open = reach.openRequests(ws);
  assert.equal(open.length, 1);
  assert.equal(open[0].want, "缺 A");
});
