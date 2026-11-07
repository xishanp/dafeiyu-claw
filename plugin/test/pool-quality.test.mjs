import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as compulsion from "../lib/compulsion.js";
import * as curiosity from "../lib/curiosity.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pool-"));

// ---------------------------------------------------------------------------
// 1. streakKey 不能把不同的东西合并成一个

test("streakKey: 两个不同的 exp 是两个不同的东西", () => {
  // 这是熔断看不见那个环的原因。改成 "exp" 之后，rotation 用精确 id 比对
  // 找不到周期，stalled 用精确 c.id 比对永远不匹配 —— 检测器的两半在说
  // 两种语言，谁都没坏，合起来什么都不做。
  const a = compulsion.streakKey("exp:exp-20261106093804-92a");
  const b = compulsion.streakKey("exp:exp-20261106093825-27u");
  assert.notEqual(a, b, "不同的 exp 必须是不同的 key");
  assert.match(a, /93804/);
  assert.match(b, /93825/);
});

test("streakKey: curiosity 保留具体对象", () => {
  assert.notEqual(
    compulsion.streakKey("curiosity:n-mw4o52s0-soi"),
    compulsion.streakKey("curiosity:n-mw4hf9ht-tnk"),
  );
});

test("streakKey: want 仍然归成行为类别", () => {
  // want 不同条目仍然都是"她一直在挑想做的事"，这个模式是该切的。
  assert.equal(compulsion.streakKey("want:want-mw3oedh8-irj"), "want");
  assert.equal(compulsion.streakKey("want:want-mw49nmji-p0z"), "want");
});

// ---------------------------------------------------------------------------
// 2. rotation 要能认出真实交替

const picks = (ids) =>
  ids.map((id, i) => ({
    id,
    key: compulsion.streakKey(id),
    at: new Date(2026, 10, 6, 10, i).toISOString(),
  }));

test("rotation: 严格交替能认出来", () => {
  const r = compulsion.rotation(
    picks(["a", "b", "a", "b", "a", "b", "a", "b"]),
  );
  assert.ok(r, "应该认出 period=2");
  assert.equal(r.period, 2);
});

test("rotation: 中间有一次替换，仍然算交替", () => {
  // 真实 2026-11-06 的历史：10 次比对里 9 次匹配，只有一条 exp 换了。
  // 要求 10/10 让检测器在一个看起来完美的环上返回 null，于是又跑了 24 轮。
  const r = compulsion.rotation(
    picks([
      "exp:exp-01", "curiosity:n-1",
      "exp:exp-01", "curiosity:n-1",
      "exp:exp-01", "curiosity:n-1",
      "exp:exp-01", "curiosity:n-1",
      "exp:exp-01", "curiosity:n-1",
      "exp:exp-02", "curiosity:n-1",
    ]),
  );
  assert.ok(r, "一处替换不该让整个判定失效");
  assert.equal(r.period, 2);
});

test("rotation: involved 包含全部参与过的 id", () => {
  // 只封末尾那一组，换掉的 exp-01 下一轮就能回来。
  const r = compulsion.rotation(
    picks([
      "exp:exp-01", "curiosity:n-1",
      "exp:exp-01", "curiosity:n-1",
      "exp:exp-01", "curiosity:n-1",
      "exp:exp-02", "curiosity:n-1",
    ]),
  );
  assert.ok(r);
  assert.ok(r.involved.includes("exp:exp-01"), JSON.stringify(r.involved));
  assert.ok(r.involved.includes("exp:exp-02"));
  assert.ok(r.involved.includes("curiosity:n-1"));
});

test("rotation: 真的乱转不算交替", () => {
  const r = compulsion.rotation(
    picks(["a", "b", "c", "a", "b", "c", "a", "d", "b", "c", "a", "b"]),
  );
  assert.equal(r, null, "没有稳定周期就该返回 null");
});

// ---------------------------------------------------------------------------
// 3. 衰减要真的衰减

const noticing = (daysAgo) => ({
  id: "n-test",
  seen: 1,
  moved: 0,
  weight: 0.7,
  last_seen_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
});

test("pull: 越久越小", () => {
  const now = curiosity.pull(noticing(0));
  const week = curiosity.pull(noticing(7));
  const month = curiosity.pull(noticing(30));
  assert.ok(week < now, `${week} 应该小于 ${now}`);
  assert.ok(month < week, `${month} 应该小于 ${week}`);
});

test("pull: 30 天要有明显下降，不能只降一点点", () => {
  // 原来是线性 45 天，而且只占结果的 25% 权重。实测 0d → 0.690，30d → 0.643，
  // 六周只掉 0.047，等于没衰减 —— 一个早忘了的问题能压着所有别的东西。
  const now = curiosity.pull(noticing(0));
  const month = curiosity.pull(noticing(30));
  const drop = (now - month) / now;
  assert.ok(drop > 0.10, `30 天至少降 10%，实际降了 ${(drop * 100).toFixed(1)}%`);
});

