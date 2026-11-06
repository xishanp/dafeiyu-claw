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

// ---------------------------------------------------------------- 6
// Curiosity. The prompt and the code drifted apart badly once already: the
// prompt told her to call `curiosity_resolve` and `curiosity_state(drop=...)`
// while the code had stopped exporting both, so following the instructions
// produced a tool-not-found. These checks fail loudly on that class of drift.
{
  let cog = "";
  try { cog = fs.readFileSync(path.join(WS, "COGNITION.md"), "utf8"); } catch { /* ok */ }
  if (!cog) {
    ok("COGNITION.md 不存在，跳过好奇心检查");
  } else {
    // Tools the prompt names must exist in the source.
    const named = [...cog.matchAll(/(curiosity_[a-z_]+)\s*\(/g)].map((m) => m[1]);
    const uniq = [...new Set(named)];
    const missing = uniq.filter((t) => !actSrc.includes(`"${t}"`));
    if (missing.length) bad(`COGNITION.md 让调用不存在的工具：${missing.join("、")}`);
    else if (uniq.length) ok(`COGNITION.md 提到的好奇心工具都存在（${uniq.join(" / ")}）`);

    // The dead API must not creep back in.
    const dead = ["curiosity_resolve", "curiosity_gaps"].filter((d) => cog.includes(d));
    if (dead.length) bad(`COGNITION.md 还在用旧 API：${dead.join("、")}`);
    else ok("COGNITION.md 没有残留旧好奇心 API");

    // "resolved" would be a claim of understanding the code cannot back: the
    // module has open / wanted / faded and nothing else.
    if (cog.includes("curiosity_resolve")) {
      bad("COGNITION.md 仍把「弄明白了」当成一个动作，代码里没有这个状态");
    } else ok("COGNITION.md 没有把「弄明白了」写成动作");

    // The system must never assert that she does not understand a name. Its
    // filter compares against her diary, and a diary is not a vocabulary —
    // `linux` is absent from her notes and she knows exactly what it is.
    // Telling her 「你还没弄清它」 would be a false statement in her own voice.
    if (/你到现在还没弄清|你弄不明白|你攒着没弄明白/.test(cog)) {
      bad("COGNITION.md 替她断言「你不懂」，系统没有这个知识");
    } else ok("COGNITION.md 没有替她断言懂或不懂");

    // She has to be told that clearing false entries is the expected move,
    // otherwise every common word that passes the shape filter stays forever.
    if (!/curiosity_forget/.test(cog) || !/本来就知道|知道了就划掉|知道哪个/.test(cog)) {
      bad("COGNITION.md 没讲「本来就知道的要划掉」，列表会被常见词填满");
    } else ok("COGNITION.md 讲了划掉已知项");

    // Recurrence must be described, because it is the actual mechanism that
    // turns a noticing into a want. If the prompt omits it she will hand over
    // every passing mention and the layer becomes a to-do generator.
    if (!/碰到第二次|碰到过好几次|同一个东西碰到/.test(cog)) {
      bad("COGNITION.md 没讲「反复碰到才会变成想做的事」");
    } else ok("COGNITION.md 讲了反复碰到才升级");
  }
}

// ------------------------------------------------ about / person.md
{
  const label = "【他自己说过的】";
  const instr = (() => { try { return fs.readFileSync(path.join(WS, "AGENTS.md"), "utf8"); } catch { return ""; } })();
  const inPrompt = instr.includes(label);
  const inCode = fs.readFileSync(new URL("../lib/about.js", import.meta.url), "utf8").includes(label);
  if (inPrompt && inCode) ok(`提示词和 lib/about.js 都用了 ${label}`);
  else if (!inCode) bad(`提示词有 ${label}，但 lib/about.js 不产出它`);
  else bad(`lib/about.js 产出 ${label}，但提示词没讲怎么用`);
  if (instr.includes("memory/facts/person.md")) ok("提示词点明了记录写在 memory/facts/person.md");
  else bad("提示词没说 remember_about / 自动记录落在 person.md");
  if (/记的是他的?原话/.test(instr)) ok("提示词讲清了记原话不是下判断");
  else bad("提示词没说清记的是原话");
}


// ------------------------------------------------ wander / browsed
{
  const cog = (() => { try { return fs.readFileSync(path.join(WS, "COGNITION.md"), "utf8"); } catch { return ""; } })();
  const src = fs.readFileSync(path.join(HERE, "..", "index.js"), "utf8");
  // 提示词讲了「自己去逛了」，代码就必须真的会写这条 deed。
  if (cog.includes("自己去逛了") && /kind:\s*"browsed"/.test(src)) {
    ok("提示词讲了「自己去逛了」，代码会写 browsed");
  } else if (cog.includes("自己去逛了")) {
    bad("提示词讲了「自己去逛了」，但没有任何地方写 browsed");
  }
  // 第二次才浮现，这是这一环的核心，两边都得说对。
  const lib = fs.readFileSync(path.join(HERE, "..", "lib", "curiosity.js"), "utf8");
  if (/0\.30 \* recur/.test(lib) && /第二次再碰到|第二次才浮现|碰两次/.test(cog)) {
    ok("名字要碰两次才浮现，代码和提示词一致");
  } else if (!/0\.30 \* recur/.test(lib)) {
    bad("pull() 的复现系数不是 0.30，dangling 可能又永远浮现不了");
  } else {
    bad("提示词没说名字要碰两次才浮现");
  }
}

// ------------------------------------------------ draw vs selfie
{
  const read = (f) => { try { return fs.readFileSync(path.join(WS, f), "utf8"); } catch { return ""; } };
  const all = ["AGENTS.md", "SOUL.md", "PROACTIVE.md", "COGNITION.md"].map(read).join("\n");
  // 「想画就画」是无条件许可，会把画图变成默认动作。主人明确要求它淡出。
  if (/想画就画/.test(all)) bad("还有「想画就画」，画图会继续变成默认动作");
  else ok("没有无条件的「想画就画」");
  // 画图必须被明确降级，而不是简单删掉——删掉她就不敢画了。
  if (/画图不是默认动作|不是随手一张|画是你的本事，不是你的日常/.test(all)) {
    ok("画图被降为次要，不是直接删掉");
  } else bad("画图没有被明确降级，可能又被当成默认动作");
  // 自拍必须留着，且能独立成立。
  const selfie = /自拍/.test(read("AGENTS.md")) && /自拍一张/.test(read("PROACTIVE.md"));
  if (selfie) ok("自拍保留，且有可执行的指令");
  else bad("自拍丢了或没有可执行指令");
  // 好奇心要当主线：得有一处说出它比画图优先。
  if (/这是最正经的一条|先去看、先去查，画放后面|画放后面/.test(all)) ok("好奇心被写成主线，画图在其后");
  else bad("没说清好奇心比画图优先");
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
