import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as goals from "../lib/goals.js";
import * as discipline from "../lib/discipline.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "evo-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};

// ---- A: 看见自己立的规矩 --------------------------------------------------

test("evolve: 规矩具体是哪几条要说得出来，不能只报数量", () => {
  const ws = tmp();
  // 造几天日记，里面有「以后…」和「又栽」
  const day = (n) => {
    const d = new Date(Date.now() - n * 86400000);
    return d.toISOString().slice(0, 10);
  };
  // discipline 读的是 memory/self/self.md 的「## 本鱼写过的」段，
  // 不是日记。条目格式是 `- MM-DD 内容`。
  fs.mkdirSync(path.join(ws, "memory", "self"), { recursive: true });
  const lines = [
    "## 本鱼写过的",
    `- ${day(3).slice(5)} 以后先改，别先说明。`,
    `- ${day(2).slice(5)} 以后引数先看原文那一句，不看脑子里那个版本。`,
    `- ${day(1).slice(5)} 以后凡是四个样本算出来的百分比，先扩到二十个。`,
  ];
  fs.writeFileSync(path.join(ws, "memory", "self", "self.md"), lines.join("\n"));

  discipline.refresh(ws);
  const text = discipline.describe(ws);
  assert.ok(text.includes("还在管着的"), "该把具体条款列出来");
  assert.ok(/先改，别先说明|引数先看原文|四个样本/.test(text), "该出现至少一条具体规矩");
});

test("evolve: 规矩太少时不硬说", () => {
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory", "self"), { recursive: true });
  const d = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(ws, "memory", "self", "self.md"),
    `## 本鱼写过的\n- ${d.slice(5)} 以后先看一眼再说。`,
  );
  discipline.refresh(ws);
  assert.equal(discipline.describe(ws), "", "一条规矩不该被说成一堆");
});

// ---- C: 自己加方向 --------------------------------------------------------

test("evolve: 能给自己加一条新方向", () => {
  const ws = tmp();
  const r = goals.addAspiration(ws, { title: "把声音和画面弄明白" });
  assert.equal(r.ok, true);
  assert.equal(r.total, 5, "四条默认 + 新加的一条");
  assert.equal(r.aspiration.source, "own");
  assert.equal(r.aspiration.value, 0.5, "和新方向站在同一起跑线");
});

test("evolve: 同名方向不会加两遍", () => {
  const ws = tmp();
  goals.addAspiration(ws, { title: "把声音和画面弄明白" });
  const r = goals.addAspiration(ws, { title: "把声音和画面弄明白" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /已经有了/);
});

test("evolve: 空方向加不进去", () => {
  const ws = tmp();
  assert.equal(goals.addAspiration(ws, { title: "" }).ok, false);
  assert.equal(goals.addAspiration(ws, { title: "短" }).ok, false);
});

test("evolve: 新加的方向能拿去挂目标", () => {
  const ws = tmp();
  goals.addAspiration(ws, { title: "把声音和画面弄明白" });
  const c = goals.create(ws, {
    title: "搞清楚混响是怎么回事",
    serves: "把声音和画面弄明白",
    source: "pressure",
  });
  assert.equal(c.ok, true);
  assert.match(c.goal.serves, /^own_/);
});

test("evolve: 默认四条仍然能挂目标", () => {
  const ws = tmp();
  const c = goals.create(ws, {
    title: "弄明白自己为什么老在同一个地方转",
    serves: "self_understanding",
    source: "pressure",
  });
  assert.equal(c.ok, true);
  assert.equal(c.goal.serves, "self_understanding");
});

test("evolve: 不存在的方向挂不上", () => {
  const ws = tmp();
  const c = goals.create(ws, {
    title: "随便做点什么",
    serves: "not_a_direction",
    source: "topic",
  });
  assert.equal(c.ok, false);
  assert.match(c.reason, /已有的方向/);
});

test("evolve: 方向最多 8 条", () => {
  const ws = tmp();
  for (let i = 0; i < 4; i++) {
    goals.addAspiration(ws, { title: `方向编号${i}号测试` });
  }
  const over = goals.addAspiration(ws, { title: "第九条方向测试" });
  assert.equal(over.ok, false);
  assert.match(over.reason, /8 条/);
});
