// COGNITION.md is injected as a slice, not whole.
//
// The regression: whole-file injection was 15,260 characters every wake while
// the rest of the prompt was ~9,000 combined. The four longest sections (七 /
// 十三 / 十四之三 / 十四之五 = 6,942 chars) all sit past the document's halfway
// point and apply to situations that are not every wake.
//
// What must NOT regress: the omitted sections have to stay discoverable. A
// slice that silently hides rules she cannot find again is a deletion, not a cut.

import assert from "node:assert/strict";

const ALWAYS = ["总则", "你在哪儿", "一、", "二、", "三、", "四、", "五、", "六、", "八、", "十一、"];

function slice(raw, openWake, resuming) {
  const OPTIONAL = openWake ? "## 七、" : resuming ? "## 十四之三、" : null;
  const picked = [];
  const rest = [];
  for (const sec of String(raw).split(/\n(?=## )/)) {
    const title = sec.split("\n", 1)[0];
    let keep = ALWAYS.some((k) => title.startsWith(`## ${k}`));
    if (!keep && OPTIONAL && title.startsWith(OPTIONAL)) keep = true;
    if (keep) picked.push(sec.trim());
    else if (/^## /.test(title)) {
      const ord = (title.match(/^## ([一二三四五六七八九十]+)/) || [])[1];
      if (ord) rest.push(ord);
    }
  }
  const index = rest.length
    ? `\n\n（剩下的在 COGNITION.md，现在用不上，真碰到了再去读：${[...new Set(rest)].slice(0, 12).join("、")}）`
    : "";
  return (picked.length ? picked.join("\n\n") : String(raw).trim()) + index;
}

const doc = `## 总则：一轮是怎么转的
看见 留意 挑一件 记下来

## 你在哪儿
这是工作区

## 一、说过话
### 子标题
内容一

## 二、犯错要留档
内容二

## 三、有证据
内容三

## 四、卡住了
内容四

## 五、有些事值得接着做
内容五

## 六、想清楚再动
内容六

## 七、没人交代的时候干什么
很长的内容七

## 八、知道自己不知道什么
内容八

## 九、怎么会对外面的事有看法
内容九

## 十、人是怎么变的
内容十

## 十一、你有一个状态卡
内容十一

## 十二、系统递过来的那句话
内容十二

## 十三、攒下来的那些
内容十三

## 十四之三、自己想干的事
内容十四之三

## 十五、几件不需要问的事
内容十五
`;

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n     ${e.message}`); }
};

t("骨架节永远在", () => {
  const out = slice(doc, false, false);
  for (const k of ["总则", "你在哪儿", "一、", "五、", "八、", "十一、"]) {
    assert.ok(out.includes(k), `缺少 ${k}`);
  }
});

t("空手时带「七」", () => {
  const out = slice(doc, true, false);
  assert.ok(out.includes("没人交代的时候干什么"));
});

t("有活在手时不带「七」", () => {
  const out = slice(doc, false, false);
  assert.equal(out.includes("没人交代的时候干什么"), false);
});

t("有未完成的事时带「十四之三」", () => {
  const out = slice(doc, false, true);
  assert.ok(out.includes("自己想干的事"));
});

t("最多只带一节可选的，不会全带上", () => {
  const out = slice(doc, true, true);
  assert.ok(out.includes("没人交代"));
  // 七 wins; 十四之三 must not also appear as a body section.
  const body = out.split("（剩下的在")[0];
  assert.equal(body.includes("自己想干的事"), false);
});

t("被省掉的节必须在索引里点名", () => {
  const out = slice(doc, false, false);
  const tail = out.split("（剩下的在")[1] || "";
  assert.ok(tail.includes("十三"), "十三 应该出现在索引里");
  assert.ok(tail.includes("十五"), "十五 应该出现在索引里");
});

t("全部都在时索引为空", () => {
  const tiny = `## 总则
x

## 你在哪儿
y
`;
  const out = slice(tiny, false, false);
  assert.equal(out.includes("剩下的在"), false);
});

t("切片后明显短于全文", () => {
  const out = slice(doc, false, false);
  assert.ok(out.length < doc.length * 0.85, `${out.length} vs ${doc.length}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
