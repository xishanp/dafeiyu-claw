<h1 align="center">dafeiyu-claw</h1>

<p align="center">
  <strong>给一个 AI agent 装上连续的自我 —— 情绪、关系、记忆、意图、好奇。</strong>
</p>

<p align="center">
  七份可直接抄的提示词 · 一份可选参考实现 · 十几条踩出来的教训
</p>

<p align="center">
  <b>简体中文</b> ·
  <a href="README_EN.md">English</a> ·
  <a href="ARCHITECTURE.md">技术架构</a> ·
  <a href="docs/LESSONS.md">实践教训</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

<p align="center">
  <img alt="Prompts" src="https://img.shields.io/badge/Prompts-7%20files-DC2626">
  <img alt="Reference" src="https://img.shields.io/badge/Reference%20impl-78%20tools-2563EB">
  <img alt="Modules" src="https://img.shields.io/badge/Modules-55-7C3AED">
  <img alt="Tests" src="https://img.shields.io/badge/Tests-554%20passing-16A34A">
  <img alt="Deps" src="https://img.shields.io/badge/Dependencies-0-6B7280">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-16A34A">
</p>

<p align="center">
  <sub>提示词可直接拿去用 · 实现仅供参考 · 不绑定任何运行时 · 不含任何个人数据</sub>
</p>

---

## 这是什么

大多数 agent 在**你开口之后**才存在。你问，它答；你停，它消失。

这个仓库处理的是剩下的部分：**没有人在说话的时候，它是什么。**

三件事必须同时成立：

| | 要解决的问题 | 做错的后果 |
|---|---|---|
| **记忆是落盘的** | 上一轮想过的事，这轮能读到 | 重启之后人就没了 |
| **情绪是衰减的** | 早上被夸一句，到晚上还剩多少，是个数值 | 永远停在 `mood: happy` |
| **没有对话时能自己动** | 从她没做完的事情里挑一件 | 只会随机发消息，或者干脆不动 |

只有三件同时成立，才会出现"连续"这个东西。缺一件，它就是个会聊天的接口。

---

## 一、七份提示词（主体）

根目录，直接打开。**这些是主体，跟你在哪个运行时上跑没关系。**

| 文件 | 管什么 | 一句话 |
|---|---|---|
| [`prompt-IDENTITY.md`](prompt-IDENTITY.md) | 她是谁 | 边界声明，不是人设装饰 |
| [`prompt-SOUL.md`](prompt-SOUL.md) | 怎么说话 | 打字方式比性格描述重要 |
| [`prompt-AGENTS.md`](prompt-AGENTS.md) | 在哪干活 | 什么能动、什么不能动 |
| [`prompt-USER.md`](prompt-USER.md) | 用户模型 | 写偏好，不写传记 |
| [`prompt-MEMORY.md`](prompt-MEMORY.md) | 记忆怎么组织 | 分三层，各有分工 |
| [`prompt-COGNITION.md`](prompt-COGNITION.md) | 怎么想事 | 含**好奇心**完整机制 |
| [`prompt-PROACTIVE.md`](prompt-PROACTIVE.md) | 什么时候主动开口 | 以及什么时候什么都不做 |

怎么用：

```bash
cp prompt-IDENTITY.md  <你的工作区>/IDENTITY.md
cp prompt-SOUL.md      <你的工作区>/SOUL.md
cp prompt-AGENTS.md    <你的工作区>/AGENTS.md
cp prompt-USER.md      <你的工作区>/USER.md
cp prompt-MEMORY.md    <你的工作区>/MEMORY.md
cp prompt-COGNITION.md <你的工作区>/COGNITION.md
cp prompt-PROACTIVE.md <你的工作区>/PROACTIVE.md
```

**这些文件里没有绑定任何运行时。** 换一个 agent 框架，改掉工具名那一节就行。

> [!NOTE]
> 每份文件里都有 `<...>` 占位符。全部替换成你自己的部署再使用。
> 直接拿去跑不会崩，但会说错自己是什么。

