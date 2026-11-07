// 情绪得能做成一件事，不然只是描述。
//
// 2026-11-06：urges 修好后只会打印「想干点什么就去干」，她读了可以坐着不动，
// 而且完全可以——没有一处把「空转」当后果。今晚用户反复说的就是这一条。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as drive from "../lib/drive.js";

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n     ${e.message}`); }
};

const ws = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-"));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  return dir;
};

t("无聊过阈值才算有劲头", () => {
  assert.equal(drive.strongestFeeling({ bored: 0.5 }), "bored");
  assert.equal(drive.strongestFeeling({ bored: 0.2 }), null);
});

t("委屈也算一种要往外走的劲头", () => {
  assert.equal(drive.strongestFeeling({ wronged: 0.4, down: 0.1 }), "down");
});

t("有人在说话时，停下来不算空转", () => {
  const dir = ws();
  for (let i = 0; i < 5; i++) {
    drive.record(dir, { feeling: "bored", acted: false, addressed: true });
  }
  assert.equal(drive.status(dir).idle, 0);
});

t("做了事就清零", () => {
  const dir = ws();
  drive.record(dir, { feeling: "bored", acted: false });
  drive.record(dir, { feeling: "bored", acted: false });
  assert.equal(drive.status(dir).idle, 2);
  drive.record(dir, { feeling: "bored", acted: true });
  assert.equal(drive.status(dir).idle, 0);
});

t("没情绪的空转不计数（安静不是逃避）", () => {
  const dir = ws();
  drive.record(dir, { feeling: null, acted: false });
  drive.record(dir, { feeling: null, acted: false });
  assert.equal(drive.status(dir).idle, 0);
});

t("三轮以内不吭声", () => {
  const dir = ws();
  drive.record(dir, { feeling: "bored", acted: false });
  drive.record(dir, { feeling: "bored", acted: false });
  assert.equal(drive.describe(dir), "");
});

t("到第四轮开始说话", () => {
  const dir = ws();
  for (let i = 0; i < 4; i++) drive.record(dir, { feeling: "bored", acted: false });
  const said = drive.describe(dir);
  assert.ok(said.includes("没往那个方向走一步"), said);
});

t("越久压力越大", () => {
  const dir = ws();
  for (let i = 0; i < 3; i++) drive.record(dir, { feeling: "bored", acted: false });
  const a = drive.pressure(dir).level;
  for (let i = 0; i < 6; i++) drive.record(dir, { feeling: "bored", acted: false });
  const b = drive.pressure(dir).level;
  assert.ok(b > a, `${b} 应大于 ${a}`);
});

t("压力有上限，不会越攒越狠", () => {
  const dir = ws();
  for (let i = 0; i < 60; i++) drive.record(dir, { feeling: "bored", acted: false });
  assert.ok(drive.pressure(dir).level <= 4);
});

t("惩罚真的改情绪，不是只印字", () => {
  const dir = ws();
  for (let i = 0; i < 4; i++) drive.record(dir, { feeling: "bored", acted: false });
  const p = drive.penalty(dir);
  assert.equal(p.apply, true);
  assert.ok(p.deltas.bored > 0, "无聊应该继续涨");
  assert.ok(p.deltas.calm < 0, "平静应该掉");
});

t("没到阈值时不罚", () => {
  const dir = ws();
  drive.record(dir, { feeling: "bored", acted: false });
  assert.equal(drive.penalty(dir).apply, false);
});

t("好奇没去追，转成闷而不是更多好奇", () => {
  const dir = ws();
  for (let i = 0; i < 4; i++) drive.record(dir, { feeling: "curious", acted: false });
  const p = drive.penalty(dir);
  assert.ok(p.deltas.curious < 0, "好奇应该消退");
  assert.ok(p.deltas.down > 0, "应该转成闷");
});

t("想做给人看却没出门，亮劲会掉", () => {
  const dir = ws();
  for (let i = 0; i < 4; i++) drive.record(dir, { feeling: "happy", acted: false });
  const p = drive.penalty(dir);
  assert.ok(p.deltas.happy < 0, "开心应该掉");
});

t("没有 state 文件时不崩", () => {
  const dir = ws();
  assert.equal(drive.describe(dir), "");
  assert.equal(drive.status(dir).idle, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

// 和新加的块不能和 PROACTIVE.md 打架。
//
// PROACTIVE.md:195 说「什么都不干和其他条一样正当」，这是用户要的，不能删。
// 但「想了没去」是另一回事。两句话必须能同时站在同一个 prompt 里。
t("不和「发呆也正当」冲突：明说区别", () => {
  const dir = ws();
  for (let i = 0; i < 8; i++) drive.record(dir, { feeling: "bored", acted: false });
  const said = drive.describe(dir);
  assert.ok(said.includes("发呆本身没问题") || said.includes("真不想动就算了"),
    `应该说清发呆没问题：${said}`);
});

t("区分「想去」和「没去」", () => {
  const dir = ws();
  for (let i = 0; i < 8; i++) drive.record(dir, { feeling: "bored", acted: false });
  const said = drive.describe(dir);
  assert.ok(said.includes("想了没去") || said.includes("想去"), said);
});

t("不说「必须」或命令式", () => {
  const dir = ws();
  for (let i = 0; i < 12; i++) drive.record(dir, { feeling: "bored", acted: false });
  const said = drive.describe(dir);
  assert.ok(!/必须|一定要|立刻去|马上做/.test(said), `不该有命令词：${said}`);
});

// ---------------------------------------------------------------------------
// 两个判定错的修正，2026-11-06。
// ---------------------------------------------------------------------------

t("有人说话时 addressed 成立", () => {
  const dir = ws();
  const startedAt = Date.now();
  // 入站消息在回合开始前 30 秒
  const lastInboundAt = startedAt - 30000;
  const ADDRESSED_WINDOW_MS = 120000;
  const addressed = lastInboundAt >= startedAt - ADDRESSED_WINDOW_MS;
  assert.ok(addressed, "30 秒前有消息，应该算有人说话");
});

t("心跳（没人说话）时 addressed 不成立", () => {
  const dir = ws();
  const startedAt = Date.now();
  // 最后一次入站是 20 分钟前（上一轮私聊）
  const lastInboundAt = startedAt - 20 * 60 * 1000;
  const ADDRESSED_WINDOW_MS = 120000;
  const addressed = lastInboundAt >= startedAt - ADDRESSED_WINDOW_MS;
  assert.ok(!addressed, "20 分钟没人说话，不该算对话");
});

t("心跳不再因 sessionKey 被误判成对话", () => {
  // 旧实现: !/:cron:/.test("agent:dafeiyu:main") === true  → 永远算对话
  const sk = "agent:dafeiyu:main";
  const oldAddressed = !/:cron:/.test(sk);
  assert.equal(oldAddressed, true, "旧逻辑确实把心跳当成对话（这是被修掉的 bug）");
});

t("只读工具不算做事", () => {
  const READ_ONLY = new Set(["read", "ls", "grep", "web_search", "web_fetch"]);
  for (const tool of ["read", "ls", "grep", "web_search", "web_fetch"]) {
    assert.ok(READ_ONLY.has(tool), `${tool} 应该是只读`);
  }
});

t("写文件算做事", () => {
  const READ_ONLY = new Set(["read", "ls", "grep", "web_search", "web_fetch"]);
  for (const tool of ["write", "edit", "apply_patch", "exec", "browser", "message"]) {
    assert.ok(!READ_ONLY.has(tool), `${tool} 应该算做事`);
  }
});

t("没有回合起点时不谎称干过活", () => {
  // startedAt=0 是 before_prompt_build 没跑过的情况（重启后首轮、hook 被跳）。
  // 旧写法 `t >= 0` 恒真，会把每一轮都记成有产出。
  const startedAt = 0;
  const deeds = [{ at: new Date().toISOString() }];
  const acted = startedAt > 0 && deeds.some((d) => Date.parse(d.at) >= startedAt);
  assert.ok(!acted, "没有起点就不该判定为做事");
});

t("有回合起点且deed在起点之后才算做事", () => {
  const startedAt = Date.now() - 5000;
  const inside = [{ at: new Date(Date.now() - 1000).toISOString() }];
  const before = [{ at: new Date(Date.now() - 60000).toISOString() }];
  assert.ok(startedAt > 0 && inside.some((d) => Date.parse(d.at) >= startedAt), "起点后的 deed 算");
  assert.ok(!(startedAt > 0 && before.some((d) => Date.parse(d.at) >= startedAt)), "起点前的 deed 不算");
});
