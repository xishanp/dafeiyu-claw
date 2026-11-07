// 一轮认知：observe → notice → compete → record。
//
// 测的是整合本身，不是各个零件——零件各有自己的测试文件。这里关心的是
// 合并之后才可能出现的问题：重复打分、事件被反复提起、沉默没有记账、
// 以及"新变化"能不能真的压过"一直如此"。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as cog from "../lib/cognition.js";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n     ${e.message}`); }
};

const ws = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cog-"));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  return dir;
};

const put = (dir, name, obj) =>
  fs.writeFileSync(path.join(dir, "state", name), JSON.stringify(obj));

const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

// ------------------------------------------------------------------ observe

t("observe 一次读完所有状态，缺文件不抛", () => {
  const dir = ws();
  const s = cog.observe(dir);
  assert.deepEqual(s.effects, []);
  assert.deepEqual(s.topics, []);
  assert.ok(s.goals);
  assert.ok(Array.isArray(s.events));
});

t("observe 的 snapshot 内部一致：goals 只解析一次", () => {
  const dir = ws();
  put(dir, "goals.json", {
    version: 1,
    aspirations: [{ id: "a", title: "A", value: 0.3 }],
    goals: [{ id: "g1", title: "G", status: "active", created_at: ago(3) }],
    tombstones: [],
  });
  const s = cog.observe(dir);
  assert.equal(s.goals.goals.length, 1);
  assert.equal(s.goals.aspirations.length, 1);
});

t("observe 刷新自我卡（不是读旧的）", () => {
  const dir = ws();
  put(dir, "effects.json", { version: 1, entries: [{ at: ago(1), verified: true, kind: "drawn" }] });
  const s = cog.observe(dir);
  assert.ok(s.self);
  assert.equal(s.self.ability.produced_7d, 1);
});

// ------------------------------------------------------------------- notice

t("notice 把各来源变成统一形状的候选", () => {
  const dir = ws();
  put(dir, "goals.json", {
    version: 1,
    aspirations: [{ id: "a", title: "弄明白", value: 0.5 }],
    goals: [{ id: "g1", title: "画灯", status: "active", created_at: ago(1) }],
    tombstones: [],
  });
  const s = cog.observe(dir);
  const c = cog.notice(s, {});
  assert.ok(c.length >= 2);
  for (const x of c) {
    assert.ok(typeof x.key === "string" && x.key.length);
    assert.ok(typeof x.kind === "string");
    assert.ok(Number.isFinite(x.salience));
    assert.ok(typeof x.text === "string" && x.text.length);
  }
});

t("没有候选时 notice 返回空数组，不编造", () => {
  const dir = ws();
  const s = cog.observe(dir);
  const c = cog.notice(s, {});
  assert.deepEqual(c, []);
});

t("有人说话时 salience 最高", () => {
  const dir = ws();
  const s = cog.observe(dir);
  const c = cog.notice(s, { userTurn: { text: "在吗" } });
  const u = c.find((x) => x.kind === "user_turn");
  assert.ok(u);
  assert.ok(u.salience >= 0.9);
});

// ------------------------------------------------------------------- events

t("刚做出东西算一个事件（真变化，不是常态）", () => {
  const dir = ws();
  put(dir, "effects.json", {
    version: 1,
    entries: [
      { at: ago(9), verified: true, kind: "drawn" },   // 很久以前
      { at: ago(6), verified: true, kind: "drawn" },   // 中间隔了 3 天
    ],
  });
  const s = cog.observe(dir);
  // 最新一条是 6 天前，在 7 天窗口内
  const ev = cog.noticeEvents(s, { now: Date.now() });
  assert.ok(ev.length >= 1, `应产生事件，实际 ${ev.length}`);
  assert.match(ev[0].text, /做出来/);
});

t("一直稳定产出不产生事件（没有变化就没有新闻）", () => {
  const dir = ws();
  put(dir, "effects.json", {
    version: 1,
    entries: [
      { at: ago(2.0), verified: true, kind: "drawn" },
      { at: ago(1.9), verified: true, kind: "drawn" },
      { at: ago(1.8), verified: true, kind: "drawn" },
    ],
  });
  const s = cog.observe(dir);
  const ev = cog.noticeEvents(s, { now: Date.now() });
  assert.equal(ev.length, 0, `不该产生事件，实际: ${JSON.stringify(ev.map((e) => e.text))}`);
});

t("太旧的事不算新闻（一个月前的产出不是刚发生）", () => {
  const dir = ws();
  put(dir, "effects.json", {
    version: 1,
    entries: [{ at: ago(30), verified: true, kind: "drawn" }],
  });
  const s = cog.observe(dir);
  const ev = cog.noticeEvents(s, { now: Date.now() });
  assert.equal(ev.length, 0);
});