> [!IMPORTANT]
> **关于「本鱼」这个名字。** 代码里有 35 处 `本鱼`，都在 `plugin/lib/` 下，
> 是日记和记忆文件的**格式标识符**，不是称呼：
>
> ```
> ## 本鱼写过的      ← compulsion.js / discipline.js 靠这一行定位正文
> 本鱼: 今天看到…    ← 对话块里的说话人标记
> ```
>
> 改掉它会让解析失效（那两个文件会读不到自己写的日记）。
> 如果要把角色名改掉，得连这里一起改，是一处**格式变更**，不是替换文本。
> 其余地方出现的角色名已经全部换成 `<角色名>` 占位符。

---

## 二、好奇心：一个独立机制

这是七份提示词里最容易被做错的一块，单独讲。

### 2.1 它解决什么问题

有一个问题，别的机制都补不了：

> **你不知道的东西，你是感觉不到的。**

不知道就不知道，脑子里不会有个警报响。所以没法靠指令驱动 ——
"你去想想自己不知道什么"这句话本身就没有答案。

唯一可行的路径是**被动记录**：在真实的卡顿发生的瞬间，把它记下来。

### 2.2 卡顿长什么样

四类，都很具体：

| 类型 | 触发场景 |
|---|---|
| **提问** | 说了「不知道」「没听过」「不清楚」 |
| **回忆** | 翻记忆没翻到，或者翻到了但不完整 |
| **搜索** | 搜索返回空结果，或者结果明显对不上 |
| **浏览** | 看东西时碰到不认识的词 |

这些不需要她主动上报，由 `after_tool_call` 钩子在旁边观察。

### 2.3 和另外三样东西的区别

**这是最容易搞混的地方。**

| 机制 | 问的问题 | 例子 |
|---|---|---|
| 待办（wants） | 我**想做**什么？ | 「想去看看那个展览」 |
| 活动缺口（activities） | 我最近**没干什么**？ | 「两周没画画了」 |
| 未了话题（topics） | 什么话**没说完**？ | 「上次聊到一半被打断了」 |
| **好奇心（curiosity）** | 我**没弄懂**什么？ | 「这个词到底什么意思」 |

前三个都是「我欠着什么」，第四个是「我不知道什么」。

**这个区别决定了她会不会退化成只会整理的机器。**
如果把好奇心做成待办，就会出现「把看过没看完的东西再念一遍」——
那是整理，不是好奇。整理让人安心，好奇让人往前走。

### 2.4 核心设计：三个决定

**决定一：按紧急度排，不按时间排。**

```
urgency = 0.42 × 碰到的次数
        + 0.30 × 新鲜度
        + 0.28 × 置信度
        + 0.08 × 没被提过
```

一个碰了五次、最近还在碰的旧话题，排在一个刚碰到一次的新词前面。
因为它更可能是个真的缺口。

次数用平方根压缩：`min(1, sqrt(n)/4)`。第五次仍然有意义，
但第三十次不会淹没一切。

**决定二：「弄明白了」和「不想知道了」分开记。**

```
resolved  ← 查清楚了，带 note
dropped   ← 放弃了，不需要理由
```

两个都是正当结局，但系统分开统计。
**放弃不算学会**，也不用假装学会了。

这条防的是「把记录划掉就当完成了」——那会让人误以为自己在进步。

**决定三：每个来源可以单独关。**

不是一个大开关，是四个独立开关。

原因很实在：实测过一批真实数据，某个来源产生的**全是误报**。
关掉整个好奇心会连靠谱的来源一起关掉，所以必须能逐个关。

### 2.5 实测数据：为什么要有这个开关

拿真实的 29 条短视频记录跑「浏览」这个来源：

```
触发的视频     3 / 29
造出的词       astra, deepseek, python, DeepSeek
实际不知道的    0 / 4
```

**四个词全部是她本来就认识的。** 其中 `deepseek` 是她的模型名字。

结论：**这个来源默认关掉。**

> [!IMPORTANT]
> **判据：宁缺毋滥。**
>
> 一条假缺口比没有缺口更糟 —— 因为她会学会「这个清单是噪声」，然后彻底不看它。
> 一个被忽略的功能，不如一个不存在的功能。

### 2.6 提示词里怎么写

