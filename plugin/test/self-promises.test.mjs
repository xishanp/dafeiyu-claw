// The promises she writes to herself must survive the twelve-entry window.
//
// Kept as a separate file from self.test.mjs on purpose: that one covers the
// state card (self.json), this one covers memory/self/self.md — the file only
// she writes. Different owners, different failure modes.
//
// Measured 2026-11-06: 13 promises existed, 10 had already scrolled out of
// every prompt and could never return. The regression this locks is "a rule
// that expires after twelve entries is not a rule".

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n     ${e.message}`); }
};

const PROMISE_RE = /(下次|以后|别再|再遇到|不能再|要记住|下次先)/;

// Mirrors buildSelfPromises in index.js. Duplicated rather than exported
// because the function closes over `probe` and `fs` in the plugin scope; a
// test that imports index.js would boot the whole plugin.
function extract(raw) {
  const idx = raw.indexOf("## 本鱼写过的");
  if (idx === -1) return [];
  const body = raw.slice(idx + "## 本鱼写过的".length).trim();
  if (!body) return [];
  const entries = body.split(/\n(?=- )/).map((s) => s.trim()).filter(Boolean);
  const promises = [];
  for (const e of entries) {
    if (!PROMISE_RE.test(e)) continue;
    const m = e.match(PROMISE_RE);
    if (!m) continue;
    const from = e.indexOf(m[0], e.indexOf(" ", 3));
    const rule = e.slice(from >= 0 ? from : 0).replace(/\s+/g, " ").trim();
    if (rule.length < 6) continue;
    const day = (e.match(/^- (\d\d-\d\d)/) || [])[1] || "";
    promises.push({ day, rule: rule.slice(0, 120) });
  }
  const seen = new Set();
  const kept = [];
  for (let i = promises.length - 1; i >= 0; i--) {
    const p = promises[i];
    const sig = p.rule.slice(0, 16);
    if (seen.has(sig)) continue;
    seen.add(sig);
    kept.push(p);
    if (kept.length >= 8) break;
  }
  kept.reverse();
  return kept;
}

const doc = (lines) =>
  `# 本鱼自己写的\n\n## 本鱼写过的\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`;

t("没有承诺时返回空，不制造空白块", () => {
  const raw = doc(["11-06 今天看了一只猫", "11-06 画了三张图"]);
  assert.equal(extract(raw).length, 0);
});

t("「以后…」被识别", () => {
  const raw = doc(["11-05 搞错了单位。以后先看原文那一句，不看脑子里的版本。"]);
  const got = extract(raw);
  assert.equal(got.length, 1);
  assert.match(got[0].rule, /^以后先看原文/);
});

t("「下次先…」被识别", () => {
  const raw = doc(["11-04 被指出毛病时总想解释。下次先改，别先说明。"]);
  assert.equal(extract(raw).length, 1);
  assert.match(extract(raw)[0].rule, /^下次先改/);
});

t("「别再…」被识别", () => {
  const raw = doc(["11-04 又是同一句话发两遍。别再在这条上接着评。"]);
  assert.match(extract(raw)[0].rule, /^别再/);
});

t("只留承诺那一句，不把整段背景搬进来", () => {
  const raw = doc([
    "11-05 今天翻了一年半的稿子，从头到尾都在给一句话找原因，找了三天。以后碰到一个「日子」，先问这几年同一个动作都发生在什么时候。",
  ]);
  const got = extract(raw);
  assert.equal(got.length, 1);
  // The rule, not the story.
  assert.ok(got[0].rule.startsWith("以后"));
  assert.ok(!got[0].rule.includes("翻了一年半"));
});

t("太短的不算（防止把半个词当规则）", () => {
  const raw = doc(["11-06 以后吧"]);
  assert.equal(extract(raw).length, 0);
});

t("同一句话写两遍只留一条", () => {
  const raw = doc([
    "11-05 以后先看原文那一句，不看自己脑子里那个版本，别再犯。",
    "11-06 以后先看原文那一句，不看自己脑子里那个版本，别再犯。",
  ]);
  assert.equal(extract(raw).length, 1);
});

t("最多 8 条，不无限增长", () => {
  const lines = Array.from({ length: 20 }, (_, i) =>
    `11-0${(i % 9) + 1} 以后第${i}种情况要先停一下再动手做点别的`
  );
  assert.equal(extract(lines.length ? doc(lines) : "").length, 8);
});

t("按时间正序输出，最早的在最上面", () => {
  const raw = doc([
    "11-04 以后早的那条规则要记住",
    "11-06 以后晚的那条规则要记住",
  ]);
  const got = extract(raw);
  assert.equal(got.length, 2);
  assert.match(got[0].day, /11-04/);
  assert.match(got[1].day, /11-06/);
});

t("没有标题的文件返回空，不误读整份", () => {
  assert.equal(extract("# 随便一份东西\n\n- 以后要好好做人").length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
