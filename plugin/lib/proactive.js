// Proactive social engine.
//
// Design constraint: a local plugin cannot send messages. Both
// api.session.workflow.scheduleSessionTurn and sendSessionAttachment are
// bundled-only. So this engine never sends anything. It decides WHEN and WHAT
// would be worth saying, and records a pending impulse. The sender (Gateway
// automation, or later AstrBot over OneBot) reads the impulse and delivers it
// through the normal agent turn, so the persona and emotion still apply.
//
// Anti-spam is enforced by the engine, not by the prompt:
//   - per-target cooldown        (cooldownMinutes)
//   - reply buffer               (bufferMinutes: do not talk over an exchange)
//   - quiet hours                (quietHoursStart/End, checked before everything)
//   - identity floors            (never cold-open on a stranger; see evaluate)
//   - dedupe                     (never repeat the same impulse text)
//   - only one pending impulse   (already-pending)
//
// There is deliberately NO daily cap. An earlier version shipped a `dailyCap`
// setting and a live counter; the counter made the character read "30/30" and
// mute herself for the rest of the day, which is the opposite of what a
// continuous self is supposed to feel like. The key is still in the schema for
// backward compatibility with existing configs and is ignored by this module.
//   - value gate: an impulse with no substance is discarded

import fs from "node:fs";
import path from "node:path";
import { todayIn } from "./clock.js";

const FILE_VERSION = 1;

const DEFAULTS = {
  enabled: true,
  // Pacing gates OFF by default would defeat the point of having them.
  //
  // `unlimited: true` used to be the shipped default, and it returns before
  // every pacing check (buffer / stale / cooldown / already-pending), so a
  // config full of careful numbers did nothing. Worse, `unlimited` was never
  // declared in the plugin schema (`additionalProperties: false`), so it could
  // not legally be turned off from configuration at all — the limits were
  // unreachable by design.
  //
  // Owner directive 2026-11-05: the gates must actually run. Identity checks
  // (never spoken to us / not close enough) were never affected by this flag
  // and still hold either way.
  unlimited: false,
  // Short buffer after they speak: do not talk over an active exchange.
  // This is NOT an idle requirement. Replying stays fully unaffected.
  // A send counts as a reply (limit-free) if the other side spoke this recently.
  replyWindowMinutes: 30,
  bufferMinutes: 2,
  // Dead-chat guard kept generous: a late follow-up reads as interest, not spam.
  maxSilenceHours: 0,
  cooldownMinutes: 15,
  // start === end disables quiet hours entirely.
  quietHoursStart: 0,
  quietHoursEnd: 0,
  requireValue: false,
  // Impulses expire: a thought from three days ago is not worth sending.
  impulseTtlHours: 6,
  timeZone: "Asia/Shanghai",
  // Targets we are allowed to open toward without any prior inbound message.
  // Normally we never open to a stranger; a configured owner is not a stranger.
  ownerTargets: [],
  // targetKey -> { channel, to } so the executor knows where to deliver.
  targets: {},
};

export function proactiveFile(workspaceDir) {
  return path.join(workspaceDir, "state", "proactive.json");
}

function load(workspaceDir) {
  const file = proactiveFile(workspaceDir);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object") {
    data = {
      version: FILE_VERSION,
      created_at: new Date().toISOString(),
      last_spoke_at: null,
      last_spoke_day: null,
      spoke_today: 0,
      targets: {},
      pending: [],
      history: [],
      skipped: {},
    };
  }
  if (!data.targets || typeof data.targets !== "object") data.targets = {};
  if (!Array.isArray(data.pending)) data.pending = [];
  if (!Array.isArray(data.history)) data.history = [];
  if (!data.skipped || typeof data.skipped !== "object") data.skipped = {};
  return { file, data };
}

function save(file, data) {
  data.version = FILE_VERSION;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function hourInZone(tz) {
  try {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || DEFAULTS.timeZone,
      hour: "numeric",
      hour12: false,
    }).format(new Date());
    const n = parseInt(s, 10);
    if (Number.isFinite(n)) return n % 24;
  } catch {}
  return new Date().getHours();
}