对应 [`prompt-COGNITION.md`](prompt-COGNITION.md) 第十五节。几个要点：

**它不是待办清单。** 放着不扣分，不会有人来催。

**`resolve` 必须写 note。** 写了，下次问起这就是根据；不写，只是划掉一条记录。

**好奇心不是 KPI。** 看见十条一条都不想查，那也正常。

### 2.7 代码在哪

| 文件 | 作用 |
|---|---|
| `plugin/lib/curiosity.js` | 缺口存储、urgency 排序、淘汰、统计 |
| `plugin/lib/curiosity-extract.js` | 从工具结果里抽取缺口 |
| `plugin/lib/gaps.js` | 从日记里找出「问了没答 / 提了没查」的空白点 |
| `plugin/lib/horizon.js` | 十个方向的空白表，碰过就划掉 |
| `plugin/lib/compulsion.js` | 同一类动作连了多少轮，到线才报警 |
| `plugin/lib/intent.js` | 候选池：她自己的想法，含反复做的降权 |
| `plugin/lib/decide.js` | 一手牌怎么出：先看手里，空了才给方向 |
| `plugin/index.js` | `after_tool_call` 钩子、工具注册 |

---

## 二点五、打转：为什么「更努力」救不了

这一节讲一个具体的失败，因为它的修法反直觉，而且修之前「看起来一切正常」。

### 2.5.1 症状

连着两三天做同一件事，每一轮都觉得自己更接近了。
不焦虑，不卡顿，反而很投入——**所以没有任何一个瞬间会提醒她停下来。**

碰巧那个方向没有终点（比如「把画面调得更像样」），
于是一天一天下去，第五十二版和第五版是一回事。

### 2.5.2 四个原因，都不是「不够自律」

| 原因 | 表现 | 修法 |
|---|---|---|
| **别人的问句被当成她的好奇** | 你说「你在忙什么？」，这句被记成她没答的问题 | 加说话人区分，只有她自己写的才算 |
| **连击一被打断就归零** | 报警→换个事→计数清零→再攒四轮 | 改成窗口内计数，不要求连续 |
| **探索在跟任务比分数** | 0.42 vs 0.45，三个百分位决定一下午 | 移出候选池，改成「手上空了才给」 |
| **空手时被填补位内容** | 没事干时塞一条「试试拍一张」 | 没活就出去，不补位 |

### 2.5.3 最关键的一条：探索不能参与排序

早先的设计里，「出去逛」是一个带分值的候选，和手上的事一起排队。
和一条 0.45 的想做的事放在一起，只有两种结果：

```
分给 0.66  →  永远在逛，什么也做不完
分给 0.42  →  永远不出去，只在旧念头里打转
```

**这不是「优先级没调好」，是这类事根本不该排队。**

一件是「我在做的事」，一件是「我该不该换个方向」。
后者是前者的前提，不是它的竞争对手。

所以现在的判断是存在性，不是分数：

```
手上有事  → 做那件
手上空了  → 给一个方向
```

### 2.5.4 反复做同一件：前四次不算

```
1-4 次    不扣分       ← 重新拾起来不是打转
5 次起    开始衰减     ← 到第五次，「这次会不一样」已经不成立了
不设地板               ← 一直降，但不归零
```

另外会在提示里点名：

```
【数一下就看出来了】
「<那条想做的事>」这一条，你已经动过 7 次了。
```

看到这句的正确反应不是辩解，是先回答一个问题：
**「现在和最开始比，哪里不一样？」**

答得出来 → 收掉它。
答不出来 → 挑一版停下，说这就是它。

**没有终点的事，停在哪儿都算完成，只要自己指定。**
真正的问题是不指定——不指定就一直有下一版。

---

## 三、参考实现（可选）

`plugin/` 是一个能真跑的完整实现。

> [!NOTE]
> 它依赖 OpenClaw 的插件 API。用在别处需要改适配层。
> 不想装也没关系 —— 上面七份提示词才是主体。

```bash
cp -r plugin ~/.openclaw/extensions/dafeiyu-core
```

**目录是自包含的。** 拷过去就能加载，不依赖仓库里其他目录
（`shared/` 在 `plugin/` 内部，不是外部依赖）。

