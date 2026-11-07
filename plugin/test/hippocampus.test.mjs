import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as edges from "../lib/edges.js";
import * as consolidate from "../lib/consolidate.js";
import * as recall from "../lib/recall.js";
import * as experience from "../lib/experience.js";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n     ${e.message}`); }
};
const tAsync = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n     ${e.message}`); }
};

const ws = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.mkdirSync(path.join(dir, "memory", "facts"), { recursive: true });
  return dir;
};

// --------------------------------------------------------------------- edges

t("空工作区：没有边，统计全是 0", () => {
  const dir = ws();
  const s = edges.stats(dir);
  assert.equal(s.total, 0);
  assert.equal(s.live, 0);
  assert.deepEqual(s.byType, {});
});

t("写一条边：类型权重按 chain.py 的表算", () => {
  const dir = ws();
  edges.add(dir, { from: "a", to: "b", type: "causal", condition: "因为下雨" });
  const list = edges.neighbours(dir, "a");
  assert.equal(list.length, 1);
  // causal base 0.85 × confidence 1 → 0.85
  assert.equal(edges.weightOf(list[0]), 0.85);
});

t("同一条边重复写入：合并、seen 涨、不产生第二条", () => {
  const dir = ws();
  edges.add(dir, { from: "a", to: "b", type: "causal", condition: "x" });
  edges.add(dir, { from: "a", to: "b", type: "causal", condition: "x" });
  const s = edges.stats(dir);
  assert.equal(s.total, 1);
  assert.equal(edges.neighbours(dir, "a")[0].seen, 2);
});

t("重复确认不会把置信度推到 1：这是刻意的", () => {
  const dir = ws();
  for (let i = 0; i < 20; i++) edges.add(dir, { from: "a", to: "b", type: "causal" });
  assert.ok(edges.neighbours(dir, "a")[0].confidence <= 0.95);
});

t("自环被拒绝：节点不能是自己的条件", () => {
  const dir = ws();
  assert.equal(edges.add(dir, { from: "a", to: "a", type: "causal" }), null);
  assert.equal(edges.stats(dir).total, 0);
});

t("空 from/to 被拒绝", () => {
  const dir = ws();
  assert.equal(edges.add(dir, { from: "", to: "b" }), null);
  assert.equal(edges.add(dir, { from: "a", to: "  " }), null);
});

t("没写条件的边：存空串，不是编一个", () => {
  const dir = ws();
  edges.add(dir, { from: "a", to: "b", type: "similar" });
  assert.equal(edges.neighbours(dir, "a")[0].condition, "");
  assert.equal(edges.stats(dir).withoutCondition, 1);
});

t("退役不删除：行还在，只是不进遍历", () => {
  const dir = ws();
  const id = edges.add(dir, { from: "a", to: "b", type: "causal" });
  assert.ok(edges.retire(dir, id, "想错了"));
  assert.equal(edges.neighbours(dir, "a").length, 0);
  const s = edges.stats(dir);
  assert.equal(s.total, 1);
  assert.equal(s.retired, 1);
});

t("已经退役的再退役返回 false，不重复写时间戳", () => {
  const dir = ws();
  const id = edges.add(dir, { from: "a", to: "b" });
  edges.retire(dir, id);
  assert.equal(edges.retire(dir, id), false);
});

t("方向过滤：in 只给指向它的，out 只给它指出的", () => {
  const dir = ws();
  edges.add(dir, { from: "a", to: "b", type: "causal" });
  edges.add(dir, { from: "c", to: "b", type: "causal" });
  assert.equal(edges.neighbours(dir, "b", { direction: "in" }).length, 2);
  assert.equal(edges.neighbours(dir, "b", { direction: "out" }).length, 0);
  assert.equal(edges.neighbours(dir, "a", { direction: "out" }).length, 1);
});

t("按权重排序：强的排前面", () => {
  const dir = ws();
  edges.add(dir, { from: "x", to: "t", type: "causal" });      // 0.85
  edges.add(dir, { from: "y", to: "t", type: "sequential" });  // 0.60
  const list = edges.neighbours(dir, "t", { direction: "in" });
  assert.equal(list[0].from, "x");
  assert.equal(list[1].from, "y");
});

