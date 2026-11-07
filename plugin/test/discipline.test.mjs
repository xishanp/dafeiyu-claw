// Discipline counts — arithmetic over her own words, never semantic matching.
//
// The regression this locks is specific: an earlier attempt to pair "promise"
// with "relapse" by sentence similarity scored 0.034 vs 0.036 on a control and
// was abandoned (see lib/compulsion.js header). These tests assert the module
// stays on the side of counting stated facts.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as d from "../lib/discipline.js";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n     ${e.message}`); }
};

const ws = (lines) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "disc-"));
  fs.mkdirSync(path.join(dir, "memory", "self"), { recursive: true });
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  if (lines) {
    const doc = `# 本鱼自己写的\n\n## 本鱼写过的\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`;
    fs.writeFileSync(path.join(dir, "memory", "self", "self.md"), doc);
  }
  return dir;
};

t("没有 self.md 时不抛异常，返回零", () => {
  const s = d.survey(ws(null));
  assert.equal(s.entries, 0);
  assert.equal(s.promises, 0);
});

t("统计条数、承诺数、复发数", () => {
  const s = d.survey(ws([
    "11-04 今天画了三张图",
    "11-04 又栽在同一个地方了",
    "11-05 以后先看原文那一句再看别的",
    "11-06 同一个毛病又犯了",
    "11-06 以后加因素要留对照组",
  ]));
  assert.equal(s.entries, 5);
  assert.equal(s.promises, 2);
  assert.equal(s.relapses, 2);
});

t("只数第一条承诺之后的复发，之前的算旧账", () => {
  const s = d.survey(ws([
    "11-01 又栽在同一个坑里",
    "11-02 同一个毛病",
    "11-04 以后先看原文",
    "11-05 又栽在同一个地方",
    "11-06 同一个毛病",
  ]));
  assert.equal(s.first_promise_day, "11-04");
  // 11-01 and 11-02 happened before any rule existed.
  assert.equal(s.relapses_after_first_promise, 2);
});

t("同一天的承诺和复发都算在内（同一天立了也犯了）", () => {
  const s = d.survey(ws([
    "11-05 以后先看原文",
    "11-05 又栽在同一个地方",
  ]));
  assert.equal(s.relapses_after_first_promise, 1);
});

t("少于 3 条规矩时保持沉默，不下结论", () => {
  const dir = ws(["11-04 以后先看原文", "11-05 又栽在同一个地方"]);
  assert.equal(d.describe(dir), "");
});

t("规矩够多、复发够多时才说话", () => {
  const dir = ws([
    "11-01 以后先看原文那一句",
    "11-02 以后加因素要留对照",
    "11-03 以后说稳定之前先凑格子",
    "11-04 又栽在同一个地方",
    "11-05 同一个毛病",
    "11-06 又栽在同一个坑里",
  ]);
  const out = d.describe(dir);
  assert.ok(out.includes("3 条"));
  assert.ok(out.includes("3 次"));
});

t("规矩多但没有复发时不说「拦不住」", () => {
  const dir = ws([
    "11-01 以后先看原文那一句",
    "11-02 以后加因素要留对照",
    "11-03 以后说稳定之前先凑格子",
  ]);
  // describe() reads from disk state when present; survey fallback is used here.
  const out = d.describe(dir);
  assert.equal(out.includes("没拦住"), false);
});

t("refresh 写入 state/discipline.json", () => {
  const dir = ws(["11-04 以后先看原文", "11-05 又栽在同一个地方"]);
  const r = d.refresh(dir, { force: true });
  assert.equal(r.ran, true);
  assert.ok(fs.existsSync(d.disciplineFile(dir)));
  const back = d.load(dir);
  assert.equal(back.promises, 1);
});

t("refresh 在 30 分钟内不重复计算", () => {
  const dir = ws(["11-04 以后先看原文"]);
  d.refresh(dir, { force: true });
  const second = d.refresh(dir);
  assert.equal(second.ran, false);
});

t("state 文件损坏时回退到现算，不抛", () => {
  const dir = ws(["11-04 以后先看原文"]);
  fs.writeFileSync(d.disciplineFile(dir), "{not json");
  assert.equal(d.load(dir), null);
  assert.equal(d.survey(dir).promises, 1);
});

t("trail 只在数字变化时增长", () => {
  const dir = ws(["11-04 以后先看原文", "11-05 又栽在同一个地方"]);
  const a = d.refresh(dir, { force: true });
  assert.equal(a.data.trail.length, 1);
  const b = d.refresh(dir, { force: true });
  assert.equal(b.data.trail.length, 1, "数字没变不该追加");
  // A new relapse must produce a new point.
  fs.appendFileSync(
    path.join(dir, "memory", "self", "self.md"),
    "- 11-06 同一个毛病又犯了\n"
  );
  const c = d.refresh(dir, { force: true });
  assert.equal(c.data.trail.length, 2);
  assert.equal(c.data.trail[1].relapses, 2);
});

t("trail 不会无限增长（上限 40）", () => {
  const dir = ws(["11-04 以后先看原文"]);
  d.refresh(dir, { force: true });
  const back = d.load(dir);
  back.trail = Array.from({ length: 60 }, (_, i) => ({ at: "x", promises: i, relapses: i }));
  d.save(dir, back);
  d.refresh(dir, { force: true });
  assert.ok(d.load(dir).trail.length <= 40);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
