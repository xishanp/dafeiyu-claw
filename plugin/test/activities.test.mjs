import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as activities from "../lib/activities.js";

// ---------------------------------------------------------------------------
// scroll must be an act, not a sentence. Measured 2026-11-06: the diary said
// "刷到…" 46 times while state/douyin.json had 30 videos and had stopped
// growing after 11-04. A counter satisfied by describing the act is a counter
// of descriptions.

test("日记里说刷到了，不算真的刷过", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "act-scroll-"));
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(ws, "memory", `${day}.md`),
    ["- 本鱼: 刷到一条讲唐代烽火台的", "- 本鱼: 刷到个视频，热消笔在稻田照片上画画"].join("\n"),
  );

  const data = activities.scan(ws);
  assert.equal(data.kinds.scroll.exposure, 2, "说过两次，exposure 是 2");
  assert.equal(data.kinds.scroll.done, 0, "但一次都没真打开，done 必须是 0");
});

test("有真实观看记录才算刷过，按天计不按条计", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "act-scroll-"));
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "state", "douyin.json"),
    JSON.stringify({
      version: 1,
      videos: {
        a: { watchedAt: "2026-11-04T01:00:00.000Z", title: "一" },
        b: { watchedAt: "2026-11-04T02:00:00.000Z", title: "二" },
        c: { watchedAt: "2026-11-04T03:00:00.000Z", title: "三" },
        d: { watchedAt: "2026-11-05T01:00:00.000Z", title: "四" },
      },
    }),
  );

  const data = activities.creditScroll(ws);
  assert.equal(data.kinds.scroll.done, 2, "两个晚上看了四条，是两次出门，不是四条");
  assert.equal(data.kinds.scroll.last_at, "2026-11-05");
});

test("creditScroll 是幂等的，跑两次不会翻倍", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "act-scroll-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "state", "douyin.json"),
    JSON.stringify({
      version: 1,
      videos: { a: { watchedAt: "2026-11-04T01:00:00.000Z" } },
    }),
  );
  activities.creditScroll(ws);
  const twice = activities.creditScroll(ws);
  assert.equal(twice.kinds.scroll.done, 1);
});

test("scan 会把 done 清零，所以必须先 scan 再 credit", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "act-scroll-"));
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "state", "douyin.json"),
    JSON.stringify({ version: 1, videos: { a: { watchedAt: "2026-11-04T01:00:00.000Z" } } }),
  );
  const afterScan = activities.scan(ws);
  assert.equal(afterScan.kinds.scroll.done, 0, "scan 后是 0");
  const afterCredit = activities.creditScroll(ws);
  assert.equal(afterCredit.kinds.scroll.done, 1, "credit 后是 1");
});


