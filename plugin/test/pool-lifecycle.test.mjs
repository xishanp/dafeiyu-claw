import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as curiosity from "../lib/curiosity.js";
import * as experience from "../lib/experience.js";

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pool-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

function writeCuriosity(ws, noticings, stats = {}) {
  fs.writeFileSync(
    path.join(ws, "state", "curiosity.json"),
    JSON.stringify({
      version: 2,
      noticings,
      stats: { noticed: noticings.length, resurfaced: 0, wanted: 0, faded: 0, ...stats },
      updated_at: iso(0),
    }),
  );
}
const readCuriosity = (ws) =>
  JSON.parse(fs.readFileSync(path.join(ws, "state", "curiosity.json"), "utf8"));

const noticing = (over = {}) => ({
  id: "n-x",
  topic: "flash",
  display: "flash",
  seen: 1,
  moved: 0,
  reasons: [],
  first_seen_at: iso(0),
  last_seen_at: iso(0),
  status: "open",
  want_id: null,
  kind: "name",
  weight: null,
  ...over,
});

// ---- 池子不积压 -----------------------------------------------------------

test("pool: 过了新鲜期还够不到门槛的名字会沉淀，不是一直挂着", () => {
  const ws = tmp();
  writeCuriosity(ws, [noticing({ last_seen_at: iso(8), first_seen_at: iso(8) })]);
  const out = curiosity.propose(ws, { minPull: 0.55 });
  assert.equal(out.length, 0, "够不到门槛就不该浮现");
  assert.equal(readCuriosity(ws).noticings[0].status, "faded", "该沉淀");
});

test("pool: 新鲜的没够到门槛也不沉淀，还要给它机会", () => {
  const ws = tmp();
  writeCuriosity(ws, [noticing()]);
  curiosity.propose(ws, { minPull: 0.55 });
  assert.equal(readCuriosity(ws).noticings[0].status, "open", "不许提前退掉");
});

test("pool: 沉淀会记进 faded 统计", () => {
  const ws = tmp();
  writeCuriosity(ws, [noticing({ last_seen_at: iso(9), first_seen_at: iso(9) })]);
  const before = readCuriosity(ws).stats.faded;
  curiosity.propose(ws, { minPull: 0.55 });
  assert.equal(readCuriosity(ws).stats.faded, before + 1);
});

test("pool: 沉淀不动已经被转成 want 的", () => {
  const ws = tmp();
  writeCuriosity(ws, [
    noticing({ id: "n-w", want_id: "w-1", last_seen_at: iso(9), first_seen_at: iso(9) }),
  ]);
  curiosity.propose(ws, { minPull: 0.55 });
  assert.equal(readCuriosity(ws).noticings[0].status, "open", "已经想要的不能被清掉");
});

// ---- 经验池老化 -----------------------------------------------------------

function writePool(ws, entries) {
  fs.writeFileSync(
    path.join(ws, "state", "experience-pool.json"),
    JSON.stringify({ version: 1, entries, last_reflected_at: null }),
  );
}
const readPool = (ws) =>
  JSON.parse(fs.readFileSync(path.join(ws, "state", "experience-pool.json"), "utf8")).entries;

test("pool: 经验池pending 过期的会退掉，最新的受保护", () => {
  const ws = tmp();
  writePool(ws, [
    { id: "o1", at: iso(6), what: "六天前", status: "pending" },
    { id: "o2", at: iso(5), what: "五天前", status: "pending" },
    { id: "o3", at: iso(4), what: "四天前", status: "pending" },
    { id: "n1", at: iso(0.2), what: "今天", status: "pending" },
    { id: "n2", at: iso(0.1), what: "今天", status: "pending" },
    { id: "n3", at: iso(0.05), what: "今天", status: "pending" },
  ]);
  const n = experience.ageOut(ws);
  const after = readPool(ws);
  assert.equal(n, 3, "三条过期的都该退");
  assert.ok(after.filter((e) => e.id.startsWith("o")).every((e) => e.status === "dropped"));
  assert.ok(after.filter((e) => e.id.startsWith("n")).every((e) => e.status === "pending"));
});

test("pool: 老化留一笔说明，不是无声无息消失", () => {
  const ws = tmp();
  writePool(ws, [
    { id: "o1", at: iso(6), what: "六天前", status: "pending" },
    { id: "n1", at: iso(0.1), what: "今天", status: "pending" },
    { id: "n2", at: iso(0.1), what: "今天", status: "pending" },
    { id: "n3", at: iso(0.1), what: "今天", status: "pending" },
  ]);
  experience.ageOut(ws);
  const gone = readPool(ws).find((e) => e.id === "o1");
  assert.equal(gone.status, "dropped");
  assert.match(String(gone.resolve_note), /没回头看/);
  assert.equal(gone.aged_out, true);
});

test("pool: 池子里的都是新的就一条都不动", () => {
  const ws = tmp();
  writePool(ws, [
    { id: "n1", at: iso(0.1), what: "a", status: "pending" },
    { id: "n2", at: iso(0.1), what: "b", status: "pending" },
  ]);
  assert.equal(experience.ageOut(ws), 0);
});

test("pool: 已经定性过的不会被老化碰到", () => {
  const ws = tmp();
  writePool(ws, [
    { id: "k1", at: iso(30), what: "很久前留下", status: "kept" },
    { id: "d1", at: iso(30), what: "很久前丢掉", status: "dropped" },
    { id: "n1", at: iso(0.1), what: "今天", status: "pending" },
    { id: "n2", at: iso(0.1), what: "今天", status: "pending" },
    { id: "n3", at: iso(0.1), what: "今天", status: "pending" },
  ]);
  experience.ageOut(ws);
  const after = readPool(ws);
  assert.equal(after.find((e) => e.id === "k1").status, "kept");
  assert.equal(after.find((e) => e.id === "d1").status, "dropped");
  assert.ok(!after.find((e) => e.id === "k1").aged_out, "kept 不该打老化标记");
});

// ---- 快照读得到真字段 -----------------------------------------------------

test("snapshot: 悬着的话题能从真实文件结构里读出来", async () => {
  const { observe } = await import("../lib/cognition.js");
  const ws = tmp();
  fs.writeFileSync(
    path.join(ws, "state", "topics.json"),
    JSON.stringify({
      version: 1,
      open_topics: [
        { key: "k1", label: "一件没结论的事", last_at: iso(2), mentions: 1 },
        { key: "k2", label: "另一件", last_at: iso(1), mentions: 1 },
      ],
      closed: [],
    }),
  );
  const s = observe(ws);
  assert.equal(s.topics.length, 2, "读到 0 条说明又读错键名了");
  assert.equal(s.topics[0].label, "一件没结论的事");
});
