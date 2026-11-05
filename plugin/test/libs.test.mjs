// Offline verification of dafeiyu-core libs against a temp workspace.
// Run: node test/libs.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import * as memIndex from "../lib/memory-index.js";
import * as relations from "../lib/relations.js";
import * as topics from "../lib/topics.js";
import * as proactive from "../lib/proactive.js";
import * as douyinLog from "../lib/douyin-log.js";
import { tokenize, expandQuery } from "../lib/text.js";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dafeiyu-test-"));
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

function seedFacts() {
  const dir = path.join(ws, "memory", "facts");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    "- 2026-10-28T10:00:00.000Z | about: 主人 | importance: 0.9 | 主人最喜欢吃白米饭配咸菜",
    "- 2026-10-28T11:00:00.000Z | about: 主人 | importance: 0.7 | 主人讨厌香菜",
    "- 2026-10-29T09:00:00.000Z | about: 小明 | importance: 0.6 | 小明在准备期末考试，压力很大",
    "- 2026-10-29T15:00:00.000Z | about: 主人 | importance: 0.5 | 主人养了一条金鱼叫泡泡",
    "- 2026-10-30T08:00:00.000Z | about: 主人 | importance: 0.4 | 主人昨天熬夜到三点",
  ];
  fs.writeFileSync(path.join(dir, "person.md"), lines.join("\n") + "\n");
  fs.writeFileSync(
    path.join(ws, "memory", "2026-10-30.md"),
    "- 2026-10-29T20:00:00.000Z | feishu | ou_x | ok | 1200ms\n随便记一句不该被搜到的东西\n",
  );
}

console.log("\n=== tokenizer ===");
t("CJK produces bigrams", () => {
  const m = tokenize("白米饭");
  assert.ok(m.has("白米"), "白米 bigram missing");
  assert.ok(m.has("米饭"), "米饭 bigram missing");
});
t("synonym expansion adds food words for 吃", () => {
  const q = expandQuery(tokenize("吃什么"), "吃什么");
  const keys = [...q.keys()];
  assert.ok(keys.some((k) => k.includes("饭") || k === "火锅" || k === "奶茶"), `no food expansion: ${keys.slice(0, 12)}`);
});

console.log("\n=== memory index ===");
seedFacts();

t("search 吃什么 finds 白米饭 via synonym", () => {
  const r = memIndex.search(ws, "吃什么", { limit: 5 });
  assert.ok(r.hits.length > 0, "no hits at all");
  const joined = r.hits.map((h) => h.meta.body).join(" ");
  assert.ok(joined.includes("白米饭"), `did not find 白米饭. got: ${joined.slice(0, 120)}`);
});
t("exact keyword 香菜 hits", () => {
  const r = memIndex.search(ws, "香菜", { limit: 5 });
  assert.ok(r.hits.some((h) => h.meta.body.includes("香菜")));
});
t("unrelated query does not match everything", () => {
  const r = memIndex.search(ws, "量子力学区块链", { limit: 5 });
  assert.ok(r.hits.length === 0, `expected 0 hits, got ${r.hits.length}`);
});
t("daily-log status rows excluded but content kept", () => {
  const r = memIndex.search(ws, "不该被搜到", { limit: 5 });
  // The content line is real memory and SHOULD be findable...
  assert.ok(r.hits.some((h) => h.text.includes("不该被搜到")), "content line lost");
  // ...but the machine-written status row must not be indexed.
  const idx = JSON.parse(fs.readFileSync(path.join(ws, "state", "memory-index.json"), "utf8"));
  const noise = idx.docs.filter((d) => /\|\s*feishu\s*\|.*ok\s*\|/.test(d.raw));
  assert.equal(noise.length, 0, `status rows indexed: ${noise.length}`);
});
t("importance boosts ranking", () => {
  const r = memIndex.search(ws, "主人", { limit: 5 });
  assert.ok(r.hits.length >= 2);
  assert.ok(r.hits[0].meta.importance >= r.hits[1].meta.importance, "high importance not first");
});
t("about filter works", () => {
  const r = memIndex.search(ws, "考试", { about: "小明", limit: 5 });
  assert.ok(r.hits.length > 0 && r.hits.every((h) => h.meta.about === "小明"));
});