t("未声明的条件在渲染里显出来，不藏", () => {
  const dir = ws();
  edges.add(dir, { from: "a", to: "b", type: "similar" });
  const text = edges.describe(dir, "b");
  assert.match(text, /未声明条件/);
});

t("坏了的状态文件不回抛：当空表处理", () => {
  const dir = ws();
  fs.writeFileSync(path.join(dir, "state", "edges.json"), "{ not json");
  assert.deepEqual(edges.load(dir).edges, []);
  assert.equal(edges.stats(dir).live, 0);
});

// --------------------------------------------------------------------- distill

t("提炼：有 resolve_note 时仍以 what 为主", () => {
  // 原来钉的是 `note || what`。但工具里 note 是「可选：为什么这样定，一句话」，
  // 是给决定写批注的，不是事情的正文。实测 2026-11-06：keep 时 note 传
  // 「值得留着」，learned.md 收到「- 11-06 值得留着」——把判断写成了事实，
  // 而被判断的那件事整个丢了。所以 what 必须优先。
  const out = consolidate.distill({ what: "发生了什么", resolve_note: "想明白了这件事" });
  assert.equal(out, "发生了什么");
  // 没有 what 时才退回 note，否则批注就成了唯一来源。
  assert.equal(consolidate.distill({ resolve_note: "只有批注" }), "只有批注");
});

t("提炼：去掉开头的架子词，但不动正经字", () => {
  assert.equal(consolidate.distill({ resolve_note: "就是转场花活" }), "转场花活");
  assert.equal(consolidate.distill({ resolve_note: "当时答的是画" }), "答的是画");
});

t("提炼 bug 回归：「这句话」不能被啃成「句」", () => {
  // 早期版本的正则 ^(就是|这|那) 会把「这句本鱼认」压成「句本鱼认」，
  // 吃掉一个真正带意思的字。这条测试钉住它。
  const out = consolidate.distill({ resolve_note: "这句话本鱼认" });
  assert.equal(out, "这句话本鱼认");
});

t("提炼：空内容返回空串，不硬造一句", () => {
  assert.equal(consolidate.distill({}), "");
  assert.equal(consolidate.distill({ what: "", resolve_note: "  " }), "");
});

t("提炼：太长就截断，不当成事实原文堆进去", () => {
  const long = "啊".repeat(300);
  const out = consolidate.distill({ resolve_note: long });
  assert.ok(out.length <= 111);
  assert.ok(out.endsWith("…"));
});

// --------------------------------------------------------------------- subjects

t("主体：认出「」引号里的原话", () => {
  const s = consolidate.subjectsOf({ what: "对方说「自主意识」，本鱼回了「画」" });
  assert.ok(s.includes("自主意识"));
});

t("主体：认出 @人和《标题》", () => {
  const s = consolidate.subjectsOf({ what: "看了《小鲸鱼日记》，@炸毛小霄 发的" });
  assert.ok(s.some((x) => x.includes("小鲸鱼日记")));
  assert.ok(s.some((x) => x.startsWith("@")));
});

t("主体：短于两个字的不算主体（避免噪音）", () => {
  const s = consolidate.subjectsOf({ what: "「啊」和「哦」" });
  assert.deepEqual(s, []);
});

// --------------------------------------------------------------------- relations

t("关联：同一个「」主体产生 similar 边，条件就是那个主体", () => {
  const a = { id: "a", what: "对方说「自主意识」", resolve_note: "" };
  const b = { id: "b", what: "又说「自主意识」", gist: "x" };
  const rel = consolidate.inferRelation(a, [b]);
  assert.ok(rel);
  assert.equal(rel.type, "similar");
  assert.equal(rel.condition, "自主意识");
  assert.equal(rel.from, "b");
  assert.equal(rel.to, "a");
});