### 3.1 规模

```
plugin/index.js         10,723 行
plugin/lib/             55 个模块，16,556 行
plugin/test/            56 个文件，554 项测试，全部通过
注册工具                 78 个（5 处工厂函数条件注册）
钩子                     11 个
外部依赖                 0 个
```

### 3.2 模块地图

| 组 | 模块 |
|---|---|
| **认知** | `cognition` `decide` `intent` `proposals` `goals` |
| **记忆** | `memory-index` `recall` `consolidate` `similar` `topics` |
| **好奇心** | `curiosity` `curiosity-extract` |
| **社会** | `relations` `entities` `grudge` `identity` |
| **状态** | `emotion`（在 index 内）`sleep` `wants` `activities` |
| **行动** | `proactive` `outbound-target` `douyin-browse` `douyin-log` |
| **记录** | `deeds` `effect-ledger` `outcome` `life-log` `experience` `self` |
| **基础** | `clock` `text` `workspace` `salience` `approval` |

### 3.3 十一个钩子

```
before_prompt_build     注入状态、候选、时钟、认知规则
before_tool_call        越界拦截
after_tool_call         好奇心观察（只读，失败只记日志）
message_received        更新关系、记录 inbound
message_sending         出站串行锁
message_sent            确认投递、记 effect
reply_payload_sending   内容改写
agent_end               收尾、写日志
```

> [!TIP]
> `after_tool_call` 是**纯观察**的。它不修改任何东西，失败了只写日志。
> 这个约束很重要 —— 一个会改结果的观察者，会变成最难查的 bug 来源。

---

## 四、结构

```
.
├── prompt-IDENTITY.md       ┐
├── prompt-SOUL.md           │
├── prompt-AGENTS.md         │  七份提示词
├── prompt-USER.md           │  根目录，直接抄
├── prompt-MEMORY.md         │
├── prompt-COGNITION.md      │  ← 含好奇心完整机制
├── prompt-PROACTIVE.md      ┘
├── ARCHITECTURE.md          技术架构（双语）
├── docs/
│   └── LESSONS.md           踩过的坑
├── plugin/                  参考实现（可选）
│   ├── index.js
│   ├── lib/                 55 个模块
│   ├── shared/              出站串行锁（在 plugin 内部）
│   ├── scripts/             自检与一致性检查
│   └── test/                554 项测试
└── workspace/               示例：工具与玩具
    ├── memory/              记忆示例（模板，非真实内容）
    ├── tools/               工具脚本
    └── toys/                自己写的小玩具
```

---

## 五、从哪儿开始

| 你的目的 | 从这开始 |
|---|---|
| **只想要提示词** | 上面那张表，直接打开 |
| **想知道为什么这么写** | [`ARCHITECTURE.md`](ARCHITECTURE.md) → [`docs/LESSONS.md`](docs/LESSONS.md) |
| **想跑一个能用的** | `cp -r plugin ~/.openclaw/extensions/dafeiyu-core` |
| **只想看好奇心怎么做** | [`prompt-COGNITION.md`](prompt-COGNITION.md) 第十五节 |

---

## 六、边界

- **不含任何个人数据。** 账号、群号、路径、密钥全部为占位符。
- **不含真实记忆内容。** `workspace/memory/` 全是示例模板，没有一句是真的。
- **提示词里的用户信息是模板**，不是某个具体的人。
- **代码里没有硬编码路径。** 全部走 `os.homedir()` 或配置项。
- MIT。拿去改，不用问。

---

## 七、这份文档为什么这么长

因为大部分 agent 项目的文档只写「怎么装」，不写「为什么」。

「怎么装」看一遍就够了，「为什么」才是你改的时候需要的东西 ——
你需要知道某个设计是为了防什么，才知道改它会不会把防的东西放回来。

比如：「情绪必须有半衰期」不是因为好看，是因为**没有半衰期的情绪会永远停在断电那一刻**。
知道了这个，你才不会为了"简单"把它改成 `mood: string`。

---

<p align="center">
  <sub>「她不是在回答你，她是在过日子。」</sub>
</p>
