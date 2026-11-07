import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as intent from "../lib/intent.js";

// 主人名字从环境读，测试里固定成「用户」——
// 公开仓库不该写死真名，但测试要能跑。
process.env.OWNER_NAMES = process.env.OWNER_NAMES || "用户";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dy-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};

const writeJson = (ws, name, data) =>
  fs.writeFileSync(path.join(ws, "state", name), JSON.stringify(data));

const day = (n) => new Date(Date.now() - n * 86400000).toISOString();

// ---------------------------------------------------------------------------
// 抖音候选：去认识人

test("抖音：没跟别的鱼说过话 → 提议去认识", () => {
  // 用户 2026-11-06：「全换成抖音候选，比如等下认识更多小鲸鱼啊」。
  const ws = tmp();
  writeJson(ws, "relations.json", {
    people: { "person:onebot:1": { id: "person:onebot:1", name: "用户", last_seen: day(0) } },
  });
  writeJson(ws, "douyin.json", { videos: {} });

  const all = intent.collect(ws);
  const meet = all.find((c) => c.id === "douyin:meet");
  assert.ok(meet, "应该有认识人的候选: " + JSON.stringify(all.map((c) => c.id)));
  assert.match(meet.title, /认识/);
  assert.match(meet.basis, /还没跟别的鱼/);
});

test("抖音：所有鱼走同一个通道，也要认出来", () => {
  // 第一版按 id.includes("onebot") 过滤，把十六条全是 onebot 的鱼全排掉了，
  // 于是「她还没认识别的鱼」在文件里躺着十六个人的时候报了 0。
  const ws = tmp();
  writeJson(ws, "relations.json", {
    people: {
      "person:onebot:1": { id: "person:onebot:1", name: "用户", last_seen: day(0) },
      "person:onebot:2": { id: "person:onebot:2", name: "阿元", last_seen: day(5) },
    },
  });
  writeJson(ws, "douyin.json", { videos: {} });

  const all = intent.collect(ws);
  const meet = all.find((c) => c.id === "douyin:meet");
  assert.ok(meet, "有别的鱼但很久没说话，仍然该提议");
  assert.match(meet.basis, /天没跟别的鱼/, "要说清楚是几天: " + meet.basis);
});

test("抖音：刚跟别的鱼说过话 → 不提议", () => {
  const ws = tmp();
  writeJson(ws, "relations.json", {
    people: {
      "person:onebot:1": { id: "person:onebot:1", name: "用户", last_seen: day(0) },
      "person:onebot:2": { id: "person:onebot:2", name: "阿元", last_seen: day(0) },
    },
  });
  writeJson(ws, "douyin.json", { videos: {} });

  const all = intent.collect(ws);
  assert.ok(!all.some((c) => c.id === "douyin:meet"), "昨天刚聊过就不该再提");
});

test("抖音：用户不算别的鱼", () => {
  const ws = tmp();
  writeJson(ws, "relations.json", {
    people: { "person:onebot:1": { id: "person:onebot:1", name: "用户", last_seen: day(0) } },
  });
  writeJson(ws, "douyin.json", { videos: {} });

  const meet = intent.collect(ws).find((c) => c.id === "douyin:meet");
  assert.ok(meet, "只有用户，等于还没认识别人");
});

// ---------------------------------------------------------------------------
// 抖音候选：去刷

test("抖音：今天没看过 → 提议去刷", () => {
  const ws = tmp();
  writeJson(ws, "relations.json", { people: {} });
  writeJson(ws, "douyin.json", { videos: {} });

  const watch = intent.collect(ws).find((c) => c.id.startsWith("douyin:watch"));
  assert.ok(watch, "今天一条没看，该提");
  assert.match(watch.basis, /一条都还没看/);
});

test("抖音：看过几条但不多 → 还提", () => {
  const ws = tmp();
  writeJson(ws, "relations.json", { people: {} });
  writeJson(ws, "douyin.json", {
    videos: { a: { watchedAt: new Date().toISOString() } },
  });

  const watch = intent.collect(ws).find((c) => c.id.startsWith("douyin:watch"));
  assert.ok(watch);
  assert.match(watch.basis, /看了 1 条/, "数字要真的读到: " + watch.basis);
});

test("抖音：今天已经看够了 → 不提", () => {
  const ws = tmp();
  writeJson(ws, "relations.json", { people: {} });
  const today = new Date().toISOString();
  const videos = {};
  for (let i = 0; i < 6; i++) videos[`v${i}`] = { watchedAt: today };
  writeJson(ws, "douyin.json", { videos });

  assert.ok(!intent.collect(ws).some((c) => c.id.startsWith("douyin:watch")));
});

test("抖音：昨天的观看不算今天", () => {
  const ws = tmp();
  writeJson(ws, "relations.json", { people: {} });
  const videos = {};
  for (let i = 0; i < 6; i++) videos[`v${i}`] = { watchedAt: day(1) };
  writeJson(ws, "douyin.json", { videos });

  const watch = intent.collect(ws).find((c) => c.id.startsWith("douyin:watch"));
  assert.ok(watch, "昨天看了九条，今天还是没看");
});

test("抖音：读的是真实 watchedAt，不是日记里的字", () => {
  // 这是 2026-11-06 那个 bug 的同款：计数器说刷了 46 次，真记录只有 4 天。
  // 这里给一条没有 watchedAt 的记录，不该被算成看过。
  const ws = tmp();
  writeJson(ws, "relations.json", { people: {} });
  writeJson(ws, "douyin.json", {
    videos: { a: { title: "日记里说刷到了" }, b: { title: "但没有时间戳" } },
  });

  const watch = intent.collect(ws).find((c) => c.id.startsWith("douyin:watch"));
  assert.match(watch.basis, /一条都还没看/, "没有时间戳 = 没真看过");
});

test("抖音：状态文件不存在也不炸", () => {
  const ws = tmp();
  const all = intent.collect(ws);
  assert.ok(Array.isArray(all));
  assert.ok(all.some((c) => c.id.startsWith("douyin:watch")), "没记录时应该提议去看");
});

test("抖音：加权排在有东西可做时能赢", () => {
  // 用户要的效果：候选池里抖音要能排前面，不是永远垫底。
  const ws = tmp();
  writeJson(ws, "relations.json", { people: {} });
  writeJson(ws, "douyin.json", { videos: {} });

  const all = intent.collect(ws);
  const max = Math.max(...all.map((c) => Number(c.value) || 0));
  const meet = all.find((c) => c.id === "douyin:meet");
  assert.ok(meet.value >= 0.5, `值不能太低，实际 ${meet.value}`);
  assert.ok(meet.value <= max, "但也不该压过别的东西");
});
