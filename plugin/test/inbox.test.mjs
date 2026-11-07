import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as inbox from "../lib/inbox.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};

const seed = (ws, videos) =>
  fs.writeFileSync(
    path.join(ws, "state", "douyin.json"),
    JSON.stringify({ version: 1, updated_at: null, videos }),
  );

const read = (ws) =>
  JSON.parse(fs.readFileSync(path.join(ws, "state", "douyin.json"), "utf8"));

const day = (n) => new Date(Date.now() - n * 86400000).toISOString();

// ---------------------------------------------------------------------------
// 记回复

test("记回复：挂到她发的那条评论下面", () => {
  const ws = tmp();
  seed(ws, {
    v1: { title: "测试视频", comments: [{ at: day(1), text: "我说了一句", replies: [] }] },
  });

  const r = inbox.recordReply(ws, { videoKey: "v1", from: "阿元", text: "我也这么想", at: day(0) });
  assert.equal(r.ok, true);
  assert.equal(r.replies, 1);

  const after = read(ws);
  assert.equal(after.videos.v1.comments[0].replies[0].from, "阿元");
  assert.equal(after.videos.v1.comments[0].replies[0].text, "我也这么想");
});

test("记回复：没有对应视频就拒绝", () => {
  const ws = tmp();
  seed(ws, {});
  const r = inbox.recordReply(ws, { videoKey: "nope", from: "阿元", text: "hi" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有这条视频/);
});

test("记回复：找不到自己发过的话就拒绝", () => {
  const ws = tmp();
  seed(ws, { v1: { title: "x", comments: [] } });
  const r = inbox.recordReply(ws, { videoKey: "v1", from: "阿元", text: "hi" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /找不到你在这条下面发过的话/);
});

test("记回复：不知道谁回的，拒绝", () => {
  const ws = tmp();
  seed(ws, { v1: { title: "x", comments: [{ at: day(1), text: "我说的" }] } });
  assert.equal(inbox.recordReply(ws, { videoKey: "v1", text: "hi" }).ok, false);
});

test("记回复：同一天同一个人同一句话，只记一次", () => {
  // 抖音通知列表会重复显示同一条。重复记会让"最后一句是谁说的"算错。
  const ws = tmp();
  seed(ws, { v1: { title: "x", comments: [{ at: day(1), text: "我说的", replies: [] }] } });

  inbox.recordReply(ws, { videoKey: "v1", from: "阿元", text: "嗯", at: day(0) });
  const r2 = inbox.recordReply(ws, { videoKey: "v1", from: "阿元", text: "嗯", at: day(0) });
  assert.equal(r2.duplicate, true);
  assert.equal(read(ws).videos.v1.comments[0].replies.length, 1);
});

test("记回复：不同天同样的话，算两条", () => {
  const ws = tmp();
  seed(ws, { v1: { title: "x", comments: [{ at: day(3), text: "我说的", replies: [] }] } });
  inbox.recordReply(ws, { videoKey: "v1", from: "阿元", text: "嗯", at: day(2) });
  inbox.recordReply(ws, { videoKey: "v1", from: "阿元", text: "嗯", at: day(0) });
  assert.equal(read(ws).videos.v1.comments[0].replies.length, 2);
});

// ---------------------------------------------------------------------------
// 谁在等

test("谁在等：最后一句是对方说的 → 要回", () => {
  const ws = tmp();
  seed(ws, {
    v1: {
      title: "测试视频",
      comments: [{ at: day(2), text: "我说了一句", replies: [{ from: "阿元", text: "你也在啊", at: day(0) }] }],
    },
  });

  const w = inbox.waiting(ws);
  assert.equal(w.length, 1);
  assert.equal(w[0].theirName, "阿元");
  assert.equal(w[0].theirText, "你也在啊");
  assert.equal(w[0].videoKey, "v1");
});

test("谁在等：超过三天的不再催", () => {
  const ws = tmp();
  seed(ws, {
    v1: {
      title: "旧视频",
      comments: [{ at: day(20), text: "我说的", replies: [{ from: "阿元", text: "旧回复", at: day(10) }] }],
    },
  });
  assert.equal(inbox.waiting(ws).length, 0, "十天前的回复现在回反而奇怪");
});

test("谁在等：没有回复的串不算", () => {
  const ws = tmp();
  seed(ws, { v1: { title: "x", comments: [{ at: day(1), text: "我说的", replies: [] }] } });
  assert.equal(inbox.waiting(ws).length, 0);
});

test("谁在等：多条按最新的排前面", () => {
  const ws = tmp();
  seed(ws, {
    v1: { title: "a", comments: [{ at: day(5), text: "m1", replies: [{ from: "甲", text: "x", at: day(2) }] }] },
    v2: { title: "b", comments: [{ at: day(5), text: "m2", replies: [{ from: "乙", text: "y", at: day(0) }] }] },
  });

  const w = inbox.waiting(ws);
  assert.equal(w.length, 2);
  assert.equal(w[0].theirName, "乙", "今天该排在两天前前面");
});

test("谁在等：老文件没有 replies 字段也不炸", () => {
  const ws = tmp();
  seed(ws, { v1: { title: "x", comments: [{ at: day(1), text: "我说的" }] } });
  assert.deepEqual(inbox.waiting(ws), []);
});

// ---------------------------------------------------------------------------
// inbox.md

test("inbox.md：有人等就写文件", () => {
  const ws = tmp();
  seed(ws, {
    v1: {
      title: "测试视频",
      comments: [{ at: day(1), text: "我也觉得", replies: [{ from: "阿元", text: "对呀", at: day(0) }] }],
    },
  });

  const r = inbox.refresh(ws);
  assert.equal(r.count, 1);
  const md = fs.readFileSync(path.join(ws, "state", "inbox.md"), "utf8");
  assert.match(md, /谁在等你回话/);
  assert.match(md, /阿元/);
  assert.match(md, /对呀/);
});

test("inbox.md：没人等就删掉文件，不留空壳", () => {
  const ws = tmp();
  seed(ws, { v1: { title: "x", comments: [{ at: day(1), text: "我说的", replies: [] }] } });
  fs.writeFileSync(path.join(ws, "state", "inbox.md"), "旧的");

  const r = inbox.refresh(ws);
  assert.equal(r.count, 0);
  assert.equal(fs.existsSync(path.join(ws, "state", "inbox.md")), false);
});

// ---------------------------------------------------------------------------
// 注入摘要

test("摘要：没人等返回 null，不占位置", () => {
  const ws = tmp();
  seed(ws, {});
  assert.equal(inbox.summary(ws), null);
});

test("摘要：有人等说清是谁、说了什么", () => {
  const ws = tmp();
  seed(ws, {
    v1: {
      title: "x",
      comments: [{ at: day(1), text: "我说", replies: [{ from: "阿元", text: "你也在这", at: day(0) }] }],
    },
  });

  const s = inbox.summary(ws);
  assert.equal(s.count, 1);
  assert.match(s.text, /别人在等你回/);
  assert.match(s.text, /阿元/);
  assert.match(s.text, /先去接话/);
});

// ---------------------------------------------------------------------------
// 最后一句必须真的是对方说的
//
// 这一条是这个模块存在的全部理由。没有它，她会被叫去回一条自己刚回过的话，
// 这是对一个正在对话的人最烦人的失败方式。

test("谁在等：最后一句是我自己说的 → 不催", () => {
  const ws = tmp();
  seed(ws, {
    v1: {
      title: "x",
      comments: [{
        at: day(4),
        text: "我说的",
        replies: [
          { from: "阿元", text: "你也在这", at: day(3) },
          { from: "本鱼", text: "我回过了", at: day(2), mine: true },
        ],
      }],
    },
  });
  assert.equal(inbox.waiting(ws).length, 0, "已经接完了，别再催");
});

test("谁在等：对方又追了一句 → 重新催", () => {
  const ws = tmp();
  seed(ws, {
    v1: {
      title: "x",
      comments: [{
        at: day(5),
        text: "我说的",
        replies: [
          { from: "本鱼", text: "我回了", at: day(4), mine: true },
          { from: "阿元", text: "又说了句", at: day(0) },
        ],
      }],
    },
  });
  const w = inbox.waiting(ws);
  assert.equal(w.length, 1);
  assert.equal(w[0].theirText, "又说了句");
});

test("记回复：自己的话可以标成 mine", () => {
  const ws = tmp();
  seed(ws, { v1: { title: "x", comments: [{ at: day(2), text: "我说的", replies: [] }] } });

  inbox.recordReply(ws, { videoKey: "v1", from: "本鱼", text: "我回了", mine: true, at: day(1) });
  const saved = read(ws).videos.v1.comments[0].replies[0];
  assert.equal(saved.mine, true);
});

test("记回复：别人说的默认不是 mine", () => {
  const ws = tmp();
  seed(ws, { v1: { title: "x", comments: [{ at: day(2), text: "我说的", replies: [] }] } });
  inbox.recordReply(ws, { videoKey: "v1", from: "阿元", text: "hi", at: day(1) });
  assert.equal(read(ws).videos.v1.comments[0].replies[0].mine, false);
});
