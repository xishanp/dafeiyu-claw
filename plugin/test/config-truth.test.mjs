// Config/docs truth check: does what we SAY match what we DO?
//
// This file exists because of a specific, repeated failure. On 2026-11-05 the
// same class of mistake showed up four separate times in one day:
//
//   1. The voice cooldown was removed in code (VOICE_COOLDOWN_MS = 0) but three
//      comments and one tool description still promised "at least 5 minutes".
//   2. `unlimited` defaulted to true and returned before every pacing check, so
//      a config full of careful numbers did nothing — and it was not declared in
//      the schema, so it could not be turned off at all.
//   3. `dailyCap` was declared in the schema with a friendly description, but no
//      code path ever read it.
//   4. `familiarity` was charged for our own outgoing turns, so talking to
//      herself raised intimacy and fed the gate that decides whether to speak.
//
// Each one is a promise the code did not keep. A comment cannot fail a build, so
// none of them were caught by the existing tests. These assertions compare the
// source against itself.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const manifest = JSON.parse(read("openclaw.plugin.json"));
const INDEX = read("index.js");
const PROACTIVE = read("lib/proactive.js");

const proProps = manifest.configSchema.properties.proactive.properties;

let pass = 0;
const fail = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log("\n=== config / docs truth ===");

// ---------------------------------------------------------------------------
// 1. A schema key that no code reads is a lie to whoever configures it.
// ---------------------------------------------------------------------------
check("every proactive schema key is read by code", () => {
  const declared = Object.keys(proProps);
  // Keys intentionally accepted-but-ignored must say so in their description.
  const deprecated = declared.filter((k) =>
    String(proProps[k].description || "").includes("已废弃"),
  );

  const unread = [];
  for (const key of declared) {
    if (deprecated.includes(key)) continue;
    // Look for the key being read off a config object anywhere in the source.
    // Must allow optional chaining (`cfg?.impulseTtlHours`) and bracket access.
    const pattern = new RegExp(
      `(cfg|config|proactiveCfg|cfgIn)\\s*(\\?\\.|\\.|\\[)\\s*["']?${key}\\b`,
    );
    const spreadRead = new RegExp(`\\b${key}\\b\\s*(\\?\\?|\\|\\||!==|===)`);
    if (!pattern.test(INDEX) && !pattern.test(PROACTIVE) && !spreadRead.test(PROACTIVE)) {
      unread.push(key);
    }
  }
  assert.deepEqual(
    unread,
    [],
    `schema declares keys nothing reads: ${unread.join(", ")}. ` +
      `Either read them, or mark the description 已废弃.`,
  );
});

// ---------------------------------------------------------------------------
// 2. Deprecated keys must be documented as such, not just quietly ignored.
// ---------------------------------------------------------------------------
check("dailyCap is documented as inert", () => {
  assert.ok(proProps.dailyCap, "dailyCap disappeared from schema entirely");
  assert.match(
    String(proProps.dailyCap.description || ""),
    /已废弃|不生效/,
    "dailyCap is accepted by the schema but never read; its description must say so",
  );
});

// ---------------------------------------------------------------------------
// 3. The pacing escape hatch must be reachable from configuration.
// ---------------------------------------------------------------------------
check("unlimited is declarable and defaults to enforcing", () => {
  assert.ok(
    proProps.unlimited,
    "`unlimited` is read by proactive.evaluate but absent from the schema; " +
      "with additionalProperties:false that makes it impossible to configure",
  );
  assert.equal(proProps.unlimited.type, "boolean");
  // Match only a real property in the DEFAULTS literal, not the explanatory
  // comment above it that mentions the old `unlimited: true`.
  const defaultsBlock = PROACTIVE.slice(
    PROACTIVE.indexOf("const DEFAULTS = {"),
    PROACTIVE.indexOf("};", PROACTIVE.indexOf("const DEFAULTS = {")),
  );
  assert.ok(defaultsBlock.length > 50, "DEFAULTS block not found");
  assert.match(
    defaultsBlock,
    /^\s*unlimited:\s*false\s*,?\s*$/m,
    "DEFAULTS.unlimited must be false, or every pacing gate is dead code",
  );
});

