// Offline verification of the curiosity store and its extractors.
// Run: node --test test/curiosity.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert";

import * as curiosity from "../lib/curiosity.js";
import * as extract from "../lib/curiosity-extract.js";

function freshWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dafeiyu-curiosity-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
}

const recallEmpty = (q) => ({
  content: [{ type: "text", text: `没找到关于「${q}」的牵连。要么本来就没记，要么还没连上。` }],
});
const recallHit = (q) => ({
  content: [{ type: "text", text: `找到 3 条关于「${q}」的记忆` }],
});

// ── store ────────────────────────────────────────────────────────────

test("first mention creates one open gap", () => {
  const ws = freshWs();
  const g = curiosity.note(ws, "某种作物减产的原因", { source: "recall" });
  assert.ok(g);
  assert.equal(g.status, "open");
  assert.equal(g.times_encountered, 1);
  assert.deepEqual(g.sources, ["recall"]);
  assert.equal(curiosity.gaps(ws).length, 1);
});

test("repeat mention accumulates rather than duplicating", () => {
  const ws = freshWs();
  curiosity.note(ws, "某种作物减产的原因", { source: "recall" });
  curiosity.note(ws, "某种作物减产的原因", { source: "browse" });
  const g = curiosity.note(ws, "某种作物减产的原因", { source: "search" });
  assert.equal(g.times_encountered, 3);
  assert.deepEqual(g.sources.sort(), ["browse", "recall", "search"]);
  assert.equal(curiosity.gaps(ws).length, 1, "three sightings, one gap");
  assert.ok(g.confidence > 0.7, "confidence should climb with encounters");
});

test("topic normalisation folds spacing and punctuation", () => {
  const ws = freshWs();
  curiosity.note(ws, "「Zink 和 Vulkan」", { source: "recall" });
  curiosity.note(ws, "zink 和 vulkan。", { source: "browse" });
  assert.equal(curiosity.gaps(ws).length, 1);
});

test("a mention below the confidence floor is refused", () => {
  const ws = freshWs();
  assert.equal(curiosity.note(ws, "随便什么东西", { confidence: 0.1 }), null);
  assert.equal(curiosity.gaps(ws).length, 0);
});

test("single characters and empty topics are refused", () => {
  const ws = freshWs();
  assert.equal(curiosity.note(ws, "", { source: "recall" }), null);
  assert.equal(curiosity.note(ws, "   ", { source: "recall" }), null);
  assert.equal(curiosity.note(ws, "a", { source: "recall" }), null);
});

test("more encounters outranks fewer", () => {
  const ws = freshWs();
  curiosity.note(ws, "冷门一点的问题", { source: "recall" });
  for (let i = 0; i < 4; i++) curiosity.note(ws, "热门一点的问题", { source: "recall" });
  const ranked = curiosity.gaps(ws);
  assert.equal(ranked[0].display, "热门一点的问题");
});

test("resolving records how it ended and stops proposing", () => {
  const ws = freshWs();
  curiosity.note(ws, "Turnip 是什么", { source: "recall" });
  const r = curiosity.resolve(ws, "Turnip 是什么", "found", "安卓上的 Vulkan 驱动");
  assert.equal(r.status, "resolved");
  assert.equal(r.resolve_note, "安卓上的 Vulkan 驱动");
  assert.equal(curiosity.gaps(ws).length, 0, "resolved gaps are not open");
  assert.equal(curiosity.stats(ws).resolved, 1);
});

test("dropped is a different ending than resolved", () => {
  const ws = freshWs();
  curiosity.note(ws, "某件不再重要的事", { source: "recall" });
  curiosity.resolve(ws, "某件不再重要的事", "dropped");
  const st = curiosity.stats(ws);
  assert.equal(st.dropped, 1);
  assert.equal(st.resolved, 0, "giving up is not learning");
});

test("re-encountering a resolved gap reopens it", () => {
  const ws = freshWs();
  curiosity.note(ws, "到底为什么", { source: "recall" });
  curiosity.resolve(ws, "到底为什么", "found", "以为懂了");
  const g = curiosity.note(ws, "到底为什么", { source: "recall" });
  assert.equal(g.status, "open", "the answer did not stick");
  assert.equal(g.times_encountered, 2);
});

