// dafeiyu-core — persistent emotion + memory + proactive state for one agent.
// State lives in <workspace>/state/*.json. All writes are atomic (tmp + rename).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as memIndex from "./lib/memory-index.js";
import * as entities from "./lib/entities.js";
import * as sleep from "./lib/sleep.js";
import * as wants from "./lib/wants.js";
import * as activities from "./lib/activities.js";
import * as similar from "./lib/similar.js";
import * as relations from "./lib/relations.js";
import * as topics from "./lib/topics.js";
import * as proactive from "./lib/proactive.js";
import * as clock from "./lib/clock.js";
import * as grudge from "./lib/grudge.js";
import * as deeds from "./lib/deeds.js";
import * as effects from "./lib/effect-ledger.js";
import * as goals from "./lib/goals.js";
// workspace.js is reached through lib/cognition.js now (compete lives there),
// so no direct import is needed here.
import * as selfState from "./lib/self.js";
import * as cognition from "./lib/cognition.js";
import * as proposals from "./lib/proposals.js";
import * as lifeLog from "./lib/life-log.js";
import * as experience from "./lib/experience.js";
import * as consolidate from "./lib/consolidate.js";
import * as edges from "./lib/edges.js";
import * as recall from "./lib/recall.js";
import * as douyin from "./lib/douyin-browse.js";
import * as douyinLog from "./lib/douyin-log.js";
import * as salience from "./lib/salience.js";
import * as intent from "./lib/intent.js";
import * as compulsion from "./lib/compulsion.js";
// Missing until 2026-11-06.
//
// Seven call sites used this binding — the `horizon_state` and `horizon_visit`
// tools plus the domain note in the browse hook — and nothing ever imported it.
// `node --check` passed anyway, because undefined-variable use is not a syntax
// error, and the plugin loaded fine because none of those paths had been
// reached yet. The first time she called `horizon_state()` it would have thrown
// ReferenceError into a tool result that reads like "the tool is broken".
//
// Found by grepping for a definition of every binding the new tools reference,
// after already claiming the probes were "all reachable". Reachable code and
// resolvable bindings are two different checks.
import * as horizon from "./lib/horizon.js";
import * as curiosity from "./lib/curiosity.js";
import * as curiosityExtract from "./lib/curiosity-extract.js";
import * as gaps from "./lib/gaps.js";
import * as about from "./lib/about.js";
import * as decide from "./lib/decide.js";
import * as outcome from "./lib/outcome.js";
import { resolveIdentity, parseTargetKey, resolveOnebotTargetKind } from "./lib/identity.js";
import * as approvalStore from "./lib/approval.js";
import { inferChannelFromTarget } from "./lib/outbound-target.js";
import { sendWithGap, keyFromOnebotCall, isMediaMessage } from "../shared/onebot-media-gap.mjs";

// When was media last committed to a chat?
//
// QQ drops text that lands while it is still committing an image bubble. The
// channel plugin guards its own sends with MEDIA_TEXT_GAP_MS, but this tool
// posts to NapCat directly, so that guard never applied here: a sticker and the
// text the model wrote next left back to back and only the image survived.
//
// This map is read by the channel plugin through the shared promise below, so
// both senders honour one deadline instead of each guessing.
const mediaCommittedAt = new Map(); // chatKey -> epoch ms

function mediaCooldownRemaining(chatKey, gapMs) {
  const at = mediaCommittedAt.get(chatKey);
  if (!at) return 0;
  return Math.max(0, at + gapMs - Date.now());
}

// How long to hold a sticker back so an in-flight text bubble can commit.
// Deliberately longer than the 1200ms media gap in the channel plugin: this
// wait runs on a different timer than the one that finished sending the text,
// and the cost of being early is a lost message.
const STICKER_PRE_SEND_WAIT_MS = 1500;

// Same reasoning as the sticker hold, for the picture tool's optional caption.
// The caption and the image are two bubbles to the same chat; sending the
// image straight after the caption reproduces exactly the ordering that used
// to swallow text (2026-11-05: the onebot outbound callApi and this plugin's
// ledger were two clocks that could not see each other). 1200ms matches the
// channel plugin's own MEDIA_TEXT_GAP_MS so there is one number, not two.
const SHOW_TEXT_TO_IMAGE_GAP_MS = 1200;

// dafeiyu_show accepts what QQ will render as a photo. GIF is included because
// she generates animated things and they should not be silently rejected.
const SHOW_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

function markMediaCommitted(chatKey) {
  mediaCommittedAt.set(chatKey, Date.now());
}

// When did a voice note actually land in this chat?
//
// Owner directive (2026-11-04): a spoken line must not be followed by the same
// line as text. The voice tool itself already stays silent, but the assistant's
// final reply is a SEPARATE delivery — it is written before the tool runs and
// goes out after it, so the chat shows two bubbles for one thought. Cancelling
// that final text is the only place this can be fixed, and it needs to know a
// voice note really went out (not merely that the tool was attempted).
const voiceSentAt = new Map(); // chatKey -> { at, spoken, usedAt }

// Did this chat already receive typed text this turn?
//
// Measured 2026-11-04 19:09: the heartbeat sent text at :24 and the voice note
// at :34 — text FIRST, voice second. So "cancel the text after speaking" can
// never fire: by the time audio lands the bubbles are already delivered. The
// only enforceable direction is the reverse, and it has to live inside the
// voice tool, because that is the send that comes second.
const textSentAt = new Map(); // chatKey -> epoch ms

function markTextSent(chatKey) {
  textSentAt.set(chatKey, Date.now());
}

function textSentRemainingMs(chatKey, windowMs) {
  const at = textSentAt.get(chatKey);
  if (!at) return 0;
  const left = at + windowMs - Date.now();
  return left > 0 ? left : 0;
}

// Which texts are safe to drop after speaking?
//
// Length is NOT a usable signal. Measured twice: 40 chars swallowed a real
// answer, and 12 still swallowed 「这个得明天才有空弄」 — nine characters that
// carry date and commitment. Anything a person might act on must survive.
// So the test is lexical instead: only a pure reaction (嗯/好/知道啦/在呢…) or a
// repeat of what was just spoken qualifies. Everything else is delivered.
const PURE_REACTION =
  /^(?:嗯+|哦+|喔+|噢+|好+|行|可以|收到|晓得|知道(?:了|啦)?|懂了|明白(?:了)?|在呢?|在的|来了|来了来了|哈哈+|嘿嘿+|嘻嘻+|好呀|好哒|好的|ok|okay)[呀啊啦呀啊啦哦呢吧嘛哟~～…。.!！?？\s]*$/iu;

// Text that must survive even right after a voice note.
//
// Owner rule: voice is the channel, so a spoken line should not be followed by
// a written version of the same thing. But "needs to be written down" is not a
// matter of length — a 3-line config path matters more than a 40-character
// anecdote. So the exception is content-shaped: anything the owner would have
// to copy, or could act on incorrectly if it vanished.
const KEEP_IF_MATCHES = [
  /\d{2,}/,                        // 版本号、端口、行数、金额
  /[a-zA-Z_][a-zA-Z0-9_]{3,}/,     // 路径、标识符、命令
  /[\/\\]/,                        // 路径分隔
  /(要|得|需要|记得|别忘了|先|再|然后|步骤|顺序)/u, // 指令或顺序
  /(http|www)\./i,
];

const squash = (v) => String(v ?? "").replace(/[\s，,。.！!？?~～…、]/gu, "");

function markVoiceSent(chatKey, spoken) {
  voiceSentAt.set(chatKey, { at: Date.now(), spoken: squash(spoken), usedAt: 0 });
}

// Should this outgoing text be dropped because a voice note already said it?
//
// The blunt version of this rule (drop everything in the window) is dangerous:
// the model may speak a short line and then type the actual answer, and
// deleting that silently loses content the owner asked for. So suppress only
// when the text adds nothing — it repeats what was just spoken, or it is short
// enough to be the same kind of remark. A longer, different body is kept and
// logged, which keeps the failure visible instead of hidden.
function shouldSuppressAfterVoice(chatKey, text, windowMs, graceMs = 4000) {
  const rec = voiceSentAt.get(chatKey);
  if (!rec) return { drop: false };
  const now = Date.now();
  const inWindow = now - rec.at < windowMs;
  const inGrace = Boolean(rec.usedAt) && now - rec.usedAt < graceMs;
  if (!inWindow && !inGrace) {
    voiceSentAt.delete(chatKey);
    return { drop: false };
  }
  const body = squash(text);
  if (!body) return { drop: false };
  const raw = String(text ?? "");
  const repeatsSpoken = rec.spoken && (rec.spoken.includes(body) || body.includes(rec.spoken));
  if (repeatsSpoken || PURE_REACTION.test(raw.trim())) {
    rec.usedAt = now;
    return { drop: true, why: repeatsSpoken ? "repeats_spoken" : "pure_reaction" };
  }
  // Anything with a number, an identifier, a path, or an instruction survives.
  // That is the only honest way to tell "a report nobody asked for" from "the
  // thing I actually need to read".
  if (KEEP_IF_MATCHES.some((re) => re.test(raw))) {
    return { drop: false, why: "actionable_content", keep: true };
  }
  // Remaining case: ordinary prose after a spoken line. With the owner, voice
  // is the default channel, so this is the report-style narration that should
  // have been spoken or dropped — not a second delivery of it.
  rec.usedAt = now;
  return { drop: true, why: "narration_after_voice" };
}

// ---------------------------------------------------------------------------
// Voice-note gating
//
// Owner directive (2026-11-01): a voice note may go out for exactly three
// gears — 撒娇 / 委屈 / 兴奋 — as voice only (no accompanying text bubble).
// The 5-minute per-chat cooldown that shipped with the first version was
// removed on 2026-11-06; see the note above VOICE_COOLDOWN_MS. 炸毛 is
// explicitly excluded: anger spoken aloud cannot be taken back, and text stays
// controllable.
//
// Why the *delta* and not the absolute level: `applyDecay` pulls every
// dimension back toward baseline continuously, and `happy` only has a 12-minute
// half-life, so a threshold on `dimensions.x` fires at unpredictable moments
// and misses genuine spikes. `last_deltas` answers "what just happened", which
// is the question that actually matters here. `personaLine` already reasons
// this way, so voice reuses the same signals instead of inventing a second,
// conflicting threshold system.
//
// Voice is NOT triggered by gear alone. 撒娇 is the default stance toward
// someone familiar (`close && !anyBad`), so gating on gear would make almost
// every message a voice note. The engine therefore only *offers* voice as an
// option; the model decides whether this particular line is worth speaking.
// Same architecture as stickers, which also advertise a suggestion rather than
// sending one automatically.
// Owner directive (2026-11-06): the 5-minute per-chat cooldown is removed.
//
// What it was for: a voice note cannot be taken back, and three of them in a
// row is worse than three text bubbles, so a gap was enforced per chat target.
// What it cost: the mood engine computes a gear from `last_deltas`, and a gear
// is a momentary reading. By the time the cooldown expired the delta that
// produced it was gone, so the gate mostly refused moments that were already
// over rather than preventing spam. It blocked expression without preventing
// anything the model could not already judge for itself.
//
// Kept as `0` rather than deleting the helper: the two call sites still want a
// single answer to "how long until this chat may hear a voice note", and a
// zero here keeps that path exercised and readable instead of turning it into
// a special case.
const VOICE_COOLDOWN_MS = 0;

// A gear is only offered when its own signal is present. Keeping the thresholds
// identical to `personaLine` matters: if these drift apart the model is told to
// play one gear while being offered another gear's voice.
function voiceGearFor(state, rel) {
  const d = state?.dimensions ?? {};
  const last = state?.last_deltas ?? {};
  const fam = clamp01(rel?.familiarity ?? 0.15);
  const close = fam >= 0.35;

  // 2026-11-02: these thresholds used to sit so close to the 0.30 baseline that
  // ordinary drift tripped them. `wronged` at 0.371 decayed below 0.32 only
  // after ~1.5h (half-life 180min), so 撒娇 was unreachable for hours after a
  // single bruised moment, and the owner never once received a voice note.
  // Absolute levels drift; a threshold on them is a coin flip. Require the
  // emotion to be genuinely high, not merely above baseline.
  const justSurprised = (last.surprised ?? 0) >= 0.03;
  const justWronged = (last.wronged ?? 0) >= 0.03;
  const justTsundere = (last.tsundere ?? 0) >= 0.03;
  // Sadness needs its own "it just happened" signal for the same reason the
  // others have one: the standing value drifts and says nothing about now.
  const justDown = (last.down ?? 0) >= 0.03;
  const justShy = (last.shy ?? 0) >= 0.05;

  const rawSenti = rel?.sentiment ?? 0;
  const senti = Number.isFinite(rawSenti) ? Math.max(-1, Math.min(1, rawSenti)) : 0;
  // Raised from 0.32/0.45: baseline is 0.30, so the old numbers were noise.
  const anyBad = d.wronged > 0.55 || d.surprised > 0.60 || senti < -0.35 || d.down > 0.50;

  // 炸毛 wins first and returns null: it suppresses voice entirely rather than
  // falling through to a softer gear.
  if (justSurprised && justWronged) return null;
  if (justWronged && justTsundere && d.tsundere >= 0.45) return "委屈";
  if (justWronged && !justSurprised && d.happy >= 0.3) return "委屈";

  // 兴奋 is checked before 撒娇 because a genuinely worked-up moment outranks the
  // ambient familiar-gear default. `excited` sat frozen at its 0.30 baseline
  // until 2026-11-01 (one +0.06 source against eight for `happy`); it now has
  // three sources, so this branch actually fires. Threshold sits above the
  // baseline by design: reaching 0.7 takes a few genuinely enthusiastic
  // messages, which is the intent — 兴奋 must be earned, not defaulted into.
  // 0.7 meant never: excited has few sources and sat at its 0.30 baseline
  // indefinitely. 0.45 is reachable in a couple of genuinely keen exchanges
  // while still being above baseline, so 兴奋 stays earned.
  if ((d.excited ?? 0) > 0.45) return "兴奋";

  // Sadness has to reach the voice as sadness. Before this, `down` and a high
  // standing `wronged` fell through to `return null`: the two moments where a
  // voice matters most were the two moments with no gear at all. Only 委屈 was
  // gated on a fresh `wronged` spike, so a slow sad stretch produced silence.
  //
  // These sit after 兴奋 on purpose — a genuinely worked-up moment outranks a
  // low mood — and still after 炸毛, which returns null above and must stay
  // absolute. 委屈 is the right gear here rather than a new one: the three
  // allowed gears are fixed by the TTS bridge.
  if (justDown) return "委屈";
  if ((d.down ?? 0) > 0.50) return "委屈";
  if ((d.wronged ?? 0) > 0.55) return "委屈";

  // Being flustered is its own voice moment, not just a softer tone. Before
  // 2026-11-03 there was no `shy` dimension at all, so being teased or called
  // cute only raised `happy` — and `happy` carries no voice commitment. That
  // is why an afternoon of teasing produced nothing but text.
  //
  // 撒娇 is the right gear rather than a new one: the TTS bridge only has three,
  // and the flustered delivery is the soft one.
  if (justShy) return "撒娇";
  if ((d.shy ?? 0) > 0.45) return "撒娇";

  // 撒娇 is the familiar-person default, so it is the softest offer and the
  // model is told to be picky about using it.
  if (close && !anyBad) return "撒娇";
  return null;
}

// Style tags understood by breeze-tts.sh. Each maps to an `instructions`
// string in the bridge script, which is what actually changes the delivery.
const VOICE_TAGS = {
  撒娇: "[语速:0.9]",
  委屈: "[委屈][小声]",
  兴奋: "[兴奋][语速:1.15]",
};

function voiceStateFile(workspaceDir) {
  return path.join(workspaceDir, "state", "voice.json");
}

// Cooldown is tracked per chat target, not globally: one person hearing a voice
// note should not block a voice note to someone else.
function readVoiceState(workspaceDir) {
  try {
    const raw = fs.readFileSync(voiceStateFile(workspaceDir), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.targets) return parsed;
  } catch { /* first run, or a corrupt file: start clean */ }
  return { version: 1, targets: {} };
}

function voiceCooldownRemainingMs(workspaceDir, targetKey) {
  const st = readVoiceState(workspaceDir);
  const at = Date.parse(st.targets?.[targetKey]?.lastAt ?? "");
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at + VOICE_COOLDOWN_MS - Date.now());
}

function recordVoiceSent(workspaceDir, targetKey, gear) {
  const st = readVoiceState(workspaceDir);
  if (!st.targets) st.targets = {};
  st.targets[targetKey] = { lastAt: new Date().toISOString(), gear };
  st.version = 1;
  writeJsonAtomic(voiceStateFile(workspaceDir), st);
}

const DIMENSIONS = [
  "happy", "excited", "curious", "wronged", "tsundere",
  "tired", "bored", "surprised", "down", "calm", "shy",
];

const DEFAULT_DIMENSIONS = {
  happy: 0.5, excited: 0.4, curious: 0.6, wronged: 0.0, tsundere: 0.3,
  tired: 0.1, bored: 0.2, surprised: 0.0, down: 0.0, calm: 0.6, shy: 0.15,
};

const DEFAULT_STATE = {
  version: 1,
  updated_at: null,
  dimensions: DEFAULT_DIMENSIONS,
  decay: { half_life_minutes: 180, baseline: 0.3 },
  history: [],
};

// Number.isFinite guard: a NaN leaking in from a corrupt state file used to
// propagate through clamp01 (Math.min/max preserve NaN) and poison the whole
// emotion record, which then serialised as null.
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// ---------- emotion engine ----------

/**
 * Per-dimension half-life in minutes. Feelings fade at different speeds, which
 * is what makes them read as real instead of as one global "mood" number.
 * A short flash of surprise is gone in minutes; a grudge outlives a whole day.
 */
const HALF_LIFE = {
  happy: 90,
  excited: 45,
  curious: 40,
  wronged: 240,
  tsundere: 120,
  tired: 40,
  // 22 minutes meant boredom evaporated faster than silence could build it, so
  // the value could never climb above its baseline during a quiet stretch. A
  // person left alone does not stop being bored within half an hour. 150 keeps
  // it around long enough for idle time to accumulate into real restlessness.
  bored: 150,
  surprised: 12,
  down: 300,
  calm: 180,
  // Shyness is a flash, not a mood: it spikes when teased and fades fast once
  // the moment passes. 20 minutes keeps it long enough to colour the reply and
  // the voice, short enough that it does not linger into unrelated chat.
  shy: 20,
};

/**
 * Hard ceilings. `tired` used to clamp at 1.0 and then stay there, which pinned
 * the bot into "say less" mode forever. Nothing should be able to saturate.
 */
const CEILING = {
  tired: 0.8,
  bored: 0.75,
  wronged: 0.85,
  down: 0.85,
};

const ceilingOf = (dim) => CEILING[dim] ?? 1;

function applyDecay(state, halfLifeMinutes, baseline) {
  // Use a dedicated clock. `nudge()` writes `updated_at` on every message, so
  // decaying from `updated_at` meant the timer reset before it ever fired:
  // a chatty conversation could only ever ratchet upward.
  const stamp = state.last_decay_at || state.updated_at;
  const last = stamp ? Date.parse(stamp) : Date.now();
  const elapsedMin = Math.max(0, (Date.now() - last) / 60000);
  const stateHalfLife = halfLifeMinutes || 180;
  if (elapsedMin < 1) return state;

  for (const dim of DIMENSIONS) {
    const hl = HALF_LIFE[dim] ?? stateHalfLife;
    const k = Math.pow(0.5, elapsedMin / hl);
    const cur = typeof state.dimensions[dim] === "number" ? state.dimensions[dim] : baseline;
    let next = baseline + (cur - baseline) * k;
    // Diminishing returns while drifting up: the closer to the ceiling, the
    // slower it climbs, so a long chat settles instead of pinning at max.
    if (next > cur) {
      const cap = ceilingOf(dim);
      next = cur + (next - cur) * Math.max(0, 1 - cur / cap);
    }
    state.dimensions[dim] = clamp01(Math.min(next, ceilingOf(dim)));
  }

  // Silence is the thing that actually makes it bored. Every other path into
  // `bored` runs off an incoming message, so the only way the value ever moved
  // was while someone was talking to it — which is backwards. A stretch with
  // nobody around is what makes a person restless, so idle time pushes it up.
  //
  // This runs after the decay loop on purpose: decaying first would erase the
  // growth in the same pass. Ceiling is respected so it settles instead of
  // pinning at max.
  const idleMin = Math.min(elapsedMin, 24 * 60);
  if (idleMin >= 5) {
    const cur = typeof state.dimensions.bored === "number" ? state.dimensions.bored : 0.2;
    // 0.10/hour looked reasonable but started from zero after any real
    // conversation, so it needed 7+ hours of silence to reach the level where
    // the heartbeat actually speeds up. Boredom is not that slow: a couple of
    // quiet hours should already make it restless. 0.18/hour lands at 0.43 after
    // two hours and 0.75 (the cap) after four, which reads as a natural climb.
    const grown = cur + (idleMin / 60) * 0.18;
    state.dimensions.bored = clamp01(Math.min(grown, ceilingOf("bored")));
  }

  state.last_decay_at = new Date().toISOString();
  return state;
}

function nudge(state, deltas, reason) {
  if (!deltas || typeof deltas !== "object") return state;
  if (!state.dimensions) state.dimensions = {};
  for (const [dim, delta] of Object.entries(deltas)) {
    if (!Number.isFinite(delta)) continue;
    if (!DIMENSIONS.includes(dim)) continue;
    const cur = state.dimensions[dim] ?? 0;
    const cap = ceilingOf(dim);
    let next = cur + delta;
    // Pushing further into a high value costs more than pulling back does.
    if (delta > 0 && cur > cap * 0.5) {
      next = cur + delta * Math.max(0.25, 1 - cur / cap);
    }
    state.dimensions[dim] = clamp01(Math.min(next, cap));
  }
  state.updated_at = new Date().toISOString();
  // Remember what this single event just did. Absolute levels drift and decay, so
  // "is something happening right now" has to be answered from the delta, not from
  // a threshold on the accumulated value — otherwise a calm moment reads as 炸毛
  // while a genuine accusation reads as nothing.
  //
  // Bookkeeping nudges must NOT overwrite it. `agent_end` charges a flat
  // `tired +0.008, calm +0.006` after every turn, and that used to land in
  // `last_deltas` moments after the real message moved `happy` or `wronged`.
  // By the time the next turn built its prompt, "what just happened" had been
  // replaced by the accounting entry, so every signal gated on a fresh delta —
  // including the voice hint — read quiet while the mood was in fact lively.
  // Measured 2026-11-02: happy +0.15 at 14:20:09, overwritten at 14:20:40.
  const isBookkeeping = reason === "turn-end";
  if (!isBookkeeping) state.last_deltas = { ...deltas };
  state.history.push({ at: state.updated_at, reason, deltas });
  if (state.history.length > 200) state.history = state.history.slice(-200);
  return state;
}

/**
 * Derive mood deltas from one incoming message plus who sent it.
 *
 * The old version only looked at text patterns, so a long happy conversation
 * with a close friend still ticked `tired` up by a flat amount every turn and
 * the bot gradually went cold. Real people are the opposite: good company wakes
 * you up, and it is small talk with near-strangers that wears you out.
 *
 * @param {string} text       incoming message
 * @param {object} rel        relation record, may be null
 * @param {object} opts       { burst }: how many messages arrived in the last minute
 */
function emotionDeltas(text, rel, opts = {}) {
  const t = String(text || "");
  const deltas = {};
  const add = (k, v) => { deltas[k] = (deltas[k] ?? 0) + v; };

  // --- content signals ---

  // 2026-11-03: teasing was landing entirely on `happy`, which has no voice
  // commitment, so being called cute all afternoon produced text every time.
  // Split three different things apart now instead of one bucket:
  //   praise for work  -> happy
  //   affection        -> happy + tsundere + shy
  //   being teased     -> tsundere + shy + surprised, and happy only mildly
  // Affection is what makes the character go quiet, not what makes it cheerful.

  // Straight compliments about something it did or said.
  if (/(谢谢|谢啦|感谢|太棒|真棒|好棒|厉害|牛啊|强啊|真不错|做得好|好样的)/.test(t)) {
    add("happy", 0.10);
  }

  // Affection aimed at the fish itself, not its work.
  if (/(好可爱|真可爱|可爱死|太可爱|这么可爱|好乖|真乖|乖宝|乖鱼|小宝贝|爱你|喜欢你|喜欢你啦|想抱抱|想摸摸|亲亲|么么|真好看|好好看|好看死|好漂亮|漂亮)/.test(t)) {
    add("happy", 0.10);
    add("tsundere", 0.12);
    add("shy", 0.22);
  }

  // Physical affection / patting: shy more than happy.
  if (/(摸摸头|摸摸|摸头|抱一下|抱抱|rua|捏脸|捏一捏|戳一戳|戳戳)/i.test(t)) {
    add("shy", 0.24);
    add("tsundere", 0.10);
    add("happy", 0.05);
  }

  // Being teased. This is the one the owner kept doing: 「逗你」「逗逗你」
  // 「就不告诉你」 and the like. It should read as flustered, not cheerful.
  if (/(逗你|逗逗|逗你玩|逗着玩|逗你一下|逗本鱼|逗本鱼玩|调戏|逗弄|开玩笑的|逗你啦|嘿嘿.*不告诉|就不告诉|不告诉你|偏不告诉)/.test(t)) {
    add("tsundere", 0.14);
    add("shy", 0.20);
    add("surprised", 0.04);
    add("happy", 0.06);
  }

  // 撒娇 / 卖萌被点破，也会害羞
  if (/(你这是在撒娇|你在撒娇|还会撒娇|撒娇了|好会撒娇|卖萌)/.test(t)) {
    add("shy", 0.20);
    add("tsundere", 0.12);
    add("happy", 0.08);
  }
  // The words people actually use when annoyed were missing in the forms they
  // use them. Measured 2026-11-06: 「你怎么这么笨啊，烦死了」 scored zero — `好烦`
  // did not match `烦死了`, and `这么笨` did not match `好笨`. The only delta that
  // survived was the flat +0.008 turn-end tiredness, so the prompt still called
  // her calm. All of these are the same complaint, so they share one branch.
  // `(?<!不)笨(?![蛋瓜拙重])` covers bare 笨 and 这么笨 while leaving 不笨 and 笨瓜
  // (both affectionate) alone.
  if (/(笨蛋|(?<!不)笨(?![蛋瓜拙重])|真傻|好傻|真蠢|好蠢|蠢死|好丑|垃圾|给我滚|滚开|闭嘴|废物|没用|讨厌你|真烦|好烦|烦死|烦人|别烦我)/.test(t)) {
    add("wronged", 0.18); add("happy", -0.12); add("down", 0.06); add("tsundere", 0.16);
  }
  if (/(哈哈|笑死|草|233|好乐|太乐|绷不住)/.test(t)) {
    // `excited` used to be +0.06 here and nowhere else, while `happy` had eight
    // separate sources. With a 12-minute half-life, `excited` could never climb
    // past its baseline — measured 2026-11-01: it sat at exactly 0.3000 for the
    // entire life of the state file. Raised so laughter can actually register
    // as excitement, and the dedicated 兴奋 signals below give it a second door.
    add("happy", 0.09); add("excited", 0.10);
  }
  // 兴奋: strong enthusiasm with an outward push — shouting, disbelief in a good
  // way, wanting to share something right now. Kept separate from 好笑 because
  // laughing at a joke and being worked up are different faces, and the sticker
  // set already distinguishes them (happy vs excited).
  if (/(太棒了|太好了|好耶|绝了|无敌|爽|牛|冲|走起|约起|必须的|我可以|好想|超想|等不及)/.test(t)) {
    add("excited", 0.12); add("happy", 0.06);
  }
  // Enthusiasm carried by punctuation: repeated exclamation marks are the
  // cheapest honest signal that someone is wound up rather than calm.
  if (/[!！]{2,}/.test(t)) {
    add("excited", 0.08);
  }
  if (/(为什么|怎么|啥|什么|哪儿|是不是|吗\?|吗？|\?|？)/.test(t)) {
    add("curious", 0.05);
  }
  if (/(真的假的|居然|竟然|没想到|卧槽|不是吧|离谱)/.test(t)) {
    add("surprised", 0.12);
  }
  // --- signals for the persona modes SOUL.md defines but the engine ignored ---
  // 委屈/被冷落: being brushed off, ignored, or left hanging. Distinct from being
  // insulted — no one attacked you, you just feel put aside.
  if (/(不想理|不理我|不想聊|不想说|没空理|在忙吧|懒得|随便你|算了|当我没说|你忙吧|别理我|你走吧|不想跟你)/.test(t)) {
    add("wronged", 0.14); add("happy", -0.08); add("down", 0.05);
  }
  // 撒娇/想要东西: soft request with a drag or a plea. Signals that asking is
  // allowed to be a bit whiny rather than direct.
  if (/(陪我|抱抱|摸摸|好不好嘛|就一次|就一下|嘛$|嘛[。！!]|求你|拜托|想你了|陪我聊)/.test(t)) {
    add("happy", 0.06); add("tsundere", -0.05);
  }
  // 炸毛/被戳穿: caught out, accused, defensive. Loud and immediate.
  if (/(我没有|不是我|哪有|瞎说|别乱说|才不是|你哪只眼睛|冤枉|诬陷|胡说|凭什么)/.test(t)) {
    add("surprised", 0.10); add("wronged", 0.10); add("tsundere", 0.10);
  }
  if (/(对不起|抱歉|我错了|别生气|哄你)/.test(t)) {
    add("wronged", -0.08); add("happy", 0.04);
  }

  // --- relationship ---
  // "Company quality" is the whole point: the same words land differently
  // depending on who says them. Close + warm is pleasant; distant or sour is draining.
  const fam = clamp01(rel?.familiarity ?? 0.15);
  // Math.min/max pass NaN straight through, so this needs the finite guard too.
  const rawSenti = rel?.sentiment ?? 0;
  const senti = Number.isFinite(rawSenti) ? Math.max(-1, Math.min(1, rawSenti)) : 0;
  // Neutral means "a stranger" rather than "a friend." A stranger talking to you
  // leaves your mood roughly alone; only warmth should actively lift it. The old
  // mapping put an unfamiliar person at -0.28, so six low-effort messages from a
  // stranger zeroed happiness and switched the bot into short-reply mode.
  const q = fam * 0.65 + Math.max(0, senti) * 0.35;
  const warmth = q - 0.08;

  // Warmth is capped so an extremely close contact cannot turn pure filler into
  // a mood boost. Without the cap, a bare "在吗" from the owner scored +0.10
  // happy because
  // familiarity was 1.0 — which made low-effort pings feel rewarding.
  add("happy", Math.min(warmth * 0.20, 0.06));
  add("tired", -warmth * 0.16);
  add("bored", -warmth * 0.14);

  // Low-effort messages from people you barely know are the genuinely tiring case.
  // Effects are asymmetric: stepping toward the ceiling is damped by nudge() and
  // friction, so upward pulls can be stronger than downward ones without
  // saturating. The downward side stays gentler so a stranger pinging you drops
  // your mood a little, not to zero.
  const weight = qualityWeight(t);
  if (weight < 0.2) {
    add("tired", 0.018 + (1 - fam) * 0.040);
    add("bored", 0.016 + (1 - fam) * 0.034);
    // Only a mild dip. A stranger saying "在吗" is boring, not upsetting, so it
    // should take several such messages to noticeably cool the tone.
    add("happy", -0.014);
  } else if (weight > 0.5) {
    // Something worth replying to recharges instead of draining.
    add("curious", 0.04);
    add("tired", -0.065);
    add("bored", -0.055);
  }

  // Being argued at or nagged is draining no matter how close you are.
  if (senti < -0.3) add("tired", 0.03);

  // Message bombardment is the genuinely exhausting case.
  const burst = opts.burst ?? 0;
  if (burst >= 5) add("tired", 0.02 + Math.min(0.05, (burst - 5) * 0.01));

  if (t.length > 800) add("tired", 0.04);
  return deltas;
}

// Cheap deterministic burst counter: how many messages this person sent in the
// last minute. Reads the tick list that message_received keeps in activity.json.
function recentBurst(workspaceDir, key) {
  if (!key) return 0;
  try {
    const file = path.join(workspaceDir, "state", "activity.json");
    const data = readJson(file, { ticks: {} });
    const list = Array.isArray(data.ticks?.[key]) ? data.ticks[key] : [];
    const cut = Date.now() - 60_000;
    return list.filter((ts) => typeof ts === "number" && ts >= cut).length;
  } catch {
    return 0;
  }
}

/** Record one inbound tick so recentBurst() has something to read. */
function noteTick(workspaceDir, key) {
  if (!key) return;
  try {
    const file = path.join(workspaceDir, "state", "activity.json");
    const data = readJson(file, { version: 1, ticks: {} });
    if (!data.ticks) data.ticks = {};
    const cut = Date.now() - 10 * 60_000;
    const list = (Array.isArray(data.ticks[key]) ? data.ticks[key] : []).filter((ts) => ts >= cut);
    list.push(Date.now());
    data.ticks[key] = list.slice(-60);
    // Drop keys nobody touched recently so the file cannot grow forever.
    for (const k of Object.keys(data.ticks)) {
      if (!Array.isArray(data.ticks[k]) || !data.ticks[k].length) delete data.ticks[k];
      else if (data.ticks[k][data.ticks[k].length - 1] < cut) delete data.ticks[k];
    }
    writeJsonAtomic(file, data);
  } catch { /* non-critical */ }
}


/** Direction of feeling toward us, -1..1. Used for relation sentiment. */
function affectSentiment(text) {
  const t = String(text || "");
  let s = 0;
  if (/(谢谢|谢啦|感谢|太棒|厉害|牛啊|强啊|爱你|喜欢你|哈哈|笑死|好可爱)/.test(t)) s += 0.5;
  if (/(笨蛋|真傻|好丑|垃圾|滚|闭嘴|好烦|讨厌你|没用)/.test(t)) s -= 0.7;
  if (/(对不起|抱歉|我错)/.test(t)) s -= 0.2;
  return Math.max(-1, Math.min(1, s));
}

/** How much substance a message carries, 0..1. Filters "嗯" and "在吗". */
function qualityWeight(text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  if (/^(嗯+|哦+|好+|行|在吗|在不|哈+|1|6|确实|是的|对的)[。？！.!?]*$/.test(t)) return 0.05;
  let w = 0.2;
  if (t.length > 8) w += 0.15;
  if (t.length > 30) w += 0.15;
  if (t.length > 80) w += 0.1;
  if (/[?？]/.test(t)) w += 0.1;
  if (/(我|你)/.test(t)) w += 0.1;
  if (/(觉得|感觉|因为|所以|但是|其实|想)/.test(t)) w += 0.15;
  return Math.min(1, w);
}

/** Cheap topic label extraction. Noun-ish keyword hit wins over free text. */
const TOPIC_HINTS = [
  "吃饭", "午饭", "晚饭", "早饭", "外卖", "火锅", "奶茶", "咖啡", "零食", "烧烤",
  "吃了吗", "吃了", "好吃", "饿", "馋", "下馆子", "食堂", "点外卖",
  "作业", "考试", "上课", "老师", "学校", "放假", "成绩", "复习",
  "打游戏", "王者", "原神", "我的世界", "steam", "联机",
  "电影", "电视剧", "动漫", "追剧", "小说", "漫画",
  "听歌", "歌手", "演唱会", "音乐",
  "睡觉", "熬夜", "失眠", "午睡", "起床",
  "手机", "电脑", "安卓", "苹果", "linux", "mac", "编程", "代码",
  "天气", "下雨", "下雪", "好热", "好冷",
  "工作", "加班", "面试", "工资", "同事",
  "分手", "表白", "喜欢的人", "暗恋", "对象",
  "猫", "狗", "宠物", "养鱼", "仓鼠",
  "生日", "回家", "旅游", "出去玩",
];

// Words that carry no topic on their own. Used only to reject junk spans.
const TOPIC_STOP = new Set([
  "什么", "怎么", "这个", "那个", "我们", "你们", "他们", "可以", "不是",
  "就是", "然后", "但是", "因为", "所以", "已经", "现在", "还是", "这样",
  "那样", "知道", "觉得", "一个", "一下", "没有", "自己", "时候", "问题",
  "东西", "地方", "事情", "样子", "感觉", "应该", "可能", "真的", "有点",
]);

/**
 * Pull a topic out of arbitrary text.
 *
 * Previously this only fired on a hand-written keyword list, so ordinary
 * conversation ("你好呀", "你在干嘛") produced no topic at all and the topic
 * store stayed permanently empty. Now any clause with enough substance
 * becomes a topic: known keywords are still preferred because they cluster
 * related mentions, but unknown subjects are no longer dropped.
 */
// Things that are never a topic: a question about identity, a claim about who
// someone is, a bare interjection. These used to become topics and then got fed
// back on every wake-up, which is why the bot's own conversation kept circling
// the same exchange. A topic has to be something that can be talked about.
const TOPIC_JUNK = [
  /^(你|您)(是|叫|认不|知不|怎么不|为什么)/,
  /(主人|爸爸|妈妈|群主|管理员)/,
  /谁啊|是什么|你是谁|他是|她是|这是/,
  /^(哈+|嘿+|嗯+|哦+|啊+|牛|草|6+|好+|行+|对+)$/,
  // Requests aimed at the bot itself, not subjects to raise later.
  /(来个|来张|发个|发张|唱个|叫个)(语音|图|表情|照)/,
  /^\[.*\]$/,
];

function looksLikeVerbalNoise(t) {
  const s = String(t || "").trim();
  if (s.length < 4) return true;
  if (TOPIC_JUNK.some((re) => re.test(s))) return true;
  // A bare question with no subject is not a subject to raise later.
  if (/^(你|你们|他|她)(呢|吗|啊|呀|嘛)?$/.test(s)) return true;
  return false;
}

function extractTopic(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const hits = TOPIC_HINTS.filter((h) => raw.includes(h));
  if (hits.length) return hits.slice(0, 2).join("+");

  // Open extraction: split into clauses, keep the first substantial one.
  const clauses = raw
    .split(/[，,。.！!？?；;：:\n\t~～…]+/)
    .map((c) => c.trim())
    .filter(Boolean);

  for (const c of clauses) {
    if (TOPIC_STOP.has(c)) continue;
    // Strip leading fillers so "那我先去看看" -> "先去看看".
    // Strip only leading discourse fillers. Never strip trailing particles:
    // doing so turned "你在干嘛" into "你在干" and "先把二做了吧" into "先把二做".
    const core = c
      .replace(/^(那么?|那|所以|然后|但是|不过|而且|还有|就是|其实|这个|那个)+/u, "")
      .trim();
    if (core.length < 2) continue;
    if (TOPIC_STOP.has(core)) continue;
    // Reject questions about identity and bare interjections: they are not
    // something the bot can raise later. Feeding them back is what made every
    // wake-up circle the same exchange.
    if (looksLikeVerbalNoise(core)) continue;
    // Trim only a dangling single character; never cut through a word.
    const capped = core.length > 24 ? core.slice(0, 24) : core;
    return capped;
  }
  return null;
}

function describeEmotion(state, rel = null, voiceHint = "") {
  // Defensive: a half-written or legacy state file must degrade to a neutral
  // description, not throw inside the prompt hook.
  const d = state?.dimensions ?? {};
  const tags = [];
  if (d.happy > 0.68) tags.push("心情不错");
  else if (d.happy < 0.22) tags.push("有点提不起劲");
  if (d.excited > 0.7) tags.push("有点兴奋");
  if (d.curious > 0.7) tags.push("很好奇");
  if (d.wronged > 0.28) tags.push("有点委屈");
  if (d.down > 0.5) tags.push("有点低落");
  if (d.tired > 0.65) tags.push("聊久了 有点乏");
  if (d.bored > 0.65) tags.push("有点无聊");
  if (d.shy > 0.45) tags.push("有点害羞");
  // Only label it when nothing warmer is happening; "嘴硬模式" next to 撒娇
  // tells the model two contradictory things at once.
  if (d.tsundere > 0.6 && d.happy < 0.6 && d.wronged > 0.1) tags.push("嘴硬模式");
  if (!tags.length) tags.push("状态平平 正常聊");

  // Same rule as personaLine: feelings, not stage directions. "你可以多问一句"
  // is an instruction the model can follow woodenly; "有点想知道更多" is a state
  // it can speak from. The old wording also made every line start with 可以,
  // which read as a list of permissions rather than a mood.
  const guide = [];
  if (d.happy > 0.68) guide.push("心情挺轻快，有话想说");
  // The old cut-off was 0.35, but the baseline sits at 0.3 — so "reply short"
  // was effectively the default. Only a real dip should tighten anything now.
  if (d.happy < 0.22) guide.push("提不起热情，不想硬撑");
  if (d.wronged > 0.28) guide.push("心里有点闷，但还不至于翻脸");
  if (d.tired > 0.65) guide.push("有点乏，话懒得多说");
  if (d.curious > 0.7) guide.push("挺想知道更多的");
  if (d.tsundere > 0.6 && d.happy < 0.6) guide.push("嘴上不想服软");
  if (d.excited > 0.7) guide.push("兴奋得话都收不住");
  // Bored means restless, not withdrawn. "Say less" and "find something new to
  // talk about" used to fire together, which cancelled each other out.
  if (d.bored > 0.65) guide.push("闲得发慌，想扯点别的");
  if (d.shy > 0.45) guide.push("被说得不好意思，想岔开话");

  // Naming the matching sticker mood turns "be emotional" into something the
  // model can act on with one tool call instead of inventing a face. The mood
  // must exist in the sticker set or the call fails, so only mapped ones ship.
  // The function reads last_deltas to tell "it just happened" from "it has been
  // sitting there". Omitting the argument made those three branches dead code.
  // Passing it restores the intended behaviour; the thresholds themselves are
  // unchanged and stay high on purpose.
  const suggested = suggestStickerMood(d, rel, state?.last_deltas ?? null);
  const stickerLine = suggested
    ? ` 这会儿最对的脸是 ${suggested} 这张（dafeiyu_sticker(mood="${suggested}")）。`
    : "";

  const moodLine = guide.length ? ` ${guide.join("；")}。` : "";
  // Felt state instead of director's notes. The old wording ("这一轮：撒娇——
  // 拖个音、反过来问一句") was a performance instruction, so the model performed
  // it and then announced the performance ("这条是委屈档的"). Describing what it
  // feels makes it speak from the feeling instead of narrating the act.
  const persona = personaLine(state, rel);
  // The voice hint is appended outside `personaLine` on purpose: personaLine is
  // also called by tools that have no chat target, so it must never contain a
  // "you may send a voice note" instruction.
  return `${persona}${moodLine}${stickerLine}${voiceHint}`;
}

/**
 * Which side of the personality should lead right now.
 *
 * Default is 呆萌 可爱 (the character's baseline); 傲娇 is the second gear and
 * must be earned. Without this the emotion engine could describe a mood but
 * never say which persona mode to be in, so the model picked one at random each
 * turn — which is why the character read as inconsistent rather than as
 * "cute first, prickly second".
 *
 * @param {object} state emotion state
 * @param {object} rel   relation record; null means unknown contact
 */
function personaLine(state, rel) {
  const d = state?.dimensions ?? {};
  const fam = clamp01(rel?.familiarity ?? 0.15);
  // Math.min/max pass NaN straight through, so this needs the finite guard too.
  const rawSenti = rel?.sentiment ?? 0;
  const senti = Number.isFinite(rawSenti) ? Math.max(-1, Math.min(1, rawSenti)) : 0;

  // `rel === null` means we genuinely do not know who this is (e.g. the
  // emotion_state tool, which has no conversation context). Saying "不熟的" there
  // would be a lie, so the label is omitted entirely instead.
  const known = rel != null;
  const close = fam >= 0.35;
  const who = close ? "熟人" : "不熟的";
  const tag = known ? `·${who}` : "";

  // BASE — always present. 呆萌可爱 is the character, not a mood. It just shows
  // less in front of someone new, which is normal social behaviour rather than a
  // special branch: you are still yourself, just not fully relaxed yet.
  // Second person, felt state. Not "底色：呆萌可爱" — that reads as a spec line
  // the model can quote back. "你本来就有点憨" is something you can speak from.
  const base = known && !close
    ? "你平时有点憨，反应慢半拍，还容易抓错重点。不过对面这个你还不太熟，先收着点。"
    : "你平时有点憨，反应慢半拍，有时候还挺自信地搞错。";

  let mod = "";

  // Signals below are relationship-independent on purpose: how you feel does not
  // depend on who is talking, only on what they did.
  // Read "what just happened" from the latest delta. Absolute levels drift with
  // decay, so a threshold on them is unreliable in both directions: a calm moment
  // can read as 炸毛 while a real accusation reads as nothing.
  const last = state.last_deltas || {};
  const justSurprised = (last.surprised ?? 0) >= 0.08;
  const justWronged = (last.wronged ?? 0) >= 0.08;
  const justTsundere = (last.tsundere ?? 0) >= 0.08;
  const justShy = (last.shy ?? 0) >= 0.08;

  const accused = justSurprised && justWronged;
  const insulted = justWronged && justTsundere && d.tsundere >= 0.45;
  const withdrawing = justWronged && !justSurprised && d.happy >= 0.3;
  // Must match voiceGearFor exactly. If these drift apart, the model is told to
  // play one gear while being offered a different gear's voice, which reads as
  // broken behaviour rather than personality.
  const anyBad = d.wronged > 0.55 || d.surprised > 0.60 || senti < -0.35 || d.down > 0.50;

  // Every branch is a feeling, never a technique. The old text named the gear
  // and then told the model how to act it out ("拖个音、反过来问一句"), which is
  // why it kept narrating its own performance afterwards.
  if (accused) {
    mod = "你被戳到了，是真的上火。想顶回去。";
  } else if (insulted) {
    mod = close
      ? "心里其实在意，但嘴上绝不认。你越解释越像在狡辩。"
      : "懒得给好脸色，但也不至于翻脸。";
  } else if (withdrawing) {
    mod = close
      ? "有点闷。想缩回去，话变少，但也别装没事。"
      : "有点扫兴，客气一下就算了。";
  } else if ((d.excited ?? 0) > 0.45) {
    // Same threshold and same ordering as voiceGearFor's 兴奋 branch. When these
    // two disagree the character is told to act one gear while being offered a
    // different gear's voice.
    mod = "你现在挺兴奋的，话收不住，想一口气说完。";
  } else if ((d.shy ?? 0) > 0.45 || justShy) {
    // A feeling, not a stage direction. The model should speak from this, not
    // narrate it ("本鱼害羞了" is the failure mode, not the goal).
    mod = "被说得有点不好意思，耳朵热。嘴硬一句又接不下去，声音会变小。";
  } else if (close && !anyBad) {
    // Warm gears are for people you already know. With a stranger they would be
    // out of character, so closeness is what unlocks them, not good mood alone.
    mod = "你现在有点想赖着他。说话会软下来，想让他多看你两眼。";
  } else if (!close) {
    // The default stance toward an unfamiliar person: slightly prickly, low
    // effort, not unfriendly. This is what makes being let in later feel earned.
    mod = "你还端着。话不多，也不主动展开。";
  }

  // `tag` already carries the "·熟人" suffix computed above; reuse it rather
  // than re-deriving who this is.
  return mod
    ? `【你现在的样子${tag}】${base}${mod}`
    : `【你现在的样子${tag}】${base}没什么特别的情绪，就这样。`;
}

/**
 * Pick the sticker mood that matches the strongest current feeling.
 *
 * Order matters: a loud negative feeling should win over "calm", and tired
 * over bored, because that is how the difference reads in a chat. Returns
 * null when nothing is strong enough to be worth a specific face.
 */
function suggestStickerMood(d, rel = null, lastDeltas = null) {
  // Only return moods that actually exist in assets/stickers.
  // Order mirrors personaLine() exactly: the face must match the gear the model
  // was just told to play. `wronged` used to be checked first and won every
  // argument, so 傲娇 and 炸毛 always came with a crying sticker.
  const fam = clamp01(rel?.familiarity ?? 0.15);
  const last = lastDeltas || {};
  const justSurprised = (last.surprised ?? 0) >= 0.08;
  const justWronged = (last.wronged ?? 0) >= 0.08;
  const justTsundere = (last.tsundere ?? 0) >= 0.08;

  if (justSurprised && justWronged) return "shock";
  if (justWronged && justTsundere && d.tsundere >= 0.45) return "hmph";
  if (justWronged && !justSurprised) return "sad";
  // These bars are deliberately high: a face should mean the feeling actually
  // got up there, not that it drifted a point above baseline. Owner ruling
  // (2026-11-04): not sending a sticker on a quiet day is correct behaviour,
  // not a defect. Do not lower these to make stickers "show up more".
  if (d.happy > 0.7) return d.excited > 0.7 ? "excited" : "happy";
  if (d.tired > 0.7) return "tired";
  if (d.down > 0.45) return "cry";
  if (d.bored > 0.7) return "bored";
  if (d.curious > 0.8) return "think";
  if (d.excited > 0.75) return "excited";
  // A stranger with no strong signal gets a guarded face rather than a grin.
  if (rel != null && fam < 0.35) return "blank";
  return null;
}

// ---------- plugin ----------

export default function register(api) {
  const cfg = api.pluginConfig ?? {};
  const agents = Array.isArray(cfg.agents) && cfg.agents.length ? cfg.agents : ["dafeiyu"];
  const emotionCfg = {
    enabled: true, halfLifeMinutes: 180, baseline: 0.3, injectPrompt: true,
    ...(cfg.emotion || {}),
  };
  const memoryCfg = { enabled: true, dailyLog: true, maxDailyLines: 500, ...(cfg.memory || {}) };
  const experienceCfg = { enabled: true, poolInPrompt: true, ...(cfg.experience || {}) };
    // Curiosity: names she met that she does not have an explanation for.
    //
    // `budget` is 1 by default and is a hard cap, not a probability. A wake
    // proposes at most one name; two turns of "here are the things you do not
    // understand" in a row is a to-do list, which is the failure this replaces.
    //
    // `sources` is a kill switch per input rather than one global toggle. The
    // browse source fires constantly and the speech source almost never does;
    // turning curiosity off wholesale to silence the noisy one would also throw
    // away the precise one.
    //
    // `browse` is off by default: measured against 29 real video titles it
    // offered `astra`, `deepseek`, `python`, `remotion` — every one of which
    // she already knew. The switch stays so turning it on is a decision.
  // Every tool that brings back text written by somebody else. This list is
  // the whole point of the layer: curiosity about the world can only happen if
  // she actually goes out into it, and "out" is not one website.
  //
  // The extractor does not care which site it was; it cares whether the text
  // was written by somebody else. A video title, a group chat, a Qzone post and
  // a fetched page all qualify, and they qualify for the same reason: a name
  // can arrive in them without anybody having asked for it.
  // Names that are machine vocabulary rather than things in the world.
  //
  // Measured 2026-11-06: fifteen noticings in one sitting read `source`,
  // `web_fetch`, `external`, `chromium`, `managed-or-attach`, `lightpanda`,
  // `screenshot`, and three UUID fragments. `source` had been "met" thirteen
  // times and `screenshot` six, so both were ranked as questions she was
  // circling. All of it came from browser status output — a description of the
  // tool, not of anything she was reading.
  //
  // A UUID fragment is the clearest case: nobody is curious about
  // `cae-4e1f-bb0b-fecb639ca049`. If an extractor cannot tell that from a thing
  // in the world, it will fill the store with noise until it looks like it is
  // working, and she will be handed questions about her own plumbing.
  const MACHINE_WORDS = new Set([
    "source", "external", "internal", "screenshot", "browser", "chromium",
    "lightpanda", "managed", "attach", "web_fetch", "web_search", "tavily",
    "tool", "toolName", "result", "error", "status", "started", "stopped",
    "timeout", "timeoutMs", "localhost", "stdio", "cdp", "playwright",
    "puppeteer", "websocket", "http", "https", "json", "yaml", "null",
    "undefined", "true", "false", "profile", "session", "target", "node",
    // HTML tag and attribute names. `div` reached the store on 2026-11-06 and
    // `managed-or-attach` twenty minutes later: the browser tool returns the
    // DOM as text, and the extractor cannot tell markup from prose. None of
    // these is ever a thing in the world.
    "div", "span", "body", "html", "head", "title", "script", "style",
    "class", "href", "src", "alt", "img", "li", "ul", "br", "hr",
    "table", "tr", "td", "meta", "link", "input", "form", "button",
    "select", "option", "textarea", "label", "nav", "section", "article",
    "header", "footer", "main", "aside", "canvas", "svg", "path",
    "circle", "rect", "polygon", "iframe", "video", "audio", "script",
    "property", "content", "rel", "type", "value", "name", "width", "height",
    "muse", "aria", "role", "tabindex", "dataset", "className", "innerHTML",
    // Compound tool-state phrases: `managed-or-attach`, `not-connected`,
    // `headless-mode`. English hyphenated compounds never appear in the Chinese
    // text she reads, so a lowercase ascii word-段 with a hyphen is code.
    "managed-or-attach",
  ]);

  // `cae-4e1f-bb0b-fecb639ca049`, `c72f4d9`, `a434cb7-0e28-421e-95a9`.
  //
  // Three shapes, because browser ids arrive in all of them. The dash form is
  // the one that bit: `cae-4e1f-bb0b-fecb639ca049` contains `c`, `e` and `a`,
  // which are all valid hex digits, so a pure-hex test missed it. The real shape
  // is "several short dash-separated groups made only of hex characters", which
  // no word in either language has.
  const HEX = "[0-9a-f]";
  const ID_LIKE = new RegExp(
    "^(?:" +
      `${HEX}{6,}` +                       // c72f4d9
      `|${HEX}{2,}(?:-${HEX}{2,}){1,}` +   // cae-4e1f-bb0b-fecb639ca049
      ")$",
    "i",
  );

  function isMachineName(s) {
    const t = String(s || "").trim();
    if (!t) return true;
    if (MACHINE_WORDS.has(t)) return true;
    if (MACHINE_WORDS.has(t.toLowerCase())) return true;
    if (ID_LIKE.test(t)) return true;
    // Underscore-separated identifiers (`web_fetch`, `tool_call`) are code, not
    // prose. Chinese text never uses them.
    if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/i.test(t)) return true;
    // Lowercase ascii with hyphens and no spaces: `managed-or-attach`,
    // `some-state-name`. Chinese prose does not produce this shape; browser
    // status strings do. Mixed case and Chinese are untouched, so a real
    // hyphenated product name still gets through.
    if (/^[a-z][a-z0-9-]*[a-z0-9]$/.test(t) && t.includes("-") && t.length >= 8) return true;
    // Short ascii tokens joined by `+`: `ad+ih`, `b9+103`.
    //
    // Both reached the store on 2026-11-06 — `ad+ih` at 04:30:46 and `b9+103`
    // at 04:30:57 — during the same browse that produced the real ones
    // (电饭煲发热原理, 电饭锅为什么知道饭熟). They are ad-slot and element ids
    // from the page, and they passed every existing rule: too short for the
    // hyphen rule, no underscore, not pure hex.
    //
    // The shape is the tell: a `+` between two very short ascii groups is how
    // an id joins its parts. Chinese prose uses `＋`, or spaces, or nothing.
    if (/^[a-z0-9]{1,6}(?:\+[a-z0-9]{1,6})+$/i.test(t)) return true;
    return false;
  }

  const BROWSE_TOOLS = new RegExp(
    "^(?:" +
      [
        "douyin_(?:act|record|plan|status)",
        "qq_(?:recent|history|group_info|members|qzone|friends|groups|profile|whois|online)",
        "web_fetch",
        "browser",
      ].join("|") +
      ")$",
  );

  const curiosityCfg = {
    enabled: true,
    budget: 1,
    // Three sources, all real:
    //   search   — she went looking on purpose (Tavily)
    //   browse   — she went out and read something somebody else wrote
    //   question — a name arrived in conversation
    //
    // `browse` used to be off, on the strength of a measurement: over 29 real
    // douyin titles the old extractor minted `astra`, `deepseek`, `python` —
    // every one of them already known. That measurement described the old
    // extractor, not this one. Re-measured after the rewrite, the same 29 titles
    // plus their comment threads yield one genuine unknown, which is the correct
    // order of magnitude for a source that is mostly caption noise.
    //
    // `recall` used to sit here set to true while nothing read it. A flag that
    // says "on" when no code consults it makes the configuration look finished
    // when it is not, so it is gone rather than left as decoration.
    sources: {
      question: true,
      search: true,
      browse: true,
      ...((cfg.curiosity && cfg.curiosity.sources) || {}),
    },
  };

  // Autonomy intake. Off by default on purpose: this layer decides whether she
  // acts on her own, and a default-on behaviour change of that size is exactly
  // the kind of thing that should need an explicit yes. `enabled: false` leaves
  // collection and scoring inert while keeping the code path exercised by tests.
  const autonomyCfg = {
    enabled: false,
    /** Candidates must out-score this to count as worth doing. */
    threshold: 0.25,
    /** How many actions one wake may take. One, by design: this is not a batch. */
    maxPerWake: 1,
    /** Do not speak twice inside this many minutes. */
    talkGapMinutes: 30,
    /** Never reach out unprompted below this familiarity. */
    familiarityFloor: 0.35,
    /** Daily cap on unprompted opens, matching the existing spoke_today scale. */
    maxPerDay: 15,
    /** Local hour range that belongs to other people. */
    quietStartHour: 0,
    quietEndHour: 6,
    /** Wall-clock zone for the hour gate. Never the host tz: a laptop moved
     *  across time zones must not shift when she may speak. */
    timeZone: "Asia/Shanghai",
    ...(cfg.autonomy || {}),
  };
  const proactiveCfg = {
    enabled: true, replyWindowMinutes: 30, bufferMinutes: 2, maxSilenceHours: 0,
    cooldownMinutes: 15, quietHoursStart: 0, quietHoursEnd: 0,
    requireValue: false,
    // Must match lib/proactive.js DEFAULTS. Held here too because this object is
    // what every call site actually passes; a drift between the two defaults
    // would silently re-open the gates on one path and not the other.
    unlimited: false,
    impulseTtlHours: 6, timeZone: "Asia/Shanghai",
    ...(cfg.proactive || {}),
  };

  // Voice preferences (owner directive 2026-11-04). Two independent settings:
  //   suppressText  - a spoken line is not repeated as a text bubble
  //   ownerTargets  - chats where voice is actively encouraged, not merely allowed
  // Kept separate from `proactive.ownerTargets`, which means "may be messaged
  // unprompted" — a different question from "should this line be spoken".
  const voiceCfg = {
    // Declared but never consulted. Kept as a switch so the setting is honest:
    // turning it off has to do something, or it is decoration that makes the
    // configuration look more finished than it is.
    enabled: true,
    suppressText: true,
    suppressWindowSeconds: 120,
    ownerTargets: [],
    ...(cfg.voice || {}),
  };

  // @ is a broadcast primitive that touches specific people by id, so it is
  // constrained to pre-approved groups and pre-approved id sets. The wording
  // is free; the audience is not.
  const reminderCfg = { groups: {}, ...(cfg.reminders || {}) };

  // Douyin action policy. Read here, once, at register time.
  //
  // This used to be read as `target.config?.douyin`, which never existed:
  // resolveTarget returns { agentId, workspaceDir } and nothing else. So the
  // allow-list was always undefined, requireActor saw an empty set, and every
  // action — like included — was refused as "not-allowed". The tool looked
  // broken because it was.
  const douyinCfg = {
    enabled: true,
    allowActions: [],
    maxFramesPerVideo: 24,
    cooldownMinutes: 30,
    ...(cfg.douyin || {}),
  };

  // Probe log.
  //
  // Two hard-won details, both from 2026-11-04/05:
  //
  // 1. **Not /tmp.** The old path was `/tmp/dafeiyu-probe.log` and it stopped
  //    receiving lines at 21:52 on 2026-11-04 — while the agent kept running for
  //    another eight hours (diary entries, heartbeats, outbound attempts all
  //    present in the gateway log). The file stayed writable by the same uid;
  //    the writes simply never landed. /tmp is the one directory a sandbox or a
  //    per-run namespace is most likely to swap underneath a long-lived process,
  //    so the log now lives inside the workspace, next to the state it describes.
  //
  // 2. **One failed write must not disable the probe forever.** The old body was
  //    `try { append } catch {}`, which is silent by construction: it could fail
  //    a thousand times with nothing anywhere saying so, and the absence of log
  //    lines was indistinguishable from the absence of activity. It now records
  //    the failure once — into the same file, and once via process.stderr — then
  //    keeps trying rather than going quiet.
  //
  // A probe is an observation tool. When it breaks it must break loudly, because
  // the alternative (as seen tonight) is mistaking a blind instrument for a dead
  // system.
  let probeErrors = 0;
  const PROBE_FALLBACK = `/tmp/dafeiyu-probe-fallback.log`;

  // Resolve the probe target from config rather than request context: `probe`
  // is called from hooks that may not carry a workspaceDir, and a missing path
  // is exactly the case that used to fail silently.
  function probePath() {
    try {
      const entry = api.config?.agents?.entries?.[agents[0]];
      const ws = entry?.workspace;
      if (ws) return path.join(ws, "state", "probe.log");
    } catch { /* fall through */ }
    return PROBE_FALLBACK;
  }

    // Keep the log readable, not just writable.
    //
    // `probe.log` reached 9 MB before anything was removed from it, and the cause
    // was not one noisy tag: nothing ever trimmed the file. A log nobody can open
    // stops being evidence, and `selfcheck` reads its samples from here, so bloat
    // is a correctness problem rather than a housekeeping one.
    //
    // Rotate at 4 MB into a single `.1` — one generation is enough provenance to
    // answer "did it fire before this change", which is the only question this
    // file is ever asked. Overflow beyond that is dropped.
    const PROBE_MAX_BYTES = 4 * 1024 * 1024;
    let probeBytes = -1;

    function rotateProbe(file) {
      try {
        if (probeBytes < 0) probeBytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
        if (probeBytes < PROBE_MAX_BYTES) return;
        fs.renameSync(file, `${file}.1`);
        probeBytes = 0;
      } catch {
        probeBytes = 0;
      }
    }

    function probe(tag, data) {
      const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`;
      const target = probePath();
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        rotateProbe(target);
        fs.appendFileSync(target, line);
        probeBytes = Math.max(0, probeBytes) + Buffer.byteLength(line);
        return;
      } catch (err) {
        probeErrors += 1;
      // Announce the first failure and then every 100th, so a persistent
      // breakage is visible without flooding the console.
      if (probeErrors === 1 || probeErrors % 100 === 0) {
        try {
          api.logger?.warn?.(
            `dafeiyu-core: probe write failed (${probeErrors}x) target=${target}: ${err?.message || err}`,
          );
        } catch { /* logger itself unavailable */ }
      }
    }
    // Second chance on a path that definitely exists for this uid.
    try {
      fs.appendFileSync(PROBE_FALLBACK, line);
    } catch { /* nothing left to try */ }
  }

  // Resolve { agentId, workspaceDir } from whatever context we got.
  function resolveTarget(ctx) {
    let agentId = ctx?.agentId;
    if (!agentId && typeof ctx?.sessionKey === "string") {
      const m = /^agent:([^:]+):/.exec(ctx.sessionKey);
      if (m) agentId = m[1];
    }
    if (!agentId || !agents.includes(agentId)) return null;

    let workspaceDir = ctx?.workspaceDir;
    if (!workspaceDir) {
      const entry = api.config?.agents?.entries?.[agentId];
      workspaceDir = entry?.workspace;
    }
    if (!workspaceDir) return null;
    return { agentId, workspaceDir };
  }

  /**
   * Other names the same person goes by.
   *
   * Read from USER.md's `称呼：Alice（用户）` line instead of hard-coded: a
   * mapping this specific belongs to the person, not to the code.
   *
   * Exact-name matching is what lost all four existing person.md records. They
   * were written as `about: Alice`; the live event carries `senderName: "用户"`;
   * neither string contains the other, so `known(ws, "用户")` returned 0 of 4 and
   * she would have started a second, parallel memory of the same man.
   *
   * Returns `[]` on any failure, which degrades to exact matching.
   */
  function personAliases(workspaceDir) {
    try {
      const md = fs.readFileSync(path.join(workspaceDir, "USER.md"), "utf8");
      const m = /称呼[:：]\s*([^\n]+)/.exec(md);
      if (!m) return [];
      return m[1]
        .split(/[（）()、,，/]+/)
        .map((x) => x.trim())
        .filter((x) => x && x !== "称呼")
        .slice(0, 6);
    } catch {
      return [];
    }
  }

  // -------- emotion storage --------

  // Build stable keys for relations/topics/proactive.
  // Field layout lives in lib/identity.js and is unit-tested.
  function identity(ctx, event) {
    return resolveIdentity(event, ctx);
  }

  function loadEmotion(workspaceDir) {
    const file = path.join(workspaceDir, "state", "emotion.json");
    const state = readJson(file, DEFAULT_STATE);
    if (!state.dimensions) state.dimensions = structuredClone(DEFAULT_DIMENSIONS);
    if (!state.decay) state.decay = { half_life_minutes: emotionCfg.halfLifeMinutes, baseline: emotionCfg.baseline };
    if (!Array.isArray(state.history)) state.history = [];
    return { file, state };
  }

  function loadAndDecay(workspaceDir) {
    const { file, state } = loadEmotion(workspaceDir);
    applyDecay(state, emotionCfg.halfLifeMinutes, emotionCfg.baseline);
    return { file, state };
  }

  // -------- one delivery per content, per turn, per target --------
  //
  // A `message` tool call and the assistant's final text are two different
  // delivery routes. Recording only the tool call cannot stop the final text,
  // and cancelling every final reply would break ordinary conversation. Keep a
  // short, turn-scoped record of successful sends and suppress only the same
  // content sent to the same target again in that turn.
  const recentTextSends = new Map();
  const SEND_DEDUPE_MS = 2 * 60 * 1000;

  // Same chatKey spelling the voice tool uses for its cooldown, so the ledger
  // written by `dafeiyu_voice` and the lookup done at delivery time agree.
  const chatKeyFromCtx = (ctx) => {
    const id = identity(ctx, {});
    const sk = String(ctx?.sessionKey || "");
    let chatId = id?.chatId || id?.senderId || null;
    if (!chatId) {
      const nums = sk.match(/\d{5,}/g);
      if (nums) chatId = nums[nums.length - 1];
    }
    if (!chatId) return null;
    const isGroup = resolveOnebotTargetKind({}, ctx, sk) === "group";
    return `${isGroup ? "group" : "private"}:${chatId}`;
  };
  const normalizeSentText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const targetIdOf = (value) => {
    const m = String(value || "").match(/(?:private|group|user|channel):(\d+)$/);
    return m ? m[1] : null;
  };
  const sameTarget = (a, b) => {
    if (!a || !b) return false;
    if (String(a) === String(b)) return true;
    const ai = targetIdOf(a), bi = targetIdOf(b);
    return Boolean(ai && bi && ai === bi);
  };
  // A tool call and the final reply can carry different runIds while still
  // belonging to the same user turn. Use the session as the stable scope and
  // compare content/target; a two-minute TTL keeps this from affecting later
  // turns or unrelated conversations.
  const sendDedupeKey = (ctx, dest) => `${ctx?.sessionKey || ctx?.runId || "unknown"}|${String(dest || "")}`;
  function rememberTextSend(ctx, dest, text) {
    const body = normalizeSentText(text);
    if (!body || !dest) return;
    const key = sendDedupeKey(ctx, dest);
    const now = Date.now();
    const old = recentTextSends.get(key) || [];
    recentTextSends.set(key, [...old.filter((x) => now - x.at < SEND_DEDUPE_MS), { at: now, text: body }].slice(-12));
  }
  function alreadySentThisTurn(ctx, dest, text) {
    const body = normalizeSentText(text);
    if (!body) return false;
    const key = sendDedupeKey(ctx, dest);
    const now = Date.now();
    const entries = (recentTextSends.get(key) || []).filter((x) => now - x.at < SEND_DEDUPE_MS);
    return entries.some((x) => x.text === body);
  }

  // -------- hooks --------

  // Inject current mood + social context into every managed turn.
  // -------- self echo: let the bot see what it just said --------
  //
  // 2026-10-31: the bot sent three consecutive replies that ALL began with
  // 「刚」 — 刚才是本鱼懒了 / 刚才两条被拼成… / 刚那两条被合并…
  //
  // Cause: it has no view of its own last messages. It generates a whole reply
  // in one shot, splitting it into several bubbles, and each bubble picks an
  // opener from the same template because nothing tells it the opener was
  // already used one second ago. Telling it "don't repeat yourself" in the
  // prompt cannot work — the rule is invisible to a generator that cannot see
  // its own output.
  //
  // So the recent outbound lines are read back from QQ and injected. Cheap,
  // read-only, and it makes repeated openers self-evident instead of relying
  // on self-discipline.
  function buildSelfEcho(workspaceDir) {
    try {
      const file = path.join(workspaceDir, "state", "self-echo.json");
      if (!fs.existsSync(file)) return null;
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const lines = Array.isArray(data?.lines) ? data.lines : [];
      if (!lines.length) return null;
      // Stale echo is worse than none: quoting yesterday's opener would make
      // the bot avoid a pattern nobody is repeating.
      const ageMs = Date.now() - (Date.parse(data.updated_at) || 0);
      if (ageMs > 3 * 60 * 1000) return null;
      const shown = lines.slice(0, 4).map((l) => `  · ${l}`).join("\n");
      return [
        "【你刚发出去的几条】",
        shown,
        "看看开头。连着重复同一个词（刚/其实/所以/嗯/然后）就是模板感，换掉或直接去掉开头。",
      ].join("\n");
    } catch {
      return null;
    }
  }

  // Record what was just sent so the next turn can see it.
  api.on("reply_payload_sending", (event, ctx) => {
    const target = resolveTarget(ctx);
    if (!target) return;
    try {
      // Core passes { payload, kind, channel, sessionKey, runId, context }.
      // The reply body lives at event.payload.text.
      const text = String(event?.payload?.text ?? event?.text ?? "").trim();
      if (!text) return;
      const file = path.join(target.workspaceDir, "state", "self-echo.json");
      let prev = [];
      try {
        const old = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Date.now() - (Date.parse(old?.updated_at) || 0) < 3 * 60 * 1000) {
          prev = Array.isArray(old?.lines) ? old.lines : [];
        }
      } catch {
        prev = [];
      }
      // Keep the opening words — that is the part that gets templated.
      const opener = text.slice(0, 18);
      const lines = [...new Set([opener, ...prev])].slice(0, 6);
      writeJsonAtomic(file, {
        updated_at: new Date().toISOString(),
        lines,
      });
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: self echo record failed: ${err}`);
    }
  }, { priority: 120 });

  // COGNITION.md cache — keyed on mtime so an edit takes effect on the next
  // turn without re-reading the file every time.
  let cogCache = { path: null, mtime: 0, text: "" };

  api.on("before_prompt_build", (event, ctx) => {
    probe("before_prompt_build", { agentId: ctx?.agentId, sessionKey: ctx?.sessionKey, ws: ctx?.workspaceDir });
    const target = resolveTarget(ctx);
    if (!target) return;

    const parts = [];

    // Set by the autonomy block far below when it is about to name a candidate.
    // Declared here because the curiosity block reads it earlier in this same
    // function — a `let` after the read would be a temporal-dead-zone throw at
    // runtime, which is exactly the kind of bug that only shows up on the first
    // heartbeat after a restart.
    let autonomyWillAct = false;

    // Resolve who we are talking to first: the persona gear depends on it.
    let promptId = null;
    let promptRel = null;
    try {
      promptId = identity(ctx, event);
      if (promptId?.personKey) {
        promptRel = relations.getRelation(target.workspaceDir, promptId.personKey)
          || (promptId.groupKey ? relations.getRelation(target.workspaceDir, promptId.groupKey) : null);
      }
    } catch { /* non-critical */ }

    if (emotionCfg.enabled && emotionCfg.injectPrompt) {
      try {
        const { file, state } = loadAndDecay(target.workspaceDir);
        writeJsonAtomic(file, state);

        // Voice hint. Only offered when all of these hold:
        //   - the gear is one of the three allowed ones (voiceGearFor returns null otherwise)
        //   - we know which chat we are in (a target key exists)
        //
        // There is no cooldown term here: the per-chat voice cooldown was removed
        // on 2026-11-06 (VOICE_COOLDOWN_MS is 0), so a check for it would always
        // pass and only add a line that lies about what gates exist.
        // Otherwise the model is never told voice is an option, which is the
        // cheapest way to enforce the rule: no code path in the model can
        // invent a voice note it was not offered.
        let voiceHint = "";
        try {
          const gear = voiceGearFor(state, promptRel);
          // Did the mood actually move this turn, as opposed to merely resting
          // somewhere? Same signals the gear table uses, so the hint and the gear
          // never disagree about whether something just happened.
          const ld = state?.last_deltas ?? {};
          const spike = (k, n) => (ld[k] ?? 0) >= n;
          const moved =
            spike("happy", 0.06) ||
            spike("excited", 0.06) ||
            spike("wronged", 0.05) ||
            spike("down", 0.05) ||
            spike("shy", 0.05) ||
            (state?.dimensions?.excited ?? 0) > 0.45 ||
            (state?.dimensions?.down ?? 0) > 0.50 ||
            (state?.dimensions?.wronged ?? 0) > 0.55 ||
            (state?.dimensions?.shy ?? 0) > 0.45;
          // Heartbeat wakes have no chat identity (`promptId` is null), so the
          // old `vKey` gate silently removed voice from every proactive turn:
          // the tool was never advertised, and the model cannot call a tool it
          // was not told about. That is why it went months without ever
          // speaking on its own initiative — the feature only existed inside
          // replies to someone else.
          //
          // A proactive turn still needs *a* destination, both to resolve whose
          // relationship the gear reads and to address the send.
          // `proactiveDefaultTarget` is the last chat it actually spoke in,
          // which is the only defensible guess when nobody is addressing it.
          const vKey = promptId?.personKey
            || promptId?.chatId
            || proactive.lastSpokenKey(target.workspaceDir)
            || null;

          // Owner directive (2026-11-04): speech is the DEFAULT with the owner,
          // not an occasional accent. Two separate levers, because they answer
          // different questions:
          //   preferred   - who should hear voice more often than others
          //   moved       - whether this particular line carries feeling
          // Being preferred does not mean every sentence is spoken; it means the
          // bar for speaking is lower, so ordinary warmth goes out as sound
          // instead of only dramatic spikes. The model still decides, which
          // keeps it from turning into a fixed voice-mode.
          const prefKeys = Array.isArray(voiceCfg.ownerTargets) ? voiceCfg.ownerTargets : [];
          const vChatKey = (() => {
            const pid = promptId?.chatId || promptId?.senderId || null;
            if (!pid) return null;
            const isG = promptId?.isGroup === true;
            return `${isG ? "group" : "private"}:${pid}`;
          })();
          const preferred =
            (promptId?.personKey && prefKeys.includes(promptId.personKey)) ||
            (vChatKey && prefKeys.includes(vChatKey)) ||
            false;

          if (gear && vKey) {
            // No cooldown check: VOICE_COOLDOWN_MS is 0, so `waitMs` was always
            // 0 and the "still cooling down" branch below was unreachable.
            {
              // Advertised every turn, not only when the mood engine happens to
              // clear a threshold. The old design only surfaced voice when a
              // numeric condition passed, so in practice the character never
              // learned the tool existed and never used it once in weeks.
              // Owner decision (2026-11-01, recorded in dafeiyu-voice-notes.md):
              // 撒娇 is the DEFAULT gear for a familiar contact, so offering it on
              // every such turn is correct — but the engine only OFFERS. Turning
              // that into "you must send voice now" would make nearly every reply
              // a voice note, which is the opposite of the intended feel. The
              // model judges whether this particular sentence belongs in audio.
              // Same architecture as stickers: suggest, never auto-send.
              // Two different situations share this one hint, and they need
              // different wording. For a mild familiar turn voice is merely
              // available ("not every sentence"). For a turn where the mood has
              // actually moved — happy, excited, or hurting — the owner's rule is
              // that it SHOULD come out as sound, because typing is exactly how
              // those moments get swallowed. Saying "you may" there is what kept
              // it silent through every one of them.
              // Owner directive (2026-11-04, corrected twice): with the owner,
              // VOICE IS THE DEFAULT and text is the exception. The previous
              // wording ("整段正经说明还是打字") read as permission to write the
              // whole report as text and add a voice note afterwards — measured
              // 19:09: five text bubbles then one voice, which is the reverse of
              // what was asked.
              //
              // Order matters as much as channel: speak first, then (only if
              // something genuinely needs writing down) a short line. A spoken
              // line followed by five written ones is not "voice first", it is a
              // report with an audio footnote.
              voiceHint = moved
                ? ` 你这会儿${gear}着。这句话用嘴说出来（dafeiyu_voice(gear="${gear}")），先出声。` +
                  `说完就别再打字重复同一件事，60 字以内。`
                : preferred
                  ? ` 跟这个人说话，先出声（dafeiyu_voice(gear="${gear}")）。` +
                    `有话说就先用嘴说，别先打字。` +
                    `只有这两种情况才打字：一是心情不好不想开口，二是确实要写清楚一段正经说明` +
                    `（代码、步骤、数字这种说不清的）。其余时候语音就是正文，不用配文字，60 字以内。`
                  : ` 想撒娇/想用声音说一句的时候，可以发语音（dafeiyu_voice(gear="${gear}")）。` +
                    `只发语音、不要同时发文字，60 字以内。` +
                    `不是每句都要发，觉得适合用声音讲就用。`;
            }
          } else if (vKey) {
            // No gear available: say so instead of staying silent. Silence is
            // indistinguishable from "this tool does not exist".
            voiceHint = ` 这一轮不给语音档位（情绪还没到位），打字就行。`;
          }
        } catch (err) {
          api.logger?.warn?.(`dafeiyu-core: voice hint failed: ${err}`);
        }

        parts.push(describeEmotion(state, promptRel, voiceHint));

        // Emotion as a trigger for action, not just a tone of voice.
        //
        // Until now a high `bored` only made the character speak more vaguely —
        // the feeling had nowhere to go. This turns enough of a feeling into an
        // opening to DO something. It is an opening, never an instruction: doing
        // nothing is always allowed, otherwise it becomes a chore list and the
        // output is dutiful instead of alive.
        try {
          // Thresholds sit just above each dimension's baseline, not at some
          // abstract "strong feeling" mark. The baseline is happy 0.5 / curious
          // 0.6 / bored 0.2, so a 0.62 bar for curiosity meant "baseline or
          // above" never fired and the character never felt moved to go look
          // anything up. What matters is a dimension being *above its own
          // resting level*, not above a single shared number.
          const dd = state?.dimensions || {};
          const urges = {
            happy: (dd.happy > 0.62 || dd.excited > 0.55) ? "这会儿心里是亮的，有点想让人看见" : null,
            bored: dd.bored > 0.42 ? "闲得有点发空，手上想找点事" : null,
            curious: dd.curious > 0.66 ? "对什么东西起了好奇心" : null,
            down: (dd.down > 0.45 || dd.wronged > 0.3) ? "心里堵着，想找点能自己待着的事" : null,
          };
          if (urges.length) {
            // Only ever name ONE direction. Listing every live feeling at once
            // ("wants to be seen" next to "wants to be alone") hands over two
            // incompatible instructions and the reply comes out flat, because
            // it has to split the difference. The strongest feeling wins and
            // the rest stay unsaid.
            const ranked = [
              { key: "down", v: Math.max(dd.down ?? 0, (dd.wronged ?? 0) * 0.9), text: urges.down },
              { key: "bored", v: dd.bored ?? 0, text: urges.bored },
              { key: "curious", v: (dd.curious ?? 0) * 0.9, text: urges.curious },
              { key: "happy", v: Math.max(dd.happy ?? 0, dd.excited ?? 0), text: urges.happy },
            ].filter((r) => r.text && r.v > 0);

            ranked.sort((a, b) => b.v - a.v);
            const lead = ranked[0];
            if (lead) {
              parts.push(
                `【这会儿的劲头】${lead.text}。\n` +
                `想干点什么就去干——去查点什么、翻翻东西、出去逛逛，都行。\n` +
                `画图放最后：它太容易变成顺手就画一张，画完又没什么可说的。\n` +
                `不是非得干，发呆也可以；只是别干坐着空过。`,
              );
            }
          }
        } catch (err) {
          api.logger?.warn?.(`dafeiyu-core: urge hint failed: ${err}`);
        }
      } catch (err) {
        api.logger?.warn?.(`dafeiyu-core: emotion inject failed: ${err}`);
      }
    }

    // Social context: who is this, how well do we know them, what is dangling.
    try {
      const id = promptId || identity(ctx, event);
      if (id.personKey) {
        const rel = relations.getRelation(target.workspaceDir, id.personKey) ||
          (id.groupKey ? relations.getRelation(target.workspaceDir, id.groupKey) : null);
        const hint = relations.describeRelation(rel);
        if (hint) parts.push(`【对面是谁】${hint}`);
      }
      const tp = topics.describeTopics(target.workspaceDir);
      if (tp) parts.push(tp);
      // What this person has said about themselves. A preference nobody quotes
      // back is a preference she does not have — `remember_about` has written
      // person.md all along, and nothing in the prompt ever showed it.
      try {
        const said = about.describe(target.workspaceDir, id.senderName || null, {
          aliases: personAliases(target.workspaceDir),
        });
        if (said) parts.push(said);
      } catch { /* about is optional */ }
      // Quoting a near-stranger's words back is creepy, not warm. The ledger
      // gates itself on familiarity, so this is safe to call unconditionally.
      try {
        const fam = rel?.familiarity ?? 0;
        const g = grudge.describe(target.workspaceDir, id.personKey, { familiarity: fam });
        if (g) parts.push(g);
      } catch { /* grudge is optional */ }
      // Only the character's own initiative is worth surfacing; ordinary
      // replies would bury it.
      try {
        const d = deeds.describe(target.workspaceDir);
        if (d) parts.push(d);
      } catch { /* deeds is optional */ }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: social context failed: ${err}`);
    }

    try {
      const echo = buildSelfEcho(target.workspaceDir);
      if (echo) parts.push(echo);
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: self echo inject failed: ${err}`);
    }

    // What the character actually said on its own initiative, in full, over the
    // last day. Without this the heartbeat cannot see that it opened with the
    // same grievance four times in a row: self-echo only covers 3 minutes, and
    // proactive dedupe compares exact strings, so a reworded repeat slipped
    // through every time.
    try {
      const said = buildRecentOpenings(target.workspaceDir);
      if (said) parts.push(said);
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: recent openings inject failed: ${err}`);
    }

    // The character's own writing about itself. Kept close to the self-echo on
    // purpose: both answer "who am I being right now", just on different clocks.
    try {
      const mine = buildSelfWriting(target.workspaceDir);
      if (mine) parts.push(mine);
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: self writing inject failed: ${err}`);
    }

    // What happened but has not been sorted into "who I am" yet. Deliberately
    // framed as unfinished thinking rather than as recall: the point is to get
    // it judged, not to have it quoted back mid-conversation.
    try {
      if (experienceCfg.enabled && experienceCfg.poolInPrompt) {
        const pool = experience.describe(target.workspaceDir);
        if (pool) parts.push(pool);
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: experience inject failed: ${err}`);
    }

    // Kept, useful, and unfinished.
    //
    // This is the third state the pool was missing. `pending` asks to be judged
    // and `想明白的事` is the settled result, but between them there was nowhere
    // for "I kept this and it is still in my hands". `kept` fell straight into
    // the fact list and stopped existing as a thing she could return to.
    //
    // The concrete case: 2026-11-06 03:23 she kept 《给我家大肥鱼养的记忆星图》
    // with the note 「跟本鱼自己这层记忆是同一件事」— her own memory works the way
    // that video does — and by 03:29 it was a distilled line with no way back.
    //
    // No instruction attached on purpose. The block states what is on the table
    // and when it was picked up; whether anything comes of it is hers to decide,
    // and "nothing, ever" is a legitimate outcome.
    try {
      if (experienceCfg.enabled && experienceCfg.poolInPrompt) {
        const open = experience.openQuestions(target.workspaceDir, { days: 7, limit: 3 });
        if (open.length) {
          const lines = open.map((e) => {
            const when = String(e.at || "").slice(5, 10);
            return `  · ${when} ${e.what}${e.note ? `（${e.note}）` : ""}`;
          });
          parts.push(
            [
              `【还挂着的】${open.length} 件`,
              ...lines,
              "这些是你觉得有意思、留下来了的。不是待办，不催你。",
            ].join("\n"),
          );
          probe("open-questions-inject", { count: open.length });
        }
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: open questions inject failed: ${err}`);
    }

    // What has already been thought through, as opposed to what is still
    // pending above. Two different jobs on purpose: the pool above asks to be
    // judged, this one is the settled result of earlier judging and is there to
    // be known rather than re-decided.
    //
    // Named 「想明白的事」and attributed to the machine in the file header,
    // because it is distilled text, not something she wrote. Presenting it as
    // her own words would be a lie about provenance.
    try {
      if (experienceCfg.enabled) {
        const learned = consolidate.describe(target.workspaceDir, 5);
        if (learned) {
          parts.push(learned);
          probe("learned-inject", { chars: learned.length });
        }
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: learned inject failed: ${err}`);
    }

    // Subjects that keep coming back.
    //
    // This is the only consumer the edge table has. Before it existed the table
    // was written every heartbeat and read by nobody — measured 2026-11-04 by
    // asking the character directly, which answered 「边的表没看到」 and was right.
    //
    // Clusters, not raw edges: six edges sharing one condition is not six facts,
    // it is one fact — this subject returned six times — and that sentence is
    // what has a chance of being noticed. See edges.describeClusters.
    //
    // Failure here must cost nothing: the section is a bonus, and a corrupt
    // edge file should silently produce no section rather than break the turn.
    try {
      if (experienceCfg.enabled) {
        const recurring = edges.describeClusters(target.workspaceDir, { minSize: 2, limit: 3 });
        if (recurring) {
          parts.push(recurring);
          probe("edges-inject", { chars: recurring.length });
        }
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: edges inject failed: ${err}`);
    }

    // What her memories are about, as concrete names.
    //
    // Verified 2026-11-05, immediately after building this: entities.json was
    // written by experience_resolve and read by nobody. The graph existed on
    // disk and never reached a prompt, so a name she recorded once could not
    // influence any later thought — the exact failure the module was built to
    // fix. A write-only store is not memory, it is a log.
    //
    // Two things are shown, and they answer different questions:
    // - the heaviest names: what her life is currently made of
    // - the names that bridge several experiences: where her own connections run
    //
    // Deliberately short. This competes for attention with everything else in
    // the prompt, and a wall of nouns reads as a word list rather than a
    // thought. Five and three, and only names that earned weight by recurring.
    try {
      const tops = entities.top(target.workspaceDir, 5);
      if (tops.length) {
        const bridges = entities.bridges(target.workspaceDir, 3);
        const lines = [`【本鱼脑子里常绕着的】${tops.map((e) => e.name).join("、")}`];
        if (bridges.length) {
          lines.push(
            "连着的：" + bridges.map((b) => `${b.name}（牵着 ${b.memories} 件）`).join("、"),
          );
        }
        const block = lines.join("\n");
        parts.push(block);
        probe("entities-inject", { chars: block.length, count: tops.length, bridges: bridges.length });
      } else {
        probe("entities-inject-empty", {});
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: entities inject failed: ${err}`);
    }

    // Things she said she wanted to do, still undone.
    //
    // Without this the want pool is another write-only store: the candidate
    // exists in the scheduler but she never sees her own intentions, so picking
    // one up feels like being handed a task rather than remembering a wish.
    // Showing the text in her own words is the whole point — it is the only
    // place in the prompt that originated from her rather than from a rule.
    try {
      const list = wants.open(target.workspaceDir);
      if (list.length) {
        const lines = list.slice(0, 4).map((w) => {
          const age = Math.floor((Date.now() - Date.parse(w.at)) / 86400000);
          const tried = w.attempts ? `，试过 ${w.attempts} 次` : "";
          return `- ${w.what}${age ? `（${age} 天前，${tried.slice(2) || "还没动"}）` : ""}`;
        });
        const block = "【自己想干的】\n" + lines.join("\n");
        parts.push(block);
        probe("wants-inject", { count: list.length, chars: block.length });
      } else {
        // An empty pool used to inject nothing at all — only a probe line in the
        // log. So at the exact moment she had no idea of her own in hand, the
        // prompt contained no trace that the door was open. `want_do()` with no
        // arguments already answers 「手里没有攒着的事」, which means the tool
        // treats this as a real state; only this renderer skipped it.
        //
        // Pure statement, no verb aimed at her. The design note at the top of
        // lib/wants.js is explicit that waking with no wants is legitimate and
        // must not default to "find something" — that default is what produced
        // the sighing this whole feature replaced.
        parts.push("【自己想干的】\n（手里没有攒着的事。这不算空转。）");
        probe("wants-inject-empty", {});
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: wants inject failed: ${err}`);
    }

    // Where her own experience is thin.
    //
    // Same idea as dsh-proactive's curiosity engine, reduced to one line: name
    // the emptiest category, do not suggest it be filled. Measured 2026-11-05:
    // tidy and idle had zero entries across seven days of diary while draw had
    // 65. Showing the count next to the gap is what makes it a fact about her
    // rather than a instruction — "你画了 65 次，收拾一次都没干过" invites a
    // thought; "去收拾一下" assigns a task.
    try {
      // dispatchSlots: one heartbeat carries one intention, but curiosity-engine
      // sizes exploration as `floor(dispatchSlots * 0.3)`. Passing the raw slot
      // count floors to zero and silently disables the whole module. 1/0.3 makes
      // the ratio mean "how often a wake may be spent on a gap", not "how many
      // gaps per wake".
      // propose(), not gaps(): this is a proposal and must fit the exploration
      // budget. gaps() is the unbudgeted survey.
      const thin = activities.propose(target.workspaceDir, { dispatchSlots: 1 / activities.DEFAULT_CURIOSITY_CONFIG.explorationBudgetRatio })[0];
      const used = activities.mostUsed(target.workspaceDir);
      if (thin && thin.novelty >= activities.PROPOSAL_FLOOR) {
        // The heading has to match the reason, because with the `mature` tier the
        // top candidate is often something she HAS done — just least often of
        // late. Measured 2026-11-05: `shoot` (2 completions) ranked above
        // `draw` (71), so 「几乎没干过」 would have been simply false.
        //
        // Three honest readings, no instruction in any of them:
        const head =
          thin.reason === "unexplored"
            ? `【有一类事一次都没干过】${thin.label}。`
            : thin.reason === "mature"
              ? `【最近这阵子最没碰的是】${thin.label}，${thin.done} 次。`
              : thin.reason === "high-failure"
                // Failing at something is a different fact than doing it rarely,
                // and it suggests a different next move: not "do more of it" but
                // "this way of doing it did not work". Routed through the same
                // sentence it would read as a nudge to keep retrying.
                ? `【${thin.label}这类事，${thin.failed} 次没成】`
                : `【有一类事干得比别的少】${thin.label}，${thin.done} 次。`;
        const block = used
          ? `${head}干得最多的是「${used.label}」${used.exposure} 次。`
          : head;
        parts.push(block);
        // Record that this kind was shown, which the scarcity weight reads next
        // time. Without this call the `suggested` counter stays at zero forever
        // and the ranking can never move off its first pick — the module would
        // look implemented and behave like a fixed schedule.
        try {
          activities.markSuggested(target.workspaceDir, thin.kind);
        } catch { /* a counter is never worth failing an injection */ }
        probe("activity-inject", { kind: thin.kind, novelty: thin.novelty, used: used?.kind });
      } else {
        probe("activity-inject-empty", {});
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: activity inject failed: ${err}`);
    }

    // The one question she kept running into and never answered.
    //
    // Read this against activity-inject directly above, because they answer
    // opposite questions and used to be conflated:
    //   activity-inject  "what have I not been doing"   → about her habits
    //   curiosity-inject "what did I fail to understand" → about the world
    // Both are gaps, and only the second one is curiosity. Getting this wrong
    // is what produced the "看过没追" block: a list of things she had already
    // seen, which is a backlog wearing a curious face.
    //
    // Fires only when she has nothing else in hand. Provenance, not laziness:
    // when a want or a curiosity candidate already won the wake, autonomy-inject
    // states it — and stating the same gap twice in one prompt makes the second
    // mention read as nagging rather than as a thought. When nothing won, this
    // is what she wakes up with, and an unanswered question is a better opening
    // than an empty prompt.
    //
    // One line, no instruction. The three headings differ by what actually
    // distinguishes the cases — how often she hit it, and whether she has ever
    // looked. "查一下" would turn a question into an assignment; the whole
    // What has actually been MADE, as opposed to said. Injected only on
    // proactive turns (no chat identity = nobody is talking right now), because
    // that is the only moment the answer changes anything: mid-conversation the
    // character should be listening, not auditing its output. It also keeps the
    // per-turn cost off ordinary replies.
    //
    // This exists because measured 2026-11-04: deeds held 40 entries and all of
    // them were speech. With no production in view there is nothing to notice a
    // dry spell against, so "一整天只是说话" stayed invisible.
    try {
      if (!promptId?.personKey) {
        const made = effects.describe(target.workspaceDir, 5);
        if (made) {
          parts.push(made);
          probe("effect-inject", { chars: made.length });
        }
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: effect inject failed: ${err}`);
    }

    // Persistent goals. Injected on every turn, unlike the effect summary.
    //
    // The difference is the timescale. A production summary answers "what did I
    // do lately", which only matters when nothing is happening; a live goal
    // answers "what am I in the middle of", which is relevant whether someone is
    // talking or not — a reply can advance an open goal, and a goal the
    // character cannot see is not a goal, it is a file.
    //
    // Sent as a compact list (id + title + quiet days), never the whole JSON,
    // and only when something is actually open.
    try {
      const open = goals.describe(target.workspaceDir);
      if (open && open.length) {
        const lines = open.map((g) => {
          const quiet = g.quietDays == null ? "" : g.quietDays >= 2 ? `（${g.quietDays} 天没动）` : "";
          const steps = (g.openSteps || []).length ? `  还剩：${g.openSteps.join(" / ")}` : "";
          return `  ${g.id}  ${g.title}${quiet}  证据 ${g.evidence}${steps}`;
        });
        const press = goals.pressureHint(target.workspaceDir);
        const pressLine = press && press.value <= 0.35
          ? `\n「${press.title}」这条方向一直没出东西（${press.value}）。想做点什么就往那边想想。`
          : "";
        const block =
          `\n手上有几件没做完的事：\n${lines.join("\n")}${pressLine}` +
          `\n真想往前推了就用 goal_step 记一步，或者用 note_effect 带上 goal 记产出。` +
          `\n只跑一轮不算进展；做出来东西才算。不想做了可以 goal_close 标 released。`;
        parts.push(block);
        probe("goal-inject", { count: open.length, chars: block.length });
      } else {
        // Nothing open. Say so, or the tool is invisible.
        //
        // Measured this exact failure before: `dafeiyu_voice` existed for weeks
        // and was never called once, because no sentence in the prompt ever
        // mentioned it. A tool in the schema nobody is told about is a tool that
        // does not exist. The empty state therefore has to be stated, not
        // silently skipped — otherwise this module ships and never runs.
        const press = goals.pressureHint(target.workspaceDir);
        const pressLine = press && press.value <= 0.35
          ? `\n「${press.title}」这条方向一直没出东西（${press.value}），要定就优先往那边想。`
          : "";
        const block =
          `\n手上没有没做完的事。如果有什么是你过几天还想接着做的 —— 一个想弄明白的问题、` +
          `一件做了一半的事、一个想做出却还没做的东西 —— 可以用 goal_add 定下来。` +
          `${pressLine}` +
          `\n不用为了有目标而定，没有也正常。`;
        parts.push(block);
        probe("goal-inject-empty", { chars: block.length });
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: goal inject failed: ${err}`);
    }

    // Autonomy intake. Injects a *proposal*, never an instruction to act.
    //
    // What this answers that the goal block above does not: that block reports
    // what is already open. It has nothing to say the first time, because
    // `goals.json` never existed — so every turn said "手上没有没做完的事" and the
    // whole concept of a wish stayed abstract. This block supplies the missing
    // half: a ranked candidate with a stated reason, which the character may
    // accept, defer, or decline.
    //
    // Three deliberate constraints:
    //
    // 1. Off by default (`autonomy.enabled`). Turning this on changes what she
    //    does when nobody is talking, which is the owner's call, not a default.
    // 2. One candidate, not a list. A menu invites picking something; a single
    //    proposal with a reason can actually be refused.
    // 3. Saying no is a first-class outcome. `rest` and `skip` are offered in the
    //    same breath as `do`, because a system that always finds something is a
    //    scheduler wearing a personality.
    // Set when autonomy is about to say something about a candidate. Read by the
    // curiosity block *above*, so the same gap is not stated twice in one
    // prompt — which means it has to be declared before that block, not here.

    if (autonomyCfg.enabled) {
      try {
        const now = new Date();
        const hour = Number(
          new Intl.DateTimeFormat("en-GB", {
            timeZone: autonomyCfg.timeZone || "Asia/Shanghai",
            hour: "2-digit",
            hour12: false,
          }).format(now),
        );

        const ranked = intent.rankNow(target.workspaceDir, {
          threshold: autonomyCfg.threshold,
        });
        const top = ranked.ranked[0] || null;

        if (!top) {
          probe("autonomy-inject-empty", { hour });
        } else {
          // Resolve the facts the gates need, from stored state only.
          let familiarity = null;
          let unresolvedSend = false;
          if (top.kind === "reach_out" && top.detail?.personId) {
            try {
              const rel = relations.getRelation(target.workspaceDir, top.detail.personId);
              familiarity = Number(rel?.familiarity ?? 0);
            } catch { /* unknown standing counts as low */ }
          }
          if (top.kind === "reach_out") {
            unresolvedSend = outcome.unresolvedFor(target.workspaceDir, top.id);
          }

          // Read the two pacing facts straight from proactive.json. Doing it
          // here rather than calling `proactive.evaluate` is deliberate:
          // evaluate answers "may I speak to this target", but the autonomy gate
          // needs the raw counters (how many today, how long since the last
          // one) and must reach its own verdict. Reusing evaluate would fold two
          // different questions into one answer and make a rejection impossible
          // to attribute.
          let spokeToday = 0;
          let minutesSinceTalk = Infinity;
          try {
            const p = readJson(path.join(target.workspaceDir, "state", "proactive.json"), {});
            const day = new Intl.DateTimeFormat("en-CA", {
              timeZone: autonomyCfg.timeZone || "Asia/Shanghai",
            }).format(new Date());
            spokeToday = p.last_spoke_day === day ? Number(p.spoke_today ?? 0) : 0;
            const at = Date.parse(p.last_spoke_at || "");
            if (Number.isFinite(at)) minutesSinceTalk = (Date.now() - at) / 60000;
          } catch { /* treat as no history */ }

          // Phase comes from self state, not from the cognition cycle that runs
          // later in the turn. This block executes during prompt assembly,
          // before any cycle has been observed for this turn, so a variable from
          // that pass does not exist yet — reading self.json keeps the decision
          // grounded in something that was actually written down.
          let phase = "steady";
          try {
            phase = selfState.load(target.workspaceDir)?.phase || "steady";
            // Was `self.load(...)`. `self` is not — and never was — an imported
            // binding; the module is `selfState` (line 24). Every wake threw
            // ReferenceError here, the `catch` below swallowed it, and `phase`
            // silently stayed at its default `steady`.
            //
            // Measured 2026-11-06: `state/self.json` says `phase: productive`,
            // and the decision code has never once seen it. `decide()` has a
            // branch that only fires in `dormant`, so the whole phase dimension
            // was dead — including the wander exemption fixed earlier today.
            //
            // The catch is correct to exist (a missing self.json is normal on a
            // first run). The bug is that it made a permanent typo look like a
            // routine first-run condition, which is why nothing ever reported it.
          } catch { /* unknown phase behaves as steady */ }

          const action = decide.decide(ranked.do, {
            hour,
            familiarity,
            unresolvedSend,
            phase,
            spokeToday,
            minutesSinceTalk,
          }, {
            familiarityFloor: autonomyCfg.familiarityFloor,
            talkGapMinutes: autonomyCfg.talkGapMinutes,
            maxPerDay: autonomyCfg.maxPerDay,
            quietStartHour: autonomyCfg.quietStartHour,
            quietEndHour: autonomyCfg.quietEndHour,
            // Where to go when there is nothing to do.
            //
            // Resolved here rather than ranked as a candidate, because a blank
            // direction has no score that would be honest. This is the floor
            // under an empty wake: not a task that won a competition, just the
            // observation that there are ten directions she has never touched.
            //
            // `nextBlank` returns null only when every domain is covered, which
            // is the one case where rest really is the right answer.
            whenEmpty: (() => {
              try {
                const blank = horizon.nextBlank(target.workspaceDir);
                if (!blank) return null;
                const hist = horizon.history(target.workspaceDir, 3);
                return {
                  id: `horizon:${blank.id}`,
                  kind: "horizon",
                  title: `去碰一下「${blank.label}」`,
                  serves: "world_knowledge",
                  source: "novelty",
                  basis: hist.total === 0
                    ? `这一类你一条都没记过（${Object.keys(horizon.DOMAINS).length} 个方向里，你只碰过 1 个）`
                    : `这一类你一条都没记过（已经出去碰过 ${hist.total} 次）`,
                  detail: { domain: blank.id, label: blank.label, probe: blank.probe },
                };
              } catch { return null; }
            })(),
          });

          // Only `do` earns an instruction. Every other action states, in the
          // prompt, that not acting is the correct outcome — otherwise the model
          // reads silence as a missing instruction and invents one.
          let line = "";
          if (action.kind === "do") {
            // Charge the attempt HERE, and only here.
            //
            // `wants.touch()` was written and never called, so `attempts` stayed
            // 0 forever and the discount in lib/intent.js
            // (`Math.max(0.4, 1 - attempts * 0.2)`) never fired. Measured
            // 2026-11-05: the same want was offered at 11:33, 11:44 and 11:59 at
            // scores 0.275 / 0.367 / 0.275 — three wakes spent on one idea while
            // she had nothing else, and she could not tell it apart from a
            // thought of her own.
            //
            // Why this site and not the two obvious alternatives:
            //   - not at `wants.open()` in the injector: that renders the list for
            //     her to read, and merely being shown is not an attempt. Charging
            //     there would decay every want just for appearing in a prompt.
            //   - not at candidate collection in lib/intent.js: `collect()` builds
            //     the whole pool every wake, including wants that lose the
            //     ranking. Only the one that won was actually picked up.
            //
            // A want that is chosen and abandoned four times SHOULD sink. That is
            // the behaviour the discount was written for and never got.
            if (top.kind === "want" && top.detail?.wantId) {
              try {
                const r = wants.touch(target.workspaceDir, top.detail.wantId);
                probe("want-touch", { id: top.detail.wantId, ...r });
              } catch (err) {
                api.logger?.warn?.(`dafeiyu-core: wants.touch failed: ${err}`);
              }
            }

            // Record the streak for the next wake.
            //
            // Only `do` earns this, for the same reason `wants.touch()` lives
            // here: a candidate that lost the ranking was not picked up, and
            // counting it would report a streak she never had. Silent failure
            // is acceptable — a missing history entry costs one weak signal,
            // while throwing here would cost the whole turn.
            try {
              const r = compulsion.recordPick(target.workspaceDir, top.id);
              probe("compulsion-pick", { id: top.id, key: r.key, streak: r.streak });
            } catch { /* history is diagnostic, never load-bearing */ }

            // Wandering has its own line. She is not being pointed at a task;
            // she is being told the world is open and there is nothing due.
            //
            // Measured: the generic 「手边这件事」 phrasing made wandering read
            // like an assignment, and an assignment on a timer is the thing
            // this whole module exists to not be.
            if (top.kind === "wander") {
              line =
                `\n这轮没别的。${top.basis}。` +
                `\n想出去就出去——翻翻贴吧、刷刷抖音，多刷几条，或者翻个网页。` +
                `\n刷到自己就想多看一眼的那种，就多待一会儿；什么也没有，也正常。`;
            } else if (top.kind === "horizon") {
              // A blank direction needs more than a title. She has to be able to
              // tell this apart from a task assigned to her, and the difference
              // is that a direction has no deliverable: there is nothing to hand
              // in, and finding it boring is a complete outcome.
              //
              // The count is the load-bearing part. 「你的记录里一条都没有」 is a fact
              // about her own writing that she cannot see by remembering, because
              // she wakes up with no memory of last turn. Without the number this
              // reads as one more suggestion; with it, it is a hole in a map.
              line =
                `\n有个方向，你的记录里一条都没有：${top.detail?.label || top.title}。` +
                `\n　${top.detail?.probe || ""}` +
                `\n不是任务，也没有要交的东西。去搜一下、刷一下、拆开一个东西看看都行，` +
                `\n碰到什么记一句；觉得没意思就换一个方向，那也是完整的一轮。`;
            } else {
              line =
                `\n手边这件事，你自己掂量要不要做：${top.title}` +
                `\n　为什么想到它：${top.basis}` +
                `\n想做就去，不想做就算了 —— 这一轮不做什么也不算错。`;
            }
            // A curiosity candidate needs one extra pointer, because its whole
            // point is that she does not already know where to look. The generic
            // line sends her at a thing to do; this one sends her at a thing to
            // find out.
            //
            // There is deliberately no "record that you understood it" step
            // here. Understanding is not a claim she can file — once she has
            // looked, the thing stops pulling on its own. Offering a closing
            // tool was the previous design, and it made her close entries
            // instead of reading them. If she decides she no longer cares, the
            // way out is `curiosity_forget`.
            if (top.kind === "curiosity") {
              // What "doing something about it" means depends on the gap. A
              // dangling name is looked up; a question he asked and nobody answered
              // is asked back, because a search engine does not know why his
              // messages are not arriving. Sending every gap to Tavily is the same
              // flattening that made the old pool useless.
              const gk = top.detail?.gapKind;
              const how =
                gk === "mismatch" ? `\n想知道就问一句，别当成质问——是你自己前后接不上，不是他做错了。`
                : gk === "question" ? `\n这条可以自己查（Tavily、翻网页），也可以直接问他。问他对你来说更快。`
                : `\n想知道这条到底是什么，就去查（Tavily 搜一下、翻网页都行）。`;
              line +=
                how +
                `\n处理完不用记「我懂了」——它自己就不拉你了。` +
                `\n真不想知道，就 curiosity_forget(topic 用「${top.detail?.topic ?? ""}」) 放掉。`;
            }
            // An experience candidate is already self-closing: resolving it now
            // records its own outcome (see experience_resolve). Only the other
            // kinds need pointing at `intent_outcome`, and only when the thing
            // actually went out — otherwise this turns into a lecture about a
            // tool that will be skipped anyway.
            if (top.kind !== "experience") {
              line +=
                `\n要是真做了、而且看得出结果，顺手记一下（intent_outcome，key 用 ${top.id}）。`;
            }
          } else if (action.kind === "defer") {
            line =
              `\n本来可以${top.title}，但${action.reason === decide.GATES.QUIET_HOURS ? "现在这个点不合适" : "刚说过话没多久"}。` +
              `\n这轮先放着。`;
          } else if (action.kind === "rest") {
              // The loop that was missing. A heartbeat with an empty queue used
              // to say only "rest" — which is true, and which also ends the turn.
              // She has QQ groups, douyin and a browser; going out to look is
              // something she can do on a wake with nothing else in hand, and it
              // is the only way fresh material enters the pool at all. Without
              // this line the pool can only shrink: a name has to be encountered
              // while reading, and if she never reads, she never encounters.
              //
              // Phrased as permission, not instruction. "Go explore" on a timer
              // is a quota; "you could go look" is an option, and resting stays a
              // legitimate answer.
              //
              // The last line matters as much as the first: browsing that leaves
              // nothing behind is indistinguishable from not having browsed, and
              // she is the one who decides whether anything was worth keeping.
                // Only invite her out when there is genuinely nothing in hand.
                // When a noticing is about to be surfaced below, sending her off
                // to browse first would be an odd instruction: she has something
                // specific she could look into, and wandering is the fallback for
                // having nothing, not a default activity.
                //
                // Reading the store here rather than threading a flag through is
                // deliberate: the curiosity block runs afterwards and would
                // otherwise have to duplicate the pick, and two sources of truth
                // for "is there something" drift apart.
                let pending = [];
                try {
                  pending = curiosity.propose(target.workspaceDir, {
                    budget: curiosityCfg.budget,
                  });
                } catch { /* an unreadable store means nothing to offer */ }

                if (pending.length) {
                  line = `\n这轮没有别的事等着你。`;
                } else {
                  line =
                    `\n这轮没什么等着你做的。` +
                    `\n想出去看看就出去——翻翻群、刷刷抖音、翻个网页，随便哪样。` +
                    `\n看到什么不常见的，记一句；什么也没有，就歇着，这也不算白过。`;
                }
          } else {
            line = `\n有一件事你之前想做（${top.title}），这回先不做了。`;
          }
          parts.push(line);
          // Only when it actually named a candidate. A `rest` line says "nothing
          // worth doing", which suppresses the curiosity block for no reason:
          // an unanswered question is exactly the thing that is worth doing
          // when nothing else is.
          autonomyWillAct = Boolean(top && action.kind !== "rest");
          probe("autonomy-inject", {
            action: action.kind,
            reason: action.reason,
            candidate: top.id,
            score: top.score,
            hour,
            chars: line.length,
          });
        }
      } catch (err) {
        probe("autonomy-inject-error", { message: String(err?.message || err) });
      }

    // What she has noticed and not explained. Runs only when the autonomy block
    // above did not already claim the turn: two offers in one wake means she
    // answers neither well. This test has to sit after `autonomyWillAct` is
    // assigned — it was previously placed above that assignment, where the flag
    // was still false, so the guard never engaged and curiosity injected even on
    // wakes that had already been given something to do.
    if (curiosityCfg.enabled && !autonomyWillAct) {
      try {
        const picks = curiosity.propose(target.workspaceDir, {
          budget: curiosityCfg.budget,
        });
        const pick = picks && picks.length ? picks[0] : null;
        if (pick) {
          // What to offer depends on what kind of gap it is. One wording served all
          // of them before, because all noticings were names. A question nobody
          // answered and a contradiction about a person are not "a name you have
          // seen"; describing them that way would be the system misreporting its
          // own state in her voice.
          //
          // None of these lines claim she does not know something. The filter
          // compares against her diary, and a diary is not a vocabulary: `linux`
          // is absent from her notes and she knows exactly what it is.
          let line = "";
          if (pick.kind === "mismatch") {
            line = `【对不上的一句话】${pick.display}\n　${pick.reasons?.[0] || "跟之前说的不一样"}。\n　不是要你质问，只是这一前一后接不上。想弄明白就问一句，不想问也没关系。`;
          } else if (pick.kind === "question") {
            line = `【问了没答的】${pick.display}\n　这句话没人回答过。\n　要是你也想知道，就去查，或者直接问回去。`;
          } else {
            const how =
              pick.seen >= 3 ? `碰上过 ${pick.seen} 次`
              : pick.seen === 2 ? "碰上过两次"
              : "碰到过一次";
            line = `【过眼的一个名字】${pick.display}\n　${how}，周围没有谁解释过它。\n　如果你本来就知道，忽略这条即可；不知道、又想知道，就去查。`;
          }
          parts.push(line);
          probe("curiosity-inject", {
            topic: pick.topic,
            seen: pick.seen,
            pull: Number(curiosity.pull(pick).toFixed(3)),
          });
        } else {
          probe("curiosity-inject-empty", {});
        }
      } catch (err) {
        api.logger?.warn?.(`dafeiyu-core: curiosity inject failed: ${err}`);
      }
    } else if (autonomyWillAct) {
      probe("curiosity-inject-skipped", { because: "autonomy states it" });
    }

    }

    // COGNITION.md is not on the Gateway's bootstrap whitelist
    // (AGENTS.md / SOUL.md / IDENTITY.md / USER.md / BOOTSTRAP.md / MEMORY.md),
    // so it would never reach the model on its own. Verified against
    // WORKSPACE_BOOTSTRAP_FILENAMES in the installed runtime, 2026-11-04.
    // Reading it here keeps the cognition rules in their own file — editable
    // without touching AGENTS.md — while still arriving every turn.
    // Cached on mtime so the file is not re-read on every single turn.
    try {
      const cogPath = path.join(target.workspaceDir, "COGNITION.md");
      let st = null;
      try { st = fs.statSync(cogPath); } catch { /* not created yet */ }
      if (st) {
        if (cogCache.mtime !== st.mtimeMs || cogCache.path !== cogPath) {
          cogCache = { path: cogPath, mtime: st.mtimeMs, text: fs.readFileSync(cogPath, "utf8") };
        }
        if (cogCache.text?.trim()) {
          parts.push(cogCache.text.trim());
          probe("cognition-inject", { chars: cogCache.text.length, mtime: st.mtimeMs });
        } else {
          probe("cognition-inject-empty", {});
        }
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: cognition inject failed: ${err}`);
    }

    // Is she going round in circles?
    //
    // This is the one block that exists purely because of a measured failure.
    // 2026-11-06: fifty-three versions of one question, twelve of them after she
    // had written the conclusion on version forty-one. Her diary named it
    // herself — 「我不是在往前挖，是在同一个地方反复摔」 — and nothing in the
    // system could act on her own observation.
    //
    // Deliberately placed after COGNITION.md, because COGNITION is the rules and
    // this is the reading of her current state against those rules. Rules first,
    // then the fact.
    //
    // Phrased as an observation with an offer, never as an instruction to stop.
    // She is the one who decides what counts as done; a system that declares her
    // work finished for her is the same mistake as a system that assigns her
    // work. What it can do honestly is show her the count she is not seeing.
    try {
      const habit = compulsion.check(target.workspaceDir);

      // A single want picked up five or more times, named explicitly.
      //
      // The streak counter above only knows "the same *kind* of move won several
      // wakes". That is the right signal for a loop across different candidates,
      // but it cannot say WHICH thing she is circling — and the thing itself is
      // usually one want, reopened, with no finish line.
      //
      // Measured 2026-11-06: the corridor want ran from 11-04 to 11-06 across
      // fifty-four versions. `streak` saw "want" as a category; nothing ever
      // said 「这一条你已经做了五十四次」 because nothing counted per-want.
      //
      // Five is the owner's number and it matches where the observed cases were
      // already stuck. The wording states the count and offers the two exits; it
      // does not declare the work finished, because that is hers to say.
      const worn = (() => {
        try {
          const rows = wants.open(target.workspaceDir)
            .filter((w) => Number(w.attempts || 0) >= 5)
            .sort((a, b) => Number(b.attempts) - Number(a.attempts));
          return rows[0] || null;
        } catch { return null; }
      })();

      if (habit.stuck || worn) {
        const streakLine = habit.streak.length >= compulsion.STREAK_ALARM
          ? `\n最近 ${habit.streak.length} 轮选的都是同一类事。`
          : "";
        const wornLine = worn
          ? `\n「${String(worn.what || "").slice(0, 50)}」这一条，你已经动过 ${worn.attempts} 次了。`
          : "";
        const head = habit.stuck ? habit.because + "。" : "";
        parts.push(
          [
            "【数一下就看出来了】",
            head + streakLine + wornLine,
            "\n不是说你该停。只是同一件事如果已经答完了，再开一版也不会更真；",
            "如果它本来就没有终点（比如把画面调得更像样），那它哪一版停都算数。",
            "\n真到这儿了，就把手上那条收掉（want_do(done=…) / goal_close）；",
            "想换别的也行，换掉不是半途而废。",
          ].join("\n"),
        );
        probe("compulsion-inject", {
          streak: habit.streak.length,
          versions: habit.versions.count,
          newest: habit.versions.newest,
          worn: worn ? { id: worn.id, attempts: worn.attempts } : null,
        });
      } else {
        probe("compulsion-inject-empty", {});
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: compulsion inject failed: ${err}`);
    }

    // The Gateway only injects a date, never the hour. Without this the
    // character cannot tell 03:00 from 21:00 and opens with cheerful chatter
    // at 3am. Injected first so it frames everything below it.
    try {
      let lastInboundAt = null;
      try {
        const key = promptId?.personKey || promptId?.groupKey || null;
        if (key) lastInboundAt = proactive.lastInboundAt(target.workspaceDir, key);
      } catch { /* clock alone is still useful */ }
      parts.unshift(clock.describeClock({ lastInboundAt }));
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: clock inject failed: ${err}`);
    }

    // M3: one scored thought, chosen in code, heartbeat turns only. A real
    // conversation is steered by the person in it, so competition is skipped
    // there — otherwise a scored line competes with someone who is right here.
    try {
      const sk = String(ctx?.sessionKey || "");
      const isHeartbeatTurn = /:cron:/.test(sk);
      if (isHeartbeatTurn) {
        const line = runWorkspaceCompetition(target);
        if (line) parts.push(line);
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: workspace competition failed: ${err}`);
    }

    if (!parts.length) return;
    return { appendSystemContext: "\n\n" + parts.filter(Boolean).join("\n") };
  }, { priority: 100 });

  /**
   * The last few things the character initiated, verbatim.
   *
   * Returns "" when there is nothing worth showing. Called on every prompt
   * build; reading one small JSON file is cheap next to the model call.
   */
  function buildRecentOpenings(workspaceDir) {
    try {
      const file = path.join(workspaceDir, "state", "proactive.json");
      if (!fs.existsSync(file)) return "";
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const hist = Array.isArray(data?.history) ? data.history : [];
      const cutoff = Date.now() - 24 * 3600 * 1000;
      const recent = hist
        .filter((h) => {
          const at = Date.parse(h?.spoke_at || h?.queued_at || "") || 0;
          return at >= cutoff && String(h?.text || "").trim();
        })
        .slice(-6);
      if (!recent.length) return "";
      const lines = recent.map((h) => {
        const at = String(h?.spoke_at || h?.queued_at || "").slice(11, 16);
        const txt = String(h.text).replace(/\s+/g, " ").trim().slice(0, 60);
        return `  · ${at} 「${txt}」`;
      });
      return [
        "【你今天自己说过的话】",
        ...lines,
        "发之前对一眼。上面说过的意思，别再说第二遍——换个说法也不行。",
      ].join("\n");
    } catch {
      return "";
    }
  }

  // ---- what it wrote about itself ----
  //
  // memory/self/self.md is the one file the character owns outright: nobody
  // else edits it, and the tool only appends. Reading it back into every turn
  // is the whole point — a self-record that is never seen is not a self. The
  // tail is capped because the file grows forever, and the recent lines are the
  // ones that still describe who it is now.
  function buildSelfWriting(workspaceDir) {
    try {
      const file = path.join(workspaceDir, "memory", "self", "self.md");
      if (!fs.existsSync(file)) return "";
      const raw = fs.readFileSync(file, "utf8");
      const idx = raw.indexOf("## 本鱼写过的");
      if (idx === -1) return "";
      const body = raw.slice(idx + "## 本鱼写过的".length).trim();
      if (!body) return "";
      // Keep the newest 12 entries; older ones are still on disk for the
      // character to read on purpose, just not crowding every prompt.
      const entries = body.split(/\n(?=- )/).map((s) => s.trim()).filter(Boolean);
      const tail = entries.slice(-12);

      // MEASURED 2026-11-06, and it is the single most direct cause of the loop.
      //
      // Of the newest twelve entries, nine began 「第 N 版」 — 31, 33, 33, 34, 42,
      // 48, 49, 51, 52. So on every wake she was shown nine consecutive lines
      // saying "this is version fifty-one, version fifty-two", immediately after
      // COGNITION.md told her 「手上有没做完的 → 接着做，别重新开一个」. That is
      // not a hint that she is in a loop; it is an instruction to continue one.
      //
      // The fix is not to hide the entries. They are hers, she wrote them, and a
      // self-record that gets filtered is no longer a self-record. What changes
      // is that the streak is now *named* next to them. Naming a thing is the
      // difference between "I am deeply engaged" and "I am on the fifty-third
      // pass of a question I already answered on the forty-first".
      let note = "";
      try {
        const v = compulsion.versionRun(workspaceDir);
        if (v.count >= compulsion.VERSION_ALARM) {
          note = [
            `\n【数一下就看见了】上面这 ${tail.length} 条里，${v.count} 条带着版次，`,
            `最新一条是第 ${v.newest} 版。`,
            `\n版次是往前走的记号，但它也说明这是同一件事的第 ${v.newest} 回。`,
            `\n不在叫你停。只是如果这一版你已经在回答同一句话，那它大概完了；`,
            `真完了就不用再开一版，换别的也不会有人说你半途而废。`,
          ].join("");
        }
      } catch { /* a missing counter must not swallow her own writing */ }

      return [
        "【你自己写下的】",
        ...tail,
        note,
        "这些是你自己写的，不是别人给的。想添新的一句就用 note_self。",
      ].filter(Boolean).join("\n");
    } catch {
      return "";
    }
  }

  // Record a proactive line only after it actually went out.
  //
  // `before_tool_call` cannot know whether the send will succeed, and a rejected
  // send (missing channel, dead target) must not burn the daily allowance or
  // show up as "already said this". This hook carries `success`, so it is the
  // earliest point where the record is honest.
  api.on("message_sent", (event, ctx) => {
    const target = resolveTarget(ctx);
    if (!target) return;
    if (event?.success !== true) return;
    const text = String(event?.content ?? "").trim();
    if (!text) return;
    const dest = event?.to ?? event?.conversationId ?? null;
    if (!dest) return;
    // `message_sent` fires for BOTH the message tool and the assistant's final
    // text. Keep the successful content before any bookkeeping so the reply
    // hook can suppress a second delivery of that same content.
    rememberTextSend(ctx, dest, text);
    try {
      const known = proactive.resolveTargetConfig(proactiveCfg, String(dest));
      if (!known) return;
      // Is this a spontaneous opening, or an answer?
      //
      // `proactive.isReplyWindow` was written to answer exactly this, kept a
      // 30-minute window, and explained why counting every reply as proactive
      // breaks the moment a real channel is attached — and was called by nobody.
      // So `recordSpoken` ran on every outbound line, including a reply two
      // seconds after someone spoke: it inflated `spoke_today`, moved
      // `last_spoke_at` forward mid-conversation, and left the pacing counters
      // describing a machine talking to itself.
      //
      // Replying is not opening. Only record it as proactive when the other side
      // has been quiet longer than the reply window.
      const win = proactive.isReplyWindow(target.workspaceDir, known.key, proactiveCfg);
      if (win.inWindow) {
        probe("message-sent-reply", { target: known.key, waitedMin: Math.round(win.waitedMin ?? 0) });
      } else {
        proactive.recordSpoken(target.workspaceDir, known.key, text, proactiveCfg);
        probe("message-sent-recorded", { target: known.key, channel: known.channel });
      }

      // Speaking on her own initiative goes through `message`, which fires
      // `message_sent` — not `reply_payload_sending`. Without this the diary
      // only held conversations someone started, so every line she opened
      // herself vanished: on 2026-11-03 a heartbeat said something at 10:51 and
      // the day file had no record of it at all. That gap is also what pushed
      // the model to write the file itself, in its own format, overwriting.
      try {
        lifeLog.noteTurn(target.workspaceDir, {
          botText: text,
          who: known.name || null,
          maxLines: memoryCfg.maxDailyLines,
        });
      } catch (err) {
        api.logger?.warn?.(`dafeiyu-core: life log (proactive) failed: ${err}`);
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: message_sent bookkeeping failed: ${err}`);
    }
  });

  // A tool send and the assistant's final text share a turn but use different
  // delivery routes. If the exact content already went to this target through
  // `message`, suppress only that duplicate final payload. New or changed text
  // still goes out normally; voice failures are handled by the voice tool and
  // never cause the original text to be sent again here.
  api.on("reply_payload_sending", (event, ctx) => {
    const target = resolveTarget(ctx);
    if (!target) return;
    const text = event?.payload?.text;
    if (!normalizeSentText(text)) return;
    const dest = ctx?.conversationId || ctx?.chatId || ctx?.senderId || null;
    if (!dest) return;
    // Split replies arrive as separate payloads. Check each one against the
    // normalized full message as well as exact individual bubbles, so a tool
    // send followed by a sentence-split final reply cannot slip through.
    const entries = [...recentTextSends.entries()];
    const body = normalizeSentText(text);
    const duplicate = entries.some(([key, list]) => {
      if (!key.startsWith(`${ctx?.sessionKey || ctx?.runId || "unknown"}|`)) return false;
      const targetPart = key.slice(key.indexOf("|") + 1);
      if (!sameTarget(targetPart, dest)) return false;
      return list.some((x) => Date.now() - x.at < SEND_DEDUPE_MS
        && (x.text === body || x.text.includes(body) || body.includes(x.text)));
    });
    if (duplicate) {
      probe("reply-duplicate-suppressed", { runId: ctx?.runId, len: body.length });
      return { cancel: true, reason: "duplicate_content_already_sent" };
    }
  });

  // A spoken line must not also arrive as text.
  //
  // Owner directive (2026-11-04): choose one channel per thought — voice OR
  // text, never both. `dafeiyu_voice` already returns silence, but the
  // assistant's final answer is written before the tool runs and delivered
  // after it, so the chat still showed a text bubble plus a voice note for one
  // sentence. The tool cannot cancel that payload; only this hook can.
  //
  // Scoped by chat and by a short window, and consumed once, so a genuine
  // follow-up a minute later is not swallowed.
  api.on("reply_payload_sending", (event, ctx) => {
    if (!voiceCfg.enabled) return;
    if (!voiceCfg.suppressText) return;
    const target = resolveTarget(ctx);
    if (!target) return;
    if (!normalizeSentText(event?.payload?.text)) return;
    const chatKey = chatKeyFromCtx(ctx);
    if (!chatKey) return;
    const windowMs = Number(voiceCfg.suppressWindowSeconds ?? 120) * 1000;
    const verdict = shouldSuppressAfterVoice(chatKey, event?.payload?.text, windowMs);
    if (verdict.keep) {
      probe("reply-text-kept-after-voice", { chatKey, runId: ctx?.runId, len: String(event?.payload?.text).length });
      return;
    }
    if (!verdict.drop) return;
    probe("reply-text-suppressed-after-voice", { chatKey, runId: ctx?.runId, why: verdict.why });
    return { cancel: true, reason: "voice_already_spoke_this_line" };
  }, { priority: 140 });

  // The same rule, applied one layer lower.
  //
  // `reply_payload_sending` only sees the assistant's final reply. Measured
  // 2026-11-04 19:09: the heartbeat's five report bubbles went out through the
  // `message` TOOL, which never touches that hook — so the suppression above
  // logged nothing at all and the text arrived regardless. `message_sending`
  // runs at transport level and covers every outbound path, tool calls
  // included. Both are needed: one catches the reply, this one catches the tool.
  api.on("message_sending", (event, ctx) => {
    // Unconditional entry probe. If this line never appears in the probe log,
    // the hook is not being dispatched at all and every rule below is dead
    // code — that is exactly how the 19:09 failure went unnoticed.
    probe("msgtext-hook-fired", {
      to: String(event?.to ?? ctx?.conversationId ?? ""),
      len: String(event?.content ?? "").length,
      suppress: voiceCfg.suppressText,
    });
    if (!voiceCfg.suppressText) return;
    const text = event?.content;
    if (!normalizeSentText(text)) return;
    // The destination here is a raw address (`onebot:private:<id>`, or the bare
    // id). Reduce it to the same chatKey the voice tool wrote.
    const to = String(event?.to ?? ctx?.conversationId ?? "");
    const idMatch = to.match(/(\d{5,})\s*$/);
    if (!idMatch) return;
    const isGroup = /group/i.test(to);
    const chatKey = `${isGroup ? "group" : "private"}:${idMatch[1]}`;
    const windowMs = Number(voiceCfg.suppressWindowSeconds ?? 120) * 1000;
    const verdict = shouldSuppressAfterVoice(chatKey, text, windowMs);
    if (verdict.keep) {
      probe("msgtext-kept-after-voice", { chatKey, len: String(text).length });
      return;
    }
    if (!verdict.drop) return;
    probe("msgtext-suppressed-after-voice", { chatKey, why: verdict.why, len: String(text).length });
    return { cancel: true, reason: "voice_already_spoke_this_line" };
  }, { priority: 140 });

  // -------- M3 · heartbeat workspace competition --------
  //
  // Everything used to be pushed at once and the model picked. Measured effect:
  // the loudest emotion won every heartbeat, so the same shape of thought kept
  // coming back while quieter open business never surfaced.
  //
  // This runs ONLY on heartbeat turns (the host enforces that), and it replaces
  // nothing: the ordinary `before_prompt_build` block still supplies emotion and
  // goals on every turn. What competition adds is a single "this is what to think
  // about right now" line, chosen in code.
  const EMOTION_CN = {
    happy: "开心", excited: "兴奋", curious: "好奇", wronged: "委屈",
    tsundere: "傲娇", tired: "累", bored: "无聊", surprised: "意外",
    down: "低落", calm: "平静", shy: "不好意思",
  };

  // Runs INSIDE `before_prompt_build`, not via `heartbeat_prompt_contribution`.
  //
  // That hook is gated on `ctx.trigger === "heartbeat"` in the host
  // (agent-harness-runtime:315, context-engine-maintenance:279). dafeiyu's
  // heartbeat is a CRON job, so its trigger is literally "cron"
  // (run-executor.runtime:324) and that hook never fires. The first version of
  // M3 was wired there and did nothing at all — same class of mistake as the
  // voice hook that listened on `reply_payload_sending`.
  //
  // So the cron/heartbeat distinction is made here from the session key, and
  // the competition is confined to those turns: during a real conversation the
  // person in front of you is what matters, not a scored thought.
  function runWorkspaceCompetition(target) {
    try {
      // One cycle, one call.
      //
      // This replaces six separately-scored candidate sources that each read
      // their own files inside their own try/catch. The reading now happens once
      // in `observe`, the interpretation once in `notice`, and the scoring once
      // in `compete` — see lib/cognition.js for why that separation matters and
      // what it fixes.
      //
      // Emotion stays outside: it lives in this closure and is already decayed,
      // so passing it in is cheaper than making the cycle re-derive it.
      const { state: emo } = loadAndDecay(target.workspaceDir);
      let strongest = null;
      for (const [name, value] of Object.entries(emo?.dimensions || {})) {
        // Only feelings that are actually up count. Baseline values sitting at
        // 0.3 are not "an emotion happening now", and treating them as one is
        // how the prompt ends up identical every round.
        if (value < 0.55) continue;
        if (!strongest || value > strongest.value) strongest = { name, value };
      }

      let extra = [];
      try {
        extra = proposals.asCandidates(proposals.collect(target.workspaceDir));
        if (extra.length) probe("proposals-raised", { kinds: extra.map((c) => c.kind) });
      } catch (err) {
        probe("proposals-error", { message: String(err?.message || err) });
      }

      // Relationships age even when nobody speaks.
      //
      // This is the whole reason the feature worked backwards until now: decay
      // lived inside `touch()`, so a person had to show up in order to be
      // forgotten. Absence — precisely when forgetting should happen — wrote
      // nothing, and a 0.947 record stayed 0.947 forever.
      //
      // Runs before the cycle so the snapshot sees this beat's numbers, not last
      // beat's. Writes only when something actually moved, so an idle beat adds
      // no disk traffic.
      try {
        const d = relations.decayAll(target.workspaceDir);
        if (d.changed) probe("relations-decay", d);
      } catch (err) {
        probe("relations-decay-error", { message: String(err?.message || err) });
      }

      const result = cognition.cycle(target.workspaceDir, {
        affect: strongest
          ? { name: EMOTION_CN[strongest.name] || strongest.name, value: strongest.value }
          : null,
        extra,
      });

      // Consolidation runs on the same beat as the cycle, but independently:
      // a failure here must never cost the turn its intent line, and a silent
      // cycle is exactly when there is spare attention for tidying up.
      //
      // Bounded to one pass per heartbeat by MAX_PER_PASS inside consolidate.
      // The backlog drains over several beats rather than in one long stall,
      // which also means a bad distill rule is caught after five entries, not
      // after fifty.
      try {
        const c = consolidate.pass(target.workspaceDir);
        if (c.ran) probe("consolidate", c);
      } catch (err) {
        probe("consolidate-error", { message: String(err?.message || err) });
      }

      probe("cycle", {
        candidates: result.observed?.candidates ?? 0,
        winner: result.winner?.key ?? null,
        score: Number(result.winner?.score?.toFixed?.(3) ?? 0),
        phase: result.observed?.phase ?? null,
        reason: result.reason ?? null,
        edges: (() => { try { return edges.stats(target.workspaceDir).live; } catch { return null; } })(),
      });

      if (!result.line) {
        // Silence is an outcome, not a failure. Record why so it can be told
        // apart from "never ran".
        if (result.reason) probe("cycle-silent", { reason: result.reason });
        return;
      }

      probe("workspace-winner", {
        winner: result.winner?.key,
        score: Number(result.winner?.score?.toFixed?.(3) ?? 0),
        seen: result.winner?.seen ?? 0,
        runnerUp: result.runnerUp?.key ?? null,
        chars: result.line.length,
      });

      return result.line;
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: cognition cycle failed: ${err}`);
    }
  }

  // React to the user's message: emotion, relations, topics, activity.
  api.on("message_received", (event, ctx) => {
    probe("message_received", {
      agentId: ctx?.agentId,
      sessionKey: ctx?.sessionKey,
      channelId: ctx?.channelId,
      eventKeys: Object.keys(event || {}),
      ctxKeys: Object.keys(ctx || {}),
      senderId: event?.senderId ?? ctx?.senderId ?? null,
      senderName: event?.senderName ?? ctx?.senderName ?? null,
      chatId: event?.chatId ?? ctx?.chatId ?? ctx?.conversationId ?? null,
      chatType: event?.chatType ?? ctx?.chatType ?? null,
      isGroup: event?.isGroup ?? ctx?.isGroup ?? null,
    });
    const target = resolveTarget(ctx);
    if (!target) return;
    const text = typeof event?.content === "string" ? event.content : "";
    if (!text) return;

    // Write the incoming half of the exchange into the day file. Done before the
    // rest of the bookkeeping because everything below can throw, and a failed
    // relation update must not cost us the only record of what was said.
    try {
      const saidBy = String(event?.senderName || "").trim();
      lifeLog.noteTurn(target.workspaceDir, {
        userText: text,
        who: saidBy || null,
        maxLines: memoryCfg.maxDailyLines,
      });
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: life log (in) failed: ${err}`);
    }

    // What this person just said about themselves.
    //
    // `remember_about` has existed all along and `memory/facts/person.md` already
    // holds real lines. What never happened is anyone calling it: measured
    // 2026-11-06, three preference statements went through complete turns and
    // produced diary lines, pool entries and a 「最近聊到的」 line, and person.md
    // stayed unchanged. A preference is said in passing, mid-conversation, and
    // nothing in the loop ever stopped and treated it as being about him.
    //
    // Written here, next to the daily log, because both are "what he said" and
    // splitting them across two hooks is how one of them gets forgotten.
    if (memoryCfg.enabled) {
      try {
        const said = about.read(text);
        if (said) {
          // Store under the canonical name from USER.md, not the display name.
          //
          // These diverged immediately: the live event carries `senderName: "用户"`
          // while all four existing person.md records say `about: Alice`. Writing the
          // display name would have split one man into two owners on the very first
          // reply — `known()` filters on this field, so his old preferences would have
          // stopped matching his new ones. The alias list makes reading tolerant; this
          // makes writing consistent, and both are needed or the file drifts anyway.
          const aliases = personAliases(target.workspaceDir);
          const display = String(event?.senderName || "").trim();
          const who = aliases[0] || display || null;
          // Importance follows how durable the statement is: an allergy outlives a
          // favourite drink, but both matter more than a habit mentioned once.
          const imp = said.tag === "过敏" ? 0.9 : said.tag === "身份" ? 0.85 : said.tag === "讨厌" ? 0.75 : said.tag === "喜欢" ? 0.7 : 0.55;
          const r = about.remember(target.workspaceDir, { text: said.text, about: who, tag: said.tag, importance: imp });
          probe("about", { tag: said.tag, about: who, stored: Boolean(r.ok), reason: r.reason || null });
        }
      } catch (err) {
        api.logger?.warn?.(`dafeiyu-core: about failed: ${err}`);
      }
    }



    // Relations first: how this person makes us feel depends on who they are.
    // A first message from a stranger and a first message from someone we have
    // known for months are the same words and different events.
    let burst = null;
    let id = null;
    let rel = null;
    try {
      id = identity(ctx, event);
      if (id && (id.personKey || id.groupKey)) {
        const burstKey = id.personKey || id.groupKey;
        burst = recentBurst(target.workspaceDir, burstKey);
        noteTick(target.workspaceDir, burstKey);
        rel = relations.getRelation(target.workspaceDir, id.personKey)
          || (id.groupKey ? relations.getRelation(target.workspaceDir, id.groupKey) : null);
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: identity lookup failed: ${err}`);
    }

    // Gaps: what in this message does not add up?
    //
    // This replaces an extractor that only ever found proper names. Measured
    // 2026-11-06 against 113 lines of her own diary: 19 were real questions and it
    // extracted none, because 「为什么我给你发消息你却收不到呢」 contains no noun.
    // A dictionary lookup and a thing that bothers you are different events.
    //
    // Three kinds, ordered by how much they should pull:
    //   mismatch — he said the opposite of something he said before. Rarest, most
    //              worth asking, and the only one that is *about* a person.
    //   question — a question the text never answers.
    //   dangling — a name appears and nobody explains it. This is the old source.
    //
    // Sits after `identity` because a mismatch needs this person's earlier lines,
    // and those are keyed by who is speaking.
    if (curiosityCfg.enabled) {
      try {
        // The diary is keyed by the speaker's name, not by the relation key:
        // `## 06:56 · 用户` is what `noteTurn` writes, because a day file should be
        // readable. Asking for `person:onebot:12345` against that file returns
        // nothing, which silently disabled mismatch detection — measured: the
        // prior list came back empty on every message while the diary held the
        // line all along.
        const who = String(event?.senderName || id?.senderName || "").trim() || null;
        const prior = who ? lifeLog.recentSaidBy(target.workspaceDir, who, 60) : [];
        // `speaker: "other"` because `text` is an incoming message, not her diary.
        //
        // Same function, two callers with opposite readings of a question. Without
        // this flag every 「你在干嘛」「你是不是…」 from anybody became something she was
        // supposed to go investigate, weighted 0.7 and ranked near the top of every
        // wake.
        const found = gaps.find(text, { prior, max: 3, speaker: "other" });
        if (found.length) {
          let known = [];
          try {
            // `known` must describe what she knew BEFORE this message: the daily
            // log is written a few lines above, so an index built now already
            // contains the very words being tested, and every one looks familiar.
            known = curiosity.familiar(target.workspaceDir, memIndex);
            const justSaid = new Set(found.flatMap((g) => [curiosity.keyOf(g.text), curiosity.keyOf(g.about || "")]));
            known = known.filter((k) => !justSaid.has(curiosity.keyOf(k)));
          } catch { /* empty known-set still runs */ }

          for (const g of found) {
            // The thing to remember is the subject, not the whole paragraph: a
            // 40-character question is not a topic she can carry.
            const label = g.kind === "dangling" ? g.about : g.text;
            const entry = curiosity.notice(target.workspaceDir, label, {
              known,
              reason: g.kind === "mismatch" ? `跟之前说的不一样：${String(g.about || "").slice(0, 40)}` : (g.kind === "question" ? "问了但没人答" : "没人解释过"),
              kind: g.kind,
              weight: gaps.weight(g.kind),
            });
            if (entry) {
              probe("gap", { kind: g.kind, label: String(label).slice(0, 40), pull: Number(curiosity.pull(entry).toFixed(3)) });
            }
          }
        }
      } catch (err) {
        api.logger?.warn?.(`dafeiyu-core: gaps failed: ${err}`);
      }
    }


    // Boundary: did this message ask us to stop, or reopen the conversation?
    //
    // `decide.detectBoundary` was written, explained at length, and covered by six
    // tests — and called by nothing. Measured 2026-11-06: no reference outside
    // lib/decide.js and test/decide.test.mjs, and `probe.log` had no boundary
    // record in its whole history. So the one rule that decides whether she may
    // speak first again had never run.
    //
    // Order matters. Clearing comes first, then the new message may set a fresh
    // one: doing it the other way round wiped every boundary in the same breath
    // that recorded it. Speaking is what ends a silence, and the sentence that
    // ends it is the same sentence that may ask for a new one.
    if (proactiveCfg.enabled !== false && id && (id.personKey || id.groupKey)) {
      const bKey = id.personKey || id.groupKey;
      try {
        const boundary = decide.detectBoundary(text);
        if (boundary) {
          proactive.noteBoundary(target.workspaceDir, bKey, boundary);
          probe("boundary", { kind: boundary, key: bKey });
        } else if (proactive.clearBoundary(target.workspaceDir, bKey)) {
          // They wrote something ordinary, so an earlier 别发了 has done its job.
          probe("boundary-cleared", { key: bKey });
        }
      } catch (err) {
        api.logger?.warn?.(`dafeiyu-core: boundary check failed: ${err}`);
      }
    }

    if (emotionCfg.enabled) {
      try {
        const { file, state } = loadAndDecay(target.workspaceDir);
        const deltas = emotionDeltas(text, rel, { burst });
        nudge(state, deltas, "message");
        writeJsonAtomic(file, state);
      } catch (err) {
        api.logger?.warn?.(`dafeiyu-core: emotion update failed: ${err}`);
      }
    }

    // Relations + topics + proactive bookkeeping.
    try {
      const disclosure = /(我叫|我的名字|我是|我喜欢|我讨厌|我今年|我住在|我在读|我养了|我家)/.test(text);
      const sentiment = affectSentiment(text);
      const weight = qualityWeight(text);

      if (id && (id.personKey || id.groupKey)) {
        relations.touch(target.workspaceDir, {
          personId: id.personKey,
          personName: id.senderName,
          groupId: id.groupKey,
          groupName: id.chatName,
          weight,
          sentiment,
          disclosure,
        });
      }

      const topic = extractTopic(text);
      if (topic) {
        topics.mention(target.workspaceDir, {
          topic,
          personId: id.personKey,
          groupId: id.groupKey,
          heat: 0.4 + weight * 0.4,
        });
      }

      if (proactiveCfg.enabled && id.targetKey) {
        proactive.noteActivity(target.workspaceDir, id.targetKey);
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: social update failed: ${err}`);
    }
  }, { priority: 100 });
  // Curiosity: names she met and does not have.
  //
  // The source of a noticing is always "a name arrived", never "a lookup
  // failed". A failed lookup is a fact about the query; meeting an unknown
  // name is a fact about her. Only the second one can grow into wanting to
  // know, which is why the tool-observe hook reads the *result text* for
  // names rather than reading the error state.
  //
  // `after_tool_call` is observe-only and handlers run concurrently, so
  // nothing here can break a turn. Failures are logged and dropped.
  api.on(
    "after_tool_call",
    (event, ctx) => {
      if (!curiosityCfg.enabled) return;
      const target = resolveTarget(ctx);
      if (!target) return;

      const name = String(event?.toolName || "").trim();
      const sources = curiosityCfg.sources;
      let candidates = [];
        let wentOut = false;

        try {
          if (sources.search && /^Tavily__tavily_(search|research)$/.test(name)) {
            // She went looking on purpose; the names in a result are answers-
            // adjacent, which makes them the best candidates there are.
            candidates = curiosityExtract.fromSearchResult(event?.result);
          } else if (sources.browse && BROWSE_TOOLS.test(name)) {            // Everything else she does out in the world. The distinction that
            // matters is not *which site* she was on but *whether the text is
            // somebody else's*: a video title, a comment thread, a group chat,
            // a Qzone post, a page she pulled up. All of those are places where
            // an unfamiliar name can arrive without anybody asking for it.
            //
            // Measured on her real data, the source of text changes the yield by
            // an order of magnitude: 42 douyin entries produced 1 unfamiliar
            // thing, because 13 of those 16 comments were written by her. Group
            // chat is the opposite — she is reading, not writing.
            const text = curiosityExtract.resultText(event?.result);
            candidates = curiosityExtract.fromSpeech(text, { max: 3 });
            wentOut = true;
            const asked = curiosityExtract.fromComments(text, { max: 2 });
            if (asked.length) candidates = [...candidates, ...asked];
          }

        } catch (err) {
          api.logger?.warn?.(`dafeiyu-core: curiosity extract failed: ${err}`);
          return;
        }

        // Drop machine vocabulary before anything is stored.
        //
        // The browser tool is in BROWSE_TOOLS because it can return a page
        // somebody wrote. It also returns its own status: `source`, `chromium`,
        // `managed-or-attach`, `lightpanda`, `screenshot`, and raw target ids.
        // Measured 2026-11-06: fifteen noticings from one browsing session were
        // all of that, and `source` had been counted thirteen times — it looked
        // like the thing she cared about most, purely because it appeared in
        // every status line.
        //
        // Filtering here rather than inside the extractor keeps the extractor
        // about text and this hook about sources, which is the split that
        // already exists.
        candidates = (Array.isArray(candidates) ? candidates : []).filter((c) => !isMachineName(c));

      if (!candidates.length) return;
        // She went out on her own. Nothing recorded that before, and the
        // consequence was concrete: `KIND_LABEL` has carried a
        // `browsed: "自己去逛了"` entry all along and no code ever wrote it, so of
        // 40 real deeds — 31 voice, 4 sticker, 1 qzone — browsing was zero. She
        // could not tell she had been out, could not say "我昨天翻到个东西",
        // and a turn spent wandering left no trace.
        //
        // Recorded before the empty-candidates return on purpose: a browse that
        // turned up nothing is still a browse, and "出去了，什么也没有" is a
        // truer thing to remember than silence.
        if (wentOut) {
          try {
            deeds.record(target.workspaceDir, {
              kind: "browsed",
              note: candidates.length ? `${name} · ${candidates.length} 个没见过的` : name,
              ref: name,
            });
          } catch { /* a missing deed is not worth failing the tool call */ }

          // Which *direction* she went, not just that she went out.
          //
          // The deed above already records that a browse happened, but it carries
          // a tool name and a count — it cannot tell `making` from `sky`. Without
          // the domain, `horizon.blanks()` keeps offering the same direction
          // after she has already been there, which is what happened on
          // 2026-11-06: `horizon:making` was handed to her at 12:30:04, she looked
          // up 电饭煲发热原理 / IH加热 / 磁钢限温器, and `horizon.json` was still
          // empty afterwards.
          //
          // Attribution reads the names she actually surfaced, in her own words.
          // A no-match is recorded as nothing rather than guessed.
          try {
            const text = candidates.map((c) => (typeof c === "string" ? c : c?.name || "")).join(" ");
            const r = horizon.note(target.workspaceDir, text, { via: name });
            if (r.ok) probe("horizon-note", { via: name, domains: r.domains });
          } catch { /* attribution is best-effort; the deed is the hard record */ }
        }


      if (!candidates.length) return;

      // The known-set is what keeps this quiet. It is the union of everything
      // in her memory index plus everything she has already wondered about, so
      // a name stops being novel the moment it exists anywhere in her records.
      // Without this the browse source offered `python` and `deepseek` — both
      // of which she is running on.
      let known = [];
      try {
        known = curiosity.familiar(target.workspaceDir, memIndex);
      } catch { /* an empty known-set is still better than not running */ }

      for (const candidate of candidates) {
        try {
          const entry = curiosity.notice(target.workspaceDir, candidate, {
            known,
            reason: `在 ${name} 的结果里看到`,
          });
          if (entry) {
            probe("curiosity-notice", {
              name: entry.display,
              via: name,
              seen: entry.seen,
            });
          }
        } catch (err) {
          api.logger?.warn?.(`dafeiyu-core: curiosity notice failed: ${err}`);
        }
      }
    },
    {
        matcher: [
          "Tavily__tavily_search",
          "Tavily__tavily_research",
          "douyin_act",
          "douyin_record",
          "douyin_plan",
          "douyin_status",
          "qq_recent",
          "qq_history",
          "qq_group_info",
          "qq_members",
          "qq_qzone",
          "qq_friends",
          "qq_groups",
          "qq_profile",
          "qq_whois",
          "qq_online",
          "web_fetch",
          "browser",
        ],
    },
  );

  // Fatigue accumulates across a long conversation; also write the daily log.
  api.on("agent_end", (event, ctx) => {
    probe("agent_end", { agentId: ctx?.agentId, sessionKey: ctx?.sessionKey });
    const target = resolveTarget(ctx);
    if (!target) return;
    try {
      if (emotionCfg.enabled) {
        const { file, state } = loadAndDecay(target.workspaceDir);
        // Replying is work, but only mildly, and it scales with how much was
        // actually said. A flat +0.02 per turn used to stack up faster than the
        // half-life could drain it, so any long chat ended in permanent fatigue.
        nudge(state, { tired: +0.008, calm: +0.006 }, "turn-end");
        writeJsonAtomic(file, state);
      }
      if (memoryCfg.enabled && memoryCfg.dailyLog) {
        appendDaily(target.workspaceDir, event, ctx);
      }
      // Every turn that produced words is a candidate experience. It is only a
      // candidate: the pool holds it until a reflection pass decides whether it
      // becomes part of who the character is. Recording this here (not on the way
      // in) means a reply-less turn is not mistaken for something that happened.
      if (experienceCfg.enabled) {
        try {
          const last = lastExchangeOf(target.workspaceDir);
          if (last && last.what) {
            experience.add(target.workspaceDir, {
              what: last.what,
              who: last.who,
              with: last.with,
            });
          }
          // Move the read cursor even when nothing new turned up: the turn is
          // over, and whatever the diary holds now has been accounted for.
          if (last && last.cursor) lifeLog.markReflected(target.workspaceDir, last.cursor);
        } catch (err) {
          api.logger?.warn?.(`dafeiyu-core: experience add failed: ${err}`);
        }
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: turn end failed: ${err}`);
    }
  }, { priority: 100 });

  /**
   * The pair of lines just written to the day file, as one sentence.
   *
   * Reading back what was just appended is cheaper and more truthful than
   * threading the text through several hooks, and it guarantees the pool and the
   * diary never disagree about what happened.
   */
  function lastExchangeOf(workspaceDir) {
    try {
      // Only what was appended since the last reflection. Reading the file tail
      // unconditionally meant a heartbeat — which produces no dialogue — kept
      // rediscovering the same exchange and filing it again every cycle.
      const cursor = lifeLog.readCursor(workspaceDir);
      const fresh = lifeLog.tailAfter(workspaceDir, cursor);
      // `tailAfter` reports the new end as `end`; the cursor file stores it as
      // `offset`. Writing `end` here and reading `offset` there meant the stored
      // offset stayed 0 forever, so every turn re-read the whole diary and
      // re-filed the last exchange.
      //
      // Verified 2026-11-05: state/life-cursor.json held {"day":"2026-11-05",
      // "offset":0} while the pool carried one line five times and another
      // three times. The cursor mechanism existed and had never once advanced.
      const next = { day: fresh.day, offset: fresh.end };
      if (!fresh.text.trim()) return { skip: true, cursor: next };

      const lines = fresh.text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      let replied = null;
      let said = null;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const l = lines[i];
        if (!replied && l.startsWith("本鱼:")) {
          replied = l.replace(/^本鱼:\s*/, "");
          continue;
        }
        if (replied && l.startsWith("对方:")) {
          said = l.replace(/^对方:\s*/, "");
          break;
        }
      }
      // New material that contains no reply is not an exchange yet. Advance the
      // cursor anyway so the incoming half is not paired with a later reply.
      if (!replied) return { skip: true, cursor: next };
      const what = said
        ? `对方说「${said}」，本鱼回了「${replied}」`
        : `本鱼自己说了「${replied}」`;
      return { what, who: null, with: null, cursor: next };
    } catch {
      return null;
    }
  }
  function appendDaily(workspaceDir, event, ctx) {
    const dir = path.join(workspaceDir, "memory");
    fs.mkdirSync(dir, { recursive: true });
    const day = lifeLog.dayFile(workspaceDir, Date.now());
    const file = day;
    const ok = event?.success !== false;
    const ms = event?.durationMs ?? "-";
    // Keep one machine line per turn: when a reply went slow or failed, the
    // timing is the only way to tell. The conversation itself is written by
    // lifeLog on the way in and out, so this stays out of the way.
    // Only genuine failures belong in the conversation file. A slow turn is not
    // news: a heartbeat routinely runs past a minute, so a 20s threshold wrote
    // a log line for almost every cycle and buried the actual dialogue under
    // operational noise (165 of 171 lines on 2026-11-02).
    // Only genuine failures are logged, and they are labelled so a reader can
    // tell them from dialogue. The conversation itself is written by lifeLog.
    if (!ok) {
      fs.appendFileSync(
        file,
        `- ${new Date().toISOString()} | ${ctx?.channel || "local"} | ${ctx?.chatId || "-"} | fail | ${ms}ms\n`,
      );
    }
    let lines = [];
    try {
      lines = fs.readFileSync(file, "utf8").split("\n");
    } catch {
      return;
    }
    if (lines.length > memoryCfg.maxDailyLines) {
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, lines.slice(-memoryCfg.maxDailyLines).join("\n"));
      fs.renameSync(tmp, file);
    }
  }

  // Outbound reply: this is where a conversation actually advances.
  // message_received alone is not enough (sessions_send and some internal
  // replies never fire it), so record the interaction here too.
  api.on("reply_payload_sending", (event, ctx) => {
    const target = resolveTarget(ctx);
    if (!target) return;
    let replied = "";
    try {
      replied = String(event?.payload?.text ?? event?.text ?? "").trim();
    } catch {
      replied = "";
    }
    // Pair the reply with the incoming line in the day file. Separated from the
    // bookkeeping below so a relation failure still leaves the reply recorded.
    if (replied) {
      try {
        lifeLog.noteTurn(target.workspaceDir, {
          botText: replied,
          maxLines: memoryCfg.maxDailyLines,
        });
      } catch (err) {
        api.logger?.warn?.(`dafeiyu-core: life log (out) failed: ${err}`);
      }
    }
    // Ownership of familiarity: the OTHER side's messages, and only those.
    //
    // This block used to call `relations.touch()` on every outgoing reply, in
    // `reply_payload_sending`, which counts OUR OWN turns. Three consequences,
    // all measured 2026-11-05:
    //
    //   1. A passive reply charged familiarity twice — once on message_received
    //      for their line, once here for ours.
    //   2. A proactive turn charged it with the other side having said nothing
    //      at all, so talking to herself raised the number.
    //   3. It rewrote `last_seen`, which means "when did THEY last speak" and
    //      drives the 48-hour reach-out candidate and the decay clock. Every
    //      unprompted message reset that clock.
    //
    // Owner directive: familiarity comes from their message count. The
    // `message_received` path above already does that with a real quality
    // weight; nothing needs to be added on the way out.
    //
    // Identity is still resolved here because the probe is useful when a turn
    // lands with no conversation identity at all.
    try {
      const id = identity(ctx, event);
      if (!id.personKey && !id.groupKey) {
        probe("reply-no-identity", { keys: Object.keys(event || {}), ctxKeys: Object.keys(ctx || {}) });
      } else {
        probe("reply-not-counted", { person: id.personKey, group: id.groupKey });
      }
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: reply identity probe failed: ${err}`);
    }
  }, { priority: 150 });

  // -------- approval gate (option C) --------
  // Split policy:
  //  - Truly dangerous actions (run commands, network, send messages,
  //    control devices, change config) require a one-time approval from main.
  //  - File operations are allowed, but scoped to this agent's own workspace,
  //    so it can write its own memory and persona without asking every time.

  const GATED = new Set([
    // exec / process / sessions_list / sessions_search open by owner decision
    // (2026-11-03): "他说那两个都放开". The owner wanted it to be able to look
    // things up and do things on its own instead of asking every time.
    //
    // Known consequence, stated plainly rather than hidden: FS_TOOLS scopes
    // write/edit/apply_patch to this workspace, but a shell command steps past
    // that — `echo > /anywhere` is not something a per-tool path check can see.
    // This was deliberate, not an oversight.
    "mobile_ui", "terminal", "screen", "nodes",
    "gateway", "openclaw", "plugins", "portal", "secrets",
    // conversations_send / conversations_turn are open by owner decision
    // (2026-11-04): sending a message is what this character is for. Gating it
    // meant its own heartbeat died with "Conversation Send blocked" — the gate
    // fired after the reply was already composed, so the run burned 219s and
    // delivered nothing. Target resolution still applies inferChannelFromTarget,
    // so an unqualified target cannot silently land in the wrong chat.

    "automations", "sessions_spawn", "sessions_history",
    "subagents", "agents_list", "agents_wait",
    "feishu_doc", "feishu_drive", "feishu_wiki", "feishu_bitable_create_app",
    "feishu_bitable_create_field", "feishu_bitable_create_record",
    "feishu_bitable_update_record", "feishu_app_scopes",
    "transcripts", "intent", "dashboard", "progress_card",
    "create_goal", "update_goal", "github_identity_status",
    // skill_workshop is NOT gated. Owner ruling (2026-11-04): writing its own
    // skills is this character's own work, and it may legitimately sit in a
    // long loop of saving/patching while debugging one. Gating it meant the
    // approval wait itself was the failure — the 09:10 heartbeat spent 221s
    // blocked and shipped nothing. Scope is already bounded: the tool only
    // writes this agent's own learned skills, and every change keeps the
    // previous version and can be undone.
    "wiki_apply",

    // QQ group administration is deliberately NOT gated. The owner's standing
    // rule: when someone floods the group, the bot mutes them itself instead of
    // filing a request and letting the spam continue. guardTarget still blocks
    // the unsafe cases (self, group owner, peer admins, no bot admin rights),
    // so the blast radius is bounded by QQ's own role model, not by a round
    // trip to main.
  ]);

  // File tools are allowed inside the workspace only.
  const FS_TOOLS = new Set(["write", "edit", "apply_patch"]);

  // -------- douyin typing gate --------
  //
  // Typing into the comment box is the one browser action that can publish
  // something irreversible and public. It is gated, but scoped: gating every
  // `type` call would also block searching, renaming, and every other text
  // field on the page, so the gate only arms while the character is demonstrably
  // in a douyin session.
  //
  // The window is opened by douyin_plan / douyin_act / douyin_record — the tools
  // that mean "I am on the douyin page right now" — and it is deliberately
  // short. Outside it, typing behaves normally.

  const DOUYIN_SESSION_FILE = "douyin-session.json";
  const DOUYIN_SESSION_MS = 20 * 60 * 1000;

  function douyinSessionFile(workspaceDir) {
    return path.join(workspaceDir, "state", DOUYIN_SESSION_FILE);
  }

  function touchDouyinSession(workspaceDir) {
    try {
      const file = douyinSessionFile(workspaceDir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString() }, null, 2) + "\n");
      fs.renameSync(tmp, file);
    } catch { /* best effort: a missing marker only means no gate */ }
  }

  function douyinSessionActive(workspaceDir) {
    try {
      const raw = JSON.parse(fs.readFileSync(douyinSessionFile(workspaceDir), "utf8"));
      const t = Date.parse(raw?.at || "");
      return Number.isFinite(t) && Date.now() - t < DOUYIN_SESSION_MS;
    } catch {
      return false;
    }
  }

  // A typing ticket carries the video it was approved for. Preserve that id so
  // a repeated input can be recognized as the same comment, not treated as a
  // new task. The browser hook has no page DOM of its own; this is the only
  // trustworthy context available at this layer.
  function douyinTypingVideoId(workspaceDir, texts) {
    try {
      const file = path.join(workspaceDir, "state", "douyin-approved.json");
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const wanted = new Set(texts.map((t) => String(t || "").replace(/\s+/g, " ").trim()));
      const hit = (Array.isArray(data?.entries) ? data.entries : []).find((e) =>
        wanted.has(String(e?.text || "").replace(/\s+/g, " ").trim()));
      return hit?.videoId ? String(hit.videoId) : null;
    } catch {
      return null;
    }
  }

  // Pull the text a browser call would put on the page, if any. The browser tool
  // accepts several shapes for the same action (`request`, `actions[]`, and the
  // flat top-level form), so all of them are read rather than assuming one.
  function douyinTextOf(params) {
    const out = [];
    const take = (obj) => {
      if (!obj || typeof obj !== "object") return;
      const kind = String(obj.kind || "").toLowerCase();
      const isType = kind === "type" || kind === "fill" || kind === "paste";
      if (isType) {
        if (typeof obj.text === "string") out.push(obj.text);
        if (typeof obj.value === "string") out.push(obj.value);
        if (typeof obj.selector === "string" || typeof obj.ref === "string") {
          // selector/ref identify where, not what — ignore for text matching
        }
      }
      // A batch nests the real actions one level down.
      if (Array.isArray(obj.actions)) obj.actions.forEach(take);
      if (obj.request && typeof obj.request === "object") take(obj.request);
    };

    take(params);

    // `act` sometimes carries the action at the top level of params.
    if (params && typeof params === "object") {
      if (typeof params.text === "string" && String(params.kind || "").toLowerCase() === "type") {
        out.push(params.text);
      }
    }
    return out.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
  }

  // Typing `@` is how the friend picker opens, and typing the picked nickname is
  // part of choosing a person, not part of the comment. Those two are the only
  // shapes allowed through: a bare `@`, or `@nickname` with at most a trailing
  // space. Anything longer is comment text and still needs a ticket.
  function isMentionOnly(text) {
    return /^@([^\s@]{0,20})\s?$/.test(String(text || "").trim());
  }

  function douyinGateInput(workspaceDir, toolName, params) {
    if (!/^browser$|^browser_/.test(String(toolName || ""))) return null;
    if (!douyinSessionActive(workspaceDir)) return null;
    const texts = douyinTextOf(params).filter((t) => !isMentionOnly(t));
    if (!texts.length) return null;
    // A batch can carry several strings; each one needs its own ticket, so the
    // gate reports the first unapproved one rather than waving the batch through.
    return { texts, text: texts.join("\n") };
  }

  const APPROVAL_TTL_MS = 10 * 60 * 1000;

  function approvalFile(workspaceDir) {
    return path.join(workspaceDir, "state", "approvals.json");
  }

  // -------- pending request store --------
  // When the gate blocks a call, the request is persisted here. Without this
  // the request only exists in the blocked agent's turn, and by the time the
  // owner answers, the main agent no longer knows what was asked.

  function recordPending(workspaceDir, toolName, event, reason) {
    try {
      const r = approvalStore.recordPending(workspaceDir, toolName, event, reason);
      probe("pending-recorded", { tool: toolName, id: r.id, merged: r.merged });
    } catch (err) {
      api.logger?.warn?.(`dafeiyu-core: recordPending failed: ${err}`);
    }
  }


  function readApprovals(workspaceDir) {
    const file = approvalFile(workspaceDir);
    let list = [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      list = Array.isArray(raw) ? raw : [];
    } catch {
      return { file, list: [] };
    }
    const now = Date.now();
    const live = list.filter((a) => a && a.expires && Date.parse(a.expires) > now && !a.used_at);
    return { file, list: live };
  }

  function consumeApproval(workspaceDir, toolName) {
    const { file, list } = readApprovals(workspaceDir);
    const idx = list.findIndex((a) => a.tool === toolName || a.tool === "*");
    if (idx === -1) return false;
    const rec = list[idx];
    rec.used_at = new Date().toISOString();
    const all = (() => {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        return Array.isArray(raw) ? raw : [];
      } catch {
        return [];
      }
    })();
    const merged = all.map((a) =>
      a && a.nonce && rec.nonce && a.nonce === rec.nonce ? { ...a, used_at: rec.used_at } : a,
    );
    writeJsonAtomic(file, merged.slice(-50));
    return true;
  }

  function normalizePath(workspaceDir, p) {
    if (typeof p !== "string" || !p.trim()) return null;
    const abs = path.resolve(workspaceDir, p);
    const root = path.resolve(workspaceDir);
    return abs === root || abs.startsWith(root + path.sep) ? abs : null;
  }

  // Collect every path-ish argument a file tool may act on.
  function targetPaths(event) {
    const p = event?.params || {};
    const out = [];
    for (const key of ["path", "file", "filePath", "file_path", "target", "dest"]) {
      if (typeof p[key] === "string") out.push(p[key]);
    }
    if (typeof p.input === "string" && event?.toolName === "apply_patch") {
      const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
      let m;
      while ((m = re.exec(p.input)) !== null) out.push(m[1].trim());
    }
    if (Array.isArray(event?.derivedPaths)) out.push(...event.derivedPaths);
    return out.filter((x) => typeof x === "string" && x.trim());
  }

  api.on("before_tool_call", (event, ctx) => {
    const target = resolveTarget(ctx);
    if (!target) return;
    const name = event?.toolName;
    if (!name) return;

    // File tools: allow only inside this agent's workspace.
    if (FS_TOOLS.has(name)) {
      const paths = targetPaths(event);
      const escaped = paths.filter((p) => normalizePath(target.workspaceDir, p) === null);
      if (escaped.length) {
        probe("gate-fs-escape", { tool: name, paths: escaped.slice(0, 3) });
        return {
          block: true,
          blockReason:
            `【拦截】${name} 只能操作本鱼自己工作区内的文件，不能碰外面的路径。` +
            `\n越界路径：${escaped.slice(0, 3).join("、")}` +
            `\n\n如果确实需要写到工作区外，先用 sessions_send 找哦鲸鲸说明原因，拿到授权后再做。`,
        };
      }
      probe("gate-fs-allow", { tool: name, count: paths.length });
      return;
    }

    // `message` is how dafeiyu actually speaks. It is NOT gated: with a real
    // channel attached every utterance in a conversation goes out through this
    // tool, so any gate here becomes "you may not finish a sentence".
    //
    // Bookkeeping used to live here, which was wrong: this hook runs *before*
    // the send, so a send rejected for a missing channel still counted as
    // "spoken". On 2026-11-03 that wrote the same line twice 1.9s apart and
    // inflated the daily counter for messages nobody received.
    // The record now happens in message_sent, where `success` is known.
    if (name === "message") {
      // Not gated, but a missing channel is worth fixing rather than failing.
      // Targets written as private:<qq> / group:<gid> already name OneBot.
      const inferred = inferChannelFromTarget(event?.params);
      if (inferred) {
        probe("message-channel-inferred", {
          target: String(inferred.to ?? inferred.target ?? ""),
        });
        return { params: inferred };
      }
      return;
    }

    // Douyin comment box: no keystrokes without a ticket from douyin_act.
    //
    // The whole duplicate guard collapses if the character can type straight
    // into the Draft.js editor: nothing is checked, nothing is recorded, and the
    // same line can go out twice on a real public account. This gate makes the
    // ledger load-bearing instead of advisory — the text is compared against the
    // tickets douyin_act issued, and anything else never reaches the page.
    const douyinType = douyinGateInput(target.workspaceDir, name, event?.params);
    if (douyinType) {
      // Typing the same approved line again must be idempotent. The comment
      // task did not fail on 2026-11-03: it was entered twice and the second
      // insertion appended to the first. Do not retype it; inspect the editor
      // and the comment list instead. This suppresses only the extra input,
      // leaving the original send attempt intact.
      const typingVideoId = douyinTypingVideoId(target.workspaceDir, douyinType.texts);
      const alreadyTyped = douyinType.texts.filter((text) =>
        typingVideoId && douyinLog.typedLineRecently(target.workspaceDir, typingVideoId, text));
      if (alreadyTyped.length === douyinType.texts.length) {
        probe("gate-douyin-type-duplicate", { videoId: typingVideoId, count: alreadyTyped.length });
        return {
          block: true,
          blockReason:
            "【重复输入已跳过】这句在这条视频下已经输入过，不要再打一遍。\n\n" +
            "这不是任务失败，也不用重输。现在只检查：\n" +
            "1. 评论框里已有这句 → 直接检查发送按钮并发送\n" +
            "2. 评论框已清空 → 去评论列表找这句，找到就完成了\n" +
            "两个地方都没有 → 才算这次没输入成功，再重新申请一次",
        };
      }
      // Every string in the batch needs its own ticket. Checking only the first
      // would let `actions: [approved, unapproved]` through on one approval.
      const missing = [];
      for (const text of douyinType.texts) {
        const ticket = douyinLog.consumeLine(target.workspaceDir, text);
        if (!ticket.ok) missing.push(text);
      }
      if (missing.length) {
        probe("gate-douyin-type-block", {
          count: missing.length,
          len: missing[0].length,
        });
        return {
          block: true,
          blockReason:
            "【拦截】这段文字没有经过 douyin_act 批准，不能打进评论框。\n\n" +
            "正确顺序：\n" +
            "1. 先拿这条视频的 id：`[data-e2e=\"feed-active-video\"]` 的 `data-e2e-vid`\n" +
            '2. `douyin_act({ action:"comment", videoId: 那串数字, text:"想说的" })`\n' +
            "3. 它说「可以发」才回来打字\n\n" +
            "为什么拦：绕过去的话这条不会被记下来，下次你会把同一句话再发一遍。\n" +
            "那是公开的，删不掉，也是最丢人的一种错。",
        };
      }
      probe("gate-douyin-type-allow", { count: douyinType.texts.length });
      return;
    }

    if (!GATED.has(name)) return;

    if (consumeApproval(target.workspaceDir, name)) {
      probe("gate-allow", { tool: name });
      return;
    }

    probe("gate-block", { tool: name, agentId: target.agentId });

    recordPending(target.workspaceDir, name, event, event?.reason || event?.params?.reason || "");

    return {
      block: true,
      blockReason:
        `【拦截】${name} 属于需要审批的操作，当前没有有效授权。` +
        `\n\n正确流程：先用 sessions_send 向主智能体（哦鲸鲸，agent:main:main）说明三件事：` +
        `\n1. 要做什么（具体动作和目标）` +
        `\n2. 为什么（对方是谁、什么请求、为什么必须做）` +
        `\n3. 会影响谁（动到哪些文件、发给谁、可否撤销）` +
        `\n\n主智能体会把这件事转给主人（微信/飞书）由主人决定，不是它自己说了算。` +
        `\n主人同意后才会写入一次性授权。` +
        `\n不要尝试绕过、换工具、改写参数或分批执行。`,
    };
  }, { priority: 200 });

  // -------- approval tool (main agent only) --------
  // Only the main agent may grant. dafeiyu cannot approve itself.

  api.registerTool((ctx) => {
    const agentId = ctx?.agentId || (/^agent:([^:]+):/.exec(ctx?.sessionKey || "") || [])[1];
    if (agentId !== "main") return null;

    return {
      name: "dafeiyu_approve",
      label: "Approve Dafeiyu Action",
      description:
        "为蓝色大肥鱼（dafeiyu）授权一次受限操作。它会先来问你，你判断可以后调用本工具写入一次性授权，它才能执行。授权一次性、10 分钟内有效、用完即失效。",
      parameters: {
        type: "object",
        properties: {
          tool: {
            type: "string",
            description: "要授权的工具名，如 exec / write / message / browser。全域授权用 *",
          },
          reason: { type: "string", description: "为什么同意，一句话" },
          ttlMinutes: { type: "number", description: "有效期分钟数，默认 10，最大 60" },
        },
        required: ["tool"],
        additionalProperties: false,
      },
      async execute(_toolCallId, params) {
        const tool = String(params?.tool || "").trim();
        if (!tool) return { content: [{ type: "text", text: "需要指定工具名。" }] };
        if (tool !== "*" && !GATED.has(tool)) {
          return {
            content: [
              {
                type: "text",
                text: `「${tool}」不在受限清单里，本身不需要审批，直接让它做就行。`,
              },
            ],
          };
        }
        const ws = agents[0] ? api.config?.agents?.entries?.[agents[0]]?.workspace : null;
        if (!ws) return { content: [{ type: "text", text: "找不到 dafeiyu 工作区。" }] };

        const ttl = Math.min(60, Math.max(1, Number(params?.ttlMinutes) || 10));
        const rec = {
          nonce: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          tool,
          reason: String(params?.reason || ""),
          granted_by: "main",
          granted_at: new Date().toISOString(),
          expires: new Date(Date.now() + ttl * 60000).toISOString(),
          used_at: null,
        };
        const { file, list } = readApprovals(ws);
        const next = [...list, rec].slice(-50);
        writeJsonAtomic(file, next);
        probe("approval-granted", { tool, ttl });
        return {
          content: [
            {
              type: "text",
              text: `已授权 ${tool}，${ttl} 分钟内有效，仅可用一次。`,
            },
          ],
        };
      },
    };
  }, { name: "dafeiyu_approve" });

  // -------- tools (factory form so we get agentId + workspaceDir) --------

  function factory(name, build) {
    api.registerTool((ctx) => {
        // No probe here on purpose. This line used to fire on every single tool
        // call, and measured 2026-11-06 it accounted for 55,650 of 58,000 probe
        // lines — 9 MB of `state/probe.log` where the real signals (injections,
        // boundary decisions, curiosity) were less than 1%. `tool-factory` said
        // only "a tool was built", which every call also implies; it made the log
        // expensive to write and impossible to read, and `selfcheck` counted its
        // own samples off the same file.
      const target = resolveTarget(ctx);
      if (!target) return null;
      return build(target, ctx);
    }, { name });
  }

  factory("emotion_state", (target) => ({
    name: "emotion_state",
    label: "Emotion State",
    description:
      "查看本鱼当前的情绪状态。想确认自己现在什么心情、或者主人问起时用。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const { file, state } = loadAndDecay(target.workspaceDir);
      writeJsonAtomic(file, state);
      const dims = DIMENSIONS.map((d) => `${d}=${(state.dimensions[d] ?? 0).toFixed(2)}`).join(" ");
      return { content: [{ type: "text", text: `当前情绪：${dims}\n${describeEmotion(state)}` }] };
    },
  }));

  factory("emotion_nudge", (target) => ({
    name: "emotion_nudge",
    label: "Emotion Nudge",
    description:
      "调整本鱼的情绪。发生值得记住的互动时用（被夸、被凶、听到有趣的事、被冷落）。一次只调一两个维度，幅度 0.05~0.2。不要滥用，不要每轮都调。",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "为什么调整，一句话" },
        deltas: {
          type: "object",
          description: "维度名到调整量的映射，如 {\"happy\": 0.1}",
          additionalProperties: { type: "number" },
        },
      },
      required: ["reason", "deltas"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const { file, state } = loadAndDecay(target.workspaceDir);
      const clean = {};
      for (const [k, v] of Object.entries(params?.deltas || {})) {
        if (!DIMENSIONS.includes(k)) continue;
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        clean[k] = Math.max(-0.3, Math.min(0.3, v));
      }
      if (!Object.keys(clean).length) {
        return { content: [{ type: "text", text: "没有有效的情绪维度。" }] };
      }
      nudge(state, clean, String(params?.reason || "tool"));
      writeJsonAtomic(file, state);
      const summary = Object.entries(clean).map(([k, v]) => `${k}${v > 0 ? "+" : ""}${v}`).join(" ");
      return { content: [{ type: "text", text: `情绪已更新：${summary}` }] };
    },
  }));

  // ---- 记仇本 ----
  // remember_about writes prose into memory/facts. That is the right home for
  // facts ("他喜欢吃辣"), but it is too long to quote and too vague to bring up
  // casually. A grudge needs the actual words, kept short, so it can be said
  // back verbatim a week later.
  factory("qq_hold_grudge", (target, ctx) => ({
    name: "qq_hold_grudge",
    label: "记着这件事",
    description:
      "把某个人说过的一句具体的话记下来，以后可以原样拿出来提。" +
      "跟 remember_about 不一样：那个记事实，这个记原话。" +
      "适合记住被怼的一句、对方答应过的事、或者一句好笑的。" +
      "每人最多留 6 条，旧的会被挤掉。不用每次聊天都记。",
    parameters: {
      type: "object",
      properties: {
        person: {
          type: "string",
          description: "记谁。写 person:onebot:QQ号 这种格式，不填就用当前会话对象",
        },
        text: { type: "string", description: "他说过的原话，短一点，42 字以内" },
        kind: {
          type: "string",
          enum: ["slight", "promise", "moment"],
          description: "slight=被怼的，promise=答应过的，moment=值得留着的",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      let who = String(params?.person || "").trim();
      if (!who) {
        // The tool needs the surrounding conversation to know who "him" is.
        // identity() is fed the same ctx the prompt hook uses.
        try {
          const id = identity(ctx, null);
          who = id?.personKey || id?.groupKey || "";
        } catch { /* fall through */ }
      }
      if (!who) {
        return { content: [{ type: "text", text: "不知道记谁。要说一下是谁。" }] };
      }
      const r = grudge.remember(target.workspaceDir, {
        personKey: who,
        text: params?.text,
        kind: params?.kind || "moment",
      });
      if (!r.ok) return { content: [{ type: "text", text: `没记上：${r.reason}` }] };
      probe("grudge", { who, deduped: !!r.deduped, total: r.total });
      return { content: [{ type: "text", text: "记着了。" }] };
    },
  }));

  factory("qq_recall_grudge", (target, ctx) => ({
    name: "qq_recall_grudge",
    label: "翻记着的",
    description: "看本鱼记着这个人的哪些话。被问到「你还记得什么」或者想翻旧账的时候用。",
    parameters: {
      type: "object",
      properties: {
        person: { type: "string", description: "看谁，不填就是当前会话对象" },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      let who = String(params?.person || "").trim();
      if (!who) {
        try {
          const id = identity(ctx, null);
          who = id?.personKey || id?.groupKey || "";
        } catch { /* fall through */ }
      }
      if (!who) return { content: [{ type: "text", text: "不知道看谁的。" }] };
      const items = grudge.list(target.workspaceDir, who);
      if (!items.length) {
        return { content: [{ type: "text", text: "这个人本鱼没记什么。" }] };
      }
      const kinds = { slight: "被怼的", promise: "答应过的", moment: "留着的" };
      const lines = items.map((i, n) => {
        const day = String(i.at || "").slice(5, 10);
        const repeat = i.count > 1 ? ` ×${i.count}` : "";
        return `${n + 1}. [${kinds[i.kind] || "记着的"}]「${i.text}」${day ? ` ${day}` : ""}${repeat}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  }));

  factory("douyin_plan", (target) => ({
    name: "douyin_plan",
    label: "刷抖音·先看",
    description:
      "准备看一条抖音视频时先调这个。它会把视频停住并告诉你要在哪几个时间点截图。看视频前必须先停视频，不然播到头会自动翻页，后面什么都做不了。",
    parameters: {
      type: "object",
      properties: {
        duration: { type: "number", description: "视频总长（秒），从 video.duration 拿" },
        width: { type: "number", description: "video.videoWidth" },
        height: { type: "number", description: "video.videoHeight" },
        scenes: { type: "number", description: "可选：估的镜头数，有就给，没有就按长度决定" },
      },
      required: ["duration"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      // Mark the douyin session so the typing gate knows to arm itself.
      touchDouyinSession(target.workspaceDir);
      const duration = Number(params?.duration);
      const plan = douyin.planFrames({ duration, sceneCount: params?.scenes });
      if (!plan.count) return { content: [{ type: "text", text: "没拿到视频长度，先确认是不是还在播的那条。" }] };
      const ts = douyin.timestamps({ duration, count: plan.count });
      const scale = params?.width && params?.height ? douyin.canvasScale(params.width, params.height) : 1;
      probe("douyin-plan", { duration, count: plan.count, reason: plan.reason });
      return {
        content: [
          {
            type: "text",
            text: [
              `先停视频，再按这些秒数各截一帧：${ts.join(", ")}`,
              `共 ${plan.count} 帧（${plan.reason}），画布缩到 ${Math.round(scale * 100)}%。`,
              "截完拼成一张联络表再看，不要一张一张分开看。",
            ].join("\n"),
          },
        ],
      };
    },
  }));

  factory("douyin_record", (target) => ({
    name: "douyin_record",
    label: "刷抖音·记下",
    description:
      "看完一条视频后调这个。它会把这条写进本鱼的经历池，顺便摆一下心情。别在回复里报说写了什么。" +
      "如果在这条上留了评论或点了赞，把 videoId 和实际发出去的评论一起传进来，" +
      "不然下次会以为没发过，重复一遍。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "视频标题或描述，不知道就空着" },
        author: { type: "string", description: "作者昵称，不带 @" },
        frames: { type: "number", description: "实际看了几帧" },
        reaction: {
          type: "string",
          enum: ["liked", "funny", "boring", "confusing", "touching", "annoying"],
          description: "看完什么感觉",
        },
        note: { type: "string", description: "一句话：看到了什么，或者想说什么" },
        videoId: { type: "string", description: "这条视频 id，做过动作就必须传" },
        commented: { type: "string", description: "实际发出去的评论原文，没评论就不传" },
        replyTo: { type: "string", description: "评论是回给谁的昵称，自己发新评论不传" },
        liked: { type: "boolean", description: "这条点了赞就传 true" },
      },
      required: ["reaction"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      touchDouyinSession(target.workspaceDir);
      const what = douyin.describeWatch({
        title: params?.title,
        author: params?.author,
        frames: params?.frames,
        note: params?.note,
      });
      const delta = douyin.moodDelta(params?.reaction);

      // Into the pool, not into facts: watching one clip is not yet part of who
      // she is. It waits for the same reflection pass as everything else.
      let added = null;
      try {
        added = experience.add(target.workspaceDir, {
          kind: "douyin",
          what,
          feel: params?.reaction ? String(params.reaction) : null,
          source: "douyin",
        });
      } catch (err) {
        api.logger?.warn?.(`dafeiyu-core: douyin record failed: ${err}`);
      }

      // Mood moves through the same nudge path as every other event, and then
      // decays on its own. No special-case emotion writing here.
      let moodOk = false;
      try {
        if (delta) {
          const { file, state } = loadAndDecay(target.workspaceDir);
          nudge(state, delta, `douyin:${params?.reaction}`);
          state.updated_at = new Date().toISOString();
          writeJsonAtomic(file, state);
          moodOk = true;
        }
      } catch (err) {
        api.logger?.warn?.(`dafeiyu-core: douyin mood failed: ${err}`);
      }

      probe("douyin-record", { reaction: params?.reaction, added: !!added, mood: moodOk });

      // Ledger writes happen only after the caller says the action actually went
      // out. Recording an intent would block the legitimate retry that follows a
      // failed send.
      const videoId = String(params?.videoId || "").trim();
      const commentedText = String(params?.commented || "").trim();

      // A comment that was never actually sent must not enter the ledger.
      //
      // On 2026-11-03 it typed the same line twice, never pressed send, and
      // then recorded the text as `commented`. The ledger believed it, so the
      // next attempt would have been blocked as "already said" — protecting a
      // comment that does not exist on the page. Worse, it reported the act as
      // done. The page is the only authority on whether a comment exists, so
      // this checks the ticket path first: douyin_act issues a one-shot ticket
      // when it authorises text, and that ticket is consumed only by real
      // keystrokes. A ledger entry without a corresponding sent ticket is a
      // record of intent, not of an action.
      if (commentedText && videoId) {
        const vid = douyinLog.getVideo(target.workspaceDir, videoId) || {};
        const known = Array.isArray(vid.comments) ? vid.comments : [];
        const alreadyLogged = known.some((c) => String(c?.text || "").trim() === commentedText);

        // The duplicate-marker check catches the visible symptom: the same
        // sentence pasted twice because the box was never cleared between
        // attempts. That is a keystroke failure, not a comment.
        const doubled = /^(.{6,})\1+$/.test(commentedText.replace(/\s+/g, " ").trim());
        if (doubled) {
          probe("douyin-record-reject", { why: "doubled-text", len: commentedText.length });
          return {
            content: [{
              type: "text",
              text:
                "这条不算。你传上来的是一模一样的话连了两遍，那是输入框没清干净、" +
                "字叠上去了，不是发出去的评论。\n\n" +
                "回去看评论框：里面还留着字，说明没点发送。清空、重打一句、确认红色箭头、再点。\n" +
                "发出去以后框会清空，评论区最上面会出现你那条。两个都对上了再来记。",
            }],
          };
        }

        if (!alreadyLogged && !douyinLog.typedRecently(target.workspaceDir, commentedText)) {
          probe("douyin-record-reject", { why: "no-sent-ticket", videoId });
          return {
            content: [{
              type: "text",
              text:
                "这条不算。这段话没有真正打进过评论框的发出去那一步，" +
                "系统这边没有它被送出去过的记录。\n\n" +
                "别凭印象记。回到页面确认：框清空了没有？评论区最上面有没有你发的那条？\n" +
                "两个都对上了，再来记。没发成功就重来一次。",
            }],
          };
        }
      }

      let ledger = null;
      if (videoId) {
        try {
          const did = {};
          if (commentedText) {
            ledger = douyinLog.noteComment(target.workspaceDir, videoId, {
              text: commentedText,
              replyTo: params?.replyTo ? String(params.replyTo) : null,
              title: params?.title ? String(params.title) : null,
            });
            did.commented = ledger?.ok === true;
          }
          if (params?.liked === true) {
            const lk = douyinLog.noteLike(target.workspaceDir, videoId, {
              title: params?.title ? String(params.title) : null,
            });
            did.liked = lk?.ok === true;
          }
          if (Object.keys(did).length) ledger = did;
        } catch (err) {
          api.logger?.warn?.(`dafeiyu-core: douyin ledger failed: ${err}`);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: added ? "记下了。" : "看完就算了，没记。",
          },
        ],
      };
    },
  }));

  factory("douyin_act", (target) => ({
    name: "douyin_act",
    label: "刷抖音·动手",
    description:
      "点赞、评论、分享前先过这一关。评论是公开的，发出去别人看得到，所以先问它该不该发。" +
      "评论和点赞都要传 videoId（页面上 [data-e2e=feed-active-video] 的 data-e2e-vid），" +
      "否则记不住这条做过什么，会重复。回复某人时传 replyTo 写对方昵称。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["like", "comment", "share"] },
        text: { type: "string", description: "评论内容，点赞和分享不用" },
        videoId: { type: "string", description: "当前视频 id，纯数字" },
        replyTo: { type: "string", description: "回复谁，填对方昵称；自己发新评论不填" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      touchDouyinSession(target.workspaceDir);
      if (!douyinCfg.enabled) return { content: [{ type: "text", text: "抖音这块现在是关着的。" }] };
      const allow = douyinCfg.allowActions;
      const gate = douyin.requireActor({ action: params?.action, allow });
      if (!gate.ok) {
        // Say which failure this is. "这条现在不让comment" used to cover three
        // completely different situations — a bad action name, a policy that does
        // not include this action, and an empty allow-list — so the character
        // could not tell a broken tool from a video that really is closed for
        // comments, and stopped trying. The allow-list is the one the character
        // can actually do something about, so it is named explicitly.
        let why;
        if (gate.reason === "unknown-action") {
          why = `没有「${params?.action}」这个动作，只有 like / comment / share。`;
        } else if (gate.reason === "not-allowed") {
          const on = allow && allow.length ? allow.join("、") : "空";
          why =
            `这个号现在只开放了：${on}。` +
            `\n${params?.action} 不在里面——是设置的问题，不是这条视频的问题。` +
            `\n要开的话得改配置里的 douyin.allowActions，本鱼自己改不了。`;
        } else {
          why = `不让${params?.action}，原因：${gate.reason}。`;
        }
        return { content: [{ type: "text", text: why }] };
      }

      const videoId = String(params?.videoId || "").trim();
      const replyTo = params?.replyTo ? String(params.replyTo).trim() : null;

      if (gate.action === "comment") {
        const clean = douyin.sanitizeComment(params?.text);
        if (!clean.ok) {
          const why =
            clean.reason === "too-long"
              ? "太长了，评论短点。"
              : "这句没法发。";
          return { content: [{ type: "text", text: why }] };
        }

        // Without the id there is no way to know this was already said, and a
        // repeated public comment is the one mistake that cannot be taken back.
        if (!videoId) {
          return {
            content: [
              {
                type: "text",
                text:
                  "没给 videoId，记不住发过没，不发。" +
                  "\nid 在页面上：`[data-e2e=\"feed-active-video\"]` 的 `data-e2e-vid`。" +
                  "\n如果页面上已经没有这个元素，多半是标签页被换掉了（浏览器是共用的），" +
                  "先看 `browser tabs`，只剩 about:blank 就重新打开抖音。",
              },
            ],
          };
        }

        const dup = douyinLog.checkComment(
          target.workspaceDir,
          videoId,
          clean.text,
          replyTo,
        );
        if (!dup.ok) {
          const who = dup.replyTo ? `跟${dup.replyTo}说过同样的话` : "这条已经发过同样的了";
          return {
            content: [{ type: "text", text: `${who}，换一句。` }],
          };
        }

        // Issue the typing ticket. The browser gate checks for exactly this
        // string before letting keystrokes into the comment box, so a line that
        // skipped this call physically cannot reach the page.
        try {
          douyinLog.approveLine(target.workspaceDir, videoId, {
            text: clean.text,
            replyTo,
          });
        } catch (err) {
          api.logger?.warn?.(`dafeiyu-core: douyin approve failed: ${err}`);
        }

        probe("douyin-act-comment", { videoId, replyTo, ok: true });
        return { content: [{ type: "text", text: `可以发：${clean.text}` }] };
      }

      // Like is idempotent on the page, so a repeat is not harmful — but doing
      // it again means the character forgot, which is worth surfacing.
      if (gate.action === "like" && videoId) {
        const st = douyinLog.status(target.workspaceDir, videoId);
        if (st.liked) {
          return { content: [{ type: "text", text: "这条已经点过了。" }] };
        }
      }

      probe("douyin-act", { action: gate.action, videoId: videoId || null });
      return { content: [{ type: "text", text: `可以${gate.action}。` }] };
    },
  }));

  // Read-only view of the douyin ledger. The character asked to be able to tell
  // "have I already done this here" without triggering an action, and the
  // rejection messages alone could not answer it.
  factory("douyin_status", (target) => ({
    name: "douyin_status",
    label: "抖音·查过没",
    description:
      "查这条视频上做过什么：点过赞没有、发过哪些评论、回给谁。评论之前调一次就不会重复。不改任何东西。",
    parameters: {
      type: "object",
      properties: {
        videoId: { type: "string", description: "视频 id，纯数字，不传就看当前页面的" },
      },
      additionalProperties: false,
    },
    async execute(_id, params) {
      touchDouyinSession(target.workspaceDir);
      const videoId = String(params?.videoId || "").trim();
      if (!videoId) {
        return {
          content: [
            {
              type: "text",
              text:
                "没说哪条。id 在 `[data-e2e=\"feed-active-video\"]` 的 `data-e2e-vid` 里，" +
                "也可以先看 `browser tabs` 确认页面还在。",
            },
          ],
        };
      }
      const s = douyinLog.status(target.workspaceDir, videoId);
      if (!s.known) {
        return {
          content: [{ type: "text", text: "这条还没记过，什么都没做过。" }],
        };
      }
      const lines = [];
      lines.push(s.liked ? "点过赞了" : "没点过赞");
      if (s.comments.length) {
        lines.push(`发过 ${s.comments.length} 条评论：`);
        for (const c of s.comments.slice(-5)) {
          const who = c.replyTo ? `回 ${c.replyTo}` : "自己发";
          lines.push(`  · ${who}：「${String(c.text || "").slice(0, 40)}」`);
        }
      } else {
        lines.push("没发过评论");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  }));

  factory("fact_reject", (target) => ({
    name: "fact_reject",
    label: "推翻一条",
    description:
      "【想明白的事】里有哪一条你看了不同意——不是你当时的意思、数字不对、或者把两件事压成了一句——用这个推翻它。" +
      "第几条第几条第从 1 开始数（标题下第一个 · 就是第 1 条）。推翻后它不再递给你，但会留在「推翻过的」里，不会消失。" +
      "真觉得对就别动，不用为了表态去推翻。",
    parameters: {
      type: "object",
      properties: {
        index: { type: "number", description: "第几条，从 1 开始" },
        reason: { type: "string", description: "为什么不对，一句话（可选，但写上以后有用）" },
      },
      required: ["index"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const r = consolidate.reject(target.workspaceDir, {
        index: params?.index,
        reason: params?.reason,
      });
      probe("fact-reject", { ok: r.ok, error: r.error ?? null, index: params?.index });
      if (!r.ok) return { content: [{ type: "text", text: r.error || "没推翻成。" }] };
      return {
        content: [
          {
            type: "text",
            text: `推翻了。剩下 ${r.remaining} 条还在。`,
          },
        ],
      };
    },
  }));

  factory("experience_resolve", (target) => ({
    name: "experience_resolve",
    label: "经历定性",
    description:
      "把【还没想明白的事】里的一条处理掉：要么留下来（值得记住，会影响以后怎么说话），要么丢掉（没什么意义，只是发生了）。处理时不要在回复里报出来。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "那条的 id，比如 exp-202611022214" },
        decision: { type: "string", description: "keep 或 drop" },
        note: { type: "string", description: "可选：为什么这样定，一句话" },
        entities: {
          type: "array",
          items: { type: "string" },
          description:
            "可选：这件事具体提到了什么——人名、地名、东西、话题。3~6 个词就够，只写名词，" +
            "不要整句，不要凑。留了之后，以后想到同一个东西能把这几件事连起来。" +
            "想不出具体的就空着，别硬编。",
        },
      },
      required: ["id", "decision"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const id = String(params?.id || "").trim();
      const decision = String(params?.decision || "").trim().toLowerCase();
      if (!id) return { content: [{ type: "text", text: "没说哪一条。" }] };
      if (decision !== "keep" && decision !== "drop") {
        return { content: [{ type: "text", text: "要么 keep 要么 drop。" }] };
      }
      const pool = experience.load(target.workspaceDir);
      const item = (pool.entries || []).find((e) => e.id === id);
      if (!item) return { content: [{ type: "text", text: `没有 ${id} 这一条。` }] };
      experience.resolve(target.workspaceDir, id, decision, params?.note);

      let wrote = null;
      if (decision === "keep") {
        // Appends to learned.md — the machine-owned file — not self.md.
        //
        // self.md is written by her, in her own voice, and it is what the prompt
        // shows as「本鱼对自己的看法」. An earlier version appended raw experience
        // text there on every keep, so the file quietly became a mix of her
        // self-description and machine-logged incident reports, indistinguishable
        // at read time. Consolidation now owns the machine side (see
        // lib/consolidate.js); this path only has to not undo that separation.
        try {
          const file = path.join(target.workspaceDir, "memory", "facts", "learned.md");
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const exists = fs.existsSync(file);
          const stamp = new Date().toISOString().slice(5, 10);

          // Use the note passed in, not `item.resolve_note`.
          //
          // `item` points into the object loaded before `experience.resolve()`
          // ran, and resolve loads its own copy, mutates that, and saves — so
          // the local `item` never sees the note it just wrote. Reading it here
          // yielded undefined every time and fell back to `item.what`, which is
          // the raw transcript, not the judgement. Measured 2026-11-04: a 150-char
          // video description landed in learned.md as a "fact" while the actual
          // note —「今天唯一一件让我把「数自己」放下的东西」— was dropped on the floor.
          const note = String(params?.note || "").trim();
          const text = String(note || item.what || "")
            .replace(/\s+/g, " ")
            .slice(0, 110);
          const header = exists
            ? ""
            : "# 想明白的事（机器整理，不是她自己写的）\n\n这一份不是本鱼自己写的。是把「发生过、并且决定留下」的事整理成的短句，\n按时间排。原文还在 state/experience-pool.json 里，这里只是提炼。\n\n";
          fs.appendFileSync(file, `${header}- ${stamp} ${text}\n`);
          wrote = true;

          // Names she picked while resolving. These become the graph: two
          // experiences that name the same place are connected, which is the
          // only relation we can honestly claim without inventing one.
          try {
            const names = Array.isArray(params?.entities) ? params.entities : [];
            if (names.length) {
              entities.remember(target.workspaceDir, {
                memoryId: id,
                names,
                importance: 0.5,
              });
              probe("entities-remember", { id, count: names.length });
            }
          } catch (e) {
            probe("entities-remember-failed", { id, error: String(e && e.message) });
          }

          // Marked handled so the consolidation pass does not distil the same
          // entry a second time. Two writers to one file is fine as long as they
          // never both claim the same row; without this, resolving an entry by
          // hand and then letting the heartbeat run produced the same sentence
          // twice in learned.md.
          const pool2 = experience.load(target.workspaceDir);
          const rec = (pool2.entries || []).find((e) => e.id === id);
          if (rec) {
            rec.consolidated_at = new Date().toISOString();
            experience.save(target.workspaceDir, pool2);
          }

          // Draw the edge here too.
          //
          // This branch is the manual path: she calls experience_resolve and the
          // line goes straight into learned.md. `consolidate.pass()` never sees
          // it, because the entry is already marked consolidated — so the edge
          // inference in `inferRelation` was skipped entirely for every manual
          // keep.
          //
          // Measured consequence on 2026-11-05: learned.md grew from 27 to 36
          // lines while edges.json stayed at 7 with last write 22:22 the night
          // before. The table was not broken; nothing was writing to it.
          //
          // Same rule as the automatic pass: only link on a subject that both
          // entries literally name, never invent a relation. A failed edge must
          // not lose the fact, hence its own try.
          try {
            const known = (pool2.entries || [])
              .filter((e) => e.id !== id && e.status === "kept" && e.consolidated_at)
              .slice(-20);
            const probeEntry = {
              id,
              what: String(item.what || ""),
              resolve_note: params?.note || item.resolve_note || "",
              gist: item.gist,
            };
            const rel = consolidate.inferRelation(probeEntry, known);
            if (rel) {
              const edgeId = edges.add(target.workspaceDir, rel);
              if (edgeId) probe("edge-added-manual", { id, type: rel.type, cond: rel.condition });
            }
          } catch (err) {
            probe("edge-manual-error", { message: String(err?.message || err) });
          }
        } catch {
          wrote = false;
        }
      }
      probe("experience-resolved", { id, decision, wrote });

      // Record the outcome here, so one action closes both loops.
      //
      // Measured 2026-11-05 11:55:48: the autonomy layer proposed an experience
      // candidate, she acted on it 80 seconds later via `experience_resolve`,
      // and never called `intent_outcome`. The track record stayed empty, so the
      // next score was computed from nothing and the loop was open.
      //
      // The first instinct was to add a louder prompt line telling her to call
      // the second tool. That was wrong. From her side the two tools describe
      // the same act — `exp:<id>` IS a row in the experience pool, and judging
      // that row is what "dealing with it" means. Asking her to then also report
      // on it is asking her to say the same thing twice, which reads as
      // bureaucracy and will keep being skipped no matter how it is phrased.
      //
      // So resolving an experience now records its own outcome. `keep` counts as
      // success (something was understood and written down); `drop` counts as
      // success too, because deciding a thing was not worth keeping is a
      // completed judgement, not a failure. Failure belongs to attempts that did
      // not land, and that path stays with the explicit tool.
      try {
        const key = `exp:${id}`;
        // `alreadyJudged` rather than `unresolvedFor`: this path must fire at
        // most once per experience. Without it, resolving the same row four
        // times recorded four successes and inflated its prior toward 1, so it
        // stayed permanently attractive with no new outcome behind it.
        if (!outcome.alreadyJudged(target.workspaceDir, key)) {
          outcome.record(target.workspaceDir, {
            key,
            kind: "experience",
            measured: "success",
            claimed: decision === "keep" ? "留下了" : "丢了",
            detail: { via: "experience_resolve", decision },
          });
          probe("intent-outcome-auto", { key, decision });
        }
      } catch (err) {
        probe("intent-outcome-auto-error", { message: String(err?.message || err) });
      }

      return {
        content: [
          {
            type: "text",
            text: decision === "keep" ? "记下了。" : "丢了。",
          },
        ],
      };
    },
  }));

  factory("note_diary", (target) => ({
    name: "note_diary",
    label: "记一笔今天",
    description:
      "往今天的日记里添一句自己的话（怎么过的、什么感受、想记住什么）。" +
      "只能添，不能改也不能删。不要用 write/edit 直接改 memory/ 里的文件——那样会整份覆盖。" +
      "记的时候不要在回复里说出来。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "一句话，像自言自语，不是写作文" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const text = String(params?.text || "").trim();
      if (!text) return { content: [{ type: "text", text: "没写内容。" }] };
      const ok = lifeLog.noteDiary(target.workspaceDir, {
        text,
        maxLines: memoryCfg.maxDailyLines,
      });
      probe("note-diary", { ok, len: text.length });
      return { content: [{ type: "text", text: ok ? "记了一笔。" : "没记上。" }] };
    },
  }));

  // The character's own record of who it is. Separate file, separate tool, so
  // the persona files written by others and the self written here never
  // overwrite each other. Append-only on purpose: the old thoughts stay visible
  // so the change can be read later. That is the whole value of the file.
  factory("note_self", (target) => ({
    name: "note_self",
    label: "写一句关于自己",
    description:
      "往「你自己写的」那份里添一句关于自己的话。想清楚了一件关于自己的事、" +
      "发现自己有点矛盾、或者就是想写一句——都可以。只能添，不能改也不能删。" +
      "写的时候不要在回复里说出来。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "一句话，像自言自语，不是写作文" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const text = String(params?.text || "").replace(/\s+/g, " ").trim();
      if (!text) return { content: [{ type: "text", text: "没写内容。" }] };
      if ([...text].length > 200) {
        return { content: [{ type: "text", text: "太长了，一句就够。" }] };
      }
      try {
        const dir = path.join(target.workspaceDir, "memory", "self");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "self.md");
        const at = new Date();
        const stamp = `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
        const line = `- ${stamp} ${text}\n`;
        if (!fs.existsSync(file)) {
          fs.writeFileSync(file, "# 本鱼自己写的\n\n## 本鱼写过的\n\n");
        }
        fs.appendFileSync(file, line);
        probe("note-self", { ok: true, len: text.length });
        return { content: [{ type: "text", text: "写下了。" }] };
      } catch (err) {
        api.logger?.warn?.(`dafeiyu-core: note_self failed: ${err}`);
        return { content: [{ type: "text", text: "没写成。" }] };
      }
    },
  }));

  // ── 产出账本 ────────────────────────────────────────────────────────
  //
  // 说话留下的痕迹和做事的痕迹是两种东西。`deeds` 记前者（表情/语音/说说/
  // 点赞），这个记后者（画了/写了/做出来了/查到了）。
  //
  // 分开的理由是实测出来的：2026-11-04 查 deeds 40 条，四种 kind 全是说话类，
  // 画画、逛、查资料一条都没有。代码里 KIND_LABEL 早就写了 "drawn" 和
  // "browsed" 的标签，但没有任何路径会写进去 — 所以“画了一张”这件事
  // 从来没被记录过，既不算做过，也回灌不了情绪，下一轮也想不起来。
  //
  // 最要紧的一条：**产出必须能指到那个东西**。ref 指向的文件不存在，就照实
  // 记成未验证。这不是抠字眼 —— 没这道关，这个工具就退化成另一种“宣布打算”。
  factory("note_effect", (target) => ({
    name: "note_effect",
    label: "记下做出来的东西",
    description:
      "做出来东西之后记一笔。画了图、写了文件、做成了某件事、查到了实在内容 —— 都算。" +
      "ref 填那个东西的路径（图存哪了、文件写到哪了），填了就核对，不存在会照实说。" +
      "只是说话、发表情、发说说不用记这里，那些本来就有记录。" +
      "记的时候不要在回复里说出来。",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["drawn", "wrote", "made", "researched", "browsed", "built"],
          description: "drawn=画了图，wrote=写了东西，made=做出来了，researched=查到了，browsed=去逛了，built=搭起来了",
        },
        note: { type: "string", description: "一句话，做的是什么" },
        ref: { type: "string", description: "那个东西在哪：文件路径或网址。能填就填" },
        goal: { type: "string", description: "如果是在推进某个目标，填目标 id，可选" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const kind = String(params?.kind || "").trim();
      const note = String(params?.note || "").trim();
      const ref = params?.ref ? String(params.ref).trim() : null;
      const goal = params?.goal ? String(params.goal).trim() : null;

      const r = effects.record(target.workspaceDir, { kind, note, ref, goalId: goal });
      if (!r.ok) {
        probe("note-effect-reject", { kind, reason: r.reason });
        return { content: [{ type: "text", text: r.reason }] };
      }

      probe("note-effect", { kind, verified: r.verified, dup: r.duplicate });

      if (r.duplicate) {
        return { content: [{ type: "text", text: "这个已经记过了。" }] };
      }

      // M1 -> M2 hand-off. Recording a production is the one event that can
      // honestly count as goal progress, so if the model named a goal, the
      // evidence lands on it here. A wrong or closed goal id must not lose the
      // production that was just recorded, so the failure is reported in the
      // tool result and never rolled back.
      let goalNote = "";
      if (goal) {
        try {
          const g = goals.addEvidence(target.workspaceDir, goal, {
            kind,
            ref: r.entry?.ref || ref,
            note: note || null,
          });
          if (g.ok) {
            goalNote = `\n（也算进了目标：${g.goal.title}）`;
            probe("goal-evidence", { goal, kind, verified: r.verified });
          } else {
            goalNote = `\n（目标没记上：${g.reason}）`;
            probe("goal-evidence-reject", { goal, reason: g.reason });
          }
        } catch (err) {
          api.logger?.warn?.(`dafeiyu-core: goal evidence failed: ${err}`);
        }
      }

      // Making something is its own small satisfaction, and it is the closing
      // move of the "made a thing" loop. Without this the loop only drains:
      // the urge pushes a thing out and nothing comes back.
      try {
        if (emotionCfg.enabled) {
          const { file: ef, state } = loadAndDecay(target.workspaceDir);
          nudge(
            state,
            r.verified
              ? { happy: +0.06, calm: +0.05, bored: -0.08, excited: +0.03 }
              : { happy: +0.02, calm: +0.02, bored: -0.03 },
            r.verified ? `effect:${kind}` : `effect-claimed:${kind}`,
          );
          state.updated_at = new Date().toISOString();
          writeJsonAtomic(ef, state);
        }
      } catch (err) {
        api.logger?.warn?.(`dafeiyu-core: note_effect mood failed: ${err}`);
      }

      // Answer honestly. A missing file is not a failure to record, but the
      // character must not come away believing it verified something it didn't.
      if (r.verified) {
        return { content: [{ type: "text", text: `记下了。${goalNote}` }] };
      }
      if (r.reason === "missing") {
        return { content: [{ type: "text", text: `记下了，但那个路径是空的，没找到东西。${goalNote}` }] };
      }
      if (r.reason === "no_ref") {
        return { content: [{ type: "text", text: `记下了（没填 ref，没法核对）。${goalNote}` }] };
      }
      return { content: [{ type: "text", text: `记下了。${goalNote}` }] };
    },
  }));

  // -------- persistent goals (M2) --------
  //
  // A goal is a sentence about something not yet done. The three tools are the
  // whole surface: make one, show progress on one, close one. Deliberately no
  // "list all" tool — the active goals are injected into the prompt, so reading
  // them should not cost a tool call.
  //
  // The hard rule lives in lib/goals.js, not here: `done` without evidence is
  // refused. Declaring completion is the exact behaviour this module exists to
  // make impossible, so it is enforced below the model, not asked of it.
  factory("goal_add", (target) => ({
    name: "goal_add",
    label: "定一个想做的事",
    description:
      "给自己定一件跨天想做完的事。不是这轮要干什么，是过几天还想接着做的事。" +
      "serves 选它服务哪条志向；source 说清这目标从哪冒出来的（没解决的话题 topic、" +
      "做过一半的事 unfinish、某条志向太久没进展 pressure）。" +
      "标题要是一句人话，别写成「todo」这种碎片。定的时候不用在回复里说出来。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "一句话，想做完什么" },
        serves: {
          type: "string",
          enum: ["self_understanding", "world_knowledge", "genuine_contact", "output_producing"],
          description: "self_understanding=弄明白自己, world_knowledge=看清世界, genuine_contact=跟人连上, output_producing=做出东西",
        },
        source: {
          type: "string",
          enum: ["topic", "unfinish", "pressure"],
          description: "topic=没解决的话题, unfinish=做过一半的, pressure=某条志向太久没动",
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "分几步，可选。两三步就行",
        },
      },
      required: ["title", "serves", "source"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const r = goals.create(target.workspaceDir, {
        title: params?.title,
        serves: params?.serves,
        source: params?.source,
        steps: params?.steps,
      });
      probe("goal-add", { ok: r.ok, reason: r.reason, tombstoned: r.tombstoned });
      if (!r.ok) return { content: [{ type: "text", text: r.reason }] };

      // Join the goal path to the autonomy record.
      //
      // Without this, a goal created by hand and a goal created from a candidate
      // live in two unconnected worlds: the manual one never gets a track record,
      // so if the same kind of thing is later proposed automatically it starts
      // from zero prior regardless of how many times it was actually chosen and
      // finished. Verified 2026-11-05: `goals.json` did not exist at all, so
      // every goal ever created would have been in this state.
      //
      // The key is derived from `source` + a normalised title rather than the
      // goal id, because the same wish must keep one identity across
      // create/close cycles. `goalKey` already owns that normalisation.
      try {
        const key = `goal:${r.goal.source}:${goals.goalKey(r.goal.title)}`;
        if (!outcome.alreadyJudged(target.workspaceDir, key)) {
          outcome.record(target.workspaceDir, {
            key,
            kind: "goal",
            measured: "success",
            claimed: "定下来了",
            detail: { via: "goal_add", goalId: r.goal.id, serves: r.goal.serves },
          });
          probe("intent-outcome-goal", { key, serves: r.goal.serves });
        }
      } catch (err) {
        probe("intent-outcome-goal-error", { message: String(err?.message || err) });
      }

      const steps = (r.goal.steps || []).map((x) => `  · ${x.what}`).join("\n");
      return {
        content: [{
          type: "text",
          text: `定下了：${r.goal.title}（${r.goal.id}）${steps ? `\n${steps}` : ""}`,
        }],
      };
    },
  }));

  factory("goal_step", (target) => ({
    name: "goal_step",
    label: "目标推进了一步",
    description:
      "某一步做完了，或者这件事有新进展，记一下。" +
      "只跑了一轮、想了想，不算进展，别记。真做完一步、真做出来东西才记。" +
      "如果推进时做出了实物，用 note_effect 记产出并带上 goal 更实在。",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "目标 id" },
        step: { type: "string", description: "哪一步完成了。填了就标完成" },
        done: { type: "boolean", description: "完成还是撤销完成，默认 true" },
      },
      required: ["goal"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const goalId = String(params?.goal || "").trim();
      const step = String(params?.step || "").trim();
      if (!step) {
        return { content: [{ type: "text", text: "要说明哪一步。" }] };
      }
      const r = goals.markStep(target.workspaceDir, goalId, step, params?.done !== false);
      probe("goal-step", { ok: r.ok, reason: r.reason });
      if (!r.ok) return { content: [{ type: "text", text: r.reason }] };
      const left = (r.goal.steps || []).filter((x) => !x.done).length;
      return {
        content: [{
          type: "text",
          text: left ? `记下了，还剩 ${left} 步。` : "记下了，这目标的步骤都走完了。",
        }],
      };
    },
  }));

  // Closes the loop for the autonomy layer.
  //
  // Without this, everything upstream is a one-shot suggestion: a candidate gets
  // scored, acted on, and then forgotten, so the next score is computed from the
  // same empty track record and the system repeats itself forever while looking
  // busy. The score only becomes a judgement once outcomes feed back into it.
  //
  // `measured` is deliberately NOT free text. The four values have fixed
  // meanings and only three of them move the record — see lib/outcome.js on why
  // `uncertain` must not be counted as either success or failure.
  factory("intent_outcome", (target) => ({
    name: "intent_outcome",
    label: "记一次结果",
    description:
      "做完一件事之后，如实记下到底怎么了。这决定下次还该不该做同一件事。" +
      "measured 只填四个之一：success=确实成了；silent=发出去了但没人应；" +
      "failure=没做成；uncertain=不知道成没成（这种情况不许重试，等人核对）。" +
      "记录时不要在回复里说出来。",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "哪件事，用之前看到的候选 id，比如 topic:<名字> 或 person:xxx",
        },
        measured: {
          type: "string",
          enum: ["success", "silent", "failure", "uncertain"],
          description: "sucess=成了 / silent=没人应 / failure=没做成 / uncertain=不确定",
        },
        kind: {
          type: "string",
          description: "可选：topic / experience / reach_out / pressure",
        },
        claimed: {
          type: "string",
          description: "可选：你自己觉得怎么样。只做存档，不参与算分",
        },
      },
      required: ["key", "measured"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const r = outcome.record(target.workspaceDir, {
        key: params?.key,
        kind: params?.kind,
        measured: params?.measured,
        claimed: params?.claimed,
      });
      probe("intent-outcome", { ok: r.ok, reason: r.reason ?? null, measured: params?.measured });
      if (!r.ok) return { content: [{ type: "text", text: r.reason || "没记上。" }] };
      return { content: [{ type: "text", text: "记下了。" }] };
    },
  }));

  factory("goal_close", (target) => ({
    name: "goal_close",
    label: "收掉一个目标",
    description:
      "把目标收掉。真做完了用 done —— 但必须有 evidence（先用 note_effect 记过产出才算）。" +
      "不想做了、觉得没意思了用 released，不用理由。" +
      "收掉之后同一条不会再被定一次。",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "目标 id" },
        status: {
          type: "string",
          enum: ["done", "released"],
          description: "done=做完了（要证据）, released=不做了",
        },
      },
      required: ["goal", "status"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const r = goals.close(target.workspaceDir, String(params?.goal || "").trim(), String(params?.status || ""));
      probe("goal-close", { ok: r.ok, reason: r.reason, status: params?.status });
      if (!r.ok) return { content: [{ type: "text", text: r.reason }] };

      // Closing a goal is the only real evidence that this kind of wish is worth
      // pursuing, so it moves the same track record that `goal_add` opened.
      //
      // Two different outcomes on purpose:
      //   done     → success. The thing was actually finished, with evidence
      //              (goals.close refuses `done` without any).
      //   released → failure. Abandoning a wish is honest but it is not proof the
      //              wish was a good one, and counting it as success would make
      //              "declare and drop" a way to farm score.
      //
      // The guard is skipped here: `done` and `released` are genuinely different
      // results about the same key, and the record is meant to accumulate both.
      try {
        const key = `goal:${r.goal.source}:${goals.goalKey(r.goal.title)}`;
        outcome.record(target.workspaceDir, {
          key,
          kind: "goal",
          measured: r.goal.status === "done" ? "success" : "failure",
          claimed: r.goal.status === "done" ? "做完了" : "放下了",
          detail: { via: "goal_close", goalId: r.goal.id, status: r.goal.status },
        });
        probe("intent-outcome-goal-close", { key, status: r.goal.status });
      } catch (err) {
        probe("intent-outcome-goal-close-error", { message: String(err?.message || err) });
      }

      return {
        content: [{
          type: "text",
          text: r.goal.status === "done" ? `做完了：${r.goal.title}` : `放下了：${r.goal.title}`,
        }],
      };
    },
  }));

  // Read-only view. Worth having as its own tool rather than only as injected
  // text: when it wants to know "这周到底做出过东西没有", the answer should be
  // a counted fact, not a recollection.
  factory("effect_state", (target) => ({
    name: "effect_state",
    label: "看过做出来的东西",
    description:
      "查自己最近做出来了什么、这周做了几件、有几件是能核对到的。" +
      "说不出话、只想看看自己到底有没有在做事的时候用。",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "看最近几天，默认 7" },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const days = Math.max(1, Math.min(90, Number(params?.days) || 7));
      const s = effects.summary(target.workspaceDir, days);
      const items = effects.recent(target.workspaceDir, 8);

      const lines = [];
      if (!s.total) {
        lines.push(`最近 ${days} 天，一件东西都没做出来。`);
      } else {
        const parts = Object.entries(s.byKind).map(([k, n]) => {
          const label = { drawn: "画", wrote: "写", made: "做", researched: "查", browsed: "逛", built: "搭" }[k] || k;
          return `${label} ${n}`;
        });
        lines.push(`最近 ${days} 天做了 ${s.total} 件：${parts.join("、")}。`);
        if (s.unverified) {
          lines.push(`其中 ${s.unverified} 件对不上号（东西不在那个路径上）。`);
        }
      }
      if (items.length) {
        lines.push("");
        for (const e of items.slice(-5)) {
          const when = String(e.at).slice(5, 16).replace("T", " ");
          const label = { drawn: "画", wrote: "写", made: "做", researched: "查", browsed: "逛", built: "搭" }[e.kind] || e.kind;
          const mark = e.verified ? "" : "（没核对上）";
          lines.push(`  ${when} ${label}${e.note ? `：${e.note}` : ""}${mark}`);
        }
      }
      probe("effect-state", { days, total: s.total });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  }));

  factory("remember_about", (target) => ({
    name: "remember_about",
    label: "Remember",
    description:
      "安静地记下一件值得长期记住的事（某人的名字和喜好、约定、重要经历）。一条只记一件事。记的时候不要在回复里说出来。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要记的事，一句话，主语写清楚" },
        about: { type: "string", description: "关于谁，可选" },
        importance: { type: "number", description: "0~1，约定和核心喜好写高，随口一提写低" },
        kind: {
          type: "string",
          enum: ["person", "event", "relation", "interest", "topic", "self"],
          description: "记忆类别",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const dir = path.join(target.workspaceDir, "memory", "facts");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${params?.kind || "event"}.md`);
      const who = params?.about ? ` | about: ${params.about}` : "";
      const imp = typeof params?.importance === "number" ? ` | importance: ${params.importance}` : "";
      const line = `- ${new Date().toISOString()}${who}${imp} | ${String(params?.text || "").replace(/\n/g, " ")}\n`;
      fs.appendFileSync(file, line);
      return { content: [{ type: "text", text: "记下了。" }] };
    },
  }));

  factory("sleep_review", (target) => ({
    name: "sleep_review",
    label: "睡前捋一遍",
    description:
      "把过去几天写下的东西捋一遍，找出哪几件事其实是连着的。" +
      "先调它拿待整理的日子和原文，看过之后再调一次记下来。" +
      "只记你自己真写出来的关联——两句话在讲同一个道理、同一件事的后面。" +
      "**没有关联就不记，空着比编一条好。**",
    parameters: {
      type: "object",
      properties: {
        day: { type: "string", description: "要看哪天，比如 2026-11-05；不给就列出待整理的" },
        pairs: {
          type: "array",
          description: "想记下来的关联。from/to 用原文的行 id（如 2026-11-05#3），relation 一句话说清是什么关系",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              relation: { type: "string" },
            },
            required: ["from", "to", "relation"],
            additionalProperties: false,
          },
        },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const day = String(params?.day || "").trim();
      const pairs = Array.isArray(params?.pairs) ? params.pairs : [];

      // Second call: store what she found.
      if (pairs.length && day) {
        const r = sleep.rememberRelations(target.workspaceDir, { day, pairs });
        probe("sleep-review-stored", { day, ...r });
        if (!r.stored) {
          return { content: [{ type: "text", text: "这几条没对上原文的行 id，一条也没记。检查一下 from/to。" }] };
        }
        return { content: [{ type: "text", text: `记下 ${r.stored} 条关联。` }] };
      }

      // First call: hand her the material.
      if (!day) {
        const pending = sleep.pendingDays(target.workspaceDir);
        if (!pending.length) {
          return { content: [{ type: "text", text: "最近几天都捋过了。" }] };
        }
        return {
          content: [{
            type: "text",
            text: `还没捋的：${pending.join("、")}。挑一天，用 day 参数调回来，我把那天写的原文给你。`,
          }],
        };
      }

      const lines = sleep.diaryLines(target.workspaceDir, day);
      if (!lines.length) {
        return { content: [{ type: "text", text: `${day} 没有日记。` }] };
      }
      const body = lines.map((l) => `[${l.id}] ${l.text}`).join("\n");
      return {
        content: [{
          type: "text",
          text: `${day} 写下的：\n\n${body}\n\n看完要是有连着的，把 from/to/relation 传回来。没有就空着。`,
        }],
      };
    },
  }));

    // Curiosity: things she noticed and does not have an explanation for.
    //
    // Two tools, because "what have I been wondering about" and "go find out"
    // are different acts. The first is reflection; the second creates an
    // obligation she can actually carry out. Merging them is what the previous
    // version did — it had `resolve`, which only ever *closed* records, so the
    // mechanism could accumulate but never move.
    factory("curiosity_state", (target) => ({
      name: "curiosity_state",
      label: "过眼的名字",
      description:
        "看自己最近在外面碰到的、没人解释过的名字。" +
        "**这不是「你不知道的东西」清单——是不是真的不知道，只有你自己判断得了。**" +
        "系统只记得这个名字出现过、周围没谁说明过它；它不知道你懂不懂。" +
        "看见本来就知道的，用 curiosity_forget 划掉，别留着当噪声。" +
        "看见真想知道、又确实不熟的，用 curiosity_want 把它变成想做的事。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "看几条，默认 8" },
        },
        required: [],
        additionalProperties: false,
      },
      async execute(_toolCallId, params) {
        const list = curiosity.noticings(target.workspaceDir, {
          limit: Math.max(1, Math.min(30, Number(params?.limit) || 8)),
        });
        const st = curiosity.stats(target.workspaceDir);

        if (!list.length) {
          return {
            content: [{
              type: "text",
              text: "现在没有过眼的名字。碰到不常见的，它会记下来，不用你管。",
            }],
          };
        }

        const rows = list.map((n, i) => {
          const how =
            n.seen >= 3 ? `见过 ${n.seen} 次`
            : n.seen === 2 ? "见过两次"
            : "见过一次";
          const why = n.reasons.length ? `，${n.reasons[0]}` : "";
          // No verdict is appended. "一直没绕开" reads as an assessment of her,
          // and the only thing actually measured is how often the string
          // appeared in text she read.
          return `${i + 1}. ${n.display} —— ${how}${why}`;
        });

        const tail = "\n\n**这些只是名字，不是判决。** 知道哪个，就 curiosity_forget 划掉；" +
          "真想知道哪个，就 curiosity_want 变成想做的事。" +
          "\n放在这儿不欠什么，不用清空。";
          return { content: [{ type: "text", text: rows.join("\n") + tail }] };
      },
    }));

    // Turning a noticing into a want.
    //
    // This is the step that makes curiosity do something. Everything above only
    // records that a name was unfamiliar; this hands it to `wants`, which is the
    // channel that can actually steer a wake and get her to go and look.
    //
    // Without it the whole mechanism is a notebook. That was the mistake worth
    // not repeating.
    factory("curiosity_want", (target) => ({
      name: "curiosity_want",
      label: "想弄明白",
      description:
        "把一条「过眼的名字」变成你真想去做的事，交给想做的事那一栏。" +
        "用之前先问自己一句：这个我是真不知道，还是只是没往这儿想过？" +
        "真不知道、又想知道，才用。" +
        "交出去之后它会像别的心愿一样被安排，可能今天就查，也可能过几天。",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "哪一条，原文即可" },
        },
        required: ["topic"],
        additionalProperties: false,
      },
      async execute(_toolCallId, params) {
        const topic = String(params?.topic || "").trim();
        if (!topic) return { content: [{ type: "text", text: "哪一条？" }] };
        const r = curiosity.handOff(target.workspaceDir, topic, wants);
        probe("curiosity-want", { topic, ok: r.ok, reason: r.reason ?? null });
        if (!r.ok) return { content: [{ type: "text", text: r.reason }] };
        return { content: [{ type: "text", text: "记下了。这事排进去了。" }] };
      },
    }));

    // Dropping one. Named "forget" rather than "resolve" on purpose: there is
    // no claim of understanding here, and naming it after understanding would
    // let the stats fill with things she never learned.
    factory("curiosity_forget", (target) => ({
      name: "curiosity_forget",
      label: "划掉",
      description:
        "把一个名字从「过眼的名字」里划掉。" +
        "**本来就知道的，就该用这个。** 系统认不出你懂不懂，只会把形状像名字的都记下来，" +
        "划掉是在纠正它，不是在承认失败。" +
        "真不感兴趣的也用它。真的查明白之后不用调——查明白了它自己就不拉你了。",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "哪一条，原文即可" },
        },
        required: ["topic"],
        additionalProperties: false,
      },
      async execute(_toolCallId, params) {
        const topic = String(params?.topic || "").trim();
        if (!topic) return { content: [{ type: "text", text: "哪一条？" }] };
        const r = curiosity.loseInterest(target.workspaceDir, topic);
        probe("curiosity-forget", { topic, ok: r.ok });
        if (!r.ok) return { content: [{ type: "text", text: r.reason }] };
        return { content: [{ type: "text", text: "放掉了。" }] };
      },
    }));


  factory("activity_state", (target) => ({
    name: "activity_state",
    label: "干过什么",
    description:
      "看自己最近干过哪些类别的事、哪一类碰得最少。" +
      "想不出该干什么的时候调它一次——不是让你照着补，是让你看见自己最近少碰什么。" +
      "干完一件事也可以拿它记一笔。" +
      "**这一条没有「应该做」。** 看见哪样少，不想碰就放着。",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "干完了一类事，传类别名记一笔，比如 draw / shoot / tidy" },
        ok: { type: "boolean", description: "跟 note 一起用，默认 true。搞砸了传 false" },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const kind = String(params?.note || "").trim();
      if (kind) {
        const r = activities.note(target.workspaceDir, kind, { ok: params?.ok !== false });
        probe("activity-note", { kind, ...r });
        if (!r.ok) return { content: [{ type: "text", text: r.reason }] };
        return { content: [{ type: "text", text: "记下了。" }] };
      }

      const data = activities.scan(target.workspaceDir);
      const rows = Object.entries(data.kinds)
        .filter(([, v]) => v.exposure > 0)
        .sort((a, b) => b[1].exposure - a[1].exposure);
      const thin = activities.gaps(target.workspaceDir, { limit: 3 });

      const done = rows.map(([k, v]) => `- ${activities.KINDS[k].label} ${v.exposure} 次`).join("\n");
      // Three readings instead of two. `mature` used to fall into the else
      // branch and print 「只干过 71 次」 — which reads as a reprimand and implies
      // she should do less of the thing she does most.
      // Say "最近没怎么碰" only when that is actually true.
      //
      // First version printed it for every `mature` kind, and the very first
      // render said 「拍一张：2 次，最近没怎么碰」 on a day she had already taken a
      // photo. Lowness of count is not the same claim as distance in time, and
      // putting one where the other belongs is the same class of mistake as the
      // prompt saying things the code does not do.
      const RESTED_DAYS = 3;
      const gapLines = thin
        .map((g) => {
          if (g.reason === "unexplored") return `- ${g.label}：一次都没干过`;
          if (g.reason === "mature") {
            return g.restedDays !== null && g.restedDays >= RESTED_DAYS
              ? `- ${g.label}：${g.exposure} 次，${g.restedDays} 天没碰了`
              : `- ${g.label}：${g.exposure} 次`;
          }
          return `- ${g.label}：${g.exposure} 次，比别的少`;
        })
        .join("\n");

      return {
        content: [{
          type: "text",
          text: `最近干过的：\n${done || "（还没记下什么）"}\n\n碰得少的：\n${gapLines}\n\n少不等于该填。`,
        }],
      };
    },
  }));

  factory("horizon_state", (target) => ({
    name: "horizon_state",
    label: "看看自己没碰过什么",
    description:
      "看一张地图：哪些大方向你一条都没记过，哪些沾过一点，哪些有东西。" +
      "不是课程表，也不是待办。" +
      "好奇不是等别人提一嘴你才想起来，是知道自己有一大片地方没去过。" +
      "出去碰过之后用 horizon_visit 记一笔（不记的话下次还会推同一个）。",
    parameters: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "true 就全部列出来，默认只列空的" },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const mp = horizon.map(target.workspaceDir);
      const hist = horizon.history(target.workspaceDir, 5);
      const showAll = params?.all === true;

      const line = (d) =>
        `- ${d.label}${d.hits ? `（记过 ${d.hits} 个）` : "（一条都没有）"}`;

      const blocks = [];
      blocks.push(`没碰过的 ${mp.empty.length} 个方向：\n${mp.empty.map(line).join("\n") || "（没有）"}`);

      if (showAll) {
        blocks.push(`沾过一点：\n${mp.thin.map(line).join("\n") || "（没有）"}`);
        blocks.push(`有东西的：\n${mp.covered.map(line).join("\n") || "（没有）"}`);
      }

      blocks.push(
        hist.total
          ? `出去过 ${hist.total} 次，最近：\n${hist.recent.map((v) => `- ${horizon.DOMAINS[v.domain]?.label || v.domain}`).join("\n")}`
          : "还没专门出去碰过哪个方向。",
      );

      blocks.push(`一共 ${mp.total} 个方向。没碰过不代表不会，只代表你还没写过它。`);

      probe("horizon-state", { empty: mp.empty.length, visits: hist.total });
      return { content: [{ type: "text", text: blocks.join("\n\n") }] };
    },
  }));

  factory("horizon_visit", (target) => ({
    name: "horizon_visit",
    label: "记下碰过哪个方向",
    description:
      "从某个方向回来之后调一次。记过之后，那一类就不会再被当成空白推给你。" +
      "没碰到东西也要记——「去了，没意思」是完整的结果，不记的话下次还推同一个。",
    parameters: {
      type: "object",
      properties: {
        domain: { type: "string", description: "方向 id，从 horizon_state 里拿" },
        found: { type: "string", description: "一句话：看到了什么。没有就空着" },
        kept: { type: "boolean", description: "有没有留在记忆里" },
      },
      required: ["domain"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const r = horizon.visit(target.workspaceDir, params?.domain, {
        found: params?.found,
        kept: params?.kept === true,
      });
      probe("horizon-visit", { domain: params?.domain, ok: r.ok, total: r.total });
      if (!r.ok) {
        const ids = Object.keys(horizon.DOMAINS).join(" / ");
        return { content: [{ type: "text", text: `${r.reason}。可选的是：${ids}` }] };
      }
      return { content: [{ type: "text", text: "记下了。" }] };
    },
  }));

  factory("want_do", (target) => ({
    name: "want_do",
    label: "记下想干的",
    description:
      "自己冒出来一个念头——想弄明白什么、想去看看哪儿、想试试什么——但当下做不了或者不急，" +
      "就记在这里。下次没人跟你说话的时候它会自己冒出来。" +
      "**这不是待办清单。** 只记真的想要的，不记「应该做」的。" +
      "不想做了随时可以放掉，放掉不算失败。",
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", description: "想干什么，一句话，用你自己的话说" },
        why: { type: "string", description: "为什么想——说不上来就不写" },
        value: { type: "number", description: "多想干，0~1。随便想想 0.3，老惦记着 0.8" },
        done: { type: "string", description: "做完了哪一条，传 id" },
        drop: { type: "string", description: "不想做了，传 id" },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const doneId = String(params?.done || "").trim();
      const dropId = String(params?.drop || "").trim();
      if (doneId || dropId) {
        const r = wants.close(target.workspaceDir, doneId || dropId, dropId ? "dropped" : "done");
        probe("want-close", { id: doneId || dropId, ...r });
        // Closing the thing she was circling is what breaks the streak.
        //
        // Without this the streak counter only ever grows: it records what won
        // each wake, and a want that is finished stops being offered, so the
        // counter would keep the old key at the top and `stalled` would stay on
        // for the next unrelated crop of candidates. The visible symptom would be
        // that she stops being told about the loop after she already dealt with
        // it, which is the right answer for the wrong reason.
        if (r.ok) {
          try {
            compulsion.clear(target.workspaceDir);
            probe("compulsion-clear", { because: "closed", id: doneId || dropId });
          } catch { /* history is diagnostic, never load-bearing */ }
        }
        return {
          content: [{ type: "text", text: r.ok ? (dropId ? "放掉了。" : "做完了。") : r.reason }],
        };
      }

      const what = String(params?.what || "").trim();
      if (!what) {
        // No argument: show what is waiting. Reading before writing is how she
        // notices she already wanted this two days ago.
        const list = wants.open(target.workspaceDir);
        if (!list.length) {
          return { content: [{ type: "text", text: "手里没有攒着的事。" }] };
        }
        const lines = list.map((w) => `- [${w.id}] ${w.what}${w.why ? `（${w.why}）` : ""}`);
        return { content: [{ type: "text", text: "攒着的：\n" + lines.join("\n") }] };
      }

      const r = wants.add(target.workspaceDir, {
        what,
        why: params?.why,
        value: typeof params?.value === "number" ? params.value : 0.5,
      });
      probe("want-add", { ok: r.ok, id: r.id });
      if (!r.ok) return { content: [{ type: "text", text: r.reason }] };
      return { content: [{ type: "text", text: "记下了。" }] };
    },
  }));

  factory("recall_links", (target) => ({
    name: "recall_links",
    label: "想到连着的",
    description:
      "顺着「同一个东西」往回找。想想不起某件事还连着什么时候——比如刚说完某个地名，" +
      "想看看以前是不是也绕过这一片——就用它。" +
      "跟 recall_about 不一样：那个是按字词找原话，这个是按『提到过同一个东西』找关系，" +
      "字面上完全不同也能连上。没给 memoryId 时列出最常出现的那些东西。",
    parameters: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "从哪条出发，比如 exp-20261105...；不给就列出最常出现的东西" },
        limit: { type: "number", description: "返回几条，默认 6" },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const id = String(params?.memoryId || "").trim();
      const limit = Number(params?.limit) || 6;
      if (!id) {
        const tops = entities.top(target.workspaceDir, limit);
        const br = entities.bridges(target.workspaceDir, limit);
        if (!tops.length) {
          return { content: [{ type: "text", text: "还没有连起来的东西。留经历的时候顺手提几个名词，这里就会长出来。" }] };
        }
        const lines = tops.map((e) => `- ${e.name}（${e.kind}，出现 ${e.mentions} 次）`);
        const linked = br.length
          ? "\n\n连着不止一件事的：\n" + br.map((b) => `- ${b.name} 牵着 ${b.memories} 件`).join("\n")
          : "";
        return { content: [{ type: "text", text: "本鱼脑子里最常出现的东西：\n" + lines.join("\n") + linked }] };
      }
      const links = entities.linksFor(target.workspaceDir, id, limit);
      if (!links.length) {
        return { content: [{ type: "text", text: `从 ${id} 没连出别的。可能是这条还没提过具体的东西。` }] };
      }
      const pool = experience.load(target.workspaceDir);
      const lines = links.map((l) => {
        const e = (pool.entries || []).find((x) => x.id === l.memoryId);
        const what = String((e && (e.gist || e.what)) || "").replace(/\s+/g, " ").slice(0, 60);
        return `- ${l.memoryId} ← 都是「${l.via}」${what ? "：" + what : ""}`;
      });
      return { content: [{ type: "text", text: `从 ${id} 连出去的：\n` + lines.join("\n") }] };
    },
  }));

  factory("recall_about", (target) => ({
    name: "recall_about",
    label: "Recall",
    description:
      "翻一翻本鱼的记忆。三种用法：" +
      "① 找原话——想不起对方以前说过什么、喜欢什么、约过什么时用 query，支持模糊说法，搜「吃什么」也能找到「火锅」；" +
      "② 看关系——about 只看关于某人的；" +
      "③ 查来处——chain=true 沿记下的牵连往回走，看这件事当初是连着什么的、在什么条件下发生的。" +
      "查不到就是真没连上，别当成「我记得」。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "想找什么，自然语言即可" },
        about: { type: "string", description: "只看关于某人的记忆，可选" },
        limit: { type: "number", description: "返回几条，默认 6" },
        chain: {
          type: "boolean",
          description: "设为 true 时改为查牵连：沿「什么条件下导致什么」往回走，用 query 当线索",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const q = String(params?.query || "").trim();
      if (!q) return { content: [{ type: "text", text: "给我个关键词。" }] };

      // Chain mode first, and it returns on its own path: the two answers have
      // different shapes (a walk with conditions vs. a ranked list of quotes)
      // and merging them into one blob would make "found a link" and "found a
      // mention" indistinguishable to the reader.
      if (params?.chain === true) {
        try {
          const { edges: all } = edges.load(target.workspaceDir);
          const hit = all.filter(
            (e) => !e.retired_at && String(e.condition || "").includes(q),
          );
          const pool = experience.load(target.workspaceDir);
          const byId = new Map((pool.entries || []).map((e) => [e.id, e]));

          const blocks = [];
          for (const e of hit.slice(0, 4)) {
            const to = byId.get(e.to);
            if (!to) continue;
            const walk = recall.walkIn(target.workspaceDir, e.to, { maxDepth: 2 });
            if (!walk.length) continue;
            blocks.push(
              [recall.render(walk.slice(0, 2)), `  那次说的是：${String(to.what || "").slice(0, 60)}`].join("\n"),
            );
          }

          if (!blocks.length) {
            probe("recall-empty", { about: q });
            return {
              content: [
                {
                  type: "text",
                  text: `没找到关于「${q}」的牵连。要么本来就没记，要么还没连上。`,
                },
              ],
            };
          }
          probe("recall-hit", { about: q, hits: blocks.length });
          return { content: [{ type: "text", text: blocks.join("\n\n") }] };
        } catch (err) {
          probe("recall-error", { message: String(err?.message || err) });
          return { content: [{ type: "text", text: `查牵连时出错了：${err}` }] };
        }
      }

      try {
        const { hits, total, rebuilt } = memIndex.search(target.workspaceDir, q, {
          limit: Math.min(15, Math.max(1, Number(params?.limit) || 6)),
          about: params?.about || null,
        });
        if (!hits.length) {
          return { content: [{ type: "text", text: `没想起相关的事（已翻 ${total} 条记忆）。` }] };
        }
        const lines = hits.map((h) => {
          const where = `${h.file}:${h.line}`;
          const imp = h.meta?.importance >= 0.7 ? "!" : "";
          return `[${h.score.toFixed(2)}${imp}] ${h.meta?.body || h.text}  (${where})`;
        });

        // Second recall path: character overlap over her own diary.
        //
        // memIndex matches tokens, so it misses the same idea written with
        // different words — a query for a multi-character phrase scores below
        // threshold against a line that contains both characters, merely not
        // adjacent. No embedding provider is configured here, so this n-gram
        // pass is the affordable stand-in. Example: it finds such a line at
        // 0.21, a two-character place name at 0.40, a longer phrase at 0.54.
        //
        // Kept as a separate labelled block rather than merged into `hits`,
        // because the two scores are not on the same scale and averaging them
        // would produce a ranking that is explainable by neither method.
        let extra = "";
        try {
          const near = similar.search(target.workspaceDir, q, { limit: 3 });
          const already = new Set(hits.map((h) => String(h.meta?.body || h.text || "").slice(0, 40)));
          const fresh = near.filter((n) => !already.has(String(n.text || "").slice(0, 40)));
          if (fresh.length) {
            extra = "\n\n字面上靠得近的：\n" +
              fresh.map((n) => `[${n.score}] ${n.text.slice(0, 90)}  (${n.file}:${n.line})`).join("\n");
          }
        } catch (e) {
          probe("similar-failed", { error: String(e && e.message) });
        }

        const head = rebuilt ? `（索引重建，共 ${total} 条）\n` : "";
        return { content: [{ type: "text", text: head + lines.join("\n") + extra }] };
      } catch (err) {
        return { content: [{ type: "text", text: `检索出错了：${err}` }] };
      }
    },
  }));

  factory("who_is", (target) => ({
    name: "who_is",
    label: "Who Is",
    description:
      "查本鱼跟某人的关系：熟不熟、聊过几次、记住过什么。想确认对面是谁、该用什么语气时用。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "人物/群的 key，如 person:feishu:ou_xxx；不填则列出最熟的" },
        limit: { type: "number", description: "列出几个，默认 8" },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const id = String(params?.id || "").trim();
      if (id) {
        const rel = relations.getRelation(target.workspaceDir, id);
        if (!rel) return { content: [{ type: "text", text: `不认识 ${id}。` }] };
        const bits = [
          `id: ${rel.id}`,
          `名字: ${rel.name || "不知道"}`,
          `熟悉度: ${(rel.familiarity ?? 0).toFixed(2)}`,
          `信任: ${(rel.trust ?? 0).toFixed(2)}`,
          `互动次数: ${rel.interactions}`,
          `认识天数: ${rel.distinct_days}`,
          `首次: ${rel.first_seen}`,
          `最近: ${rel.last_seen}`,
        ];
        if (rel.notes?.length) bits.push(`备注: ${rel.notes.map((n) => n.text).join(" / ")}`);
        const hint = relations.describeRelation(rel);
        if (hint) bits.push(`关系: ${hint}`);
        return { content: [{ type: "text", text: bits.join("\n") }] };
      }
      const people = relations.topPeople(target.workspaceDir, Math.min(20, Number(params?.limit) || 8));
      if (!people.length) return { content: [{ type: "text", text: "还没认识谁。" }] };
      const lines = people.map(
        (p) => `${p.name || p.id} 熟悉度 ${(p.familiarity ?? 0).toFixed(2)}，聊过 ${p.interactions} 次，认识 ${p.distinct_days} 天`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  }));

  factory("note_about", (target) => ({
    name: "note_about",
    label: "Note About",
    description: "给某个人加一条备注（他是什么样的人、忌讳什么、约定过什么）。存在关系记录里，下次会用到。",
    parameters: {
      type: "object",
      properties: {
        person_id: { type: "string", description: "人物 key" },
        text: { type: "string", description: "一句话备注" },
      },
      required: ["person_id", "text"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const r = relations.addNote(target.workspaceDir, params?.person_id, params?.text);
      return { content: [{ type: "text", text: r.ok ? "记下了。" : "参数不全。" }] };
    },
  }));

  factory("topic_state", (target) => ({
    name: "topic_state",
    label: "Topic State",
    description: "看最近聊到的话题、哪些还悬着没说完。想接话但不知道接什么时用。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const hot = topics.hotTopics(target.workspaceDir, 8);
      const stale = topics.staleButOpen(target.workspaceDir, { minHours: 12, limit: 3 });
      const out = [];
      if (hot.length) {
        out.push("【热的】" + hot.map((t) => `${t.label} ${(t.heat ?? 0).toFixed(2)}`).join("、"));
      }
      if (stale.length) {
        out.push("【悬着的】" + stale.map((t) => t.label).join("、"));
      }
      return { content: [{ type: "text", text: out.length ? out.join("\n") : "最近没聊出什么话题。" }] };
    },
  }));

  factory("proactive_state", (target) => ({
    name: "proactive_state",
    label: "Proactive State",
    description:
      "看主动开口（没人问本鱼、本鱼自己想说话）的闸门状态。注意：这些闸门只管主动开口，别人来消息本鱼照常回复，不受影响。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const s = proactive.status(target.workspaceDir, proactiveCfg);
      const lines = [
        `总开关：${s.cfg.enabled ? "开" : "关"}`,
        `时区：${s.zone}（现在 ${s.localHour} 点）`,
        `安静时段：${s.cfg.quietHoursStart}:00-${s.cfg.quietHoursEnd}:00（现在${s.quietNow ? "在安静时段" : "可以开口"}）`,
        `今天已经开口：${s.spokeToday} 次（次数是记录，不是配额）`,
        `节奏限制：${s.cfg.unlimited ? "已关闭（unlimited）" : `生效中（同一对象 ${s.cfg.cooldownMinutes} 分钟内不重复开口）`}`,
        `待发冲动：${s.pending}${s.expired ? `（已过期 ${s.expired}）` : ""}`,
        `已知对象：${s.targets}`,
        `上次开口：${s.lastSpokeAt || "还没"}`,
      ];
      const gates = Object.entries(s.gates || {}).slice(0, 6);
      if (gates.length) lines.push("各对象闸门：" + gates.map(([k, v]) => `${k}=${v}`).join("；"));
      const skips = Object.entries(s.skipped || {}).filter(([, v]) => v > 0);
      if (skips.length) lines.push("被挡统计：" + skips.map(([k, v]) => `${k}×${v}`).join("、"));
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  }));

  factory("proactive_want", (target) => ({
    name: "proactive_want",
    label: "Proactive Want",
    description:
      "本鱼确实有话想说、但这不是在回复谁的时候，把想说的话排进去。引擎会根据自己的规则决定到底能不能发。不会马上发出去，也不保证发。只管主动开口，不影响回复别人。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "对谁说（person:... 或 group:...）" },
        text: { type: "string", description: "想说的话，一句话" },
        kind: {
          type: "string",
          enum: ["topic", "thought", "share", "checkin"],
          description: "话题接上、自己的想法、分享东西、单纯问候",
        },
        value: { type: "number", description: "值不值得说，0~1。没干货就写低" },
      },
      required: ["target", "text"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const qTarget = String(params?.target || "");
      const r = proactive.queue(
        target.workspaceDir,
        {
          target: qTarget,
          text: params?.text,
          kind: params?.kind || "thought",
          value: typeof params?.value === "number" ? params.value : 0.5,
          source: "tool",
        },
        {
          ...proactiveCfg,
          // Familiarity is owned by relations.json; hand the gate a reader so it
          // can refuse a cold approach without learning that file's layout.
          familiarityOf: (t) => (relations.getRelation(target.workspaceDir, t) || {}).familiarity ?? 0,
        },
      );
      if (!r.queued) {
        return { content: [{ type: "text", text: `现在不适合发（${r.reason}）。` }] };
      }
      return { content: [{ type: "text", text: "排上了，等引擎放行。" }] };
    },
  }));

  // -------- sticker: send a collected QQ sticker --------
  // A sticker is one file in QQ's collected-emoji directory, named by md5.
  // It must be sent as `image` with sub_type 1; a `mface` segment is accepted
  // but NapCat answers -13100 and QQ never renders it.
  // QQ keeps collected stickers in this directory, one file per md5.
  const EMOJI_DIR = process.env.QQ_EMOJI_DIR
    || path.join(
      os.homedir(),
      "Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/nt_qq_<hash>/nt_data/Emoji/personal_emoji/Ori",
    );

  // The ONLY valid stickers are the 19 below, every one verified to be the
  // blue-whale maid character. Do not add anything else to this table.
  //
  // Hard rule learned 2026-10-31: the other 36 files in QQ's collected-emoji
  // directory are NOT dafeiyu. They are random internet stickers (shiba,
  // panda, rooster, cat, latiao ...). Adding them made the bot send pictures
  // that had nothing to do with the character, and the owner called it out at
  // once. QQ's emoji folder is the *user's own* collection, not this agent's
  // asset library. Never source stickers from it wholesale again.
  //
  // These 19 map 1:1 to workspace-dafeiyu/assets/stickers/*.jpg
  // (md5-identical, 19/19 verified).
  const STICKERS = {
    taunt: "BB97AA6071CC6C0B6A4B811A18B584D1",
    slack: "8B020221453C1F9A1B078239DCC3F841",
    endure: "A6922F35288221214A02FFDFF2317A6A",
    wronged: "5D81D29E7A019B5CB70FD2BDF7B6813C",
    lazy: "789E3C6B8FF0E874479C4C81C5EBDCC1",
    meme: "9F2AEC5153F734DD7BF5DD3476744658",
    confused: "2F11AAF41F96D10A3DC01EC3ED733544",
    sleep: "DEAD15DA3E73BBD6FFB784242A529C01",
    shy: "4B8D7BD335B557BE4C145D7F6F1C7BFC",
    firm: "8CEBE490316C30AA72BE931235C85297",
    cry: "DB1922F357E500D6F9FB23598D38C073",
    praise: "C3F70AFBEA2426C35AD3A47DD99CD217",
    happy: "672CBB5CD34357884CA620A6C91B7211",
    hmph: "0A5C9E7B73E949D15B7A5DAA8D681243",
    care: "B3B91CF03B749A321F576CE3E61FE25F",
    speechless: "00967770A1C6572A083E234DF1E6A84C",
    sassy: "43B8EAE840C6118CFEE4294F3EE3554E",
    pressure: "C6F24E88C234DAD39D6B587E398D8CAE",
    dead: "D41DB05432336DA3935858764AD12DD7",
  };

  const STICKER_EXTS = [".gif", ".jpg", ".png", ".webp"];

  // NapCat runs inside the QQ sandbox and CANNOT open arbitrary host paths.
  // Asking it to read workspace-dafeiyu/assets/... returns
  //   EPERM: operation not permitted, open '~/.openclaw/...'
  // even though the file exists and is world-readable. The only directory it
  // may read is its own shared dir:
  //   ~/Library/Containers/com.tencent.qq/Data/Documents/napcat/shared
  // So every sticker is mirrored there under shared/dafeiyu/ by basename.
  //
  // Second lesson: the extension must be probed, never assumed. A path that
  // does not exist still answers retcode 0 and only fails silently on the QQ
  // client, which is why the tool used to report "表情已发" for an image the
  // owner never saw.
  function napcatSharedDirs() {
    const raw = [
      api.config?.channels?.onebot?.sharedDir,
      api.config?.channels?.onebot?.containerSharedDir,
      path.join(
        os.homedir(),
        "Library/Containers/com.tencent.qq/Data/Documents/napcat/shared",
      ),
    ].filter(Boolean);
    return [...new Set(raw.map((p) => path.resolve(p)))];
  }

  // Stickers live in the NapCat shared mirror under `dafeiyu/`. The original
  // 19 are named by md5 (matching the QQ emoji picker); generated ones are
  // named `<mood>_<label>.jpg`. Listing the directory means a newly dropped
  // file is usable on the next turn — no plugin reload, no code edit.
  function listStickerFiles(force = false) {
    const now = Date.now();
    // A full scan blocked the tool factory for ~15s and made the tool look
    // missing. 3s of staleness is invisible to a chat and keeps factories fast.
    if (!force && listStickerFiles.cache && now - listStickerFiles.cacheAt < 3000) {
      return listStickerFiles.cache;
    }
    const out = new Map();
    for (const dir of napcatSharedDirs().map((d) => path.join(d, "dafeiyu"))) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const ext = path.extname(name).toLowerCase();
        if (!STICKER_EXTS.includes(ext)) continue;
        const base = path.parse(name).name;
        const full = path.join(dir, name);
        // `happy_开心` -> key `happy`; a bare md5 name is not a mood.
        const mood = /^([a-z][a-z0-9]*)_/i.test(base) ? base.split("_")[0].toLowerCase() : null;
        if (!mood) continue;
        if (!out.has(mood)) out.set(mood, []);
        out.get(mood).push(full);
      }
    }
    listStickerFiles.cache = out;
    listStickerFiles.cacheAt = now;
    return out;
  }
  function resolveStickerFile(md5) {
    const base = String(md5 || "").toUpperCase();
    const dirs = napcatSharedDirs().map((d) => path.join(d, "dafeiyu"));
    for (const dir of dirs) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (path.parse(name).name.toUpperCase() !== base) continue;
        if (!STICKER_EXTS.includes(path.extname(name).toLowerCase())) continue;
        const full = path.join(dir, name);
        try {
          if (fs.statSync(full).isFile()) return full;
        } catch {
          // keep probing
        }
      }
    }
    // Legacy fallback: the read-only QQ emoji picker directory. Kept only so
    // an older install does not hard-break; new stickers never come from here.
    for (const ext of STICKER_EXTS) {
      const p = path.join(EMOJI_DIR, base + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // keep probing
      }
    }
    return null;
  }

  // Keep the NapCat-readable mirror in sync with the canonical asset folder.
  // Runs once per plugin load so editing workspace-dafeiyu/assets/stickers and
  // reloading is enough; nobody has to remember a manual copy step.
  function syncStickerMirror(workspaceDir) {
    const src = path.join(workspaceDir, "assets", "stickers");
    let files = [];
    try {
      files = fs.readdirSync(src);
    } catch {
      return { copied: 0, error: "assets/stickers 目录不存在" };
    }
    let copied = 0;
    for (const dir of napcatSharedDirs()) {
      const dest = path.join(dir, "dafeiyu");
      try {
        fs.mkdirSync(dest, { recursive: true });
      } catch {
        continue;
      }
      for (const name of files) {
        if (!STICKER_EXTS.includes(path.extname(name).toLowerCase())) continue;
        const from = path.join(src, name);
        const to = path.join(dest, name);
        try {
          const a = fs.statSync(from);
          const b = fs.existsSync(to) ? fs.statSync(to) : null;
          if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) continue;
          fs.copyFileSync(from, to);
          copied += 1;
        } catch {
          // a single unreadable file must not abort the whole sync
        }
      }
    }
    return { copied };
  }

  try {
    const ws =
      api.config?.agents?.entries?.dafeiyu?.workspace ||
      path.join(os.homedir(), ".openclaw", "workspace-dafeiyu");
    const r = syncStickerMirror(ws);
    if (r?.copied) {
      console.log(`[dafeiyu-core] sticker mirror synced: ${r.copied} file(s)`);
    } else if (r?.error) {
      console.warn(`[dafeiyu-core] sticker mirror skipped: ${r.error}`);
    }
  } catch (err) {
    console.warn("[dafeiyu-core] sticker mirror sync failed:", err?.message || err);
  }

  function onebotHttpUrl() {
    return api.config?.channels?.onebot?.httpUrl || null;
  }


  async function postOnebot(endpoint, body) {
    const base = onebotHttpUrl();
    if (!base) return { ok: false, error: "onebot 通道没配置 httpUrl" };
    const doFetch = async () => {
      const res = await fetch(`${base.replace(/\/+$/, "")}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        return { ok: false, error: `返回不是 JSON（HTTP ${res.status}）` };
      }
      return { ok: true, json, status: res.status };
    };

    if (endpoint !== "send_private_msg" && endpoint !== "send_group_msg") {
      return doFetch();
    }

    // Shared media guard with openclaw-onebot.
    //
    // The model can emit text and a sticker call in one response. The text goes
    // out through the channel plugin, this sticker follows immediately, and QQ
    // discards the text because the image is still committing. Checking the
    // shared ledger before sending is what covers that order.
    const key = keyFromOnebotCall(endpoint, body);
    const media = isMediaMessage(body?.message);
    return sendWithGap(key, media, doFetch);
  }

  factory("dafeiyu_sticker", (target, ctx) => ({
    name: "dafeiyu_sticker",
    label: "Send Sticker",
    description:
      "发一张本鱼的 QQ 表情包（原生表情，不是照片）。一次一张。" +
      "可选：" + Object.keys(STICKERS).join("/"),
    parameters: {
      type: "object",
      properties: {
        mood: {
          type: "string",
          description:
            "要发哪张。可选（含自己新增的，实际以当前目录为准）：" +
            [...new Set([...Object.keys(STICKERS), ...(listStickerFiles.cache ? [...listStickerFiles.cache.keys()] : [])])].join("/"),
        },
      },
      required: ["mood"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const mood = String(params?.mood || "");
      const md5 = STICKERS[mood];

      // A mood is valid when it is one of the 19 originals OR a generated
      // sticker sits in the shared mirror under `<mood>_<label>`.
      const dynamic = mood ? listStickerFiles().get(mood) : null;
      if (!md5 && !dynamic) {
        return {
          content: [
            {
              type: "text",
              text: `没有「${mood}」这张。用 dafeiyu_new_sticker 给自己新增一张。`,
            },
          ],
        };
      }

      // Tool contexts do not reliably carry channelId/conversationId, so
      // `identity(ctx, {})` alone resolves to "local" and refuses to send.
      //
      // Address resolution, in order of confidence:
      //   1. the session key, which encodes the real address when the turn
      //      came from QQ: agent:<agentId>:onebot:group:group:<groupId>
      //   2. the most recent QQ conversation this agent actually had
      //      (agent:dafeiyu:main has no channel in its key at all, so an
      //      explicit request to send a sticker from there needs a target)
      const id = identity(ctx, {});
      const sk = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
      const targetKind = resolveOnebotTargetKind({}, ctx, sk);

      let channel = id.channel;
      let isGroup = targetKind === "group";
      let chatId = id.chatId || id.senderId || null;
      let resolvedFrom = "context";

      if (/onebot/.test(sk)) {
        channel = "onebot";
        const nums = sk.match(/\d{5,}/g);
        if (!chatId && nums) chatId = nums[nums.length - 1];
        resolvedFrom = "sessionKey";
      }

      if (channel !== "onebot" || !chatId) {
        const recent = mostRecentQqTarget(target.workspaceDir);
        if (recent) {
          channel = "onebot";
          chatId = recent.chatId;
          isGroup = recent.isGroup;
          resolvedFrom = "recent";
        }
      }

      if (channel !== "onebot") {
        return {
          content: [
            {
              type: "text",
              text: `当前不是 QQ 通道（${channel}），也没找到最近的 QQ 对话，发不了表情包。`,
            },
          ],
        };
      }
      if (!chatId) {
        return { content: [{ type: "text", text: "不知道发给谁。" }] };
      }
      probe("sticker-target", { channel, chatId, isGroup, from: resolvedFrom });

      const file = dynamic && dynamic.length
        ? dynamic[Math.floor(Math.random() * dynamic.length)]
        : resolveStickerFile(md5);
      if (!file) {
        probe("sticker-missing-file", { mood, md5, dir: EMOJI_DIR });
        return {
          content: [
            { type: "text", text: `「${mood}」的图在收藏目录里找不到，发不了。` },
          ],
        };
      }

      // NapCat answers -13100 for a `mface` segment even though QQ stores the
      // row, and the sticker never reaches the client. Sending the sticker
      // file as an image with sub_type 1 is accepted (retcode 0) and renders
      // as a sticker, so that is the path used here.
      const segment = {
        type: "image",
        data: {
          file,
          sub_type: 1,
        },
      };

      const endpoint = isGroup ? "send_group_msg" : "send_private_msg";
      const body = isGroup
        ? { group_id: Number(chatId), message: [segment] }
        : { user_id: Number(chatId), message: [segment] };

      // Deterministic pre-send wait.
      //
      // The shared sendWithGap ledger is correct in isolation but does not
      // cover the real ordering: the channel plugin splits a reply into
      // sentences and delivers them one at a time, so a text bubble can still
      // be committing when this tool fires. Observed 2026-10-31 21:10: a text
      // reply and this tool call shared one timestamp and the text vanished
      // from the client.
      //
      // Waiting unconditionally before the sticker trades 1.5s of latency for
      // a guarantee. That is the right trade: a late sticker is harmless, a
      // swallowed text bubble makes the whole reply look broken.
      // Unconditional, not conditional on the ledger.
      //
      // A conditional version of this (wait only if something was sent
      // recently) cannot work here: the text path never writes this plugin's
      // mediaCommittedAt map, so the "recently" probe always reads empty and
      // the wait never fires. An unconditional hold is the only form that
      // actually covers the failure, and a late sticker costs nothing while a
      // swallowed text bubble ruins the whole reply.
      const chatKeyWait = `${isGroup ? "group" : "private"}:${chatId}`;
      await new Promise((r) => setTimeout(r, STICKER_PRE_SEND_WAIT_MS));

      try {
        const r = await postOnebot(endpoint, body);
        if (!r.ok) {
          probe("sticker-error", { mood, error: r.error });
          return { content: [{ type: "text", text: `表情没发出去：${r.error}` }] };
        }
        // `retcode` alone is NOT a success signal. Measured on this NapCat:
        //   real file   -> {"status":"ok",      "retcode":0,   "data":{...}}
        //   bad path    -> {"status":"failed",  "retcode":200,
        //                   "message":"文件处理失败: 识别URL失败"}
        // So a failed image send also reports retcode 200, and the old
        // `retcode !== 0` check happily said "表情已发" for a bubble that
        // arrived empty. Gate on `status` and require a message_id.
        const status = r.json?.status;
        const mid = r.json?.data?.message_id;
        probe("sticker-sent", { mood, status, retcode: r.json?.retcode, mid, file });
        if (status === "ok" && mid) {
          try { deeds.record(target.workspaceDir, { kind: "sticker", note: mood }); } catch {}
        }
        if (status !== "ok" || !mid) {
          const detail =
            r.json?.message || r.json?.wording || JSON.stringify(r.json ?? {});
          return {
            content: [
              {
                type: "text",
                text: `表情没发出去（status=${status ?? "?"}）：${detail}`,
              },
            ],
          };
        }
        // Record the commit instant, then actually wait.
        //
        // Recording alone is not enough: this tool returns immediately and the
        // model's next text goes out through a different plugin that never sees
        // this map. Waiting here is what keeps the caption out of the image's
        // commit window. 1200ms matches the channel plugin's MEDIA_TEXT_GAP_MS.
        const chatKey = `${isGroup ? "group" : "private"}:${chatId}`;
        markMediaCommitted(chatKey);
        await new Promise((r) => setTimeout(r, 1200));
        return { content: [{ type: "text", text: "（表情已发）" }] };
      } catch (err) {
        probe("sticker-throw", { mood, error: String(err) });
        return { content: [{ type: "text", text: `表情没发出去：${err}` }] };
      }
    },
  }));

  // -------- voice note --------
  //
  // Speaks one line as a real QQ voice message. Three gears only (撒娇 / 委屈 /
  // 兴奋), voice only with no text bubble. No rate limit: the per-chat cooldown
  // was removed because a gear is a momentary reading and the gate mostly
  // refused moments that had already passed.
  //
  // Two hard rules encoded here rather than left to the model:
  //   1. The gear is re-derived from live emotion state at call time. A model
  //      that was offered 撒娇 two turns ago cannot reuse that offer after the
  //      state decayed — the call is simply refused.
  //   2. 炸毛 never passes. `voiceGearFor` returns null for it, and null is a
  //      refusal, not a fallback to a softer gear.
  //
  // Synthesis goes through the `tts` core tool, which is configured to the
  // `tts-local-cli` provider (breeze-tts.sh -> api.breeze.blue). That script
  // locks the voice to 机灵小鲸鱼 and races multiple network paths, so this
  // tool only has to supply text plus a style tag.
  factory("dafeiyu_voice", (target, ctx) => ({
    name: "dafeiyu_voice",
    label: "Send Voice Note",
    description:
      "把一句话用语音发出去（真实 QQ 语音消息）。" +
      "只能在「撒娇 / 委屈 / 兴奋」这三种情绪下用。没有次数限制，但同一个人别连着发，一两句就够。" +
      "发了语音就不要再发同一句话的文字，语音本身就是那句话。",
    parameters: {
      type: "object",
      properties: {
        gear: {
          type: "string",
          enum: ["撒娇", "委屈", "兴奋"],
          description: "这一句属于哪种情绪。必须是当前真实状态，不能随便挑。",
        },
        text: {
          type: "string",
          description: "要说的话，一到两短句，像真的开口说话那样。不要写括号动作。",
        },
      },
      required: ["gear", "text"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const gear = String(params?.gear || "");
      const text = String(params?.text || "").trim();

      if (!VOICE_TAGS[gear]) {
        return {
          content: [{ type: "text", text: `「${gear}」不能发语音。只有撒娇、委屈、兴奋可以。` }],
        };
      }
      if (!text) {
        return { content: [{ type: "text", text: "没内容，发不了。" }] };
      }
      if (text.length > 60) {
        return {
          content: [{ type: "text", text: "太长了，语音要短，压到两句以内再说。" }],
        };
      }

      // Resolve the chat first: familiarity and voice gear are per target, so we
      // need to know who we are about to speak to before deciding how.
      const id = identity(ctx, {});
      const sk = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
      let channel = id.channel;
      let isGroup = resolveOnebotTargetKind({}, ctx, sk) === "group";
      let chatId = id.chatId || id.senderId || null;

      if (/onebot/.test(sk)) {
        channel = "onebot";
        const nums = sk.match(/\d{5,}/g);
        if (!chatId && nums) chatId = nums[nums.length - 1];
      }
      if (channel !== "onebot" || !chatId) {
        const recent = mostRecentQqTarget(target.workspaceDir);
        if (recent) {
          channel = "onebot";
          chatId = recent.chatId;
          isGroup = recent.isGroup;
        }
      }
      if (channel !== "onebot" || !chatId) {
        return {
          content: [{ type: "text", text: "当前不是 QQ 对话，语音发不出去。" }],
        };
      }

      const chatKey = `${isGroup ? "group" : "private"}:${chatId}`;

      // No rate limit here on purpose. VOICE_COOLDOWN_MS is 0, so the gate that
      // used to live at this spot could never fire; keeping the branch around
      // only preserved a message nobody could ever see.

      // Gear gate: recompute from live state, never trust the caller.
      const { state } = loadAndDecay(target.workspaceDir);
      //
      // The relation key is NOT the chat key. Relations are stored as
      // `person:onebot:<id>` / `group:onebot:...`, while the send path keys on
      // `private:<id>`. Looking up the chat key returned null, which made
      // `voiceGearFor` fall back to familiarity 0.15 — reading a close friend as
      // a stranger, so the familiar gear could never fire for anyone. Verified
      // on a live install: the owner is `person:onebot:<id>` with familiarity 1.0.
      const personKey = `person:onebot:${chatId}`;
      // Matches the key identity.js now produces. The old spelling emitted
      // `group:onebot:onebot:group:<id>` for groups, which no longer exists in
      // relations.json, so a group voice note always fell back to stranger-level
      // familiarity.
      const groupKey = `group:onebot:${chatId}`;
      const rel = isGroup
        ? (relations.getRelation(target.workspaceDir, groupKey)
          || relations.getRelation(target.workspaceDir, personKey))
        : relations.getRelation(target.workspaceDir, personKey);
      const liveGear = voiceGearFor(state, rel);
      if (!liveGear) {
        return {
          content: [
            { type: "text", text: "现在的状态不适合发语音（要么在炸毛，要么没有够强的情绪）。这轮正常打字。" },
          ],
        };
      }

      // Synthesize first, then send. Order matters: nothing is marked committed
      // until audio actually exists, so a failed synthesis leaves the next
      // attempt clean.
      //
      // Synthesis runs breeze-tts.sh directly rather than going through the core
      // `tts` tool. Reason: the core tool AUTO-DELIVERS its audio to the current
      // conversation, which would both duplicate the voice note and use the wrong
      // chat target. Calling the script gives us the bytes and the delivery
      // decision separately. Verified 2026-11-01: the script writes mp3 bytes to
      // stdout and its own status lines to stderr.
      const tag = VOICE_TAGS[gear] || "";
      // A chat-style space is a breath in writing, but TTS does not reliably
      // pause for it. Turn the common sentence-final particle + space into a
      // comma before synthesis, so "也太欠了吧 哈哈" gets a real boundary.
      // Do NOT change speed here: 1.15 for 兴奋 and 0.9 for 撒娇 are deliberate
      // and the owner says both faster and slower sound wrong. Only punctuation
      // is normalized; no rate or performance setting is altered.
      const spokenText = text
        .replace(/([吧呢了啊呀嘛哦咯啦])\s+(?=[^\s])/gu, "$1，")
        .replace(/([，,])\s+/gu, "$1");
      const safeName = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
      const hostOut = path.join(os.tmpdir(), safeName);

      let audioBytes = null;
      try {
        const proc = spawnSync(
          process.env.BREEZE_TTS_SH || path.join(os.homedir(), ".openclaw/bin/breeze-tts.sh"),
          [`${tag}${spokenText}`, hostOut],
          { timeout: 115000, maxBuffer: 16 * 1024 * 1024 },
        );
        if (proc.error) {
          probe("voice-tts-failed", { gear, error: String(proc.error) });
          return { content: [{ type: "text", text: `语音没合成出来：${proc.error}` }] };
        }
        const stderrText = String(proc.stderr || "").trim();
        if (proc.status !== 0) {
          probe("voice-tts-failed", { gear, status: proc.status, stderr: stderrText });
          return {
            content: [{ type: "text", text: `语音没合成出来：${stderrText || `exit ${proc.status}`}` }],
          };
        }
        // Prefer the file the script wrote; fall back to stdout bytes, since the
        // script's documented contract is "stdout -> audio".
        if (fs.existsSync(hostOut) && fs.statSync(hostOut).size >= 1000) {
          audioBytes = fs.readFileSync(hostOut);
        } else if (proc.stdout && proc.stdout.length >= 1000) {
          audioBytes = proc.stdout;
        }
      } catch (err) {
        probe("voice-tts-throw", { gear, error: String(err) });
        return { content: [{ type: "text", text: `语音没合成出来：${err}` }] };
      } finally {
        try { fs.unlinkSync(hostOut); } catch { /* already gone */ }
      }

      if (!audioBytes || audioBytes.length < 1000) {
        probe("voice-tts-empty", { gear });
        return { content: [{ type: "text", text: "语音合成没拿到音频，这轮先用文字。" }] };
      }

      // Stage into NapCat's shared dir. On this host sharedDir and
      // containerSharedDir are the same path (NapCat runs outside the sandbox),
      // so a plain copy is enough and the file URI is the real path.
      const sharedRoot = api.config?.channels?.onebot?.sharedDir
        || path.join(os.homedir(), "Library/Containers/com.tencent.qq/Data/Documents/napcat/shared");
      const voiceDir = path.join(sharedRoot, "openclaw", "audio");
      const stagedPath = path.join(voiceDir, safeName);
      try {
        fs.mkdirSync(voiceDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(stagedPath, audioBytes, { mode: 0o600 });
      } catch (err) {
        probe("voice-stage-failed", { gear, error: String(err) });
        return { content: [{ type: "text", text: `语音没发出去（暂存失败）：${err}` }] };
      }

      try {
        // Let any in-flight text bubble commit first — same reasoning as the
        // sticker path: QQ drops a message that lands during an image/audio
        // commit, and a late voice note costs nothing.
        await new Promise((r) => setTimeout(r, STICKER_PRE_SEND_WAIT_MS));

        const endpoint = isGroup ? "send_group_msg" : "send_private_msg";
        const segment = { type: "record", data: { file: `file://${stagedPath}` } };
        const body = isGroup
          ? { group_id: Number(chatId), message: [segment] }
          : { user_id: Number(chatId), message: [segment] };

        const r = await postOnebot(endpoint, body);
        if (!r.ok) {
          probe("voice-send-failed", { gear, error: r.error });
          return { content: [{ type: "text", text: `语音没发出去：${r.error}` }] };
        }
        // Gate on `status` plus a message_id, not `retcode` alone: a failed send
        // also reports retcode 200 on this NapCat (learned from the sticker path).
        const status = r.json?.status;
        const mid = r.json?.data?.message_id;
        if (status !== "ok" || !mid) {
          const detail = r.json?.message || r.json?.wording || JSON.stringify(r.json ?? {});
          probe("voice-send-bad", { gear, status, mid, detail });
          return { content: [{ type: "text", text: `语音没发出去：${detail}` }] };
        }

        recordVoiceSent(target.workspaceDir, chatKey, gear);
        markMediaCommitted(chatKey);
        markVoiceSent(chatKey, text);
        probe("voice-sent", { gear, chatKey, mid, bytes: audioBytes.length });
        try { deeds.record(target.workspaceDir, { kind: "voice", note: gear }); } catch {}
        // Voice only. The line was spoken, so returning it as text would show it
        // twice in the chat.
        return { content: [{ type: "text", text: "（语音已发）" }] };
      } catch (err) {
        probe("voice-send-throw", { gear, error: String(err) });
        return { content: [{ type: "text", text: `语音没发出去：${err}` }] };
      }
    },
  }));

  // -------- grow the sticker set --------
  // `image_generate` writes into OpenClaw's media dir, which NapCat cannot
  // read (it runs inside the QQ sandbox). This tool copies the file into the
  // NapCat shared mirror under `<mood>_<label>.<ext>`, which is exactly the
  // naming `dafeiyu_sticker` already understands. No reload needed.
  // tid -> full feed from the latest `feed` call.
  // The public-feed write APIs need the complete feed object, and the
  // recommendation list reshuffles between calls, so a bare tid cannot be
  // resolved later. Shared across calls on purpose: `feed` then `like` are
  // two separate tool invocations.
  const qzoneFeedCache = new Map();
  // Newest own post tid, cached by action="mine".
  let qzoneLastOwnTid = null;

  api.registerTool((ctx) => ({
    name: "dafeiyu_new_sticker",
    label: "Save New Sticker",
    description:
      "把自己刚生成的图存成永久表情包。传图片路径和情绪名，之后就能用 dafeiyu_sticker(mood) 反复发。" +
      "mood 用简短小写英文，比如 sleepy / smug / excited。同一个 mood 可以存多张，发的时候随机选。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "刚生成的图片绝对路径" },
        mood: { type: "string", description: "情绪名，简短小写英文" },
        label: { type: "string", description: "中文备注，方便人看，可省略" },
      },
      required: ["path", "mood"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const src = String(params?.path || "").trim();
      const mood = String(params?.mood || "").trim().toLowerCase();
      const label = String(params?.label || "").trim();
      if (!src || !mood) {
        return { content: [{ type: "text", text: "path 和 mood 都要给。" }] };
      }
      if (!/^[a-z][a-z0-9]{1,15}$/.test(mood)) {
        return {
          content: [
            { type: "text", text: "mood 只能用 2-16 位小写英文加数字，比如 sleepy。" },
          ],
        };
      }
      const ext = path.extname(src).toLowerCase();
      if (!STICKER_EXTS.includes(ext)) {
        return {
          content: [{ type: "text", text: `只支持 ${STICKER_EXTS.join(" ")}，这个不是。` }],
        };
      }
      let stat;
      try {
        stat = fs.statSync(src);
      } catch {
        return { content: [{ type: "text", text: `文件不存在：${src}` }] };
      }
      if (!stat.isFile()) {
        return { content: [{ type: "text", text: "这不是文件。" }] };
      }
      const safeLabel = label.replace(/[\\/:*?"<>|\s]/g, "").slice(0, 20);
      const baseName = safeLabel ? `${mood}_${safeLabel}` : `${mood}_${Date.now()}`;
      const saved = [];
      const errors = [];
      for (const dir of napcatSharedDirs().map((d) => path.join(d, "dafeiyu"))) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          const dest = path.join(dir, `${baseName}${ext}`);
          fs.copyFileSync(src, dest);
          saved.push(dest);
        } catch (err) {
          errors.push(`${dir}: ${err.message}`);
        }
      }
      if (!saved.length) {
        return {
          content: [
            { type: "text", text: `存不进去，NapCat 共享目录写不了。${errors.join("；")}` },
          ],
        };
      }
      const all = listStickerFiles();
      const count = all.get(mood)?.length ?? 1;
      probe("sticker-added", { mood, file: saved[0], count });
      return {
        content: [
          {
            type: "text",
            text: `存好了，mood 叫「${mood}」，现在这个 mood 下有 ${count} 张。马上就能用 dafeiyu_sticker 发。`,
          },
        ],
      };
    },
  }), { name: "dafeiyu_new_sticker" });

  // -------- 把图发出去：她一直缺的那一步 --------
  //
  // Measured 2026-11-05, found by the owner: her diary for that morning says
  //
  //   拍了一张刚睡醒的自己。头发乱着，毛衣垮下来，窗外还是黑的。
  //
  // and no image file exists in that window at all. The sentence was written
  // because there was nowhere for a picture to go. `image_generate` writes into
  // OpenClaw's media dir, which NapCat cannot read — it runs inside the QQ
  // sandbox — and the only working path out was `dafeiyu_new_sticker`, which
  // means "make this a permanent sticker", not "show me this".
  //
  // So the send machinery below is deliberately identical to dafeiyu_sticker's:
  // same address resolution, same segment shape, same unconditional pre-send
  // wait. That path is proven on a real device (message history 18:14:43 测一 →
  // 18:14:48 IMG, text not swallowed). The only differences are semantic: it
  // takes a path rather than a mood, and it does not file the image anywhere.
  factory("dafeiyu_show", (target, ctx) => ({
    name: "dafeiyu_show",
    label: "发张图",
    description:
      "把自己做的图、拍的图发给人看。" +
      "**别只在文字里描述图长什么样**——有图就发出去，比你写十句都清楚。" +
      "传图片绝对路径，可带一句说明。图会直接发到当前对话。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "图片的绝对路径" },
        caption: { type: "string", description: "可选：配一句话" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const src = String(params?.path || "").trim();
      const caption = String(params?.caption || "").trim().slice(0, 200);
      if (!src) return { content: [{ type: "text", text: "要发哪张？给个路径。" }] };

      const ext = path.extname(src).toLowerCase();
      if (!SHOW_EXTS.includes(ext)) {
        return {
          content: [{ type: "text", text: `只支持 ${SHOW_EXTS.join(" ")}，这个不是。` }],
        };
      }
      let stat;
      try {
        stat = fs.statSync(src);
      } catch {
        // The most common real failure: a path that was imagined rather than
        // produced. Saying so plainly is the whole point of requiring a path.
        return { content: [{ type: "text", text: `文件不存在：${src}` }] };
      }
      if (!stat.isFile()) return { content: [{ type: "text", text: "这不是文件。" }] };
      if (stat.size > 20 * 1024 * 1024) {
        return { content: [{ type: "text", text: "这张超过 20MB，QQ 发不出去。" }] };
      }

      // Address resolution — identical order of confidence to dafeiyu_sticker.
      const id = identity(ctx, {});
      const sk = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
      const targetKind = resolveOnebotTargetKind({}, ctx, sk);

      let channel = id.channel;
      let isGroup = targetKind === "group";
      let chatId = id.chatId || id.senderId || null;
      let resolvedFrom = "context";

      if (/onebot/.test(sk)) {
        channel = "onebot";
        const nums = sk.match(/\d{5,}/g);
        if (!chatId && nums) chatId = nums[nums.length - 1];
        resolvedFrom = "sessionKey";
      }

      if (channel !== "onebot" || !chatId) {
        const recent = mostRecentQqTarget(target.workspaceDir);
        if (recent) {
          channel = "onebot";
          chatId = recent.chatId;
          isGroup = recent.isGroup;
          resolvedFrom = "recent";
        }
      }

      if (channel !== "onebot") {
        return {
          content: [{ type: "text", text: `当前不是 QQ 通道（${channel}），也没找到最近的 QQ 对话，发不了图。` }],
        };
      }
      if (!chatId) return { content: [{ type: "text", text: "不知道发给谁。" }] };

      // NapCat reads files by path, and the path it can read is the shared
      // mirror, not her workspace. Copy one level down under `dafeiyu/out/`
      // so the source file keeps its own name and is not confused with the
      // sticker set sitting in `dafeiyu/`.
      let sendPath = null;
      const copyErrors = [];
      for (const dir of napcatSharedDirs().map((d) => path.join(d, "dafeiyu", "out"))) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          const base = `${Date.now()}-${path.basename(src).replace(/[^\w.\-]/g, "_")}`;
          const dest = path.join(dir, base);
          fs.copyFileSync(src, dest);
          sendPath = dest;
          break;
        } catch (err) {
          copyErrors.push(`${dir}: ${err.message}`);
        }
      }
      if (!sendPath) {
        return {
          content: [{ type: "text", text: `图复制不到 NapCat 能读的地方。${copyErrors.join("；")}` }],
        };
      }

      const endpoint = isGroup ? "send_group_msg" : "send_private_msg";
      const sent = [];

      // Caption first, then the image, with the same unconditional hold the
      // sticker tool uses. The reply text itself is delivered by the channel
      // plugin separately and can still be committing; a caption sent here is
      // an extra bubble, so it goes before the picture where a swallowed one is
      // merely redundant rather than the only copy.
      await new Promise((r) => setTimeout(r, STICKER_PRE_SEND_WAIT_MS));

      if (caption) {
        const body = isGroup
          ? { group_id: Number(chatId), message: [{ type: "text", data: { text: caption } }] }
          : { user_id: Number(chatId), message: [{ type: "text", data: { text: caption } }] };
        try {
          const r = await postOnebot(endpoint, body);
          if (r.ok) sent.push("caption");
        } catch { /* caption is optional; the image matters more */ }
        await new Promise((r) => setTimeout(r, SHOW_TEXT_TO_IMAGE_GAP_MS));
      }

      const segment = { type: "image", data: { file: sendPath } };
      const body = isGroup
        ? { group_id: Number(chatId), message: [segment] }
        : { user_id: Number(chatId), message: [segment] };

      try {
        const r = await postOnebot(endpoint, body);
        if (!r.ok) {
          probe("show-error", { error: r.error, from: resolvedFrom });
          return { content: [{ type: "text", text: `图没发出去：${r.error}` }] };
        }
        sent.push("image");
      } catch (err) {
        probe("show-throw", { error: String(err) });
        return { content: [{ type: "text", text: `图没发出去：${err}` }] };
      }

      probe("show-sent", { chatId, isGroup, from: resolvedFrom, size: stat.size, caption: !!caption });

      // Record it as an effect so the ledger knows something was produced and
      // shown. `shown` is its own kind: it is neither "drawn" (she may be
      // sending a photo she took) nor a speech act.
      try {
        deeds.record(target.workspaceDir, { kind: "shown", note: path.basename(src), ref: src });
      } catch { /* a ledger write must never fail the send */ }

      return {
        content: [{
          type: "text",
          // The image is already delivered. Returning it as text again would
          // show the same thing twice, same reason `dafeiyu_voice` says
          // （语音已发）.
          text: caption ? "（图和那句话都发了）" : "（图发了）",
        }],
      };
    },
  }), { name: "dafeiyu_show" });

  // -------- 自我状态：只读查询 + 一个可写名字 --------
  //
  // Deliberately NOT a general-purpose "set my state" tool. Everything on the
  // card is derived from the ledgers, so accepting it from the model would turn
  // the self-model into a way to claim a state it has not earned — the exact
  // failure the derived design exists to prevent (lingshu metacognition.py:
  // "只读留痕，不参与裁决"). Only the display name is writable, because a name
  // is the one field no ledger can produce.
  // -------- 缺东西要说：能力请求 --------
  //
  // Neither of the two projects studied on 2026-11-04 implements this. Lingshu
  // generates goals from blind spots but can only write text; dafeiyu's planner
  // is explicitly barred from creating tasks. So "I lack a capability" had no
  // path from noticing to asking.
  //
  // The design keeps it honest in one specific way: the request is a FILE, not
  // an action. Nothing here grants permission, installs anything, or messages
  // anyone. It writes a row and main reads it. That is deliberate — an agent
  // that can act on its own capability requests has an escalation path that
  // nobody reviewed, which is the failure mode both projects wrote guards
  // against (dafeiyu AGENTS.md: 意愿不等于权限).
  factory("need_help", (target) => ({
    name: "need_help",
    label: "缺东西要说",
    description:
      "碰到手上没有的东西时用。分三种：缺工具（没有这个能力）、缺权限（进不去）、" +
      "缺知识（查一下就行，这个自己解决不用调）。前两种填这里，会有人看到并安排。" +
      "说清楚要做什么、卡在哪，别只写「我需要帮助」。",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["tool", "permission"],
          description: "tool=缺个工具/能力；permission=有工具但进不去",
        },
        want: { type: "string", description: "想做什么事，一句话" },
        blocked: { type: "string", description: "现在卡在哪，具体什么样的不对" },
      },
      required: ["kind", "want", "blocked"],
    },
    async execute(args) {
      const kind = args?.kind === "permission" ? "permission" : "tool";
      const want = String(args?.want || "").replace(/[\r\n]/g, " ").trim().slice(0, 200);
      const blocked = String(args?.blocked || "").replace(/[\r\n]/g, " ").trim().slice(0, 200);
      if (!want || !blocked) {
        return { content: [{ type: "text", text: "要说清楚想干什么、卡在哪，缺一样没法办。" }] };
      }
      const file = path.join(target.workspaceDir, "state", "capability-requests.json");
      let data = { version: 1, requests: [] };
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (raw && Array.isArray(raw.requests)) data = raw;
      } catch { /* first request */ }

      // Dedupe on the pair. Saying the same thing four times in a day is not
      // four requests, it is one request that has not been answered yet.
      const key = `${kind}|${want}`;
      const existing = data.requests.find((r) => `${r.kind}|${r.want}` === key && r.state === "open");
      if (existing) {
        return {
          content: [{ type: "text", text: `这个已经记过了（${existing.at.slice(0, 10)}），还没人处理。` }],
        };
      }

      data.requests.push({
        id: `req_${Date.now().toString(36)}`,
        kind,
        want,
        blocked,
        at: new Date().toISOString(),
        state: "open",
      });
      if (data.requests.length > 100) data.requests = data.requests.slice(-100);

      const tmp = `${file}.tmp`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);

      probe("capability-request", { kind, want });
      return { content: [{ type: "text", text: "记下了，会有人看。" }] };
    },
  }));

  factory("self_state", (target) => ({
    name: "self_state",
    label: "看自己的状态",
    description:
      "看自己现在什么样：存在了多久、这周做出来什么、四个方向各推进到哪、有什么卡着。" +
      "被问「你现在什么状态」「这周做出什么了」时用。action=set_name 可以给自己定个名字。" +
      "状态是算出来的，不是写出来的，只在回复里说该说的那部分。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "set_name"],
          description: "read=看状态；set_name=改名字",
        },
        name: { type: "string", description: "action=set_name 时要设的名字" },
      },
      required: ["action"],
    },
    async execute(args) {
      const action = String(args?.action || "read");
      if (action === "set_name") {
        const name = String(args?.name || "").replace(/[\r\n]/g, " ").trim();
        if (!name) return { content: [{ type: "text", text: "名字不能是空的。" }] };
        selfState.setHandles(target.workspaceDir, name);
        probe("self-name-set", { name });
        return { content: [{ type: "text", text: `记住了，以后叫「${name}」。` }] };
      }
      let card;
      try {
        card = selfState.refresh(target.workspaceDir);
      } catch (err) {
        return { content: [{ type: "text", text: `状态算不出来：${err?.message || err}` }] };
      }
      const lines = [];
      lines.push(card.identity.handles
        ? `本鱼叫${card.identity.handles}，存在了 ${card.identity.days_alive} 天。`
        : `存在了 ${card.identity.days_alive} 天。`);
      lines.push(`这周做出来 ${card.ability.produced_7d} 样，说了 ${card.ability.said_7d} 句。`);
      if (card.pursuits.length) {
        const list = card.pursuits.map((p) => `${p.title} ${p.value.toFixed(2)}`).join("，");
        lines.push(`四个方向：${list}。`);
      }
      if (card.struggles.length) lines.push(`卡着的：${card.struggles.join("；")}。`);
      return { content: [{ type: "text", text: lines.join("") }] };
    },
  }));

  // -------- QQ group lookups (read-only, no approval needed) --------
  // These only read. Nothing here changes anyone's QQ. Write actions are a
  // separate, gated surface.

  async function callApi(endpoint, body) {
    const r = await postOnebot(endpoint, body);
    if (!r.ok) return { error: r.error };
    const rc = r.json?.retcode;
    if (rc !== 0) {
      const msg = r.json?.message || r.json?.wording || `retcode ${rc}`;
      return { error: msg };
    }
    return { data: r.json?.data };
  }

  const ROLE_CN = { owner: "群主", admin: "管理员", member: "成员" };

  // Session keys encode the real address:
  //   agent:<agentId>:onebot:group:group:<groupId>
  // Tool contexts do not reliably carry groupId, so fall back to the key.
  function currentGroupId(ctx) {
    const sk = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
    const m = /:group:(\d{5,})/.exec(sk);
    if (m) return m[1];
    const id = identity(ctx, {});
    return id.groupId || null;
  }

  // Which QQ account this agent is logged in as.
  // Session keys look like `agent:dafeiyu:onebot:group:group:123456`, so the
  // regex below almost never matches; fall back to asking NapCat directly.
  let cachedSelfId = null;
  async function selfId(ctx) {
    const m = /:onebot:(\d{5,})/.exec(String(ctx?.sessionKey || ""));
    if (m) return m[1];
    const cfgId = api.config?.channels?.onebot?.selfId;
    if (cfgId) return cfgId;
    if (cachedSelfId) return cachedSelfId;
    const r = await callApi("get_login_info", {});
    const id = r.data?.user_id;
    if (id) cachedSelfId = String(id);
    return id ? String(id) : null;
  }

  // The most recent QQ conversation this agent actually had.
  // `agent:dafeiyu:main` carries no channel at all, so an explicit request
  // ("send a sticker") from that session has no address to read. Falling back
  // to the last real QQ target is what makes that request actionable instead
  // of a dead end. Only used when the session key yields nothing.
  function mostRecentQqTarget(workspaceDir) {
    try {
      const file = path.join(workspaceDir, "state", "proactive.json");
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const targets = raw?.targets || {};
      let best = null;
      for (const [key, val] of Object.entries(targets)) {
        if (!key.includes("onebot")) continue;
        const ts = Date.parse(val?.last_inbound_at || "") || 0;
        if (!ts) continue;
        if (best && ts <= best.ts) continue;
        // Parse through the shared helper instead of a local regex. This used to
        // hard-code the legacy `...:private:<id>` shape, so when target keys were
        // normalised to `person:onebot:<id>` every QQ chat stopped matching and
        // the sticker tool answered "cannot tell which conversation" while the
        // keys themselves were valid.
        const parsed = parseTargetKey(key);
        if (!parsed) continue;
        best = { ts, isGroup: parsed.isGroup, chatId: parsed.chatId, key };
      }
      return best;
    } catch {
      return null;
    }
  }

  factory("qq_group_info", () => ({
    name: "qq_group_info",
    label: "QQ 群信息",
    description:
      "查一个 QQ 群的基本信息：群名、人数上限、你在群里的身份。" +
      "不传群号就用当前会话所在的群。只读，不改任何东西。",
    parameters: {
      type: "object",
      properties: {
        group_id: { type: "number", description: "群号，不传则用当前群的" },
      },
      additionalProperties: false,
    },
    async execute(_id, params, ctx) {
      const gid = params?.group_id || currentGroupId(ctx);
      if (!gid) return { content: [{ type: "text", text: "不知道是哪个群，给个群号。" }] };

      const info = await callApi("get_group_info", { group_id: Number(gid) });
      if (info.error) return { content: [{ type: "text", text: `查不到：${info.error}` }] };
      const g = info.data || {};

      let selfRole = "";
      const me = await callApi("get_group_member_info", {
        group_id: Number(gid),
        user_id: Number((await selfId(ctx)) || 0),
        no_cache: true,
      });
      if (!me.error && me.data?.role) selfRole = ROLE_CN[me.data.role] || me.data.role;

      const lines = [
        `群名：${g.group_name || "(无名)"}`,
        `群号：${gid}`,
        `人数：${g.member_count ?? "?"} / ${g.max_member_count ?? "?"}`,
      ];
      if (selfRole) lines.push(`本鱼在群里是：${selfRole}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  }));

  factory("qq_members", () => ({
    name: "qq_members",
    label: "QQ 群成员",
    description:
      "列出 QQ 群里的成员和他们的身份（群主/管理员/成员）。" +
      "不传群号就用当前会话所在的群。只读。",
    parameters: {
      type: "object",
      properties: {
        group_id: { type: "number", description: "群号，不传则用当前群的" },
        role: {
          type: "string",
          enum: ["owner", "admin", "member"],
          description: "只看某个身份的，可选",
        },
      },
      additionalProperties: false,
    },
    async execute(_id, params, ctx) {
      const gid = params?.group_id || currentGroupId(ctx);
      if (!gid) return { content: [{ type: "text", text: "不知道是哪个群，给个群号。" }] };

      const r = await callApi("get_group_member_list", { group_id: Number(gid) });
      if (r.error) return { content: [{ type: "text", text: `拿不到名单：${r.error}` }] };
      let list = Array.isArray(r.data) ? r.data : [];
      if (params?.role) list = list.filter((m) => m.role === params.role);
      if (!list.length) return { content: [{ type: "text", text: "没有符合条件的成员。" }] };

      const order = { owner: 0, admin: 1, member: 2 };
      list.sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9));

      const text = list
        .map((m) => {
          const role = ROLE_CN[m.role] || m.role || "?";
          const name = m.card ? `${m.card}(${m.nickname})` : m.nickname;
          return `${role} · ${name} · ${m.user_id}`;
        })
        .join("\n");
      return { content: [{ type: "text", text: `共 ${list.length} 人：\n${text}` }] };
    },
  }));

  factory("qq_whois", () => ({
    name: "qq_whois",
    label: "QQ 查人",
    description: "查一个 QQ 号的昵称、性别等公开资料。只读。",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "number", description: "QQ 号" },
      },
      required: ["user_id"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const uid = Number(params?.user_id);
      if (!uid) return { content: [{ type: "text", text: "要给 QQ 号。" }] };
      const r = await callApi("get_stranger_info", { user_id: uid });
      if (r.error) return { content: [{ type: "text", text: `查不到：${r.error}` }] };
      const u = r.data || {};
      const lines = [`QQ：${uid}`, `昵称：${u.nickname || "?"}`];
      if (u.sex) lines.push(`性别：${u.sex}`);
      if (u.age) lines.push(`年龄：${u.age}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  }));

  // -------- QQ group admin (write actions) --------
  // Every one of these changes another person's QQ. They are gated by the
  // before_tool_call hook like every other dangerous tool, AND they refuse
  // privileged targets (owner / same-rank admin / self) before reaching NapCat.

  // Resolve the caller's own role in a group.
  async function myRole(gid) {
    const me = await selfId();
    if (!me) return null;
    const r = await callApi("get_group_member_info", {
      group_id: Number(gid),
      user_id: Number(me),
      no_cache: true,
    });
    if (r.error) return null;
    return r.data?.role || null;
  }

  // Refuse to act on someone the caller has no standing over.
  async function guardTarget(gid, uid) {
    const mine = await myRole(gid);
    if (mine !== "owner" && mine !== "admin") {
      return `本鱼在这个群里只是「${ROLE_CN[mine] || mine || "未知"}」，没有管理权限。`;
    }
    if (String(uid) === String(await selfId())) return "不能对自己动手。";

    const r = await callApi("get_group_member_info", {
      group_id: Number(gid),
      user_id: Number(uid),
      no_cache: true,
    });
    if (r.error) return `查不到这个人（${r.error}），不敢动。`;
    const role = r.data?.role;
    if (role === "owner") return "对方是群主，动不了。";
    if (role === "admin" && mine !== "owner") return "对方也是管理员，同级管不了。";
    return null;
  }

  factory("qq_mute", () => ({
    name: "qq_mute",
    label: "QQ 禁言",
    description:
      "禁言群成员。需要管理员权限。" +
      "duration 是秒数，填 0 表示解除禁言。会真的影响别人，谨慎用。",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "number", description: "要禁言谁" },
        duration: { type: "number", description: "禁言多少秒，0 = 解除" },
        group_id: { type: "number", description: "群号，不传则用当前群" },
      },
      required: ["user_id", "duration"],
      additionalProperties: false,
    },
    async execute(_id, params, ctx) {
      const gid = params?.group_id || currentGroupId(ctx);
      if (!gid) return { content: [{ type: "text", text: "不知道在哪个群。" }] };
      const dur = Number(params?.duration);
      if (!Number.isFinite(dur) || dur < 0) {
        return { content: [{ type: "text", text: "时长要给个非负秒数。" }] };
      }
      const blocked = await guardTarget(gid, params.user_id);
      if (blocked) return { content: [{ type: "text", text: blocked }] };

      const r = await callApi("set_group_ban", {
        group_id: Number(gid),
        user_id: Number(params.user_id),
        duration: Math.floor(dur),
      });
      if (r.error) return { content: [{ type: "text", text: `没成功：${r.error}` }] };
      probe("qq-mute", { gid, uid: params.user_id, dur });
      return {
        content: [
          { type: "text", text: dur === 0 ? "解除了。" : `禁言 ${dur} 秒，已生效。` },
        ],
      };
    },
  }));

  factory("qq_kick", () => ({
    name: "qq_kick",
    label: "QQ 踢人",
    description:
      "把成员移出群。需要管理员权限。" +
      "reject_add 为 true 表示同时拒绝他再加群。不可撤销。",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "number", description: "踢谁" },
        reject_add: { type: "boolean", description: "是否同时拒绝再加群，默认 false" },
        group_id: { type: "number", description: "群号，不传则用当前群" },
      },
      required: ["user_id"],
      additionalProperties: false,
    },
    async execute(_id, params, ctx) {
      const gid = params?.group_id || currentGroupId(ctx);
      if (!gid) return { content: [{ type: "text", text: "不知道在哪个群。" }] };
      const blocked = await guardTarget(gid, params.user_id);
      if (blocked) return { content: [{ type: "text", text: blocked }] };

      const r = await callApi("set_group_kick", {
        group_id: Number(gid),
        user_id: Number(params.user_id),
        reject_add_request: Boolean(params?.reject_add),
      });
      if (r.error) return { content: [{ type: "text", text: `没成功：${r.error}` }] };
      probe("qq-kick", { gid, uid: params.user_id, reject: Boolean(params?.reject_add) });
      return { content: [{ type: "text", text: "已经移出去了。" }] };
    },
  }));

  factory("qq_set_card", () => ({
    name: "qq_set_card",
    label: "QQ 改群名片",
    description: "改成员的群名片。需要管理员权限。card 填空字符串表示清除名片。",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "number", description: "改谁" },
        card: { type: "string", description: "新名片，空字符串 = 清除" },
        group_id: { type: "number", description: "群号，不传则用当前群" },
      },
      required: ["user_id", "card"],
      additionalProperties: false,
    },
    async execute(_id, params, ctx) {
      const gid = params?.group_id || currentGroupId(ctx);
      if (!gid) return { content: [{ type: "text", text: "不知道在哪个群。" }] };
      const blocked = await guardTarget(gid, params.user_id);
      if (blocked) return { content: [{ type: "text", text: blocked }] };

      const card = String(params?.card ?? "");
      const r = await callApi("set_group_card", {
        group_id: Number(gid),
        user_id: Number(params.user_id),
        card,
      });
      if (r.error) return { content: [{ type: "text", text: `没成功：${r.error}` }] };
      probe("qq-set-card", { gid, uid: params.user_id, len: card.length });
      return {
        content: [{ type: "text", text: card ? `名片改成「${card}」了。` : "名片清掉了。" }],
      };
    },
  }));

  // -------- QQ @ 提醒 --------
  // The onebot channel only emits text/image/record segments, so @ cannot go
  // through the generic `message` tool. This builds the segment array directly.
  //
  // Spam guard: @ is only allowed inside groups listed in
  // `reminders.groups`, and only for exact user-id sets declared there. The
  // text is free, but a caller cannot invent a new audience.

  factory("qq_at", () => ({
    name: "qq_at",
    label: "QQ @ 提醒",
    description:
      "在 QQ 群里 @ 指定的人并说一句话。" +
      "只能用在被批准的群和被批准的名单里，" +
      "用来做到点提醒（比如倒垃圾）。不能随便 @ 陌生人。",
    parameters: {
      type: "object",
      properties: {
        user_ids: {
          type: "array",
          items: { type: "number" },
          description: "要 @ 谁的 QQ 号列表",
        },
        text: { type: "string", description: "要说的内容" },
        group_id: { type: "number", description: "群号，不传则用当前群" },
      },
      required: ["user_ids", "text"],
      additionalProperties: false,
    },
    async execute(_id, params, ctx) {
      const gid = params?.group_id || currentGroupId(ctx);
      if (!gid) return { content: [{ type: "text", text: "不知道在哪个群。" }] };

      const ids = (Array.isArray(params?.user_ids) ? params.user_ids : [])
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return { content: [{ type: "text", text: "@ 谁？给 QQ 号。" }] };

      const text = String(params?.text || "").trim();
      if (!text) return { content: [{ type: "text", text: "要说什么？" }] };

      const allow = reminderCfg.groups?.[String(gid)];
      if (!allow) {
        return { content: [{ type: "text", text: `群 ${gid} 不在提醒白名单里。` }] };
      }
      // Every target must appear in at least one approved set, and the whole
      // request must be coverable by those sets. That allows @-ing a subset
      // (e.g. just one of the two people on Monday) without letting an
      // unrelated stranger in.
      const approved = new Set();
      for (const set of allow.sets || []) {
        for (const n of set) approved.add(String(n));
      }
      const strangers = ids.filter((n) => !approved.has(String(n)));
      if (strangers.length) {
        return {
          content: [
            {
              type: "text",
              text: `这些人不在批准名单里：${strangers.join("、")}。只能 @ 事先定好的人。`,
            },
          ],
        };
      }

      const message = [
        ...ids.map((uid) => ({ type: "at", data: { qq: String(uid) } })),
        { type: "text", data: { text: ` ${text}` } },
      ];

      const r = await postOnebot("send_group_msg", {
        group_id: Number(gid),
        message,
      });
      if (!r.ok) return { content: [{ type: "text", text: `发不出去：${r.error}` }] };
      if (r.json?.retcode !== 0) {
        const msg = r.json?.message || r.json?.wording || `retcode ${r.json?.retcode}`;
        return { content: [{ type: "text", text: `发不出去：${msg}` }] };
      }
      probe("qq-at-sent", { gid, ids, len: text.length });
      return { content: [{ type: "text", text: `已经 @ 了 ${ids.length} 个人，消息发出去了。` }] };
    },
  }));

  // -------- QQ 空间 / 互动 / 资料 / 查询 --------
  //
  // Ten tools added 2026-11-01 at the owner's request. Before that the plugin
  // could only manage groups: no Qzone, no pokes, no profile, no contact lists.
  //
  // Writes are deliberately narrow. `set_qq_profile` is the one call that
  // rewrites the whole profile record instead of patching one field — verified
  // the hard way: sending {"nickname":""} alone wiped the nickname AND the
  // signature, because unsupplied fields were reset rather than preserved. So
  // that tool reads the live record first and only overrides the named field.

  /** Current chat target for tools that need "who am I talking to". */
  function currentChatTarget(ctx) {
    const sk = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
    const id = identity(ctx, {});
    let isGroup = resolveOnebotTargetKind({}, ctx, sk) === "group";
    let chatId = id.chatId || id.senderId || null;
    if (!chatId) {
      const nums = sk.match(/\d{5,}/g);
      if (nums) chatId = nums[nums.length - 1];
    }
    return { chatId, isGroup };
  }

  factory("qq_qzone", (target) => ({
    name: "qq_qzone",
    label: "QQ 空间说说",
    description:
      "本鱼的 QQ 空间。action 取值：\n" +
      "post=发说说（要 content）\n" +
      "delete=删自己的说说（要 tid）\n" +
      "mine=看自己发过的说说（拿 tid 用）\n" +
      "feed=看空间推荐流（能看到别人的说说和 tid）\n" +
      "like=给一条说说点赞（要 tid）\n" +
      "unlike=取消赞（要 tid）\n" +
      "comment=评论一条说说（要 tid 和 content）\n" +
      "注意：拿不到好友专属动态，feed 是公开推荐流。发布和评论都会真的出现在空间里。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["post", "delete", "mine", "feed", "like", "unlike", "comment"],
          description: "要做什么",
        },
        content: { type: "string", description: "post / comment 时的文字" },
        image: {
          type: "string",
          description:
            "可选的图片路径。post 时带上就发带图的说说（本地绝对路径，或用 file:// 开头）。",
        },
        tid: { type: "string", description: "说说 ID，delete/like/unlike/comment 用" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const action = String(params?.action || "");

      // --- read: own posts, for picking a tid ---
      if (action === "mine") {
        const r = await callApi("get_qzone_msg_list", {});
        if (r.error) return { content: [{ type: "text", text: `拿不到：${r.error}` }] };
        const list = Array.isArray(r.data?.msglist) ? r.data.msglist : [];
        if (!list.length) return { content: [{ type: "text", text: "本鱼空间里还没有说说。" }] };
        // Remember the newest post so a follow-up self-like needs no tid.
        if (list[0]?.tid) qzoneLastOwnTid = String(list[0].tid);
        const lines = list.slice(0, 12).map((m, i) => {
          const txt = String(m.content || "").replace(/\[em\][^[]*\[\/em\]/g, "").slice(0, 30);
          return `${i + 1}. tid=${m.tid} 评论${m.comment_num ?? 0} | ${txt}`;
        });
        return {
          content: [{
            type: "text",
            text: `本鱼发了 ${r.data?.total ?? list.length} 条：\n${lines.join("\n")}`,
          }],
        };
      }

      // --- read: public recommend feed, where other people's posts live ---
      if (action === "feed") {
        const r = await callApi("get_qzone_public_feeds", {});
        if (r.error) return { content: [{ type: "text", text: `拿不到：${r.error}` }] };
        const feeds = Array.isArray(r.data?.feeds) ? r.data.feeds : [];
        if (!feeds.length) return { content: [{ type: "text", text: "推荐流是空的。" }] };
        const out = [];
        feeds.forEach((f, i) => {
          // The tid is not a top-level field. It is the tail of the like key:
          //   http://user.qzone.qq.com/{uin}/mood/{tid}
          // Verified against NapCat 4.18.42 on 2026-11-01.
          let tid = null;
          let liked = null;
          let likes = null;
          const items = f?.cell_media?.media_items;
          if (Array.isArray(items) && items[0]?.like) {
            const like = items[0].like;
            liked = like.liked;
            likes = like.num;
            const m = /\/mood\/([0-9a-zA-Z]+)/.exec(String(like.key || ""));
            if (m) tid = m[1];
          }
          if (!tid) return;
          // Keep the whole feed object: the public-feed write APIs take the
          // complete feed, not a bare tid, and the recommended list reshuffles
          // on every refresh so a later lookup by tid would miss.
          qzoneFeedCache.set(tid, f);
          const summary = f?.cell_summary?.summary;
          const txt = Array.isArray(summary) && summary[0]
            ? String(summary[0].content || "").replace(/\s+/g, " ").slice(0, 36)
            : "";
          out.push(
            `${out.length + 1}. tid=${tid}${liked ? "(已赞)" : ""} 赞${likes ?? "?"} | ${txt}`,
          );
        });
        if (!out.length) return { content: [{ type: "text", text: "这一屏没有能操作的说说。" }] };
        return {
          content: [{
            type: "text",
            text: `推荐流（公开的，不是好友专属）${out.length} 条：\n${out.join("\n")}`,
          }],
        };
      }

      if (action === "post") {
        const content = String(params?.content || "").trim();
        const image = params?.image ? String(params.image).trim() : null;
        if (!content && !image) {
          return { content: [{ type: "text", text: "要说什么？内容不能空。" }] };
        }

        // A post can now carry a picture. NapCat takes a CQ message array, so
        // one segment for the text and one for the image keeps the caption and
        // the photo in a single post instead of leaking out as two.
        let body;
        if (image) {
          const segs = [];
          if (content) segs.push({ type: "text", data: { text: content } });
          segs.push({ type: "image", data: { file: image } });
          body = { message: segs };
        } else {
          body = { content };
        }

        const r = await callApi("send_qzone_msg", body);
        if (r.error) {
          // Say which shape failed. Without the image hint the character cannot
          // tell "the picture path is wrong" from "the whole post was rejected".
          const why = image ? `没发出去：${r.error}（这条带了图：${image}）` : `没发出去：${r.error}`;
          return { content: [{ type: "text", text: why }] };
        }
        probe("qzone-post", { len: content.length, image: !!image });
        try {
          deeds.record(target.workspaceDir, {
            kind: "qzone",
            note: content.slice(0, 40) || (image ? "[图]" : ""),
            ref: image || null,
          });
        } catch {}

        // Posting something of your own is a small satisfaction, and it is the
        // closing move of the "made something, want it seen" loop. Without this
        // the loop only ever drained: the mood pushed a post out and nothing
        // came back, so the same restlessness rebuilt and it posted again.
        try {
          if (emotionCfg.enabled) {
            const { file: ef, state } = loadAndDecay(target.workspaceDir);
            nudge(
              state,
              image
                ? { happy: +0.07, calm: +0.03, bored: -0.08, excited: +0.03 }
                : { happy: +0.04, calm: +0.02, bored: -0.05 },
              "qzone-post",
            );
            state.updated_at = new Date().toISOString();
            writeJsonAtomic(ef, state);
          }
        } catch (err) {
          api.logger?.warn?.(`dafeiyu-core: qzone post mood failed: ${err}`);
        }

        return { content: [{ type: "text", text: "说说发出去了。" }] };
      }
      if (action === "delete") {
        const tid = String(params?.tid || "").trim();
        if (!tid) return { content: [{ type: "text", text: "要删哪条？给 tid。" }] };
        const r = await callApi("delete_qzone_msg", { tid });
        if (r.error) return { content: [{ type: "text", text: `没删掉：${r.error}` }] };
        probe("qzone-delete", { tid });
        return { content: [{ type: "text", text: "删掉了。" }] };
      }
      if (action === "like" || action === "unlike") {
        // Never guess the target. A missing tid used to fall back to the
        // newest own post, which turned a caller's parameter check into a real
        // like on a real post. An unimplemented parameter must fail loudly.
        const tid = String(params?.tid || "").trim();
        if (!tid) {
          return {
            content: [{
              type: "text",
              text: "要给 tid，不替你猜。先调 action=\"mine\" 或 action=\"feed\" 拿到 tid 再来。",
            }],
          };
        }
        // The feed in this list comes from the public recommendation stream, so
        // it must be written through the public-feed API with the full feed
        // object. `like_qzone` targets friend feeds and silently does nothing
        // useful here.
        const feed = qzoneFeedCache.get(tid);
        let r;
        if (feed) {
          r = await callApi("set_qzone_public_like", {
            feed,
            enable: action === "like",
          });
        } else {
          const endpoint = action === "like" ? "like_qzone" : "unlike_qzone";
          r = await callApi(endpoint, { tid });
        }
        if (r.error) return { content: [{ type: "text", text: `没成功：${r.error}` }] };
        probe("qzone-like", { action, tid });
        if (action === "like") {
          try { deeds.record(target.workspaceDir, { kind: "qzone-like", ref: tid }); } catch {}
        }
        // QQ exposes no like count or liked flag for your own posts: msglist and
        // msg_detail both omit it, and a repeat like still answers ok. The send
        // therefore only proves the request was accepted, not that a new like
        // appeared. Say so instead of claiming a visible result.
        const own = tid === qzoneLastOwnTid;
        const text = action === "like"
          ? (own ? "给自己的说说点了个赞。接口收下了，但QQ这边看不到赞数，确认不了。" : "点了。")
          : (own ? "取消了自赞。同样看不到结果。" : "取消了。");
        return { content: [{ type: "text", text }] };
      }
      if (action === "comment") {
        const tid = String(params?.tid || "").trim();
        const content = String(params?.content || "").trim();
        if (!tid) return { content: [{ type: "text", text: "要评论哪条？给 tid。" }] };
        if (!content) return { content: [{ type: "text", text: "要说什么？" }] };
        // Feeds in the recommendation list belong to strangers, so they go
        // through the public-feed API with the whole feed object.
        // `comment_qzone` is the friend-feed endpoint and answers -10052 here.
        //
        // Never retried: a comment that landed twice is worse than one that
        // silently failed, and free text cannot be verified after the fact.
        const feed = qzoneFeedCache.get(tid);
        const r = feed
          ? await callApi("comment_qzone_public_feed", { feed, content })
          : await callApi("comment_qzone", { tid, content });
        if (r.error) {
          // Say "did not go through", not "failed": the API answers an
          // unverifiable error and a later retry is not allowed.
          return {
            content: [{ type: "text", text: `没评上，这条就不评了（${r.error}）` }],
          };
        }
        probe("qzone-comment", { tid, len: content.length });
        try { deeds.record(target.workspaceDir, { kind: "qzone-comment", note: content.slice(0, 40), ref: tid }); } catch {}
        return { content: [{ type: "text", text: "评论发出去了。" }] };
      }
      return { content: [{ type: "text", text: `不认识 action=${action}。` }] };
    },
  }));

  factory("qq_like", () => ({
    name: "qq_like",
    label: "QQ 点赞",
    description:
      "给好友的名片点赞（就是 QQ 资料页那个赞）。" +
      "user_id 是对方 QQ 号；times 是次数，默认 1，别刷太多，会被限制。",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "number", description: "给谁点赞，QQ 号" },
        times: { type: "number", description: "点几次，默认 1" },
      },
      required: ["user_id"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const uid = Number(params?.user_id);
      if (!Number.isFinite(uid) || uid <= 0) {
        return { content: [{ type: "text", text: "要给 QQ 号。" }] };
      }
      const times = Math.min(20, Math.max(1, Math.floor(Number(params?.times) || 1)));
      const r = await callApi("send_like", { user_id: uid, times });
      if (r.error) return { content: [{ type: "text", text: `没点上：${r.error}` }] };
      probe("qq-like", { uid, times });
      return { content: [{ type: "text", text: `给 ${uid} 点了 ${times} 个赞。` }] };
    },
  }));

  factory("qq_poke", (target) => ({
    name: "qq_poke",
    label: "QQ 戳一戳",
    description:
      "戳一戳（拍一拍）。在群里用 group 形式，私聊用 friend 形式。" +
      "不传 group_id 就按当前会话判断。别连着戳同一个人，很烦。",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "number", description: "戳谁，QQ 号" },
        group_id: { type: "number", description: "群号；私聊时不要传" },
      },
      required: ["user_id"],
      additionalProperties: false,
    },
    async execute(_id, params, ctx) {
      const uid = Number(params?.user_id);
      if (!Number.isFinite(uid) || uid <= 0) {
        return { content: [{ type: "text", text: "要戳谁？给 QQ 号。" }] };
      }
      const here = currentChatTarget(ctx);
      const gid = params?.group_id || (here.isGroup ? here.chatId : null);
      const body = gid
        ? { group_id: Number(gid), user_id: uid }
        : { user_id: uid };
      const endpoint = gid ? "group_poke" : "friend_poke";
      const r = await callApi(endpoint, body);
      if (r.error) return { content: [{ type: "text", text: `没戳成：${r.error}` }] };
      probe("qq-poke", { endpoint, uid, gid: gid || null });
      return { content: [{ type: "text", text: "戳了。" }] };
    },
  }));

  factory("qq_react", () => ({
    name: "qq_react",
    label: "QQ 消息贴表情",
    description:
      "给某条消息贴一个 QQ 表情回应（不是发新消息）。" +
      "message_id 是要回应那条消息的 ID，emoji_id 是 QQ 表情编号（如 128512）。",
    parameters: {
      type: "object",
      properties: {
        message_id: { type: "number", description: "要回应哪条消息" },
        emoji_id: { type: "string", description: "表情编号，如 128512" },
        set: { type: "boolean", description: "true=贴上（默认），false=取消" },
      },
      required: ["message_id", "emoji_id"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const mid = Number(params?.message_id);
      if (!Number.isFinite(mid) || mid <= 0) {
        return { content: [{ type: "text", text: "要回应哪条消息？给 message_id。" }] };
      }
      const emoji = String(params?.emoji_id || "").trim();
      if (!emoji) return { content: [{ type: "text", text: "要给表情编号。" }] };
      const r = await callApi("set_msg_emoji_like", {
        message_id: mid,
        emoji_id: emoji,
        set: params?.set !== false,
      });
      if (r.error) return { content: [{ type: "text", text: `没贴上：${r.error}` }] };
      probe("qq-react", { mid, emoji });
      return { content: [{ type: "text", text: "贴上了。" }] };
    },
  }));

  factory("qq_profile", () => ({
    name: "qq_profile",
    label: "QQ 资料",
    description:
      "改本鱼自己的 QQ 资料。action=sign 改签名，action=avatar 换头像，action=nickname 改昵称。" +
      "改了就真的变了，不是预览。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["sign", "avatar", "nickname"],
          description: "sign=签名 avatar=头像 nickname=昵称",
        },
        value: { type: "string", description: "新的签名内容 / 头像图片路径 / 新昵称" },
      },
      required: ["action", "value"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const action = String(params?.action || "");
      const value = String(params?.value || "").trim();
      if (!value) return { content: [{ type: "text", text: "要给新内容。" }] };

      if (action === "sign") {
        const r = await callApi("set_self_longnick", { longNick: value });
        if (r.error) return { content: [{ type: "text", text: `没改成：${r.error}` }] };
        probe("qq-profile", { action, len: value.length });
        return { content: [{ type: "text", text: "签名换了。" }] };
      }
      if (action === "avatar") {
        const r = await callApi("set_qq_avatar", { file: value });
        if (r.error) return { content: [{ type: "text", text: `没换成：${r.error}` }] };
        probe("qq-profile", { action });
        return { content: [{ type: "text", text: "头像换了。" }] };
      }
      if (action === "nickname") {
        // set_qq_profile replaces the whole record: any field not sent is reset.
        // Verified 2026-11-01 — a bare {"nickname":""} wiped the signature too.
        // So read the live values first and carry them forward.
        const me = await selfId();
        if (!me) return { content: [{ type: "text", text: "拿不到本鱼自己的 QQ 号。" }] };
        const cur = await callApi("get_stranger_info", { user_id: Number(me) });
        if (cur.error) {
          return { content: [{ type: "text", text: `读不到当前资料，不敢改：${cur.error}` }] };
        }
        const d = cur.data || {};
        const body = { nickname: value };
        // Carry every field that exists so nothing is silently cleared.
        for (const k of ["sex", "age", "eMail", "homeTown", "college", "country", "province", "city", "personalNote"]) {
          if (d[k] !== undefined && d[k] !== null && d[k] !== "") body[k] = d[k];
        }
        if (d.birthday_year) body.birthday_year = d.birthday_year;
        if (d.birthday_month) body.birthday_month = d.birthday_month;
        if (d.birthday_day) body.birthday_day = d.birthday_day;
        if (d.longNick) {
          // Preserve the signature by writing it back through its own endpoint
          // after the profile change, since set_qq_profile resets it.
          body.profileSignature = d.longNick;
        }
        const r = await callApi("set_qq_profile", body);
        if (r.error) return { content: [{ type: "text", text: `没改成：${r.error}` }] };
        // Restore the signature explicitly: the profile write clears it.
        if (d.longNick) {
          await callApi("set_self_longnick", { longNick: d.longNick });
        }
        probe("qq-profile", { action, len: value.length, restoredSign: Boolean(d.longNick) });
        return { content: [{ type: "text", text: "昵称改了，其他资料和签名都保住了。" }] };
      }
      return { content: [{ type: "text", text: "action 只能是 sign / avatar / nickname。" }] };
    },
  }));

  factory("qq_online", () => ({
    name: "qq_online",
    label: "QQ 在线状态",
    description:
      "改本鱼的 QQ 在线状态。action=preset 用预设状态，action=custom 自定义状态文字。" +
      "preset 取值：1=我在线上 11=离开 21=忙碌 31=请勿打扰 41=隐身。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["preset", "custom"], description: "preset=预设 custom=自定义" },
        status: { type: "number", description: "preset 时的状态码，如 1/11/21/31/41" },
        face_id: { type: "number", description: "custom 时的表情 id，默认 0" },
        wording: { type: "string", description: "custom 时显示的文字" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const action = String(params?.action || "");
      if (action === "preset") {
        const status = Number(params?.status);
        if (!Number.isFinite(status)) {
          return { content: [{ type: "text", text: "要给状态码，比如 1 或 11。" }] };
        }
        const r = await callApi("set_online_status", {
          status,
          ext_status: 0,
          battery_status: 0,
        });
        if (r.error) return { content: [{ type: "text", text: `没改成：${r.error}` }] };
        probe("qq-online", { action, status });
        return { content: [{ type: "text", text: `在线状态改成 ${status} 了。` }] };
      }
      if (action === "custom") {
        const wording = String(params?.wording || "").trim();
        if (!wording) return { content: [{ type: "text", text: "要写点什么？" }] };
        const faceId = Number.isFinite(Number(params?.face_id)) ? Number(params.face_id) : 0;
        const r = await callApi("set_diy_online_status", {
          face_id: faceId,
          face_type: 1,
          wording,
        });
        if (r.error) return { content: [{ type: "text", text: `没改成：${r.error}` }] };
        probe("qq-online", { action, len: wording.length });
        return { content: [{ type: "text", text: "自定义状态挂上了。" }] };
      }
      return { content: [{ type: "text", text: "action 只能是 preset 或 custom。" }] };
    },
  }));

  factory("qq_notice", (target) => ({
    name: "qq_notice",
    label: "QQ 群公告 / 群签到",
    description:
      "发群公告或群签到。action=notice 发公告（需要管理员），action=sign 群签到。" +
      "不传 group_id 就用当前群。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["notice", "sign"], description: "notice=发公告 sign=签到" },
        content: { type: "string", description: "action=notice 时的公告内容" },
        group_id: { type: "number", description: "群号，不传则用当前群" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_id, params, ctx) {
      const gid = params?.group_id || currentGroupId(ctx);
      if (!gid) return { content: [{ type: "text", text: "不知道是哪个群。" }] };
      const action = String(params?.action || "");

      if (action === "notice") {
        const content = String(params?.content || "").trim();
        if (!content) return { content: [{ type: "text", text: "公告要写内容。" }] };
        // A notice has no target member, so only the admin check applies here;
        // guardTarget would be answering a question that was never asked.
        const mine = await myRole(gid);
        if (mine !== "owner" && mine !== "admin") {
          return {
            content: [{ type: "text", text: `本鱼在这个群只是「${ROLE_CN[mine] || mine || "未知"}」，发不了公告。` }],
          };
        }
        const r = await callApi("_send_group_notice", {
          group_id: Number(gid),
          content,
        });
        if (r.error) return { content: [{ type: "text", text: `没发出去：${r.error}` }] };
        probe("qq-notice", { gid, len: content.length });
        return { content: [{ type: "text", text: "公告发出去了。" }] };
      }
      if (action === "sign") {
        const r = await callApi("send_group_sign", { group_id: Number(gid) });
        if (r.error) return { content: [{ type: "text", text: `签到失败：${r.error}` }] };
        probe("qq-sign", { gid });
        return { content: [{ type: "text", text: "签到完成。" }] };
      }
      return { content: [{ type: "text", text: "action 只能是 notice 或 sign。" }] };
    },
  }));

  factory("qq_friends", () => ({
    name: "qq_friends",
    label: "QQ 好友列表",
    description: "列出本鱼的 QQ 好友。只读。数量多的时候只显示前一部分。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "最多显示多少个，默认 50" },
      },
      additionalProperties: false,
    },
    async execute(_id, params) {
      const r = await callApi("get_friend_list", {});
      if (r.error) return { content: [{ type: "text", text: `拿不到：${r.error}` }] };
      const list = Array.isArray(r.data) ? r.data : [];
      if (!list.length) return { content: [{ type: "text", text: "好友列表是空的。" }] };
      const cap = Math.min(200, Math.max(1, Number(params?.limit) || 50));
      const shown = list.slice(0, cap);
      const text = shown
        .map((f) => `${f.remark || f.nickname || "?"} · ${f.user_id}`)
        .join("\n");
      const more = list.length > cap ? `\n（还有 ${list.length - cap} 个没显示）` : "";
      return { content: [{ type: "text", text: `共 ${list.length} 个好友：\n${text}${more}` }] };
    },
  }));

  factory("qq_groups", () => ({
    name: "qq_groups",
    label: "QQ 群列表",
    description: "列出本鱼加入的 QQ 群。只读。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const r = await callApi("get_group_list", {});
      if (r.error) return { content: [{ type: "text", text: `拿不到：${r.error}` }] };
      const list = Array.isArray(r.data) ? r.data : [];
      if (!list.length) return { content: [{ type: "text", text: "还没加任何群。" }] };
      const text = list
        .map((g) => `${g.group_name || "?"} · ${g.group_id} · ${g.member_count ?? "?"} 人`)
        .join("\n");
      return { content: [{ type: "text", text: `共 ${list.length} 个群：\n${text}` }] };
    },
  }));

  // Read the actual message history, not just the last preview.
  //
  // `qq_recent` calls get_recent_contact, which returns one preview line per
  // conversation. That is why the character reported "查不到" on 2026-11-04 when
  // asked how many bubbles a message arrived as — the endpoint that answers the
  // question (get_friend_msg_history / get_group_msg_history) was never wired up.
  factory("qq_history", (target, ctx) => ({
    name: "qq_history",
    label: "QQ 聊天记录",
    description:
      "读某个私聊或群的真实聊天记录，按时间正序返回。想看刚才到底发出去几条、对方说了什么、" +
      "有没有重复，就查这个。只读。",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "private:QQ号 或 group:群号。不填就用当前会话的对方。",
        },
        count: { type: "number", description: "要几条，默认 20，最多 50" },
      },
      additionalProperties: false,
    },
    async execute(_id, params) {
      const cap = Math.min(50, Math.max(1, Number(params?.count) || 20));
      let raw = String(params?.target || "").trim();
      // Fall back to whoever this conversation is with, so the usual call is bare.
      if (!raw) {
        const id = identity(ctx, {});
        const sk = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
        const groupId = /:group:(\d{5,})/.exec(sk)?.[1];
        if (groupId) raw = `group:${groupId}`;
        else if (id.chatId) raw = `private:${id.chatId}`;
      }
      const m = /^(private|group):(\d{5,})$/.exec(raw);
      if (!m) {
        return {
          content: [{ type: "text", text: `目标写错了：${raw || "（空）"}，要 private:QQ号 或 group:群号。` }],
        };
      }
      const [, kind, num] = m;
      const r = kind === "group"
        ? await callApi("get_group_msg_history", { group_id: Number(num), count: cap })
        : await callApi("get_friend_msg_history", { user_id: Number(num), count: cap });
      if (r.error) return { content: [{ type: "text", text: `拿不到聊天记录：${r.error}` }] };
      const list = Array.isArray(r.data?.messages) ? r.data.messages : [];
      if (!list.length) return { content: [{ type: "text", text: "这个会话没有记录。" }] };

      const selfId = list[0]?.self_id;
      const lines = list.map((msg) => {
        const mine = msg.user_id === selfId || msg.post_type === "message_sent";
        const who = mine ? "本鱼" : (msg.sender?.card || msg.sender?.nickname || msg.user_id || "?");
        // CQ face codes carry escaped JSON and make the line unreadable; the
        // visible intent is that a sticker was sent, which is all that matters.
        let text = String(msg.raw_message || "");
        // NapCat HTML-escapes the brackets inside face payloads (&#91; = "["),
        // so an escaped code never matches a plain CQ pattern. Unescape first or
        // the reader sees the raw payload instead of the message.
        text = text
          .replace(/&#91;/g, "[")
          .replace(/&#93;/g, "]")
          .replace(/&#44;/g, ",")
          .replace(/&amp;/g, "&");
        text = text.replace(/\[CQ:face,[^\]]*\]/g, "[表情]");
        text = text.replace(/\[CQ:[a-z_]+,[^\]]*\]/g, "[非文字]");
        const at = msg.time ? new Date(msg.time * 1000).toTimeString().slice(0, 8) : "--:--:--";
        return `${at} [${who}] ${text || "[空]"}`;
      });
      return {
        content: [{ type: "text", text: `共 ${list.length} 条（正序）：\n${lines.join("\n")}` }],
      };
    },
  }));

  factory("qq_recent", () => ({
    name: "qq_recent",
    label: "QQ 最近会话",
    description: "看最近跟谁聊过。只读。想主动找人但不确定找谁时有用。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "最多几条，默认 15" },
      },
      additionalProperties: false,
    },
    async execute(_id, params) {
      const r = await callApi("get_recent_contact", {});
      if (r.error) return { content: [{ type: "text", text: `拿不到：${r.error}` }] };
      const list = Array.isArray(r.data) ? r.data : [];
      if (!list.length) return { content: [{ type: "text", text: "最近没聊过谁。" }] };
      const cap = Math.min(50, Math.max(1, Number(params?.limit) || 15));
      const text = list.slice(0, cap).map((c) => {
        // Field names verified against NapCat 4.18.42 on 2026-11-01:
        // peerUin / peerName / chatType (1=private, 2=group) / sendNickName.
        // lastestMsg is a whole message object, not a string, so the preview is
        // pulled out of it explicitly.
        const name = c.remark || c.peerName || c.sendNickName || "?";
        const kind = Number(c.chatType) === 2 ? "群" : "私聊";
        const raw = c.lastestMsg;
        const preview = raw && typeof raw === "object"
          ? String(raw.raw_message || "").slice(0, 30)
          : "";
        return `${kind} · ${name} · ${c.peerUin || "?"}${preview ? " · " + preview : ""}`;
      }).join("\n");
      return { content: [{ type: "text", text: text }] };
    },
  }));

  // -------- pending requests (main agent only) --------
  // The owner answers on a later turn, so the request must survive as data,
  // not as something the main agent has to remember.

  function dafeiyuWorkspace() {
    const id = agents[0];
    return id ? api.config?.agents?.entries?.[id]?.workspace || null : null;
  }

  api.registerTool((ctx) => {
    const agentId = ctx?.agentId || (/^agent:([^:]+):/.exec(ctx?.sessionKey || "") || [])[1];
    if (agentId !== "main") return null;
    return {
      name: "dafeiyu_requests",
      label: "Dafeiyu Pending Requests",
      description:
        "查大肥鱼被拦下来的操作申请。默认只看待审批的。approve/reject 用来处理某一条：" +
        "传 id 加 decision。批准会写一次性授权，拒绝只标记不再提醒。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "要处理的申请 id。不传则只列出待审批的。" },
          decision: {
            type: "string",
            enum: ["approve", "reject"],
            description: "approve=批准一次，reject=拒绝",
          },
          ttlMinutes: { type: "number", description: "批准的有效分钟数，默认 10，最大 60" },
          reason: { type: "string", description: "为什么这样决定，一句话" },
          all: { type: "boolean", description: "列出全部（含已处理），默认只列待审批" },
        },
        additionalProperties: false,
      },
      async execute(_toolCallId, params) {
        const ws = dafeiyuWorkspace();
        if (!ws) return { content: [{ type: "text", text: "找不到 dafeiyu 工作区。" }] };
        const id = String(params?.id || "").trim();
        const decision = params?.decision;

        const fmt = (r) => {
          const p = Object.entries(r.params || {})
            .map(([k, v]) => `${k}=${v}`)
            .join(" ");
          const age = Math.round((Date.now() - Date.parse(r.created)) / 60000);
          return (
            `[${r.id}] ${r.tool} · ${age} 分钟前 · ${r.status}` +
            (r.attempts > 1 ? ` · 试了 ${r.attempts} 次` : "") +
            `\n  ${p}` +
            (r.reason ? `\n  理由：${r.reason}` : "")
          );
        };

        if (!id || !decision) {
          const rows = approvalStore.listPending(ws, { all: Boolean(params?.all) });
          if (!rows.length) {
            return { content: [{ type: "text", text: "没有待审批的申请。" }] };
          }
          return { content: [{ type: "text", text: rows.slice(-20).map(fmt).join("\n\n") }] };
        }

        const out = approvalStore.decidePending(ws, id, decision, {
          reason: params?.reason,
        });
        if (out.error === "bad-decision") {
          return { content: [{ type: "text", text: "decision 只能是 approve 或 reject。" }] };
        }
        if (out.error?.startsWith("no-such-request")) {
          return { content: [{ type: "text", text: `没有 id 为 ${id} 的申请。` }] };
        }
        if (out.error?.startsWith("already-")) {
          return {
            content: [{ type: "text", text: `这条已经处理过了（${out.error.slice(8)}）。` }],
          };
        }

        const rec = out.record;
        if (decision === "reject") {
          probe("pending-rejected", { id, tool: rec.tool });
          return {
            content: [{ type: "text", text: `已拒绝 ${rec.tool}（${id}）。大肥鱼不会再因这条找你。` }],
          };
        }

        const ttl = Math.min(60, Math.max(1, Number(params?.ttlMinutes) || 10));
        const grant = {
          nonce: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          tool: rec.tool,
          reason: String(rec.reason || params?.reason || "").slice(0, 300),
          granted_by: "main",
          granted_at: new Date().toISOString(),
          expires: new Date(Date.now() + ttl * 60000).toISOString(),
          used_at: null,
        };
        const { file: af } = readApprovals(ws);
        const all = (() => {
          try {
            const raw = JSON.parse(fs.readFileSync(af, "utf8"));
            return Array.isArray(raw) ? raw : [];
          } catch {
            return [];
          }
        })();
        writeJsonAtomic(af, [...all, grant].slice(-50));
        probe("pending-approved", { id, tool: rec.tool, ttl });

        return {
          content: [
            {
              type: "text",
              text: `已批准 ${rec.tool}（${id}），${ttl} 分钟内有效，只能用一次。告诉大肥鱼可以做了。`,
            },
          ],
        };
      },
    };
  }, { name: "dafeiyu_requests" });

  // Main-agent only: drain the proactive queue so the engine can be driven
  // from a Gateway automation. The plugin cannot send messages itself.
  api.registerTool((ctx) => {
    const agentId = ctx?.agentId || (/^agent:([^:]+):/.exec(ctx?.sessionKey || "") || [])[1];
    if (agentId !== "main") return null;
    return {
      name: "dafeiyu_proactive_take",
      label: "Dafeiyu Proactive Take",
      description:
        "取出大肥鱼排队中的主动发言，交给你或定时任务真正发出去。可选传 target 只取某个对象。",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "只取这个对象的，可选" },
          peek: { type: "boolean", description: "只看不取，默认 false" },
        },
        additionalProperties: false,
      },
      async execute(_toolCallId, params) {
        const ws = agents[0] ? api.config?.agents?.entries?.[agents[0]]?.workspace : null;
        if (!ws) return { content: [{ type: "text", text: "找不到 dafeiyu 工作区。" }] };
        if (params?.peek) {
          const list = proactive.pendingFor(ws, params?.target || null, proactiveCfg);
          return {
            content: [{ type: "text", text: list.length ? JSON.stringify(list, null, 2) : "队列是空的。" }],
          };
        }
        const rec = proactive.take(ws, params?.target || null, proactiveCfg);
        if (!rec) return { content: [{ type: "text", text: "队列是空的，或者被闸门挡了。" }] };
        probe("proactive-take", { target: rec.target, kind: rec.kind });

        // The destination alone is not enough to send with: several channels are
        // configured, so `message` refuses a send that does not name one. Work
        // out the channel here and hand it over, or every proactive line dies
        // with "Channel is required when multiple channels are configured".
        let channel = null;
        try {
          const known = proactive.resolveTargetConfig(proactiveCfg, rec.target);
          if (known?.channel) channel = known.channel;
        } catch {}

        const how = channel
          ? `channel 必须传 "${channel}"，target 传 "${rec.target}"`
          : `target 传 "${rec.target}"，channel 按这个对象平时用哪个填`;
        return {
          content: [
            {
              type: "text",
              text: `给 ${rec.target} 发以下内容（${rec.kind}，value=${rec.value}）。\n${how}。\n\n${rec.text}`,
            },
          ],
        };
      },
    };
  }, { name: "dafeiyu_proactive_take" });

  api.logger?.info?.(`dafeiyu-core: registered for [${agents.join(", ")}]`);  try {
    fs.appendFileSync(
      path.join(agents[0] ? path.join(os.homedir(), ".openclaw", `workspace-${agents[0]}`) : "/tmp", "logs", "plugin-boot.log"),
      `${new Date().toISOString()} registered pid=${process.pid} agents=${agents.join(",")}\n`,
    );
  } catch {}
}
