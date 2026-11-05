// Identity resolution tests using the real hook payload shapes.
// Shapes taken from dist/message-hook-mappers-*.mjs

import assert from "node:assert";
import { resolveIdentity, resolveOnebotTargetKind } from "../lib/identity.js";

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

console.log("\n=== identity ===");

t("direct weixin message resolves person key", () => {
  const event = {
    content: "在吗",
    senderId: "wxid_example@im.wechat",
    timestamp: Date.now(),
    metadata: {
      senderId: "wxid_example@im.wechat",
      senderName: "owner_example",
      originatingChannel: "openclaw-weixin",
    },
  };
  const ctx = {
    channelId: "openclaw-weixin",
    conversationId: "wxid_example@im.wechat",
    senderId: "wxid_example@im.wechat",
    sessionKey: "agent:dafeiyu:main",
  };
  const id = resolveIdentity(event, ctx);
  assert.equal(id.channel, "openclaw-weixin");
  assert.equal(id.isGroup, false, "direct chat misdetected as group");
  assert.equal(id.personKey, "person:openclaw-weixin:wxid_example@im.wechat");
  assert.equal(id.groupKey, null);
  assert.equal(id.targetKey, id.personKey);
  assert.equal(id.senderName, "owner_example");
});

t("group message resolves group key and keeps sender", () => {
  const event = {
    content: "大家好",
    senderId: "12345",
    metadata: { senderId: "12345", senderName: "小明" },
  };
  const ctx = {
    channelId: "openclaw-weixin",
    conversationId: "999999@chatroom",
    senderId: "12345",
  };
  const id = resolveIdentity(event, ctx);
  assert.equal(id.isGroup, true, "group not detected");
  assert.equal(id.groupKey, "group:openclaw-weixin:999999@chatroom");
  assert.equal(id.personKey, "person:openclaw-weixin:12345");
  assert.equal(id.targetKey, id.groupKey, "proactive should target the group");
});

t("missing senderId yields null person key, no crash", () => {
  const id = resolveIdentity({ content: "hi" }, { channelId: "webchat" });
  assert.equal(id.personKey, null);
  assert.equal(id.targetKey, null);
});

t("falls back to originatingChannel when ctx channelId absent", () => {
  const event = {
    senderId: "u1",
    metadata: { originatingChannel: "feishu", senderId: "u1" },
  };
  const id = resolveIdentity(event, {});
  assert.equal(id.channel, "feishu");
  assert.equal(id.personKey, "person:feishu:u1");
});

t("explicit metadata.groupId forces group", () => {
  const event = {
    senderId: "u1",
    metadata: { senderId: "u1", groupId: "g-abc" },
  };
  const ctx = { channelId: "feishu", conversationId: "u1" };
  const id = resolveIdentity(event, ctx);
  assert.equal(id.isGroup, true);
  assert.equal(id.groupKey, "group:feishu:u1");
});

t("session key as conversationId must NOT mean group", () => {
  // WebChat passes conversationId = "agent:dafeiyu:main". Treating that as a
  // group produced a bogus group:webchat:agent:dafeiyu:main record.
  const event = {
    content: "hi",
    senderId: "openclaw-macos",
    metadata: { senderId: "openclaw-macos" },
  };
  const ctx = {
    channelId: "webchat",
    conversationId: "agent:dafeiyu:main",
    sessionKey: "agent:dafeiyu:main",
    senderId: "openclaw-macos",
  };
  const id = resolveIdentity(event, ctx);
  assert.equal(id.isGroup, false, "session key misread as group");
  assert.equal(id.groupKey, null, `bogus group key: ${id.groupKey}`);
  assert.equal(id.personKey, "person:webchat:openclaw-macos");
  assert.equal(id.targetKey, id.personKey, "proactive target should be the person");
});

t("QQ private session containing group segment is still private", () => {
  const sk = "agent:dafeiyu:onebot:group:private:1000000001";
  assert.equal(resolveOnebotTargetKind({}, { sessionKey: sk }, sk), "private");
});

t("real QQ group session remains group", () => {
  const sk = "agent:dafeiyu:onebot:group:group:1000000003";
  assert.equal(resolveOnebotTargetKind({}, { sessionKey: sk }, sk), "group");
});

t("explicit private target wins over session naming", () => {
  const sk = "agent:dafeiyu:onebot:group:private:1000000001";
  const ctx = { sessionKey: sk, conversationId: "onebot:private:1000000001" };
  assert.equal(resolveOnebotTargetKind({}, ctx, sk), "private");
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
