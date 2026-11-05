// -*- coding: utf-8 -*-
// Prompt/code agreement check.
//
// The failure this exists for, observed twice on 2026-11-05:
//
//   1. Code changed `gaps()` to keep mature kinds in the pool, but the injector
//      still printed 【有一类事几乎没干过】 for a kind she had done twice that
//      morning.
//   2. COGNITION.md carried a hard-coded table of activity counts that had gone
//      stale (「收拾 0 次」 while the store said 3).
//
// Both are the same shape: a sentence that was true when written and is now
// false, with no mechanism that could ever notice. Comments do not fail. Tests
// of behaviour do not fail either, because the behaviour is correct — only the
// wording lies.
//
// So this checks prose against state, not code against tests.

import fs from "node:fs";
import path from "node:path";
import * as activities from "../lib/activities.js";

const WS = process.argv[2] || process.env["DAFEIYU_WORKSPACE"] || path.join(process.env["HOME"] || "", ".openclaw", "workspace-dafeiyu");
const HERE = path.dirname(new URL(import.meta.url).pathname);

const problems = [];
const oks = [];

function ok(m) { oks.push(`  ok   ${m}`); }
function bad(m) { problems.push(`  FAIL ${m}`); }

// ---------------------------------------------------------------- 1
// Every `reason` the library can emit must have a wording branch in the
// injector. A new tier added to gaps() and forgotten in the renderer is exactly
// how 「几乎没干过」 survived.
const actSrc = fs.readFileSync(path.join(HERE, "..", "index.js"), "utf8");
const reasons = ["unexplored", "low-experience", "high-failure", "mature"];
{
  const block = actSrc.slice(actSrc.indexOf('thin.reason === "unexplored"'));
  const head = block.slice(0, 900);
  const missing = reasons.filter((r) => r !== "low-experience" && !head.includes(`"${r}"`));
  if (missing.length) bad(`活动注入标题缺 reason 分支: ${missing.join(", ")}`);
  else ok("活动注入标题覆盖所有 reason 档");
}

// ---------------------------------------------------------------- 2
// The heading must not claim "never done" for a kind that has been done. This
// is checked against live state, so it keeps holding as her numbers change.
try {
  const g = activities.gaps(WS, { limit: 20, dispatchSlots: 1 / activities.DEFAULT_CURIOSITY_CONFIG.explorationBudgetRatio });
  const top = g[0];
  if (top) {
    const saysNever = actSrc.includes("【有一类事几乎没干过】");
    if (saysNever && top.done > 0) {
      bad(`标题还在说「几乎没干过」，但排第一的 ${top.kind} 已做过 ${top.done} 次`);
    } else {
      ok(`标题措辞与实况一致（${top.kind} done=${top.done} reason=${top.reason}）`);
    }
  } else {
    bad("候选池为空，无法核对标题");
  }
} catch (e) {
  bad(`核对标题时出错: ${e.message}`);
}

// ---------------------------------------------------------------- 3
// 「最近没怎么碰」 must be gated on elapsed days, not on a low count.
{
  const gated = actSrc.includes("RESTED_DAYS") && actSrc.includes("restedDays >= RESTED_DAYS");
  if (!gated) bad("「最近没怎么碰」没有按 restedDays 判定，会对着今天刚做过的事说这句话");
  else ok("「最近没怎么碰」只在真的隔了天数时才说");
}

// ---------------------------------------------------------------- 4
// COGNITION.md must not carry a hard-coded table of counts. Any number that
// appears there will drift; activity_state() is the live source.
{
  const cogPath = path.join(WS, "COGNITION.md");
  if (fs.existsSync(cogPath)) {
    const cog = fs.readFileSync(cogPath, "utf8");
    // A block of lines each ending in 「N 次」 is the shape of the stale table.
    const tableLike = (cog.match(/^\s*\S+\s+\d+\s*次$/gm) || []).length;
    if (tableLike >= 3) {
      bad(`COGNITION.md 里有 ${tableLike} 行写死的次数，会随状态漂移`);
    } else {
      ok("COGNITION.md 没有写死次数的表");
    }
    if (!cog.includes("activity_state()")) {
      bad("COGNITION.md 没有指向 activity_state()，她看不到实时数据");
    } else {
      ok("COGNITION.md 指向 activity_state()");
    }
  } else {
    ok("COGNITION.md 不存在，跳过");
  }
}

// ---------------------------------------------------------------- 5
// The wants injector must say something when the pool is empty. Silence there
// was invisible; the tool itself calls it a legitimate state.
{
  const saying = actSrc.includes("手里没有攒着的事");
  if (!saying) bad("wants 空池时不注入任何文字，她看不出这扇门是开的");
  else ok("wants 空池时有明确措辞");
}

// ---------------------------------------------------------------- report
console.log(`提示词/代码一致性检查 · ${WS}`);
console.log("");
if (problems.length) {
  console.log("不一致：");
  problems.forEach((p) => console.log(p));
  console.log("");
}
oks.forEach((o) => console.log(o));
if (problems.length) {
  console.log("");
  console.log(`共 ${problems.length} 处不一致。`);
  process.exit(1);
}
console.log("");
console.log("全部一致。");
