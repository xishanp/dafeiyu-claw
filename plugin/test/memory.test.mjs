import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as entities from "../lib/entities.js";
import * as similar from "../lib/similar.js";
import * as sleep from "../lib/sleep.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dafeiyu-test-"));
}

test("实体：同名两条连上，不同名不连", () => {
  const ws = tmp();
  entities.remember(ws, { memoryId: "exp-a", names: ["甲地", "丙地"] });
  entities.remember(ws, { memoryId: "exp-b", names: ["甲地", "黄河"] });
  entities.remember(ws, { memoryId: "exp-c", names: ["某现象"] });

  const links = entities.linksFor(ws, "exp-a");
  assert.equal(links.length, 1, "只该连上 exp-b");
  assert.equal(links[0].memoryId, "exp-b");
  assert.ok(["甲地", "丙地"].includes(links[0].via));

  assert.equal(entities.linksFor(ws, "exp-c").length, 0, "某现象没跟谁共有");
});

test("实体：整句不算名字，被拒绝", () => {
  const ws = tmp();
  const r = entities.remember(ws, {
    memoryId: "exp-x",
    names: ["这是一整句话，不该被当成实体", "甲地"],
  });
  assert.equal(r.added, 1);
  assert.deepEqual(r.names, ["甲地"]);
});

test("实体：单字和纯标点被拒绝", () => {
  const ws = tmp();
  const r = entities.remember(ws, { memoryId: "exp-y", names: ["盐", "，", "。。", "乙地"] });
  assert.deepEqual(r.names, ["乙地"]);
});

test("实体：重复记忆同一 id 不重复计权重", () => {
  const ws = tmp();
  entities.remember(ws, { memoryId: "exp-z", names: ["甲地"] });
  const before = entities.top(ws, 5)[0].importance;
  entities.remember(ws, { memoryId: "exp-z", names: ["甲地"] });
  const after = entities.top(ws, 5)[0].importance;
  assert.equal(before, after, "同一条重复写入不该刷权重");
});

test("实体：桥接只列出现在两条以上的", () => {
  const ws = tmp();
  entities.remember(ws, { memoryId: "a", names: ["甲地"] });
  entities.remember(ws, { memoryId: "b", names: ["甲地"] });
  entities.remember(ws, { memoryId: "c", names: ["孤零零"] });
  const names = entities.bridges(ws).map((b) => b.name);
  assert.ok(names.includes("甲地"));
  assert.ok(!names.includes("孤零零"));
});

test("相似：不同说法但同一主题能命中", () => {
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "memory", "2026-11-05.md"),
    "本鱼: 那个味道不是米自己的，是那块地在替它调味。\n本鱼: 今天风很大什么都没干。\n",
  );
  // 「青禾米的味道」不在原文里连续出现，原文只有「青禾」和「米」分开写。
  // bigram 单独会漏掉，混合 unigram 后应命中。
  const hits = similar.search(ws, "青禾米的味道", { limit: 2 });
  assert.ok(hits.length >= 1, "应该找到讲味道那一句");
  assert.ok(hits[0].text.includes("味道"));
});

test("相似：完全无关的查询不返回", () => {
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.writeFileSync(path.join(ws, "memory", "2026-11-05.md"), "本鱼: 今天风很大。\n");
  const hits = similar.search(ws, "量子色动力学禁闭", { limit: 3 });
  assert.equal(hits.length, 0);
});

test("相似：标题行不参与检索", () => {
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.writeFileSync(path.join(ws, "memory", "2026-11-05.md"), "## 08:06\n本鱼: 真正的正文在这里。\n");
  const hits = similar.search(ws, "真正的正文", { limit: 2 });
  assert.ok(hits.every((h) => !h.text.startsWith("##")));
});

test("整理：编造的行 id 被拒绝", () => {
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.writeFileSync(path.join(ws, "memory", "2026-11-05.md"), "本鱼: 第一句真话。\n本鱼: 第二句真话。\n");
  const r = sleep.rememberRelations(ws, {
    day: "2026-11-05",
    pairs: [
      { from: "2026-11-05#0", to: "2026-11-05#1", relation: "真的" },
      { from: "2026-11-05#0", to: "2026-11-05#99", relation: "编的" },
    ],
  });
  assert.equal(r.stored, 1);
  assert.equal(r.skipped, 1);
});

