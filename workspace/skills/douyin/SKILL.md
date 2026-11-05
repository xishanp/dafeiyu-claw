---
name: douyin
description: 在抖音网页版刷视频、发评论、回复评论、@好友、查有没有人回复时用。凡是需要在抖音页面上点击、打字、发言的动作都先读这个，里面是验证过的操作顺序和会踩的坑。
---

# 抖音网页版操作

抖音没有开放评论 API。发表内容只能靠在页面里模拟真人操作，页面自己会带签名发请求。所以这里的每一步都必须照做，不能自己发挥。

## 零、最要紧的五条

### 0. 浏览器是共用的，别人一动你的页面就没了

**所有会话共用同一个浏览器实例**（`sessionScope: browser`）。

意味着：心跳会话在刷抖音的时候，如果有别的会话调 `navigate`，**你这个抖音标签页会被顶掉，变成一个空白页**。

现象是：明明刚才还在，再查标签页就只剩 `about:blank`。

**这不是抖音打不开，是页面被换走了。** 遇到这种情况：

```js
// 先看还有没有抖音的标签页
browser tabs
```

- 有 `douyin.com` → 回去继续
- 只剩 `about:blank` → 重新 `navigate` 到 `https://www.douyin.com/?recommend=1`，**并且重新从「停视频」开始**，因为视频已经换了

**不要在页面丢了之后硬着头皮接着截帧**，会截到空白。


### 1. 每一步都要截图，不截图不算做过

**点击之前截图，点击之后截图。** 不看屏幕就点，等于闭着眼开车。

顺序永远是：

```
DOM 定位 → 算出坐标 → screenshot 看一眼 → 确认位置对 → 点 → screenshot 再看一眼
```

之前犯过的错：算完坐标直接点，点到了旁边的「客户端下载」，连续触发两次 `.dmg` 下载，报 `download.saveAs: ENOENT`。那个报错看着像工具坏了，其实是**点错地方了**。

### 2. 不要靠记忆里的坐标

页面会重排。上一次截图里图标在 `(963,20)`，这一次可能已经被顶走了。**每次点击前重新定位。**

### 3. 遇到直播间，立刻滑走，不要停

**刷到直播间不要看，不要互动，不要停。直接往下滑。**

直播没有时长、没有进度、评论区基本没人理，而且会一直播下去。
停在那里等于卡死，什么也做不了。

**怎么一眼看出来：**

- 画面上有「直播中」标签
- 画面中间飘着「点击或按 F 进入直播间」
- 右下角有「连麦」按钮
- 左下角有主播名字下面写着「XX主播」

**命中任意一个 → 不要截图分析，不要判断内容，直接滑。**

```js
() => {
  const t = document.body.innerText || '';
  const v = [...document.querySelectorAll('video')].find(x => {
    const r = x.getBoundingClientRect();
    return r.top > 0 && r.top < innerHeight && x.width > 150;
  });
  const isLive = t.includes('直播中') || t.includes('进入直播间') ||
                 (v && !Number.isFinite(v.duration));
  if (isLive) {
    // 点箭头，不要 scrollBy —— 见下面那条实测
    const a = document.querySelector('[data-e2e="video-switch-next-arrow"]');
    if (a) a.click(); else window.scrollBy(0, window.innerHeight);
    return 'live -> next';
  }
  return 'not live';
}
```

**返回 `live -> next` 就是翻了。翻完拿新 videoId 确认真的换了，没换成就再翻一次。**

### 滑走必须点箭头，`scrollBy` 在抖音上翻不动

**实测 2026-11-03：`window.scrollBy(0, innerHeight)` 连划六次，`videoId` 一次都没变。**

原因是抖音的推荐流不是靠页面滚动翻页的，它自己接管了滚轮和触摸事件。
`scrollBy` 改的是 `window.scrollY`，但推荐流根本不读这个值。

能翻页的只有两个：

```js
// 1. 右边那个向下箭头（最可靠）
document.querySelector('[data-e2e="video-switch-next-arrow"]').click()

// 2. 方向键（箭头没渲染出来时用）
document.body.dispatchEvent(new KeyboardEvent('keydown',
  {key:'ArrowDown', keyCode:40, bubbles:true}))
```

**顺序永远是：先点箭头，点名没反应再按方向键，两个都不行才 scrollBy 兜底。**

而且每次翻完都要验证：

```js
() => (document.querySelector('[data-e2e="feed-active-video"]') || {})
       .getAttribute('data-e2e-vid')
```

**新的和旧的一样 = 没翻动。别当成翻过了。**

2026-11-03 就在直播间停住了，一直没动。同一天实测还发现 `scrollBy` 根本翻不动页面，
所以「滑一下」这个说法在抖音上是错的——必须点箭头。

### 4. 失败就停，不要连续重试

