// 产出账本 — what actually got MADE, as opposed to what got SAID.
//
// Why this file exists
// --------------------
// `deeds.json` records acts, but every kind it knows about is a form of speech:
// a sticker, a voice note, a 说说, a like. Measured 2026-11-04: 40 entries, all
// four kinds, zero productions. So "画了一张" and "自己去逛了" were labelled in
// KIND_LABEL but no code path ever wrote them.
//
// The consequence is not cosmetic. If a drawing is not recorded, then:
//   - it does not count as having done anything
//   - it cannot feed back into mood
//   - it cannot be recalled next session ("昨天那张画得还行")
//   - and an hour spent drawing looks identical to an hour of nothing
//
// Orrin v3 solves this with an effect ledger that is content-addressed and
// refuses to credit an effect that does not exist on disk. That refusal is the
// whole point, so this module copies it: a production claims a `ref`, and the
// claim is verified before it is written.
//
// The rule
// --------
//   said something      → deeds (unchanged, no verification possible)
//   made something      → here, and the thing must exist
//
// A missing ref is not a hard error — the model may genuinely be describing a
// browse it cannot point at. But it is recorded as `verified: false`, and the
// reader can tell the two apart. That distinction is what stops this from
// degrading into another way to announce intentions.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAX_ENTRIES = 300;
const MAX_NOTE = 120;

// Which kinds count as production. Kept explicit rather than inferred, so
// adding a new kind is a deliberate act and not a typo away from silent credit.
const PRODUCTION_KINDS = new Set([
  "drawn",       // 画了一张图
  "wrote",       // 写出了文件/代码/文字
  "made",        // 做出了别的实体东西
  "researched",  // 查到了东西并留下了记录
  "browsed",     // 自己去逛了，有落点
  "built",       // 装好了/搭起来了
]);

export function ledgerFile(workspaceDir) {
  return path.join(workspaceDir, "state", "effects.json");
}

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.entries)) return raw;
  } catch { /* first run */ }
  return { version: 1, updated_at: new Date().toISOString(), entries: [] };
}