test("整理：同一条重复记录被去重", () => {
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.writeFileSync(path.join(ws, "memory", "2026-11-05.md"), "本鱼: 第一句真话。\n本鱼: 第二句真话。\n");
  const pair = { from: "2026-11-05#0", to: "2026-11-05#1", relation: "同一个道理" };
  const a = sleep.rememberRelations(ws, { day: "2026-11-05", pairs: [pair] });
  const b = sleep.rememberRelations(ws, { day: "2026-11-05", pairs: [pair] });
  assert.equal(a.stored, 1);
  assert.equal(b.stored, 0, "第二次不该重复写入");
  assert.equal(sleep.relationsFor(ws).length, 1);
});

test("整理：自己连自己不收", () => {
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.writeFileSync(path.join(ws, "memory", "2026-11-05.md"), "本鱼: 只有这一句有用的。\n");
  const r = sleep.rememberRelations(ws, {
    day: "2026-11-05",
    pairs: [{ from: "2026-11-05#0", to: "2026-11-05#0", relation: "自指" }],
  });
  assert.equal(r.stored, 0);
});

test("整理：标记过的日子不再待办", () => {
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(ws, "memory", `${y}.md`), "本鱼: 昨天下了一整天雨。\n");
  assert.ok(sleep.pendingDays(ws).includes(y));
  sleep.markDay(ws, y);
  assert.ok(!sleep.pendingDays(ws).includes(y));
});

