import fs from "node:fs";
import path from "node:path";

// 颜文字 —— 一张固定的小词表，不是生成器。
//
// 为什么不用库直接生成：网上现成的库（`kaomoji-collection` 41000 条、
// `kaomoji` 314 条）体量够，但直接丢给模型会出事——实测抓到的条目里有
// HTML 实体（`&gt;&lt;`）、混着日文假名和词尾（`(つд⊂)ｴｰﾝ`、`ありがとう`）、
// 还有拿英文拼的假颜文字。她会原样照抄，聊天框里就出现一串看不懂的东西。
//
// 所以这里走的是 `dsh-kaomoji` 那条路：**只给白名单，只许照抄**，不许自己
// 拼。词表取自 dsh-kaomoji 0.3.0（MIT），其数据源是 kaomojiya.org 的人工
// 精选子集，挑的时候已经偏好「纯表情、无拟声词后缀」的写法。`tired` 那一组
// 来自 kaomoji-collection（同样 MIT），经过同一套过滤：无 HTML 实体、无
// 假名、无汉字、无连续英文字母。
//
// 一个关键差别：dsh-kaomoji 是 Cordis 插件，要 `@deepseek-ai/schemastery`
// 和 dsh 运行时，装不进 OpenClaw（和 dsh-proactive 一样的原因）。这里只搬
// 词表和「白名单+照抄」的原则，宿主部分自己写。

/**
 * 情绪 -> 颜文字。每条都是纯表情，可以直接复制进聊天。
 *
 * 每个 id 对应她情绪引擎里确实存在的一个方向（见 lib/emotion.js 的
 * dimensions），不是随便分的类。对不上的就不放进来——一个她用不到的表情
 * 组，只是白占提示词。
 */
export const CATALOG = Object.freeze({
  happy: {
    label: "开心",
    faces: ["(´∀｀)", "( ◜ω◝ )", "＼(^o^)／", "(*´▽`*)"],
  },
  love: {
    label: "心动",
    faces: ["(♡´౪`♡)", "(●´ω｀●)♡", "(｡♥‿♥｡)", "( ˘ ³˘)♡"],
  },
  sad: {
    label: "低落",
    faces: ["(´；ω；`)", "(｡•́︿•̀｡)", "(〒﹏〒)", "(இωஇ)"],
  },
  cry: {
    label: "哭",
    faces: ["(T_T)", "(ಥ_ಥ)", "( ；∀；)", "｡ﾟ(ﾟ´Д｀ﾟ)ﾟ｡"],
  },
  angry: {
    label: "生气",
    faces: ["(｀ε´)", "ヽ(`Д´)ﾉ", "(¬˛¬ )", "( ･᷄ὢ･᷅ )"],
  },
  surprised: {
    label: "惊讶",
    faces: ["( °Д° )", "Σ(*ﾟдﾟ*)", "Σ(ﾟﾛﾟ;)", "（〇o〇）"],
  },
  confused: {
    label: "困惑",
    faces: ["(´･-･`)", "(^_^;)", "( -᷄ω-᷅ )", "╮( •́ω•̀ )╭"],
  },
  shy: {
    label: "害羞",
    faces: ["(〃ﾉдﾉ)", "(*ﾉωﾉ)", "(///ω///)", "(〃▽〃)"],
  },
  playful: {
    label: "俏皮",
    faces: ["(・ω<)", "(｡•ω<｡)", "(∩_∩)", "(〃´∀｀〃)"],
  },
  encourage: {
    label: "加油",
    faces: ["(•̀ω•́)✧", "(๑•̀ㅂ•́)و✧", "(ง •̀_•́)ง", "(｡•̀ᴗ-)✧"],
  },
  thanks: {
    label: "谢谢",
    faces: ["(人´∀`)", "(*´▽`人)", "m(_ _)m", "⸜(*ˊᵕˋ*)⸝"],
  },
  sorry: {
    label: "对不起",
    faces: ["(人'д`o)", "(´｡･д人)", "(｡-人-｡)"],
  },
  tired: {
    label: "累了",
    faces: ["(´-`)", "(´Д｀)", "(´□｀)", "(´-｀；)"],
  },
});

/** 每轮最多放几个。一个就够，多了像刷屏。 */
export const MAX_PER_TURN = 1;

/**
 * 这会儿最贴合的表情组。
 *
 * 门槛借自 `suggestStickerMood`，理由相同：一个表情要代表「这个情绪真的上
 * 去了」，不是「它比基线飘高了一点」。用户 2026-11-04 定过规矩——安静的一
 * 天不发表情是正确行为，不是缺陷——这里沿用，所以返回 null 是常态。
 *
 * `lastDeltas` 用来分辨「刚刚这样了」和「一直是这个底色」。缺了它，那三个
 * 瞬时分支永远不会触发（贴纸那边踩过这个坑）。
 */
