import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as habit from "../lib/habit.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "habit-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};

// ---------------------------------------------------------------- 纠正检测

test("habit: 明确说错了的能认出来", () => {
  const hits = habit.detectCorrections("不对，应该用 tabs。");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].phrase, "不对");
});

test("habit: 纯任务描述不算纠正", () => {
  // 这条是原实现的 TASK_PREFIX 规则：句首是动词的是任务，不是纠正。
  const hits = habit.detectCorrections("帮我改一下这个文件");
  assert.equal(hits.length, 0, "任务描述不该被当成纠正");
});

test("habit: 任务句里如果开头就是纠正词，仍然算", () => {
  const hits = habit.detectCorrections("别用 tabs，改成空格");
  assert.ok(hits.length >= 1);
});

test("habit: 太长的不算", () => {
  const long = `不对，${"很长的内容".repeat(120)}`;
  assert.equal(habit.detectCorrections(long).length, 0);
});

test("habit: 一句话里多个纠正只算命中的那几段", () => {
  const hits = habit.detectCorrections("不对。你搞错了。");
  assert.equal(hits.length, 2);
});

// ---------------------------------------------------------------- 观察流水线

test("habit: 没到阈值不触发判定", async () => {
  const ws = tmp();
  const r1 = await habit.observe(ws, { sessionId: "s1", turn: 1, text: "不对，应该这样" });
  assert.equal(r1.triggered, false);
  assert.equal(r1.detected, 1);
});

test("habit: 同一会话到 3 次才触发", async () => {
  const ws = tmp();
  let last;
  for (let i = 0; i < 3; i += 1) {
    last = await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，应该用空格" });
  }
  assert.equal(last.triggered, true);
  assert.equal(last.sessionCount, 3);
});

test("habit: 一个会话只触发一次，第 4 次不再触发", async () => {
  const ws = tmp();
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，用空格" });
  const fourth = await habit.observe(ws, { sessionId: "s1", turn: 3, text: "不对，用空格" });
  assert.equal(fourth.triggered, false, "同一会话不该反复触发");
});

test("habit: 没有判定器时走规则回退，仍然产出 pending 候选", async () => {
  // fail open：判定不可用不能阻塞流水线。
  const ws = tmp();
  let r;
  for (let i = 0; i < 3; i += 1) r = await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，应该用空格" });
  assert.equal(r.judge, "rule");
  assert.ok(r.candidateId, "规则回退也要产出候选");
});

test("habit: 候选默认是 pending，不会被注入", async () => {
  const ws = tmp();
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，应该用空格" });
  const rv = habit.review(ws);
  assert.equal(rv.candidates.length, 1);
  assert.equal(rv.candidates[0].status, "pending");
  assert.equal(habit.activeHabits(ws).length, 0, "pending 不该进注入");
});

test("habit: 判定器说是习惯就采纳，说不是就不产出候选", async () => {
  const ws = tmp();
  const yes = async () => '{"isHabit":true,"pattern":"always use spaces","category":"format","confidence":0.9}';
  let r;
  for (let i = 0; i < 3; i += 1) {
    r = await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，应该用空格", judge: yes });
  }
  assert.equal(r.judge, "judge");
  assert.ok(r.candidateId);

  const ws2 = tmp();
  const no = async () => '{"isHabit":false,"pattern":"","category":"other","confidence":0.1}';
  let r2;
  for (let i = 0; i < 3; i += 1) {
    r2 = await habit.observe(ws2, { sessionId: "s1", turn: i, text: "不对，应该用空格", judge: no });
  }
  assert.equal(r2.candidateId, undefined, "判定为不是习惯就不该有候选");
});

test("habit: 判定器崩溃时走规则回退，不抛", async () => {
  const ws = tmp();
  const boom = async () => { throw new Error("network down"); };
  let r;
  for (let i = 0; i < 3; i += 1) {
    r = await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，用空格", judge: boom });
  }
  assert.equal(r.judge, "rule");
  assert.ok(r.candidateId);
});

test("habit: 判定器回一段乱七八糟的也能放过", () => {
  assert.equal(habit.parseJudgeReply("我觉得这是个习惯"), null);
  assert.equal(habit.parseJudgeReply(""), null);
  assert.equal(habit.parseJudgeReply(null), null);
});

// ------------------------------------------------------------------ 两道门

test("habit: 模型不能确认（门 1）", async () => {
  const ws = tmp();
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，用空格" });
  const id = habit.review(ws).candidates[0].id;

  const r = habit.confirm(ws, id, "agent");
  assert.equal(r.ok, false);
  assert.match(r.reason, /user action/);
  assert.equal(habit.review(ws).candidates[0].status, "pending", "状态不该变");
});

test("habit: 用户确认后是 suggested，仍然不注入", async () => {
  const ws = tmp();
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，用空格" });
  const id = habit.review(ws).candidates[0].id;

  const r = habit.confirm(ws, id, "user");
  assert.equal(r.ok, true);
  assert.equal(r.profile.status, "suggested");
  assert.equal(habit.activeHabits(ws).length, 0, "suggested 仍然不注入");
});

test("habit: 模型不能提升（门 2）", async () => {
  const ws = tmp();
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，用空格" });
  const id = habit.review(ws).candidates[0].id;
  habit.confirm(ws, id, "user");

  const r = habit.promote(ws, id, "agent");
  assert.equal(r.ok, false);
  assert.match(r.reason, /user action|never promote/);
  assert.equal(habit.activeHabits(ws).length, 0);
});