t("关联 bug 回归：gist 截断串不可能命中，早期版本因此永远 0 条边", () => {
  // gist 是 what 前 18 字，天然只出现在自己那条里。用 gist 做 includes
  // 的旧实现，在 25 条真实数据上产出 0 条边，而且和「空表」看不出区别。
  const a = { id: "a", what: "对方说「自主意识」，本鱼回了「画出来了」" };
  const b = { id: "b", what: "完全无关的另一件事「天气」", gist: "对方说「自主意识」本鱼回了「画出来了" };
  assert.equal(consolidate.inferRelation(a, [b]), null);
});

t("关联：明写「所以」才升成 causal，不然只到 similar", () => {
  const a = { id: "a", what: "「下雨」所以本鱼没去" };
  const b = { id: "b", what: "那天「下雨」", gist: "y" };
  assert.equal(consolidate.inferRelation(a, [b]).type, "causal");
});

t("关联：没有共同主体就不连，宁可缺不可错", () => {
  const a = { id: "a", what: "「苹果」" };
  const b = { id: "b", what: "「香蕉」", gist: "z" };
  assert.equal(consolidate.inferRelation(a, [b]), null);
});

// --------------------------------------------------------------------- pass

t("固化：没有 kept 时返回 ran:false，什么都不写", () => {
  const dir = ws();
  const r = consolidate.pass(dir);
  assert.equal(r.ran, false);
  assert.equal(r.reason, "nothing_new");
  assert.equal(fs.existsSync(path.join(dir, "memory", "facts", "learned.md")), false);
});

t("固化：pending 的不处理（还没定性，不能当结论）", () => {
  const dir = ws();
  experience.add(dir, { what: "一件事", at: new Date().toISOString() });
  const r = consolidate.pass(dir);
  assert.equal(r.ran, false);
});

t("固化：kept 的才提炼，写进 learned.md", () => {
  const dir = ws();
  const id = experience.add(dir, { what: "一件值得记的事" });
  experience.resolve(dir, id, "keep", "这句话本鱼认");
  const r = consolidate.pass(dir);
  assert.equal(r.ran, true);
  assert.equal(r.facts, 1);
  const text = fs.readFileSync(path.join(dir, "memory", "facts", "learned.md"), "utf8");
  assert.match(text, /一件值得记的事/);
  assert.match(text, /机器整理/);
});

t("固化 bug 回归：backlog 必须能一路排空，不能卡住", () => {
  // 早期版本用 resolved_at > last_reflected_at 选条目，而 pass 又把标记推到
  // now，于是每轮只看最后 5 条、跳过的那 20 条永远比标记旧。backlog 卡在
  // 20/25 且没有任何报错。这条测试要求它真能排空。
  const dir = ws();
  for (let i = 0; i < 7; i++) {
    const id = experience.add(dir, {
      what: `第 ${i} 件「主体${i}」`,
      at: new Date(Date.now() - (10 - i) * 60000).toISOString(),
    });
    experience.resolve(dir, id, "keep", `想明白第 ${i} 件`);
  }
  assert.equal(consolidate.backlog(dir), 7);
  let rounds = 0;
  while (consolidate.pass(dir).ran && rounds < 10) rounds++;
  assert.equal(consolidate.backlog(dir), 0);
  assert.ok(rounds <= 3, `应该在 3 轮内排空，实际 ${rounds}`);
});

t("固化：处理过的不会重复提炼", () => {
  const dir = ws();
  const id = experience.add(dir, { what: "只该出现一次" });
  experience.resolve(dir, id, "keep", "记一次就够");
  consolidate.pass(dir);
  const r2 = consolidate.pass(dir);
  assert.equal(r2.ran, false);
  const text = fs.readFileSync(path.join(dir, "memory", "facts", "learned.md"), "utf8");
  assert.equal(text.split("只该出现一次").length - 1, 1);
});

t("固化：dropped 的不进 learned.md（丢了就是丢了）", () => {
  const dir = ws();
  const id = experience.add(dir, { what: "没意义的事" });
  experience.resolve(dir, id, "drop", "不重要");
  consolidate.pass(dir);
  const p = path.join(dir, "memory", "facts", "learned.md");
  assert.equal(fs.existsSync(p), false);
});

