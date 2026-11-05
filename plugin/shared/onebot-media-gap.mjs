// Serialized sends for every path that talks to NapCat.
//
// The problem: QQ drops a text bubble that lands while it is still committing
// an image. Two independent senders reach NapCat:
//
//   1. openclaw-onebot  dist/src/outbound.js  -> callApi()
//      normal replies, the `message` tool, gateway.js deliver
//   2. dafeiyu-core     index.js              -> postOnebot()
//      the dafeiyu_sticker tool
//
// Failure history, because each attempt fixed a different half:
//
//   a. Post-send wait (sticker finished, then sleep): useless when the image
//      comes SECOND, which is the real ordering.
//   b. Pre-send check of a shared timestamp ledger: right direction, but the
//      check and the send were not atomic. Two callers in the same tick both
//      read a stale ledger, both concluded "no wait needed", and both fired.
//      Text in flight is invisible because its timestamp is only written after
//      the fetch resolves. That is the hole still open in the version below.
//
// The fix here is to serialize per chat instead of merely checking. Every send
// joins a FIFO chain for its chat, so a media send can never start while a text
// send is in flight, and the gap decision is made inside the serialized
// section where no other caller can interleave. Timestamps are claimed BEFORE
// the network call, not after, so an in-flight send is visible to the next one.
//
// This requires both plugins to live in the same process. They do today (same
// gateway pid). If they are ever split, the chain silently stops being shared —
// see the pid guard below.

import { AsyncLocalStorage } from "node:async_hooks";

const MEDIA_COMMIT_MS = 1200;

// Marks "this async context is already inside a reply window for chatKey".
// Sends made inside the owning window must NOT queue again: the window itself
// holds the chat lock, so re-queueing would deadlock against it.
const replyWindows = new AsyncLocalStorage();

/** chatKey -> { tail: Promise, lastStart: number, lastMedia: boolean } */
const chatQueues = new Map();
let ownerPid = null;

function checkPid() {
  const pid = typeof process !== "undefined" ? process.pid : null;
  if (pid == null) return;
  if (ownerPid == null) {
    ownerPid = pid;
    return;
  }
  if (ownerPid !== pid) {
    console.warn(
      `[onebot-media-gap] shared send chain used from pid ${pid} but was created in pid ${ownerPid}; ` +
        "media/text ordering across plugins is NOT guaranteed",
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function paceKey(targetType, targetId) {
  return `onebot:${targetType}:${targetId}`;
}

export function keyFromOnebotCall(endpoint, body) {
  if (body && body.group_id != null) return paceKey("group", body.group_id);
  if (body && body.user_id != null) return paceKey("private", body.user_id);
  return `onebot:${endpoint}`;
}

export function isMediaMessage(message) {
  if (!Array.isArray(message)) return false;
  return message.some((seg) => seg && seg.type && seg.type !== "text");
}

/**
 * Hold the chat lock for an ENTIRE multi-part reply.
 *
 * Why this exists: `deliver` splits one answer into sentences and sends them
 * one at a time with a random 380-1100ms pause between pieces. A sticker that
 * fires during one of those pauses slips between two sentences of the same
 * reply and QQ drops whichever piece is still committing. Per-send gating
 * cannot see that gap, because between two pieces nothing is in flight.
 *
 * So the lock is taken before the first sentence and released after the last
 * one. Anything else wanting to send to this chat waits for the whole reply,
 * not for a single bubble.
 */
export function withReplyWindow(chatKey, fn) {
  checkPid();

  let q = chatQueues.get(chatKey);
  if (!q) {
    q = { tail: Promise.resolve(), lastStart: 0, lastMedia: false };
    chatQueues.set(chatKey, q);
  }

  const run = async () => {
    if (q.lastStart) {
      const wait = Math.max(0, q.lastStart + MEDIA_COMMIT_MS - Date.now());
      if (wait > 0) await sleep(wait);
    }
    try {
      return await replyWindows.run(chatKey, fn);
    } finally {
      q.lastStart = Date.now();
      q.lastMedia = false;
    }
  };

  const result = q.tail.then(run, run);
  q.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Run one send, serialized behind every other send to the same chat.
 *
 * @param {string} chatKey
 * @param {boolean} media  whether THIS payload contains a non-text segment
 * @param {() => Promise<any>} sendFn  performs the actual HTTP call
 */
export function sendWithGap(chatKey, media, sendFn) {
  checkPid();

  // Inside the owning reply window the chat lock is already held and every
  // piece of that reply is meant to go out back-to-back. Queueing here would
  // wait on a chain the window itself is holding, so send straight through.
  if (replyWindows.getStore() === chatKey) {
    return sendFn();
  }

  let q = chatQueues.get(chatKey);
  if (!q) {
    q = { tail: Promise.resolve(), lastStart: 0, lastMedia: false };
    chatQueues.set(chatKey, q);
  }

  const run = async () => {
    // This block runs exclusively: no other send to this chat is between its
    // own start and finish, so lastStart/lastMedia are stable here.
    const now = Date.now();
    let wait = 0;
    // A gap is needed when the previous send was media (still committing) or
    // when this one is media (it would push a fresh text bubble out). Text
    // after text needs nothing: QQ renders that fine and a forced delay there
    // only makes replies feel laggy.
    if (q.lastStart && (q.lastMedia || media)) {
      wait = Math.max(0, q.lastStart + MEDIA_COMMIT_MS - now);
    }
    if (wait > 0) await sleep(wait);

    // Claim the slot BEFORE the request. If this were written after the fetch
    // resolved, a concurrent caller would see lastStart=0 and fire immediately.
    q.lastStart = Date.now();
    q.lastMedia = Boolean(media);

    try {
      return await sendFn();
    } finally {
      // The commit window starts when the request actually finished.
      q.lastStart = Date.now();
    }
  };

  // FIFO: chain onto the tail, and keep the tail alive even if a send rejects.
  const result = q.tail.then(run, run);
  q.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Milliseconds the next send to this chat would wait. Diagnostics only. */
export function waitBeforeSend(chatKey, incomingMedia = false) {
  const q = chatQueues.get(chatKey);
  if (!q || !q.lastStart) return 0;
  if (!q.lastMedia && !incomingMedia) return 0;
  return Math.max(0, q.lastStart + MEDIA_COMMIT_MS - Date.now());
}

/** Legacy no-op kept so older call sites keep importing cleanly. */
export function noteSend() {}

export { MEDIA_COMMIT_MS };
