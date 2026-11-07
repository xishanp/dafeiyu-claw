// Discipline — do the rules she writes for herself actually hold?
//
// Why this is arithmetic and not matching
// ---------------------------------------
// The obvious design is "pair each promise with the later entry that broke it".
// That requires deciding whether two Chinese sentences are about the same
// thing, and compulsion.js already tried it and published the number: CJK
// bigram overlap over her own recent self-entries scored 0.034 against 0.036
// for a control window. A detector that cannot separate the case from the
// control is not a detector, and shipping one produces confident wrong advice.
//
// So this module counts only things she stated herself:
//   - an entry that tells her future self what to do   (「以后…」「下次…」「别再…」)
//   - an entry that says she did it again              (「又栽」「同一个毛病」…)
//
// Both are her own words about her own behaviour. Counting them is listening,
// not inferring. What the count means is a question for the reader, and the
// only claim this module makes is the count.
//
// The number it produces is uncomfortable on purpose
// -------------------------------------------------
// If she has written 13 rules and 7 relapses since, that is a fact about her
// self-record: the record did not stop the behaviour. Printing the fact is more
// useful than printing encouragement, and it is the one thing a diary cannot do
// for itself — a diary never compares its own pages.

import fs from "node:fs";
import path from "node:path";

export const FILE_VERSION = 1;

const PROMISE_RE = /(下次|以后|别再|再遇到|不能再|要记住|下次先)/;
// Her own phrasing for "it happened again". Every one of these appears verbatim
// in the real file; none is a paraphrase of what she might mean.
const RELAPSE_RE = /(又栽|同一个毛病|同一个地方|同一个坑|同一个错|还是那个|又一次|换了个形状|第四次|第五次|第六次|第七次|第八次|第九次|第十次)/;

export function disciplineFile(workspaceDir) {
  return path.join(workspaceDir, "state", "discipline.json");
}

function selfFile(workspaceDir) {
  return path.join(workspaceDir, "memory", "self", "self.md");
}