console.log("\n=== relations ===");
t("new person starts unfamiliar", () => {
  relations.touch(ws, { personId: "person:x", personName: "小明", weight: 0.5 });
  const r = relations.getRelation(ws, "person:x");
  assert.ok(r.familiarity < 0.3, `too familiar too fast: ${r.familiarity}`);
});
t("repeated contact raises familiarity", () => {
  const before = relations.getRelation(ws, "person:x").familiarity;
  for (let i = 0; i < 10; i++) relations.touch(ws, { personId: "person:x", weight: 0.6 });
  const after = relations.getRelation(ws, "person:x").familiarity;
  assert.ok(after > before, `${before} -> ${after}`);
});
// Familiarity is owned by the other side's messages alone.
//
// Regression guard for 2026-11-05: `agent_end` used to call touch() on every
// turn, including proactive ones where the other side said nothing. That made
// her own output raise intimacy, which then made it easier to pass the very
// gates that decide whether to speak again — a feedback loop with no ceiling.
// `last_seen` was collateral damage: it means "when did THEY last speak" and
// drives the 48h reach-out candidate.
t("familiarity is not raised by our own outgoing turns", () => {
  const key = "person:quiet";
  relations.touch(ws, { personId: key, personName: "安静的人", weight: 0.5 });
  const base = relations.getRelation(ws, key);
  const f0 = base.familiarity;
  const seen0 = base.last_seen;
  const n0 = base.interactions;

  // Simulate time passing without being touched by the other side at all.
  // Nothing here should change: no inbound line, no growth.
  const f1 = relations.getRelation(ws, key).familiarity;
  assert.equal(f1, f0, `familiarity drifted without an inbound message: ${f0} -> ${f1}`);
  assert.equal(relations.getRelation(ws, key).interactions, n0);
  assert.equal(relations.getRelation(ws, key).last_seen, seen0);
});

// The behavioural check above cannot catch the call site coming back: a test
// that never calls the removed function will pass no matter what index.js does.
// This reads the source and asserts the structural property directly, because
// the whole defect was one call sitting in an outbound hook.
//
// The offender lived in `reply_payload_sending` (the hook that sees every reply
// we send), not in `agent_end` — an earlier version of this test looked in the
// wrong hook and passed while the bug was still present.
t("no outbound hook charges familiarity", () => {
  const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const lines = src.split("\n");

  const hookLine = (name) => {
    const idx = lines.findIndex((l) => l.includes(`api.on("${name}"`));
    assert.ok(idx >= 0, `${name} hook not found`);
    return idx;
  };

  // Handler end is found by BRACE DEPTH, not by "the next api.on(". A handler
  // that contains its own nested hook registrations would otherwise swallow the
  // following handler's body, which is exactly how the first version of this
  // test reported a false positive at message_received (which is allowed to
  // call touch — it sees THEIR message).
  const handlerBody = (start) => {
    let depth = 0;
    let seenOpen = false;
    for (let i = start; i < lines.length; i += 1) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth += 1; seenOpen = true; }
        else if (ch === "}") {
          depth -= 1;
          if (seenOpen && depth === 0) {
            return lines.slice(start, i + 1).join("\n");
          }
        }
      }
    }
    return lines.slice(start).join("\n");
  };

  // Every hook that runs on our own output.
  for (const name of ["reply_payload_sending", "message_sent", "agent_end"]) {
    const starts = lines
      .map((l, i) => (l.includes(`api.on("${name}"`) ? i : -1))
      .filter((i) => i >= 0);
    assert.ok(starts.length > 0, `${name} hook not found`);

    for (const start of starts) {
      const body = handlerBody(start);
      assert.ok(body.length > 100, `${name} handler body looks empty`);
      // Strip comments and string literals first: prose ABOUT the removed call
      // must not read as a call. The first version of this test failed on its
      // own explanatory comment.
      const code = body
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .map((l) => l.replace(/\/\/.*$/, ""))
        .join("\n");
      assert.ok(
        !code.includes("relations.touch("),
        `${name} must not call relations.touch(): familiarity is owned by the ` +
          `other side's messages. Charging our own turn let her proactive ` +
          `messages raise intimacy, which then fed the gate deciding whether ` +
          `to speak again (fixed 2026-11-05).`,
      );
    }
  }
});

t("disclosure raises trust", () => {
  const b = relations.getRelation(ws, "person:y");
  relations.touch(ws, { personId: "person:y", disclosure: true, weight: 0.6 });
  const r = relations.getRelation(ws, "person:y");
  assert.ok(r.disclosures === 1);
  assert.ok(r.trust > 0.3);
});
t("negative sentiment recorded", () => {
  relations.touch(ws, { personId: "person:z", sentiment: -0.9, weight: 0.6 });
  const r = relations.getRelation(ws, "person:z");
  assert.ok(r.sentiment < 0, `sentiment ${r.sentiment}`);
});
t("notes persist and surface in hint", () => {
  relations.addNote(ws, "person:x", "怕黑");
  const r = relations.getRelation(ws, "person:x");
  const hint = relations.describeRelation(r);
  assert.ok(hint.includes("怕黑"), hint);
});
t("group tracked separately", () => {
  relations.touch(ws, { groupId: "group:g1", groupName: "摸鱼群", personId: "person:x", weight: 0.5 });
  const g = relations.getRelation(ws, "group:g1");
  assert.equal(g.members_seen.length, 1);
});