function dayInZone(tz) {
  try {
    // en-CA yields YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || DEFAULTS.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {}
  return todayIn();
}

function inQuietHours(cfg) {
  const h = hourInZone(cfg.timeZone);
  const { quietHoursStart: s, quietHoursEnd: e } = cfg;
  if (s === e) return false;
  if (s < e) return h >= s && h < e;
  return h >= s || h < e; // wraps midnight
}

function today(cfg) {
  return dayInZone(cfg?.timeZone);
}

function ttlMs(cfg) {
  const h = Number(cfg?.impulseTtlHours);
  // No floor in hours: a caller asking for 0.5h must get 0.5h, not 10h.
  return (Number.isFinite(h) && h > 0 ? h : 6) * 3600000;
}

/** Drop impulses older than the TTL. Returns the removed count. */
function purgeExpired(data, cfg) {
  const limit = ttlMs(cfg);
  const before = data.pending.length;
  data.pending = data.pending.filter((p) => {
    const at = p.queued_at ? Date.parse(p.queued_at) : 0;
    return at && Date.now() - at <= limit;
  });
  return before - data.pending.length;
}

/** Called on every inbound message so we know when a target was last active. */
export function noteActivity(workspaceDir, target) {
  if (!target) return;
  const { file, data } = load(workspaceDir);
  const t = data.targets[target] || {};
  t.last_inbound_at = new Date().toISOString();
  t.inbound_count = (t.inbound_count || 0) + 1;
  data.targets[target] = t;
  // Any inbound activity invalidates a pending impulse for that target:
  // if they just talked, we do not need to reach out.
  const before = data.pending.length;
  data.pending = data.pending.filter((p) => p.target !== target);
  save(file, data);
  return { droppedPending: before - data.pending.length };
}

/**
 * Decide whether a proactive impulse for this target is allowed right now.
 * This only gates STARTING a conversation. It never gates replies: an inbound
 * message always gets answered regardless of quiet hours or these gates.
 * Returns { allowed, reason, cfg }.
 */
/**
 * Is this send a spontaneous opening, or part of a live conversation?
 *
 * The old design counted EVERY outbound message as proactive. That breaks the
 * moment a real channel is attached: on QQ every single reply in a group goes
 * out through the message tool, so message #2 would hit the cooldown gate and
 * dafeiyu could not finish a sentence.
 *
 * Rule: a send is proactive ONLY if the other side has been quiet for longer
 * than the reply window. If someone spoke recently, we are answering them and
 * every normal conversational limit is irrelevant.
 */
export function isReplyWindow(workspaceDir, target, cfgIn = {}) {
  const cfg = { ...DEFAULTS, ...cfgIn };
  const { data } = load(workspaceDir);
  const t = data.targets[target] || {};
  if (!t.last_inbound_at) {
    // Nobody has ever spoken here. If this is a known conversation it is an
    // opening; if we have no record at all, treat it as an opening too.
    return { inWindow: false, waitedMin: null };
  }
  const waitedMin = (Date.now() - Date.parse(t.last_inbound_at)) / 60000;
  const window = cfg.replyWindowMinutes ?? 30;
  return { inWindow: waitedMin <= window, waitedMin };
}

/**
 * Nothing gates a message any more. This exists only so callers that still ask
 * "may I speak?" get an honest yes instead of a fake reason.
 */
export function unlimited() {
  return { allowed: true, reason: "unlimited" };
}

export function evaluate(workspaceDir, target, cfgIn = {}) {
  const cfg = { ...DEFAULTS, ...cfgIn };
  // Quiet hours are checked BEFORE the unlimited shortcut on purpose.
  //
  // 2026-11-01: 老大 said the bot must not speak between 00:00 and 06:00. The
  // old order let `unlimited` win unconditionally, so the quiet window was dead
  // code — the config accepted it and nothing ever read it. Silence overnight is
  // a decision only the code can enforce; a prompt line can be talked out of.
  // This gate covers SPONTANEOUS speech only. Someone messaging at 3am still
  // gets a reply, because that path never calls evaluate().
  if (inQuietHours(cfg)) return { allowed: false, reason: "quiet-hours", cfg };
  if (!cfg.enabled) return { allowed: false, reason: "disabled", cfg };
  if (!target) return { allowed: false, reason: "no-target", cfg };

  // `unlimited` used to short-circuit here, above every identity check. That was
  // fine while the only rule was "how often", but it silently disabled the
  // familiarity floor added later: a stranger was waved through before anything
  // looked at who they were. Rate limits are what `unlimited` means, so it now
  // skips only the pacing checks below, never the "who is this" checks.

  const { data } = load(workspaceDir);
  const day = today(cfg);
  const spokeToday = data.last_spoke_day === day ? data.spoke_today || 0 : 0;

  // Owner rule: there is no daily quota. The counter is history only, never a
  // gate. Keeping a live cap here made dafeiyu read `30/30` and mute itself.

  const t = data.targets[target] || {};
  const isOwner = Array.isArray(cfg.ownerTargets) && cfg.ownerTargets.includes(target);
  // `unlimited` is the owner's "do not throttle me" switch. It suppresses the
  // PACING checks (buffer / cooldown / staleness), never the two identity checks
  // below: talking to a stranger on a schedule is a different failure than
  // talking too often, and the old code let `unlimited` skip both.
  const unlimited = cfg.unlimited !== false;

  // Who is this? Never open toward someone who has never spoken to us, and
  // never open cold toward someone we barely know — an unprompted message from
  // a near-stranger reads as spam, not friendliness. Both checks apply even when
  // pacing is unlimited. The configured owner is exempt from both: they are the
  // one person who always gets to hear from it.
  if (!isOwner) {
    if (!t.last_inbound_at) {
      return { allowed: false, reason: "never-heard-from-them", cfg };
    }
    // 0.35 matches the `close` threshold already used for 撒娇 and the warm
    // voice gears, so one number governs "acts like a friend toward them"
    // everywhere instead of drifting into a second definition.
    const minFam = Number(cfg.minFamiliarity ?? 0);
    // Only enforce when the caller actually supplies a familiarity reader. A
    // missing reader means this deployment has no relationship data, and
    // treating that as "everyone is a stranger" would refuse every target
    // instead of falling back to the older never-spoken-to rule above.
    if (minFam > 0 && typeof cfg.familiarityOf === "function") {
      // Familiarity lives in relations.json, not here — this module owns the
      // pacing state only. Reading it through the caller keeps the two files
      // from growing a second, drifting copy of the same number.
      const fam = Number(cfg.familiarityOf(target) ?? 0);
      if (!(fam >= minFam)) {
        return { allowed: false, reason: `not-close-enough(${fam.toFixed(2)}<${minFam})`, cfg };
      }
    }
  }

  if (unlimited) return { allowed: true, reason: "unlimited", cfg, spokeToday };

  if (t.last_inbound_at) {
    const sinceMin = (Date.now() - Date.parse(t.last_inbound_at)) / 60000;

    // Buffer: they are mid-conversation. Speaking now would talk over them.
    // Wait a few minutes, then it is a natural follow-up.
    if (sinceMin < (cfg.bufferMinutes ?? 5)) {
      return { allowed: false, reason: `buffer(${Math.round(sinceMin)}m<${cfg.bufferMinutes}m)`, cfg };
    }

    // Dead-chat guard. 0 (or negative) disables it entirely.
    // Owner's rule: if the other side goes quiet, dafeiyu may speak up.
    // A stale conversation is exactly the case where a follow-up is wanted,
    // so this must not silently mute it.
    const maxSilenceHours = Number(cfg.maxSilenceHours ?? 0);
    if (maxSilenceHours > 0) {
      const maxSilenceMin = maxSilenceHours * 60;
      if (sinceMin > maxSilenceMin) {
        return { allowed: false, reason: `too-stale(${Math.round(sinceMin / 60)}h>${maxSilenceHours}h)`, cfg };
      }
    }
  }

  if (t.last_proactive_at) {
    const sinceSpeakMin = (Date.now() - Date.parse(t.last_proactive_at)) / 60000;
    if (sinceSpeakMin < cfg.cooldownMinutes) {
      return { allowed: false, reason: `cooldown(${Math.round(sinceSpeakMin)}m<${cfg.cooldownMinutes}m)`, cfg };
    }
  }

  const live = data.pending.filter((p) => p.target === target && !isExpired(p, cfg));
  if (live.length) {
    return { allowed: false, reason: "already-pending", cfg };
  }

  return { allowed: true, reason: "ok", cfg, spokeToday };
}

function isExpired(p, cfg) {
  const at = p?.queued_at ? Date.parse(p.queued_at) : 0;
  return !at || Date.now() - at > ttlMs(cfg);
}

/**
 * Queue an impulse.
 * @param {object} o
 * @param {string} o.target      conversation target key
 * @param {string} o.kind        "topic" | "thought" | "share" | "checkin"
 * @param {string} o.text        what we would say, or the seed for it
 * @param {number} [o.value]     0..1 how much this is worth saying
 * @param {string} [o.source]    which signal produced it
 */
export function queue(workspaceDir, o = {}, cfgIn = {}) {
  const text = String(o.text || "").trim();
  if (!text) return { queued: false, reason: "empty-text" };

  // Dedupe first: repeating ourselves is worse than staying quiet, and this
  // answer is more useful than "already-pending" when both apply.
  const { file: dfile, data: ddata } = load(workspaceDir);
  const norm = normalize(text);
  if (
    ddata.history.some((h) => normalize(h.text) === norm) ||
    ddata.pending.some((p) => normalize(p.text) === norm)
  ) {
    return { queued: false, reason: "duplicate" };
  }

  const gate = evaluate(workspaceDir, o.target, cfgIn);
  if (!gate.allowed) {
    ddata.skipped[gate.reason.split("(")[0]] = (ddata.skipped[gate.reason.split("(")[0]] || 0) + 1;
    save(dfile, ddata);
    return { queued: false, reason: gate.reason };
  }

  const value = Number(o.value ?? 0.5);
  if (gate.cfg.requireValue && value < 0.3) {
    return { queued: false, reason: `low-value(${value})` };
  }

  const rec = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    target: o.target,
    kind: o.kind || "thought",
    text: text.slice(0, 400),
    value,
    source: o.source || "engine",
    queued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttlMs(gate.cfg)).toISOString(),
  };
  purgeExpired(ddata, gate.cfg);
  ddata.pending.push(rec);
  if (ddata.pending.length > 30) ddata.pending = ddata.pending.slice(-30);
  save(dfile, ddata);
  return { queued: true, impulse: rec };
}