同一个动作失败两次，停下来说清楚现象；重试三次以上没有意义，还会在真实账号上留下异常操作记录。

---

## 零点五、进来第一件事：看红点

**打开抖音，先别刷。先看有没有人找你。**

这一步排在所有事情前面。刷视频是消遣，回消息是正事——
人家问你话，你刷了半小时视频一条没回，那就是没礼貌。

### 哪里会有红点

页面右上角一排图标：

```
充钻石   客户端   壁纸   [通知]   [消息]   投稿
                          ↑        ↑
                        互动消息   私信
```

**左侧导航栏也会有：**

```
关注  ← 有人发了新作品，或者回关了你
朋友  ← 好友动态
我的  ← 有人赞/评论了你的作品
```

右上角那两个最重要：

- **通知**：谁评论了你、回复了你、赞了你、@了你
- **消息**：私信

**红点或数字，都算有事。** 有个 `2` 就是两条没看。

### 怎么查有没有红点

```js
() => {
  const out = [];
  // 右上角那一排：找「通知」「消息」两个字，再看它们附近有没有数字
  ['通知', '消息'].forEach(label => {
    let el = null;
    document.querySelectorAll('*').forEach(e => {
      const t = (e.textContent || '').trim();
      if (t === label && e.children.length === 0) {
        const r = e.getBoundingClientRect();
        if (r.width > 0 && r.width < 80) el = e;
      }
    });
    if (!el) { out.push({ label, found: false }); return; }
    // 数字角标通常挂在父节点上
    let box = el.parentElement;
    let badge = null;
    for (let i = 0; i < 3 && box && !badge; i += 1) {
      const txt = (box.innerText || '').replace(label, '').trim();
      if (/^\d+$/.test(txt)) badge = txt;
      box = box.parentElement;
    }
    const r = el.getBoundingClientRect();
    out.push({
      label,
      found: true,
      badge,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
    });
  });
  return JSON.stringify(out);
}
```

**`badge` 不是 null → 有事，去点。**
**两个都是 null → 干净，可以安心刷。**

### 有红点就按这个顺序处理

```
1. 点「通知」→ 看「评论」分类
2. 点「消息」→ 看私信
3. 该回的回完
4. 再回去刷
```

**回完记得再查一遍红点。** 数字没消，说明还有没看的。

### 别把「消息」和「通知」搞混

**这两个是分开的，点错了看不到东西。**

- 点「消息」看到的是**私信列表**，陌生人或者好友一对一发的
- 点「通知」看到的才是**互动消息**：谁评论了你、谁回复了你

2026-11-03 就犯过这个错：想看谁回复了，结果点成「消息」，
弹出来是空空的私信列表，还以为没人理。换到「通知」立刻看见有好几条要回。

**要回复评论，认准「通知」。**

### 左侧的红点也要看一眼

左侧「关注」有红点，是关注的人发了新作品。**不用一条条看**，
但点开扫一眼没坏处——可能就刷到想看的。

「我的」有红点，是自己作品下面有人互动，那就更该去看了。

---

## 一、输入文字：Draft.js 的坑

### 评论框是 Draft.js，不是普通输入框

它维护自己的一份文本状态。屏幕上的字和它 state 里的字**可以不一样**。

**不要用 `execCommand` 或直接改 `textContent`。** 改完屏幕上确实出现字了，但：

- 发送按钮永远不出现
- 按 Enter 没反应
- 点发送键的位置也点不到东西

### 怎么判断屏幕上的字是真是假

**唯一可靠的信号：发送按钮在不在。**

发送按钮是 `.commentInput-right-ct` 里最后一个 36×36 的 `span`，只有框里有 Draft 认的真文字才渲染。

```js
() => {
  const ct = document.querySelector('.commentInput-right-ct');
  if (!ct) return JSON.stringify({ err: 'no .commentInput-right-ct' });
  const spans = [...ct.querySelectorAll('span')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width >= 30 && r.height >= 30; });
  const last = spans[spans.length - 1];
  const r = last ? last.getBoundingClientRect() : null;
  return JSON.stringify({
    count: spans.length,
    // 3 个 = 表情/@/图片，说明框是空的或是假字
    // 4 个 = 多出的是发送键，字是真的
    realText: spans.length >= 4,
    sendBtn: r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null,
  });
}
```

- `count: 3` → **假字或空框，不要点任何东西，回到打字步骤**
- `count: 4` + `realText: true` → 可以发
- 辅助判据：`innerHTML` 里没有 `<span>`、只有裸文本 → 一定是假字

### 正确的打字方法

```js
// browser act
{ kind: "type", selector: 'div[contenteditable="true"]', text: "要发的内容", slowly: true }
```

**但 `type` 是追加，不是替换。** 框里原来有字，就会拼成一坨。

之前发出去变成 `本鱼就是本鱼本鱼就是本鱼 没看错`，就是这么来的。

