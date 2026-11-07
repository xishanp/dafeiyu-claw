/**
 * 习惯层 —— 从重复发生的事里认出稳定的行为模式。
 *
 * 移植自 x-000001/dsh-memory-plugin 的 `src/habit.ts`（MIT）。
 * **逻辑照原样，不做自己发挥。** 唯一改动是把 TypeScript 的类拆成函数 +
 * 一个 JSON 状态文件，因为这套系统里没有 Cordis 的 storage 抽象。
 *
 * 原文的流水线：
 *
 *   session events → 确定性纠正检测（零 token）
 *   → 同一会话内达到阈值（默认 3） → 一次便宜的判定调用
 *   → 候选（**不注入**）
 *   → 门 1：用户确认 → `suggested`（**仍不注入**）
 *   → 门 2：用户提升 → `auto`（现在才注入）
 *
 * **硬边界：没有任何模型输出能把状态设成 `auto`。**
 * 只有 `promote()` 且 actor === 'user' 能，而且要求这个模式出现在
 * `minSessionsForAuto` 个不同会话里。删除写墓碑，同一个模式不再被学习。
 *
 * 为什么这两道门是重点
 * --------------------
 *
 * 这套东西一旦自动生效，就是在改自己的行为规则。让模型自己决定
 * 「我以后应该这样」，等于让它自己写自己的判决书。原实现把这一步
 * 钉死在用户手上，是对的，照抄。
 */

import fs from "node:fs";
import path from "node:path";

// --------------------------------------------------------------------- 常量

/**
 * 固定词表。大小写不敏感，字面匹配。
 *
 * 原样保留，不增不减。加词会让它开始捕捉原文没打算捕捉的东西，
 * 而这个列表的每一条都对应「用户明确说了我错了」。
 */
export const CORRECTION_PHRASES = [
  "不对",
  "不是这样",
  "不是这个意思",
  "你理解错了",
  "你搞错了",
  "错了",
  "重新来",
  "重来",
  "别再",
  "不要这样",
  "不要用",
  "别用",
  "应该是",
  "我说的是",
  "我指的是",
  "按我说的",
  "wrong",
  "not what i",
  "i meant",
  "you misunderstood",
  "stop doing",
  "don't do",
  "do not do",
  "instead use",
  "actually, use",
  "no, use",
];

/** 以这些动词开头的句子是任务描述，不是纠正。原样保留。 */
const TASK_PREFIX =
  /^(?:请帮我|帮我|给我|实现|添加|新增|修复|写入|创建|设计|做个|开发|重构|删除|add|implement|fix|create|write|build|design|refactor|remove|update)\b/i;

const DEFAULTS = {
  enabled: true,
  threshold: 3,
  maxEvidence: 5,
  judgeEnabled: false,
  judgeTimeoutMs: 8000,
  minSessionsForAuto: 2,
};

// ------------------------------------------------------------------- 存储层

function stateDir(workspaceDir) {
  return path.join(workspaceDir, "state", "habit");
}

