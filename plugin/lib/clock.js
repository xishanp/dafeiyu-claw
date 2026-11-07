// Time awareness for dafeiyu.
//
// The Gateway only injects a DATE ("2026-11-01"), never the hour. Without the
// hour the character cannot tell 03:00 from 21:00, so a "spontaneous" opener
// lands at the wrong moment: cheerful chatter at 3am, or a sleepy line at noon.
// Every line below exists to give the model one concrete, actionable fact about
// when "now" is, in the terms a person would actually think in.

const ZONE = "Asia/Shanghai";

function shanghaiParts(d = new Date()) {
  // Fixed +08:00. China has no DST, so this is exact and does not depend on a
  // timezone database being present in the sandbox.
  const ms = d.getTime() + 8 * 60 * 60 * 1000;
  const t = new Date(ms);
  return {
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    weekday: t.getUTCDay(),
    iso: t.toISOString(),
  };
}

/**
 * The calendar day, in the zone the character actually lives in.
 *
 * `new Date().toISOString().slice(0,10)` is UTC, which in UTC+8 rolls the day
 * over at 08:00 local. Everything said between midnight and eight in the
 * morning was being filed under the previous day: the diary split one evening
 * across two files, "today's deeds" listed yesterday's, and a first message of
 * the morning did not count as a new day of knowing someone.
 *
 * Any day-scoped bookkeeping must use this, not the UTC slice.
 */
function todayIn(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return t.toISOString().slice(0, 10);
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** Which part of the day it is, in the terms the character thinks in. */
function phaseOf(hour) {
  if (hour >= 1 && hour < 5) return { name: "凌晨", hint: "这个点正常人都在睡" };
  if (hour >= 5 && hour < 8) return { name: "清早", hint: "刚起床的点，人还迷糊" };
  if (hour >= 8 && hour < 11) return { name: "上午", hint: "在忙的时候" };
  if (hour >= 11 && hour < 14) return { name: "中午", hint: "吃饭午休的点" };
  if (hour >= 14 && hour < 18) return { name: "下午", hint: "下午，容易犯困" };
  if (hour >= 18 && hour < 22) return { name: "晚上", hint: "一天里最闲的时候" };
  if (hour >= 22 && hour < 24) return { name: "深夜", hint: "快睡了，话会变少" };
  return { name: "凌晨", hint: "这个点正常人都在睡" };
}

/**
 * How long since this person last said anything here.
 * `lastInboundAt` is an ISO string or epoch ms from the proactive store.
 */
function silenceLine(lastInboundAt) {
  if (!lastInboundAt) return "";
  const then = typeof lastInboundAt === "number" ? lastInboundAt : Date.parse(lastInboundAt);
  if (!Number.isFinite(then)) return "";
  const min = Math.floor((Date.now() - then) / 60000);
  if (min < 0) return "";
  if (min < 5) return "刚刚还在说话";
  if (min < 60) return `有一阵没说话了（约 ${min} 分钟）`;
  const h = Math.floor(min / 60);
  if (h < 24) return `隔了挺久（约 ${h} 小时）`;
  return `上次说话是 ${Math.floor(h / 24)} 天前了`;
}

/** Build the one-line context block injected before the model speaks. */
export { todayIn, shanghaiParts };
// Which outfit is on right now.
//
// IDENTITY.md describes both, so the model had to work out "am I in the day
// one or the night one" from the clock on every single turn — one reasoning
// hop that produced mistakes (night clothes described at noon). Deciding it
// here turns that into a fact it reads instead of a judgement it makes.
// 19:00–08:00 is the knit sweater, everything else is the maid dress.
function outfitOf(hour) {
  return hour >= 19 || hour < 8 ? "毛衣那套（宅在家、快睡了的样子）" : "女仆装那套";
}

export function describeClock({ lastInboundAt } = {}) {
  const p = shanghaiParts();
  const phase = phaseOf(p.hour);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  const lines = [
    `【现在】${WEEKDAYS[p.weekday]} ${hh}:${mm}，${phase.name}。${phase.hint}。` +
    `这会儿穿的是${outfitOf(p.hour)}，不用自己推。`,
  ];
  const gap = silenceLine(lastInboundAt);
  if (gap) lines.push(`（${gap}）`);
  return lines.join("\n");
}

