import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as compulsion from "../lib/compulsion.js";
import * as salience from "../lib/salience.js";
import * as activities from "../lib/activities.js";
import * as intent from "../lib/intent.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "compulsion-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.mkdirSync(path.join(ws, "memory", "self"), { recursive: true });
  return ws;
};

// ---------------------------------------------------------------------------
// The loop this whole file exists for.
//
// Measured 2026-11-06: fifty-three versions of one question, twelve of them
// after she had already written the conclusion on version forty-one. Every one
// of the three things that pointed her back at it was, individually, behaving
// as designed. What was missing was anything that could see the repetition.
// ---------------------------------------------------------------------------

test("compulsion: 同一类事连做 4 轮就报出打转", () => {
  const ws = tmp();
  for (let i = 0; i < 4; i++) compulsion.recordPick(ws, `want:want-${i}`);
  const s = compulsion.streak(ws);
  assert.equal(s.length, 4, `应连 4 轮，实际 ${s.length}`);
  assert.equal(s.key, "want");
  assert.equal(compulsion.check(ws).stuck, true);
});

test("compulsion: 换了别的事，连击归零", () => {
  const ws = tmp();
  for (let i = 0; i < 4; i++) compulsion.recordPick(ws, `want:want-${i}`);
  compulsion.recordPick(ws, "wander:out");
  assert.equal(compulsion.streak(ws).length, 1);
  assert.equal(compulsion.check(ws).stuck, false, "换了事就不算打转");
});

test("compulsion: 3 轮还没到报警线", () => {
  const ws = tmp();
  for (let i = 0; i < 3; i++) compulsion.recordPick(ws, `want:want-${i}`);
  const c = compulsion.check(ws);
  assert.equal(c.streak.length, 3);
  assert.equal(c.stuck, false, "3 轮是正常深挖，不是打转");
});

test("compulsion: streakKey 把不同 id 归成同一类行为", () => {
  // 十二个不同的 want id，行为上是同一件事：去查一个数。
  assert.equal(compulsion.streakKey("want:want-aaa"), "want");
  assert.equal(compulsion.streakKey("want:want-bbb"), "want");
  // curiosity 保留具体条目，因为那是同一个念头在反复浮现。
  assert.notEqual(
    compulsion.streakKey("curiosity:n-aaa"),
    compulsion.streakKey("curiosity:n-bbb"),
  );
});

test("compulsion: 空历史不会误报", () => {
  const ws = tmp();
  const c = compulsion.check(ws);
  assert.equal(c.stuck, false);
  assert.equal(c.streak.length, 0);
});

test("compulsion: 从她自己写的版次读出打转", () => {
  const ws = tmp();
  const lines = [
    "# 本鱼自己写的",
    "",
    "## 本鱼写过的",
    "",
    "- 11-06 第五十一版没找到那份批复文件",
    "- 11-06 第五十二版才发现，前四版一直在找一份不存在的文件",
    "- 11-06 第五十三版还是同一件事",
  ].join("\n");
  fs.writeFileSync(path.join(ws, "memory", "self", "self.md"), lines);

  const v = compulsion.versionRun(ws);
  assert.equal(v.count, 3, `应数出 3 条，实际 ${v.count}`);
  assert.equal(v.newest, "五十三");
  assert.equal(compulsion.check(ws).stuck, true);
});

test("compulsion: 写别的事就不算版次连击", () => {
  const ws = tmp();
  const lines = [
    "## 本鱼写过的",
    "- 11-06 今天刷到一个做机械蝴蝶的",
    "- 11-06 想起昨天的雨",
    "- 11-06 那个粒子花挺好玩的",
  ].join("\n");
  fs.writeFileSync(path.join(ws, "memory", "self", "self.md"), lines);
  const v = compulsion.versionRun(ws);
  assert.equal(v.count, 0, "没有版次就不该数出条数");
  assert.equal(compulsion.check(ws).stuck, false);
});

// ---------------------------------------------------------------------------
// The threshold bug. This is the one that made the whole `mature` tier inert.
// ---------------------------------------------------------------------------

