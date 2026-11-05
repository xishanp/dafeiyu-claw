// Offline verification of the effect ledger.
// Run: node test/effect-ledger.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import * as ledger from "../lib/effect-ledger.js";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dafeiyu-ledger-"));
let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

function reset() {
  const f = ledger.ledgerFile(ws);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

console.log("effect-ledger");

// ── the refusal: an effect that does not exist is not credited ──────────────

t("a real file verifies", () => {
  reset();
  const p = path.join(ws, "drawn", "a.png");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "fake png bytes");
  const r = ledger.record(ws, { kind: "drawn", note: "一盏灯", ref: p });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true, "should verify");
  assert.equal(r.reason, "exists");
});

t("a missing file is recorded but NOT verified", () => {
  reset();
  const r = ledger.record(ws, { kind: "drawn", note: "编的", ref: "/tmp/definitely-not-here-xyz.png" });
  assert.equal(r.ok, true, "still records — a claim is information");
  assert.equal(r.verified, false, "but must not be credited");
  assert.equal(r.reason, "missing");
});

t("a missing ref is unverified, not an error", () => {
  reset();
  const r = ledger.record(ws, { kind: "browsed", note: "随便看了看" });
  assert.equal(r.ok, true);
  assert.equal(r.verified, false);
  assert.equal(r.reason, "no_ref");
});

t("a URL is unverified-but-plausible", () => {
  reset();
  const r = ledger.record(ws, { kind: "researched", note: "查到一段", ref: "https://example.com/x" });
  assert.equal(r.verified, false);
  assert.equal(r.reason, "url_unverifiable");
});

t("a relative path resolves against the workspace", () => {
  reset();
  fs.mkdirSync(path.join(ws, "assets"), { recursive: true });
  fs.writeFileSync(path.join(ws, "assets", "b.png"), "x");
  const r = ledger.record(ws, { kind: "drawn", note: "相对路径", ref: "assets/b.png" });
  assert.equal(r.verified, true, "relative should resolve");
  assert.equal(r.entry.ref, path.join(ws, "assets", "b.png"));
});

// ── the gate: speech cannot enter the production ledger ────────────────────

t("a speech kind is rejected with a reason", () => {
  reset();
  for (const k of ["sticker", "qzone", "voice", "qzone-like"]) {
    const r = ledger.record(ws, { kind: k, note: "说话" });
    assert.equal(r.ok, false, `${k} must not be a production`);
    assert.match(r.reason, /不是产出类/);
  }
});

t("an unknown kind is rejected", () => {
  reset();
  const r = ledger.record(ws, { kind: "whatever", note: "?" });
  assert.equal(r.ok, false);
});

t("empty kind is rejected", () => {
  reset();
  const r = ledger.record(ws, { note: "没 kind" });
  assert.equal(r.ok, false);
});

// ── dedupe: the same artifact twice is one act ─────────────────────────────

t("same file + same note within an hour is a duplicate", () => {
  reset();
  const p = path.join(ws, "drawn", "dup.png");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "bytes");
  const a = ledger.record(ws, { kind: "drawn", note: "同一张", ref: p });
  const b = ledger.record(ws, { kind: "drawn", note: "同一张", ref: p });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true, "second should be recognised");
  assert.equal(ledger.all(ws).length, 1, "only one row");
});

t("same file + different note is a separate act", () => {
  reset();
  const p = path.join(ws, "drawn", "x.png");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "bytes");
  ledger.record(ws, { kind: "drawn", note: "第一版", ref: p });
  ledger.record(ws, { kind: "drawn", note: "改过了", ref: p });
  assert.equal(ledger.all(ws).length, 2);
});

// ── summary is the number that matters ─────────────────────────────────────

t("summary splits verified from claimed", () => {
  reset();
  const p = path.join(ws, "a.txt");
  fs.writeFileSync(p, "real");
  ledger.record(ws, { kind: "wrote", note: "真的", ref: p });
  ledger.record(ws, { kind: "drawn", note: "编的", ref: "/nope/gone.png" });
  ledger.record(ws, { kind: "drawn", note: "又编一个", ref: "/nope/gone2.png" });
  const s = ledger.summary(ws, 7);
  assert.equal(s.total, 3);
  assert.equal(s.verified, 1);
  assert.equal(s.unverified, 2);
  assert.equal(s.byKind.wrote, 1);
  assert.equal(s.byKind.drawn, 2);
});

// ── what gets injected ─────────────────────────────────────────────────────

t("describe says so plainly when nothing was made", () => {
  reset();
  const d = ledger.describe(ws);
  assert.match(d, /一件都没有/);
});

t("describe flags an artifact that has since vanished", () => {
  reset();
  const p = path.join(ws, "gone.png");
  fs.writeFileSync(p, "x");
  ledger.record(ws, { kind: "drawn", note: "在的", ref: p });
  fs.unlinkSync(p);
  const d = ledger.describe(ws);
  assert.match(d, /已经不在了/, "should notice the file is gone");
});

t("describe counts the dry spell", () => {
  reset();
  const file = ledger.ledgerFile(ws);
  const old = new Date(Date.now() - 4 * 86400_000).toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    updated_at: old,
    entries: [{ kind: "drawn", note: "四天前", ref: null, verified: false, at: old }],
  }));
  const d = ledger.describe(ws);
  assert.match(d, /4 天没做出新东西了/);
});

// ── caps ───────────────────────────────────────────────────────────────────

t("entries are capped at 300", () => {
  reset();
  for (let i = 0; i < 310; i++) {
    ledger.record(ws, { kind: "browsed", note: `第${i}次` });
  }
  const n = ledger.all(ws).length;
  assert.equal(n, 300, `expected 300, got ${n}`);
});

t("note is capped at 120 chars", () => {
  reset();
  const r = ledger.record(ws, { kind: "wrote", note: "字".repeat(300) });
  assert.equal([...r.entry.note].length, 120);
});

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(ws, { recursive: true, force: true });
if (fail) process.exit(1);