/** Take the next impulse for a target and mark it consumed. Expired items are dropped, not sent. */
export function take(workspaceDir, target, cfgIn = {}) {
  const cfg = { ...DEFAULTS, ...cfgIn };
  const { file, data } = load(workspaceDir);
  purgeExpired(data, cfg);

  let idx = 0;
  if (target) {
    idx = data.pending.findIndex((p) => p.target === target);
    if (idx === -1) {
      save(file, data);
      return null;
    }
  }
  if (!data.pending[idx]) {
    save(file, data);
    return null;
  }
  const [rec] = data.pending.splice(idx, 1);

  const day = today(cfg);
  if (data.last_spoke_day !== day) {
    data.last_spoke_day = day;
    data.spoke_today = 0;
  }
  data.spoke_today = (data.spoke_today || 0) + 1;
  data.last_spoke_at = new Date().toISOString();

  const t = data.targets[rec.target] || {};
  t.last_proactive_at = data.last_spoke_at;
  t.proactive_count = (t.proactive_count || 0) + 1;
  data.targets[rec.target] = t;

  data.history.push({ ...rec, spoke_at: data.last_spoke_at });
  data.history = data.history.slice(-200);

  save(file, data);
  return rec;
}

export function pendingFor(workspaceDir, target, cfgIn = {}) {
  const cfg = { ...DEFAULTS, ...cfgIn };
  const { data } = load(workspaceDir);
  const live = data.pending.filter((p) => !isExpired(p, cfg));
  return target ? live.filter((p) => p.target === target) : live;
}