test("activities: mature 档至少有一种能过决策门槛 0.25", () => {
  // 回归：MATURE_CEILING = 0.35 时理论上限是 0.242，十一类全在 0.063~0.242，
  // 永远够不到 decide.js 的 0.25。池子非空、但每一轮都退化成 rest。
  const ws = tmp();
  fs.writeFileSync(
    path.join(ws, "state", "activity-kinds.json"),
    JSON.stringify({
      version: 1,
      kinds: {
        shoot: { exposure: 2, done: 2, failed: 0 },
        draw: { exposure: 60, done: 60, failed: 0 },
      },
    }),
  );
  const gaps = activities.gaps(ws, { limit: 20 });
  const reachable = gaps.filter((g) => g.reason === "mature" && g.novelty >= 0.25);
  assert.ok(
    reachable.length > 0,
    `mature 档应有能过 0.25 的，实际 ${JSON.stringify(gaps.map((g) => [g.kind, g.reason, g.novelty]))}`,
  );
});

test("activities: 新做完的两类排在做很多的之前", () => {
  const ws = tmp();
  // shoot 2 次、draw 60 次，都过阈值
  const kinds = { shoot: { exposure: 2, done: 2, failed: 0 }, draw: { exposure: 60, done: 60, failed: 0 } };
  fs.writeFileSync(
    path.join(ws, "state", "activity-kinds.json"),
    JSON.stringify({ version: 1, kinds }),
  );
  const gaps = activities.gaps(ws, { limit: 20 });
  const shoot = gaps.find((g) => g.kind === "shoot");
  const draw = gaps.find((g) => g.kind === "draw");
  assert.ok(shoot.novelty > draw.novelty, `shoot ${shoot.novelty} 应高于 draw ${draw.novelty}`);
});

// ---------------------------------------------------------------------------
// Fresh prior. Laplace smoothing is right for "tried and could fail", wrong for
// "never offered".
// ---------------------------------------------------------------------------

test("salience: 从没试过的东西不被先验分砍半", () => {
  // 回归：priorOf({}) = 0.5，把 0.242 砍成 0.121，低于 0.25 被丢弃。
  // 结果从没做过的事永远不能赢 → 永远开始不了 → 一直没做过。
  const fresh = salience.scoreCandidate({ value: 0.3, outcomes: {} });
  assert.equal(fresh, 0.3, `全新候选应保持 0.3，实际 ${fresh}`);
});

test("salience: 试过一次之后就回到正常先验", () => {
  // 不能被用来洗白一条反复失败的路。
  const once = salience.scoreCandidate({ value: 0.3, outcomes: { successes: 0, failures: 1 } });
  assert.ok(once < 0.3, `失败过一次应低于原值，实际 ${once}`);
});

test("salience: 成功过的照常算", () => {
  const s = salience.scoreCandidate({ value: 1, outcomes: { successes: 3, failures: 0 } });
  assert.ok(s > 0.5, `成功三次应显著高于 0.5，实际 ${s}`);
});

// ---------------------------------------------------------------------------
// Strength of the whole chain, against her real workspace shape.
// ---------------------------------------------------------------------------

test("intent: 打转的时候，别的事能排在原来的念头前面", () => {
  const ws = tmp();
  // 造一个打转的历史
  for (let i = 0; i < 6; i++) compulsion.recordPick(ws, `want:want-${i}`);

  // 一个高价值的 want，正常情况它应该压住一切
  fs.writeFileSync(
    path.join(ws, "state", "wants.json"),
    JSON.stringify({
      version: 1,
      wants: [{ id: "want-x", what: "查清某个数", status: "open", value: 0.95, at: new Date().toISOString() }],
    }),
  );

  const ranked = intent.rankNow(ws);
  const wantScore = ranked.ranked.find((c) => c.id === "want:want-x")?.score ?? 0;
  const top = ranked.ranked[0];
  assert.ok(top, "应至少有候选");
  assert.ok(
    top.id !== "want:want-x" || wantScore < 0.95,
    `打转时不该让原来的念头继续压住一切，实际第一是 ${top?.id} @ ${top?.score}`,
  );
});

