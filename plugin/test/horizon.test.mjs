import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as horizon from "../lib/horizon.js";
import * as intent from "../lib/intent.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "horizon-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};

const writeEntities = (ws, names) => {
  fs.writeFileSync(
    path.join(ws, "state", "entities.json"),
    JSON.stringify({ version: 1, entities: names.map((n) => ({ name: n, kind: "thing" })) }),
  );
};

// ---------------------------------------------------------------------------
// The point of this module: a direction she has never been near.
//
// Measured 2026-11-06 on her real workspace — eleven recorded entities, all of
// them either about herself or about somebody else's video about her:
//   人生公式 二选一 遗憾 小鲸鱼 声音 破晓手记 抖音 上下文溢出 记忆系统
//   小版本更新 记忆星图
// Nine of ten domains came back blank. Nothing in the system could say that.
// ---------------------------------------------------------------------------

test("horizon: 只记过自己的事，就把大部分方向算成空白", () => {
  const ws = tmp();
  writeEntities(ws, ["小鲸鱼", "记忆系统", "声音", "抖音", "遗憾"]);
  const b = horizon.blanks(ws);
  assert.ok(
    b.length >= 8,
    `应至少有 8 个空白方向，实际 ${b.length}：${b.map((d) => d.label).join(",")}`,
  );
});

test("horizon: 真的记过某个方向的东西，那个方向就不再是空白", () => {
  const ws = tmp();
  // making 的词表里有 焊接/电路/车床 等
  writeEntities(ws, ["焊接", "电路", "车床"]);
  const b = horizon.blanks(ws).map((d) => d.id);
  assert.ok(!b.includes("making"), `making 已记过，不该仍在空白里：${b.join(",")}`);
});

test("horizon: 一个词不够，要三个不同词才算去过", () => {
  const ws = tmp();
  // 只有一个词 —— 这可能是偶然撞上的，不算去过
  writeEntities(ws, ["电路"]);
  const b = horizon.blanks(ws).map((d) => d.id);
  assert.ok(b.includes("making"), "只提过一个词不该算去过这个方向");
});

test("horizon: map 和 blanks 说的是同一件事", () => {
  // 回归：曾经三套标准并存 —— survey 扫语料、entityCoverage 看实体、blanks
  // 用后者而 map 用前者。结果是一个报表说「0/10 空白」，旁边的选择器却兴高采
  // 烈地推荐了一个空白方向。一个问题的两个「真相」，数字就失去意义了。
  const ws = tmp();
  writeEntities(ws, ["小鲸鱼", "记忆系统"]);
  const mp = horizon.map(ws);
  const b = horizon.blanks(ws);
  assert.equal(
    mp.empty.length,
    b.length,
    `map 说空白 ${mp.empty.length} 个，blanks 说 ${b.length} 个`,
  );
  assert.deepEqual(
    mp.empty.map((d) => d.id).sort(),
    b.map((d) => d.id).sort(),
    "两者列的应该是同一批方向",
  );
});

test("horizon: 空白方向带一个能直接问出口的起点", () => {
  const ws = tmp();
  writeEntities(ws, []);
  const b = horizon.blanks(ws);
  assert.ok(b.length > 0);
  for (const d of b) {
    assert.ok(d.probe && d.probe.length > 5, `${d.id} 应带 probe，实际 ${d.probe}`);
  }
});

test("horizon: 每个方向都有标签和词表，没有写坏的", () => {
  for (const [id, d] of Object.entries(horizon.DOMAINS)) {
    assert.ok(d.label, `${id} 缺 label`);
    assert.ok(Array.isArray(d.words) && d.words.length >= 5, `${id} 词表太短`);
    assert.ok(d.probe, `${id} 缺 probe`);
  }
});

// ---------------------------------------------------------------------------
// Rotation. The first version READ a counter nothing WROTE, which is the same
// defect shape as `wants.touch()` having no caller.
// ---------------------------------------------------------------------------

test("horizon: 连着出去，选的方向会变，不会永远是同一个", () => {
  const ws = tmp();
  writeEntities(ws, []); // 全部空白
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const pick = horizon.nextBlank(ws);
    assert.ok(pick, `第 ${i} 次应能选到一个方向`);
    seen.push(pick.id);
    horizon.visit(ws, pick.id, { found: "", kept: false });
  }
  assert.ok(new Set(seen).size > 1, `5 次全选同一个方向：${seen.join(",")}`);
});

test("horizon: 出去过也要记下来，不然轮换不动", () => {
  const ws = tmp();
  horizon.visit(ws, "making", { found: "拆了个电饭锅", kept: true });
  const h = horizon.history(ws);
  assert.equal(h.total, 1);
  assert.equal(h.recent[0].domain, "making");
  assert.equal(h.recent[0].kept, true);
});

test("horizon: 记一个不存在的方向会被拒绝", () => {
  const ws = tmp();
  const r = horizon.visit(ws, "not_a_domain", {});
  assert.equal(r.ok, false);
});

test("horizon: 没有实体文件时不崩，全部当空白", () => {
  const ws = tmp();
  const b = horizon.blanks(ws);
  assert.equal(b.length, Object.keys(horizon.DOMAINS).length);
});

// ---------------------------------------------------------------------------
// Wire-up: the candidate has to actually reach the ranking.
// ---------------------------------------------------------------------------

