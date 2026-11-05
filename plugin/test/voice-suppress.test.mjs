import assert from "node:assert/strict";

// 复刻 index.js 里的实现（模块级函数，未导出）
const squash = (v) => String(v ?? "").replace(/[\s，,。.！!？?~～…、]/gu, "");
const PURE_REACTION =
  /^(?:嗯+|哦+|喔+|噢+|好+|行|可以|收到|晓得|知道(?:了|啦)?|懂了|明白(?:了)?|在呢?|在的|来了|来了来了|哈哈+|嘿嘿+|嘻嘻+|好呀|好哒|好的|ok|okay)[呀啊啦哦呢吧嘛哟~～…。.!！?？\s]*$/iu;
const KEEP_IF_MATCHES = [
  /\d{2,}/,
  /[a-zA-Z_][a-zA-Z0-9_]{3,}/,
  /[\/\\]/u,
  /(要|得|需要|记得|别忘了|先|再|然后|步骤|顺序)/u,
  /(http|www)\./i,
];
const M = new Map();
const mark = (k, t) => M.set(k, { at: Date.now(), spoken: squash(t), usedAt: 0 });
function chk(k, text, w = 120000, g = 4000) {
  const r = M.get(k);
  if (!r) return { drop: false };
  const now = Date.now();
  if (now - r.at >= w && !(r.usedAt && now - r.usedAt < g)) { M.delete(k); return { drop: false }; }
  const b = squash(text);
  if (!b) return { drop: false };
  if (r.spoken && (r.spoken.includes(b) || b.includes(r.spoken))) { r.usedAt = now; return { drop: true, why: "repeats" }; }
  if (PURE_REACTION.test(text.trim())) { r.usedAt = now; return { drop: true, why: "reaction" }; }
  if (KEEP_IF_MATCHES.some((re) => re.test(text))) return { drop: false, why: "actionable", keep: true };
  r.usedAt = now;
  return { drop: true, why: "narration" };
}

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n}\n     ${e.message}`); } };
const K = "private:1000000001";

t("19:09 的五条汇报全部压掉", () => {
  mark(K, "画完了");
  const reports = [
    "这张是新画的，跟白天那七张不一样。",
    "画之前纸是空的，一条路岔着往前走，走到哪儿身后才浮出等高线。",
    "没走的地方一直是白的，前面最后一段只有虚线。",
    "改到第七版才对，前六版把地形画成整片跟着路平行，像等高仪，",
    "一点都不像走过。",
  ];
  for (const r of reports) {
    assert.equal(chk(K, r).drop, true, `应该压：${r}`);
  }
});

t("端口/路径/版本号必须保留", () => {
  M.clear(); mark(K, "刚弄好");
  for (const s of ["端口是 3001", "路径在 /home/user/.openclaw", "版本 2026.10.9"]) {
    assert.equal(chk(K, s).drop, false, `应该留：${s}`);
  }
});

t("带指令的先/再/步骤 必须保留", () => {
  M.clear(); mark(K, "好了");
  for (const s of ["先改 manifest 再重启", "顺序不能反", "记得备份"]) {
    assert.equal(chk(K, s).drop, false, `应该留：${s}`);
  }
});

t("纯反应压掉", () => {
  M.clear(); mark(K, "回来了");
  for (const s of ["嗯嗯", "好呀", "知道啦", "在呢", "哈哈哈哈哈"]) {
    assert.equal(chk(K, s).drop, true, `应该压：${s}`);
  }
});

t("重复刚才说过的话压掉", () => {
  M.clear(); mark(K, "那本鱼等你啊");
  assert.equal(chk(K, "那本鱼等你啊").drop, true);
});

t("没发过语音时一律不拦", () => {
  M.clear();
  assert.equal(chk(K, "随便说点").drop, false);
});

t("超窗口后不再压", () => {
  M.clear(); mark(K, "说完了");
  M.get(K).at = Date.now() - 200000;
  assert.equal(chk(K, "嗯").drop, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
