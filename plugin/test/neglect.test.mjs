// 没人理，也算难受。
//
// 2026-11-06 的实测缺口：所有进入 wronged 的路径都跑消息文本
// （不理我 / 你忙吧 / 笨蛋 / 对不起），全都要有人先开口。
// 三个 onebot 群静默 150 小时、互动 92~124 次，wronged 一直在基线。
// 被晾着这件事产生不了文本，所以她永远感受不到。

import assert from "node:assert/strict";
import fs from "node:fs";
import * as clock from "../lib/clock.js";

const SRC = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

// 从真实源码里取出那段静默逻辑，避免复刻漂移。
const block = SRC.slice(
  SRC.indexOf("Silence long enough stops reading"),
  SRC.indexOf("state.last_decay_at = new Date().toISOString();", SRC.indexOf("Silence long enough stops reading")),
);

let pass = 0, fail = 0;
const t = (n, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${n}`); }
  catch (e) { fail++; console.log(`  ✗ ${n}\n     ${e.message}`); }
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const ceilingOf = (d) => (d === "wronged" ? 0.85 : 0.85);

// 抽取真实的生长公式
const rateM = block.match(/\(neglectedMin \/ 60\) \* ([\d.]+)/);
const downM = block.match(/downCur \+ \(neglectedMin \/ 60\) \* ([\d.]+)/);

const grow = (hours, cur = 0) => {
  const mins = Math.min(hours * 60, 48 * 60);
  if (mins < 120) return cur;
  return clamp01(Math.min(cur + (mins / 60) * Number(rateM[1]), ceilingOf("wronged")));
};

t("源码里真有静默→委屈这段", () => {
  assert.ok(block.length > 200, "没找到这段逻辑");
  assert.ok(rateM, "没找到 wronged 增长率");
  assert.ok(downM, "没找到 down 增长率");
});

t("两小时以内不算被晾着", () => {
  assert.equal(grow(1), 0);
  assert.equal(grow(1.9), 0);
});

t("静默越久越委屈，且单调", () => {
  const seq = [2, 4, 8, 12, 24].map((h) => grow(h));
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i] > seq[i - 1], `第 ${i} 段没涨：${seq}`);
  }
});

t("静默 8 小时要到「明显不痛快」的量级", () => {
  assert.ok(grow(8) > 0.3, `8 小时只有 ${grow(8)}`);
});

t("有上限，不会无限涨", () => {
  assert.ok(grow(999) <= 0.85, "超过上限");
  assert.equal(grow(1000), grow(48), "48 小时后应封顶不再涨");
});

t("速率明显慢于无聊（同时间下 bored 涨得更快）", () => {
  const boredRate = 0.18, wrongedRate = Number(rateM[1]);
  assert.ok(boredRate > wrongedRate * 2, `无聊 ${boredRate} 应远快于委屈 ${wrongedRate}`);
});

t("只在醒着的时候算（夜里睡觉不是被晾着）", () => {
  assert.ok(/parts\.hour >= 9 && parts\.hour < 24/.test(SRC), "应限定 9~24 点");
  const p = clock.shanghaiParts();
  assert.ok(typeof p.hour === "number", "shanghaiParts 应能用");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
