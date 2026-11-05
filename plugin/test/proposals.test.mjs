import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as proposals from "../lib/proposals.js";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n     ${e.message}`); }
};

const DAY = 86400000;

function ws() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m4-"));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  return dir;
}

function writeJson(dir, name, obj) {
  fs.writeFileSync(path.join(dir, "state", name), JSON.stringify(obj, null, 2));
}

function goal(dir, g) {
  const file = path.join(dir, "state", "goals.json");
  let data = { version: 1, aspirations: [], goals: [], tombstones: [] };
  if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.goals.push(g);
  writeJson(dir, "goals.json", data);
}

function effect(dir, at) {
  const file = path.join(dir, "state", "effects.json");
  let data = { version: 1, entries: [] };
  if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.entries.push({ kind: "drawn", note: "x", verified: true, at });
  writeJson(dir, "effects.json", data);
}

function experience(dir, entries) {
  writeJson(dir, "experience-pool.json", { version: 1, entries });
}

const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

// ------------------------------------------------ 空工作区必须闭嘴

t("空工作区不产生任何提案", () => {
  const dir = ws();
  assert.deepEqual(proposals.collect(dir), []);
});

t("只有 goals 但没有卡住的，也不提", () => {
  const dir = ws();
  goal(dir, { id: "g1", title: "新鲜事", serves: "world_knowledge", status: "active", created_at: ago(0.1), last_advanced_at: ago(0.1) });
  assert.deepEqual(proposals.collect(dir), []);
});

// ------------------------------------------------ stalled_goal

t("目标卡 3 天 → 提一条，且带 wants", () => {
  const dir = ws();
  goal(dir, { id: "g1", title: "画那盏灯", serves: "output_producing", status: "active", created_at: ago(10), last_advanced_at: ago(3) });
  const p = proposals.checkStalledGoal(dir);
  assert.ok(p, "应该提");
  assert.equal(p.kind, "stalled_goal");
  assert.ok(p.text.includes("画那盏灯"));
  assert.ok(p.wants && p.wants.length > 4, "必须说该怎么办");
});

t("卡 3 天和卡 7 天的 wants 不一样", () => {
  const dir = ws();
  goal(dir, { id: "g1", title: "A", serves: "output_producing", status: "active", created_at: ago(30), last_advanced_at: ago(3) });
  const short = proposals.checkStalledGoal(dir);
  const dir2 = ws();
  goal(dir2, { id: "g1", title: "A", serves: "output_producing", status: "active", created_at: ago(30), last_advanced_at: ago(7) });
  const long = proposals.checkStalledGoal(dir2);
  assert.notEqual(short.wants, long.wants, "久了该建议放掉，不是继续推");
  assert.ok(long.wants.includes("released"));
});

t("多个卡住的，只提最老的那个", () => {
  const dir = ws();
  goal(dir, { id: "g1", title: "新的", serves: "output_producing", status: "active", created_at: ago(5), last_advanced_at: ago(3) });
  goal(dir, { id: "g2", title: "更老的", serves: "output_producing", status: "active", created_at: ago(30), last_advanced_at: ago(20) });
  const p = proposals.checkStalledGoal(dir);
  assert.ok(p.text.includes("更老的"), `应该提最老的，实际：${p.text}`);
});

t("已关闭的目标不算卡住", () => {
  const dir = ws();
  goal(dir, { id: "g1", title: "做完了", serves: "output_producing", status: "done", created_at: ago(30), last_advanced_at: ago(20) });
  assert.equal(proposals.checkStalledGoal(dir), null);
});

// ------------------------------------------------ unresolved_repeat

t("同一想法丢 3 次 → 提一条", () => {
  const dir = ws();
  experience(dir, [
    { id: "e1", status: "dropped", gist: "为什么被夸会不好意思" },
    { id: "e2", status: "dropped", gist: "为什么被夸会不好意思" },
    { id: "e3", status: "dropped", gist: "为什么被夸会不好意思。" },
  ]);
  const p = proposals.checkUnresolvedRepeat(dir);
  assert.ok(p, "标点不同也该算同一条");
  assert.equal(p.kind, "unresolved_repeat");
  assert.ok(p.text.includes("3 次"));
  assert.ok(p.wants.includes("experience_resolve"));
});

t("只丢 2 次不提", () => {
  const dir = ws();
  experience(dir, [
    { id: "e1", status: "dropped", gist: "同一个问题" },
    { id: "e2", status: "dropped", gist: "同一个问题" },
  ]);
  assert.equal(proposals.checkUnresolvedRepeat(dir), null);
});

t("status=kept 的不算丢", () => {
  const dir = ws();
  experience(dir, [
    { id: "e1", status: "kept", gist: "同一个问题" },
    { id: "e2", status: "kept", gist: "同一个问题" },
    { id: "e3", status: "kept", gist: "同一个问题" },
  ]);
  assert.equal(proposals.checkUnresolvedRepeat(dir), null);
});

t("多组都达标时提重复最多的", () => {
  const dir = ws();
  const mk = (n, gist) => Array.from({ length: n }, (_, i) => ({ id: `${gist}${i}`, status: "dropped", gist }));
  experience(dir, [...mk(3, "少一些的"), ...mk(5, "最多的那个")]);
  const p = proposals.checkUnresolvedRepeat(dir);
  assert.ok(p.text.includes("最多的那个"), `实际：${p.text}`);
  assert.ok(p.text.includes("5 次"));
});

// ------------------------------------------------ empty_production

t("4 天没产出 → 提一条", () => {
  const dir = ws();
  effect(dir, ago(4));
  const p = proposals.checkEmptyProduction(dir);
  assert.ok(p);
  assert.equal(p.kind, "empty_production");
  assert.ok(p.text.includes("4 天"));
  assert.ok(p.wants.length > 4);
});

t("昨天刚做过不提", () => {
  const dir = ws();
  effect(dir, ago(1));
  assert.equal(proposals.checkEmptyProduction(dir), null);
});

t("从未产出的新号不提（不是干涸，是年轻）", () => {
  const dir = ws();
  assert.equal(proposals.checkEmptyProduction(dir), null);
});

// ------------------------------------------------ world_starved

t("目标全是朝内的 → 提一条", () => {
  const dir = ws();
  for (let i = 0; i < 5; i++) {
    goal(dir, { id: `g${i}`, title: `自己的事${i}`, serves: "self_understanding", status: "active", created_at: ago(1), last_advanced_at: ago(1) });
  }
  const p = proposals.checkWorldStarved(dir);
  assert.ok(p);
  assert.equal(p.kind, "world_starved");
  assert.ok(p.wants.includes("查"));
});

t("朝内朝外各一半不提", () => {
  const dir = ws();
  for (let i = 0; i < 3; i++) goal(dir, { id: `a${i}`, title: `内${i}`, serves: "self_understanding", status: "active", created_at: ago(1), last_advanced_at: ago(1) });
  goal(dir, { id: "b1", title: "外1", serves: "world_knowledge", status: "active", created_at: ago(1), last_advanced_at: ago(1) });
  assert.equal(proposals.checkWorldStarved(dir), null);
});

t("目标少于 4 个不判（一个不算比例）", () => {
  const dir = ws();
  goal(dir, { id: "g1", title: "只有一件", serves: "self_understanding", status: "active", created_at: ago(1), last_advanced_at: ago(1) });
  assert.equal(proposals.checkWorldStarved(dir), null);
});

// ------------------------------------------------ 组合与约束

t("多个检查同时命中，全部收进来", () => {
  const dir = ws();
  goal(dir, { id: "g1", title: "画那盏灯", serves: "output_producing", status: "active", created_at: ago(30), last_advanced_at: ago(5) });
  effect(dir, ago(6));
  experience(dir, [
    { id: "e1", status: "dropped", gist: "想不通的事" },
    { id: "e2", status: "dropped", gist: "想不通的事" },
    { id: "e3", status: "dropped", gist: "想不通的事" },
  ]);
  const all = proposals.collect(dir);
  const kinds = all.map((p) => p.kind).sort();
  assert.deepEqual(kinds, ["empty_production", "stalled_goal", "unresolved_repeat"]);
});

t("转成候选后不豁免习惯化（不能一直唠叨）", () => {
  const dir = ws();
  goal(dir, { id: "g1", title: "画那盏灯", serves: "output_producing", status: "active", created_at: ago(30), last_advanced_at: ago(5) });
  const cands = proposals.asCandidates(proposals.collect(dir));
  assert.ok(cands.length > 0);
  for (const c of cands) {
    assert.equal(c.exempt, false, "提案不该豁免，输了就该退场");
    assert.ok(c.key.startsWith("proposal:"), "key 必须带前缀，避免和 M3 自己的撞");
  }
});

t("提案只能作候选，模块自己不注入（bias never preempt）", () => {
  const exports = Object.keys(proposals).sort();
  for (const forbidden of ["inject", "write", "apply", "push"]) {
    assert.ok(!exports.includes(forbidden), `不该导出 ${forbidden}`);
  }
});

t("每个提案都带 wants", () => {
  const dir = ws();
  goal(dir, { id: "g1", title: "画那盏灯", serves: "output_producing", status: "active", created_at: ago(30), last_advanced_at: ago(5) });
  effect(dir, ago(6));
  for (const p of proposals.collect(dir)) {
    assert.ok(p.wants && typeof p.wants === "string" && p.wants.length > 4, `${p.kind} 缺 wants`);
  }
});

t("注入的 text 必须自带 wants，不能只说卡住了", () => {
  // 规格原文：每个提案必须带 wants，不能只说「你卡住了」。
  // 曾经 wants 只存在字段里，而注入只读 text，于是空产出的提案注入出来就是
  // 「已经 7 天没做出东西了，光在想。」——说了病，没给药。
  const dir = ws();
  goal(dir, { id: "g1", title: "画那盏灯", serves: "output_producing", status: "active", created_at: ago(30), last_advanced_at: ago(6) });
  effect(dir, ago(7));
  experience(dir, [
    { id: "e1", status: "dropped", gist: "想不通的事" },
    { id: "e2", status: "dropped", gist: "想不通的事" },
    { id: "e3", status: "dropped", gist: "想不通的事" },
  ]);
  for (let i = 0; i < 5; i++) {
    goal(dir, { id: `s${i}`, title: `自己的事${i}`, serves: "self_understanding", status: "active", created_at: ago(1), last_advanced_at: ago(1) });
  }
  const all = proposals.collect(dir);
  assert.ok(all.length >= 3, `该有多条，实际 ${all.length}`);
  for (const p of all) {
    assert.ok(p.text.includes(p.wants), `${p.kind} 的 text 丢了 wants：${p.text}`);
  }
});

t("提案是人话，不是 stall=12", () => {
  const dir = ws();
  goal(dir, { id: "g1", title: "画那盏灯", serves: "output_producing", status: "active", created_at: ago(30), last_advanced_at: ago(5) });
  const p = proposals.checkStalledGoal(dir);
  assert.ok(!/=\s*\d/.test(p.text), `不该出现表达式：${p.text}`);
  assert.ok(p.text.length > 8);
});

t("坏文件不炸", () => {
  const dir = ws();
  fs.writeFileSync(path.join(dir, "state", "goals.json"), "{ 坏掉");
  fs.writeFileSync(path.join(dir, "state", "experience-pool.json"), "也是坏的");
  fs.writeFileSync(path.join(dir, "state", "effects.json"), "全坏");
  assert.deepEqual(proposals.collect(dir), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
