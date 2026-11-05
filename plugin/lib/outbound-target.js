/**
 * Fill in the channel when the destination already names it.
 *
 * With several channels configured the `message` tool refuses a send that has
 * no `channel`, even when the target is unambiguous:
 *
 *   Channel is required when multiple channels are configured:
 *   feishu, onebot, openclaw-weixin. Pass --channel <channel> to choose one.
 *
 * That is what killed three proactive heartbeats carrying a GIF on 2026-11-03
 * (20:25, 20:33, 20:50). The same text without media went out fine, so the
 * failure only showed up on the media path.
 *
 * `private:<id>` and `group:<id>` are OneBot's own target syntax: no other
 * channel here accepts them, so deriving `onebot` from the target adds no
 * guesswork. Anything else is left untouched — a missing channel is a real
 * ambiguity there, and inventing one would send to the wrong place.
 */
const ONEBOT_TARGET = /^(private|group):\d+$/;

export function inferChannelFromTarget(params) {
  if (!params || typeof params !== "object") return null;
  if (typeof params.channel === "string" && params.channel.trim()) return null;

  const action = params.action;
  if (action !== undefined && action !== "send") return null;

  const rawTo = typeof params.to === "string" ? params.to : params.target;
  if (typeof rawTo !== "string") return null;

  let to = rawTo.trim();
  if (to.toLowerCase().startsWith("onebot:")) to = to.slice("onebot:".length);
  if (!ONEBOT_TARGET.test(to)) return null;

  return { ...params, channel: "onebot" };
}
