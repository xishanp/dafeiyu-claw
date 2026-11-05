// Resolve who is talking, from a plugin hook event + context pair.
//
// Field layout verified against the shipped mappers in
// dist/message-hook-mappers-*.mjs:
//
//   message_received event:
//     event.content, event.senderId, event.timestamp, event.threadId,
//     event.messageId, event.sessionKey, event.runId,
//     event.metadata.{ senderId, senderName, senderUsername, threadId,
//                      originatingChannel, originatingTo, groupId? }
//
//   message context (ctx):
//     channelId, accountId, conversationId, sessionKey, runId, messageId,
//     senderId, callDepth
//
// Notably absent: isGroup and chatName. Group-ness must be inferred.

/**
 * @param {object} event  plugin hook event
 * @param {object} ctx    plugin hook context
 * @returns {object} identity with stable keys
 */
/**
 * Parse a stored target key into its delivery address.
 *
 * Target keys changed shape once already: a QQ DM used to be stored as
 * `group:onebot:onebot:private:<id>` and is now `person:onebot:<id>`.
 * Consumers that each carried their own regex silently stopped matching at that
 * point — the sticker tool reported "cannot tell which conversation" for every
 * chat even though the keys were perfectly valid.
 *
 * Accepts both shapes so old state keeps working, and so a consumer never has to
 * re-learn the format.
 *
 * @returns {{isGroup: boolean, chatId: string} | null}
 */
export function parseTargetKey(key) {
  if (typeof key !== "string") return null;

  // Current: person:<channel>:<id> / group:<channel>:<id>
  let m = /^(person|group):([^:]+):([\w.@-]+)$/.exec(key);
  if (m) {
    const isGroup = m[1] === "group";
    // A channel-qualified private chat still carries a `private:` segment.
    const priv = /^private:(.+)$/.exec(m[3]);
    if (priv) return { isGroup: false, chatId: priv[1] };
    return { isGroup, chatId: m[3] };
  }

  // Legacy: group:<channel>:<channel>:private:<id> / ...:group:<id>
  m = /:(group|private):(\d{5,})$/.exec(key);
  if (m) return { isGroup: m[1] === "group", chatId: m[2] };

  return null;
}

/**
 * Resolve the delivery type of a QQ target from explicit evidence only.
 *
 * A session key is NOT evidence. `agent:<agentId>:onebot:group:private:<id>`
 * contains both words, so a naive /:group:/ test turns a private chat into a
 * group send. Prefer the host's real identity, then an explicit private/group
 * target. Only an unambiguous session suffix remains as a last resort.
 */
export function resolveOnebotTargetKind(event, ctx, sessionKey = null) {
  const id = resolveIdentity(event || {}, ctx || {});
  if (id?.isGroup === true) return "group";
  const sk = String(sessionKey ?? ctx?.sessionKey ?? "");
  if (/:private:/.test(sk)) return "private";
  if (/:group:/.test(sk) && !/:group:private:/.test(sk)) return "group";
  const candidates = [
    ctx?.conversationId,
    ctx?.chatId,
    event?.conversationId,
    event?.chatId,
    event?.metadata?.originatingTo,
    event?.metadata?.conversationId,
  ];
  for (const value of candidates) {
    const s = String(value || "");
    if (/^(?:[^:]+:)?private:/.test(s)) return "private";
    if (/^(?:[^:]+:)?group:/.test(s)) return "group";
  }
  return null;
}

export function resolveIdentity(event, ctx) {
  const ev = event || {};
  const c = ctx || {};
  const md = ev.metadata || {};

  const channel =
    c.channelId || ev.channel || md.originatingChannel || "local";

  const senderId = ev.senderId || md.senderId || c.senderId || null;
  const senderName = md.senderName || md.senderUsername || ev.senderName || null;

  const conversationId =
    c.conversationId || ev.conversationId || md.conversationId || null;

  const groupId = md.groupId || md.group || null;

  // A session key is not a conversation id. WebChat passes `agent:<id>:<x>`
  // as conversationId, which previously made every direct chat look like a
  // group. Reject that shape before inferring group-ness.
  const looksLikeSessionKey =
    typeof conversationId === "string" && /^agent:[^:]+:/.test(conversationId);

  const realConversationId = looksLikeSessionKey ? null : conversationId;

  // OneBot encodes a direct chat as `onebot:private:<uin>`, so the conversation
  // id never equals the raw sender id even though it is a private chat. Comparing
  // them made every QQ DM look like a group, which wrote target keys like
  // `group:onebot:onebot:private:<id>` — and those never matched the
  // `person:onebot:<uin>` keys used for familiarity, so relationship lookups
  // silently missed every QQ private chat.
  const looksLikePrivateConversation =
    typeof realConversationId === "string" &&
    /^(?:[^:]+:)?private:/.test(realConversationId);

  // A group chat is one where the conversation is not the person themselves.
  const isGroup =
    !looksLikePrivateConversation &&
    (Boolean(groupId) ||
      Boolean(md.isGroup) ||
      Boolean(realConversationId && senderId && realConversationId !== senderId));

  const chatId = realConversationId || senderId;
  const chatName = md.chatName || md.groupName || md.conversationName || null;

  return {
    channel,
    chatId,
    senderId,
    senderName,
    chatName,
    groupId: groupId || (isGroup ? chatId : null),
    isGroup,
    // Stable keys used by relations / topics / proactive state.
    personKey: senderId ? `person:${channel}:${senderId}` : null,
    groupKey: isGroup && chatId ? `group:${channel}:${chatId}` : null,
    // Where a proactive message would be sent.
    targetKey:
      isGroup && chatId
        ? `group:${channel}:${chatId}`
        : senderId
          ? `person:${channel}:${senderId}`
          : null,
  };
}