function p(workspaceDir, name) {
  return path.join(stateDir(workspaceDir), name);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`);
  fs.renameSync(tmp, file);
}

function appendNdjson(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

function readNdjson(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function loadState(workspaceDir) {
  return readJson(p(workspaceDir, "state.json"), { candidates: [], tombstones: [], triggers: [] });
}

function saveState(workspaceDir, state) {
  writeJson(p(workspaceDir, "state.json"), state);
}

function readProfiles(workspaceDir) {
  // 原实现用 ndjson + 整体重写；这里保持同一个文件语义。
  const rows = readNdjson(p(workspaceDir, "profiles.ndjson"));
  // 后写的覆盖先写的（同一 id）
  const byId = new Map();
  for (const r of rows) byId.set(r.id, r);
  return [...byId.values()];
}

function rewriteProfiles(workspaceDir, profiles) {
  fs.mkdirSync(stateDir(workspaceDir), { recursive: true });
  const body = profiles.map((x) => JSON.stringify(x)).join("\n");
  fs.writeFileSync(p(workspaceDir, "profiles.ndjson"), body ? `${body}\n` : "");
}

function appendSignal(workspaceDir, signal) {
  appendNdjson(p(workspaceDir, "signals.ndjson"), signal);
}

function readSignals(workspaceDir) {
  return readNdjson(p(workspaceDir, "signals.ndjson"));
}

function audit(workspaceDir, event) {
  appendNdjson(p(workspaceDir, "audit.ndjson"), { at: new Date().toISOString(), ...event });
}

function shortId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function normalize(v) {
  return String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// --------------------------------------------------------------- 纠正检测

/**
 * 确定性纠正检测。零 token。
 *
 * 一句算数要同时满足（照原样）：
 *   - 含固定词表里的某一条
 *   - 短到像一句纠正（默认 <= 400 字）
 *   - 不是纯任务描述（动词在句首的不算）
 */
export function detectCorrections(text, maxSegmentChars = 400) {
  const segments = String(text ?? "")
    .split(/\r?\n|(?<=[。！？!?])\s*|(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const hits = [];
  for (const segment of segments) {
    if (segment.length > maxSegmentChars) continue;
    const lowered = segment.toLowerCase();
    const phrase = CORRECTION_PHRASES.find((x) => lowered.includes(x.toLowerCase()));
    if (!phrase) continue;
    if (TASK_PREFIX.test(segment)
      && !CORRECTION_PHRASES.some((x) => lowered.startsWith(x.toLowerCase()))) {
      continue;
    }
    hits.push({ phrase, text: segment.slice(0, maxSegmentChars) });
  }
  return hits;
}

// ------------------------------------------------------------------- 观察

/**
 * 喂一条用户消息。
 *
 * 纯记账 + 最多一次判定调用。达到阈值之后同一会话只触发一次。
 */
export async function observe(workspaceDir, { sessionId, turn = 0, text, settings = {}, judge = null, now = Date.now } = {}) {
  const cfg = { ...DEFAULTS, ...settings };
  if (!cfg.enabled) {
    return { detected: 0, sessionCount: 0, triggered: false, judge: "skipped", reason: "habit learning disabled by config" };
  }

  const hits = detectCorrections(text);
  if (!hits.length) return { detected: 0, sessionCount: 0, triggered: false, judge: "none" };

  const at = now();
  for (const hit of hits) {
    appendSignal(workspaceDir, { sessionId, turn, phrase: hit.phrase, text: hit.text, at });
  }
  audit(workspaceDir, {
    type: "habit-signal",
    actor: "system",
    sessionId,
    detail: `${hits.length} correction signal(s): ${hits.map((h) => h.phrase).join(", ")}`,
  });

  const all = readSignals(workspaceDir);
  const sessionSignals = all.filter((s) => s.sessionId === sessionId);
  const sessionCount = sessionSignals.length;

  const state = loadState(workspaceDir);
  const alreadyTriggered = state.triggers.includes(sessionId);
  if (sessionCount < cfg.threshold || alreadyTriggered) {
    return { detected: hits.length, sessionCount, triggered: false, judge: "none" };
  }

  const evidence = sessionSignals.slice(-cfg.maxEvidence).map((s) => s.text);
  const existing = readProfiles(workspaceDir)
    .filter((x) => x.status !== "disabled")
    .map((x) => x.pattern);

  state.triggers = [...state.triggers, sessionId];
  saveState(workspaceDir, state);

  // ---- 判定。失败放过（fail open）。 ----
  let judgedBy = "none";
  let isHabit = false;
  let pattern = "";
  let confidence = 0.35;
  let category = "other";
  let note = "";

  const outcome = judge ? await runJudge(judge, { evidence, existingHabits: existing, timeoutMs: cfg.judgeTimeoutMs }) : { ok: false, reason: "no judge configured", failOpen: true };

  if (outcome.ok) {
    judgedBy = "judge";
    isHabit = Boolean(outcome.verdict.isHabit) && Number(outcome.verdict.confidence) >= 0.5;
    pattern = String(outcome.verdict.pattern ?? "");
    confidence = Number(outcome.verdict.confidence) || 0.35;
    category = String(outcome.verdict.category ?? "other");
    audit(workspaceDir, {
      type: "judge",
      actor: "system",
      sessionId,
      detail: `isHabit=${outcome.verdict.isHabit} confidence=${outcome.verdict.confidence} pattern="${pattern.slice(0, 80)}"`,
    });
  } else {
    // 判定不可用不阻塞流水线，但规则模式只能提一个低置信度的 pending。
    judgedBy = "rule";
    isHabit = true;
    const last = hits[hits.length - 1] ?? { phrase: "correction", text: String(text ?? "") };
    pattern = last.text.slice(0, 120);
    confidence = 0.35;
    note = `judge unavailable/failed (${outcome.reason}); rule fallback`;
    audit(workspaceDir, { type: "judge", actor: "system", sessionId, detail: `fail-open: ${outcome.reason}` });
  }

  if (!isHabit) {
    return { detected: hits.length, sessionCount, triggered: true, judge: judgedBy, reason: "judge decided this is not a stable habit" };
  }
  if (isTombstoned(workspaceDir, pattern)) {
    return { detected: hits.length, sessionCount, triggered: true, judge: judgedBy, reason: "pattern was deleted by the user (tombstone); not learned again" };
  }

  const state2 = loadState(workspaceDir);
  const prior = state2.candidates.find((c) => c.status !== "discarded" && normalize(c.pattern) === normalize(pattern));

  // 已经确认过的候选不能被一次新观察打回 pending。
  //
  // 原实现的条件是 `status !== 'discarded'`，于是 `confirmed` 也算"prior"，
  // 下面的对象重建会把 status 写成 'pending' —— 一道门过了又退回门外，
  // 而且 `promote` 会以 "requires a confirmed candidate first" 拒绝。
  //
  // 实测 2026-11-07：会话 A 凑够三次 → 确认；会话 B 又出现同一个模式 →
  // 候选被打回 pending，profile 还是 suggested，门 2 永远过不去。
  //
  // 只补一个会话记录，不重建候选。
  if (prior && (prior.status === "confirmed" || prior.status === "mature")) {
    prior.sessions = [...new Set([...(prior.sessions ?? []), sessionId])];
    prior.evidence = [...(prior.evidence ?? []), ...evidence].slice(-cfg.maxEvidence);
    prior.updatedAt = now();
    saveState(workspaceDir, state2);
    audit(workspaceDir, {
      type: "habit-candidate",
      actor: "system",
      sessionId,
      entryId: prior.id,
      detail: `existing ${prior.status} candidate; added session ${sessionId} (${prior.sessions.length} total)`,
    });
    return { detected: hits.length, sessionCount, triggered: true, candidateId: prior.id, judge: judgedBy };
  }

  const sessions = [...new Set([...(prior?.sessions ?? []), sessionId])];
  const candidate = {
    id: prior?.id ?? shortId("cand"),
    status: "pending",
    pattern,
    category,
    confidence,
    evidence: [...(prior?.evidence ?? []), ...evidence].slice(-cfg.maxEvidence),
    sessions,
    createdAt: prior?.createdAt ?? now(),
    updatedAt: now(),
    judgedBy,
    note: note || prior?.note,
  };

  state2.candidates = [...state2.candidates.filter((c) => c.id !== candidate.id), candidate];
  saveState(workspaceDir, state2);
  audit(workspaceDir, {
    type: "habit-candidate",
    actor: "system",
    sessionId,
    entryId: candidate.id,
    detail: `pending candidate (${judgedBy}, confidence ${confidence}, sessions ${sessions.length}); no injection until two human gates`,
  });

  return { detected: hits.length, sessionCount, triggered: true, candidateId: candidate.id, judge: judgedBy };
}

// ------------------------------------------------------------------- 判定

const MAX_PATTERN = 160;

export function buildJudgePrompt({ evidence = [], existingHabits = [] } = {}) {
  const ev = evidence.slice(0, 5).map((e, i) => `${i + 1}. ${String(e).slice(0, 300)}`).join("\n");
  const habits = existingHabits.slice(0, 8).map((h) => `- ${String(h).slice(0, MAX_PATTERN)}`).join("\n") || "(none)";
  return [
    "You are a strict habit classifier. Decide whether the user repeatedly corrected the assistant in a consistent, reusable way.",
    "Reply with ONE JSON object and nothing else:",
    '{"isHabit": true|false, "pattern": "<=120 chars, imperative rule", "category": "style|workflow|tooling|format|other", "confidence": 0..1}',
    "Rules:",
    "- Corrections must describe how the assistant should behave in future work, not one-off task instructions.",
    "- If the evidence is inconsistent or too thin, set isHabit=false.",
    "- Never invent a pattern not supported by the evidence.",
    "",
    `Evidence:\n${ev}`,
    "",
    `Existing habits:\n${habits}`,
  ].join("\n");
}

export function parseJudgeReply(raw) {
  const start = String(raw ?? "").indexOf("{");
  const end = String(raw ?? "").lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const d = JSON.parse(String(raw).slice(start, end + 1));
    if (typeof d?.isHabit !== "boolean") return null;
    return {
      isHabit: d.isHabit,
      pattern: String(d.pattern ?? "").slice(0, MAX_PATTERN),
      category: String(d.category ?? "other"),
      confidence: Math.max(0, Math.min(1, Number(d.confidence) || 0)),
    };
  } catch {
    return null;
  }
}

async function runJudge(caller, input) {
  try {
    if (typeof caller !== "function") return { ok: false, reason: "judge is not callable", failOpen: true };
    const raw = await caller(buildJudgePrompt(input), { timeoutMs: input.timeoutMs });
    const verdict = parseJudgeReply(raw);
    if (!verdict) return { ok: false, reason: "malformed judge reply", failOpen: true };
    return { ok: true, verdict };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err), failOpen: true };
  }
}

// ------------------------------------------------------------------ 两道门

/**
 * 门 1：用户确认。pending → suggested（**仍然不注入**）。
 *
 * actor 必须 'user'。模型调用会被明确拒绝，不是静默失败。
 */
export function confirm(workspaceDir, candidateId, actor = "agent", { now = Date.now } = {}) {
  if (actor !== "user") {
    return { ok: false, reason: "gate 1 requires a user action; the agent cannot confirm habits" };
  }
  const state = loadState(workspaceDir);
  const candidate = state.candidates.find((c) => c.id === candidateId);
  if (!candidate) return { ok: false, reason: `candidate not found: ${candidateId}` };
  if (candidate.status !== "pending") return { ok: false, reason: `candidate ${candidateId} is ${candidate.status}, expected pending` };

  const ts = now();
  const profile = {
    id: candidate.id,
    status: "suggested",
    pattern: candidate.pattern,
    category: candidate.category,
    confidence: candidate.confidence,
    evidenceCount: candidate.evidence.length,
    sessions: candidate.sessions,
    pinned: false,
    createdAt: ts,
    updatedAt: ts,
  };

  candidate.status = "confirmed";
  candidate.updatedAt = ts;
  saveState(workspaceDir, state);

  const profiles = readProfiles(workspaceDir).filter((x) => x.id !== profile.id);
  profiles.push(profile);
  rewriteProfiles(workspaceDir, profiles);
  audit(workspaceDir, { type: "habit-confirm", actor, entryId: candidateId, detail: "gate 1 passed: suggested (not injected)" });

  return { ok: true, reason: "confirmed as suggested; not injected until the second gate", profile };
}

/**
 * 门 2：用户提升。suggested → auto（现在才注入）。
 *
 * 两条硬约束，照原样：
 *   1. actor 必须 'user'
 *  2. 这个模式必须出现在 minSessionsForAuto 个不同会话里
 */
export function promote(workspaceDir, candidateId, actor = "agent", { settings = {}, now = Date.now } = {}) {
  const cfg = { ...DEFAULTS, ...settings };
  if (actor !== "user") {
    return { ok: false, reason: "gate 2 requires a user action; the model can never promote habits" };
  }
  const state = loadState(workspaceDir);
  const candidate = state.candidates.find((c) => c.id === candidateId);
  if (!candidate) return { ok: false, reason: `candidate not found: ${candidateId}` };
  if (candidate.status !== "confirmed") {
    return { ok: false, reason: `gate 2 requires a confirmed candidate first (current: ${candidate.status})` };
  }
  if (candidate.sessions.length < cfg.minSessionsForAuto) {
    return {
      ok: false,
      reason: `cross-session guardrail: pattern seen in ${candidate.sessions.length} session(s); need ${cfg.minSessionsForAuto} distinct sessions before auto`,
    };
  }

  const ts = now();
  const profiles = readProfiles(workspaceDir);
  const profile = profiles.find((x) => x.id === candidateId);
  if (!profile) return { ok: false, reason: "habit profile missing; confirm the candidate first" };

  profile.status = "auto";
  profile.updatedAt = ts;
  rewriteProfiles(workspaceDir, profiles);

  candidate.status = "mature";
  candidate.updatedAt = ts;
  saveState(workspaceDir, state);

  audit(workspaceDir, { type: "habit-promote", actor, entryId: candidateId, detail: "gate 2 passed: auto (now injected)" });
  return { ok: true, reason: "promoted to auto; habit is now injected", profile };
}

/** 丢掉一个候选。模型也可以做，因为它只是不采纳。 */
export function discard(workspaceDir, candidateId, actor = "agent", { now = Date.now } = {}) {
  const state = loadState(workspaceDir);
  const candidate = state.candidates.find((c) => c.id === candidateId);
  if (!candidate) return { ok: false, reason: `candidate not found: ${candidateId}` };

  candidate.status = "discarded";
  candidate.updatedAt = now();
  saveState(workspaceDir, state);

  const profiles = readProfiles(workspaceDir);
  const profile = profiles.find((x) => x.id === candidateId);
  if (profile) {
    profile.status = "disabled";
    profile.updatedAt = now();
    rewriteProfiles(workspaceDir, profiles);
  }
  audit(workspaceDir, { type: "habit-discard", actor, entryId: candidateId, detail: "candidate discarded" });
  return { ok: true, reason: "discarded; never injected" };
}

/** 删除写墓碑。同一个模式不再被学习。只能用户做。 */
export function deleteProfile(workspaceDir, profileId, actor = "agent", { now = Date.now } = {}) {
  if (actor !== "user") {
    return { ok: false, reason: "deleting a habit requires an explicit user action" };
  }
  const profiles = readProfiles(workspaceDir);
  const profile = profiles.find((x) => x.id === profileId);
  if (!profile) return { ok: false, reason: `habit profile not found: ${profileId}` };

  profile.status = "disabled";
  profile.updatedAt = now();
  rewriteProfiles(workspaceDir, profiles);

  const state = loadState(workspaceDir);
  const tombstone = { id: shortId("tomb"), pattern: profile.pattern, reason: "deleted by user", at: now() };
  state.tombstones = [...state.tombstones, tombstone];
  const candidate = state.candidates.find((x) => x.id === profileId);
  if (candidate) {
    candidate.status = "discarded";
    candidate.updatedAt = now();
  }
  saveState(workspaceDir, state);

  audit(workspaceDir, { type: "habit-delete", actor, entryId: profileId, detail: `tombstone ${tombstone.id}` });
  return { ok: true, reason: "habit deleted and tombstoned; pattern will not be learned again" };
}

export function isTombstoned(workspaceDir, pattern) {
  const needle = normalize(pattern);
  return loadState(workspaceDir).tombstones.some((t) => normalize(t.pattern) === needle);
}

// ------------------------------------------------------------------- 读

/** 供注入：只有 `auto` 的才返回。`suggested` 和 `pending` 都还在等门。 */
export function activeHabits(workspaceDir) {
  return readProfiles(workspaceDir).filter((x) => x.status === "auto");
}

export function review(workspaceDir, { settings = {} } = {}) {
  const cfg = { ...DEFAULTS, ...settings };
  const state = loadState(workspaceDir);
  return {
    candidates: state.candidates,
    profiles: readProfiles(workspaceDir),
    tombstones: state.tombstones,
    threshold: cfg.threshold,
    minSessionsForAuto: cfg.minSessionsForAuto,
    gate1: "user confirm: pending -> suggested (still not injected)",
    gate2: "user promote: suggested -> auto (injected; requires >= minSessionsForAuto distinct sessions)",
    policy: "models can never promote habits; only explicit user actions call confirm/promote",
  };
}

export const CONSTANTS = Object.freeze({ DEFAULTS, MAX_PATTERN });