test("habit: 没确认就提升会被拒", async () => {
  const ws = tmp();
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，用空格" });
  const id = habit.review(ws).candidates[0].id;
  const r = habit.promote(ws, id, "user");
  assert.equal(r.ok, false);
  assert.match(r.reason, /confirmed candidate first/);
});

test("habit: 只在一个会话出现过，不能提升到 auto", async () => {
  // 跨会话护栏：单一会话里的重复可能是那一次对话的特殊情况。
  const ws = tmp();
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，用空格" });
  const id = habit.review(ws).candidates[0].id;
  habit.confirm(ws, id, "user");

  const r = habit.promote(ws, id, "user", { settings: { minSessionsForAuto: 2 } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /distinct session/);
});

test("habit: 两个会话都出现过，用户可以提升到 auto", async () => {
  const ws = tmp();
  const judge = async () => '{"isHabit":true,"pattern":"use spaces","category":"format","confidence":0.9}';
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，用空格", judge });
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s2", turn: i, text: "不对，用空格", judge });

  const cands = habit.review(ws).candidates;
  assert.equal(cands.length, 1, "同一模式应合并成一条候选");
  assert.equal(cands[0].sessions.length, 2);

  habit.confirm(ws, cands[0].id, "user");
  const r = habit.promote(ws, cands[0].id, "user", { settings: { minSessionsForAuto: 2 } });
  assert.equal(r.ok, true);
  assert.equal(r.profile.status, "auto");
  assert.equal(habit.activeHabits(ws).length, 1, "auto 才进注入");
});

// -------------------------------------------------------------------- 墓碑

test("habit: 删除写墓碑，同一个模式不再被学习", async () => {
  const ws = tmp();
  const judge = async () => '{"isHabit":true,"pattern":"use spaces","category":"format","confidence":0.9}';
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，用空格", judge });
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s2", turn: i, text: "不对，用空格", judge });
  const id = habit.review(ws).candidates[0].id;
  habit.confirm(ws, id, "user");
  habit.promote(ws, id, "user", { settings: { minSessionsForAuto: 2 } });

  const d = habit.deleteProfile(ws, id, "user");
  assert.equal(d.ok, true);
  assert.equal(habit.activeHabits(ws).length, 0);

  // 再遇到同样的话，不该长出新的候选
  for (let i = 0; i < 3; i += 1) {
    await habit.observe(ws, { sessionId: "s3", turn: i, text: "不对，用空格", judge });
  }
  const after = habit.review(ws);
  assert.equal(after.candidates.filter((c) => c.status === "pending").length, 0, "墓碑之后不该再学习");
});

test("habit: 模型不能删除", async () => {
  const ws = tmp();
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，用空格" });
  const id = habit.review(ws).candidates[0].id;
  habit.confirm(ws, id, "user");
  const r = habit.deleteProfile(ws, id, "agent");
  assert.equal(r.ok, false);
  assert.match(r.reason, /user action/);
});

test("habit: discard 可以由模型做，因为它只是不采纳", async () => {
  const ws = tmp();
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，用空格" });
  const id = habit.review(ws).candidates[0].id;
  const r = habit.discard(ws, id, "agent");
  assert.equal(r.ok, true);
  assert.equal(habit.activeHabits(ws).length, 0);
});

// ------------------------------------------------------------------ 其它

test("habit: 关掉开关就完全不工作", async () => {
  const ws = tmp();
  const r = await habit.observe(ws, { sessionId: "s1", text: "不对，用空格", settings: { enabled: false } });
  assert.equal(r.detected, 0);
  assert.equal(r.judge, "skipped");
});

test("habit: 空目录不报错", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "habit-empty-"));
  assert.deepEqual(habit.activeHabits(ws), []);
  assert.equal(habit.review(ws).candidates.length, 0);
});

test("habit: 状态能存能读", async () => {
  const ws = tmp();
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，用空格" });
  const f = path.join(ws, "state", "habit", "state.json");
  assert.ok(fs.existsSync(f));
  const raw = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.equal(raw.candidates.length, 1);
});

test("habit: review 里写明了策略，模型看得到边界", () => {
  const ws = tmp();
  const rv = habit.review(ws);
  assert.match(rv.policy, /models can never promote/);
  assert.match(rv.gate1, /not injected/);
  assert.match(rv.gate2, /auto/);
});

test("habit: 只有 auto 进注入，suggested 和 pending 都不进", async () => {
  // 这是两道门最终要保证的事：没走完流程的规矩不能影响行为。
  const ws = tmp();
  const judge = async () => '{"isHabit":true,"pattern":"use spaces","category":"format","confidence":0.9}';
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s1", turn: i, text: "不对，用空格", judge });
  const id = habit.review(ws).candidates[0].id;

  // pending
  assert.equal(habit.activeHabits(ws).length, 0, "pending 不注入");
  // suggested
  habit.confirm(ws, id, "user");
  assert.equal(habit.activeHabits(ws).length, 0, "suggested 也不注入");
  // 第二个会话 + promote
  for (let i = 0; i < 3; i += 1) await habit.observe(ws, { sessionId: "s2", turn: i, text: "不对，用空格", judge });
  habit.promote(ws, id, "user", { settings: { minSessionsForAuto: 2 } });
  const active = habit.activeHabits(ws);
  assert.equal(active.length, 1, "只有 auto 才注入");
  assert.equal(active[0].pattern, "use spaces");
});