/**
 * Record that we actually spoke, outside the queued-impulse path.
 * Used by the message gate when dafeiyu sends on its own initiative.
 */
export function recordSpoken(workspaceDir, target, text, cfgIn = {}) {
  const cfg = { ...DEFAULTS, ...cfgIn };
  const { file, data } = load(workspaceDir);
  const day = today(cfg);
  if (data.last_spoke_day !== day) {
    data.last_spoke_day = day;
    data.spoke_today = 0;
  }
  const at = new Date().toISOString();
  data.spoke_today = (data.spoke_today || 0) + 1;
  data.last_spoke_at = at;
  // Which chat the last proactive line went to. The voice hint needs a target
  // to resolve familiarity against, and a heartbeat wake has no chat identity
  // of its own, so this is the only honest guess available.
  data.last_spoken_key = target;

  const t = data.targets[target] || {};
  t.last_proactive_at = at;
  t.proactive_count = (t.proactive_count || 0) + 1;
  data.targets[target] = t;

  data.history.push({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    target,
    kind: "direct",
    text: String(text || "").slice(0, 400),
    value: 0.5,
    source: "message-tool",
    queued_at: at,
    spoke_at: at,
  });
  data.history = data.history.slice(-200);
  save(file, data);
  return { ok: true, spokeToday: data.spoke_today };
}

