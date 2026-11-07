// Tests for the curiosity layer.
//
// The mechanism has one job: notice a specific thing she does not have, and —
// if it keeps pulling on her — turn it into something she has decided to find
// out. Everything here checks one of those two links, or checks the guards that
// keep the list from filling with noise.
//
// History worth keeping in mind while reading: an earlier version recorded
// *failed lookups* as gaps. It passed its own tests and produced zero output in
// 313 real turns, because a failed lookup is not curiosity. These tests are
// shaped to catch that class of mistake — each one ends by asking whether a
// real entry came out, not whether a function returned without throwing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as curiosity from "../lib/curiosity.js";
import * as extract from "../lib/curiosity-extract.js";

function freshWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "curiosity-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.mkdirSync(path.join(ws, "memory", "facts"), { recursive: true });
  return ws;
}

// ── Extraction: what counts as a candidate ────────────────────────────────

test("latin: only name-shaped tokens survive", () => {
  const got = extract.latin("Python is a language. Zink is a gallium driver.");
  assert.deepEqual(got, ["Python", "Zink"]);
  // `language` and `driver` are ordinary vocabulary. An earlier version
  // accepted every 4+ letter word and produced both of these from this exact
  // sentence, which is what taught the list to be unreadable.
  assert.ok(!got.includes("language"));
  assert.ok(!got.includes("driver"));
});

test("latin: identifiers with digits or punctuation are names", () => {
  const got = extract.latin("我用 node.js 和 gpt-4.1 还有 c++");
  assert.ok(got.includes("node.js"), JSON.stringify(got));
  assert.ok(got.includes("gpt-4.1"), JSON.stringify(got));
});

test("latin: tool noise never becomes a candidate", () => {
  const got = extract.latin('{"error":"null","status":"ok","value":123}');
  assert.deepEqual(got, []);
});

test("zh: a definition question yields the noun, not the sentence", () => {
  const got = extract.zhQuestions("到底什么是 redox？");
  assert.ok(got.includes("redox"), JSON.stringify(got));
  // The whole sentence must not also appear: `redox` is searchable, the
  // sentence is not, and two entries for one unknown means two lookups.
  assert.ok(!got.some((g) => g.includes("到底什么是")), JSON.stringify(got));
});

test("zh: a question with no single noun is kept whole", () => {
  const got = extract.zhQuestions("古代几万人打仗，靠什么知道该进还是该退？");
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.ok(got[0].includes("靠什么"), got[0]);
});

test("zh: a question containing a space is not truncated", () => {
  // Real line from her own notes. The separator set originally excluded ASCII
  // space, so this came back cut at the length cap.
  const got = extract.zhQuestions("为什么不直接烤 非用 2.45GHz？");
  assert.ok(got.some((g) => g.includes("2.45GHz")), JSON.stringify(got));
});

test("zh: questions about a person are conversational, not curious", () => {
  assert.deepEqual(extract.zhQuestions("你为什么这样？"), []);
  assert.deepEqual(extract.zhQuestions("我该怎么办？"), []);
});

test("zh: a declarative sentence ending in a question mark is not a gap", () => {
  assert.deepEqual(extract.zhQuestions("今天天气很好？"), []);
});

test("names: output is capped and deduplicated", () => {
  const got = extract.names("Zink zink ZINK Mesa Vulkan wgpu Turnip", { max: 3 });
  assert.equal(got.length, 3, JSON.stringify(got));
  assert.equal(new Set(got.map((g) => g.toLowerCase())).size, 3);
});

// ── Key normalisation ─────────────────────────────────────────────────────

test("keyOf: one thing said two ways lands on one key", () => {
  assert.equal(curiosity.keyOf("Zink"), curiosity.keyOf("ZINK"));
  assert.equal(
    curiosity.keyOf("为什么不直接烤 非用 2.45GHz？"),
    curiosity.keyOf("为什么不直接烤非用2.45GHz"),
  );
});

// ── Noticing ──────────────────────────────────────────────────────────────

test("notice: a known name is not a noticing", () => {
  const ws = freshWs();
  assert.equal(curiosity.notice(ws, "python", { known: ["python"] }), null);
});

