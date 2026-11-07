import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as discipline from "../lib/discipline.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "disc-"));
  fs.mkdirSync(path.join(ws, "memory", "self"), { recursive: true });
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};

// self.md 只有一个可读区段，标题是固定的。readEntries 从这一行之后开始
// 按 `- ` 切块，所以标题缺了就是"一条都没有"，不会报错 —— 这个失败模式
// 在真实文件里不会出现，但在测试里必须写对。
const writeSelf = (ws, lines) =>
  fs.writeFileSync(
    path.join(ws, "memory", "self", "self.md"),
    "## 本鱼写过的\n\n" + lines.join("\n") + "\n",
  );

const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86400000);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ---------------------------------------------------------------------------
// 退休：一条规矩，写下来之后再没记过复发，就该退场。
//
// 这是「写下来的东西不会过期」的解药。她的规矩表只增不减，13 条规矩
// 配 16 次复发，两边一起涨，读完只剩噪音。

test("之后没再复发 → 退休", () => {
  // 时间顺序很重要：复发在前，规矩在后。这样才叫"写下来之后没再犯"。
  // 反过来（规矩在前、复发在后）是没拦住，不是退休。
  const ws = tmp();
  writeSelf(ws, [
    `- ${daysAgo(20)} 又栽在同一个地方了`,
    `- ${daysAgo(10)} 以后别再一上来就画图`,
  ]);
  const r = discipline.survey(ws);
  assert.equal(r.retired_promises.length, 1);
  assert.equal(r.active_promises.length, 0);
  assert.match(r.retired_promises[0].why, /没再记过复发/);
});

test("之后还有复发 → 不退", () => {
  const ws = tmp();
  writeSelf(ws, [
    `- ${daysAgo(20)} 以后别再一上来就画图`,
    `- ${daysAgo(2)} 又栽在同一个地方了`,
  ]);
  const r = discipline.survey(ws);
  assert.equal(r.active_promises.length, 1);
  assert.equal(r.retired_promises.length, 0);
  assert.match(r.active_promises[0].why, /还有复发/);
});

test("写下来不到 3 天的，不参与退休", () => {
  // 刚写完就退场，等于一句话都没落地就作废。
  const ws = tmp();
  writeSelf(ws, [`- ${daysAgo(1)} 以后别再磨到第十五版`]);
  const r = discipline.survey(ws);
  assert.equal(r.retired_promises.length, 0);
  assert.match(r.active_promises[0].why, /还没到 3 天/);
});

test("退休是可逆的：新的复发一来，退掉的自己回来", () => {
  // 这个判据会错，错在她只是不写复发那类话了。
  // 所以宁可让它回来，也不让一条真规矩被永久埋掉。
  const ws = tmp();
  writeSelf(ws, [
    `- ${daysAgo(20)} 又栽了`,
    `- ${daysAgo(10)} 以后别再一上来就画图`,
  ]);
  assert.equal(discipline.survey(ws).retired_promises.length, 1, "先退掉");

  writeSelf(ws, [
    `- ${daysAgo(20)} 又栽了`,
    `- ${daysAgo(10)} 以后别再一上来就画图`,
    `- ${daysAgo(0)} 又栽在同一个坑`,
  ]);
  assert.equal(discipline.survey(ws).retired_promises.length, 0, "复发一来就回来");
  assert.equal(discipline.survey(ws).active_promises.length, 1);
});

test("没有任何复发记录时，老规矩可以退", () => {
  const ws = tmp();
  writeSelf(ws, [`- ${daysAgo(30)} 以后先看原文再说`]);
  const r = discipline.survey(ws);
  assert.equal(r.retired_promises.length, 1);
  assert.equal(r.newest_relapse_day, null);
});

test("只退该退的，不退全部的", () => {
  const ws = tmp();
  writeSelf(ws, [
    `- ${daysAgo(30)} 以后先看原文再说`,
    `- ${daysAgo(2)} 以后别在改稿上开第十六版`,
    `- ${daysAgo(1)} 又栽了`,
  ]);
  const r = discipline.survey(ws);
  // 30 天前那条：之后（1 天前）有复发 → 不退
  // 2 天前那条：不到 3 天 → 不退
  assert.equal(r.active_promises.length, 2);
  assert.equal(r.retired_promises.length, 0);
});

test("总数仍然对得上：active + retired = promises", () => {
  const ws = tmp();
  writeSelf(ws, [
    `- ${daysAgo(30)} 以后先看原文再说`,
    `- ${daysAgo(20)} 以后别再磨版`,
    `- ${daysAgo(15)} 又栽了`,
  ]);
  const r = discipline.survey(ws);
  assert.equal(
    r.active_promises.length + r.retired_promises.length,
    r.promises,
    "分成两堆不能丢条目",
  );
});