test("intent: 打转时那个念头被标记 stalled", () => {
  const ws = tmp();
  for (let i = 0; i < 5; i++) compulsion.recordPick(ws, `want:want-${i}`);
  fs.writeFileSync(
    path.join(ws, "state", "wants.json"),
    JSON.stringify({
      version: 1,
      wants: [{ id: "want-y", what: "继续查", status: "open", value: 0.9, at: new Date().toISOString() }],
    }),
  );
  const c = intent.collect(ws).find((x) => x.id === "want:want-y");
  assert.ok(c, "那条念头应该在候选里（不是被删掉）");
  assert.equal(c.stalled, true, "打转时应被标记 stalled，降权而不是删除");
});

// ---------------------------------------------------------------------------
// Wiring. `clear` was written and never called — the same defect shape as
// `wants.touch()`. It has to be reachable from the place that actually closes
// the thing, or the streak counter only ever grows.
// ---------------------------------------------------------------------------

test("compulsion: clear 能把连击归零", () => {
  const ws = tmp();
  for (let i = 0; i < 5; i++) compulsion.recordPick(ws, `want:want-${i}`);
  assert.equal(compulsion.streak(ws).length, 5);
  compulsion.clear(ws);
  assert.equal(compulsion.streak(ws).length, 0);
  assert.equal(compulsion.check(ws).stuck, false);
});

test("compulsion: index.js 在 want 关闭时真的调用了 clear", () => {
  // 源码级断言：接线本身零覆盖过（11-05 就栽过这个）。
  const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const closeBlock = src.slice(
    src.indexOf('const r = wants.close(target.workspaceDir'),
    src.indexOf('const r = wants.close(target.workspaceDir') + 1200,
  );
  assert.ok(
    closeBlock.includes("compulsion.clear"),
    "want_do 关闭分支里应该调用 compulsion.clear，否则连击计数只增不减",
  );
});

// ---------------------------------------------------------------------------
// Phase gate. Wandering must not be the thing that gets cancelled when she is
// idle — that is exactly when there is time for it.
// ---------------------------------------------------------------------------

test("decide: dormant 相位下，出去逛不被降成 rest", async () => {
  const decide = await import("../lib/decide.js");
  const ctx = { hour: 14, phase: "dormant", familiarity: 0.5, spokeToday: 0, minutesSinceTalk: 999 };
  for (const kind of ["wander", "horizon"]) {
    const a = decide.choose({ id: `${kind}:x`, kind, score: 0.34 }, ctx);
    assert.equal(a.kind, "do", `${kind} 在 dormant 且 0.34 时应该 still do，实际 ${a.kind}/${a.reason}`);
  }
});

test("decide: dormant 相位下，弱的普通任务仍然变 rest", async () => {
  // 压制半心半意，这条是原本的设计意图，不能被上一条修坏。
  const decide = await import("../lib/decide.js");
  const ctx = { hour: 14, phase: "dormant", familiarity: 0.5, spokeToday: 0, minutesSinceTalk: 999 };
  const a = decide.choose({ id: "want:x", kind: "want", score: 0.2 }, ctx);
  assert.equal(a.kind, "rest");
});

// ---------------------------------------------------------------------------
// 连击计数不能在"换一个候选"之后归零。
//
// 这是打转活过之前每一次修复的原因。实测 2026-11-06：
//   04:38 curiosity x4（报警）
//   04:43 horizon   x1（报警唯一的动作：换一个）
//   04:44 curiosity x1（回来，计数归零，可以再来四轮）
// 打断不等于解决。计数器一归零，检测器唯一的响应反而保证了它能重演。
// ---------------------------------------------------------------------------

test("compulsion: 中途插了别的候选，连击不归零", () => {
  const mk = (keys) => keys.map((k, i) => ({ id: k, key: k, at: new Date(2026, 10, 6, 4, i).toISOString() }));
  // 这正是真实发生过的序列
  assert.equal(compulsion.currentStreak(mk(["A", "A", "A", "A", "B", "A"])), 5);
  // 严格连续时是这个数
  assert.equal(compulsion.currentStreak(mk(["A", "A", "A", "A"])), 4);
  // 来回横跳也要累计，不然交替两个候选就能无限循环
  assert.equal(compulsion.currentStreak(mk(["A", "B", "A", "B", "A"])), 3);
});