test("notice: an unknown name is recorded", () => {
  const ws = freshWs();
  const e = curiosity.notice(ws, "Zink", { known: ["python"] });
  assert.ok(e);
  assert.equal(e.display, "Zink");
  assert.equal(e.seen, 1);
  assert.equal(e.status, "open");
});

test("notice: meeting it again increments seen", () => {
  // This is the link that was broken. `familiar()` used to fold her own
  // noticings into the known-set, so the second encounter with `Zink` was
  // rejected as "already known" and `seen` stayed at 1 forever. Nothing could
  // then reach the threshold that turns a noticing into a want.
  const ws = freshWs();
  curiosity.notice(ws, "Zink", { known: [] });
  const second = curiosity.notice(ws, "Zink", { known: [] });
  assert.equal(second.seen, 2);
  const third = curiosity.notice(ws, "Zink", { known: [] });
  assert.equal(third.seen, 3);
});

test("notice: the better spelling wins without letting caps overwrite it", () => {
  const ws = freshWs();
  curiosity.notice(ws, "DeepSeek", {});
  const e = curiosity.notice(ws, "DEEPSEEK", {});
  assert.equal(e.display, "DeepSeek");
});

test("notice: reasons accumulate but stay bounded", () => {
  const ws = freshWs();
  for (let i = 0; i < 8; i++) curiosity.notice(ws, "Zink", { reason: `r${i}` });
  const [n] = curiosity.noticings(ws);
  assert.ok(n.reasons.length <= 4, JSON.stringify(n.reasons));
  assert.equal(n.reasons.at(-1), "r7");
});

// ── Pull, propose, hand off ───────────────────────────────────────────────

test("pull: recurrence raises it, one-off stays low", () => {
  const ws = freshWs();
  curiosity.notice(ws, "Mesa", {});
  const [once] = curiosity.noticings(ws);
  for (let i = 0; i < 3; i++) curiosity.notice(ws, "Zink", {});
  const many = curiosity.noticings(ws).find((n) => n.display === "Zink");
  assert.ok(curiosity.pull(many) > curiosity.pull(once));
});

test("propose: always returns an array", () => {
  // Returning null for "nothing" and an array for "something" makes callers
  // test the shape instead of the length; one of them will get it wrong.
  const ws = freshWs();
  assert.ok(Array.isArray(curiosity.propose(ws)));
  assert.equal(curiosity.propose(ws).length, 0);
});

test("propose: a single encounter is not enough to surface", () => {
  const ws = freshWs();
  curiosity.notice(ws, "Turnip", {});
  assert.equal(curiosity.propose(ws, { minPull: 0.55 }).length, 0);
});

test("propose: repeated encounters surface it", () => {
  const ws = freshWs();
  for (let i = 0; i < 3; i++) curiosity.notice(ws, "Zink", {});
  const picks = curiosity.propose(ws);
  assert.equal(picks.length, 1, JSON.stringify(picks));
  assert.equal(picks[0].display, "Zink");
});

test("propose: 池子可以有多条，但默认只给一条", () => {
  // This test used to assert `propose(budget:10).length === 1` — that intake had
  // a hard ceiling of one. That was MAX_SURFACED leaking from presentation into
  // intake, and it is what starved the candidate pool: six questions tied at the
  // same score, exactly one of them ever surfaced, so the same one won every
  // wake for seven hours while the other five were never offered.
  //
  // The rule that survives is about presentation, and it still holds: call with
  // no budget and you get one. Asking for more gets more, because the caller
  // ranking a pool needs more than one to rank.
  const ws = freshWs();
  for (const n of ["Zink", "Mesa", "Vulkan", "Turnip"]) for (let i = 0; i < 3; i++) curiosity.notice(ws, n, {});
  assert.equal(curiosity.propose(ws).length, 1, "默认仍然只给一条");
  const many = curiosity.propose(ws, { budget: 10 });
  assert.equal(many.length, 4, "要多少给多少（受候选数限制）");
  assert.equal(new Set(many.map((n) => n.id)).size, 4, "四条不同");
});