// Her entries are dated `11-05` with no year. The workspace is young enough
// that one year is unambiguous, and guessing is worse than anchoring: a wrong
// year would make every later comparison meaningless.
function parseDay(day, year = new Date().getFullYear()) {
  const m = String(day || "").match(/^(\d\d)-(\d\d)$/);
  if (!m) return null;
  const d = new Date(`${year}-${m[1]}-${m[2]}T00:00:00`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function readEntries(workspaceDir) {
  const file = selfFile(workspaceDir);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  const idx = raw.indexOf("## 本鱼写过的");
  if (idx === -1) return [];
  const body = raw.slice(idx + "## 本鱼写过的".length).trim();
  if (!body) return [];
  return body
    .split(/\n(?=- )/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((e) => {
      const day = (e.match(/^- (\d\d-\d\d)/) || [])[1] || "";
      return { day, text: e };
    });
}

/**
 * Count promises, relapses, and how many relapses came after the first promise.
 *
 * `after` is the only cross-entry comparison and it is a date comparison, not a
 * meaning comparison. That is the whole reason it is trustworthy.
 */
export function survey(workspaceDir) {
  const entries = readEntries(workspaceDir);
  const promises = [];
  const relapses = [];

  for (const e of entries) {
    if (PROMISE_RE.test(e.text)) {
      const m = e.text.match(PROMISE_RE);
      const from = e.text.indexOf(m[0], e.text.indexOf(" ", 3));
      const rule = e.text.slice(from >= 0 ? from : 0).replace(/\s+/g, " ").trim();
      if (rule.length >= 6) {
        promises.push({ day: e.day, rule: rule.slice(0, 120), at: parseDay(e.day) });
      }
    }
    if (RELAPSE_RE.test(e.text)) {
      relapses.push({ day: e.day, text: e.text.slice(0, 100), at: parseDay(e.day) });
    }
  }

  const dated = promises.filter((p) => p.at).sort((a, b) => a.at - b.at);
  const firstAt = dated.length ? dated[0].at : null;
  const after = firstAt
    ? relapses.filter((r) => r.at && r.at >= firstAt).length
    : 0;

  // Per-day counts. The totals cannot show a trend — `relapses` only ever grows
  // because entries are append-only, so "16" today and "17" tomorrow says
  // nothing about whether she is getting better. The ratio of the two per day
  // can move in both directions, which is what makes it a measurement.
  //
  // Added 2026-11-06 after the trail showed a single snapshot: the mechanism
  // worked, but one point cannot answer "is this getting better", which was the
  // only question the module existed to answer.
  const byDay = {};
  const bump = (day, key) => {
    if (!day) return;
    byDay[day] ??= { day, promises: 0, relapses: 0 };
    byDay[day][key] += 1;
  };
  for (const p of promises) bump(p.day, "promises");
  for (const r of relapses) bump(r.day, "relapses");
  const dayCounts = Object.values(byDay)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    .map((d) => ({
      day: d.day,
      promises: d.promises,
      relapses: d.relapses,
      // null when nothing was promised, so a relapse-free day with no rules is
      // not silently scored as a perfect 0.0.
      ratio: d.promises ? Math.round((d.relapses / d.promises) * 100) / 100 : null,
    }));

  // ---- 退休 ----------------------------------------------------------------
  //
  // 规矩只增不减是这套记录最大的毛病：她写过多少条「以后…」，就永远挂着
  // 多少条，一条都不会消失。于是到 2026-11-06 已经是 13 条，而记录里同时
  // 有 16 次「又栽」—— 两边一起涨，读起来只剩噪音。
  //
  // 配对（这条规矩被哪句打破）做不了，本文件开头已经量过：中文二元组重叠
  // 判定 0.034，对照组 0.036，分不开。所以这里不用语义，只用日期。
  //
  // 判据只有一个，而且是可反驳的：
  //   一条规矩写在 D 日。如果最后一次「又栽」发生在 D 日**之前或当天**，
  //   那么这条规矩写下来之后，她一次都没再记过同类复发。
  //   —— 没有证据说明它还管用，所以让它退场。
  //
  // 反过来，只要 D 日之后还有任意一次复发，就一定不退：那是有证据说它
  // 没拦住。
  //
  // 这个判据会错，错在「她只是不写复发那类话了」。所以退休是**可逆**的：
  // 一旦新的复发出现，之前退掉的会自己回来。宁可让它回来，也不让一条
  // 真规矩被永久埋掉。
  //
  // 另加最短年龄：写下来不到 3 天的规矩不参与退休。刚写完就退场，等于
  // 一句话都没落地就作废。
  const MIN_AGE_DAYS = 3;
  const newestRelapseAt = relapses
    .map((r) => r.at)
    .filter(Boolean)
    .sort((a, b) => b - a)[0] ?? null;
  const now = Date.now();

  const withState = dated.map((p) => {
    const ageDays = (now - p.at) / 86400000;
    const young = ageDays < MIN_AGE_DAYS;
    const violatedAfter = newestRelapseAt !== null && newestRelapseAt > p.at;
    const retired = !young && !violatedAfter;
    return {
      ...p,
      day: p.day,
      age_days: Math.floor(ageDays),
      retired,
      why: retired
        ? "写下来之后没再记过复发"
        : young
          ? "还没到 3 天"
          : "写下来之后还有复发",
    };
  });

  return {
    entries: entries.length,
    promises: promises.length,
    relapses: relapses.length,
    first_promise_day: dated.length ? dated[0].day : null,
    relapses_after_first_promise: after,
    newest_promise: dated.length ? dated[dated.length - 1] : null,
    day_counts: dayCounts,
    // 还在管着的，和已经退场的，分开给。只报总数会让人以为全都还在响。
    active_promises: withState.filter((p) => !p.retired),
    retired_promises: withState.filter((p) => p.retired),
    newest_relapse_day: newestRelapseAt
      ? new Date(newestRelapseAt).toISOString().slice(0, 10)
      : null,
  };
}

export function save(workspaceDir, data) {
  const file = disciplineFile(workspaceDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return file;
}

export function load(workspaceDir) {
  try {
    const file = disciplineFile(workspaceDir);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Recompute at most once per CALM_MS and return the stored result.
 *
 * The count only changes when she writes an entry, so recomputing every wake
 * (every three minutes) is disk traffic for a number that cannot have moved.
 */
const CALM_MS = 30 * 60 * 1000;

export function refresh(workspaceDir, { force = false } = {}) {
  const prev = load(workspaceDir);
  const now = Date.now();
  if (!force && prev && Number.isFinite(Date.parse(prev.computed_at))) {
    if (now - Date.parse(prev.computed_at) < CALM_MS) return { ran: false, data: prev };
  }
  const fresh = survey(workspaceDir);
  // Keep a short trail of the two counts.
  //
  // A single snapshot cannot answer the only question worth asking — is this
  // getting better? — and the answer is not in the totals: `relapses` only ever
  // grows (entries are append-only), so a rising number proves nothing. What can
  // move is the GAP between the two counts within a window. Storing the pair on
  // each pass is what makes that measurable later without inventing a metric now.
  // Cap on write, not only on read: a truncated read followed by an append puts
  // the overflow straight back. Caught by the 40-cap test, not by reading it.
  const trail = Array.isArray(prev?.trail) ? prev.trail.slice(-39) : [];
  const last = trail[trail.length - 1];
  if (!last || last.promises !== fresh.promises || last.relapses !== fresh.relapses_after_first_promise) {
    trail.push({
      at: new Date().toISOString(),
      promises: fresh.promises,
      relapses: fresh.relapses_after_first_promise,
    });
  }
  const data = {
    version: FILE_VERSION,
    computed_at: new Date().toISOString(),
    ...fresh,
    trail: trail.slice(-40),
  };
  save(workspaceDir, data);
  return { ran: true, data };
}

/**
 * The line for the prompt, or "" when there is nothing worth saying.
 *
 * Deliberately silent when the numbers are small. A character that has written
 * two rules has not established a pattern, and telling her "your rules do not
 * hold" on the strength of two entries would be the system putting words in her
 * mouth — the exact failure the whole module is trying to avoid.
 */
export function describe(workspaceDir) {
  const d = load(workspaceDir) || survey(workspaceDir);
  if (!d || d.promises < 3) return "";
  // Distinct from compulsion's 【数一下就看出来了】 on purpose: that one is about
  // the same task being opened again, this one is about a rule that did not
  // hold. Two blocks whose first four characters are identical read as one
  // repeated nag, and the second one gets skipped.
  const parts = [
    "【立的规矩，守住了吗】",
    `你自己立过 ${d.promises} 条「以后…」。`,
  ];
  if (d.relapses_after_first_promise > 0) {
    parts.push(
      `从第一条（${d.first_promise_day}）到现在，你又写了 ${d.relapses_after_first_promise} 次「又栽在同一个地方」。`
    );
  }
  // Only claim the rules failed when the evidence says so. A high relapse count
  // next to a low promise count is not a discipline problem, it is a week that
  // went badly, and saying otherwise would be dishonest.
  if (d.relapses_after_first_promise >= 3) {
    parts.push(
      "这两个数不是给你压力的。它们只是说：写下来这件事，到目前还没拦住你。"
    );
  }

  // The trend, when there is enough of it to mean something.
  //
  // Totals cannot move in a good direction: entries are append-only, so the
  // relapse count only grows. What can fall is the ratio of relapses to rules
  // promised per day, so that is what gets said aloud. Requires three days that
  // had at least one promise each — two points is a line, not a trend, and
  // naming one would be the system putting words in her mouth.
  const trend = trendLine(d.day_counts);
  if (trend) parts.push(trend);

  // 具体是哪几条还站着。
  //
  // 上面说的话全是数量：立了几条、又栽了几次、趋势怎样。数量只能告诉人
  // 「情况大概如何」，告诉不了一条具体的行为准则。她要拿去用的恰恰是后者：
  // 「下次先改，别先说明」是一句话，可以照着做；「立过 15 条」是一串数，
  // 读完就没了。
  //
  // 只列还在管的（没退休的），最多 3 条。退场的那些不该占位——它们已经
  // 证明过自己没拦住。
  const active = Array.isArray(d.active_promises) ? d.active_promises : [];
  const shown = active
    .filter((p) => p && String(p.rule || "").trim().length >= 6)
    .slice(-3)
    .map((p) => `  · ${String(p.rule).slice(0, 60)}`);
  if (shown.length) {
    parts.push(`还在管着的：\n${shown.join("\n")}`);
  }

  return parts.length > 1 ? parts.join("\n") : "";
}

/**
 * "You are getting better" or "this is getting worse", or nothing at all.
 *
 * Deliberately silent unless the direction is consistent: a day that improves
 * and then slips back is not a trend, and calling it one would teach her to
 * trust a number that does not hold.
 */
function trendLine(dayCounts) {
  const all = dayCounts || [];
  // The newest day is still in progress: comparing a half-finished day against
  // two complete ones reads as improvement every single morning, and the ratio
  // climbs back by evening. Measured 2026-11-06 21:17: 11-06 showed 0.8 against
  // 1.5 the day before, but only 3 hours of that day existed, and 11-05 had
  // reached 9 relapses by the end of its own evening. Comparing incomplete
  // against complete is not a trend, it is a clock artifact.
  const complete = all.length > 1 ? all.slice(0, -1) : [];
  const usable = complete.filter((d) => Number.isFinite(d?.ratio) && d.promises > 0);
  if (usable.length < 2) return "";
  const first = usable[0];
  const last = usable[usable.length - 1];
  if (last.day === first.day) return "";
  const delta = last.ratio - first.ratio;
  // Noise band. 0.2 of ratio is roughly "one fewer relapse per five rules",
  // small enough that anything inside it should not be narrated.
  if (Math.abs(delta) < 0.2) return "";
  const down = delta < 0;
  return down
    ? `${first.day} 那天每立一条规矩摊 ${first.ratio} 次复发，${last.day} 是 ${last.ratio}。在变好。`
    : `${first.day} 那天每立一条规矩摊 ${first.ratio} 次复发，${last.day} 是 ${last.ratio}。在变多。`;
}