test("propose returns at most the budget", () => {
  const ws = freshWs();
  for (let i = 0; i < 5; i++) curiosity.note(ws, `问题编号${i}`, { source: "recall" });
  assert.equal(curiosity.propose(ws, { budget: 1 }).length, 1);
  assert.equal(curiosity.propose(ws, { budget: 0 }).length, 0);
});

test("propose records that it proposed", () => {
  const ws = freshWs();
  curiosity.note(ws, "被提过一次的问题", { source: "recall" });
  curiosity.propose(ws);
  const after = curiosity.gaps(ws)[0];
  assert.equal(after.proposed_count, 1);
  assert.ok(after.last_proposed_at, "timestamp is what lets a gap cool down");
});

test("the store survives a corrupt file", () => {
  const ws = freshWs();
  fs.writeFileSync(path.join(ws, "state", "curiosity.json"), "{not json", "utf8");
  assert.doesNotThrow(() => curiosity.load(ws));
  assert.equal(curiosity.gaps(ws).length, 0);
  assert.ok(curiosity.note(ws, "坏文件之后还能写", { source: "recall" }));
});

// ── extractors ───────────────────────────────────────────────────────

test("empty recall becomes a gap", () => {
  const hits = extract.fromRecall({ params: { query: "某种作物" }, result: recallEmpty("某种作物") });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].topic, "某种作物");
  assert.equal(hits[0].domain, "knowledge");
});

test("a successful recall is not a gap", () => {
  const hits = extract.fromRecall({ params: { query: "火锅" }, result: recallHit("火锅") });
  assert.equal(hits.length, 0, "finding it means the shelf was not empty");
});

test("who_is on a stranger is a person gap", () => {
  const hits = extract.fromWhoIs({
    params: { name: "张三" },
    result: { content: [{ type: "text", text: "不认识这个人，没记录。" }] },
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].domain, "person");
  assert.match(hits[0].topic, /张三/);
});

test("numeric ids are not person gaps", () => {
  const hits = extract.fromWhoIs({
    params: { name: "1000000001" },
    result: { content: [{ type: "text", text: "查不到" }] },
  });
  assert.equal(hits.length, 0);
});

test("explicit not-knowing becomes a gap", () => {
  const hits = extract.fromQuestion("我不知道 Zink 是什么东西");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].topic, "Zink");
});

test("meta not-knowing is refused", () => {
  assert.equal(extract.fromQuestion("我不知道你在说什么").length, 0);
  assert.equal(extract.fromQuestion("不知道该怎么办").length, 0);
});

test("a sentence carrying both still yields the honest half", () => {
  const hits = extract.fromQuestion("我不知道你在说什么，但 Zink 我确实不知道");
  const topics = hits.map((h) => h.topic);
  assert.ok(topics.includes("Zink"), `expected Zink in ${JSON.stringify(topics)}`);
  assert.ok(!topics.some((t) => t.includes("你在说什么")));
});

test("short search queries are refused as too ambiguous", () => {
  assert.equal(extract.fromSearch({ params: { query: "天气" } }).length, 0);
  assert.equal(extract.fromSearch({ params: { query: " 水稻 面积 下降" } }).length, 1);
});

test("browse picks latin terms and ignores urls", () => {
  const hits = extract.fromBrowse({ text: "这期讲 Turnip 和 Zink，https://x.com/a" });
  const topics = hits.map((h) => h.topic);
  assert.ok(topics.includes("Turnip"));
  assert.ok(!topics.some((t) => t.includes("https")));
});

test("browse respects already-known terms", () => {
  const hits = extract.fromBrowse({ text: "Turnip 和 Zink", known: ["turnip"] });
  assert.deepEqual(hits.map((h) => h.topic), ["Zink"]);
});

test("browse caps at two per scroll", () => {
  const hits = extract.fromBrowse({ text: "Alpha Beta Gamma Delta Epsilon" });
  assert.equal(hits.length, 2);
});

// ── end to end ───────────────────────────────────────────────────────

test("extraction feeds the store and produces an injection-ready pick", () => {
  const ws = freshWs();
  for (const h of extract.fromRecall({ params: { query: "某种作物" }, result: recallEmpty("某种作物") })) {
    curiosity.note(ws, h.topic, { source: "recall", domain: h.domain });
  }
  const pick = curiosity.propose(ws)[0];
  assert.ok(pick);
  assert.equal(pick.display, "某种作物");
  assert.ok(pick.urgency > 0 && pick.urgency <= 1);
  assert.ok(pick.sources.includes("recall"));
});