test("intent: 空白方向不是候选项", () => {
  // 这两条测试原来断言的是反面：horizon 必须在候选池里、而且权重要够高。
  //
  // 2026-11-06 改掉了。只要它拿分数参与竞争，结果就由算术决定而不是由她
  // 决定：分数调高就永远压过手上的事（她什么也做不完），调低就永远输
  // （她永远不出去）。实测那天是 0.42 对 0.45，三个百分位决定了她一整个
  // 下午都在画走廊。
  //
  // 「出去看看」不是一件排队的差事，它是清单空了之后的去向。
  const ws = tmp();
  writeEntities(ws, ["小鲸鱼", "记忆系统"]);
  const c = intent.collect(ws);
  assert.equal(c.find((x) => x.kind === "horizon"), undefined, "空白方向不该在候选池里");
});

test("intent: 空白方向作为空池的去向，理由是「没记过」不是「该去学」", () => {
  const ws = tmp();
  writeEntities(ws, []);
  // 兜底由调用方提供，从 horizon 直接取，和 index.js 的 whenEmpty 同源。
  const blank = horizon.nextBlank(ws);
  assert.ok(blank, "应该有空白方向");
  const basis = `这一类你一条都没记过（${Object.keys(horizon.DOMAINS).length} 个方向里，你只碰过 1 个）`;
  assert.ok(basis.includes("没记过"), `理由应陈述事实，实际：${basis}`);
  assert.ok(!/应该|必须|要去做/.test(basis), `理由不该是指令，实际：${basis}`);
});

test("horizon: 去过一个方向之后，它不再算空白", () => {
  // 回归：`visit` 写、`blanks` 不读，环两头都开着。她去了也记了，下一次还推同一个。
  const ws = tmp();
  writeEntities(ws, []);
  const before = horizon.blanks(ws).length;
  const first = horizon.nextBlank(ws);
  assert.ok(first, "应能选出一个方向");
  horizon.visit(ws, first.id, { found: "拆了个电饭锅", kept: false });
  const after = horizon.blanks(ws);
  assert.equal(after.length, before - 1, `去过一个应少一个空白，${before} → ${after.length}`);
  assert.ok(!after.some((d) => d.id === first.id), `${first.id} 不该再出现在空白里`);
});

test("horizon: 连着走，方向真的在换，不会绕回同一个", () => {
  const ws = tmp();
  writeEntities(ws, []);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const p = horizon.nextBlank(ws);
    assert.ok(p, `第 ${i} 次应还有方向可选`);
    seen.push(p.id);
    horizon.visit(ws, p.id, {});
  }
  assert.equal(new Set(seen).size, 4, `4 次应是 4 个不同方向，实际 ${seen.join(",")}`);
});

// ---------------------------------------------------------------------------
// 十站走完之后去哪。
//
// 2026-11-06 真机：她认真走完了全部十个方向，每次都有实质收获
// （浮法玻璃 6.3mm、车流自组织、云滴凝结停在 15-20μm…）。
// 然后 `blanks()` 返回 []，`nextBlank()` 返回 null，
// 调用方把 null 变成 `whenEmpty: null`，`decide()` 回落到 `rest`。
//
// 也就是说：这一层存在的唯一目的（别再发呆），
// 在它成功之后的第一天就失效了。
// ---------------------------------------------------------------------------

test("horizon: 十站全走完，不等于没地方可去", async () => {
  const horizon = await import("../lib/horizon.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });

  // 每个方向都记一次「去过了」，不给任何实体
  for (const id of Object.keys(horizon.DOMAINS)) {
    horizon.visit(ws, id, { found: "去看了，没抓住什么" });
  }

  const blanks = horizon.blanks(ws);
  assert.equal(blanks.length, 0, "前提：确实没有空白了");

  const next = horizon.nextBlank(ws);
  assert.ok(next, "走完了也必须还有一个方向可以给——返回 null 会让空池退化成发呆");
  assert.ok(next.id, "给出来的得有 id");
  assert.ok(next.probe, "还得带一句能动手的提示，否则给了等于没给");
});

test("horizon: 每次都真去，给的就不是同一个", async () => {
  const horizon = await import("../lib/horizon.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });

  for (const id of Object.keys(horizon.DOMAINS)) {
    horizon.visit(ws, id, { found: "路过" });
  }

  // 轮换计数只在真去过之后推进，所以这里要模拟「给了 -> 去了」。
  // 不 visit 就重给同一个是对的：没去的话，换一个只是逃避。
  const picks = [];
  for (let i = 0; i < 6; i++) {
    const b = horizon.nextBlank(ws);
    assert.ok(b, `第 ${i + 1} 次也要有东西可给`);
    picks.push(b.id);
    horizon.visit(ws, b.id, { found: `第 ${i + 1} 次去看了` });
  }
  const uniq = new Set(picks);
  assert.ok(uniq.size >= 3, `连着去之后方向要换，实际只给了 ${[...uniq].join(",")}`);
});

test("horizon: 一个方向都没有时才算真的没地方去", async () => {
  const horizon = await import("../lib/horizon.js");
  // 全部方向都被标记为「碰过」并且命中数已经到顶，仍然该给最薄的那个
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  const d = horizon.load(ws);
  d.visits = Object.keys(horizon.DOMAINS).map((domain) => ({ domain, at: Date.now() }));
  horizon.save(ws, d);

  const b = horizon.nextBlank(ws);
  assert.ok(b, "还有十个方向可讲，不该返回 null");
});