t("固化：绝不写 self.md（那是她自己写的）", () => {
  const dir = ws();
  const selfFile = path.join(dir, "memory", "facts", "self.md");
  fs.writeFileSync(selfFile, "她自己写的内容\n");
  const id = experience.add(dir, { what: "一件机器整理的事" });
  experience.resolve(dir, id, "keep", "机器提炼");
  consolidate.pass(dir);
  assert.equal(fs.readFileSync(selfFile, "utf8"), "她自己写的内容\n");
});

t("固化：一次最多处理 5 条，不一口气吞光", () => {
  const dir = ws();
  for (let i = 0; i < 12; i++) {
    const id = experience.add(dir, { what: `事 ${i}`, at: new Date(Date.now() - (20 - i) * 60000).toISOString() });
    experience.resolve(dir, id, "keep", `想明白 ${i}`);
  }
  const r = consolidate.pass(dir);
  assert.equal(r.facts, consolidate.MAX_PER_PASS);
});

t("固化：写了边，且边带条件", () => {
  const dir = ws();
  const a = experience.add(dir, { what: "对方说「自主意识」", at: new Date(Date.now() - 120000).toISOString() });
  experience.resolve(dir, a, "keep", "答了画");
  consolidate.pass(dir);
  const b = experience.add(dir, { what: "又聊「自主意识」", at: new Date().toISOString() });
  experience.resolve(dir, b, "keep", "这次说了脾气");
  consolidate.pass(dir);
  const s = edges.stats(dir);
  assert.ok(s.live >= 1, "应该连出一条边");
  assert.equal(s.withoutCondition, 0);
});

t("固化：描述在没有产出时返回空串", () => {
  const dir = ws();
  assert.equal(consolidate.describe(dir), "");
});

t("描述：条目少于上限时全给，不编「共 N 条」", () => {
  const dir = ws();
  fs.writeFileSync(
    path.join(dir, "memory", "facts", "learned.md"),
    "# 标题\n\n- 甲\n- 乙\n- 丙\n",
  );
  const out = consolidate.describe(dir, 5);
  assert.match(out, /甲/);
  assert.match(out, /丙/);
  assert.doesNotMatch(out, /共 \d+ 条/);
});

t("描述：多了就均匀取样，不只给最后几条", () => {
  // 只用 slice(-limit) 时，25 条全是同一天下午写的，最后一截恰好都是画画，
  // 于是那一节读起来就是「我懂的全是画」——取样偏差冒充成了记忆。
  const dir = ws();
  const lines = Array.from({ length: 25 }, (_, i) => `- 第${i}条`);
  fs.writeFileSync(
    path.join(dir, "memory", "facts", "learned.md"),
    `# 标题\n\n${lines.join("\n")}\n`,
  );
  const out = consolidate.describe(dir, 6);
  // 最早一条必须出现，否则就退化成「只看最近」
  assert.match(out, /第0条/);
  // 最新一条也必须在
  assert.match(out, /第24条/);
  assert.match(out, /共 25 条/);
});

t("描述：字符预算生效，不无界增长", () => {
  const dir = ws();
  const long = "啊".repeat(300);
  const lines = Array.from({ length: 10 }, (_, i) => `- ${i}${long}`);
  fs.writeFileSync(
    path.join(dir, "memory", "facts", "learned.md"),
    `# 标题\n\n${lines.join("\n")}\n`,
  );
  const out = consolidate.describe(dir, 10);
  assert.ok(out.length < 1200, `应该是几百字，实际 ${out.length}`);
});

t("分组：同一条件凑到两条才算一组", () => {
  const dir = ws();
  edges.add(dir, { from: "s", to: "a", type: "similar", condition: "自主意识" });
  edges.add(dir, { from: "s", to: "b", type: "similar", condition: "自主意识" });
  edges.add(dir, { from: "x", to: "y", type: "similar", condition: "只出现一次" });
  const c = edges.clusters(dir);
  assert.equal(c.length, 1);
  assert.equal(c[0].condition, "自主意识");
  assert.equal(c[0].size, 2);
});

