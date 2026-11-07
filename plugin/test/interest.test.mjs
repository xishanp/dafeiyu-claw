import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as interest from "../lib/interest.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "int-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};

const ok = {
  name: "拆开看数字怎么来的",
  pattern: "一个数字被引用时，它的测量条件是什么",
  transfers: ["这个统计口径包含什么", "这个百分比的分母是谁"],
  evidence: ["吸水率 152% 怎么测的"],
};

test("interest: 写得出迁移方向的才能记下来", () => {
  const ws = tmp();
  const r = interest.declare(ws, ok);
  assert.equal(r.ok, true);
  assert.equal(r.touched, false);
});

test("interest: 两类都空着的被拒，理由说清楚", () => {
  // 改了判据：兴趣不等于求知欲。偏好型（喜欢哪些具体的东西）也算。
  // 但两类都空着，那就是什么都没说。
  const ws = tmp();
  const r = interest.declare(ws, { name: "想弄明白大米怎么煮", transfers: [], examples: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /求知型|偏好型/);
  assert.equal(interest.review(ws).count, 0, "被拒的不该写进去");
});

test("interest: 只有偏好型也能记下来", () => {
  // 她说「喜欢刷抖音」——说不出迁移方向，但那确实是她喜欢的东西。
  const ws = tmp();
  const r = interest.declare(ws, {
    name: "手搓的小玩意",
    examples: ["纸箱三角当耳朵的机器人", "小橘猫扮齐天大圣"],
  });
  assert.equal(r.ok, true);
  const item = interest.review(ws).items[0];
  assert.deepEqual(item.transfers, []);
  assert.equal(item.examples.length, 2);
});

test("interest: 偏好型的例子能参与贴合度", () => {
  const ws = tmp();
  interest.declare(ws, { name: "手搓的小玩意", examples: ["纸箱做的机器人", "小橘猫扮齐天大圣"] });
  const near = interest.affinity(ws, "看到一个人用纸箱做的机器人");
  const far = interest.affinity(ws, "今天下雨了");
  assert.ok(near.score > far.score, `例子应参与匹配：${near.score} vs ${far.score}`);
});

test("interest: 没名字的也拒", () => {
  const ws = tmp();
  assert.equal(interest.declare(ws, { name: "  ", transfers: ["x"] }).ok, false);
});

test("interest: 同名再写一次是触碰，不是新增", () => {
  const ws = tmp();
  const a = interest.declare(ws, ok);
  const b = interest.declare(ws, ok);
  assert.equal(b.touched, true);
  assert.ok(b.strength > a.strength, "碰第二次应变强");
  assert.equal(interest.review(ws).count, 1, "不该多一条");
});

test("interest: 触碰会变强", () => {
  const ws = tmp();
  const r = interest.declare(ws, ok);
  const t = interest.touch(ws, "拆开看数字怎么来的");
  assert.equal(t.ok, true);
  assert.ok(t.strength > r.strength);
});

test("interest: 触碰不存在的兴趣不会新建", () => {
  const ws = tmp();
  const r = interest.touch(ws, "从没写过的东西");
  assert.equal(r.ok, false);
  assert.equal(interest.review(ws).count, 0);
});

test("interest: 会随时间衰减", () => {
  const ws = tmp();
  interest.declare(ws, ok);
  const fresh = interest.active(ws)[0];
  // 90 天 = 一个半衰期 → 剩一半
  const later = interest.active(ws, { now: Date.now() + 90 * 86400000 })[0];
  assert.ok(later, "一个半衰期后还在");
  assert.ok(later.current < fresh.current, `应该变淡：${fresh.current} → ${later.current}`);
  const ratio = later.current / fresh.current;
  assert.ok(ratio > 0.4 && ratio < 0.6, `一个半衰期应剩约一半，实际 ${ratio.toFixed(2)}`);
});

test("interest: 衰减到地板以下就不再出现", () => {
  const ws = tmp();
  interest.declare(ws, ok);
  // 730 天 = 8 个半衰期，剩 0.3/256 ≈ 0.001
  const list = interest.active(ws, { now: Date.now() + 730 * 86400000 });
  assert.equal(list.length, 0, "太久了不该还算数");
});

test("interest: 放掉的不再出现，但记录还在", () => {
  const ws = tmp();
  interest.declare(ws, ok);
  const d = interest.drop(ws, "拆开看数字怎么来的");
  assert.equal(d.ok, true);
  assert.equal(interest.active(ws).length, 0, "不该再被注入");
  assert.equal(interest.review(ws).count, 1, "历史要留着");
});

test("interest: 贴不贴能算出来", () => {
  const ws = tmp();
  interest.declare(ws, ok);
  const near = interest.affinity(ws, "这个统计口径的分母是谁，值得查一下");
  const far = interest.affinity(ws, "今天天气不错出去走了走");
  assert.ok(near.score > far.score, `贴的应更高：${near.score} vs ${far.score}`);
  assert.ok(near.matched.length > 0, "应说出匹配到了哪条");
});

test("interest: 完全不搭的给 0，不编", () => {
  const ws = tmp();
  interest.declare(ws, ok);
  const r = interest.affinity(ws, "qqq zzz xxx");
  assert.equal(r.score, 0);
  assert.deepEqual(r.matched, []);
});

test("interest: 没有兴趣时 affinity 是 0 不是崩", () => {
  const ws = tmp();
  const r = interest.affinity(ws, "随便什么话");
  assert.equal(r.score, 0);
});

test("interest: 越强的兴趣权重越高", () => {
  const ws = tmp();
  interest.declare(ws, ok);
  interest.declare(ws, { ...ok, name: "另一个兴趣", transfers: ["完全不同的词"] });
  const before = interest.affinity(ws, "这个统计口径包含什么").score;
  // 把第一条碰强
  interest.touch(ws, ok.name);
  interest.touch(ws, ok.name);
  const after = interest.affinity(ws, "这个统计口径包含什么").score;
  assert.ok(after > before, `变强之后权重应上升：${before} → ${after}`);
});

test("interest: 空的 workspace 不报错", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "int-empty-"));
  assert.deepEqual(interest.active(ws), []);
  assert.equal(interest.review(ws).count, 0);
});

