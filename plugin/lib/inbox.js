// Inbox — 谁在等她回话。
//
// 为什么这一层比"去刷抖音"重要
// ----------------------------
// `dsh-bili-scroll` 的做法里最值钱的一条不是刷视频，是它自己算「谁在等我」
// （`conversation.json` + 判重表 → 去读楼中楼 → 最后一句是对方说的 → inbox.md
// → 内联进下轮提示词）。
//
// 差别是根本的：
//   没有它：她刷完、评论完、结束。下一次醒来又是"去刷抖音"。
//   有它：  有人在等她。下一轮第一件事是接话，不是找事做。
//
// 前者靠分数驱动，后者靠真实往来驱动。人格是后者长出来的。
//
// 我们之前只有前半段：`douyin.json` 记了 13 条她发出去的评论，但一条回复都
// 没记。所以 `inbox.md` 永远是空的，这个机制从来没启动过。
//
// 这一层不做判断，只做记账
// ------------------------
// 哪些该回、哪些不该回，`skills/douyin/SKILL.md` 第八节已经写死了规则
// （回复了我的评论 / 评论了我的作品 → 要回；赞、关注 → 不回；超过三天 → 不动）。
// 这里不重复那套判断，只负责：
//   - 收到的回复落盘
//   - 算出"最后一句是谁说的"
//   - 把"对方说了最后一句"的挑出来，按时间排
//
// 判断留给读它的人。一个模块做两件事，两件都会做错。

import fs from "node:fs";
import path from "node:path";

/** 超过这个天数的不再催她回。SKILL.md 里定的是三天。 */
export const STALE_DAYS = 3;

export function inboxFile(workspaceDir) {
  return path.join(workspaceDir, "state", "inbox.md");
}

function douyinFile(workspaceDir) {
  return path.join(workspaceDir, "state", "douyin.json");
}

function loadVideos(workspaceDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(douyinFile(workspaceDir), "utf8"));
    if (raw && typeof raw.videos === "object") return raw.videos;
  } catch { /* 没有记录 */ }
  return {};
}

function daysSince(iso) {
  const at = Date.parse(String(iso || ""));
  if (!Number.isFinite(at)) return Infinity;
  return (Date.now() - at) / 86400000;
}

/**
 * 记一条收到的回复。
 *
 * 挂在对应视频的 `comments` 里：她发的那条评论带上 `replies` 数组。
 * 找不到她发的那条就拒绝 —— 挂不上父评论的回复，事后没法判断语境。
 *
 * 幂等：同一个人、同一句话、同一天，只记一次。抖音的通知列表会重复出现同一
 * 条，重复记会让"最后一句是谁说的"算错。
 */
export function recordReply(workspaceDir, { videoKey, commentAt, from, text, mine = false, at = new Date().toISOString() }) {
  if (!videoKey) return { ok: false, reason: "没给视频" };
  if (!from || !String(from).trim()) return { ok: false, reason: "不知道是谁回的" };
  if (!text || !String(text).trim()) return { ok: false, reason: "回复内容是空的" };

  const file = douyinFile(workspaceDir);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ok: false, reason: "抖音记录还读不到" };
  }
  if (!raw || typeof raw.videos !== "object") return { ok: false, reason: "记录结构不对" };

  const video = raw.videos[videoKey];
  if (!video) return { ok: false, reason: `没有这条视频的记录（${videoKey}）` };

  const comments = Array.isArray(video.comments) ? video.comments : [];
  // 按时间戳找她发的那条；没给时间就退回最后一条（最常见的情况）。
  const parent = commentAt
    ? comments.find((c) => String(c?.at || "") === String(commentAt))
    : comments[comments.length - 1];

  if (!parent) return { ok: false, reason: "找不到你在这条下面发过的话" };

  if (!Array.isArray(parent.replies)) parent.replies = [];

  const day = String(at).slice(0, 10);
  const dup = parent.replies.some(
    (r) => String(r?.from || "") === String(from).trim()
      && String(r?.text || "") === String(text).trim()
      && String(r?.at || "").slice(0, 10) === day,
  );
  if (dup) return { ok: true, duplicate: true, replies: parent.replies.length };

  parent.replies.push({
    from: String(from).trim().slice(0, 60),
    text: String(text).trim().slice(0, 500),
    at,
    // `mine` marks an entry she wrote herself.
    //
    // Without it the rule below cannot work at all: 「the last word is theirs」
    // needs to tell her own follow-up apart from a stranger's. Measured
    // 2026-11-06 — a thread where she had already answered came back as
    // "阿元在等你回", with the last reply being her own sentence. The detector
    // would have sent her to answer a question she had just answered, which is
    // the most annoying possible failure for the thing she is talking to.
    mine: Boolean(mine),
  });

  // 按时间排，这样"最后一句"可以直取末位。
  parent.replies.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  if (!video.comments) video.comments = comments;
  raw.updated_at = new Date().toISOString();

  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf8");
  fs.renameSync(tmp, file);

  return { ok: true, replies: parent.replies.length };
}