test("compulsion: 长时间没碰过的不算连击", () => {
  // 窗口只有 12 条。真隔了很久才回来一次，不该继续受罚。
  const picks = [];
  for (let i = 0; i < 12; i++) picks.push({ id: "B", key: "B", at: new Date(2026, 10, 6, 4, i).toISOString() });
  picks.push({ id: "A", key: "A", at: new Date(2026, 10, 6, 5, 0).toISOString() });
  assert.equal(compulsion.currentStreak(picks), 1);
});

// ---------------------------------------------------------------------------
// 一条 want 被反复做，怎么处理。
//
// owner 2026-11-06 的原话：「如果检测到 5 次都重复弄 1 个的话，应该要干嘛」
//
// 旧的公式是 Math.max(0.2, value * Math.max(0.4, 1 - attempts * 0.2))，两个
// 钳子都有问题：0.4 那个让折扣停在 40% 不再往下，0.2 那个在结果上垫了个底。
// 实测后果是「会不会停下来」取决于她当初随口写的 value：
//   value 0.45 做 5 次 → 0.200（掉出门槛，纯属巧合）
//   value 0.80 做 5 次 → 0.320（永远是候选）
//   value 1.00 做 5 次 → 0.400（同上，更糟）
// 走廊那条正好是 0.45，所以看着像修好了。
// ---------------------------------------------------------------------------

test("want: 前 4 次不动分（在做事，不是打转）", async () => {
  const intent = await import("../lib/intent.js");
  for (const n of [0, 1, 3, 4]) {
    assert.equal(intent.wantValue({ value: 0.45, attempts: n }), 0.45, `第 ${n} 次不该扣分`);
  }
});

test("want: 第 5 次开始降，而且不再停在一个地板上", async () => {
  const intent = await import("../lib/intent.js");
  const at5 = intent.wantValue({ value: 0.45, attempts: 5 });
  const at8 = intent.wantValue({ value: 0.45, attempts: 8 });
  const at20 = intent.wantValue({ value: 0.45, attempts: 20 });
  assert.ok(at5 < 0.45, "第 5 次要低于原值");
  assert.ok(at8 < at5, "第 8 次要继续降");
  assert.ok(at20 < at8, "第 20 次还要继续降，不能触底不动");
  assert.ok(at20 > 0, "但不归零——她不收掉，就还在");
});

test("want: value 高的能多撑几次，但撑不到无限", async () => {
  const intent = await import("../lib/intent.js");
  // 说「这对我很重要」可以多买几次机会
  assert.ok(
    intent.wantValue({ value: 1.0, attempts: 5 }) > intent.wantValue({ value: 0.45, attempts: 5 }),
    "重要的事应该多撑一会儿",
  );
  // 但不能无限撑——这是旧公式的漏洞
  assert.ok(intent.wantValue({ value: 1.0, attempts: 10 }) < 0.25, "10 次之后也要掉出门槛");
  assert.ok(intent.wantValue({ value: 1.0, attempts: 20 }) < 0.15, "20 次之后必须非常低");
});

test("want: 反复做的那条会被点名，而不是只报「某一类」", async () => {
  const intent = await import("../lib/intent.js");
  // 只有一条被做很多次时，理由里要带上次数
  const basis = intent.wantBasis({ value: 0.45, attempts: 7 }, 48);
  assert.ok(basis.includes("7 次"), `理由要说出具体次数，实际：${basis}`);
  assert.ok(basis.includes("还没收掉"), `5 次以上要说明还没收掉，实际：${basis}`);
  // 没反复做的不该被这么说
  const fresh = intent.wantBasis({ value: 0.45, attempts: 1 }, 5);
  assert.ok(!fresh.includes("还没收掉"), `刚开始的不该这么说，实际：${fresh}`);
});