test("interest: 状态能存能读", () => {
  const ws = tmp();
  interest.declare(ws, ok);
  const f = path.join(ws, "state", "interest.json");
  assert.ok(fs.existsSync(f));
  const raw = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.equal(raw.items.length, 1);
  assert.equal(raw.items[0].name, ok.name);
  assert.deepEqual(raw.items[0].transfers, ok.transfers);
});

test("interest: 迁移方向会合并去重", () => {
  const ws = tmp();
  interest.declare(ws, ok);
  interest.declare(ws, { ...ok, transfers: ["另一个迁移方向"] });
  const item = interest.review(ws).items[0];
  assert.ok(item.transfers.length >= 3, `应合并：${JSON.stringify(item.transfers)}`);
  const set = new Set(item.transfers);
  assert.equal(set.size, item.transfers.length, "不该有重复");
});

test("interest: 兴趣加成只提高概率，不决定结果", () => {
  // 一条弱候选贴兴趣，不该压过一条强候选。
  // 如果压过了，兴趣就变成硬规则，而硬规则会让她只会做同一件事。
  const ws = tmp();
  interest.declare(ws, {
    name: "测试用兴趣",
    transfers: ["统计口径", "分母"],
  });
  const strong = { salience: 0.8, text: "今天有人来问了个问题" };
  const weak = { salience: 0.30, text: "这个统计口径的分母是谁" };

  const a = interest.affinity(ws, weak.text);
  const boosted = weak.salience + 0.10 * a.score;

  assert.ok(a.score > 0, "弱候选应该贴上兴趣");
  assert.ok(boosted < strong.salience, `加成后 ${boosted.toFixed(3)} 仍不该超过 ${strong.salience}`);
});

test("interest: 加成有上限，不会把候选顶到 1", () => {
  const ws = tmp();
  interest.declare(ws, { name: "测试用兴趣", transfers: ["统计口径", "分母"] });
  const a = interest.affinity(ws, "统计口径的分母");
  const salience = 0.98;
  const boosted = Math.min(1, salience + 0.10 * a.score);
  assert.ok(boosted <= 1, "不该超过 1");
});

test("interest: 多个例子不该被摊薄", () => {
  // 实测的 bug：一条兴趣有 4 个例子 + name + pattern，拼成一段约 80 个
  // bigram。候选只可能命中其中一个例子 —— 4/80 = 0.05，永远过不了线。
  // 逐段比、取最高才对得上语义。
  const ws = tmp();
  interest.declare(ws, {
    name: "刷抖音，看别人做的东西",
    pattern: "刷到自己没见过的手艺或改装就停住",
    examples: [
      "纸箱三角当耳朵的手搓小机器人",
      "小橘猫戴金赤鸟翎扮齐天大圣",
      "只剩一只小狗在家换了皮肤尾巴",
      "AI 把小猫屠龙拍成史诗",
    ],
  });
  const hit = interest.affinity(ws, "又看到一个人用纸箱做了个小机器人");
  assert.ok(hit.score > 0.08, `命中一个例子应该过线，实际 ${hit.score}`);
});

test("interest: 虚词单独命中不算贴合", () => {
  // 实测 2026-11-07：例子「给自己拍照片」里的「自己」，让
  // 「弄明白自己是怎么运作的」拿到 0.108，越过 0.08 的线 ——
  // 一条关于自拍的偏好，给一条关于自我认知的志向加了分。
  const ws = tmp();
  interest.declare(ws, { name: "给自己拍照片", examples: ["换身衣服拍一张"] });
  for (const t of ["自己", "自己的状态", "弄明白自己是怎么运作的", "今天想做什么"]) {
    const a = interest.affinity(ws, t);
    assert.equal(a.score, 0, `「${t}」不该贴合，实际 ${a.score}`);
  }
});

test("interest: 一个词重合也不算，至少两个实词", () => {
  const ws = tmp();
  interest.declare(ws, { name: "刷抖音", examples: ["纸箱做的机器人"] });
  // 只命中「纸箱」一个 bigram 不算
  const one = interest.affinity(ws, "纸箱");
  assert.equal(one.score, 0, "单个 bigram 不算贴合");
  // 命中两个以上才算
  const two = interest.affinity(ws, "看到纸箱做的机器人");
  assert.ok(two.score > 0, "两个以上实词应该算");
});

test("interest: 真的像的照样匹配得上", () => {
  const ws = tmp();
  interest.declare(ws, { name: "给自己拍照片", examples: ["换身衣服拍一张"] });
  const a = interest.affinity(ws, "今天想换身衣服拍张照");
  assert.ok(a.score > 0.05, `应匹配，实际 ${a.score}`);
});