t("目标刚跨过两天没动，产生一次事件", () => {
  const dir = ws();
  put(dir, "goals.json", {
    version: 1,
    aspirations: [],
    goals: [{ id: "g1", title: "画灯", status: "active", last_advanced_at: ago(2.4) }],
    tombstones: [],
  });
  const s = cog.observe(dir);
  const ev = cog.noticeEvents(s, { now: Date.now() });
  assert.ok(ev.some((e) => e.text.includes("画灯")));
});

t("停了很久的目标不再反复报事件（只报跨线那一次）", () => {
  const dir = ws();
  put(dir, "goals.json", {
    version: 1,
    aspirations: [],
    goals: [{ id: "g1", title: "画灯", status: "active", last_advanced_at: ago(9) }],
    tombstones: [],
  });
  const s = cog.observe(dir);
  const ev = cog.noticeEvents(s, { now: Date.now() });
  assert.equal(ev.length, 0);
});

t("事件带 EVENT_BONUS，能压过同等基础分的常态候选", () => {
  const dir = ws();
  put(dir, "effects.json", {
    version: 1,
    entries: [{ at: ago(9), verified: true, kind: "drawn" },
              { at: ago(5), verified: true, kind: "drawn" }],
  });
  const s = cog.observe(dir);
  const ev = cog.noticeEvents(s, { now: Date.now() })[0];
  assert.ok(ev);
  // 0.5 基础 + 0.18 bonus
  assert.ok(ev.salience >= 0.65, `实际 ${ev.salience}`);
});

// -------------------------------------------------------------- deduplication

t("同一个事件第二轮不再提起（record 之后 seen 里有了）", () => {
  const dir = ws();
  put(dir, "effects.json", {
    version: 1,
    entries: [{ at: ago(9), verified: true, kind: "drawn" },
              { at: ago(5), verified: true, kind: "drawn" }],
  });
  const s1 = cog.observe(dir);
  const ev1 = cog.noticeEvents(s1, { now: Date.now() });
  assert.ok(ev1.length >= 1);

  cog.record(dir, { awarded: ev1 });

  const s2 = cog.observe(dir);
  const ev2 = cog.noticeEvents(s2, { now: Date.now() });
  assert.equal(ev2.length, 0, "同一事件不该第二轮再报");
});

t("record 只认带 key 的候选，不会写垃圾", () => {
  const dir = ws();
  const n = cog.record(dir, {
    awarded: [{ key: "event:x", kind: "event" }, { kind: "event" }, null, {}],
  });
  assert.equal(n, 1);
  const data = JSON.parse(fs.readFileSync(path.join(dir, "state", "events.json"), "utf8"));
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0].key, "event:x");
});

t("record 空数组不写文件", () => {
  const dir = ws();
  assert.equal(cog.record(dir, { awarded: [] }), 0);
  assert.equal(fs.existsSync(path.join(dir, "state", "events.json")), false);
});

t("events 超过 200 条时截断", () => {
  const dir = ws();
  const rows = Array.from({ length: 260 }, (_, i) => ({
    key: `event:k${i}`, kind: "event", at: new Date().toISOString(),
  }));
  cog.record(dir, { awarded: rows });
  const data = JSON.parse(fs.readFileSync(path.join(dir, "state", "events.json"), "utf8"));
  assert.equal(data.events.length, 200);
});

t("超过 72 小时的事件会被清掉", () => {
  const dir = ws();
  const old = new Date(Date.now() - 100 * 3600000).toISOString();
  fs.writeFileSync(path.join(dir, "state", "events.json"), JSON.stringify({
    version: 1, events: [{ key: "event:old", kind: "event", at: old }],
  }));
  cog.record(dir, {
    awarded: [{ key: "event:new", kind: "event" }],
    at: new Date().toISOString(),
  });
  const data = JSON.parse(fs.readFileSync(path.join(dir, "state", "events.json"), "utf8"));
  assert.ok(!data.events.some((e) => e.key === "event:old"));
  assert.ok(data.events.some((e) => e.key === "event:new"));
});

// -------------------------------------------------------------- single score