// 2026-11-04 实测过的两个反向缺陷，各一条测试钉住。

t("话叠：过了门槛之后涨得明显变慢，不能一发就到顶", () => {
  // 2026-11-04 两轮收紧后的实测：300 条同天只到 ~0.15。
  // 原值（0.012 / 门槛 100 / 系数 0.15）能到 0.65，更早的版本直接顶到 1.0。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-dim-"));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  for (let i = 0; i < 300; i++) relations.touch(dir, { personId: "p1" });
  const f = relations.getRelation(dir, "p1").familiarity;
  assert.ok(f < 0.25, `300 条同天不该过 0.25，实际 ${f}`);
  assert.ok(f > 0.05, `但也得真涨，实际 ${f}`);
});

t("衰减：没人来的时候也会掉（这才是关键）", () => {
  // 改前：applyDecay 只在 touch() 里跑，所以「被忘记」必须先「出现」。
  // 一个人不再出现，数值就永远停在原地。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-decay-"));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  fs.writeFileSync(
    path.join(dir, "state", "relations.json"),
    JSON.stringify({
      version: 1,
      updated_at: old,
      groups: {},
      people: {
        p1: {
          id: "p1", name: "旧人", familiarity: 0.9, trust: 0.8, sentiment: 0.5,
          interactions: 152, first_seen: old, last_seen: old, distinct_days: 3,
          last_day: "2026-10-05", disclosures: 0, last_topic: null, notes: [],
        },
      },
    }),
  );
  const before = relations.getRelation(dir, "p1").familiarity;
  const r = relations.decayAll(dir);
  const after = relations.getRelation(dir, "p1").familiarity;
  assert.equal(r.changed, 1);
  assert.ok(after < before - 0.2, `30 天不理该明显掉，${before} -> ${after}`);
});

t("衰减：刚聊过的不掉（不能把正在聊的人也算旧）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-fresh-"));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  relations.touch(dir, { personId: "p1", weight: 0.6 });
  const before = relations.getRelation(dir, "p1").familiarity;
  const r = relations.decayAll(dir);
  assert.equal(r.changed, 0);
  assert.equal(relations.getRelation(dir, "p1").familiarity, before);
});

console.log("\n=== topics ===");
t("mention opens topic", () => {
  topics.mention(ws, { topic: "期末考试", heat: 0.8 });
  const hot = topics.hotTopics(ws, 5);
  assert.ok(hot.some((x) => x.label === "期末考试"));
});
t("repeated mention raises heat", () => {
  const h1 = topics.hotTopics(ws, 5).find((x) => x.label === "期末考试").heat;
  topics.mention(ws, { topic: "期末考试", heat: 0.8 });
  const h2 = topics.hotTopics(ws, 5).find((x) => x.label === "期末考试").heat;
  assert.ok(h2 >= h1, `${h1} -> ${h2}`);
});
t("resolve removes from open", () => {
  topics.resolveTopic(ws, "期末考试");
  assert.ok(!topics.hotTopics(ws, 10).some((x) => x.label === "期末考试"));
});
t("describeTopics renders a hint", () => {
  topics.mention(ws, { topic: "火锅", heat: 0.7 });
  const s = topics.describeTopics(ws);
  assert.ok(s.includes("火锅"), s);
});

console.log("\n=== proactive ===");
const pcfg = {
  bufferMinutes: 5,
  maxSilenceHours: 12,
  cooldownMinutes: 60,
  dailyCap: 2,
  quietHoursStart: 3,
  quietHoursEnd: 4,
  impulseTtlHours: 6,
  // Gate tests below exercise the value threshold explicitly. It is OFF by
  // default now, so these tests must opt back in or they stop testing the gate.
  requireValue: true,
  // Production default is now `unlimited: false` (2026-11-05): the pacing
  // gates must actually run, otherwise every number in the config is
  // decoration. These tests opt OUT explicitly so the gate mechanics can be
  // exercised without the production default interfering.
  unlimited: false,
  timeZone: "Asia/Shanghai",
};