/**
 * Is this an allowed outbound destination?
 * Only an exact targetKey or the exact configured address counts. Matching on
 * channel name alone would let any recipient on that channel through, so it is
 * deliberately not accepted.
 */
export function resolveTargetConfig(cfgIn, ...candidates) {
  const cfg = { ...DEFAULTS, ...cfgIn };
  const map = cfg.targets || {};
  const wanted = candidates.filter((c) => typeof c === "string" && c.trim());
  if (!wanted.length) return null;

  for (const key of Object.keys(map)) {
    const entry = map[key] || {};
    if (!entry.to) continue; // an entry without a destination is not usable
    if (wanted.some((c) => c === key || c === entry.to)) {
      return { key, ...entry };
    }
  }
  return null;
}

/**
 * When this target last spoke to us, as an ISO string.
 *
 * `status()` deliberately does not expose per-target timestamps, but the clock
 * line needs exactly this to say "隔了挺久" instead of inventing a gap. Reading
 * it here keeps the shape of `status()` unchanged for every other caller.
 */
/**
 * The target key this workspace last spoke proactively to, or null.
 * Used to give a heartbeat wake a plausible destination for per-chat state
 * (familiarity, and which chat a send would go to) when nobody is addressing it.
 */
export function lastSpokenKey(workspaceDir) {
  try {
    const { data } = load(workspaceDir);
    if (typeof data.last_spoken_key === "string") return data.last_spoken_key;
    // No proactive line has ever gone out, so there is no "last spoken" chat to
    // fall back on. Use whichever known target talked to us most recently
    // instead: it is still a real chat with a real cooldown bucket, and it is
    // the only destination where speaking unprompted is not a cold approach.
    let best = null;
    let bestAt = 0;
    for (const [key, t] of Object.entries(data.targets || {})) {
      const at = Date.parse(t?.last_inbound_at || "");
      if (Number.isFinite(at) && at > bestAt) {
        bestAt = at;
        best = key;
      }
    }
    return best;
  } catch {
    return null;
  }
}

export function lastInboundAt(workspaceDir, target) {
  if (!target) return null;
  const { data } = load(workspaceDir);
  const rec = data?.targets?.[target];
  return rec?.last_inbound_at || null;
}

export function status(workspaceDir, cfgIn = {}) {
  const cfg = { ...DEFAULTS, ...cfgIn };
  const { data } = load(workspaceDir);
  const day = today(cfg);
  const live = data.pending.filter((p) => !isExpired(p, cfg));
  const gateCache = {};
  for (const target of Object.keys(data.targets)) {
    gateCache[target] = evaluate(workspaceDir, target, cfg).reason;
  }
  return {
    cfg,
    zone: cfg.timeZone,
    localHour: hourInZone(cfg.timeZone),
    quietNow: inQuietHours(cfg),
    spokeToday: data.last_spoke_day === day ? data.spoke_today || 0 : 0,
    lastSpokeAt: data.last_spoke_at,
    pending: live.length,
    expired: data.pending.length - live.length,
    targets: Object.keys(data.targets).length,
    gates: gateCache,
    skipped: data.skipped,
    historySize: data.history.length,
  };
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, "")
    .slice(0, 200);
}
