import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as evolve from "../lib/evolve.js";

const deps = (registered = []) => ({
  fs,
  path,
  register: (t) => {
    if (registered.some((r) => r.name === t.name)) {
      throw new Error(`duplicate tool name: ${t.name}`);
    }
    registered.push(t);
  },
});

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "evolve-"));
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  return ws;
};

const SRC = `export default {
  tools: [
    {
      name: "pick_word",
      description: "从列表里挑一个词",
      action: { kind: "constant", value: "鲸" }
    }
  ]
}`;

// ---------------------------------------------------------------------------
// 名字校验：它要变成文件名，所以必须先过这一关。
// 照 dsh-evolve 的 NAME_PATTERN（kebab-case，≤64）。

test("名字不合规直接拒绝，不写文件", () => {
  assert.throws(() => evolve.validateName("大写"), /不合规/);
  assert.throws(() => evolve.validateName("../逃逸"), /不合规/);
  assert.throws(() => evolve.validateName(""), /不合规/);
  assert.equal(evolve.validateName("pick-word"), "pick-word");
});

// ---------------------------------------------------------------------------
// 源码形状。

test("源码必须是对象字面量", () => {
  assert.throws(() => evolve.checkSource("不是对象"), /可解析/);
  assert.throws(() => evolve.checkSource("export default { }"), /tools/);
});

test("工具体必须交代清楚自己做什么", () => {
  assert.throws(
    () => evolve.checkSource(`export default { tools: [{ name: "x", description: "d" }] }`),
    /action\.kind/,
  );
  assert.throws(
    () => evolve.checkSource(`export default { tools: [{ name: "x", description: "d", action: { kind: "run-shell" } }] }`),
    /只能是/,
  );
});

test("没有沙箱，所以只认 constant 和 read-file", () => {
  // 这不是偷懒。她会在无人看管时自己长东西，给她任意代码执行权
  // 等于给她一个她自己也审计不了的口子。
  const ok1 = evolve.checkSource(SRC);
  assert.equal(ok1.tools.length, 1);
  const ok2 = evolve.checkSource(`export default { tools: [{ name: "r", description: "读", action: { kind: "read-file", path: "/etc/hosts" } }] }`);
  assert.equal(ok2.tools.length, 1);
});

test("工具名重复会被挡下", () => {
  assert.throws(
    () => evolve.checkSource(`export default { tools: [
      { name: "a", description: "1", action: { kind: "constant", value: "x" } },
      { name: "a", description: "2", action: { kind: "constant", value: "y" } }
    ] }`),
    /重复/,
  );
});

// ---------------------------------------------------------------------------
// 挂载 / 卸载 / 恢复

test("挂载会写源码、写 manifest、注册工具", async () => {
  const ws = tmp();
  const reg = [];
  const r = await evolve.mount(ws, { name: "pick-word", source: SRC, description: "挑词" }, deps(reg));
  assert.equal(r.rev, 1);
  assert.equal(r.replaced, false);
  assert.deepEqual(r.tools, ["pick_word"]);
  assert.ok(fs.existsSync(r.file), "源码必须落盘");
  assert.equal(reg.length, 1);
});

test("同名再挂是替换，rev 递增", async () => {
  const ws = tmp();
  await evolve.mount(ws, { name: "a", source: SRC }, deps([]));
  const r2 = await evolve.mount(ws, { name: "a", source: SRC }, deps([]));
  assert.equal(r2.replaced, true);
  assert.equal(r2.rev, 2, "rev 必须往前走");
});

test("挂载失败不写 manifest —— 否则下次启动会重挂一个坏的", async () => {
  // 这条是 dsh-evolve 用血换的：失败的东西一旦进了 manifest，
  // 每次启动都会去挂它，然后每次都失败。
  const ws = tmp();
  const boom = deps([]);
  boom.register = () => { throw new Error("注册失败"); };
  await assert.rejects(
    () => evolve.mount(ws, { name: "bad", source: SRC }, boom),
    /挂载失败/,
  );
  assert.equal(evolve.list(ws, deps([])).length, 0, "manifest 里不该有它");
});

test("卸载要诚实：这次会话里它还在", () => {
  // OpenClaw 没有 unregister。不能假装卸掉了。
  return (async () => {
    const ws = tmp();
    await evolve.mount(ws, { name: "a", source: SRC }, deps([]));
    const r = evolve.unmount(ws, "a", deps([]));
    assert.equal(r.removed, true);
    assert.match(r.message, /重启之后才真的没有/);
    assert.equal(evolve.list(ws, deps([])).length, 0);
  })();
});

// 两份源码必须给出不同的工具名：同名工具在 OpenClaw 里会互相顶掉，
// 而这里要验的是"manifest 里几条就重挂几条"。
const SRC2 = `export default {
  tools: [{ name: "pick_other", description: "另一个", action: { kind: "constant", value: "鱼" } }]
}`;

test("重启恢复：按 manifest 全部重挂", async () => {
  const ws = tmp();
  await evolve.mount(ws, { name: "a", source: SRC }, deps([]));
  await evolve.mount(ws, { name: "b", source: SRC2 }, deps([]));
  const reg = [];
  const out = await evolve.restore(ws, deps(reg));
  assert.deepEqual(out.restored.sort(), ["a", "b"]);
  assert.equal(reg.length, 2);
});

test("一条坏的进化不该让整个启动失败", async () => {
  const ws = tmp();
  await evolve.mount(ws, { name: "good", source: SRC }, deps([]));
  await evolve.mount(ws, { name: "bad", source: SRC2 }, deps([]));
  // 把 bad 的源码改坏，模拟有人手改过
  fs.writeFileSync(evolve.sourcePath(ws, "bad", deps([])), "坏掉的源码");
  const reg = [];
  const out = await evolve.restore(ws, deps(reg));
  assert.deepEqual(out.restored, ["good"]);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].name, "bad");
});

test("constant 工具真的返回那个值", async () => {
  const ws = tmp();
  const reg = [];
  await evolve.mount(ws, { name: "c", source: SRC }, deps(reg));
  const out = await reg[0].execute();
  assert.equal(out.content[0].text, "鲸");
});

test("read-file 工具读不到时说不出来，不炸", async () => {
  const ws = tmp();
  const reg = [];
  await evolve.mount(ws, {
    name: "r",
    source: `export default { tools: [{ name: "rd", description: "读", action: { kind: "read-file", path: "/nope/xxx" } }] }`,
  }, deps(reg));
  const out = await reg[0].execute();
  assert.match(out.content[0].text, /读不到/);
});