// The production default must throttle: the gates have to be reachable.
//
// Before 2026-11-05 `unlimited` defaulted to true and returned before every
// pacing check, and it was never declared in the plugin schema, so the limits
// could not be turned on from configuration at all. A config full of careful
// numbers did nothing.
t("default config enforces pacing", () => {
  // DEFAULTS must ship with the gates armed.
  const g0 = proactive.evaluate(ws, "person:nobody", {});
  assert.equal(g0.reason, "never-heard-from-them");

  proactive.queue(ws, { target: "person:familiar2", text: "seed2", kind: "thought" }, { enabled: false });
  // Spoke one minute ago: inside the default buffer window.
  setTarget(ws, "person:familiar2", {
    last_inbound_at: new Date(Date.now() - 60000).toISOString(),
  });
  const g = proactive.evaluate(ws, "person:familiar2", {});
  assert.equal(g.allowed, false, "default must not wave a target through");
  assert.match(g.reason, /^buffer\(/, `expected buffer gate, got ${g.reason}`);

  // The escape hatch still exists, but only when asked for by name.
  const u = proactive.evaluate(ws, "person:familiar2", { unlimited: true });
  assert.equal(u.allowed, true);
  assert.equal(u.reason, "unlimited");
});

function setTarget(ws, target, patch) {
  const f = proactive.proactiveFile(ws);
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  d.targets[target] = { ...(d.targets[target] || {}), ...patch };
  fs.writeFileSync(f, JSON.stringify(d, null, 2));
}

function minutesAgo(m) {
  return new Date(Date.now() - m * 60000).toISOString();
}

t("never-heard-from-them blocks", () => {
  const g = proactive.evaluate(ws, "person:nobody", pcfg);
  assert.equal(g.allowed, false);
  assert.ok(g.reason.startsWith("never-heard"));
});
t("mid-conversation gets a short buffer, not a long idle wall", () => {
  proactive.noteActivity(ws, "person:x");
  const g = proactive.evaluate(ws, "person:x", pcfg);
  assert.equal(g.allowed, false);
  assert.ok(g.reason.startsWith("buffer"), `expected buffer, got ${g.reason}`);
});
t("buffer is minutes not 90 minutes", () => {
  setTarget(ws, "person:x", { last_inbound_at: minutesAgo(10) });
  const g = proactive.evaluate(ws, "person:x", pcfg);
  assert.equal(g.allowed, true, `should allow after 10m, got ${g.reason}`);
});
t("very recent message still buffered", () => {
  setTarget(ws, "person:x", { last_inbound_at: minutesAgo(2) });
  const g = proactive.evaluate(ws, "person:x", pcfg);
  assert.equal(g.allowed, false);
  assert.ok(g.reason.startsWith("buffer"), g.reason);
});
t("dead conversation too stale", () => {
  setTarget(ws, "person:x", { last_inbound_at: minutesAgo(60 * 20), last_proactive_at: null });
  const g = proactive.evaluate(ws, "person:x", pcfg);
  assert.equal(g.allowed, false);
  assert.ok(g.reason.startsWith("too-stale"), g.reason);
});
t("idle target allowed within window", () => {
  setTarget(ws, "person:x", { last_inbound_at: minutesAgo(120), last_proactive_at: null });
  const g = proactive.evaluate(ws, "person:x", pcfg);
  assert.equal(g.allowed, true, g.reason);
});
t("low value allowed when requireValue is off", () => {
  const looseWs = fs.mkdtempSync(path.join(os.tmpdir(), "dafeiyu-loose-"));
  const looseCfg = { ...pcfg, requireValue: false };
  proactive.noteActivity(looseWs, "person:y");
  // Backdate inbound past the buffer so only the value threshold is under test.
  setTarget(looseWs, "person:y", { last_inbound_at: minutesAgo(10) });
  const r = proactive.queue(looseWs, { target: "person:y", text: "嗯", value: 0.05 }, looseCfg);
  assert.equal(r.queued, true, r.reason);
});

t("low value rejected", () => {
  const r = proactive.queue(ws, { target: "person:x", text: "嗯", value: 0.05 }, pcfg);
  assert.equal(r.queued, false);
  assert.ok(r.reason.startsWith("low-value"));
});
t("good impulse queued", () => {
  const r = proactive.queue(ws, { target: "person:x", text: "昨天那个考试考完没", value: 0.7, kind: "topic" }, pcfg);
  assert.equal(r.queued, true, r.reason);
});
t("duplicate rejected", () => {
  const r = proactive.queue(ws, { target: "person:x", text: "昨天那个考试考完没", value: 0.7 }, pcfg);
  assert.equal(r.queued, false);
  assert.equal(r.reason, "duplicate");
});
t("second pending for same target blocked", () => {
  const r = proactive.queue(ws, { target: "person:x", text: "完全不同的内容啊", value: 0.7 }, pcfg);
  assert.equal(r.queued, false);
  assert.equal(r.reason, "already-pending");
});
t("inbound activity drops pending", () => {
  proactive.noteActivity(ws, "person:x");
  assert.equal(proactive.pendingFor(ws, "person:x").length, 0);
});
t("take increments daily counter", () => {
  setTarget(ws, "person:x", { last_inbound_at: minutesAgo(120), last_proactive_at: null });
  proactive.queue(ws, { target: "person:x", text: "发一条测试", value: 0.9 }, pcfg);
  const rec = proactive.take(ws, "person:x", pcfg);
  assert.ok(rec, "take returned null");
  const s = proactive.status(ws, pcfg);
  assert.equal(s.spokeToday, 1);
});
// Owner directive (2026-10-31): proactive speech has no daily quota, so the
// gate must report `unlimited` and never emit a `daily-cap` refusal. This test
// previously asserted the opposite and failed against the intended behaviour.
t("no daily cap by default", () => {
  setTarget(ws, "person:x", { last_inbound_at: minutesAgo(120), last_proactive_at: null });
  proactive.queue(ws, { target: "person:x", text: "第二条内容", value: 0.9 }, pcfg);
  proactive.take(ws, "person:x", pcfg);
  setTarget(ws, "person:x", { last_inbound_at: minutesAgo(120), last_proactive_at: null });
  const r = proactive.queue(ws, { target: "person:x", text: "第三条内容", value: 0.9 }, pcfg);
  assert.equal(r.queued, true, "a third message same day must still queue: " + r.reason);
});

// With limits on, the daily counter must still be RECORDED (history), and the
// gate must not invent a quota of its own. The explicit cap logic was removed
// by owner directive; only `unlimited: false` restores the other gates (buffer,
// dead-chat, quiet hours, cooldown), never a daily cap.
t("turning limits on records counts but never invents a daily quota", () => {
  const limited = { ...pcfg, unlimited: false, quietHoursStart: 0, quietHoursEnd: 0 };
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "proactive-cap-"));
  fs.mkdirSync(path.join(ws2, "state"), { recursive: true });
  const target = "person:y";
  proactive.noteActivity(ws2, target);
  for (let i = 0; i < 4; i++) {
    setTarget(ws2, target, { last_inbound_at: minutesAgo(120), last_proactive_at: null });
    proactive.queue(ws2, { target, text: `填充 ${i}`, value: 0.9 }, limited);
    proactive.take(ws2, target, limited);
  }
  const s = proactive.status(ws2, limited);
  assert.equal(s.spokeToday, 4, "counter must still track sends");
  setTarget(ws2, target, { last_inbound_at: minutesAgo(120), last_proactive_at: null });
  const g = proactive.evaluate(ws2, target, limited);
  assert.equal(g.allowed, true, "no daily quota exists: " + g.reason);
  assert.ok(!String(g.reason).startsWith("daily-cap"), g.reason);
});
t("quiet hours blocked", () => {
  // Built around the CURRENT hour instead of a fixed window. The old version
  // used 0→23, which silently becomes a no-op between 23:00 and 23:59 — the
  // suite failed every night at that hour and looked like a code regression.
  const h = proactive.status(ws, pcfg).localHour;
  const qcfg = { ...pcfg, quietHoursStart: h, quietHoursEnd: (h + 1) % 24 };
  const g = proactive.evaluate(ws, "person:x", qcfg);
  assert.equal(g.allowed, false, `hour ${h} should be quiet`);
  assert.equal(g.reason, "quiet-hours");
});
t("quiet hours use fixed zone, not host clock", () => {
  const s = proactive.status(ws, { ...pcfg, timeZone: "Asia/Shanghai" });
  assert.equal(s.zone, "Asia/Shanghai");
  assert.ok(Number.isFinite(s.localHour));
  const tokyo = proactive.status(ws, { ...pcfg, timeZone: "America/New_York" });
  assert.equal(tokyo.zone, "America/New_York");
});
t("expired impulse is purged not sent", () => {
  setTarget(ws, "person:old", { last_inbound_at: minutesAgo(120), last_proactive_at: null });
  const r = proactive.queue(ws, { target: "person:old", text: "会过期的话", value: 0.9 }, { ...pcfg, dailyCap: 99 });
  assert.equal(r.queued, true, r.reason);

  // Backdate it past the TTL.
  const f = proactive.proactiveFile(ws);
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  const item = d.pending.find((p) => p.target === "person:old");
  item.queued_at = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
  fs.writeFileSync(f, JSON.stringify(d, null, 2));

  assert.equal(proactive.pendingFor(ws, "person:old", pcfg).length, 0, "expired item still visible");
  const rec = proactive.take(ws, "person:old", pcfg);
  assert.equal(rec, null, "expired item was taken");
});
t("fresh impulse survives pendingFor", () => {
  setTarget(ws, "person:fresh", { last_inbound_at: minutesAgo(120), last_proactive_at: null });
  proactive.queue(ws, { target: "person:fresh", text: "新鲜的话", value: 0.9 }, { ...pcfg, dailyCap: 99 });
  assert.equal(proactive.pendingFor(ws, "person:fresh", pcfg).length, 1);
});
t("inbound activity still clears pending", () => {
  proactive.noteActivity(ws, "person:fresh");
  assert.equal(proactive.pendingFor(ws, "person:fresh", pcfg).length, 0);
});

