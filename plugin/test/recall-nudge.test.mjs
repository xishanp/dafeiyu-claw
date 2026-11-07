// Yesterday's own words, without the machine noise.
//
// The regression: 139,729 characters of diary existed and 0 were injected.
// What must not regress: the thing injected has to be HER writing. The day file
// is shared — the plugin writes dialogue, a log writer writes `| fail |` lines,
// and only `## 自己的话` belongs to her.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as rn from "../lib/recall-nudge.js";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n     ${e.message}`); }
};

const stamp = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const ws = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rn-"));
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  return dir;
};

const writeDay = (dir, daysAgo, body, now = new Date("2026-11-06T12:00:00")) => {
  const d = new Date(now.getTime() - daysAgo * 86400000);
  fs.writeFileSync(path.join(dir, "memory", `${stamp(d)}.md`), body);
};

// Machine lines really do appear INSIDE `## 自己的话` in the production files —
// verified 2026-11-06 against 11-03 / 11-04 / 11-06, which all carry
// `- 2026-11-05T23:35:07.352Z | local | - | fail | 1310330ms` under that head.
// Putting them above the head (the first version of this fixture) made the
// filter untestable: deleting the filter still passed.
const full = (diary, { machine = true } = {}) => [
  "# 2026-11-05",
  "",
  "## 18:00 · 用户",
  "对方: 在干嘛",
  "本鱼: 在画东西",
  "",
  "## 自己的话",
  machine ? "- 2026-11-05T10:15:32.306Z | onebot | - | fail | 318754ms" : "",
  diary,
  "",
].filter((l) => l !== "").join("\n");

const NOW = new Date("2026-11-06T12:00:00");

t("只有自己的话被带出来，机器行和对话不带", () => {
  const dir = ws();
  writeDay(dir, 1, full("- 23:39 23:40 翻出一条 2020 年的稿子，缺口在 2011—2018"), NOW);
  const got = rn.lastWritten(dir, { now: NOW });
  assert.equal(got.lines.length, 1);
  assert.ok(got.lines[0].includes("2020 年"));
  assert.equal(got.lines[0].includes("fail"), false);
  assert.equal(got.lines[0].includes("对方"), false);
});

t("最多 3 条", () => {
  const dir = ws();
  writeDay(dir, 1, full([1, 2, 3, 4, 5].map((i) => `- 1${i}:00 第${i}条记录，内容足够长可以保留下来`).join("\n")), NOW);
  assert.equal(rn.lastWritten(dir, { now: NOW }).lines.length, 3);
});

t("取的是最后 3 条，不是最前 3 条", () => {
  const dir = ws();
  writeDay(dir, 1, full([1, 2, 3, 4, 5].map((i) => `- 1${i}:00 第${i}条记录，内容足够长可以保留下来`).join("\n")), NOW);
  const got = rn.lastWritten(dir, { now: NOW });
  assert.ok(got.lines[0].includes("第3条"));
  assert.ok(got.lines[2].includes("第5条"));
});

t("昨天没写就往前找，不会空着", () => {
  const dir = ws();
  writeDay(dir, 2, full("- 22:00 前天写的那一条，内容足够长可以保留"), NOW);
  const got = rn.lastWritten(dir, { now: NOW });
  assert.ok(got);
  assert.ok(got.lines[0].includes("前天"));
});

t("超过 3 天都空着就返回 null", () => {
  const dir = ws();
  writeDay(dir, 5, full("- 22:00 五天前的记录，内容足够长可以保留"), NOW);
  assert.equal(rn.lastWritten(dir, { now: NOW }), null);
});

t("没有「自己的话」这一节时不误读整份文件", () => {
  const dir = ws();
  writeDay(dir, 1, "# 2026-11-05\n\n对方: 你好\n本鱼: 你好\n", NOW);
  assert.equal(rn.lastWritten(dir, { now: NOW }), null);
});

t("太短的行丢掉（噪声）", () => {
  const dir = ws();
  writeDay(dir, 1, full("- 22:00 短\n- 23:00 这一条内容足够长，应该被保留下来"), NOW);
  const got = rn.lastWritten(dir, { now: NOW });
  assert.equal(got.lines.length, 1);
  assert.ok(got.lines[0].includes("足够长"));
});

t("超长行截断，不撑爆 prompt", () => {
  const dir = ws();
  writeDay(dir, 1, full(`- 22:00 ${"长".repeat(300)}`), NOW);
  const got = rn.lastWritten(dir, { now: NOW });
  assert.ok(got.lines[0].length <= 111, `得到 ${got.lines[0].length}`);
});

t("describe 带日期和出处说明", () => {
  const dir = ws();
  writeDay(dir, 1, full("- 23:39 翻出一条 2020 年的稿子，缺口在 2011—2018"), NOW);
  const out = rn.describe(dir, { now: NOW });
  assert.ok(out.includes("11-05"));
  assert.ok(out.includes("不用接着做"));
});

t("空工作区返回空串，不制造空块", () => {
  assert.equal(rn.describe(ws(), { now: NOW }), "");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

// 早上那次醒来，和普通一轮，剂量不该一样。
const many = (n) => Array.from({ length: n }, (_, i) => `- 第 ${i + 1} 条自己写的话，长度够过噪声门槛`).join("\n");
const bigDay = (dir) => writeDay(dir, 1, full(many(20)));

t("morning 模式给得比 turn 多", () => {
  const dir = ws(); bigDay(dir);
  const turn = rn.describe(dir);
  const morning = rn.describe(dir, { morning: true });
  assert.ok(morning.length > turn.length, `morning(${morning.length}) 应比 turn(${turn.length}) 长`);
});

t("turn 模式仍保持克制（3 条）", () => {
  const dir = ws(); bigDay(dir);
  const got = rn.lastWritten(dir);
  assert.equal(got.lines.length, 3);
});

t("morning 模式带 10 条", () => {
  const dir = ws(); bigDay(dir);
  const got = rn.lastWritten(dir, { morning: true });
  assert.equal(got.lines.length, 10);
});

t("总数超过展示时，告诉她还剩多少", () => {
  const dir = ws(); bigDay(dir);
  const morning = rn.describe(dir, { morning: true });
  assert.ok(/一共 \d+ 条/.test(morning), "应该标注总数");
});