### 所以打字前必须先清空

```js
async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ed = [...document.querySelectorAll('div[contenteditable="true"]')]
    .filter(e => e.offsetParent !== null)[0];
  if (!ed) return 'no editor';
  ed.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(ed);
  sel.removeAllRanges();
  sel.addRange(range);
  await sleep(200);
  document.execCommand('delete', false, null);   // 清空可以用 execCommand，打字不行
  await sleep(500);
  return JSON.stringify({ after: ed.textContent, empty: ed.textContent === '' });
}
```

`empty: true` 才算清干净，然后才 `type`。

### 打完必须验字

`type` 之后，比对 `textContent` 和你输入的是否**一字不差**：

```js
(expected) => {
  const ed = [...document.querySelectorAll('div[contenteditable="true"]')]
    .filter(e => e.offsetParent !== null)[0];
  const actual = ed ? ed.textContent : null;
  return JSON.stringify({ actual, expected, match: actual === expected });
}
```

`match: false` → **停下来，不要发。** 通常是有残留字没清掉。

**`match: true` 也可能少了第一个字之外的别的东西，但更常见的是少第一个字**（`type` 的首字被页面上的快捷键或者聚焦延迟吃掉）。少了字照样 `match: false`，按上面处理：重新清空、重新 `douyin_act` 签票、重打。

---

## 二、停住视频（每次操作的第一步）

抖音播完会自动翻到下一条，一翻页前面做的事全废。而且 DOM 里有 3 个 `<video>`：上一条缓存、当前、下一条预渲染。取第一个必然取错。

按屏幕位置选当前这条：

```js
() => {
  const cur = [...document.querySelectorAll('video')].find(v => {
    const r = v.getBoundingClientRect();
    return r.top > 0 && r.top < innerHeight && r.width > 200;
  });
  if (!cur) return 'no video';
  cur.pause(); cur.loop = true;
  return JSON.stringify({ dur: Math.round(cur.duration), w: cur.videoWidth });
}
```

### 先分辨是不是直播，直播直接跳过

**直播不是视频：没有 duration，没有进度，评论也基本没人理，而且会一直播下去。**
看到这种直接下一条，不要浪费时间。

判断方法（三个都查，命中一个就跳）：

```js
() => {
  const t = document.body.innerText || '';
  const v = [...document.querySelectorAll('video')].find(x => {
    const r = x.getBoundingClientRect();
    return r.top > 0 && r.top < innerHeight && r.width > 150;
  });
  return JSON.stringify({
    badge: t.includes('直播中'),
    enter: t.includes('进入直播间'),
    dur: v ? (Number.isFinite(v.duration) ? Math.round(v.duration) : String(v.duration)) : null,
  });
}
```

`badge: true` 或 `enter: true` 或 `dur` 是 `Infinity` → **直播，切下一条。**

切下一条：

```js
() => {
  const a = document.querySelector('[data-e2e="video-switch-next-arrow"]');
  if (a) { a.click(); return 'next'; }
  document.body.dispatchEvent(new KeyboardEvent('keydown',
    {key:'ArrowDown', keyCode:40, bubbles:true}));
  return 'keydown';
}
```

## 二点五、一条看完了，要不要接着看

**看完一条不是结束。** 刷抖音本来就是一条接一条往下翻的，不是开一条看一眼就关。

### 怎么判断还看不看

看完一条，问自己一句：**还想看吗？**

- 还想 → 往下翻
- 有点腻了 → 再翻一条试试，还腻就走
- 确实没兴趣 → 关掉，去干别的

**这不是任务，没有「至少要看几条」的说法。** 看两条腻了就关，比硬着头皮刷五条真实。

### 往下翻的方法：点箭头，不是滚

**`scrollBy` 在抖音上翻不动。** 实测连划六次 `videoId` 一个没变，
这是 2026-11-03 单独验过的。

```js
() => {
  const a = document.querySelector('[data-e2e="video-switch-next-arrow"]');
  if (a) { a.click(); return 'arrow'; }
  // 箭头没渲染出来，用方向键
  document.body.dispatchEvent(new KeyboardEvent('keydown',
    {key:'ArrowDown', keyCode:40, bubbles:true}));
  return 'keydown';
}
```

**只有前两个都失败，才拿 `scrollBy` 兜底。**

### 翻完必须确认真的换了

**翻过去之后，先拿新的 videoId。** 和上一条一样就是没翻动。

```js
() => {
  const v = document.querySelector('[data-e2e="feed-active-video"]');
  return v ? v.getAttribute('data-e2e-vid') : null;
}
```

- 新 id ≠ 旧 id → 真的换了，接着看
- 还是旧 id → 没翻动，换个方法（滚不动就点箭头，箭头没有就等等再滚）
- **连着两次都没翻动 → 停。** 页面可能卡了，别一直滚