test("handOff: turns a noticing into a want", () => {
  const ws = freshWs();
  for (let i = 0; i < 3; i++) curiosity.notice(ws, "Zink", {});
  const added = [];
  const wants = {
    add: (_ws, w) => {
      added.push(w);
      return { ok: true, id: "want-1" };
    },
  };
  const r = curiosity.handOff(ws, "Zink", wants);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(added.length, 1);
  assert.ok(added[0].what.includes("Zink"), JSON.stringify(added[0]));
});

test("handOff: refuses a cold one-off", () => {
  // Handing over everything would make curiosity a to-do generator, which is
  // the failure mode this design exists to avoid.
  const ws = freshWs();
  curiosity.notice(ws, "Turnip", {});
  const wants = { add: () => ({ ok: true, id: "w" }) };
  const r = curiosity.handOff(ws, "Turnip", wants);
  assert.equal(r.ok, false);
});

test("handOff: the same noticing is not handed over twice", () => {
  const ws = freshWs();
  for (let i = 0; i < 3; i++) curiosity.notice(ws, "Zink", {});
  const wants = { add: () => ({ ok: true, id: "want-1" }) };
  assert.equal(curiosity.handOff(ws, "Zink", wants).ok, true);
  assert.equal(curiosity.handOff(ws, "Zink", wants).ok, false);
});

// ── Losing interest ───────────────────────────────────────────────────────

test("loseInterest: drops it and it stops surfacing", () => {
  const ws = freshWs();
  for (let i = 0; i < 3; i++) curiosity.notice(ws, "Zink", {});
  assert.equal(curiosity.loseInterest(ws, "Zink").ok, true);
  assert.equal(curiosity.propose(ws).length, 0);
});

test("loseInterest: a fragment finds the longer entry", () => {
  const ws = freshWs();
  curiosity.notice(ws, "为什么不直接烤 非用 2.45GHz", {});
  assert.equal(curiosity.loseInterest(ws, "2.45GHz").ok, true);
});

test("loseInterest: an ambiguous fragment drops nothing", () => {
  // Silently dropping two records because a fragment matched both is worse
  // than refusing.
  const ws = freshWs();
  curiosity.notice(ws, "Vulkan 后端", {});
  curiosity.notice(ws, "Vulkan 驱动", {});
  assert.equal(curiosity.loseInterest(ws, "Vulkan").ok, false);
  assert.equal(curiosity.noticings(ws).length, 2);
});

test("loseInterest: it is not a claim of understanding", () => {
  // There is no "resolved" state on purpose. Stats must not report a learned
  // count, because losing interest is not learning.
  const ws = freshWs();
  curiosity.notice(ws, "Zink", {});
  curiosity.loseInterest(ws, "Zink");
  const st = curiosity.stats(ws);
  assert.equal(st.faded, 1);
  assert.equal(st.open, 0);
  assert.equal("resolved" in st, false, JSON.stringify(st));
});

// ── Persistence ───────────────────────────────────────────────────────────

test("state survives a reload", () => {
  const ws = freshWs();
  for (let i = 0; i < 3; i++) curiosity.notice(ws, "Zink", {});
  const again = curiosity.noticings(ws);
  assert.equal(again.length, 1);
  assert.equal(again[0].seen, 3);
});

test("an empty workspace is not an error", () => {
  const ws = freshWs();
  assert.deepEqual(curiosity.noticings(ws), []);
  assert.deepEqual(curiosity.propose(ws), []);
  assert.equal(curiosity.stats(ws).open, 0);
});

test("trimming drops the weakest pull, not the oldest", () => {
  // An old noticing that keeps coming back is the most alive thing in the
  // file; the newest one-off is the least. Evicting by age would delete
  // exactly the wrong entries.
  const ws = freshWs();
  for (let i = 0; i < curiosity.CONSTANTS.MAX_NOTICINGS + 5; i++) {
    curiosity.notice(ws, `filler${i}`, {});
  }
  // Make one entry ancient but recurring.
  for (let i = 0; i < 6; i++) curiosity.notice(ws, "filler0", {});
  const open = curiosity.noticings(ws, { limit: 200 });
  assert.ok(open.some((n) => n.topic === "filler0"), "the recurring entry was evicted");
});
