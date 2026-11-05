// Outcome — what actually happened, as opposed to what the model says happened.
//
// The problem this solves
// -----------------------
// Every "self-improving" agent design eventually needs an answer to one
// question: who decides that a thing worked? If the answer is "the model that
// did it", the system cannot learn, it can only become more confident. Voyager
// is the clearest case — `critic.py:101` sets `success` from
// `self.llm(messages).content`, so "this skill is verified" means "another
// model believed it". It works in Minecraft only because the environment also
// throws on impossible actions, giving a hard signal underneath.
//
// Measured-vs-claimed separation
// ------------------------------
// dsh-douyin-agent persona-memory.mjs:421 stores two fields per piece of
// evidence:
//
//     signal         — what the host measured (watchedSeconds, watchRatio)
//     proposalSignal — what the model asserted ("I like this")
//
// Statistics read `signal` only. `proposalSignal` is kept for audit and never
// feeds a score. That is the whole trick, and it is worth copying exactly:
// a claim is recorded so it can be reviewed later, and it cannot move a number.
//
// Two independent things are recorded here
// ----------------------------------------
// 1. `claimed` — the model's own account. Always stored, never scored.
// 2. `measured` — a hard observation from the runtime. Scored.
//
// If they disagree, that disagreement is itself the interesting datum. A model
// that keeps claiming success while measurement says silent is not lying
// exactly; it is over-reading its own actions, and the log is the only place
// that shows up.

import fs from "node:fs";
import path from "node:path";

import * as intent from "./intent.js";

const MAX_RECORDS = 500;

export function outcomesLogFile(workspaceDir) {
  return path.join(workspaceDir, "state", "outcomes.json");
}

function nowIso() {
  return new Date().toISOString();
}

export function load(workspaceDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(outcomesLogFile(workspaceDir), "utf8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.records)) return raw;
  } catch { /* first run */ }
  return { version: 1, records: [] };
}

function save(workspaceDir, data) {
  const file = outcomesLogFile(workspaceDir);
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Record one attempt.
 *
 * `measured` is what the runtime observed and must be one of:
 *   success | silent | failure | uncertain
 *
 * `claimed` is whatever the model said, free text. It is stored and ignored by
 * scoring — see `agrees` below for why it is still worth keeping.
 */
export function record(workspaceDir, { key, kind, measured, claimed = null, detail = null } = {}) {
  if (!key) return { ok: false, reason: "没有 key" };
  const valid = ["success", "silent", "failure", "uncertain"];
  if (!valid.includes(measured)) {
    return { ok: false, reason: `measured 必须是 ${valid.join(" / ")}` };
  }

  const data = load(workspaceDir);
  const rec = {
    at: nowIso(),
    key: String(key),
    kind: String(kind || "unknown"),
    measured,
    claimed: claimed == null ? null : String(claimed).slice(0, 200),
    detail: detail && typeof detail === "object" ? detail : null,
  };
  data.records.push(rec);
  if (data.records.length > MAX_RECORDS) data.records = data.records.slice(-MAX_RECORDS);
  save(workspaceDir, data);

  // The track record that scoring actually reads lives in intent.js. Only the
  // three terminal outcomes move it; `uncertain` is evidence of nothing.
  if (measured !== "uncertain") {
    intent.recordOutcome(workspaceDir, key, measured);
  }

  return { ok: true, record: rec };
}

/**
 * Did the model's account match reality?
 *
 * Returns null when there is no claim to compare — an unjudged attempt is not a
 * disagreement. Never used to punish; only surfaced in review output, because
 * the point is to make over-claiming visible to a human, not to train the model
 * against a signal it cannot perceive mid-turn.
 */
export function agrees(rec) {
  if (!rec || rec.claimed == null) return null;
  const t = String(rec.claimed);
  const saidYes = /成功|发出去|送达|做到了|成功了|已经|完成/u.test(t);
  const saidNo = /失败|没成|发不出去|不行|没做到|失败/u.test(t);
  if (saidYes && rec.measured !== "success") return false;
  if (saidNo && rec.measured === "success") return false;
  return true;
}

/**
 * Find attempts that went out and were never resolved.
 *
 * This is the state that blocks retries. `douyin-agent` calls it `uncertain`
 * and stops sending until a human confirms the receipt — for the same reason
 * here: we cannot tell "delivered silently" from "never left".
 */
export function unresolvedFor(workspaceDir, key) {
  const data = load(workspaceDir);
  const mine = data.records.filter((r) => r.key === key);
  if (!mine.length) return false;
  const last = mine[mine.length - 1];
  return last.measured === "uncertain";
}

/**
 * Has this exact key already been judged?
 *
 * Guards the auto-record path in `experience_resolve`. Verified 2026-11-05: with
 * no guard, resolving the same experience four times produced four successes,
 * pushing that candidate's prior toward 1 and making it permanently attractive.
 * A repeated judgement about the same thing is not new evidence — it is the same
 * act looked at twice, and counting it inflates the score without any new
 * outcome having occurred.
 */
export function alreadyJudged(workspaceDir, key) {
  const data = load(workspaceDir);
  return data.records.some((r) => r.key === key && r.measured !== "uncertain");
}

/** Per-key summary for prompt injection. Small by design. */
export function describe(workspaceDir, limit = 5) {
  const data = load(workspaceDir);
  const recent = data.records.slice(-limit).reverse();
  if (!recent.length) return null;
  return recent.map((r) => ({
    key: r.key,
    kind: r.kind,
    measured: r.measured,
    claimed: r.claimed,
    disagree: agrees(r) === false,
    at: r.at,
  }));
}
