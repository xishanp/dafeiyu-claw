// approval.test.mjs — pending-request store + secret redaction.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ap from "../lib/approval.js";

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ap-"));
fs.mkdirSync(path.join(ws, "state"), { recursive: true });

console.log("\n=== redact ===");
t("api key assignment is masked", () => {
  assert.equal(ap.redact("export API_KEY=sk-abcdef123456"), "export API_KEY=<redacted>");
});
t("bearer header is masked", () => {
  const out = ap.redact('curl -H "Authorization: Bearer abcdefghijklmnop1234" https://x');
  assert.ok(out.includes("Bearer <redacted>"), out);
  assert.ok(!out.includes("abcdefghijklmnop1234"), out);
});
t("basic auth is masked", () => {
  assert.ok(ap.redact("Authorization: Basic dXNlcjpwYXNzMTIz").includes("<redacted>"));
});
t("github token is masked", () => {
  const out = ap.redact("https://ghp_AAAABBBBCCCCDDDDEEEE@github.com/x/y");
  assert.ok(!out.includes("ghp_AAAABBBBCCCCDDDDEEEE"), out);
  assert.ok(out.includes("github.com/x/y"), out);
});
t("jwt is masked", () => {
  assert.ok(ap.redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghij").includes("redacted-jwt"));
});
t("email is masked", () => {
  assert.ok(ap.redact("mail user@example.com now").includes("<redacted-email>"));
});
t("chinese id and phone are masked", () => {
  const out = ap.redact("手机 13812345678 身份证 110101199003071234");
  assert.ok(out.includes("<redacted-phone>"), out);
  assert.ok(out.includes("<redacted-id>"), out);
});
t("ordinary command is left alone", () => {
  assert.equal(ap.redact("npm install -g left-pad"), "npm install -g left-pad");
});
t("voice id is left alone", () => {
  assert.equal(ap.redact("tts --voice voc_g4trfmyggnbq"), "tts --voice voc_g4trfmyggnbq");
});
t("the word token in prose is left alone", () => {
  assert.equal(ap.redact("token was valid"), "token was valid");
});

console.log("\n=== summarizeParams ===");
t("keeps only listed keys", () => {
  const s = ap.summarizeParams({ params: { command: "ls", random: "x", cwd: "/tmp" } });
  assert.deepEqual(Object.keys(s), ["command"]);
});
t("falls back to brief when no known key", () => {
  const s = ap.summarizeParams({ params: { foo: "bar" } });
  assert.ok(s.brief, JSON.stringify(s));
});
t("redacts inside summary", () => {
  const s = ap.summarizeParams({ params: { command: "curl -H 'Authorization: Bearer abcdefgh12345678' x" } });
  assert.ok(!s.command.includes("abcdefgh12345678"), s.command);
});
t("truncates long values", () => {
  const s = ap.summarizeParams({ params: { command: "a".repeat(900) } });
  assert.ok(s.command.length <= 301, String(s.command.length));
});

console.log("\n=== pending store ===");
t("first record is pending", () => {
  const r = ap.recordPending(ws, "exec", { params: { command: "npm i -g foo" } }, "想装工具");
  assert.equal(r.merged, false);
  const list = ap.listPending(ws);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "pending");
});
t("identical attempt inside 30min is merged", () => {
  const r = ap.recordPending(ws, "exec", { params: { command: "npm i -g foo" } }, "想装工具");
  assert.equal(r.merged, true);
  const list = ap.listPending(ws);
  assert.equal(list.length, 1);
  assert.equal(list[0].attempts, 2);
});
t("different command makes a new entry", () => {
  ap.recordPending(ws, "exec", { params: { command: "rm -rf /tmp/x" } }, "清理");
  assert.equal(ap.listPending(ws).length, 2);
});
t("same command after 30min makes a new entry", () => {
  const later = Date.now() + 31 * 60000;
  ap.recordPending(ws, "exec", { params: { command: "npm i -g foo" } }, "想装工具", later);
  assert.equal(ap.listPending(ws).length, 3);
});
t("secrets never reach disk", () => {
  ap.recordPending(ws, "secrets", { params: { command: "export API_KEY=sk-live-abcdef123456" } }, "");
  const raw = fs.readFileSync(ap.pendingFile(ws), "utf8");
  assert.ok(!raw.includes("sk-live-abcdef123456"), raw.slice(0, 400));
  assert.ok(raw.includes("<redacted>"), raw.slice(0, 400));
});
t("approve marks approved", () => {
  const id = ap.listPending(ws)[0].id;
  const out = ap.decidePending(ws, id, "approve", { reason: "可以" });
  assert.ok(out.record, JSON.stringify(out));
  assert.equal(out.record.status, "approved");
});
t("decided entry leaves the pending list", () => {
  const ids = ap.listPending(ws).map((r) => r.id);
  const all = ap.listPending(ws, { all: true });
  assert.equal(all.length - ids.length, 1);
});
t("double decide is refused", () => {
  const id = ap.listPending(ws, { all: true }).find((r) => r.status === "approved").id;
  assert.equal(ap.decidePending(ws, id, "reject").error, "already-approved");
});
t("reject marks rejected", () => {
  const id = ap.listPending(ws)[0].id;
  assert.equal(ap.decidePending(ws, id, "reject").record.status, "rejected");
});
t("unknown id is reported", () => {
  assert.ok(ap.decidePending(ws, "nope", "approve").error.startsWith("no-such-request"));
});
t("bad decision is refused", () => {
  const id = ap.listPending(ws)[0].id;
  assert.equal(ap.decidePending(ws, id, "maybe").error, "bad-decision");
});
t("survives a fresh read", () => {
  assert.ok(ap.listPending(ws, { all: true }).length >= 3);
});

fs.rmSync(ws, { recursive: true, force: true });
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
