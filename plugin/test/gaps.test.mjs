// 缺口：她注意到了但说不通的事。
//
// 这一组钉的是"好奇心"和"查字典"的区别。旧抽取器只认大写英文词，实测在
// 113 句真实日记里 19 句是问题，它一句都抽不出来——因为问题里没有名词。
import { test } from "node:test";
import assert from "node:assert/strict";

import * as gaps from "../lib/gaps.js";

test("缺口：没人回答的问题被认出来", () => {
  // 这一句是真实日记里的原话。
  assert.equal(gaps.isOpenQuestion("为什么我给你发消息你却收不到呢"), true);
  assert.equal(gaps.isOpenQuestion("你现在平时无聊都干嘛呀？"), true);
  // 没有问号也算，因为有疑问词。
  assert.equal(gaps.isOpenQuestion("为什么手机用久了会变卡"), true);
});

test("缺口：自问自答不算缺口", () => {
  // 「因为…所以…」已经把问题答了，再记就变成永远关不掉的待办。
  assert.equal(gaps.isOpenQuestion("为什么会卡，因为内存不够"), false);
});

test("缺口：陈述句不算问题", () => {
  assert.equal(gaps.isOpenQuestion("今天天气不错"), false);
  assert.equal(gaps.isOpenQuestion("有啥好笑的"), false);
});

test("缺口：前后矛盾能抓出来", () => {
  const prior = [{ what: "我特别讨厌香菜" }];
  const found = gaps.find("我最近喜欢上香菜了", { prior });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "mismatch");
  assert.match(found[0].about, /讨厌香菜/);
});

test("缺口：没改口就不算矛盾", () => {
  const prior = [{ what: "我特别讨厌香菜" }];
  assert.equal(gaps.find("我还是讨厌香菜", { prior }).length, 0);
  // 说的是别的事，也不能硬配。
  assert.equal(gaps.find("我今天吃了饭", { prior }).length, 0);
});

test("缺口：单字主语靠后缀匹配，不误伤", () => {
  // 烟 是 抽烟 的后缀，同一个东西。
  const prior = [{ what: "我戒了烟" }];
  assert.equal(gaps.find("我又开始抽烟了", { prior })[0].kind, "mismatch");
  // 但 上/下/了 这类不能当成主语。
  assert.equal(gaps.find("我去了超市", { prior }).length, 0);
});

test("缺口：没人解释的名字记下来，解释过的不记", () => {
  assert.equal(gaps.find("群里有人说要做个 DAO 的东西")[0].about, "DAO");
  // 「是」已经把话说完了，这就不是缺口。
  assert.equal(gaps.find("Zink 是 Mesa 里的驱动").length, 0);
});

test("缺口：小写词不当名词，但走问句路仍会记", () => {
  // 词形分不出 remotion 和 morning，所以不猜。
  assert.equal(gaps.namesIn("今天很 morning").length, 0);
  // 但作为问题它照样进来——前提是这句话是她自己说的。
  assert.equal(gaps.find("这个 remotion 是什么原理啊", { speaker: "self" })[0].kind, "question");
});

test("缺口：别人问她的问题不算她想弄明白的事（2026-11-06 打转根因）", () => {
  // 这个 bug 让打转活过了之前每一次修复。用户写了「小鲸鱼在干嘛呢？研究如何
  // 用电饭煲做白饭吗⚆_⚆」，gaps 记成 question，curiosity 给了 0.7 权重，
  // 于是每一轮都推给她。六轮里她选了三次，每次都撞到连击报警线；
  // 报警只能换一个候选，换完这条又回来，因为没有任何东西会移除它。
  //
  // 被她人问是一句要回答的话，不是一片要探索的空白。
  const asked = "小鲸鱼在干嘛呢？研究如何用电饭煲做白饭吗⚆_⚆";
  assert.equal(gaps.find(asked, { speaker: "other" }).length, 0, "别人问她，不该记为缺口");
  assert.equal(gaps.find(asked, { speaker: "self" }).length, 1, "她自己问的，要记");

  // 真正该保留的：对话里出现陌名词。这是 question 来源的本意。
  const dangling = gaps.find("群里有人说要做个 DAO 的东西", { speaker: "other" });
  assert.ok(dangling.length > 0, "陌生名字仍然要记");
});

test("缺口：权重按种类分档，问题不该等第二次", () => {
  assert.ok(gaps.weight("mismatch") > gaps.weight("question"));
  assert.ok(gaps.weight("question") > gaps.weight("dangling"));
});

test("缺口：一句最多三条，不刷屏", () => {
  const found = gaps.find("为什么 A 是啥 B 怎么用 C 呢", { max: 2 });
  assert.ok(found.length <= 2);
});

// ---- 网页包装壳不是名字（2026-11-06 重启后首次实测发现）----
import * as extract from "../lib/curiosity-extract.js";

test("抽取：web_fetch 的包装标记不算名字", () => {
  const junk = "<EXTERNAL_UNTRUSTED_CONTENT>\n来源: www.gotohui.com\n[show-819136]\n正文 Poincaré\n</EXTERNAL_UNTRUSTED_CONTENT>";
  const got = extract.fromSpeech(junk, { max: 5 });
  assert.ok(!got.includes("EXTERNAL_UNTRUSTED_CONTENT"), `包装标记混进来了：${got}`);
  assert.ok(!got.includes("www.gotohui.com"), `域名混进来了：${got}`);
  assert.ok(!got.includes("show-819136"), `生成的 id 混进来了：${got}`);
  assert.ok(got.includes("Poincaré"), `正文里的名字该留下：${got}`);
});

test("抽取：全大写但不是常量要留下", () => {
  assert.deepEqual(extract.fromSpeech("聊到 DSH 和 DAO", { max: 5 }).sort(), ["DAO", "DSH"]);
});

test("抽取：带数字的产品名不能被过滤", () => {
  assert.ok(extract.fromSpeech("试试 gpt-4.1", { max: 5 }).includes("gpt-4.1"));
  assert.ok(extract.fromSpeech("用 node.js 跑", { max: 5 }).includes("node.js"));
});

test("抽取：URL 拼音 slug 不算名字", () => {
  assert.deepEqual(extract.fromSpeech("xinxiangshi_pingyuanshifanqu", { max: 3 }), []);
});
test("抽取：短蛇形标识保留", () => {
  assert.ok(extract.fromSpeech("my_var 这个变量", { max: 3 }).includes("my_var"));
});
test("抽取：网页标记词不算名字", () => {
  assert.deepEqual(extract.fromSpeech("raw-html", { max: 3 }), []);
});
test("抽取：纯 hex 哈希不算名字", () => {
  assert.deepEqual(extract.fromSpeech("c3a70b7340439b77", { max: 3 }), []);
});