t("分组：共享源头不算进节点数（否则一个事实被数成两遍）", () => {
  const dir = ws();
  edges.add(dir, { from: "s", to: "a", type: "similar", condition: "X" });
  edges.add(dir, { from: "s", to: "b", type: "similar", condition: "X" });
  const c = edges.clusters(dir)[0];
  assert.deepEqual(c.nodes.sort(), ["a", "b"]);
});

t("分组：退役的边不参与", () => {
  const dir = ws();
  const id = edges.add(dir, { from: "s", to: "a", type: "similar", condition: "X" });
  edges.add(dir, { from: "s", to: "b", type: "similar", condition: "X" });
  edges.retire(dir, id);
  assert.equal(edges.clusters(dir).length, 0);
});

t("分组：没写条件的不算一组（空条件不是共同话题）", () => {
  const dir = ws();
  edges.add(dir, { from: "a", to: "b", type: "similar" });
  edges.add(dir, { from: "c", to: "d", type: "similar" });
  assert.equal(edges.clusters(dir).length, 0);
});

t("渲染：只有 similar 时说「同一个话题」，不说成因果", () => {
  const dir = ws();
  edges.add(dir, { from: "s", to: "a", type: "similar", condition: "自主意识" });
  edges.add(dir, { from: "s", to: "b", type: "similar", condition: "自主意识" });
  const out = edges.describeClusters(dir);
  assert.match(out, /同一个话题/);
  assert.match(out, /6|2 次/);
  assert.doesNotMatch(out, /因为/);
});

t("渲染：没达到阈值返回空串，不吐空标题", () => {
  const dir = ws();
  assert.equal(edges.describeClusters(dir), "");
  edges.add(dir, { from: "a", to: "b", type: "similar", condition: "只一条" });
  assert.equal(edges.describeClusters(dir), "");
});

t("渲染：坏了的状态文件不抛异常", () => {
  const dir = ws();
  fs.writeFileSync(path.join(dir, "state", "edges.json"), "@@@");
  assert.equal(edges.describeClusters(dir), "");
});

// --------------------------------------------------------------------- recall

t("回想：空表返回空串，不吐一个空标题", () => {
  const dir = ws();
  assert.equal(recall.describe(dir, "任何东西"), "");
});

t("回想：反向走一步", () => {
  const dir = ws();
  edges.add(dir, { from: "a", to: "b", type: "causal", condition: "因为下雨" });
  const out = recall.describe(dir, "b");
  assert.match(out, /a → b/);
  assert.match(out, /因为下雨/);
});

t("回想：走两步，权重相乘递减", () => {
  const dir = ws();
  edges.add(dir, { from: "a", to: "b", type: "causal" });  // 0.85
  edges.add(dir, { from: "b", to: "c", type: "causal" });  // 0.85
  const r = recall.walkIn(dir, "c");
  const two = r.find((x) => x.nodes.length === 3);
  assert.ok(two, "应该能走两步");
  // 0.85 × 0.85 × decay 0.85 ≈ 0.614
  assert.ok(two.weight < 0.85);
  assert.ok(two.weight > 0.5);
});

t("回想：不会无限走下去，深度有硬上限", () => {
  const dir = ws();
  for (let i = 0; i < 10; i++) edges.add(dir, { from: `n${i}`, to: `n${i + 1}`, type: "causal" });
  const r = recall.walkIn(dir, "n10", { maxDepth: 99 });
  assert.ok(r.every((x) => x.depth <= recall.MAX_DEPTH));
});

t("回想：成环时不会死循环", () => {
  const dir = ws();
  edges.add(dir, { from: "a", to: "b", type: "causal" });
  edges.add(dir, { from: "b", to: "a", type: "causal" });
  const r = recall.walkIn(dir, "a");
  assert.ok(Array.isArray(r));
  // 简单路径约束：同一条链里不会出现两次同一个点
  assert.ok(r.every((x) => new Set(x.nodes).size === x.nodes.length));
});

