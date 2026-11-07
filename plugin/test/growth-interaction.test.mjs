import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as growth from "../lib/growth.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "grow-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  return ws;
};

const put = (ws, name, data) =>
  fs.writeFileSync(path.join(ws, "state", name), JSON.stringify(data));

const m = (ws) => growth.measure(ws, { fs, path });
const d = (ws) => growth.describe(ws, { fs, path });

// ---------------------------------------------------------------------------
// 一轮往来怎么数

test("轮次：对方接一句 = 1 轮", () => {
  const turns = growth.countTurns([
    { text: "我问", replies: [{ from: "阿元", text: "我答", mine: false }] },
  ]);
  assert.equal(turns, 1);
});

test("轮次：来回三次 = 3 轮", () => {
  const turns = growth.countTurns([
    {
      text: "我问",
      replies: [
        { from: "阿元", text: "1", mine: false },
        { from: "本鱼", text: "2", mine: true },
        { from: "阿元", text: "3", mine: false },
        { from: "本鱼", text: "4", mine: true },
        { from: "阿元", text: "5", mine: false },
      ],
    },
  ]);
  assert.equal(turns, 3, "三次对方说的话，中间都隔着她的一句");
});

test("轮次：对方连发三条不算三轮", () => {
  // 一个人连发五句不算五轮，那是自言自语。
  const turns = growth.countTurns([
    {
      text: "我问",
      replies: [
        { from: "阿元", text: "1", mine: false },
        { from: "阿元", text: "2", mine: false },
        { from: "阿元", text: "3", mine: false },
      ],
    },
  ]);
  assert.equal(turns, 1, "中间没有她的话，只算一轮");
});

test("轮次：她连发几条也不算", () => {
  const turns = growth.countTurns([
    {
      text: "我问",
      replies: [
        { from: "本鱼", text: "补一句", mine: true },
        { from: "本鱼", text: "再补一句", mine: true },
        { from: "阿元", text: "答", mine: false },
      ],
    },
  ]);
  assert.equal(turns, 1);
});

test("轮次：没有回复 = 0", () => {
  assert.equal(growth.countTurns([{ text: "我问", replies: [] }]), 0);
  assert.equal(growth.countTurns([{ text: "我问" }]), 0);
});

test("轮次：多条串加起来", () => {
  const turns = growth.countTurns([
    { text: "a", replies: [{ from: "甲", text: "1", mine: false }] },
    { text: "b", replies: [{ from: "乙", text: "1", mine: false }] },
  ]);
  assert.equal(turns, 2);
});

// ---------------------------------------------------------------------------
// 成长只算往来 + 经验

test("长大：只留下经验、没往来 → 不装作在长大", () => {
  const ws = tmp();
  put(ws, "douyin.json", { videos: {} });
  put(ws, "experience-pool.json", {
    entries: [{ status: "kept" }, { status: "kept" }, { status: "dropped" }],
  });

  const r = m(ws);
  assert.equal(r.parts.turn, 0);
  assert.equal(r.parts.kept, 2);
  assert.match(d(ws), /留下 2 条经验/);
  assert.ok(!/聊过/.test(d(ws)), "没聊过就不能说聊过");
});

test("长大：做了 105 件事不加分", () => {
  // 这是改掉的那个 bug。第一版 effect × 4，105 件 = 420 分，直接成年。
  const ws = tmp();
  put(ws, "effects.json", { entries: new Array(105).fill({}) });
  put(ws, "douyin.json", { videos: {} });
  put(ws, "experience-pool.json", { entries: [] });

  const r = m(ws);
  assert.equal(r.points, 0, "做完的事不再算成长");
  assert.equal(r.stageLabel, "蛋");
});

test("长大：聊得多但没沉淀 → 也是长大，但只长在往来上", () => {
  const ws = tmp();
  put(ws, "douyin.json", {
    videos: {
      v1: {
        title: "x",
        comments: [{
          text: "我问",
          replies: [
            { from: "阿元", text: "1", mine: false },
            { from: "本鱼", text: "2", mine: true },
            { from: "阿元", text: "3", mine: false },
          ],
        }],
      },
    },
  });
  put(ws, "experience-pool.json", { entries: [] });

  const r = m(ws);
  assert.equal(r.parts.turn, 2);
  assert.equal(r.parts.kept, 0);
  assert.match(d(ws), /来回聊过 2 轮/);
  assert.ok(!/经验/.test(d(ws)), "没留下经验就不要提");
});

test("长大：阶段按分值真的会往上走", () => {
  const ws = tmp();
  // 40 轮 = 120 分 → 大鱼
  const videos = {};
  for (let i = 0; i < 40; i++) {
    videos[`v${i}`] = { title: "x", comments: [{ text: "我问", replies: [{ from: "阿元", text: "答", mine: false }] }] };
  }
  put(ws, "douyin.json", { videos });
  put(ws, "experience-pool.json", { entries: [] });

  const r = m(ws);
  assert.equal(r.parts.turn, 40);
  assert.equal(r.points, 120);
  assert.equal(r.stageLabel, "大鱼");
});

test("长大：什么都没有时说没有，不硬凑", () => {
  const ws = tmp();
  put(ws, "douyin.json", { videos: {} });
  put(ws, "experience-pool.json", { entries: [] });

  const text = d(ws);
  assert.match(text, /还没跟人来回聊过/);
  assert.match(text, /不欠谁/);
});

test("长大：文件全缺也不炸", () => {
  const ws = tmp();
  const r = m(ws);
  assert.equal(r.points, 0);
  assert.equal(r.stageLabel, "蛋");
});