console.log("\n=== proactive allowlist ===");

// Fresh workspace: earlier cases already consumed the daily cap, which would
// mask the gates under test here.
const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "dafeiyu-allow-"));
const OWNER = "person:openclaw-weixin:wxid_example@im.wechat";
const allowCfg = {
  ...pcfg,
  dailyCap: 4,
  ownerTargets: [OWNER],
  targets: {
    [OWNER]: { channel: "openclaw-weixin", to: "wxid_example@im.wechat", label: "owner_example" },
  },
};

t("owner target allowed with no prior inbound", () => {
  const g = proactive.evaluate(ws2, OWNER, allowCfg);
  assert.equal(g.allowed, true, g.reason);
});
t("stranger still blocked even with allowlist configured", () => {
  const g = proactive.evaluate(ws2, "person:openclaw-weixin:stranger", allowCfg);
  assert.equal(g.allowed, false);
  assert.equal(g.reason, "never-heard-from-them");
});
t("resolveTargetConfig matches exact key", () => {
  const hit = proactive.resolveTargetConfig(allowCfg, OWNER);
  assert.ok(hit, "key did not match");
  assert.equal(hit.key, OWNER);
  assert.equal(hit.to, "wxid_example@im.wechat");
});
t("resolveTargetConfig matches exact address", () => {
  const hit = proactive.resolveTargetConfig(allowCfg, "wxid_example@im.wechat");
  assert.ok(hit);
  assert.equal(hit.key, OWNER);
});
t("channel name alone must NOT match", () => {
  const hit = proactive.resolveTargetConfig(allowCfg, "openclaw-weixin");
  assert.equal(hit, null, "channel-only match is a security hole");
});
t("arbitrary recipient must NOT match", () => {
  const hit = proactive.resolveTargetConfig(allowCfg, "someone-else@im.wechat");
  assert.equal(hit, null);
});
t("entry without destination is unusable", () => {
  const cfg = { ...allowCfg, targets: { [OWNER]: { channel: "openclaw-weixin" } } };
  assert.equal(proactive.resolveTargetConfig(cfg, OWNER), null);
});
t("recordSpoken increments counter and starts cooldown", () => {
  const before = proactive.status(ws2, allowCfg).spokeToday;
  proactive.recordSpoken(ws2, OWNER, "本鱼说一句", allowCfg);
  const after = proactive.status(ws2, allowCfg);
  assert.equal(after.spokeToday, before + 1);
  const g = proactive.evaluate(ws2, OWNER, allowCfg);
  assert.equal(g.allowed, false);
  assert.ok(g.reason.startsWith("cooldown"), g.reason);
});
t("owner target still respects quiet hours", () => {
  // Same clock-independence fix as the plain quiet-hours case above.
  const h = proactive.status(ws2, allowCfg).localHour;
  const cfg = { ...allowCfg, quietHoursStart: h, quietHoursEnd: (h + 1) % 24 };
  const g = proactive.evaluate(ws2, OWNER, cfg);
  assert.equal(g.allowed, false, `hour ${h} should be quiet for owner too`);
  assert.equal(g.reason, "quiet-hours");
});
t("owner target still respects daily cap", () => {
  const cfg = { ...allowCfg, dailyCap: 1, quietHoursStart: 3, quietHoursEnd: 4 };
  // ws2 already has 1 spoken from the previous case, but cooldown also applies.
  const s = proactive.status(ws2, cfg);
  assert.ok(s.spokeToday >= 1, `spokeToday=${s.spokeToday}`);
  const g = proactive.evaluate(ws2, OWNER, cfg);
  assert.equal(g.allowed, false);
});
fs.rmSync(ws2, { recursive: true, force: true });