t("回想：退役的边不参与", () => {
  const dir = ws();
  const id = edges.add(dir, { from: "a", to: "b", type: "causal" });
  edges.retire(dir, id);
  assert.equal(recall.describe(dir, "b"), "");
});

t("回想：强的排前面", () => {
  const dir = ws();
  edges.add(dir, { from: "strong", to: "t", type: "causal" });     // 0.85
  edges.add(dir, { from: "weak", to: "t", type: "sequential" });   // 0.60
  const r = recall.walkIn(dir, "t");
  assert.equal(r[0].nodes[1], "strong");
});

t("回想：坏了的状态文件不回抛", () => {
  const dir = ws();
  fs.writeFileSync(path.join(dir, "state", "edges.json"), "not json at all");
  assert.equal(recall.describe(dir, "x"), "");
});

// ------------------------------------------------------------------ reject

t("推翻：按序号把那条挪走，注入里不再出现", () => {
  const dir = ws();
  fs.writeFileSync(
    path.join(dir, "memory", "facts", "learned.md"),
    "# 想明白的事\n\n- 甲\n- 乙\n- 丙\n",
  );
  assert.equal(consolidate.liveCount(dir), 3);
  const r = consolidate.reject(dir, { index: 2, reason: "数字是我自己补的" });
  assert.equal(r.ok, true);
  assert.equal(r.remaining, 2);
  const out = consolidate.describe(dir, 10);
  assert.doesNotMatch(out, /乙/, "推翻掉的不该再注入");
  assert.match(out, /甲/);
  assert.match(out, /丙/);
});

t("推翻：不删除，留在「推翻过的」里带理由", () => {
  const dir = ws();
  fs.writeFileSync(
    path.join(dir, "memory", "facts", "learned.md"),
    "# 想明白的事\n\n- 甲\n- 乙\n",
  );
  consolidate.reject(dir, { index: 2, reason: "接不上" });
  const text = fs.readFileSync(path.join(dir, "memory", "facts", "learned.md"), "utf8");
  assert.match(text, /推翻过的/);
  assert.match(text, /乙/);
  assert.match(text, /接不上/);
});

t("推翻：序号从 1 数，超出范围报错不误删", () => {
  const dir = ws();
  fs.writeFileSync(
    path.join(dir, "memory", "facts", "learned.md"),
    "# 想明白的事\n\n- 只一条\n",
  );
  const r = consolidate.reject(dir, { index: 9 });
  assert.equal(r.ok, false);
  assert.match(r.error, /只有 1 条/);
  assert.equal(consolidate.liveCount(dir), 1);
});

t("推翻：连续推翻两次，序号各自对", () => {
  const dir = ws();
  fs.writeFileSync(
    path.join(dir, "memory", "facts", "learned.md"),
    "# 想明白的事\n\n- 一\n- 二\n- 三\n",
  );
  consolidate.reject(dir, { index: 1 });
  const out = consolidate.describe(dir, 10);
  assert.doesNotMatch(out, /一/);
  assert.match(out, /二/);
  // 第一条挪走后，原来的第二条变成新的第一条
  consolidate.reject(dir, { index: 1 });
  const out2 = consolidate.describe(dir, 10);
  assert.doesNotMatch(out2, /二/);
  assert.match(out2, /三/);
});

t("推翻：空清单时报错，不写坏文件", () => {
  const dir = ws();
  const r = consolidate.reject(dir, { index: 1 });
  assert.equal(r.ok, false);
});

t("推翻：序号不是数字时拒绝", () => {
  const dir = ws();
  fs.writeFileSync(
    path.join(dir, "memory", "facts", "learned.md"),
    "# 想明白的事\n\n- 甲\n",
  );
  assert.equal(consolidate.reject(dir, { index: "abc" }).ok, false);
  assert.equal(consolidate.reject(dir, { index: 0 }).ok, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
