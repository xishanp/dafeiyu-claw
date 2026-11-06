#!/usr/bin/env node
// Self-check for the starvation failure that nothing reported.
//
// Measured 2026-11-05: `activity-inject-empty` fired 79 consecutive times
// between 08:29 and 13:28 and no code anywhere read it. The log existed; the
// alarm did not. She spent the day re-digging one question and the only signal
// was her own diary line 「没别的事可做」.
//
// Two kinds of check, deliberately separated:
//
//   STATE  — computed now from the real stores. Catches a starved pool whether
//            or not a heartbeat ran recently.
//   LOG    — reads probe.log. Catches a heartbeat that disagrees with STATE,
//            i.e. the injector and the library drifting apart.
//
// Exit 1 on any failure so a cron job or `&&` chain notices. Nothing here
// writes: a self-check that can change state is one more thing to debug.

import fs from "node:fs";
import path from "node:path";
import * as activities from "../lib/activities.js";
import * as intent from "../lib/intent.js";
import * as wants from "../lib/wants.js";

const WS = process.argv[2] || process.env["DAFEIYU_WORKSPACE"] || path.join(process.env["HOME"] || "", ".openclaw", "workspace-dafeiyu");

const problems = [];
const notes = [];

function check(name, ok, detail) {
  if (ok) {
    notes.push(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    problems.push(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- STATE

let gaps = [];
let pool = [];
try {
  gaps = activities.gaps(WS, { limit: 20, dispatchSlots: 1 / activities.DEFAULT_CURIOSITY_CONFIG.explorationBudgetRatio });
  pool = intent.collect(WS);
} catch (err) {
  problems.push(`  FAIL 无法读取状态 — ${err?.message || err}`);
}

// The headline failure. An empty pool is not an error condition to the code;
// gaps() just returns [] and every caller treats that as "nothing to say".
check("活动候选池非空", gaps.length > 0, `${gaps.length} 条`);

// An EMPTY pool is a correct outcome now, not a failure.
//
// This check used to demand pool.length >= 2, on the reading that "one candidate
// is starvation with a nicer costume". That was right while `gap` and `horizon`
// were pool entries — the pool was the only thing that could ever reach her, so
// an empty one meant she would sit there.
//
// 2026-11-06 that changed: exploring is no longer a scored candidate, it is the
// caller's `whenEmpty` fallback in decide(). So an empty pool now means exactly
// what it should mean — nothing in hand — and the wake resolves to a blank
// direction instead of rest. Demanding >= 2 would force the list to keep
// manufacturing filler (「试试拍一张」) to satisfy the checker, which is the
// behaviour that was just removed.
//
// What is still worth catching: a pool with exactly ONE item that is not a want,
// i.e. filler standing in for a decision.
const onlyOne = pool.length === 1;
const loneIsWant = onlyOne && pool[0].kind === "want";
check(
  "候选池：空是正常，单条填充不正常",
  !onlyOne || loneIsWant,
  pool.length === 0 ? "空（由 whenEmpty 兜底去探索）" : `${pool.length} 条`,
);

// Her own wants must never be crowded out by novelty suggestions.
const wantCands = pool.filter((c) => c.kind === "want");
const gapCands = pool.filter((c) => c.kind === "gap");
if (wantCands.length && gapCands.length) {
  const bestWant = Math.max(...wantCands.map((c) => c.value));
  const bestGap = Math.max(...gapCands.map((c) => c.value));
  check("自己的念头压在新奇之上", bestWant > bestGap, `want ${bestWant.toFixed(2)} > gap ${bestGap.toFixed(2)}`);
}

// A want that keeps being picked and never gets done should sink. attempts
// stuck at 0 across the whole store means touch() is not wired.
try {
  const open = wants.open(WS);
  if (open.length) {
    const touched = open.filter((w) => Number(w.attempts || 0) > 0).length;
    notes.push(`  info 念头：${open.length} 条 open，其中 ${touched} 条被拿起过`);
  } else {
    notes.push("  info 念头：手里没有攒着的事");
  }
} catch (err) {
  problems.push(`  FAIL 读取 wants 失败 — ${err?.message || err}`);
}

// ---------------------------------------------------------------- LOG

// heartbeat freshness and the empty-streak in one pass
const probePath = path.join(WS, "state", "probe.log");
try {
  const raw = fs.readFileSync(probePath, "utf8").trimEnd().split("\n").slice(-400);
  const act = raw.filter((l) => l.includes("activity-inject"));
  const empties = act.filter((l) => l.includes("activity-inject-empty"));
  const filled = act.length - empties.length;

  if (act.length >= 6) {
    // Count the run of empties at the tail.
    let streak = 0;
    for (let i = act.length - 1; i >= 0; i--) {
      if (act[i].includes("activity-inject-empty")) streak++;
      else break;
    }
    check("最近没有连续空池", streak < 5, `尾部连续空 ${streak} 次 / 最近 ${act.length} 次里 ${empties.length} 次为空`);
  } else {
    notes.push(`  info probe.log 里 activity-inject 样本只有 ${act.length} 条，暂不判断`);
  }
  if (filled > 0) notes.push(`  info 最近 ${act.length} 次活动注入里 ${filled} 次有内容`);
} catch {
  notes.push("  info probe.log 还没生成，跳过日志检查");
}

// ---------------------------------------------------------------- report

console.log(`dafeiyu 自检 · ${WS}`);
console.log(`  ${new Date().toISOString()}`);
console.log("");
if (problems.length) {
  console.log("发现的问题：");
  problems.forEach((p) => console.log(p));
  console.log("");
}
notes.forEach((n) => console.log(n));

if (problems.length) {
  console.log("");
  console.log(`共 ${problems.length} 项不正常。`);
  process.exit(1);
}
console.log("");
console.log(`全部正常。候选 ${pool.length} 条，活动池 ${gaps.length} 条。`);