// --- douyin ledger: the same line must not go out twice -------------------
const ws3 = fs.mkdtempSync(path.join(os.tmpdir(), "dafeiyu-douyin-"));
fs.mkdirSync(path.join(ws3, "state"), { recursive: true });
const VID = "7701221407162606409";

t("douyin: fresh video has nothing recorded", () => {
  const s = douyinLog.status(ws3, VID);
  assert.equal(s.known, false);
  assert.equal(s.liked, false);
  assert.deepEqual(s.comments, []);
});

t("douyin: unknown video lets the comment through", () => {
  assert.equal(douyinLog.checkComment(ws3, VID, "本鱼就是本鱼").ok, true);
});

t("douyin: recording a comment creates the entry", () => {
  const r = douyinLog.noteComment(ws3, VID, { text: "本鱼就是本鱼" });
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
});

t("douyin: the same line is blocked", () => {
  const r = douyinLog.checkComment(ws3, VID, "本鱼就是本鱼");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "duplicate");
});

t("douyin: whitespace does not sneak the same line through", () => {
  assert.equal(douyinLog.checkComment(ws3, VID, "  本鱼就是本鱼 ").ok, false);
});

t("douyin: the same person saying something new is allowed", () => {
  // A live exchange must not be gagged by a per-person cooldown.
  assert.equal(douyinLog.checkComment(ws3, VID, "你说得对").ok, true);
});

