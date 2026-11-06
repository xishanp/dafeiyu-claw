// Every module binding index.js uses must actually be imported.
//
// Why this file exists: on 2026-11-06 `horizon` was used in seven places inside
// index.js — both `horizon_*` tools and the domain note in the browse hook — and
// was never imported. Two checks passed anyway:
//
//   `node --check index.js`  — undefined variables are not syntax errors
//   loading the module       — the tool paths had never been called
//
// So the plugin loaded clean, the test suite went green, and the first time she
// called `horizon_state()` it would have thrown ReferenceError into a tool
// result that reads like the feature is broken. That is worse than a crash: it
// looks like her, not like code.
//
// A static check over the source is the only thing that catches a binding used
// in a closure that never runs during tests.

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const raw = fs.readFileSync(path.join(root, "index.js"), "utf8");

// Comments are stripped before scanning, in one pass, tracking block state.
//
// Two earlier attempts failed in instructive ways. A regex for block comments
// over the whole file matched from the first `/*` in the body to a later `*/`,
// which swallowed all 35 import lines and reported every module as missing.
// Scanning raw source instead reported `self` as missing purely because a
// comment quoted the `self.load(...)` line that had just been fixed. A detector
// that cannot tell code from prose about code fights the notes that explain it.
const src = (() => {
  const out = [];
  let inBlock = false;
  for (const line of raw.split("\n")) {
    let kept = "";
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const close = line.indexOf("*/", i);
        if (close === -1) { i = line.length; break; }
        inBlock = false;
        i = close + 2;
        continue;
      }
      const open = line.indexOf("/*", i);
      const slash = line.indexOf("//", i);
      if (slash !== -1 && (open === -1 || slash < open)) {
        kept += line.slice(i, slash);
        i = line.length;
        break;
      }
      if (open !== -1) {
        kept += line.slice(i, open);
        inBlock = true;
        i = open + 2;
        continue;
      }
      kept += line.slice(i);
      break;
    }
    out.push(kept);
  }
  return out.join("\n");
})();

/** Module identifiers imported as `import * as X from "./lib/x.js"`. */
function namespaceImports(text) {
  const out = new Map();
  for (const m of text.matchAll(/^import \* as (\w+) from "\.\/lib\/([\w.-]+)"/gm)) {
    out.set(m[1], m[2]);
  }
  return out;
}

test("index.js: 每个 lib 命名空间都在 import 里声明过", () => {
  const imported = namespaceImports(src);

  // Identifiers that are never module namespaces.
  const reserved = new Set([
    "fs", "os", "path", "spawnSync", "URL", "Buffer", "process", "console",
    "JSON", "Math", "Date", "Number", "String", "Object", "Array", "Promise",
    "Error", "Set", "Map", "Boolean", "RegExp", "Intl", "parseInt", "parseFloat",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "structuredClone",
    "AbortController", "TextEncoder", "TextDecoder",
  ]);

  // `x.someMethod(` where x is a lowercase identifier followed by a dot and a
  // word that looks like a module export (not a chain like `a.b.c`).
  const used = new Set();
  for (const m of src.matchAll(/(?<![.\w$])([a-z][A-Za-z0-9_]*)\.\w+\s*\(/g)) {
    const name = m[1];
    if (reserved.has(name)) continue;
    if (imported.has(name)) continue;
    used.add(name);
  }

  // Only names that are known lib module basenames count as suspects. A local
  // variable like `target` or `params` shows up in the same pattern and is fine.
  const libFiles = new Set(
    fs.readdirSync(path.join(root, "lib")).filter((f) => f.endsWith(".js")),
  );
  const libBasenames = new Set([...libFiles].map((f) => f.replace(/\.js$/, "")));

  // A lib basename is only a suspect if the identifier is never declared locally.
  //
  // `lib/text.js` and `lib/self.js` exist, and index.js has both `const text =`
  // and `self` as an object field. Without this guard the check reported two
  // false positives on its first run, and a check that cries wolf gets deleted
  // rather than fixed — which is how the real bug survived in the first place.
  //
  // Declarations searched: parameter lists, `const/let/var name`, and
  // destructuring. Anything declared anywhere in the file counts; the binding
  // question is "is this name resolvable", not "in which scope".
  const declared = new Set();
  for (const m of src.matchAll(/(?:const|let|var)\s+([a-z][A-Za-z0-9_]*)\s*=/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const n = part.split(":").pop().trim().split("=")[0].trim();
      if (/^[a-z][A-Za-z0-9_]*$/.test(n)) declared.add(n);
    }
  }
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split("=")[0].trim();
      if (/^[a-z][A-Za-z0-9_]*$/.test(n)) declared.add(n);
    }
  }
  for (const m of src.matchAll(/function\s*[\w$]*\s*\(([^()]*)\)/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split("=")[0].trim();
      if (/^[a-z][A-Za-z0-9_]*$/.test(n)) declared.add(n);
    }
  }

  const missing = [...used].filter(
    (n) => libBasenames.has(n) && !imported.has(n) && !declared.has(n),
  );
  assert.deepEqual(
    missing,
    [],
    `这些名字当成模块用了但没有 import：${missing.join(", ")}。` +
      "语法检查和模块加载都抓不到，只有真正调用时才会 ReferenceError。",
  );
});

test("index.js: horizon 与 compulsion 都真的 import 了", () => {
  const imported = namespaceImports(src);
  for (const name of ["horizon", "compulsion", "experience", "activities"]) {
    assert.ok(imported.has(name), `${name} 没有被 import`);
  }
});