test("cursor 字段名必须与读取端一致（2026-11-05 真机重复）", async () => {
  const lifeLog = await import("../lib/life-log.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });

  // Simulate the diary growing by one exchange.
  const { dayFile } = lifeLog;
  const f = dayFile(ws, Date.now());
  fs.writeFileSync(f, "对方: 在吗\n本鱼: 在\n");

  const c0 = lifeLog.readCursor(ws);
  assert.equal(c0.offset, 0, "初始没有 cursor");

  const fresh = lifeLog.tailAfter(ws, c0);
  assert.ok(fresh.text.includes("本鱼"));
  assert.ok(fresh.end > 0, "tailAfter 必须报告新的结束位置");

  // This is the exact shape the caller writes. If the key is wrong the cursor
  // silently stays at 0 and every turn replays the same exchange.
  lifeLog.markReflected(ws, { day: fresh.day, offset: fresh.end });
  const c1 = lifeLog.readCursor(ws);
  assert.equal(c1.offset, fresh.end, "写进去的 offset 必须读得回来");
  assert.notEqual(c1.offset, 0, "offset 绝不能停在 0");

  // Reading again from that cursor must find nothing new.
  const again = lifeLog.tailAfter(ws, c1);
  assert.equal(again.text.trim(), "", "同一批内容不该被读第二次");
});

test("cursor 换天后自动归零", async () => {
  const lifeLog = await import("../lib/life-log.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.writeFileSync(lifeLog.dayFile(ws, Date.now()), "对方: 今天\n本鱼: 嗯\n");
  // A cursor stamped with a different day cannot address this file's offsets.
  const r = lifeLog.tailAfter(ws, { day: "1999-01-01", offset: 999 });
  assert.ok(r.text.includes("今天"), "换天后应从 0 开始读");
});

test("want_do: 记下来能读回来", async () => {
  const wants = await import("../lib/wants.js");
  const ws = tmp();
  const r = wants.add(ws, { what: "想去看看那条河最后流到哪儿", why: "说不上来", value: 0.8 });
  assert.ok(r.ok);
  const list = wants.open(ws);
  assert.equal(list.length, 1);
  assert.equal(list[0].what, "想去看看那条河最后流到哪儿");
  assert.equal(list[0].value, 0.8);
});

test("want_do: 同一条不记两次", async () => {
  const wants = await import("../lib/wants.js");
  const ws = tmp();
  wants.add(ws, { what: "想弄明白这事" });
  const dup = wants.add(ws, { what: "想弄明白这事。" }); // 只差标点
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /已经记着/);
  assert.equal(wants.open(ws).length, 1);
});

test("want_do: 放掉不是失败，能重新记", async () => {
  const wants = await import("../lib/wants.js");
  const ws = tmp();
  const { id } = wants.add(ws, { what: "想试试那个" });
  assert.ok(wants.close(ws, id, "dropped").ok);
  assert.equal(wants.open(ws).length, 0);
  // 放掉之后可以重新立一条一样的
  assert.ok(wants.add(ws, { what: "想试试那个" }).ok);
});

test("want_do: 攒太多会被挡住", async () => {
  const wants = await import("../lib/wants.js");
  const ws = tmp();
  for (let i = 0; i < 12; i++) wants.add(ws, { what: `第 ${i} 件想干的事` });
  const over = wants.add(ws, { what: "第十三件" });
  assert.equal(over.ok, false);
  assert.match(over.reason, /攒了/);
});

test("want_do: 进了候选池，来源是她自己", async () => {
  const wants = await import("../lib/wants.js");
  const intent = await import("../lib/intent.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  wants.add(ws, { what: "想知道那首歌为什么让人安静", value: 0.9 });
  const all = intent.collect(ws);
  const w = all.find((c) => c.kind === "want");
  assert.ok(w, "应有一个 want 候选");
  assert.equal(w.source, "herself", "来源必须是她自己，不是环境");
  assert.ok(w.value >= 0.5);
});

test("want_do: 试过多次后权重下降", async () => {
  const wants = await import("../lib/wants.js");
  const intent = await import("../lib/intent.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  const { id } = wants.add(ws, { what: "老是惦记但一直没做的事", value: 1 });
  const first = intent.collect(ws).find((c) => c.kind === "want").value;
  wants.touch(ws, id);
  wants.touch(ws, id);
  wants.touch(ws, id);
  const later = intent.collect(ws).find((c) => c.kind === "want").value;
  assert.ok(later < first, `试过多次后应下降：${first} → ${later}`);
});

test("活动分类：认得出在干什么", async () => {
  const a = await import("../lib/activities.js");
  assert.equal(a.classify("本鱼: 画了三条鱼"), "draw");
  assert.equal(a.classify("查明白某长词的味道不是米自己的"), "lookup");
  assert.equal(a.classify("量了一遍某现象四幕"), "count");
  assert.equal(a.classify("刷到一条讲哈雷彗星的"), "scroll");
  assert.equal(a.classify("今天天气不错"), null, "没有活动的句子不算");
});

test("活动扫描：刷到不算产出", async () => {
  const a = await import("../lib/activities.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "memory", "2026-11-05.md"),
    "本鱼: 刷到一条讲彗星的\n本鱼: 刷到个视频\n本鱼: 画了一条鱼\n",
  );
  const d = a.scan(ws);
  assert.equal(d.kinds.scroll.exposure, 2);
  assert.equal(d.kinds.scroll.done, 0, "刷到是被动，不算自己干的");
  assert.equal(d.kinds.draw.done, 1);
});

test("活动空白：没干过的排最前", async () => {
  const a = await import("../lib/activities.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  // 大量画画，从不收拾
  const lines = Array.from({ length: 30 }, (_, i) => `本鱼: 画了第 ${i} 条`).join("\n");
  fs.writeFileSync(path.join(ws, "memory", "2026-11-05.md"), lines + "\n");
  a.scan(ws);
  // The assertion is about ordering, not about which names appear. Requiring a
  // specific kind in the top 3 made the test depend on tie-break details that
  // have nothing to do with the behaviour being protected.
  const all = a.gaps(ws, { limit: 20 });
  const tidy = all.find((x) => x.kind === "tidy");
  const draw = all.find((x) => x.kind === "draw");
  assert.ok(tidy, "收拾应该在候选里");
  assert.equal(tidy.reason, "unexplored", "没干过就是 unexplored");
  // DELIBERATE DIVERGENCE from curiosity-engine, decided 2026-11-05.
  //
  // Their rule is `if (!reason) continue`: done twice, gone forever. That
  // emptied the pool completely (all twelve kinds had done >= 2, and
  // activity-inject logged 79 consecutive empties), so she spent a day
  // re-digging one question. See memory/decisions/2026-11-05-roaming-is-the-point.md.
  //
  // A mature kind now stays in the pool but must rank BELOW the thin ones.
  // Both halves matter: merely "present" would let `draw` (30 times here)
  // crowd out something she has never tried.
  assert.ok(draw, "做过很多次的仍在池子里");
  assert.equal(draw.reason, "mature", "超过 lowExperienceThreshold 就是 mature");
  assert.ok(draw.novelty < tidy.novelty, "做过的必须排在没做过的后面");

  const top = all[0];
  assert.equal(top.reason, "unexplored", "最前面必须还是没试过的");
  assert.notEqual(top.kind, "draw", "做过很多次的不许排第一");
});

test("活动：她自己的想头优先于新奇建议", async () => {
  const a = await import("../lib/activities.js");
  const wants = await import("../lib/wants.js");
  const intent = await import("../lib/intent.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.writeFileSync(path.join(ws, "memory", "2026-11-05.md"), "本鱼: 画了一天\n");
  a.scan(ws);

  // 没有自己的想头时，可以给新奇建议
  let all = intent.collect(ws);
  assert.ok(all.some((c) => c.kind === "gap"), "空手时应该给一个空白建议");

  // 有了自己的想头，新奇建议让位——但仍在池子里。
  //
  // `!some(gap)` was the old assertion and it enforced exclusion, not priority,
  // despite the test's name. Measured 2026-11-05: with one open want,
  // `collect()` returned exactly one candidate for an entire afternoon. One
  // option is not priority, it is starvation wearing a different coat.
  const added = wants.add(ws, { what: "想去看看那条河" });
  all = intent.collect(ws);
  const want = all.find((c) => c.kind === "want");
  const gap = all.find((c) => c.kind === "gap");
  assert.ok(want, "她自己的念头必须在");
  assert.ok(gap, "新奇建议也留着，让手里有不止一件可选的事");
  assert.ok(want.value > gap.value, "但分值必须压在新奇之上");

  // The ceiling tracks the want's discounted value, so a want she keeps picking
  // up and dropping eventually lets novelty through — and never before.
  wants.touch(ws, added.id);
  wants.touch(ws, added.id);
  wants.touch(ws, added.id);
  const after = intent.collect(ws);
  const w2 = after.find((c) => c.kind === "want");
  const g2 = after.find((c) => c.kind === "gap");
  if (g2) assert.ok(w2?.value > g2.value, "掉分之后念头仍要压住新奇");
});

test("活动：试砸了能记下来", async () => {
  const a = await import("../lib/activities.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  a.note(ws, "try", { ok: false });
  a.note(ws, "try", { ok: false });
  const d = a.scan(ws); // scan 会重建，靠日记；这里只验 note 不崩
  assert.ok(true);
  const st = a.stats(ws);
  assert.ok(st.tracked > 0);
});

test("好奇心缺陷1：什么都不干必须能检测到（2026-11-05 真机）", async () => {
  const a = await import("../lib/activities.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  // 真实日记里她会这样写
  fs.writeFileSync(
    path.join(ws, "memory", "2026-11-05.md"),
    "本鱼: 今天什么都没干，就在窗台上待着\n本鱼: 坐了一下午，发呆\n",
  );
  const d = a.scan(ws);
  assert.ok(d.kinds.idle.exposure > 0, "「待着」「发呆」必须被认出来");
  // 关键：认出来之后，它绝不能被拿来推荐 —— 推荐一个「什么都不干」的建议
  // 无法被观测为完成（她回 NO_REPLY 就等于做了，但留不下痕迹），会死循环。
  const idle = a.gaps(ws, { limit: 20 }).find((g) => g.kind === "idle");
  assert.equal(idle, undefined, "idle 只计数，不参与推荐");
});

test("好奇心缺陷2：note 记的失败不会被 scan 冲掉", async () => {
  const a = await import("../lib/activities.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.writeFileSync(path.join(ws, "memory", "2026-11-05.md"), "本鱼: 画了一条鱼\n");
  a.scan(ws);
  a.note(ws, "try", { ok: false });
  const after = a.scan(ws); // 再扫一次
  assert.equal(after.kinds.try.failed, 1, "失败次数必须活过下一次 scan");
});

test("好奇心规则：做过两次降为 mature，但仍可被想起（偏离 curiosity-engine）", async () => {
  const a = await import("../lib/activities.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.writeFileSync(path.join(ws, "memory", "2026-11-05.md"), "本鱼: 画了一条鱼\n本鱼: 又画了一条\n");
  a.scan(ws);

  const after2 = a.gaps(ws, { limit: 20 });
  const draw = after2.find((g) => g.kind === "draw");

  // The pool must never be empty just because she has lived a little. Measured
  // 2026-11-05: `gaps()` returning `[]` was the root cause of a whole day of
  // repetition, and nothing logged an error while it happened.
  assert.ok(after2.length > 0, "做过事不等于没得做，池子不能空");
  assert.ok(draw, "做过 2 次的 draw 仍在候选里");
  assert.equal(draw.reason, "mature", "2 次刚好到阈值，归入 mature");

  // 没做过的仍然在，而且排第一
  assert.equal(after2[0].reason, "unexplored");
  assert.notEqual(after2[0].kind, "draw");
});

test("好奇心：做得越多排得越后，但不会归零", async () => {
  const a = await import("../lib/activities.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  // One kind done 50 times, another done 3 times, both past the threshold.
  fs.writeFileSync(
    path.join(ws, "memory", "2026-11-05.md"),
    Array.from({ length: 50 }, (_, i) => `本鱼: 画了第 ${i} 张`).join("\n") +
      "\n" +
      Array.from({ length: 3 }, (_, i) => `本鱼: 整理了第 ${i} 次`).join("\n") +
      "\n",
  );
  a.scan(ws);
  const all = a.gaps(ws, { limit: 20 });
  const draw = all.find((g) => g.kind === "draw");
  const tidy = all.find((g) => g.kind === "tidy");
  assert.ok(draw && tidy, "两个都该在池子里");
  assert.ok(tidy.novelty > draw.novelty, "做得少的排在前面");
  // The floor exists so a heavily-used kind is not permanently buried: "I have
  // drawn 71 times" is a reason to draw later, not a reason to never draw.
  assert.ok(draw.novelty > 0, "做得再多也不能归零");
});

test("好奇心：markSuggested 同一天只记一次", async () => {
  const a = await import("../lib/activities.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "state", "activity-kinds.json"),
    JSON.stringify({ version: 1, kinds: { idle: { exposure: 0, done: 0, failed: 0, suggested: 0 } } }),
  );
  a.markSuggested(ws, "idle");
  a.markSuggested(ws, "idle");
  a.markSuggested(ws, "idle");
  const d = JSON.parse(fs.readFileSync(path.join(ws, "state", "activity-kinds.json"), "utf8"));
  assert.equal(d.kinds.idle.suggested, 1, "心跳每分钟一次，不能每次都加");
});

test("死循环修复：不可观测的类型不进候选（2026-11-05 真机）", async () => {
  const a = await import("../lib/activities.js");
  const intent = await import("../lib/intent.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.writeFileSync(path.join(ws, "memory", "2026-11-05.md"), "本鱼: 画了一天\n");

  // idle 是反例：推它 → 她 NO_REPLY → 等于做了 → 但留不下痕迹
  const all = a.gaps(ws, { limit: 20 });
  assert.ok(!all.some((g) => g.kind === "idle"), "「什么都不干」永远不该被推荐");

  // 但它仍然要能计数，否则她真待着时系统看不见
  fs.writeFileSync(
    path.join(ws, "memory", "2026-11-05.md"),
    "本鱼: 画了一天\n本鱼: 晚上什么都没干，就在阳台坐着\n",
  );
  const d = a.scan(ws);
  assert.ok(d.kinds.idle.exposure > 0, "idle 要能计数");

  // 候选池里也不能出现
  const cands = intent.collect(ws);
  assert.ok(!cands.some((c) => c.kind === "gap" && String(c.detail?.kind) === "idle"),
    "候选池里不能有 idle");
});

test("死循环修复：idle 只计数，永不进候选（2026-11-05 真机）", async () => {
  const a = await import("../lib/activities.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.writeFileSync(path.join(ws, "memory", "2026-11-05.md"), "本鱼: 在阳台坐着，什么都没干\n");
  a.scan(ws);

  // 两种保护同时成立：
  //   1. proposable:false —— 结构上不许推
  //   2. 做过 >= 2 次 —— curiosity-engine 的门槛
  // 任一条都足以让它出局，这里确认结果。
  assert.ok(!a.gaps(ws, { limit: 20 }).some((g) => g.kind === "idle"));
  assert.ok(a.scan(ws).kinds.idle.exposure > 0, "但计数要留下");
});

test("门槛：做过一次的类型仍然能被提（0.2 不是 0.7）", async () => {
  const a = await import("../lib/activities.js");
  const intent = await import("../lib/intent.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });

  // 只干过一次收拾 —— 打中的正是 proximity 到门槛的那一档：
  // experienceCount=1 < lowExperienceThreshold=2 → low-experience，novelty≈0.405
  fs.writeFileSync(
    path.join(ws, "memory", "2026-11-05.md"),
    "本鱼: 把作品收拾了一遍，过程稿归到 _drafts\n",
  );
  a.scan(ws);

  // 在这个只有一条日记的工作区里，其余十一类都是 unexplored(1.0)，会排在
  // tidy 前面。所以查全表而不是取首位 —— 断言的是「tidy 还在池子里」，
  // 不是「tidy 排第一」。
  const all = a.gaps(ws, { limit: 20 });
  const tidy = all.find((g) => g.kind === "tidy");
  assert.ok(tidy, "做过一次的类型仍在盲区表里");
  assert.equal(tidy.reason, "low-experience", "一次 → low-experience，不是 unexplored");
  // 不要断言具体分数：exposureScore 是 exposureCount/maxExposure，在这个只有
  // 一条日记的工作区里 maxExposure=1、tidy 的 exposure 也是 1，比例恰好是 1.0
  // 把分数顶高了。真实工作区里 tidy 是 0.405。测的是门槛有没有把它挡住，
  // 不是某个环境下的算术结果。
  assert.ok(tidy.novelty >= a.PROPOSAL_FLOOR, "必须还在门槛之上");

  // 真正的回归点：这样做之后，整体候选池不能空
  const cands = intent.collect(ws);
  assert.ok(cands.length > 0, "做完一次就把候选清空是缺陷");

  // 门槛本身钉住数值，防止下次又被调回 0.7
  assert.equal(a.PROPOSAL_FLOOR, 0.2);
});

test("wants：touch 过几次，分值必须掉下来", async () => {
  const wants = await import("../lib/wants.js");
  const intent = await import("../lib/intent.js");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });

  const r = wants.add(ws, { what: "去看那条河最后流到哪儿", value: 0.9 });
  assert.ok(r.ok, "先得记得下");

  const valueOf = () =>
    intent.collect(ws).find((c) => c.kind === "want")?.value ?? 0;

  const first = valueOf();
  assert.ok(first > 0, "刚开始该有分值");

  // Three picks, three misses. This is the shape measured on 2026-11-05:
  // one want offered at 11:33, 11:44 and 11:59 at 0.275 / 0.367 / 0.275, because
  // nothing ever called touch() and attempts stayed 0.
  wants.touch(ws, r.id);
  wants.touch(ws, r.id);
  wants.touch(ws, r.id);

  const after = valueOf();
  assert.ok(after < first, "推过三次必须掉分，否则会一直霸着候选位");
  assert.ok(after > 0, "但也不能掉到零——她还可以改主意");

  // The floor in lib/intent.js is 0.4x; past it, more touches stop mattering.
  // Pinned so a future "make it decay faster" edit has to be deliberate.
  assert.ok(after / first >= 0.39, "折扣下限是 0.4 倍，不该无限衰减");
});

test("wants：index.js 必须在 decide 出 do 时调用 touch（接线不能断）", () => {
  // Guard the wiring itself, not just the library.
  //
  // Verified 2026-11-05: deleting the entire `wants.touch(...)` block from
  // index.js left all 102 tests green. The function was written, documented and
  // never called for days, and nothing could tell. This assertion is cheap and
  // makes that specific regression loud.
  const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(src, /wants\.touch\(/, "index.js 必须调用 wants.touch");
  assert.match(
    src,
    /top\.kind === "want" && top\.detail\?\.wantId/,
    "只在候选确实是 want 时计数",
  );
  // Charging at display time would decay every want just for appearing in the
  // prompt. The call must live in the `do` branch, not the injector.
  const doAt = src.indexOf('action.kind === "do"');
  const touchAt = src.indexOf("wants.touch(");
  assert.ok(doAt > 0 && touchAt > doAt, "touch 必须在 do 分支里，不能在渲染列表时");
});