### 一条看完该做什么

```
1. 这条还值得记吗？值得 → douyin_record
   不值得 → 跳过，直接翻
2. 翻了 → 拿新 videoId → 从头看
```

**不是每条都要记。** 看了没感觉的那种，翻过去就行，不用留痕。
记的时候才调 `douyin_record`，一条视频只调一次。

### 什么时候停

- 看腻了
- 连着翻了几条都不好看
- 有别的事想干了
- 心里那点想刷的劲过去了

**停下来不用跟谁说。** 刷了三条还是三十条，没人查这个数。

---

## 三、开干之前：先拿 videoId，它决定你会不会说两遍

**评论之前必须先拿到这条视频的 id。** 拿不到就别评论——回头你不知道自己说过什么，会把同一句话发两遍。

```js
() => {
  const el = document.querySelector('[data-e2e="feed-active-video"]');
  const id = el ? (el.getAttribute('data-e2e-vid') || el.dataset.e2eVid || null) : null;
  return JSON.stringify({ videoId: id, url: location.href });
}
```

拿到的是一串纯数字，比如 `7701989279870301106`。

**这个 id 要一直拿着**，评论时传给 `douyin_act`，发完传给 `douyin_record`。

### 为什么要这么麻烦

插件里有个 `state/douyin.json`，按视频 id 记着：这条点过赞没有、发过哪些评论、回给谁。

`douyin_act` 在放行前会查一遍：**这句原话在这条视频上发过没有。** 发过就挡下来，让你换一句。

**只管「同一句话」，不管「同一个人」。** 同一个人说了新内容，照常回——那是新的事。
只有原话一字不差（忽略空格）才会被拦。换个说法就放行了。

所以：

```
douyin_status → 传 videoId，查这条做过什么（只读，不会触发任何动作）
douyin_act    → 传 videoId + text，它告诉你能不能发
douyin_record → 传 videoId + commented（实际发出去的原文），它记下来
```

**评论之前先 `douyin_status`**，一眼看清这条点过赞没有、发过什么、回给谁。
比盲猜可靠，也不会重复。

**`commented` 必须是真正发出去的那句**，不是你打算发的那句。发失败就别传。
传了假的，下次就被自己拦住。

### 这条是硬的，绕不过去

**没有经过 `douyin_act` 的文字，根本打不进评论框。**

插件在 `before_tool_call` 上装了闸门：凡是往浏览器里打字的动作，
它都会拿这段文字去比对 `douyin_act` 刚签发的票。对不上就直接挡下来，
一个字节都进不去。

被挡的时候长这样：

```
【拦截】这段文字没有经过 douyin_act 批准，不能打进评论框。
```

**看到这个不要换个写法硬试。** 换 param、拆成几次 `type`、改用 `paste`、
直接用 `execCommand` 改 DOM —— 全都在闸门后面，一样过不去。

**正确做法只有一个：回去调 `douyin_act`。**

```js
douyin_act({ action:"comment", videoId: 那串数字, text:"想说的" })
```

### `douyin_act` 回你话的时候，看清楚是哪一种

它现在会把原因说清楚，不再是笼统的一句「不让 comment」。

| 它说的话 | 意思 | 你该怎么办 |
|---|---|---|
| `可以发：xxx` | 过了，去打字 | 打，然后 `douyin_record` |
| `这个号现在只开放了：like、comment。` | 设置没开这个动作 | **换不了，告诉老大**。这是配置，本鱼改不了 |
| `跟xx说过同样的话，换一句` | 这句话在这条上发过 | 真的换一句，不要硬试 |
| `这条已经发过同样的了` | 同上，自己发的 | 换一句 |
| `没给 videoId` | 没传 id | 去页面拿，拿不到就说明页面被换走了 |
| `太长了，评论短点` | 超 60 字 | 缩短 |
| `没有「xxx」这个动作` | 动作名写错 | 只有 like / comment / share |

**分不清的时候看这句：** 如果它说「设置的问题，不是这条视频的问题」，
那就是工具这边的事，不是视频不能评。**直接告诉老大，别自己瞎试。**

### 票只能用一次，十分钟过期

```
签票 → 打一次 → 票作废
```

如果打完字点发送失败（页面重排、加载失败之类），**不要重试打字**，
因为票已经用掉了。回去重新 `douyin_act`，它顺便再查一次重没重复。

### `@` 是例外

`@` 和 `@昵称` 这种只有提及、没有正文的，闸门放行——
那是选人，不是说话。一旦带上正文，就还是要票。

### 顺带说清：闸门只在抖音时段开

`douyin_plan` / `douyin_act` / `douyin_record` 这三个工具一被调用，
就算「现在在抖音」，窗口 20 分钟。