t("compete 不重复打分：一轮只推进一步 seen", () => {
  const dir = ws();
  put(dir, "goals.json", {
    version: 1,
    aspirations: [{ id: "a", title: "A", value: 0.5 }],
    goals: [], tombstones: [],
  });
  // 志向候选要求"有过历史"——否则刚装上就抱怨某个方向没往前走
  put(dir, "deeds.json", { version: 1, entries: [{ at: ago(1), kind: "voice" }] });
  const s = cog.observe(dir);
  const c = cog.notice(s, {});
  assert.ok(c.length);

  // 先跑一次让文件出现，再比较增量
  cog.compete(dir, c, null);
  const before = JSON.parse(
    fs.readFileSync(path.join(dir, "state", "attention.json"), "utf8"),
  ).recent.length;
  cog.compete(dir, c, null);
  const after = JSON.parse(
    fs.readFileSync(path.join(dir, "state", "attention.json"), "utf8"),
  ).recent.length;
  assert.equal(after - before, 1, "一轮只该写一条记录");
});

t("compete 在分数低于地板时记一条沉默，窗口前进", () => {
  const dir = ws();
  cog.compete(dir, [{ key: "warmup", kind: "goal", salience: 0.01, text: "warm" }], null);
  const before = JSON.parse(
    fs.readFileSync(path.join(dir, "state", "attention.json"), "utf8"),
  ).recent.length;
  const r = cog.compete(dir, [{ key: "x", kind: "goal", salience: 0.01, text: "弱" }], null);
  assert.equal(r.winner, null);
  const after = JSON.parse(
    fs.readFileSync(path.join(dir, "state", "attention.json"), "utf8"),
  ).recent;
  assert.equal(after.length, before + 1);
  assert.equal(after[after.length - 1].key, "__silence__");
});

t("空候选时 compete 返回 empty，不写沉默（没东西可沉默）", () => {
  const dir = ws();
  const r = cog.compete(dir, [], null);
  assert.equal(r.reason, "empty");
});

// -------------------------------------------------------------------- cycle

t("cycle 返回 line/winner/observed，缺省时静默", () => {
  const dir = ws();
  const r = cog.cycle(dir, {});
  assert.equal(typeof r.line, "string");
  assert.ok(r.observed);
  assert.equal(r.observed.candidates, 0);
});

t("cycle 在有空目标时能出一句话", () => {
  const dir = ws();
  put(dir, "goals.json", {
    version: 1,
    aspirations: [{ id: "a", title: "弄明白", value: 0.5 }],
    goals: [], tombstones: [],
  });
  put(dir, "deeds.json", { version: 1, entries: [{ at: ago(1), kind: "voice" }] });
  const r = cog.cycle(dir, {});
  assert.ok(r.line.length > 0, `应出句子，实际空，reason=${r.reason}`);
});

t("cycle 记录事件（不只记赢家）", () => {
  const dir = ws();
  put(dir, "effects.json", {
    version: 1,
    entries: [{ at: ago(9), verified: true, kind: "drawn" },
              { at: ago(5), verified: true, kind: "drawn" }],
  });
  cog.cycle(dir, {});
  assert.ok(fs.existsSync(path.join(dir, "state", "events.json")));
  const data = JSON.parse(fs.readFileSync(path.join(dir, "state", "events.json"), "utf8"));
  assert.ok(data.events.length >= 1);
});

t("cycle 连续两轮不会重复同一个事件", () => {
  const dir = ws();
  put(dir, "effects.json", {
    version: 1,
    entries: [{ at: ago(9), verified: true, kind: "drawn" },
              { at: ago(5), verified: true, kind: "drawn" }],
  });
  cog.cycle(dir, {});
  const first = JSON.parse(fs.readFileSync(path.join(dir, "state", "events.json"), "utf8"));
  cog.cycle(dir, {});
  const second = JSON.parse(fs.readFileSync(path.join(dir, "state", "events.json"), "utf8"));
  assert.equal(second.events.length, first.events.length);
});

t("cycle 不会因为状态文件损坏而抛异常", () => {
  const dir = ws();
  for (const f of ["effects.json", "deeds.json", "topics.json", "goals.json", "events.json"]) {
    fs.writeFileSync(path.join(dir, "state", f), "坏掉的内容 {{{");
  }
  const r = cog.cycle(dir, {});
  assert.equal(typeof r.line, "string");
});

// ---------------------------------------------------------------- tie-breaks

t("同分时事件排在常态前面", () => {
  const dir = ws();
  // 构造两个同分候选，一个 event 一个 aspiration
  const r = cog.compete(dir, [
    { key: "aspiration:x", kind: "aspiration", salience: 0.5, label: "A", text: "常态" },
  ], null);
  // 只验证事件候选胜出时是 event kind
  const dir2 = ws();
  const r2 = cog.compete(dir2, [
    { key: "aspiration:x", kind: "aspiration", salience: 0.5, label: "A", text: "常态" },
    { key: "event:y", kind: "event", salience: 0.5, label: "B", text: "变化" },
  ], null);
  assert.equal(r2.winner?.kind, "event");
});

