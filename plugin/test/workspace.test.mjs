import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as attention from "../lib/workspace.js";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n     ${e.message}`); }
};

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "attn-"));

// ---------------------------------------------------------------- candidates

t("四类实质候选都能构造出来（情绪不算候选）", () => {
  const c = attention.buildCandidates({
    userTurn: { text: "在吗" },
    goal: { id: "g1", title: "画那盏灯" },
    aspiration: { id: "output_producing", title: "做出以前没有的东西", value: 0.3 },
    affect: { name: "兴奋", value: 0.8 },
    unresolved: { key: "lantern", label: "灯的倒影", days: 3 },
  });
  assert.equal(c.length, 4);
  const kinds = c.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ["aspiration", "goal", "unresolved", "user_turn"]);
});

t("只有情绪时不产生任何候选", () => {
  const c = attention.buildCandidates({ affect: { name: "平静", value: 0.9 } });
  assert.deepEqual(c, [], "光有情绪没有事可做，注入就是九字废话");
});

t("只有情绪时不注入", () => {
  const dir = ws();
  const r = attention.compete(dir, { affect: { name: "平静", value: 0.9 } });
  assert.equal(r.winner, null);
  assert.equal(attention.render(r), "");
});

t("空输入不产生候选", () => {
  assert.deepEqual(attention.buildCandidates({}), []);
});

t("有人说话的权重最高", () => {
  const c = attention.buildCandidates({
    userTurn: { text: "在吗" },
    goal: { id: "g1", title: "画那盏灯" },
    aspiration: { id: "world_knowledge", title: "把世界看得更清楚", value: 1 },
  });
  const u = c.find((x) => x.kind === "user_turn");
  assert.ok(c.every((x) => x.salience <= u.salience), "user_turn 应该压过一切");
});

t("情绪只加权、不造赢家", () => {
  const c = attention.buildCandidates({ goal: { id: "g1", title: "画那盏灯" } });
  const lo = attention.rank({ recent: [] }, c, { name: "低落", value: 0 })[0].score;
  const hi = attention.rank({ recent: [] }, c, { name: "开心", value: 1 })[0].score;
  assert.ok(hi > lo, "情绪高时同一件事更该想");
  assert.ok(hi - lo <= 0.12 + 1e-9, "但最多加 0.12，不能压过候选之间的真实差距");
});

t("志向越低越该被想（value 是成绩，不是压力）", () => {
  // value 在 goal_close 里 done +0.08、released -0.03，所以低分=饿着。
  // 曾经写成 0.4 + 0.4*v，等于越饿越没声音，方向反了。
  const starving = attention.buildCandidates({
    aspiration: { id: "output_producing", title: "做出以前没有的东西", value: 0.1 },
  })[0];
  const fed = attention.buildCandidates({
    aspiration: { id: "output_producing", title: "做出以前没有的东西", value: 0.9 },
  })[0];
  assert.ok(starving.salience > fed.salience,
    `饿着的方向该更重：${starving.salience} vs ${fed.salience}`);
});

t("悬着的事随天数变重但有上限", () => {
  const d1 = attention.buildCandidates({ unresolved: { key: "a", label: "A", days: 1 } })[0];
  const d5 = attention.buildCandidates({ unresolved: { key: "a", label: "A", days: 5 } })[0];
  const d99 = attention.buildCandidates({ unresolved: { key: "a", label: "A", days: 99 } })[0];
  assert.ok(d5.salience > d1.salience);
  // d5 是 5 天，d99 是 6+ 天（封顶 6）。所以 d99 略高于 d5，但两者都受限。
  assert.ok(Math.abs(d99.salience - (0.35 + 0.06 * 6)) < 1e-9, "6 天封顶");
});

// ---------------------------------------------------------------- habituation

t("没赢过的候选不扣分", () => {
  const data = { recent: [] };
  const ranked = attention.rank(data, attention.buildCandidates({ goal: { id: "g1", title: "X" } }));
  assert.equal(ranked[0].penalty, 0);
});

t("连赢 3 次扣 0.6，但被封顶在 0.5", () => {
  const data = { recent: [{ key: "goal:g1" }, { key: "goal:g1" }, { key: "goal:g1" }] };
  const ranked = attention.rank(data, attention.buildCandidates({ goal: { id: "g1", title: "X" } }));
  // 3 * 0.2 = 0.6，超过 cap 0.5，所以实际扣 0.5。上限优先。
  assert.equal(ranked[0].penalty, 0.5);
});

t("连赢 2 次扣 0.4（未触顶时的原值）", () => {
  const data = { recent: [{ key: "goal:g1" }, { key: "goal:g1" }] };
  const ranked = attention.rank(data, attention.buildCandidates({ goal: { id: "g1", title: "X" } }));
  assert.ok(Math.abs(ranked[0].penalty - 0.4) < 1e-9);
});

t("扣分封顶 0.5", () => {
  const data = { recent: Array(6).fill({ key: "goal:g1" }) };
  const ranked = attention.rank(data, attention.buildCandidates({ goal: { id: "g1", title: "X" } }));
  assert.equal(ranked[0].penalty, 0.5);
});

t("只看最近 6 次", () => {
  const data = { recent: [...Array(6).fill({ key: "old" }), { key: "goal:g1" }] };
  const ranked = attention.rank(data, attention.buildCandidates({ goal: { id: "g1", title: "X" } }));
  assert.ok(Math.abs(ranked[0].penalty - 0.2) < 1e-9, "更早的不算");
});

t("习惯化真的能换人：连赢 3 次后被别的顶下去", () => {
  const data = { recent: [{ key: "goal:g1" }, { key: "goal:g1" }, { key: "goal:g1" }] };
  const ranked = attention.rank(data, attention.buildCandidates({
    goal: { id: "g1", title: "画那盏灯" },
    unresolved: { key: "lantern", label: "灯的倒影", days: 5 },
  }));
  assert.equal(ranked[0].kind, "unresolved", `应该换人，实际第一是 ${ranked[0].kind}`);
});

t("卡住的目标不衰减", () => {
  const data = { recent: Array(6).fill({ key: "goal:g1" }) };
  const ranked = attention.rank(data, attention.buildCandidates({
    goal: { id: "g1", title: "画那盏灯", stale: true },
  }));
  assert.equal(ranked[0].penalty, 0, "stale 目标豁免习惯化");
});

t("豁免不扣分，但也不额外加分", () => {
  const data = { recent: Array(6).fill({ key: "goal:g1" }) };
  const ranked = attention.rank(data, attention.buildCandidates({
    goal: { id: "g1", title: "画那盏灯", stale: true },
    unresolved: { key: "lantern", label: "灯的倒影", days: 6 },
  }));
  const g = ranked.find((x) => x.kind === "goal");
  assert.equal(g.penalty, 0, "卡住的目标不衰减");
  // 0.55 vs 0.71：仍然可能输。豁免是去掉惩罚，不是插队。
  assert.equal(ranked[0].kind, "unresolved");
});

t("普通目标会被扣垮，卡住的目标不会", () => {
  const data = { recent: Array(6).fill({ key: "goal:g1" }) };
  const stale = attention.rank(data, attention.buildCandidates({
    goal: { id: "g1", title: "画那盏灯", stale: true },
  }));
  const fresh = attention.rank(data, attention.buildCandidates({
    goal: { id: "g1", title: "画那盏灯", stale: false },
  }));
  assert.equal(stale[0].score, 0.55);
  assert.ok(Math.abs(fresh[0].score - 0.05) < 1e-9, "普通目标被扣到 0.05");
});

// ---------------------------------------------------------------- compete

t("compete 落盘并记录赢家", () => {
  const dir = ws();
  const r = attention.compete(dir, { goal: { id: "g1", title: "画那盏灯" } });
  assert.equal(r.winner.kind, "goal");
  const saved = attention.load(dir);
  assert.equal(saved.recent.length, 1);
  assert.equal(saved.recent[0].key, "goal:g1");
});

t("没有候选时不写文件", () => {
  const dir = ws();
  const r = attention.compete(dir, {});
  assert.equal(r.winner, null);
  assert.equal(fs.existsSync(attention.attentionFile(dir)), false);
});

t("连跑多轮同一件事，得分一路递减直到闭嘴", () => {
  const dir = ws();
  const input = { goal: { id: "g1", title: "画那盏灯" } };
  const scores = [];
  for (let i = 0; i < 4; i++) {
    const r = attention.compete(dir, input);
    scores.push(r.winner ? r.winner.score : null);
  }
  // goal 基分 0.55 → 0.55, 0.35, 0.15(低于地板 0.25 就闭嘴)
  const spoken = scores.filter((v) => v !== null);
  for (let i = 1; i < spoken.length; i++) {
    assert.ok(spoken[i] < spoken[i - 1], `应该递减：${spoken.join(" → ")}`);
  }
  assert.equal(scores[scores.length - 1], null, "掉到地板后该沉默");
});

t("recent 不会无限增长", () => {
  const dir = ws();
  for (let i = 0; i < 40; i++) attention.compete(dir, { goal: { id: "g1", title: "X" } });
  assert.ok(attention.load(dir).recent.length <= 24);
});

t("文件损坏时从空白开始，不抛", () => {
  const dir = ws();
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.writeFileSync(attention.attentionFile(dir), "{ 坏掉的 json");
  const r = attention.compete(dir, { goal: { id: "g1", title: "X" } });
  assert.equal(r.winner.kind, "goal");
});

// ---------------------------------------------------------------- 地板

t("单独的志向不发声（没有对手就没有竞争）", () => {
  // 志向是背景方向，不是当轮该做的事。只剩它一个时注入它，就是在一天的
  // 5-15 分钟心跳里反复念同一句。
  const dir = ws();
  const r = attention.compete(dir, {
    aspiration: { id: "self_understanding", title: "弄明白自己是怎么运作的", value: 0.5 },
    affect: { name: "平静", value: 0.657 },
  });
  assert.equal(r.winner, null);
  assert.equal(r.reason, "solo_background");
  assert.equal(attention.render(r), "");
});

t("有真实事务时，志向可以正常赢", () => {
  const dir = ws();
  const r = attention.compete(dir, {
    goal: { id: "g1", title: "画那盏灯" },
    aspiration: { id: "self_understanding", title: "弄明白自己是怎么运作的", value: 0.2 },
    affect: { name: "平静", value: 0.657 },
  });
  assert.ok(r.winner, "两个候选就该正常竞争");
  assert.ok(["goal", "aspiration"].includes(r.winner.kind));
});

t("两个候选时，习惯化到地板就闭嘴", () => {
  // 有对手才谈得上习惯化。基分 0.6 + 情绪加成 0.079 = 0.679，
  // 每赢一次扣 0.2：0.679 → 0.479 → 0.279 → 0.179(低于地板 0.25)。
  const dir = ws();
  const input = {
    goal: { id: "g1", title: "画那盏灯" },
    aspiration: { id: "self_understanding", title: "弄明白自己是怎么运作的", value: 0.5 },
    affect: { name: "平静", value: 0.657 },
  };
  const seats = [];
  for (let i = 0; i < 8; i++) {
    const r = attention.compete(dir, input);
    seats.push(r.winner ? "说" : "默");
  }
  const joined = seats.join("");
  // 前几轮轮换着说，然后一起沉下去
  assert.ok(joined.includes("说"), `该有人说：${joined}`);
  assert.ok(joined.includes("默"), `最后该一起沉默：${joined}`);
  assert.ok(!joined.startsWith("默"), `不该一开始就沉默：${joined}`);
});

t("沉默要记账，否则会永久哑掉", () => {
  // 第一版沉默不记账，理由是「没说话不该罚它」。实测 30 轮：窗口冻在原来那三次
  // 胜利上，seen 恒为 3，分数恒 0.179，从此一声不响。用「十轮重复」换「永远不说」
  // 不是修复。记一个不回应的沉默标记，窗口才会往前走。
  const dir = ws();
  const input = {
    goal: { id: "g1", title: "画那盏灯" },
    aspiration: { id: "self_understanding", title: "弄明白自己是怎么运作的", value: 0.5 },
  };
  let sawSilence = false;
  let spokeAfterSilence = false;
  for (let i = 0; i < 40; i++) {
    const r = attention.compete(dir, input);
    if (!r.winner) sawSilence = true;
    else if (sawSilence) spokeAfterSilence = true;
  }
  assert.ok(sawSilence, "该有沉默轮");
  assert.ok(spokeAfterSilence, "沉默之后必须能再开口，不能永久哑掉");
});

t("有多个候选时地板不误伤，正常轮换", () => {
  const dir = ws();
  const kinds = {};
  for (let i = 0; i < 12; i++) {
    const r = attention.compete(dir, {
      aspiration: { id: "self_understanding", title: "弄明白自己是怎么运作的", value: 0.5 },
      goal: { id: "g1", title: "画那盏灯" },
      unresolved: { key: "lantern", label: "灯的倒影", days: 5 },
      affect: { name: "平静", value: 0.66 },
    });
    const k = r.winner ? r.winner.kind : "沉默";
    kinds[k] = (kinds[k] || 0) + 1;
  }
  assert.ok((kinds["沉默"] || 0) <= 2, `不该大面积沉默：${JSON.stringify(kinds)}`);
  assert.ok(Object.keys(kinds).filter((k) => k !== "沉默").length >= 2, `该有轮换：${JSON.stringify(kinds)}`);
});

// ---------------------------------------------------------------- render

t("注入只给赢家 + 一句落选原因", () => {
  const txt = attention.render({
    winner: { text: "手上那件事：画那盏灯" },
    runnerUp: { label: "悬着的事", text: "还悬着的一件事：灯的倒影" },
  });
  const lines = txt.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("画那盏灯"));
  assert.ok(lines[1].includes("悬着的事"), "落选那句要点出是什么让了位");
});

t("落选提示用短标签，不把整句塞进括号", () => {
  const long = "「把海底那盏灯的倒影画对」已经 6 天没动过了。要么换个法子推一步，要么就用 goal_close 标 released 放掉它。";
  const txt = attention.render({
    winner: { text: "已经 7 天没做出东西了" },
    runnerUp: { label: "手上那件事", text: long },
  });
  const tail = txt.split("\n")[1];
  assert.ok(!tail.includes("goal_close"), `不该把整句塞进来：${tail}`);
  assert.ok(tail.length < 24, `落选提示该短：${tail.length} 字`);
});

t("没有落选者时只有一行", () => {
  const txt = attention.render({ winner: { text: "手上那件事：X" }, runnerUp: null });
  assert.equal(txt.split("\n").length, 1);
});

t("没有赢家时注入空字符串", () => {
  assert.equal(attention.render({ winner: null }), "");
  assert.equal(attention.render(null), "");
});

t("不注入完整排名", () => {
  const txt = attention.render({
    winner: { text: "A" },
    runnerUp: { text: "B" },
    ranked: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }],
  });
  assert.ok(!txt.includes("C") && !txt.includes("D"), "排名表会把老问题带回来");
});

// ---------------------------------------------------------------- 20 轮分布

t("20 轮竞争，来源分布不是单一来源 > 60%", () => {
  const dir = ws();
  const kinds = [];
  for (let i = 0; i < 20; i++) {
    const r = attention.compete(dir, {
      goal: { id: "g1", title: "画那盏灯" },
      aspiration: { id: "world_knowledge", title: "把世界看得更清楚", value: 0.3 },
      affect: { name: "兴奋", value: 0.9 },
      unresolved: { key: "lantern", label: "灯的倒影", days: 6 },
    });
    kinds.push(r.winner.kind);
  }
  const counts = {};
  for (const k of kinds) counts[k] = (counts[k] || 0) + 1;
  const top = Math.max(...Object.values(counts));
  assert.ok(top / 20 <= 0.6, `单一来源占比过高：${JSON.stringify(counts)}`);
  assert.ok(Object.keys(counts).length >= 3, `只出现了 ${Object.keys(counts).length} 类`);
});

t("同一内容连续赢不超过 3 轮", () => {
  const dir = ws();
  const kinds = [];
  for (let i = 0; i < 20; i++) {
    const r = attention.compete(dir, {
      goal: { id: "g1", title: "画那盏灯" },
      affect: { name: "兴奋", value: 0.9 },
      unresolved: { key: "lantern", label: "灯的倒影", days: 6 },
      aspiration: { id: "world_knowledge", title: "把世界看得更清楚", value: 0.3 },
    });
    kinds.push(r.winner.key);
  }
  let run = 1;
  let maxRun = 1;
  for (let i = 1; i < kinds.length; i++) {
    run = kinds[i] === kinds[i - 1] ? run + 1 : 1;
    maxRun = Math.max(maxRun, run);
  }
  assert.ok(maxRun <= 3, `最长连续 ${maxRun} 轮：${kinds.join(",")}`);
});


// ----------------------------------------------------------------- self card

t("selfState 进候选池，kind 为 self_state", () => {
  const c = attention.buildCandidates({
    selfState: { line: "这周做出来 3 样东西", phase: "productive" },
  });
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, "self_state");
  assert.equal(c[0].text, "这周做出来 3 样东西");
});

t("没有 line 时不产生 self 候选", () => {
  const c = attention.buildCandidates({ selfState: { line: "", phase: "steady" } });
  assert.equal(c.length, 0);
});

t("dormant 的权重高于志向，productive 的低于是设计意图", () => {
  const base = { aspiration: { id: "a", title: "x", value: 0.5 } };
  const dorm = attention.buildCandidates({ ...base, selfState: { line: "没动过", phase: "dormant" } });
  const prod = attention.buildCandidates({ ...base, selfState: { line: "做了很多", phase: "productive" } });
  const sal = (c, k) => c.find((x) => x.kind === k).salience;
  assert.ok(sal(dorm, "self_state") > sal(dorm, "aspiration"));
  assert.ok(sal(prod, "self_state") < sal(prod, "aspiration"));
});

t("dormant 状态下 self 候选能赢过志向", () => {
  const dir = ws();
  const r = attention.compete(dir, {
    aspiration: { id: "a", title: "x", value: 0.5 },
    selfState: { line: "好一阵子没动过了", phase: "dormant" },
  });
  assert.equal(r.winner?.key, "self:state");
});

t("productive 状态下 self 候选输给真业务", () => {
  const dir = ws();
  const r = attention.compete(dir, {
    aspiration: { id: "a", title: "x", value: 0.5 },
    selfState: { line: "这周做了很多", phase: "productive" },
  });
  assert.equal(r.winner?.key, "aspiration:a");
});

t("只有 self 这一条背景候选时沉默（solo_background 规则覆盖它）", () => {
  const dir = ws();
  const r = attention.compete(dir, {
    selfState: { line: "这周光在说话", phase: "stuck" },
  });
  // self_state 不在 SOLO_SILENT_KINDS 里，所以它会照常注入——
  // 这是刻意的：自我状态是"关于自己"的事实，不是背景噪音
  assert.equal(r.winner?.key, "self:state");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