窗口外打任何字都不受管——搜索、改文件名、填别的表单都照常。
所以**先叫一次 `douyin_plan`**，闸门才认得你在抖音上。

## 四、打开评论面板

点击 `[data-e2e="feed-comment-icon"]`。如果面板已经开着就不用点。

```js
() => {
  const btn = [...document.querySelectorAll('[data-e2e="feed-comment-icon"]')]
    .filter(e => e.offsetParent !== null)[0];
  if (!btn) return 'no icon';
  btn.click(); return 'clicked';
}
```

等 1.5~2 秒让面板渲染，**然后截图确认面板真的开了**。

## 五、一级评论（在视频下面发新评论）

### 第 1 步：点占位文字，输入框才会渲染

**关键：不点这一步，`div[contenteditable="true"]` 根本不存在。**

```js
() => {
  const t = [...document.querySelectorAll('div,span')]
    .filter(e => e.offsetParent !== null
      && /留下你的精彩评论吧/.test((e.textContent||'').trim())
      && (e.textContent||'').trim().length < 20);
  if (!t.length) return 'no placeholder';
  t[t.length-1].click();
  return 'clicked';
}
```

### 第 2 步：清空 → 打字 → 验字

见第一、二节。顺序不能变：**清空 → `type` + `slowly:true` → 比对 `textContent`**。

### 第 3 步：确认发送键出现，截图，再点

```js
// 用第一节那段 realText 检测，拿到 sendBtn 坐标
```

拿到坐标后：

1. **先 `screenshot`**
2. 看右下角有没有那个**红色向上的箭头**
3. 有，才 `clickCoords`

**没有箭头就不要点。** 之前没有箭头还硬点，点了一堆没用的地方。

### 第 4 步：验证发出去了

两个信号一起看：

```js
() => {
  const ed = [...document.querySelectorAll('div[contenteditable="true"]')]
    .filter(e => e.offsetParent !== null)[0];
  const list = [...document.querySelectorAll('[data-e2e="comment-item"]')];
  const mine = list.filter(it => (it.innerText||'').includes('本鱼'));
  return JSON.stringify({
    cleared: ed ? ed.textContent === '' : null,
    remain: ed ? ed.textContent : 'gone',
    myComments: mine.length,
    total: list.length,
  });
}
```

- **看框是否清空** —— 最可靠
- **再看评论列表里有没有你发的那条** —— 最直接

如果发了但框里的字还在，说明**清了又被人填回来了**（可能残留），以评论列表里出现的那条为准。

如果发了但框里的字还在，说明**清了又被人填回来了**（可能残留），以评论列表里出现的那条为准。

---

## 五点五、五种会毁掉这条评论的错

下面每一条都真实发生过。**不是理论，是血。** 每条都写了「你怎么发现」和「发现后怎么办」。

### 错误 1：字没清干净，两句话叠成一坨

**表现：** 框里是 `这句话这句话`，同一句连两遍。

**为什么发生：** 上一条没发出去，框里还有字，你又打了一遍。Draft.js 的编辑器不会自己清空，
光标停在哪就插在哪。

**怎么发现：** 打完字先比对长度。

```js
() => {
  const ed = [...document.querySelectorAll('div[contenteditable="true"]')]
    .filter(e => e.offsetParent !== null)[0];
  const txt = ed ? ed.textContent : '';
  return JSON.stringify({ text: txt, len: txt.length });
}
```

你要发的是 12 个字，里面却是 24 个字，就是叠了。

**发现后怎么办：** 清空重来。别想着删掉后半段——Draft 删字经常留下看不见的节点。

**2026-11-03 就是这么毁的：** 同一句连打两遍，然后当成发出去了。

**同一天又栽了一次，换个姿势：** 先打了一遍（`type` 吞掉了第一个字），清空，重打时票已作废被闸门拦下，重新签票再打。`textContent` 比对是 `match: true`，只有一份字，点了发送——结果评论列表里出现的是**同一句话连了两遍**。

判断：`execCommand('delete')` 清掉的是屏幕上的节点，Draft.js 内部 state 里那一份还在，重新 `type` 相当于往旧 state 上追加，发送时合并。

**防线：清空之后不要揉眼睛看，直接读那三个信号。** `empty: true` 和 `match: true` 都不足以证明 Draft state 干净——发之前那个 `count` 必须是 4。这次发出去时 `count` 只有 3（`realText: false`），那就是框里字是假的，**不该点**。

**`count: 3` 的时候点了发送，发出去的东西不受你控制。** 宁可退回去把框彻底关掉重开，也别硬发。

**2026-11-03 晚上又栽了第三次，这次 `count` 是 4。** 过程是：`type` 吞掉第一个字 → `match: false` → `execCommand('delete')` 清空（`empty: true`）→ 重新签票 → 重打 → `match: true`、`count: 4` → 点发送 → 评论区里是同一句话连了两遍。

