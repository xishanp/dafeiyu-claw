import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as revisit from "../lib/revisit.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "revisit-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.mkdirSync(path.join(ws, "memory", "facts"), { recursive: true });
  return ws;
};

const day = (offset) => {
  const d = new Date(Date.now() - offset * 86400000);
  return d.toISOString().slice(0, 10);
};

test("revisit: 5-gram 能算出重合率", () => {
  const a = "今天走了很远的路去看那片海";
  const b = "今天走了很远的路去看那片海，水很凉";
  const r = revisit.overlap(a, b);
  assert.ok(r.ratio > 0.8, `几乎完全相同应高重合，实际 ${r.ratio}`);
  assert.ok(r.matches >= 2);
});

test("revisit: 完全无关的两句重合为 0", () => {
  const r = revisit.overlap("今天走了很远的路", "编译器在第三行报了个错");
  assert.equal(r.ratio, 0);
});

test("revisit: 太短的话也能比较（不会因为不足 5 字就永远 0）", () => {
  // 两个字的句子切不出 5-gram，但如果不给兜底，它跟谁都 0 重合，
  // 于是一切短句都会被判成「再没提起过」。
  const r = revisit.overlap("嗯", "嗯");
  assert.ok(r.ratio > 0, "两个字的完全一样也该有重合");
});

test("revisit: 扫描能找出从没回访的话", () => {
  const ws = tmp();
  const old = day(5);
  const today = day(0);
  fs.writeFileSync(
    path.join(ws, "memory", `${old}.md`),
    `- 10:00 主动跟用户说了句今天天气不错，问他那边怎么样\n`,
  );
  fs.writeFileSync(
    path.join(ws, "memory", `${today}.md`),
    `- 09:00 写了点代码，修了一个解析器的边界问题\n`,
  );

  const d = revisit.scan(ws);
  assert.ok(d.total >= 1, `应该扫到至少一条，实际 ${d.total}`);
  const coldOne = d.lines.find((x) => x.day === old);
  assert.ok(coldOne, "应找到旧的那条");
  assert.equal(coldOne.cold, true, "后来完全没提到，应该是冷的");
});

test("revisit: 后来被提过的，不算冷", () => {
  const ws = tmp();
  const old = day(4);
  const today = day(0);
  const said = "我今天去看了那片海，水特别凉";
  fs.writeFileSync(path.join(ws, "memory", `${old}.md`), `- 10:00 主动跟用户说了：${said}\n`);
  fs.writeFileSync(path.join(ws, "memory", `${today}.md`), `- 11:00 又想起${said}，跟用户提了一句\n`);

  const d = revisit.scan(ws);
  const item = d.lines.find((x) => x.day === old);
  assert.ok(item);
  assert.equal(item.cold, false, "后来提过就不冷");
});

test("revisit: 最后一天的话不判冷（后面还没有内容可比）", () => {
  const ws = tmp();
  const today = day(0);
  fs.writeFileSync(path.join(ws, "memory", `${today}.md`), `- 10:00 主动跟用户说了句话\n`);
  const d = revisit.scan(ws);
  const item = d.lines.find((x) => x.day === today);
  if (item) assert.equal(item.cold, undefined, "最新那天没有之后可比，不该判冷");
});

test("revisit: 冷的话能重新变成候选", () => {
  const ws = tmp();
  const old = day(3);
  fs.writeFileSync(path.join(ws, "memory", `${old}.md`), `- 10:00 主动跟用户说了：想去看看那片海到底有多宽\n`);
  fs.writeFileSync(path.join(ws, "memory", `${day(0)}.md`), `- 09:00 写代码\n`);
  revisit.scan(ws);

  const r = revisit.resurface(ws);
  assert.ok(r, "三天前冷掉的话应该能被翻出来");
  assert.match(r.line, /后来一直没再提/);
  assert.ok(r.salience > 0 && r.salience <= 1);
});

test("revisit: 太新的不翻（她自己还没走远）", () => {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "memory", `${day(0)}.md`), `- 10:00 主动说了句话\n`);
  fs.writeFileSync(path.join(ws, "memory", `${day(1)}.md`), `- 09:00 写代码\n`);
  revisit.scan(ws);
  // 0 天前的不在 1–10 天窗口内
  const r = revisit.resurface(ws);
  if (r) assert.notEqual(r.day, day(0), "当天的不该被翻出来");
});

test("revisit: 太旧的不翻（翻旧账是骚扰）", () => {
  const ws = tmp();
  const ancient = day(60);
  fs.writeFileSync(path.join(ws, "memory", `${ancient}.md`), `- 10:00 主动说了：很久以前的一句话\n`);
  fs.writeFileSync(path.join(ws, "memory", `${day(0)}.md`), `- 09:00 写代码\n`);
  revisit.scan(ws);
  assert.equal(revisit.resurface(ws), null, "六十天前的不该翻出来");
});

test("revisit: 没有数据时 resurface 返回 null 不报错", () => {
  const ws = tmp();
  assert.equal(revisit.resurface(ws), null);
  assert.deepEqual(revisit.cold(ws), []);
});

test("revisit: 空目录扫描不崩", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "revisit-empty-"));
  const d = revisit.scan(ws);
  assert.equal(d.total, 0);
  assert.equal(d.revisit_rate, null, "没有样本时回访率应是 null 不是 0");
});

test("revisit: 统计能读回来", () => {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "memory", `${day(2)}.md`), `- 10:00 主动说了句话给用户听\n`);
  revisit.scan(ws);
  const s = revisit.stats(ws);
  assert.ok(s.total >= 1);
  assert.equal(typeof s.updated_at, "string");
});

test("revisit: 机器行不算成「她自己的话」", () => {
  // 工具日志里也会有「说了」这种字，但那是记录不是她的话。
  const ws = tmp();
  fs.writeFileSync(
    path.join(ws, "memory", `${day(2)}.md`),
    `- 10:00 | tool | exec 说了点什么\n` +
    `- 10:01 主动跟用户说：今天想出去看看\n`,
  );
  const d = revisit.scan(ws);
  assert.equal(d.total, 1, `只该认那一句人话，实际 ${d.total}`);
});

test("revisit: 最新那天一条都不该判冷（哪怕 facts 有内容）", () => {
  // 上一版的 bug：用 `!corpus` 判断「有没有之后」，但 laterCorpus 会读
  // facts/ 和 self/，永远不为空 —— 那个分支一次都不会走到。
  // 结果当天说的话只要 facts 里碰不上就被判冷。
  // 实测 2026-11-07：当天 5 句全被判冷，其中几条是十分钟前刚写下的。
  const ws = tmp();
  fs.writeFileSync(
    path.join(ws, "memory", "facts", "self.md"),
    "一些早就存在的自我描述，跟今天的话无关\n",
  );
  const today = day(0);
  fs.writeFileSync(
    path.join(ws, "memory", `${today}.md`),
    `- 10:00 主动跟用户说：这件事情我已经想清楚了\n`,
  );
  const d = revisit.scan(ws);
  const item = d.lines.find((x) => x.day === today);
  assert.ok(item, "应该扫到当天那条");
  assert.notEqual(item.cold, true, "最新那天不该判冷");
  assert.equal(item.ratio, null, "没有可比的之后，ratio 应是 null");
});