test("pull: 老东西要真的接近零，不能停在一个地板值上", () => {
  // This test has now been wrong twice, and both times the mistake was the
  // same: it compared two adjacent points where any monotone curve passes.
  //
  // Attempt 1 checked "30d is 10% below 0d" — passed on linear (13.7%) and
  // exponential (15.4%) alike. Attempt 2 checked "60d below 45d" — passed even
  // with the bug I was hunting, because the bug did not stop the curve, it put
  // a 75% floor under it: measured 45d = 0.6777, 60d = 0.6757, 90d = 0.6750.
  // Technically decreasing, functionally frozen.
  //
  // What actually distinguishes "decays" from "has a floor" is the distance
  // from the fresh value at a point far enough out that only a floor could
  // still be holding it up. Ninety days is that point: a real decay curve is
  // near zero there, and a floored one is still at three quarters of weight.
  const fresh = curiosity.pull(noticing(0));
  const at90 = curiosity.pull(noticing(90));
  assert.ok(
    at90 < fresh * 0.35,
    `90 天后应该只剩不到 35%，实际 ${at90.toFixed(4)} / ${fresh.toFixed(4)} = ${(at90 / fresh * 100).toFixed(1)}%（有地板的话会停在 75% 左右）`,
  );
  assert.ok(curiosity.pull(noticing(60)) < curiosity.pull(noticing(30)), "60 天比 30 天低");
});

test("pull: 一个月没碰的问题，压不住新的", () => {
  // The behaviour that matters, stated as behaviour rather than as a number:
  // a question she met once a month ago should not outrank one she met today.
  const stale = { id: "n-old", seen: 1, moved: 0, weight: 0.7, last_seen_at: new Date(Date.now() - 40 * 86400000).toISOString() };
  const fresh = { id: "n-new", seen: 1, moved: 0, weight: 0.7, last_seen_at: new Date().toISOString() };
  assert.ok(curiosity.pull(stale) < curiosity.pull(fresh));
});

// ---------------------------------------------------------------------------
// 4. propose 不再被展示上限卡死

const seed = (ws, names, times = 1) => {
  for (const n of names) for (let i = 0; i < times; i++) curiosity.notice(ws, n, {});
};

test("propose: 默认只给一条（展示规则还在）", () => {
  const ws = tmp();
  seed(ws, ["Zink", "Mesa", "Vulkan", "Turnip"], 3);
  assert.equal(curiosity.propose(ws).length, 1);
});

test("propose: 要更多就给更多（候选池需要）", () => {
  // MAX_SURFACED 是"一次只给她看一个"的展示规则，不该顺手把 intake 也限死。
  // 实测：六个问题同分 0.847，propose(budget:4) 返回 1，池子里只有一条好奇心，
  // 于是同一条赢了七个小时。
  const ws = tmp();
  seed(ws, ["Zink", "Mesa", "Vulkan", "Turnip"], 3);
  assert.equal(curiosity.propose(ws, { budget: 4 }).length, 4);
});

test("propose: 没那么多合格的就返回实际的量", () => {
  const ws = tmp();
  seed(ws, ["Zink"], 3);
  assert.equal(curiosity.propose(ws, { budget: 10 }).length, 1);
});

test("propose: 返回的都是不同的对象", () => {
  const ws = tmp();
  seed(ws, ["Zink", "Mesa", "Vulkan"], 3);
  const got = curiosity.propose(ws, { budget: 10 });
  assert.equal(new Set(got.map((n) => n.id)).size, got.length);
});

// ---------------------------------------------------------------------------
// 5. 五天硬出局

const aged = (daysAgo, weight = 0.7) => ({
  id: "n-aged",
  seen: 1,
  moved: 0,
  weight,
  last_seen_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
});

test("propose: 超过 5 天的不再提，哪怕分数还够", () => {
  // 用户的规则：「快速做完 5 天最多就出局」。这是硬上限，不是又一条曲线。
  // 调曲线只解决了形状 —— 一周的问题正好压线、十天出局 —— 但"多老算老"
  // 仍然由算术回答，而分数高的问题可以跑赢算术：weight 0.9 的第 10 天还有
  // 0.561，仍在 0.55 之上。硬规则把这个口子堵死。
  const ws = tmp();
  const got = curiosity.notice(ws, "Turnip", {});
  assert.ok(got, "先正常记一条");

  // 手动把它改老 —— notice 用的是真实时间，改不了 date
  const file = path.join(ws, "state", "curiosity.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.noticings[0].seen = 3;
  data.noticings[0].last_seen_at = new Date(Date.now() - 6 * 86400000).toISOString();
  fs.writeFileSync(file, JSON.stringify(data));

  assert.equal(curiosity.propose(ws).length, 0, "6 天前的不该再出现");
});

test("propose: 5 天以内的还在", () => {
  const ws = tmp();
  curiosity.notice(ws, "Turnip", {});
  const file = path.join(ws, "state", "curiosity.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.noticings[0].seen = 3;
  data.noticings[0].last_seen_at = new Date(Date.now() - 2 * 86400000).toISOString();
  fs.writeFileSync(file, JSON.stringify(data));

  assert.equal(curiosity.propose(ws).length, 1, "2 天前的应该还在");
});

test("propose: 重问题也跑不过 5 天", () => {
  // weight 0.9 在 10 天时 pull 还有 0.561，高于 0.55 的门槛。
  // 光靠曲线它会被一直提，所以必须有不看分数的年龄闸。
  const ws = tmp();
  curiosity.notice(ws, "Turnip", {});
  const file = path.join(ws, "state", "curiosity.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.noticings[0].seen = 3;
  data.noticings[0].weight = 0.9;
  data.noticings[0].kind = "question";
  data.noticings[0].last_seen_at = new Date(Date.now() - 10 * 86400000).toISOString();
  fs.writeFileSync(file, JSON.stringify(data));

  assert.ok(curiosity.pull(data.noticings[0]) > 0.55, "分数确实还够");
  assert.equal(curiosity.propose(ws).length, 0, "但年龄闸把它拦下了");
});