function save(file, data) {
  data.updated_at = new Date().toISOString();
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Does the claimed ref actually exist?
 *
 * Accepts an absolute path, a path relative to the workspace, or a URL (URLs
 * count as unverifiable-but-plausible, since a browse has no local file).
 *
 * Returns { verified, resolved, reason }.
 */
export function checkRef(workspaceDir, ref) {
  if (!ref) return { verified: false, resolved: null, reason: "no_ref" };
  const s = String(ref).trim();
  if (!s) return { verified: false, resolved: null, reason: "empty_ref" };

  if (/^https?:\/\//i.test(s)) {
    return { verified: false, resolved: s, reason: "url_unverifiable" };
  }

  const abs = path.isAbsolute(s) ? s : path.join(workspaceDir, s);
  try {
    const st = fs.statSync(abs);
    return { verified: true, resolved: abs, reason: "exists", size: st.size };
  } catch {
    return { verified: false, resolved: abs, reason: "missing" };
  }
}

/** Stable short hash so the same artifact recorded twice is recognisable. */
function fingerprint(verified, resolved) {
  if (!verified || !resolved) return null;
  try {
    const st = fs.statSync(resolved);
    return crypto
      .createHash("sha1")
      .update(`${resolved}:${st.size}:${Math.floor(st.mtimeMs)}`)
      .digest("hex")
      .slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * Record one production.
 *
 * `kind`      one of PRODUCTION_KINDS
 * `note`      one sentence, what it was
 * `ref`       path or URL pointing at the thing (strongly recommended)
 * `goalId`    optional: which persistent goal this advanced (M2 will use it)
 *
 * Returns { ok, verified, reason, duplicate, entry }.
 */
export function record(workspaceDir, { kind, note, ref = null, goalId = null } = {}) {
  const k = String(kind || "").trim();
  if (!k) return { ok: false, reason: "缺 kind" };
  if (!PRODUCTION_KINDS.has(k)) {
    return {
      ok: false,
      reason: `"${k}" 不是产出类。说话类的东西记 deeds，不记这里。`,
      known: [...PRODUCTION_KINDS],
    };
  }

  const file = ledgerFile(workspaceDir);
  const data = load(file);
  const chk = checkRef(workspaceDir, ref);
  const fp = fingerprint(chk.verified, chk.resolved);

  // Same artifact, same note, within an hour → it is the same act reported
  // twice. Browsing ten pages is ten entries; re-recording one page is not.
  if (fp) {
    const hourAgo = Date.now() - 3600_000;
    const dup = data.entries.find(
      (e) => e.fingerprint === fp && Date.parse(e.at) > hourAgo && String(e.note || "") === String(note || ""),
    );
    if (dup) {
      return { ok: true, verified: true, duplicate: true, reason: "already_recorded", entry: dup };
    }
  }

  const entry = {
    kind: k,
    note: note ? String(note).slice(0, MAX_NOTE) : null,
    ref: chk.resolved || null,
    ref_raw: ref ? String(ref) : null,
    verified: chk.verified,
    verify_reason: chk.reason,
    fingerprint: fp,
    goal_id: goalId ? String(goalId) : null,
    at: new Date().toISOString(),
  };

  data.entries.push(entry);
  if (data.entries.length > MAX_ENTRIES) {
    data.entries = data.entries.slice(-MAX_ENTRIES);
  }
  save(file, data);
  return { ok: true, verified: chk.verified, reason: chk.reason, duplicate: false, entry };
}

/** Everything recorded, oldest first. */
export function all(workspaceDir) {
  return load(ledgerFile(workspaceDir)).entries;
}

/** Entries whose `at` starts with the given YYYY-MM-DD (defaults to nothing). */
export function onDay(workspaceDir, day) {
  if (!day) return [];
  return all(workspaceDir).filter((e) => String(e.at).startsWith(day));
}

/** The last N entries, newest last. */
export function recent(workspaceDir, limit = 8) {
  return all(workspaceDir).slice(-Math.max(1, Math.min(MAX_ENTRIES, limit)));
}

/**
 * Counts for the last `days` days, split by kind and by whether the artifact
 * could be verified. This is the number that answers "did it actually make
 * anything this week" without reading the entries by hand.
 */
export function summary(workspaceDir, days = 7) {
  const since = Date.now() - days * 86400_000;
  const rows = all(workspaceDir).filter((e) => Date.parse(e.at) >= since);
  const byKind = {};
  let verified = 0;
  let unverified = 0;
  for (const e of rows) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    if (e.verified) verified += 1;
    else unverified += 1;
  }
  return { days, total: rows.length, verified, unverified, byKind };
}

const KIND_LABEL = {
  drawn: "画了一张",
  wrote: "写出来了",
  made: "做出来了",
  researched: "查到了",
  browsed: "去逛了",
  built: "搭起来了",
};

/**
 * What to inject into the prompt. Deliberately short: a list of everything
 * would read like a log. It names the recent productions and, crucially, says
 * how long it has been since the last one — that is the signal that actually
 * changes behaviour ("三天没做出东西了" is actionable; a list is not).
 */
export function describe(workspaceDir, limit = 5) {
  const items = recent(workspaceDir, limit);
  const now = Date.now();
  const lines = [];

  if (!items.length) {
    return [
      "【本鱼最近做出来的东西】",
      "  一件都没有。光在说话，没做出东西来。",
    ].join("\n");
  }

  for (const e of items) {
    const at = Date.parse(e.at);
    const mins = Number.isFinite(at) ? Math.floor((now - at) / 60000) : null;
    let when = "";
    if (mins !== null) {
      if (mins < 60) when = `${mins} 分钟前`;
      else if (mins < 24 * 60) when = `${Math.floor(mins / 60)} 小时前`;
      else when = `${Math.floor(mins / (24 * 60))} 天前`;
    }
    const label = KIND_LABEL[e.kind] || e.kind;
    const note = e.note ? `：${e.note}` : "";
    // Re-check at read time, not just from the stored verdict: a file that
    // existed when it was recorded may be gone now, and a stale "verified"
    // would quietly keep claiming credit for something no longer there.
    const gone = e.verified && e.ref && !fs.existsSync(e.ref) ? "（那个东西已经不在了）" : "";
    lines.push(`  · ${when} ${label}${note}${gone}`);
  }

  const last = items[items.length - 1];
  const gapDays = Math.floor((now - Date.parse(last.at)) / 86400_000);
  if (gapDays >= 2) {
    lines.push("");
    lines.push(`  ${gapDays} 天没做出新东西了。`);
  }

  return ["【本鱼最近做出来的东西】", ...lines].join("\n");
}
