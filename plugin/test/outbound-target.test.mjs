import { test } from "node:test";
import assert from "node:assert/strict";
import { inferChannelFromTarget } from "../lib/outbound-target.js";

test("private target gets onebot channel", () => {
  const out = inferChannelFromTarget({ action: "send", target: "private:1000000001", message: "hi" });
  assert.equal(out?.channel, "onebot");
  assert.equal(out.target, "private:1000000001");
});

test("group target gets onebot channel", () => {
  const out = inferChannelFromTarget({ action: "send", target: "group:1000000003", message: "hi" });
  assert.equal(out?.channel, "onebot");
});

test("onebot: prefix is accepted and kept", () => {
  const out = inferChannelFromTarget({ action: "send", target: "onebot:private:1000000001", message: "hi" });
  assert.equal(out?.channel, "onebot");
});

test("explicit channel is never overwritten", () => {
  const out = inferChannelFromTarget({ action: "send", channel: "feishu", target: "private:1000000001" });
  assert.equal(out, null);
});

test("unknown target shape is left alone", () => {
  assert.equal(inferChannelFromTarget({ action: "send", target: "user:1000000001" }), null);
  assert.equal(inferChannelFromTarget({ action: "send", target: "ou_abc123" }), null);
  assert.equal(inferChannelFromTarget({ action: "send", target: "private:abc" }), null);
});

test("non-send actions are untouched", () => {
  assert.equal(inferChannelFromTarget({ action: "react", target: "private:1000000001" }), null);
});

test("missing channel with no target is untouched", () => {
  assert.equal(inferChannelFromTarget({ action: "send", message: "hi" }), null);
  assert.equal(inferChannelFromTarget(null), null);
});

test("to field works as well as target", () => {
  const out = inferChannelFromTarget({ action: "send", to: "group:1000000003", message: "hi" });
  assert.equal(out?.channel, "onebot");
});

test("other params survive the rewrite", () => {
  const out = inferChannelFromTarget({
    action: "send",
    target: "private:1000000001",
    message: "hi",
    media: "/tmp/a.gif",
  });
  assert.equal(out?.message, "hi");
  assert.equal(out?.media, "/tmp/a.gif");
});
