import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as about from "../lib/about.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "about-"));
  fs.mkdirSync(path.join(ws, "memory", "facts"), { recursive: true });
  return ws;
};

test("about: 偏好能认出来", () => {
  for (const s of ["我特别讨厌香菜", "我不喜欢人多的地方", "我最喜欢喝冰美式", "我对海鲜过敏", "我不能吃辣"]) {
    assert.ok(about.read(s), `应认出：${s}`);
  }
});

test("about: 不喜欢不会被读成喜欢", () => {
  const r = about.read("我特别不喜欢香菜");
  assert.equal(r.tag, "讨厌");
});

test("about: 事件不是偏好", () => {
  for (const s of ["今天吃了香菜", "昨天又吃了香菜", "我刚吃完饭"]) {
    assert.equal(about.read(s), null, `不该记：${s}`);
  }
});

test("about: 问句不是陈述", () => {
  assert.equal(about.read("我喜欢什么来着？"), null);
  assert.equal(about.read("我喜欢什么来着?"), null);
});

test("about: 别人的喜好不记在本鱼名下", () => {
  for (const s of ["我朋友说我喜欢狗", "他说「我喜欢猫」", "他特别讨厌香菜", "你要吃点什么"]) {
    assert.equal(about.read(s), null, `不该记：${s}`);
  }
});

test("about: 写进 person.md 且带 about 字段", () => {
  const ws = tmp();
  const r = about.remember(ws, { text: "我特别讨厌香菜", about: "用户", tag: "讨厌", importance: 0.75 });
  assert.equal(r.ok, true);
  const body = fs.readFileSync(path.join(ws, "memory", "facts", "person.md"), "utf8");
  assert.match(body, /about: 用户/);
  assert.match(body, /我特别讨厌香菜/);
});

test("about: 同一句不写两遍", () => {
  const ws = tmp();
  about.remember(ws, { text: "我特别讨厌香菜", about: "用户" });
  const second = about.remember(ws, { text: "我特别讨厌香菜", about: "用户" });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "duplicate");
  const lines = fs.readFileSync(path.join(ws, "memory", "facts", "person.md"), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
});

test("about: 去重跨过字段前缀（回归）", () => {
  // 曾经的 bug：tag 是最后一栏，`\|tag:[^|]+` 吃到行尾，
  // about/importance 残留在比较体里，同一句永远匹配不上自己。
  const ws = tmp();
  about.remember(ws, { text: "我对海鲜过敏", about: "用户", tag: "过敏", importance: 0.9 });
  const again = about.remember(ws, { text: "我对海鲜过敏", about: "用户", tag: "过敏", importance: 0.9 });
  assert.equal(again.ok, false);
});

test("about: describe 只挑重要的，且读得出", () => {
  const ws = tmp();
  about.remember(ws, { text: "我对海鲜过敏", about: "用户", tag: "过敏", importance: 0.9 });
  about.remember(ws, { text: "我最喜欢喝冰美式", about: "用户", tag: "喜欢", importance: 0.3 });
  const d = about.describe(ws, "用户");
  assert.match(d, /【他自己说过的】/);
  assert.match(d, /海鲜/);
  assert.ok(d.indexOf("海鲜") < d.indexOf("冰美式"), "重要的排前面");
});

test("about: describe 空文件返回空串", () => {
  assert.equal(about.describe(tmp(), "用户"), "");
});

test("about: known 只取这个人的", () => {
  const ws = tmp();
  about.remember(ws, { text: "我不吃香菜", about: "用户" });
  about.remember(ws, { text: "我怕冷", about: "别人" });
  const got = about.known(ws, "用户");
  assert.equal(got.length, 1);
  assert.match(got[0], /香菜/);
});

test("about: 没有 person.md 时不报错", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "about-empty-"));
  assert.deepEqual(about.known(ws, "用户"), []);
  assert.equal(about.describe(ws, "用户"), "");
});

test("about: 别名能对上同一个人（回归）", () => {
  // 真实情况：person.md 写的是主名（阿鲸），事件里是显示名（用户），互相都 contains 不到。
  // 如果不认别名，她会开始第二份关于同一个人的记忆。
  const ws = tmp();
  about.remember(ws, { text: "他要求称呼改成用户", about: "阿鲸", importance: 0.9 });
  assert.equal(about.known(ws, "用户").length, 0, "不传别名时对不上，这是旧行为");
  const withAlias = about.known(ws, "用户", 40, ["阿鲸"]);
  assert.equal(withAlias.length, 1, "传别名后应认出是同一个人");
});

test("about: 只认明确列出的名字，不做子串猜测", () => {
  const ws = tmp();
  about.remember(ws, { text: "我不吃香菜", about: "阿鲸" });
  assert.equal(about.known(ws, "老").length, 0, "「老」不该匹配到「阿鲸」");
  assert.equal(about.known(ws, "阿鲸").length, 1);
});

test("about: describe 去掉名字和日期，且补回主语", () => {
  const ws = tmp();
  fs.writeFileSync(
    path.join(ws, "memory", "facts", "person.md"),
    "- 2026-10-31T10:41:47.101Z | about: 阿鲸 | importance: 0.85 | 2026-10-31 18:41 起，阿鲸 定的规矩：一个回合发一到两张。\n",
  );
  const d = about.describe(ws, "阿鲸", { aliases: ["阿鲸"] });
  assert.ok(!d.includes("2026-10-31"), `不该带日期：${d}`);
  assert.ok(!d.includes("阿鲸"), `不该带名字：${d}`);
  assert.match(d, /【他自己说过的】他/);
});

test("about: describe 不把 quoted 词吃掉（回归）", () => {
  const ws = tmp();
  fs.writeFileSync(
    path.join(ws, "memory", "facts", "person.md"),
    "- 2026-10-31T07:37:58.168Z | about: 阿鲸 | importance: 0.7 | 阿鲸 2026-10-31 说过不喜欢「wronged（我不是小鲸鱼）」那张。\n",
  );
  const d = about.describe(ws, "阿鲸", { aliases: ["阿鲸"] });
  assert.match(d, /wronged/, `引号里的词被吃掉了：${d}`);
  assert.match(d, /我不是小鲸鱼/);
});

test("about: 写入用 USER.md 的主名，不是显示名（回归）", () => {
  // 真实情况：senderName 是显示名（用户），历史记录全是主名（阿鲸）。
  // 写显示名会让同一个人变成两个 owner，老偏好全部失联。
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "USER.md"), "- 称呼：阿鲸\n");
  about.remember(ws, { text: "我特别讨厌香菜", about: "阿鲸", tag: "讨厌" });
  const lines = fs.readFileSync(path.join(ws, "memory", "facts", "person.md"), "utf8");
  assert.match(lines, /about: 阿鲸/);
  assert.ok(!/about: 用户/.test(lines), "不该写成显示名");
});