// ---------------------------------------------------------------------------
// 4. The two copies of the defaults must not drift.
// ---------------------------------------------------------------------------
check("index.js proactiveCfg agrees with lib DEFAULTS", () => {
  const block = INDEX.slice(
    INDEX.indexOf("const proactiveCfg = {"),
    INDEX.indexOf("};", INDEX.indexOf("const proactiveCfg = {")),
  );
  assert.ok(block.length > 50, "proactiveCfg block not found");

  // Strip comments: the explanation above DEFAULTS.unlimited mentions the old
  // value, and matching that text made the two sides look different.
  const stripComments = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");

  const libDefaults = stripComments(
    PROACTIVE.slice(
      PROACTIVE.indexOf("const DEFAULTS = {"),
      PROACTIVE.indexOf("};", PROACTIVE.indexOf("const DEFAULTS = {")),
    ),
  );
  const indexBlock = stripComments(block);

  const shared = ["unlimited", "bufferMinutes", "cooldownMinutes", "maxSilenceHours"];
  for (const key of shared) {
    const inIndex = new RegExp(`\\b${key}:\\s*([^,\\n]+)`).exec(indexBlock);
    const inLib = new RegExp(`\\b${key}:\\s*([^,\\n]+)`).exec(libDefaults);
    assert.ok(inIndex, `${key} missing from index.js proactiveCfg`);
    assert.ok(inLib, `${key} missing from lib/proactive.js DEFAULTS`);
    assert.equal(
      inIndex[1].trim(),
      inLib[1].trim(),
      `${key} default differs: index.js has ${inIndex[1].trim()}, ` +
        `lib/proactive.js has ${inLib[1].trim()}. One path would enforce a ` +
        `different rule than the other.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. No prose may promise a voice cooldown that the code does not enforce.
// ---------------------------------------------------------------------------
check("no voice cooldown is advertised while it is disabled", () => {
  const disabled = /const\s+VOICE_COOLDOWN_MS\s*=\s*0\b/.test(INDEX);
  if (!disabled) return; // a real cooldown is back; the prose may describe it

  // Tool descriptions and user-visible strings, NOT comments. Comments that
  // explain the removal are correct and must stay.
  const stringLiterals = INDEX.match(/"[^"\n]*"|`[^`\n]*`/g) || [];
  const offenders = stringLiterals.filter(
    (lit) => /分钟/.test(lit) && /(冷却|隔)/.test(lit) && !/已废弃|不再|没有了/.test(lit),
  );
  assert.deepEqual(
    offenders,
    [],
    `VOICE_COOLDOWN_MS is 0 but these strings still promise a cooldown: ` +
      offenders.join(" | "),
  );
});

// ---------------------------------------------------------------------------
// 6. Familiarity belongs to the other side.
// ---------------------------------------------------------------------------
check("no outbound hook charges familiarity", () => {
  const lines = INDEX.split("\n");
  const hookBody = (start) => {
    let depth = 0;
    let seen = false;
    for (let i = start; i < lines.length; i += 1) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth += 1; seen = true; }
        else if (ch === "}") {
          depth -= 1;
          if (seen && depth === 0) return lines.slice(start, i + 1).join("\n");
        }
      }
    }
    return lines.slice(start).join("\n");
  };

  for (const name of ["reply_payload_sending", "message_sent", "agent_end"]) {
    const starts = lines
      .map((l, i) => (l.includes(`api.on("${name}"`) ? i : -1))
      .filter((i) => i >= 0);
    assert.ok(starts.length > 0, `${name} hook not found`);

    for (const start of starts) {
      const code = hookBody(start)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .map((l) => l.replace(/\/\/.*$/, ""))
        .join("\n");
      assert.ok(
        !code.includes("relations.touch("),
        `${name} calls relations.touch(): familiarity must come from THEIR ` +
          `messages only. Charging our own turn let proactive output raise ` +
          `intimacy, which feeds the gate deciding whether to speak again.`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 7. The status tool must not describe itself as having no limits.
// ---------------------------------------------------------------------------
check("proactive_state does not claim 'no limit'", () => {
  const idx = INDEX.indexOf('factory("proactive_state"');
  assert.ok(idx > 0, "proactive_state tool not found");
  const body = INDEX.slice(idx, idx + 2500);
  assert.ok(
    !/不限次数/.test(body),
    "proactive_state still prints 不限次数; with unlimited now false that is " +
      "false, and the character reads this string to decide how to behave",
  );
});

console.log(`\n=== ${pass} passed, ${fail.length} failed ===`);
if (fail.length) {
  for (const f of fail) console.error("  " + f);
  process.exit(1);
}