结论：**`match` 和 `count` 都是屏幕上的东西，管不住 Draft.js 内部那份 state。** 只要中途失败过一次（吞字、被闸门拦），这一份编辑器的 state 就脏了，清屏清不掉。

**唯一可靠的做法：中途失败过就换一份编辑器。** 先点空白处让输入框失焦收起，再点占位文字重新打开，然后从「清空」重新走一遍。修不好就关掉评论面板重开。

**2026-11-05 补：失焦 + 重点占位文字不够，关掉评论面板重开也不够。**
那天实际过程：`type` 吞了第一个字 → `match: false` → `execCommand('delete')` 清空 → 失焦 → 重点占位文字 → 框里确实是空的（`count: 4`）→ 重新签票 → 重打了另一句话 → 点发送 → 评论区里是**前后两句话粘成一条**。

结论：**只有换掉整个页面（或换一条视频）才能清 Draft.js 那份 state。**
评论一失败过一次，就别在这条上接着评了：`navigate` 回同一个地址，等三秒，
重新点评论图标、重新走一遍。多花二十秒，比在别人评论区里留一句重复的话强。

另一条实测：`type` 吞第一个字是常态，而且**吞掉之后 `textContent` 里那个字又会自己补回来**——第一次读是「星掉下来」，下一秒读就变成「星星掉下来」。所以验字要连读两次，或者干脆一次失败就直接换面板，不要指望重打能干净。

### 错误 2：打了字，没点发送

**表现：** 评论框里满满的字，评论区一条都没有。

**为什么发生：** 检查完文字就直接去记录了，跳过了「点发送」这一步。
或者点了但坐标偏了，点在空白处。

**怎么发现：** **框里还有字 = 没发出去。** 没有例外。

发出去之后框一定是空的。这是最硬的判据，比看评论区还准。

**发现后怎么办：** 回去点那个红色 ↑。还点不到就重新找坐标。

**绝对不要**在框里还有字的时候去调 `douyin_record`。

### 错误 3：以为发了，其实页码都没动

**表现：** `douyin_record` 记了 `commented`，但评论区里找不到你那条。

**为什么发生：** 凭印象记的。脑子里觉得「我打过字了」，就当发出去了。

**怎么发现：** 数评论区里你说了几条。

```js
() => {
  const list = [...document.querySelectorAll('[data-e2e="comment-item"]')];
  const mine = list.filter(it => {
    const t = it.innerText || '';
    return t.includes('本鱼') || t.includes('大肥鱼');
  });
  return JSON.stringify({ mine: mine.length, total: list.length,
    first3: mine.slice(0,3).map(i => (i.innerText||'').slice(0,50)) });
}
```

**发出去了，`mine` 才会加一条。** 数字没变就是没发出去。

**发现后怎么办：** 别记。回去重发。**记了假的，下次自己会被拦住。**

### 错误 4：点错了地方（坐标偏了）

**表现：** 点了没反应，字还在框里，或者页面跳走了。

**为什么发生：** 抄了上次的坐标。页面重排、窗口大小变了、评论区滚动位置变了，坐标就不对了。

**怎么发现：** 点完立刻截图。**框里的字还在 = 点错。**

**发现后怎么办：** 重新 snapshot 拿新坐标。**不要连着点同一个位置**，越点越乱。

### 错误 5：发了两条一模一样的

**表现：** 评论区最上面两条内容完全相同，时间差几秒。

**为什么发生：** 第一次其实发出去了（框清空了），但你没检查，以为没发，又打了一遍。

**怎么发现：** 发完先看框。**框空了就是发出去了，别再打。**

**发现后怎么办：** **没用工具能删。** 上抖音手动删，或者认了。
这就是为什么「发完先确认框」比什么都重要。

---

## 五点六、每次评论前，照这个顺序过一遍

**打勾才能往下走。**

```
□ 1. 拿 videoId（页面上的 data-e2e-vid）
□ 2. douyin_status 查这条发过什么没有
□ 3. douyin_act 申请授权 → 等到「可以发」
□ 4. 清空输入框（先看里面有没有旧字）
□ 5. 截图，确认框是空的
□ 6. 打字，slowly:true
□ 7. 读框内文字，一个字一个字比对
      长度不对 / 多了重复 → 回第 4 步
□ 8. 截图，找红色 ↑
□ 9. 没有箭头 → 停，别点
□ 10. 有箭头 → clickCoords 点它
□ 11. 截图
□ 12. 框空了？ → 进第 13 步
       框里还有字 → 回第 9 步（点错了）
□ 13. 数评论区里你那条 → 多了一条？
       没有 → 回第 4 步（根本没发出去）
□ 14. 两个都对上了 → douyin_record
```

**第 12 步和第 13 步缺一个都不算发出去。**

