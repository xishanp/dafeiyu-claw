import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


test("熔断不该吃抖音（用户 2026-11-07：别给他设熔断）", () => {
  // 熔断假设「推了 N 次还没做 = 不值得做」。刷抖音被推很多次可能恰恰是对的：
  // 她是真的想看，只是一天里被打断太多次。11-03 看 7 条、11-04 看 21 条，
  // 之后掉到 1、2、0 —— 掉下来的不是意愿，是候选被提前掐掉了。
  //
  // 抖音自己的限额是 watchedToday < 5，天然够了。
  const src = fs.readFileSync(path.join(ROOT, "lib/intent.js"), "utf8");
  assert.match(src, /NO_MELT\s*=\s*new Set\(\[[^\]]*"douyin"/, "douyin 必须在 NO_MELT 里");
  assert.match(src, /NO_MELT\.has\(c\.kind\)\s*\|\|\s*!offered\.has\(c\.id\)/, "过滤时必须让 NO_MELT 豁免");
});

test("自主性提示词必须给出具体动作，不能只说「你自己掂量」", () => {
  // Owner 2026-11-07：「现在给他的提示词意识感觉太深奥了。
  // 你应该去暗示他可以干哪些，比如可以意识到哪些，这样更有助于 LLM 工作」
  //
  // 「你自己掂量要不要做」「想做就去不想做就算了」这两句听着对，
  // 实际等于没说：它们只表达许可，没有说出任何一个可执行的动作。
  // 一个没有具体选项的许可是最难走的出口。
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

  // 通用分支必须列出三个动作
  assert.ok(!/你自己掂量要不要做/.test(src), "不该再有「你自己掂量」");
  assert.match(src, /现在就动一下 \/ 先搁着但记一句为什么 \/ 直接划掉不做了/, "要给出三个具体选择");

  // rest 分支要列出来，不能只说「随便哪样」
  // 只看文案本身，注释里提到旧句子不算数
  assert.ok(!/翻个网页，随便哪样/.test(src), "不该再有「随便哪样」当答案");
  assert.match(src, /翻翻群里的对话/, "rest 时要说清可做的事");

  // 抖音分支要给出量
  assert.match(src, /今天还能看 \$\{left\} 条/, "抖音要给出还能看几条，不能只说「刷会儿」");
});