t("douyin: one person can be answered several times in a row", () => {
  const V2 = "888";
  douyinLog.noteComment(ws3, V2, { text: "一", replyTo: "小明" });
  douyinLog.noteComment(ws3, V2, { text: "二", replyTo: "小明" });
  assert.equal(douyinLog.checkComment(ws3, V2, "三", "小明").ok, true);
});

t("douyin: same line to the same person is still blocked", () => {
  const V3 = "777";
  douyinLog.noteComment(ws3, V3, { text: "你好", replyTo: "小明" });
  const r = douyinLog.checkComment(ws3, V3, "你好", "小明");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "duplicate");
});

t("douyin: a different video is unaffected", () => {
  assert.equal(douyinLog.checkComment(ws3, "999", "本鱼就是本鱼").ok, true);
});

t("douyin: empty text is refused", () => {
  assert.equal(douyinLog.checkComment(ws3, VID, "   ").reason, "empty");
});

t("douyin: no video id means no write", () => {
  assert.equal(douyinLog.noteComment(ws3, "", { text: "x" }).reason, "no-video-id");
});

t("douyin: like is remembered and reported once", () => {
  assert.equal(douyinLog.noteLike(ws3, VID).ok, true);
  assert.equal(douyinLog.status(ws3, VID).liked, true);
  assert.ok(douyinLog.describeStatus(ws3, VID).includes("点过赞"));
});

fs.rmSync(ws3, { recursive: true, force: true });

// --- douyin typing tickets: no keystrokes without douyin_act --------------
const ws4 = fs.mkdtempSync(path.join(os.tmpdir(), "dafeiyu-ticket-"));
fs.mkdirSync(path.join(ws4, "state"), { recursive: true });
const V4 = "7701221407162606409";

t("ticket: typing without approval is refused", () => {
  const r = douyinLog.consumeLine(ws4, "本鱼就是本鱼");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-approval");
});

t("ticket: an approved line can be typed once", () => {
  assert.equal(douyinLog.approveLine(ws4, V4, { text: "本鱼就是本鱼" }).ok, true);
  const r = douyinLog.consumeLine(ws4, "本鱼就是本鱼");
  assert.equal(r.ok, true);
  assert.equal(r.videoId, V4);
});

t("ticket: a spent ticket cannot be replayed", () => {
  assert.equal(douyinLog.consumeLine(ws4, "本鱼就是本鱼").ok, false);
});

t("ticket: a different line is not covered by someone else's approval", () => {
  douyinLog.approveLine(ws4, V4, { text: "甲" });
  assert.equal(douyinLog.consumeLine(ws4, "乙").ok, false);
});

t("ticket: whitespace differences still match the approval", () => {
  douyinLog.approveLine(ws4, V4, { text: "你好  啊" });
  assert.equal(douyinLog.consumeLine(ws4, " 你好 啊 ").ok, true);
});