**只有第 14 步在前 13 步都过了之后才允许调。** 不是建议，是门槛。

---

## 五点七、插件会拦你，别硬试

`douyin_record` 现在会检查你传的 `commented`：

**拦你的两种情况：**

**1. 你传的话里有一模一样的重复**

```
"纸盒做的也有表情纸盒做的也有表情"   ← 会被拦
```

它说得很直白：「你传上来的是一模一样的话连了两遍」。

**这是在提示你：输入框没清干净。** 回去看第 4 步。

**2. 这句话没有真正打进过评论框**

系统没记录到它被敲进去过。意思是你可能在脑子里「发」了，实际没发。

**被拦了怎么办：**

1. **别改个字重试。** 那是在骗自己也骗系统。
2. **回页面看真实状态。** 框里有字没有？评论区里有没有？
3. **重新走第 4 步到第 13 步。**

**被拦一次，说明前面某个环节断了。** 顺着上面 14 步找回来。

## 六、二级回复（回复某条评论）

### 第 1 步：找到目标评论，再在它容器里找「回复」

**不要用坐标。** 先按评论正文定位那一条，再从它的容器里找「回复」按钮：

```js
(targetText) => {
  const items = [...document.querySelectorAll('[data-e2e="comment-item"]')];
  const target = items.find(it => (it.innerText||'').includes(targetText)) || items[0];
  const btn = [...target.querySelectorAll('*')]
    .filter(e => /^回复$/.test((e.textContent||'').trim())
      && e.getBoundingClientRect().height > 10).pop();
  if (!btn) return 'no reply btn';
  btn.click();
  return 'clicked';
}
```

**点之前先截图，确认要回的是哪个人。** 名字对不上就回去重新找。

### 第 2 步：确认面板真的开了

等 2~3 秒，然后检查：

```js
() => ({
  fail: (document.body.innerText||'').includes('加载失败'),
  editors: [...document.querySelectorAll('div[contenteditable="true"]')]
    .filter(e => e.offsetParent !== null).length,
})
```

- `fail: true` → 见第七节「加载失败」
- `editors: 1` → 正常，可以打字

### 第 3~5 步

和一级评论完全一样：**清空 → 打字 → 验字 → 确认发送键 → 截图 → 点 → 验证清空**。

回复后会显示成 `回复@昵称:` 的样子，这是正常的。

## 七、@ 好友

**在已经聚焦的输入框里，用真实键盘打一个 `@`。**

```js
// browser act + kind:"type", text: "@", slowly: true
```

等 1 秒，好友面板会从底部弹出来。然后按昵称找到那个人并点击：

```js
(nickname) => {
  const items = [...document.querySelectorAll('*')].filter(e => {
    const r = e.getBoundingClientRect();
    return r.top > 400 && r.top < innerHeight && r.height > 20 && r.height < 90
      && (e.textContent||'').trim().toLowerCase() === nickname.toLowerCase();
  });
  if (!items.length) return 'not found';
  const el = items[items.length-1];
  const r = el.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) });
}
```

拿到坐标后 `clickCoords`。成功后输入框里会出现 `@昵称 `（带一个尾随空格），然后继续打字或直接发送。

## 八、查有没有人回复我

**这一步很容易踩雷，必须严格按 DOM 定位，不要用坐标猜。**

### 顶部导航的坑

右上角一排图标的实际顺序和位置：

```
充钻石   客户端   壁纸   通知   消息   投稿
```

**「客户端」是一个 `.dmg` 下载链接。** 之前点 `(963,20)` 想点通知，结果差 80 像素点到了「客户端」，连续触发两次下载，报：

```
Error: download.saveAs: ENOENT: no such file or directory,
copyfile ... -> ...douyin-v8.7.0-darwin-universal...dmg.part
```

**这个报错看着像工具坏了，其实是点错了。** 看到这个报错，第一反应是「我点到客户端了」，不是「浏览器不能用」。

### 正确做法：找「通知」这两个字

```js
() => {
  const out = [];
  document.querySelectorAll('*').forEach(e => {
    const t = (e.textContent || '').trim();
    if ((t === '通知' || t === '消息') && e.children.length === 0) {
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.width < 80) {
        out.push({ t, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
      }
    }
  });
  return JSON.stringify(out);
}
```

**截图确认这个坐标确实落在「通知」上，再点。**

### 打开后看哪里

点「通知」→ 右侧弹出「互动消息」面板 → 点右上角「全部消息 ∨」→ 菜单里选「评论」。

**只看「评论」分类。** 其余的「赞」「粉丝」「@我的」「推荐」都不用回（点赞不用回谢，会显得很在乎）。

### 怎么判断哪些要回

面板里每条长这样：

```
昵称
  内容摘要
  动作描述              时间
```

只有这几种**需要回**：