export function suggest(d, lastDeltas = null) {
  if (!d || typeof d !== "object") return null;
  const last = lastDeltas || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  // 瞬时门槛按她的**实测振幅**定，不是拍脑袋。
  //
  // 初版照搬了贴纸那边的 0.08，那一刻就是死代码：拿她 200 条情绪历史量一下，
  //   surprised  最大单次 +0.040
  //   tsundere   最大单次 +0.050
  //   wronged    从未出现过
  // 而单次变动的常见量级就是 0.03–0.06。门槛比真实信号高一倍，三个分支
  // 永远不会触发，写了等于没写。改成 0.03：一次实打实的心情上扬就算数。
  const justSurprised = num(last.surprised) >= 0.03;
  const justWronged = num(last.wronged) >= 0.03;
  const justTsundere = num(last.tsundere) >= 0.03;
  const justHappy = num(last.happy) >= 0.05;
  const justDown = num(last.down) >= 0.02;

  // 瞬时优先：刚发生的事比底色更值得一张脸。
  if (justSurprised) return "surprised";
  if (justWronged && justTsundere && num(d.tsundere) >= 0.45) return "angry";
  if (justWronged) return "sad";
  if (justDown) return "sad";
  if (justHappy) return "happy";

  // 长久底色。用户 2026-11-06：「可以的多发点」——所以门槛从
  // 0.7/0.5/0.45/0.65 整体下调一档。原来的数字是照「安静的一天不发是
  // 正确的」定的，那条规矩没错，但现在要的是她更常把情绪放出来，两个要求
  // 不是一回事：门槛降下来之后，安静时依旧不触发，只是中等强度也开始算。
  if (num(d.happy) > 0.62) return num(d.excited) > 0.55 ? "encourage" : "happy";
  if (num(d.down) > 0.4) return "sad";
  if (num(d.shy) > 0.38) return "shy";
  if (num(d.tsundere) > 0.5 && num(d.happy) < 0.6) return "angry";
  if (num(d.tired) > 0.55) return "tired";
  if (num(d.bored) > 0.5) return "playful";
  if (num(d.excited) > 0.55) return "encourage";
  if (num(d.calm) > 0.68) return "playful";

  return null;
}

/**
 * 从一组里挑一张。
 *
 * 按半小时取模而不是随机：同一轮里多次调用拿到的是同一张（不会自相矛盾），
 * 半小时后自然换一张（不会永远那一张）。
 */
export function pick(id, at = Date.now()) {
  const group = CATALOG[id];
  if (!group || !group.faces.length) return null;
  const slot = Math.floor(at / (30 * 60 * 1000));
  return group.faces[slot % group.faces.length];
}

/**
 * 注入提示词的那一段。
 *
 * 两种状态分开给：
 *   - 有正合适的：指出是哪一张，并说清放哪儿
 *   - 没有：只给词表，说「不用勉强」
 *
 * 词表每次都给，因为她是靠这一句知道「原来可以用颜文字」。只在她情绪上头的
 * 时候才给词表，等于绝大多数轮次她都不知道有这回事。
 */
export function line(d, lastDeltas = null, at = Date.now()) {
  const table = Object.values(CATALOG)
    .map((g) => `${g.label}${g.faces[0]}`)
    .join(" ");

  const id = suggest(d, lastDeltas);
  const face = id ? pick(id, at) : null;

  if (!face) {
    return (
      `\n\n【颜文字】心情平的时候不用。` +
      `\n　想用就从这些里原样挑一个，接在句尾：${table}` +
      `\n　只能照抄，不要自己拼、不要改字符，一条消息最多一个。`
    );
  }

  // 语气从「可以」换成「就在这儿」。她之前收到「觉得不合适就不用」，结果一条
  // 都没发——因为那句话把决定权交回给她，而她本来就没有这个习惯。表达情绪不是
  // 需要审批的事，给她一张现成的脸、让她直接用。
  return (
    `\n\n【颜文字】这轮带上这个：${face}` +
    `\n　放在你这句的末尾。不用另外解释，不用说明你在用什么表情。` +
    `\n　其他可选：${table}` +
    `\n　只能照抄上面这些，不要自己拼、不要改字符，一条消息最多一个。`
  );
}

/**
 * 本轮要不要真的推一张。
 *
 * 两个问题在 `suggest()` 里解决不了，因为它们是跨轮次的：
 *
 *   ① `last_deltas` 不过期。它只在有真实情绪事件时被覆盖（原因见
 *      index.js 里 isBookkeeping 那段注释），所以一次 `happy +0.05` 会一直
 *      挂在那儿。实测：之后连续五轮没有新情绪，`suggest()` 五轮都回 `happy`。
 *      同一个人连着五句话都带 `＼(^o^)／`，不是表达情绪，是卡住了。
 *
 *   ② `happy > 0.62` 是底色判断，能持续好几轮。底色本来就不该每轮都配一张
 *      脸——一整天都很开心，不需要每句话都告诉对方一遘。
 *
 * 所以对状态加一个冷却：同一个组在 ≤3 轮内不重复推。跨轮次的记忆放在
 * state 文件里，不放在模块变量里（插件可能重载）。
 */
export function gate(dir, id, at = Date.now(), cooldownMs = 45 * 60 * 1000) {
  if (!id) return true;
  const file = path.join(dir, "state", "kaomoji.json");
  let rec = {};
  try {
    rec = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch { /* 第一次运行，正常 */ }

  const lastAt = Number(rec.last_at) || 0;
  const lastId = rec.last_id || null;

  // 冷却内且是同一个组 → 不推。不同组照推（换了个情绪就该换张脸）。
  if (lastId === id && at - lastAt < cooldownMs) return false;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ last_id: id, last_at: at }) + "\n");
  } catch { /* 记不住就多发一次，不阻塞聊天 */ }
  return true;
}
