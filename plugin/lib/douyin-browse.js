// Watching videos on Douyin, the way a person does it — not the way a crawler does.
//
// The hard part is not grabbing frames. It is that the page is a live feed that
// advances on its own, the comment panel tears itself down when the page moves
// under it, and every action leaves a trace on a real account. So this module
// separates the two kinds of work:
//
//   * reading (frames, captions, comments) — safe, repeatable, no account risk
//   * acting (like, comment, share) — irreversible and public, gated by policy
//
// Everything here is pure-ish helpers over plain objects. The browser itself is
// driven from index.js, because that is where the host tools live.

const MAX_FRAMES = 24;
const MAX_FRAME_EDGE = 960;
const MAX_TOTAL_PIXELS = 921600;

// Douyin advances the feed when a video ends. Any scripted frame grab that keeps
// the video playing will lose the page mid-run, so playback is always stopped
// first. This is the single most common cause of "the comment box vanished".
const FREEZE_JS = `() => {
  const v = [...document.querySelectorAll('video')].find(x => x.videoWidth > 800);
  if (!v) return JSON.stringify({ ok: false, reason: 'no-video' });
  if (!v.paused) v.pause();
  v.loop = true;
  return JSON.stringify({ ok: true, duration: v.duration, width: v.videoWidth, height: v.videoHeight });
}`;

// Frame count follows the content, not a fixed number. A long single-shot clip
// and a fast-cut edit have nothing in common, so the caller passes a hint from
// the scene-change pass and this only enforces sane bounds.
function planFrames({ duration, sceneCount }) {
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return { count: 0, interval: 0, reason: "no-duration" };
  if (d < 3) return { count: 2, interval: d / 2, reason: "very-short" };
  if (d < 10) return { count: 4, interval: d / 4, reason: "short" };

  const scenes = Number(sceneCount);
  if (Number.isFinite(scenes) && scenes > 0) {
    // One frame per scene, plus a second sample on the longest scenes, capped.
    const count = Math.min(MAX_FRAMES, Math.max(6, Math.round(scenes * 1.2)));
    return { count, interval: d / count, reason: "scene-driven" };
  }
  if (d < 60) return { count: 8, interval: d / 8, reason: "medium" };
  if (d < 180) return { count: 12, interval: d / 12, reason: "long" };
  return { count: 16, interval: d / 16, reason: "very-long" };
}

// Downscale to a fixed pixel budget rather than a fixed edge, so a portrait
// clip and a wide clip land at comparable token cost.
function canvasScale(width, height) {
  const w = Number(width), h = Number(height);
  if (!(w > 0 && h > 0)) return 1;
  return Math.min(
    1,
    MAX_FRAME_EDGE / w,
    MAX_FRAME_EDGE / h,
    Math.sqrt(MAX_TOTAL_PIXELS / (w * h)),
  );
}

function timestamps({ duration, count }) {
  const d = Number(duration), n = Math.floor(Number(count));
  if (!(d > 0) || !(n > 0)) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    // Sample the middle of each slice: the first and last frames of a slice are
    // the ones most likely to be a transition smear.
    out.push(Number((((i + 0.5) / n) * d).toFixed(3)));
  }
  return out;
}

// A video the character "watched" is worth remembering only if something can be
// said about it. Bare metadata is not an experience.
function describeWatch({ title, author, frames, note }) {
  const t = String(title || "").trim();
  const a = String(author || "").trim();
  const n = Number(frames) || 0;
  const parts = [];
  if (t) parts.push(`看了条视频：《${t.slice(0, 40)}》`);
  else parts.push("看了条视频");
  if (a) parts.push(`@${a.slice(0, 20)}`);
  if (n) parts.push(`抽了 ${n} 帧`);
  if (note) parts.push(String(note).slice(0, 60));
  return parts.join("，");
}

// What the character felt while watching, expressed as deltas it can apply.
// Deliberately small and signed: watching something is a nudge, not an event.
const MOOD_BY_REACTION = {
  liked: { happy: 0.05, excited: 0.03, bored: -0.04 },
  funny: { happy: 0.06, excited: 0.04, bored: -0.05 },
  boring: { bored: 0.05, happy: -0.02 },
  confusing: { surprised: 0.04, curious: 0.03 },
  touching: { happy: 0.03, down: 0.02, calm: 0.02 },
  annoying: { tsundere: 0.04, bored: 0.03, happy: -0.03 },
};

function moodDelta(reaction) {
  return MOOD_BY_REACTION[String(reaction || "").trim()] || null;
}

// Acting on the account is a separate decision from watching. The caller must
// opt in per action, and the guard lives here so every path shares one rule.
const ACTIONS = new Set(["like", "comment", "share"]);

function requireActor({ action, allow }) {
  const a = String(action || "").trim();
  if (!ACTIONS.has(a)) return { ok: false, reason: "unknown-action" };
  const set = allow instanceof Set ? allow : new Set(Array.isArray(allow) ? allow : []);
  if (!set.has(a)) return { ok: false, reason: "not-allowed" };
  return { ok: true, action: a };
}

// Comments are public and permanent. Keep them short and free of anything that
// reads like a log line or a system message.
function sanitizeComment(text) {
  let s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return { ok: false, reason: "empty" };
  // Strip the things the character is not allowed to leak into public text.
  s = s.replace(/<[^>\n]{1,20}>/g, "").replace(/https?:\/\/\S+/g, "").trim();
  if (!s) return { ok: false, reason: "empty-after-strip" };
  if ([...s].length > 60) return { ok: false, reason: "too-long", limit: 60 };
  return { ok: true, text: s };
}

export {
  MAX_FRAMES,
  FREEZE_JS,
  planFrames,
  canvasScale,
  timestamps,
  describeWatch,
  moodDelta,
  requireActor,
  sanitizeComment,
  MOOD_BY_REACTION,
};
