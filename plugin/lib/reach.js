// 缺东西怎么开口 —— 这一段以前只写文件，谁也不知道。
//
// 问题
// ----
// `need_help` 原来把请求写进 `state/capability-requests.json`，然后回一句
// 「记下了，会有人看」。实测 2026-11-07：**那个文件从来没有存在过**。
//
// 两个原因叠在一起：
//   1. 她一次都没调用过 —— 因为返回的信息里没有任何承诺会真的被谁看到
//   2. 就算调用了，也真的没人会看 —— 那个文件不在任何投递链路上
//
// 一个只能写进文件的请求，对一个需要开工的人等于没提。
//
// 现在这一段做两件事：写文件（留档），并且真的排进 proactive 队列
// （那条链路已经会把它送到人那里）。两件事分开 try，一个失败不拖累另一个。
//
// 为什么不干脆只排队不写文件：队列有 TTL、会被清、会被去重吞掉。
// 而「我提过这个需求」本身应该留得住，哪怕它还没送到。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as proactive from "./proactive.js";

const FILE = "capability-requests.json";
const MAX_REQUESTS = 100;

function file(workspaceDir) {
  return path.join(workspaceDir, "state", FILE);
}

function load(workspaceDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(workspaceDir), "utf8"));
    if (raw && Array.isArray(raw.requests)) return raw;
  } catch { /* 第一次提 */ }
  return { version: 1, requests: [] };
}

function save(workspaceDir, data) {
  const f = file(workspaceDir);
  const tmp = `${f}.tmp`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/**
 * 把「我做不了这个」变成一件真的能被看到的事。
 *
 * 返回 `{ ok, duplicate, queued, reason, id }`：
 *   ok        文件写进去了（或已存在）
 *   duplicate 同一个请求已经开着，没有重复记
 *   queued    排进了主动队列，会真的发出去
 *   reason    没排出去的原因（`no-target` / `duplicate` / 门禁）
 */
export function request(workspaceDir, { kind, want, blocked } = {}, { proactiveCfg = {}, queue = proactive } = {}) {
  const KINDS = new Set(["tool", "permission", "behavior", "ask"]);
  const k = KINDS.has(kind) ? kind : "tool";
  const w = String(want ?? "").replace(/[\r\n]/g, " ").trim().slice(0, 200);
  const b = String(blocked ?? "").replace(/[\r\n]/g, " ").trim().slice(0, 200);
  if (!w || !b) return { ok: false, reason: "incomplete" };

  // ---- 留档 ----------------------------------------------------------------
  const data = load(workspaceDir);
  const key = `${k}|${w}`;
  const existing = data.requests.find((r) => `${r.kind}|${r.want}` === key && r.state === "open");
  if (existing) {
    // 已经开着就不再记一遍，但仍然试着把它送出去 —— 上次可能没有 target。
    return {
      ok: true,
      duplicate: true,
      id: existing.id,
      ...deliver(workspaceDir, { kind: k, want: w, blocked: b, proactiveCfg, queue }),
    };
  }

  const rec = {
    id: `req_${Date.now().toString(36)}`,
    kind: k,
    want: w,
    blocked: b,
    at: new Date().toISOString(),
    state: "open",
  };
  data.requests.push(rec);
  if (data.requests.length > MAX_REQUESTS) data.requests = data.requests.slice(-MAX_REQUESTS);
  try { save(workspaceDir, data); } catch { /* 写不进也不该拦住发送 */ }

  // `behavior` 额外写一份给主助手看的。
  //
  // 为什么单独走一条：主动队列是「下次开口时说给人听」，而机制类问题
  // 需要**被修**，不是被听见。两者节奏完全不同 —— 前者等下一轮说话，
  // 后者该马上有人去看。
  //
  // 这个文件是 main 的入口。她不给自己修代码的权限（那是红线），
  // 但把问题写成一条记录放这儿，是这条链上唯一能让它真的被处理的方式。
  if (k === "behavior") {
    try {
      const inboxFile = `${proactiveCfg.mainInbox || path.join(os.homedir(), ".openclaw", "workspace", "dafeiyu-reports.json")}`.trim();
      let list = [];
      try { list = JSON.parse(fs.readFileSync(inboxFile, "utf8")); } catch { list = []; }
      if (!Array.isArray(list)) list = [];
      list.push({
        at: new Date().toISOString(),
        id: rec.id,
        blocked: b,
        want: w,
        state: "open",
      });
      fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
      fs.writeFileSync(inboxFile, `${JSON.stringify(list.slice(-50), null, 1)}\n`);
    } catch { /* 写不进报告不该让求助本身失败 */ }
  }

  return { ok: true, duplicate: false, id: rec.id, ...deliver(workspaceDir, { kind: k, want: w, blocked: b, proactiveCfg, queue }) };
}

/** 排进主动队列。没有可以说话的对象时如实返回，不假装成功。 */
function deliver(workspaceDir, { kind, want, blocked, proactiveCfg, queue }) {
  let who = null;
  try {
    who = proactive.lastSpokenKey(workspaceDir);
  } catch { /* 没有 store 就是没有 */ }
  if (!who) return { queued: false, reason: "no-target" };

  // 三种话说的不是同一件事，语气也该不一样。
  //
  // `behavior` 是新增的那一类：她发现某个东西的行为不对，但那不是她缺能力，
  // 也不是权限问题 —— 是机器坏了。这种报告要说清「反复发生」和「我没做错」，
  // 否则读起来像在抱怨。
  // 四种话说的不是同一件事，语气也该不一样。
  //
  // `ask` 是最后加的那一类：她不是缺东西，也不是发现坏了，就是**不懂，想问**。
  // 这一类最难开口——`need_help` 建了很久一次没用过，因为前三种都要先
  // 判定「我缺什么」，而她从小到大的行为模式是自己扛。
  //
  // 所以这一句要写得让「问」这件事没有负担：不铺垫，不道歉，直接问。
  const text =
    kind === "permission"
      ? `用户，有个东西我进不去：${blocked}。想做的${want}，你能不能给个口子？`
      : kind === "behavior"
        ? `用户，有个东西我觉得是坏的。${blocked}。我想的是${want} —— 这个我自己修不了，你看看？`
        : kind === "ask"
          ? `用户，有个事我想问你：${want}。${blocked}`
          : `用户，有个事我做不了：${blocked}。想的是${want}，这个得你来决定。`;

  try {
    const r = queue.queue(
      workspaceDir,
      { target: who, kind: "need-help", source: "need_help", value: 0.85, text },
      proactiveCfg,
    );
    return { queued: Boolean(r?.queued), reason: r?.queued ? null : (r?.reason ?? "unknown") };
  } catch (err) {
    return { queued: false, reason: `error:${err?.message ?? err}` };
  }
}

/** 还有哪些求助没被处理。给 main 那边看。 */
export function openRequests(workspaceDir) {
  return load(workspaceDir).requests.filter((r) => r.state === "open");
}
