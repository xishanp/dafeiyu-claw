// approval.js — pending-request store + secret redaction.
//
// The gate blocks a tool call inside the blocked agent's own turn. By the time
// the owner answers, that turn is long gone, so the request has to exist as
// data on disk. Everything here is pure filesystem + string work so it can be
// unit-tested without a Gateway.

import fs from "node:fs";
import path from "node:path";

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

// Mask anything credential-shaped. The owner needs to know *that* a secret is
// involved, never its value.
export function redact(text) {
  let s = String(text);
  const rules = [
    // Authorization headers: mask whatever follows the scheme.
    [/\b(bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
      (_m, scheme) => `${scheme} <redacted>`],
    // key=value / key: value where the key looks like a credential
    [/\b(api[_-]?key|apikey|token|secret|password|passwd|pwd|auth|access[_-]?key|private[_-]?key|client[_-]?secret)\b(\s*[:=]\s*)(["']?)([^\s"',;]{4,})/gi,
      (_m, k, sep, q) => `${k}${sep}${q}<redacted>`],
    // well-known token shapes
    [/\b(sk|pk|rk|brz|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g, "<redacted>"],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "<redacted-jwt>"],
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<redacted-email>"],
    // long opaque blobs
    [/\b[A-Za-z0-9]{32,}\b/g, "<redacted-blob>"],
    // Chinese ID / phone-ish
    [/\b\d{17}[\dXx]\b/g, "<redacted-id>"],
    [/\b1[3-9]\d{9}\b/g, "<redacted-phone>"],
  ];
  for (const [re, rep] of rules) s = s.replace(re, rep);
  return s;
}

const PARAM_KEYS = [
  "command", "label", "mood", "tool", "target", "to", "channel",
  "url", "path", "file", "action", "reason",
];

// Keep only what the owner needs to judge, redacted and truncated.
export function summarizeParams(event) {
  const p = event?.params || {};
  const out = {};
  for (const k of PARAM_KEYS) {
    if (p[k] === undefined || p[k] === null) continue;
    const v = redact(p[k]);
    out[k] = v.length > 300 ? `${v.slice(0, 300)}…` : v;
  }
  if (!Object.keys(out).length) {
    const s = redact(JSON.stringify(p));
    out.brief = s.length > 300 ? `${s.slice(0, 300)}…` : s;
  }
  return out;
}

export function pendingFile(workspaceDir) {
  return path.join(workspaceDir, "state", "pending-requests.json");
}

export function readPending(workspaceDir) {
  const file = pendingFile(workspaceDir);
  let list = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    list = Array.isArray(raw) ? raw : [];
  } catch {
    return { file, list: [] };
  }
  return { file, list: list.filter((r) => r && r.id) };
}

// Record a blocked attempt. Identical attempts inside 30 minutes are merged
// into one entry so the owner is not asked the same thing twice.
export function recordPending(workspaceDir, toolName, event, reason, now = Date.now()) {
  const { file, list } = readPending(workspaceDir);
  const params = summarizeParams(event);
  const sig = `${toolName}:${JSON.stringify(params).slice(0, 200)}`;

  const dup = list.find(
    (r) => r.status === "pending" && r.sig === sig && now - Date.parse(r.created) < 30 * 60000,
  );

  let id;
  if (dup) {
    dup.last_seen = new Date(now).toISOString();
    dup.attempts = (dup.attempts || 1) + 1;
    id = dup.id;
  } else {
    id = `req-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    list.push({
      id,
      tool: toolName,
      params,
      sig,
      reason: redact(String(reason || "")).slice(0, 600),
      status: "pending",
      created: new Date(now).toISOString(),
      last_seen: new Date(now).toISOString(),
      attempts: 1,
      decided_at: null,
      decided_by: null,
      decided_reason: null,
    });
  }
  writeJsonAtomic(file, list.slice(-50));
  return { id, merged: Boolean(dup), list };
}

// Mark a request decided. Returns the record, or an error string.
export function decidePending(workspaceDir, id, decision, { reason = "", by = "main" } = {}) {
  const { file, list } = readPending(workspaceDir);
  const rec = list.find((r) => r.id === id);
  if (!rec) return { error: `no-such-request:${id}` };
  if (rec.status !== "pending") return { error: `already-${rec.status}` };
  if (decision !== "approve" && decision !== "reject") return { error: "bad-decision" };

  rec.decided_at = new Date().toISOString();
  rec.decided_by = by;
  rec.decided_reason = redact(String(reason)).slice(0, 300);
  rec.status = decision === "approve" ? "approved" : "rejected";
  writeJsonAtomic(file, list);
  return { record: rec, list };
}

export function listPending(workspaceDir, { all = false } = {}) {
  const { list } = readPending(workspaceDir);
  return all ? list : list.filter((r) => r.status === "pending");
}
