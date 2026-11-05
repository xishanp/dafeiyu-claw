import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as goals from "../lib/goals.js";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "goals-test-"));
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n     ${e.message}`); }
}

t("首次加载给四条志向，默认 0.5", () => {
  const d = goals.load(ws);
  assert.equal(d.aspirations.length, 4);
  assert.equal(d.goals.length, 0);
  assert.equal(d.aspirations[0].value, 0.5);
});

t("创目标必须有 serves", () => {
  const r = goals.create(ws, { title: "把那个洞画完", source: "topic" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /serves/);
});

t("serves 必须在四条之内", () => {
  const r = goals.create(ws, { title: "随便", serves: "nonsense", source: "topic" });
  assert.equal(r.ok, false);
});

t("source 必须是三种之一", () => {
  const r = goals.create(ws, { title: "随便", serves: "output_producing", source: "made-up" });
  assert.equal(r.ok, false);
});

t("正常创建", () => {
  const r = goals.create(ws, {
    title: "把那个洞画完",
    serves: "output_producing",
    source: "unfinish",
    steps: ["改倒影", "发出去"],
  });
  assert.equal(r.ok, true);
  assert.equal(r.goal.status, "active");
  assert.equal(r.goal.steps.length, 2);
  assert.equal(r.goal.steps[0].done, false);
});

t("重复标题不能建两次（空格/标点归一化）", () => {
  const r = goals.create(ws, {
    title: " 把那个洞 画完。",
    serves: "output_producing",
    source: "topic",
  });
  assert.equal(r.ok, false);
  assert.equal(r.duplicate, true);
});

t("刚建的目标不算已推进（关键）", () => {
  const d = goals.load(ws);
  const g = d.goals[0];
  assert.equal(goals.advanced(g), false, "创建不应被当成进展");
  assert.equal(g.last_advanced_at, null);
});

t("加 evidence 才算推进", () => {
  const d = goals.load(ws);
  const id = d.goals[0].id;
  const before = d.goals[0].last_advanced_at;
  const r = goals.addEvidence(ws, id, { kind: "drawn", ref: "work/x.png", note: "改完倒影" });
  assert.equal(r.ok, true);
  assert.notEqual(r.goal.last_advanced_at, null);
  assert.notEqual(r.goal.last_advanced_at, before);
});

t("只有一轮没有 evidence 的空转，不算推进", () => {
  const d = goals.load(ws);
  const g = d.goals[0];
  // 模拟：又跑了一轮，什么都没变
  assert.equal(goals.advanced(g), false);
});

t("步骤完成算推进", () => {
  const d = goals.load(ws);
  const id = d.goals[0].id;
  const r = goals.markStep(ws, id, "改倒影", true);
  assert.equal(r.ok, true);
  assert.equal(r.goal.steps[0].done, true);
});

t("没 evidence 不能标 done", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-t2-"));
  const c = goals.create(fresh, { title: "空目标", serves: "world_knowledge", source: "topic" });
  const r = goals.close(fresh, c.goal.id, "done");
  assert.equal(r.ok, false);
  assert.match(r.reason, /evidence|released/);
});

t("没 evidence 可以标 released", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-t3-"));
  const c = goals.create(fresh, { title: "不想做了", serves: "world_knowledge", source: "topic" });
  const r = goals.close(fresh, c.goal.id, "released");
  assert.equal(r.ok, true);
  assert.equal(r.goal.status, "released");
});

t("done 之后留墓碑，同标题不能再造（防 Orrin 那个复活 28 次）", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-t4-"));
  const c = goals.create(fresh, { title: "已经做完的事", serves: "output_producing", source: "topic" });
  goals.addEvidence(fresh, c.goal.id, { kind: "drawn", ref: null });
  assert.equal(goals.close(fresh, c.goal.id, "done").ok, true);
  const again = goals.create(fresh, { title: "已经 做完的事", serves: "output_producing", source: "topic" });
  assert.equal(again.ok, false);
  assert.equal(again.tombstoned, true);
});

t("released 也留墓碑", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-t5-"));
  const c = goals.create(fresh, { title: "放弃的事", serves: "genuine_contact", source: "topic" });
  goals.close(fresh, c.goal.id, "released");
  const again = goals.create(fresh, { title: "放弃的事", serves: "genuine_contact", source: "topic" });
  assert.equal(again.tombstoned, true);
});

t("停滞 48 小时会被标出来", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-t6-"));
  const c = goals.create(fresh, { title: "老目标", serves: "world_knowledge", source: "topic" });
  const d = goals.load(fresh);
  d.goals[0].created_at = new Date(Date.now() - 72 * 3600_000).toISOString();
  d.goals[0].last_advanced_at = null;
  fs.writeFileSync(goals.goalsFile(fresh), JSON.stringify(d, null, 2));
  const stale = goals.staleGoals(fresh);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].id, c.goal.id);
});

t("刚推进过的目标不算停滞", () => {
  const d = goals.load(ws);
  d.goals[0].last_advanced_at = new Date().toISOString();
  assert.equal(goals.staleGoals(ws).some((g) => g.id === d.goals[0].id), false);
});

t("active 上限 12 条", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-t7-"));
  for (let i = 0; i < 12; i++) {
    const r = goals.create(fresh, { title: `目标${i}`, serves: "output_producing", source: "topic" });
    assert.equal(r.ok, true, `第 ${i} 条应该成功`);
  }
  const over = goals.create(fresh, { title: "第十三条", serves: "output_producing", source: "topic" });
  assert.equal(over.ok, false);
  assert.match(over.reason, /太多/);
});

t("标题超长会截断", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-t8-"));
  const long = "长".repeat(100);
  const r = goals.create(fresh, { title: long, serves: "output_producing", source: "topic" });
  assert.equal(r.ok, true);
  assert.equal(r.goal.title.length, 60);
});

t("空标题不建", () => {
  const r = goals.create(ws, { title: "   ", serves: "output_producing", source: "topic" });
  assert.equal(r.ok, false);
});

t("说明能给人看，且只给 active", () => {
  const list = goals.describe(ws);
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1);
  assert.ok(list[0].title);
  assert.ok("quietDays" in list[0]);
});

t("没有 active 时 describe 返回 null", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-t9-"));
  assert.equal(goals.describe(fresh), null);
});

t("找最弱的志向", () => {
  const d = goals.load(ws);
  const w = goals.weakestAspiration(d);
  assert.ok(w);
  assert.ok(w.id);
  assert.equal(typeof w.score, "number");
});

t("损坏的文件不会让整轮崩掉", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-t10-"));
  fs.mkdirSync(path.join(fresh, "state"), { recursive: true });
  fs.writeFileSync(path.join(fresh, "state", "goals.json"), "{ not json");
  const d = goals.load(fresh);
  assert.equal(d.goals.length, 0);
  assert.equal(d.aspirations.length, 4);
});

t("evidence 上限 20 条", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-t11-"));
  const c = goals.create(fresh, { title: "灌满", serves: "output_producing", source: "topic" });
  for (let i = 0; i < 25; i++) {
    goals.addEvidence(fresh, c.goal.id, { kind: "drawn", ref: null, note: `第${i}` });
  }
  const d = goals.load(fresh);
  assert.equal(d.goals[0].evidence.length, 20);
});

t("已关闭的目标不能再加 evidence", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-t12-"));
  const c = goals.create(fresh, { title: "关掉的", serves: "output_producing", source: "topic" });
  goals.addEvidence(fresh, c.goal.id, { kind: "drawn", ref: null });
  goals.close(fresh, c.goal.id, "done");
  const r = goals.addEvidence(fresh, c.goal.id, { kind: "drawn", ref: null });
  assert.equal(r.ok, false);
});


// ---- 回归：这几个函数必须真的活着，不能只有测试在调 ----
t("完成一条目标后，那条志向的 value 真的会涨", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-v1-"));
  const before = goals.load(fresh).aspirations.find((a) => a.id === "output_producing").value;
  const c = goals.create(fresh, { title: "做出点东西", serves: "output_producing", source: "topic" });
  goals.addEvidence(fresh, c.goal.id, { kind: "drawn", ref: null });
  goals.close(fresh, c.goal.id, "done");
  const after = goals.load(fresh).aspirations.find((a) => a.id === "output_producing").value;
  assert.ok(after > before, `value 应该涨：${before} → ${after}`);
});

t("released 会让 value 降一点", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-v2-"));
  const before = goals.load(fresh).aspirations.find((a) => a.id === "world_knowledge").value;
  const c = goals.create(fresh, { title: "放弃看看", serves: "world_knowledge", source: "topic" });
  goals.close(fresh, c.goal.id, "released");
  const after = goals.load(fresh).aspirations.find((a) => a.id === "world_knowledge").value;
  assert.ok(after < before, `value 应该降：${before} → ${after}`);
});

t("value 不会掉到 0 以下", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-v3-"));
  for (let i = 0; i < 30; i++) {
    const c = goals.create(fresh, { title: `放弃${i}`, serves: "genuine_contact", source: "topic" });
    goals.close(fresh, c.goal.id, "released");
  }
  const v = goals.load(fresh).aspirations.find((a) => a.id === "genuine_contact").value;
  assert.ok(v >= 0.1, `不许低于 0.1，实际 ${v}`);
});

t("pressureHint 能指出最弱的方向", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-v4-"));
  const h = goals.pressureHint(fresh);
  assert.ok(h);
  assert.ok(h.id);
  assert.equal(typeof h.value, "number");
});

t("describe 会标出 stale", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-v5-"));
  const c = goals.create(fresh, { title: "放三天了", serves: "output_producing", source: "topic" });
  const d = goals.load(fresh);
  d.goals[0].created_at = new Date(Date.now() - 72 * 3600_000).toISOString();
  fs.writeFileSync(goals.goalsFile(fresh), JSON.stringify(d, null, 2));
  const list = goals.describe(fresh);
  assert.equal(list[0].id, c.goal.id);
  assert.equal(list[0].stale, true);
  assert.ok(list[0].quietDays >= 2);
});


// ---- 阈值必须真的能触发 ----
t("初始 value 0.5 不会触发压力提示（阈值 0.35）", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-p1-"));
  const h = goals.pressureHint(fresh);
  assert.ok(h.value > 0.35, `初始值应高于阈值，实际 ${h.value}`);
});

t("掉到 0.35 以下才该提示", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "goals-p2-"));
  // 连续释放把某条志向压下去
  for (let i = 0; i < 8; i++) {
    const c = goals.create(fresh, { title: `放弃${i}`, serves: "genuine_contact", source: "topic" });
    goals.close(fresh, c.goal.id, "released");
  }
  const v = goals.load(fresh).aspirations.find((a) => a.id === "genuine_contact").value;
  assert.ok(v < 0.5, `应该被压低了，实际 ${v}`);
});
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