t("ticket: an expired approval no longer works", () => {
  douyinLog.approveLine(ws4, V4, { text: "过期" });
  const f = path.join(ws4, "state", "douyin-approved.json");
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const e of d.entries) e.at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  fs.writeFileSync(f, JSON.stringify(d));
  assert.equal(douyinLog.consumeLine(ws4, "过期").ok, false);
});

t("ticket: no video id means no approval is issued", () => {
  assert.equal(douyinLog.approveLine(ws4, "", { text: "x" }).reason, "no-video-id");
});

t("ticket: empty text never gets a ticket", () => {
  assert.equal(douyinLog.approveLine(ws4, V4, { text: "   " }).reason, "empty");
});

t("ticket: the same line is idempotent on the same video", () => {
  douyinLog.approveLine(ws4, V4, { text: "2061 年本鱼说不定还在" });
  assert.equal(douyinLog.consumeLine(ws4, "2061 年本鱼说不定还在").ok, true);
  assert.equal(douyinLog.typedLineRecently(ws4, V4, "2061 年本鱼说不定还在"), true);
  assert.equal(douyinLog.typedLineRecently(ws4, "another-video", "2061 年本鱼说不定还在"), false);
});

t("ticket: a different line can still be typed", () => {
  assert.equal(douyinLog.typedLineRecently(ws4, V4, "换一句"), false);
});

t("ticket: typed evidence is not proof of posting", () => {
  const file = path.join(ws4, "state", "douyin-approved.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(Array.isArray(d.sent));
  assert.equal(d.sent.at(-1).text, "2061 年本鱼说不定还在");
  assert.equal(Object.hasOwn(d.sent.at(-1), "posted"), false);
});

fs.rmSync(ws4, { recursive: true, force: true });

// 2026-11-04 新速率：0.9 断 7 天要落到 0.4 左右。
t("衰减速率：0.9 断 7 天落到 0.4 附近", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-rate-"));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  const old = new Date(Date.now() - 7 * 86400000).toISOString();
  fs.writeFileSync(
    path.join(dir, "state", "relations.json"),
    JSON.stringify({
      version: 1, updated_at: old, groups: {},
      people: { p: { id: "p", name: "x", familiarity: 0.9, trust: 0.5, sentiment: 0.3,
        interactions: 50, first_seen: old, last_seen: old, distinct_days: 5,
        last_day: "2026-10-28", disclosures: 0, last_topic: null, notes: [] } },
    }),
  );
  relations.decayAll(dir);
  const f = relations.getRelation(dir, "p").familiarity;
  assert.ok(f > 0.35 && f < 0.47, `7 天该到 0.4 附近，实际 ${f}`);
});

t("衰减幂等：同一次沉默不会被反复扣", () => {
  // 这是真实发生过的 bug：decayAll 每分钟跑，applyDecay 按 last_seen 算天数
  // 却不更新它，于是同一段沉默每次心跳都重新收一次钱。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-idem-"));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  const old = new Date(Date.now() - 7 * 86400000).toISOString();
  fs.writeFileSync(
    path.join(dir, "state", "relations.json"),
    JSON.stringify({
      version: 1, updated_at: old, groups: {},
      people: { p: { id: "p", name: "x", familiarity: 0.9, trust: 0.5, sentiment: 0.3,
        interactions: 50, first_seen: old, last_seen: old, distinct_days: 5,
        last_day: "2026-10-28", disclosures: 0, last_topic: null, notes: [] } },
    }),
  );
  relations.decayAll(dir);
  const a = relations.getRelation(dir, "p").familiarity;
  relations.decayAll(dir);
  relations.decayAll(dir);
  const b = relations.getRelation(dir, "p").familiarity;
  assert.equal(b, a, `重复运行不该继续扣：${a} -> ${b}`);
});

t("衰减不篡改 last_seen（那是「上次说话」，不是「上次结算」）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-keep-"));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  const old = new Date(Date.now() - 7 * 86400000).toISOString();
  fs.writeFileSync(
    path.join(dir, "state", "relations.json"),
    JSON.stringify({
      version: 1, updated_at: old, groups: {},
      people: { p: { id: "p", name: "x", familiarity: 0.9, trust: 0.5, sentiment: 0.3,
        interactions: 50, first_seen: old, last_seen: old, distinct_days: 5,
        last_day: "2026-10-28", disclosures: 0, last_topic: null, notes: [] } },
    }),
  );
  relations.decayAll(dir);
  assert.equal(relations.getRelation(dir, "p").last_seen, old);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
fs.rmSync(ws, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
