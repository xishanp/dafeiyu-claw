// `if (urges.length)` where urges is an object is always false.
//
// This exact mistake shipped in before_prompt_build and killed the only path
// from a feeling to an action: happy/bored/curious/down could never produce
// 「这会儿的劲头」. Verified 2026-11-06 by `{a:1}.length === undefined` and by
// zero probe records for the path.

import assert from "node:assert/strict";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n     ${e.message}`); }
};

const dd = { happy: 0.5, excited: 0.4, bored: 0.2, curious: 0.6, down: 0, wronged: 0 };

const urgesFor = (d) => ({
  happy: (d.happy > 0.62 || d.excited > 0.55) ? "这会儿心里是亮的，有点想让人看见" : null,
  bored: d.bored > 0.42 ? "闲得有点发空，手上想找点事" : null,
  curious: d.curious > 0.66 ? "对什么东西起了好奇心" : null,
  down: (d.down > 0.45 || d.wronged > 0.3) ? "心里堵着，想找点能自己待着的事" : null,
});

const fires = (d) => Object.values(urgesFor(d)).some(Boolean);

t("对象没有 length —— 这就是原 bug", () => {
  const u = urgesFor(dd);
  assert.equal(u.length, undefined);
  assert.equal(Boolean(u.length), false, "旧写法永远为假");
});

t("修正后的判定在平静时不开火", () => {
  assert.equal(fires(dd), false);
});

t("开心超过门槛会开火", () => {
  assert.equal(fires({ ...dd, happy: 0.8 }), true);
});

t("兴奋超过门槛也会", () => {
  assert.equal(fires({ ...dd, excited: 0.6 }), true);
});

t("无聊超过门槛", () => {
  assert.equal(fires({ ...dd, bored: 0.5 }), true);
});

t("好奇超过门槛", () => {
  assert.equal(fires({ ...dd, curious: 0.7 }), true);
});

t("低落超过门槛", () => {
  assert.equal(fires({ ...dd, down: 0.5 }), true);
});

t("委屈超过门槛", () => {
  assert.equal(fires({ ...dd, wronged: 0.35 }), true);
});

t("只挑一个，不会同时给两条矛盾指令", () => {
  const pick = (d) => {
    const u = urgesFor(d);
    const ranked = [
      { key: "down", v: Math.max(d.down ?? 0, (d.wronged ?? 0) * 0.9) },
      { key: "bored", v: d.bored ?? 0 },
      { key: "curious", v: (d.curious ?? 0) * 0.9 },
      { key: "happy", v: Math.max(d.happy ?? 0, d.excited ?? 0) },
    ].filter((r) => u[r.key] && r.v > 0).sort((a, b) => b.v - a.v);
    return { count: ranked.length, lead: ranked[0]?.key };
  };

  // Real shape measured 2026-11-06: happy 0.75 leads over curious 0.53 /
  // down 0.34. That is the case that actually occurs.
  assert.equal(pick({ happy: 0.75, excited: 0.48, curious: 0.53, down: 0.34, wronged: 0.25, bored: 0.05 }).lead, "happy");

  // `down` outranks an equal `happy` on purpose: the weights are not
  // symmetric (curious is discounted 0.9, down gets wronged added in). Do not
  // "fix" this to happy — asserting the real ordering is the point.
  assert.equal(pick({ happy: 0.9, excited: 0, bored: 0, curious: 0, down: 0.9, wronged: 0 }).lead, "down");

  // Never more than one line even when all four are live.
  const all = pick({ happy: 0.9, excited: 0.9, bored: 0.9, curious: 0.9, down: 0.9, wronged: 0.9 });
  assert.equal(all.count, 4, "四条都活着，但只取第一条");
  assert.ok(["happy", "down", "bored", "curious"].includes(all.lead));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
