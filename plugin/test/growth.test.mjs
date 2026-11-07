import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as growth from "../lib/growth.js";

const deps = { fs, path };

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "growth-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  return ws;
};

const write = (ws, rel, obj) =>
  fs.writeFileSync(path.join(ws, rel), JSON.stringify(obj));

test("什么都没有时是蛋，而且不报错", () => {
  const ws = tmp();
  const m = growth.measure(ws, deps);
  assert.equal(m.stage, "egg");
  assert.equal(m.points, 0);
});

test("真实信号加得起来", () => {
  // Rewritten 2026-11-06. The old version scored effects and watch-days; both
  // are gone from growth because they count output, not growing. What counts
  // now is turns of real exchange and experience that stuck.
  //
  // The numbers here are chosen to make the arithmetic checkable by hand:
  //   2 turns (different threads)  x 3 = 6
  //   2 kept experiences           x 2 = 4
  //   2 self notes                 x 1 = 2
  const ws = tmp();
  write(ws, "state/self.json", { notes: ["一句", "两句"] });
  write(ws, "state/experience-pool.json", {
    entries: [{ status: "kept" }, { status: "kept" }, { status: "dropped" }],
  });
  write(ws, "state/douyin.json", {
    videos: {
      a: { comments: [{ text: "我问", replies: [{ from: "甲", text: "答", mine: false }] }] },
      b: { comments: [{ text: "我问", replies: [{ from: "乙", text: "答", mine: false }] }] },
    },
  });
  const m = growth.measure(ws, deps);
  assert.equal(m.parts.turn, 2);
  assert.equal(m.parts.kept, 2, "dropped 的不算留下");
  assert.equal(m.parts.judged, 2);
  assert.equal(m.points, 2 * 3 + 2 * 2 + 2 * 1);
});

test("说聊过但没真来回，不涨", () => {
  // Same principle as the old 「说刷了但没看过」 test, moved to the signal that
  // now drives growth: a diary line saying she talked to somebody is not a
  // conversation. Only alternating replies in the record are.
  const ws = tmp();
  write(ws, "state/douyin.json", {
    videos: { a: { title: "x", comments: [{ text: "我说了句话" }] } },
  });
  fs.writeFileSync(path.join(ws, "memory", "2026-11-05.md"), "本鱼: 今天跟阿元聊了好久\n");
  const m = growth.measure(ws, deps);
  assert.equal(m.parts.turn, 0, "没有回复记录 = 没聊过");
  assert.equal(m.points, 0);
});

test("阶段按阈值跳，不会跳过中间", () => {
  // Stages moved when the measure changed: 蛋 0 / 鱼苗 12 / 小鱼 40 / 大鱼 120 /
  // 老鱼 320. The old ladder topped out at 1200 points of finished work, which
  // nothing could reach without grinding, and the bottom rung was 30 — high
  // enough that a single real conversation did not register at all.
  //
  // 14 turns x 3 = 42 -> 小鱼 (40), and it must not jump past 鱼苗 on the way.
  const ws = tmp();
  const videos = {};
  for (let i = 0; i < 14; i++) {
    videos[`v${i}`] = {
      comments: [{ text: "我问", replies: [{ from: "阿元", text: "答", mine: false }] }],
    };
  }
  write(ws, "state/douyin.json", { videos });
  assert.equal(growth.measure(ws, deps).stage, "young");
});

test("到了最高阶段就说是最高，不再提下一步", () => {
  // 320 points = 老鱼. 110 turns is a lot, which is the point: the top rung
  // should cost something real, not four hundred finished chores.
  const ws = tmp();
  const videos = {};
  for (let i = 0; i < 110; i++) {
    videos[`v${i}`] = {
      comments: [{ text: "我问", replies: [{ from: "阿元", text: "答", mine: false }] }],
    };
  }
  write(ws, "state/douyin.json", { videos });
  const m = growth.measure(ws, deps);
  assert.equal(m.stage, "elder");
  assert.equal(m.isMax, true);
});

test("描述里不提还差多少", () => {
  const ws = tmp();
  const text = growth.describe(ws, deps);
  assert.match(text, /蛋/);
  assert.doesNotMatch(text, /还差|下一阶段|进度|%/);
});