/**
 * 谁说了最后一句。
 *
 * 这是整个 inbox 的唯一判据，也是 bili-scroll 那条链的核心：
 *   - 最后一句是她自己 → 这条串已经接完了，别催
 *   - 最后一句是对方   → 人家在等她
 *
 * 返回需要她回的那些，按最新在前。
 */
export function waiting(workspaceDir, { maxDays = STALE_DAYS } = {}) {
  const videos = loadVideos(workspaceDir);
  const out = [];

  for (const [key, video] of Object.entries(videos)) {
    const comments = Array.isArray(video?.comments) ? video.comments : [];
    for (const c of comments) {
      const replies = Array.isArray(c?.replies) ? c.replies : [];
      if (!replies.length) continue;

      // The rule, stated once: somebody is waiting only when the LAST thing
      // said in the thread was said by somebody other than her.
      //
      // Taking the last reply blindly is not the same test — it reports her own
      // answer as an incoming message. Walk backwards past anything she wrote;
      // if the newest entry is hers, the thread is already answered.
      const last = replies[replies.length - 1];
      if (!last || last.mine) continue;

      const age = daysSince(last?.at);
      if (age > maxDays) continue;

      out.push({
        videoKey: key,
        title: String(video?.title || "").slice(0, 60),
        mine: String(c?.text || "").slice(0, 120),
        theirName: String(last?.from || ""),
        theirText: String(last?.text || "").slice(0, 200),
        at: last?.at || null,
        ageDays: Math.floor(age),
        replyCount: replies.length,
      });
    }
  }

  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** 写 inbox.md。没有要回的就删掉文件，不留空壳。 */
export function refresh(workspaceDir, opts = {}) {
  const items = waiting(workspaceDir, opts);
  const file = inboxFile(workspaceDir);

  if (!items.length) {
    fs.rmSync(file, { force: true });
    return { count: 0, file: null };
  }

  const lines = [
    "# 谁在等你回话",
    "",
    "这几条的**最后一句是对方说的** —— 不是你去刷，是有人在等你接。",
    "",
  ];
  for (const it of items) {
    lines.push(`## ${it.theirName}（${it.ageDays === 0 ? "今天" : `${it.ageDays} 天前`}）`);
    lines.push(`- 视频：${it.title}`);
    lines.push(`- 你说：${it.mine}`);
    lines.push(`- 对方说：${it.theirText}`);
    if (it.replyCount > 1) lines.push(`- 这一串已经来回 ${it.replyCount} 次`);
    lines.push("");
  }
  lines.push("—— 超过三天的不要再回，突然回一条旧的反而奇怪。");

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, lines.join("\n"), "utf8");
  fs.renameSync(tmp, file);

  return { count: items.length, file };
}

/**
 * 给注入用的一句话。没有就返回 null，不塞"0 条"占位置。
 */
export function summary(workspaceDir, opts = {}) {
  const items = waiting(workspaceDir, opts);
  if (!items.length) return null;

  const names = [...new Set(items.map((i) => i.theirName))].slice(0, 4);
  const first = items[0];
  return {
    count: items.length,
    names,
    text:
      `【有 ${items.length} 条是别人在等你回】` +
      `\n${names.join("、")}${items.length > names.length ? " 等" : ""}接了你的话，最后一句是对方说的。` +
      `\n最近一条：${first.theirName} 说「${first.theirText.slice(0, 40)}」` +
      `\n先去接话，这比再刷几条要紧。`,
  };
}
