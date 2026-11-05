# 更新记录

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 未发布

### 新增：好奇心

一个独立的认知机制：记录她碰到过但没弄明白的事。

- `lib/curiosity.js` —— 缺口存储、紧急度排序、淘汰、统计（470 行）
- `lib/curiosity-extract.js` —— 从工具结果里抽取缺口（322 行）
- `after_tool_call` 钩子 —— 纯观察，四个来源：提问 / 回忆 / 搜索 / 浏览
- `curiosity_state` —— 列出攒着的缺口，支持 `drop` 放弃
- `curiosity_resolve` —— 关闭一条，要求写 `note`
- 提示词：`prompt-COGNITION.md` 第十五节（完整机制说明）

三个设计决定：

1. **按紧急度排，不按时间排。** 反复碰到的旧缺口排在刚出现的新词前面。
2. **`resolved` 和 `dropped` 分开记。** 放弃不算学会。
3. **每个来源独立开关。** 不是一个大开关。

### 修正

- 好奇心排序改为逐字转写参考实现：接触项比例、稀缺项按完成次数衰减、做过两次即退出候选池。
- 推荐门槛从 0.7 降到 0.2。0.7 会让「做过一次」变成「再也不提」。
- 日记游标字段名修正。此前写成 `end`、读成 `offset`，导致每轮重读整篇日记。
- `scan()` 不再冲掉 `note()` 记录的失败次数。

### 修复：七个导出函数遇坏输入会抛错

模糊测试（13 函数 × 11 种坏输入）查出 7 处：

```
urgency(null)          → 读 times_encountered 抛 TypeError
gaps(null)             → 读 limit 抛 TypeError
propose(null)          → 读 budget 抛 TypeError
fromRecall/fromWhoIs/
fromSearch/fromBrowse(null) → 解构抛 TypeError
```

修后：0 抛错。

### 修复：已知词过滤器从未被调用

接口 `fromBrowse({ text, known })` 写好了，实际调用只传 `text`。
过滤器生效但没有接入。已修复，并补了「调用方真的传了」的测试。

### 修复：中文句子里的英文词比对不上

已知词表存整句（`transformer 的注意力机制`），比对用单个词（`Transformer`），
永远不相等。已改为先把已知词组拆成拉丁词再比。

### 修复：大小写被首个写法锁死

同一个词出现 `deepseek` / `DeepSeek` / `DEEPSEEK` 时保留第一个。
已改为保留更规整的写法，但不让全大写覆盖正常大小写。

### 修复：路径硬编码

发布版本改为仓库自包含：

- `import "../shared/..."` → `"./shared/..."`
- 5 处绝对路径（`/Users/<name>/...`）改为 `os.homedir()` 或配置项
- QQ 容器目录、TTS 脚本路径改为可配置

### 变更：默认关闭「浏览」来源

真实数据实测（29 条短视频记录）：

```
触发 3 / 29，造词 4 个，实际不知道的 0 个
```

四个词全错，其中一个是它自己的模型名。默认关闭，保留开关。

### 已知问题

- `deeds.json`、`effects.json`、`experience-pool.json` 仍有多个写入者，字段归属未定。
- `lib/text.js`、`lib/workspace.js` 在 `index.js` 中无引用，可能为死代码。
- `lib/curiosity.js` 多导出了 `load`/`save`/`urgency`/`normaliseTopic`，有内部调用者，但对外不必暴露。
- 浏览来源的词表过滤仍是启发式。彻底修需要一份「已知技术名词表」，未做。

---

## 2026-11-05

首个公开版本。

### 内容

- 插件本体 6,900 行，55 个工具，9 条注入。
- 33 个模块，每个管一种状态。
- 17 个测试文件，100 项断言。
- 7 份提示词。
- 十一条实践教训。
- 她的工具与玩具源码。