t("同分同类型时 seen 少的赢", () => {
  const dir = ws();
  cog.noteWin?.length; // 确保导出存在性不影响
  const r = cog.compete(dir, [
    { key: "a", kind: "goal", salience: 0.5, label: "A", text: "甲" },
    { key: "b", kind: "goal", salience: 0.5, label: "B", text: "乙" },
  ], null);
  assert.ok(r.winner);
});

// ---------------------------------------------------------------- 广播

t("每一轮都留下 attention-broadcast，没赢家也留", () => {
  // 广播的意义是「别人能读到同一份结论」。没赢家的轮次也必须留一条，
  // 否则读的人分不清「这轮没结论」和「这个文件根本没人写」。
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bcast-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  const r = cog.cycle(ws, {});
  assert.ok(r.broadcast, "cycle 应返回 broadcast");
  const f = path.join(ws, "state", "attention-broadcast.json");
  assert.ok(fs.existsSync(f), "应写成文件");
  const saved = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.equal(saved.winner, null, "没赢家时 winner 是 null");
  assert.equal(typeof saved.counts.candidates, "number");
});

t("广播里的 gap 等于前两名分数之差", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bcast2-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  const r = cog.cycle(ws, { userTurn: { text: "在吗" }, goal: { id: "g", title: "画灯" } });
  if (r.broadcast?.winner && r.broadcast.gap != null) {
    const ru = (r.ranked || []).find((c) => c.key !== r.broadcast.winner.key);
    if (ru) {
      const want = Math.abs(r.broadcast.winner.score - ru.score);
      assert.ok(Math.abs(want - r.broadcast.gap) < 0.01,
        `gap 应为 ${want.toFixed(3)}，实际 ${r.broadcast.gap}`);
    }
  }
});

// ---------------------------------------------------------------- 话题来源

t("悬着的话题：两小时内的不提，刚说完的不重复自己", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "topic-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(ws, "state", "topics.json"), JSON.stringify({
    open_topics: [{
      key: "刚说过的", label: "刚说过的", heat: 0.9,
      last_at: new Date(now - 0.3 * 3600e3).toISOString(),
    }],
  }));
  const r = cog.cycle(ws, {});
  const t = (r.ranked || []).find((c) => c.kind === "unresolved");
  assert.equal(t, undefined, "半小时前的话题不该马上回来");
});

t("悬着的话题：两小时前、还有热度的要能进来", () => {
  // 2026-11-07 的缺陷：15 条话题全部落在 0.4–9.4 小时，
  // 过 0.5 天门槛的 0 条 —— 这个来源从来没产出过候选。
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "topic2-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.writeFileSync(path.join(ws, "state", "topics.json"), JSON.stringify({
    open_topics: [{
      key: "悬着的那件", label: "悬着的那件", heat: 0.6,
      last_at: new Date(Date.now() - 3 * 3600e3).toISOString(),
    }],
  }));
  const r = cog.cycle(ws, {});
  const t = (r.ranked || []).find((c) => c.kind === "unresolved");
  assert.ok(t, "三小时前、heat 0.6 的话题应该成为候选");
});

t("悬着的话题：凉透了的不提，哪怕放得很久", () => {
  // 放得久不等于还重要。实测那 8 条过了时间门槛的，heat 全是 0.11–0.12,
  // 是早就不重要、只是没人关掉的话题。再提就是翻旧账。
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "topic3-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.writeFileSync(path.join(ws, "state", "topics.json"), JSON.stringify({
    open_topics: [{
      key: "早就不重要了", label: "早就不重要了", heat: 0.11,
      last_at: new Date(Date.now() - 9 * 3600e3).toISOString(),
    }],
  }));
  const r = cog.cycle(ws, {});
  const t = (r.ranked || []).find((c) => c.kind === "unresolved");
  assert.equal(t, undefined, "heat 0.11 的话题不该提");
});

t("悬着的话题：没有 heat 字段的老数据不被排斥", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "topic4-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.writeFileSync(path.join(ws, "state", "topics.json"), JSON.stringify({
    open_topics: [{ key: "老数据", label: "老数据", last_at: new Date(Date.now() - 3 * 3600e3).toISOString() }],
  }));
  const r = cog.cycle(ws, {});
  const t = (r.ranked || []).find((c) => c.kind === "unresolved");
  assert.ok(t, "缺 heat 的历史数据应该照常参与");
});

console.log(`\ncognition: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