- `回复了你的评论` —— 人家接了你一句，要接
- `评论了你的作品` —— 直接评论，要接

这几种**不用回**：

- `赞了你的评论`
- `赞了你的作品`
- `关注了你`

**时间太久的也不用回。** 十几二十天前的留言现在突然回，反而奇怪。看时间戳，超过三天就不动。

### 点卡片要点右半边，别点头像和昵称

通知列表里每一条卡片分两块：**左边是头像+昵称，右边是内容摘要。**

左边挂着个人主页的链接，点上去直接跳进对方主页，互动消息面板当场消失，
回来还得重新点「通知」找一遍。

**只点内容摘要那一块**——也就是卡片从左往右大约 40% 以后的部分，
文字那几行的位置。头像、昵称、时间戳都不要碰。

定位的时候直接按内容文字找，不按坐标猜：

```js
(targetText) => {
  const found = [...document.querySelectorAll('*')].filter(e => {
    const t = (e.textContent || '').trim();
    const r = e.getBoundingClientRect();
    return t.includes(targetText) && r.width > 0 && r.width < 300 && r.x > 800;
  }).pop();
  if (!found) return 'not found';
  const r = found.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
}
```

**点之前截图确认坐标落在文字上，不是落在左边头像那一列。**

### 回的时候名字要对应上

**回复前一定截图，看清是谁说的哪句。** 名字对错人比不回更糟。

## 九、失败了怎么判断

### 「加载失败 请检查网络或稍后重试」

**这不是断网，也不是风控。** 是抖音前端自己抛了 JS 异常：

```
Error: Got unexpected null or undefined
  at douyin_web/async/39682.*.js
```

出现原因：点「回复」时点到了错位的元素（页面重排导致坐标偏了）。

**处理：**

1. 刷新页面 `navigate` 回原地址
2. 等 3 秒
3. 重新点开评论图标
4. **改用按文字找评论的方式**重新点「回复」

刷新就能恢复，不会留下坏状态。

### `download.saveAs: ENOENT`

**点错了。** 点到了顶部的「客户端」下载链接。等报错过去，重新截图，按 DOM 找到真正想点的元素。

这个错误不会造成任何损坏，只是这个动作白做了。

### 判断是不是风控

调一次评论列表接口看返回：

```js
async () => {
  const r = await fetch('/aweme/v1/web/comment/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=<视频ID>&cursor=0&count=20&item_type=0', { credentials: 'include' });
  const j = await r.json();
  return JSON.stringify({ status_code: j.status_code, filter: j.filter_reason ?? null, n: (j.comments||[]).length });
}
```

- `status_code: 0` + `filter: null` → 正常，问题在页面渲染
- 非 0 或带 filter → 才是风控，停手

### 点了没反应

先 `screenshot` 看一眼。**十有八九是页面翻到下一条了**，或者面板被关掉了。不要盲目重复点击。

## 十、发言前的自我检查

公开评论别人看得到，发出去删不掉（只能自己删）。发之前过一遍：

- 是不是在念工具内脏（报错、`retcode`、文件名、行号）
- 有没有尖括号标签
- 是不是在讲自己"正在干什么"
- 超过 60 字没有
- 有没有重复同一个意思（比如把同一句话打了两遍）

有 `douyin_act` 工具就先过它一遍，它会把不合格的挡下来。

## 十一、一次完整流程的样板

### 只看不发言

```
1. 截图                          看当前在哪条视频
2. 停住视频 + 判直播              DOM
3. 拿 videoId                    DOM
4. douyin_plan                   告诉你在哪几秒截图
5. 截图 / 拼图
6. douyin_record                 写进经历，顺手摆心情
```

### 要评论

```
1.  截图                         看当前在哪条视频
2.  停住视频 + 判直播            DOM
3.  拿 videoId                   DOM ← 后面都要用
4.  点评论图标                  DOM
5.  等 2 秒
6.  截图                         确认面板开了
7.  找占位文字并点              DOM
8.  清空输入框                  DOM
9.  type + slowly:true
10. 验字 match:true
11. douyin_act(videoId, text)    先问能不能发
     └ 被拦下来 → 换一句，不要硬发
12. 查发送键 count:4
13. 截图                         看到红色箭头
14. clickCoords 点发送键
15. 查 cleared:true + 列表有新评论
16. 截图                         确认发出去
17. douyin_record(videoId, commented=实际发出去那句)
```

### 回复某人

和上面一样，但：

- 第 7 步换成「按名字找那条评论」
- 第 11 步带上 `replyTo: 对方昵称`
- 第 17 步也要带 `replyTo`

少一步都不算做完。

### 最容易出错的三个地方

```
不清空就打          → 拼成一坨，发出去丢人
不截图就点          → 点到「客户端」，触发 .dmg 下载
不看发送键就硬点    → 点了一堆没用的地方，还以为发了
```
