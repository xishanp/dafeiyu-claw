// 关于一个人 —— what a person has stated about themselves.
//
// The gap this fills
// ------------------
// `remember_about` has existed all along and writes `memory/facts/<kind>.md` with
// an `about:` field the memory index can filter on. `memory/facts/person.md` even
// holds four real lines about 用户. So the machinery was never missing.
//
// What was missing is a trigger. Measured 2026-11-06: three preference statements
// went through a full turn each and produced diary lines, experience-pool entries
// and a 「最近聊到的」 line — and nothing in `person.md`. A preference is stated on
// the way past, in the middle of a conversation about something else, and nothing
// in the loop ever stopped and said "that was about him".
//
// What counts
// -----------
// Only a statement the person made about themselves, in a form where the subject
// is unambiguous: I like / I hate / I can't eat / I'm allergic / my name is / I
// live in. Narrow on purpose — a wide net here produces a file of half-guessed
// personality traits, which is worse than an empty file, because it reads as
// knowledge.
//
// What it refuses to do
// ---------------------
//   · It never infers a trait. 「昨天吃了香菜」 is an event, not a preference, and
//     inferring 他喜欢香菜 from it is how a memory file becomes fiction.
//   · It never records a negation as its opposite. 不吃香菜 and 吃香菜 differ by one
//     character and mean the two halves of everything.
//   · It never writes the same fact twice. Repeating yourself is not new
//     information, and a file that grows an identical line every day stops being
//     readable.

import fs from "node:fs";
import path from "node:path";

const MAX_PER_FILE = 200;

// Subject must be first or second person. A sentence about a third party
// (「他不吃香菜」) is gossip, not a preference of the person talking.
const FIRST_PERSON = /^(我|俺|咱)/;
// Or "my X is Y" — the subject is the speaker by possessive.
const MY_THING = /^我(的|家|们)?/;

/**
 * Patterns that state something durable about the speaker.
 *
 * Each carries a tag so the written line can say which kind it is. The tag is not
 * used for filtering — it is there so a human reading the file can tell a dislike
 * from a fact without parsing the sentence again.
 */
const PATTERNS = [
  // Dislikes first: 「不喜欢」 contains 「喜欢」, and testing likes first would read
  // every dislike as a like. This ordering is the whole correctness of the module.
  { tag: "讨厌", re: /我(?:特别|很|最|真的|有点|非常|超)?(?:讨厌|不喜欢|不爱|受不了|吃不惯|不吃|不喝|不碰|戒了)/ },
  { tag: "过敏", re: /我(?:对)?[^，。]{0,8}(?:过敏|不能吃|不能喝|吃不了|喝不了)/ },
  { tag: "喜欢", re: /我(?:特别|很|最|真的|有点|非常|超|挺)?(?:喜欢|爱吃|爱喝|爱玩|爱看|爱听|想学|想要)/ },
  { tag: "习惯", re: /我(?:每天|经常|总是|一般|平时|习惯|从来)/ },
  { tag: "身份", re: /我(?:叫|是|住|在|今年|读|养了|家)/ },
  { tag: "经历", re: /我(?:以前|之前|曾经|小时候|去年|上个月)/ },
];

/** Strip the framing so the stored line reads as a fact, not as a quotation. */
function condense(said) {
  return String(said || "")
    .replace(/^[\s「」"'“”]+/, "")
    .replace(/[\s「」"'“”]+$/, "")
    .replace(/[。！!？?]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Does this sentence state something durable about the speaker?
 *
 * Returns { tag, text } or null. `text` keeps the speaker's own words: a
 * paraphrase would be this module's opinion, and the file is supposed to hold
 * what he said.
 */
export function read(sentence) {
  const said = String(sentence || "").trim();
  if (said.length < 4) return null;
  if (!FIRST_PERSON.test(said) && !MY_THING.test(said)) return null;

  // A question is not a statement. 「我喜欢什么来着」 is not a preference.
  if (/[？?]\s*$/.test(said)) return null;
  // Quoted speech inside the sentence means we may be reading someone else.
  if (/[「」"“”]/.test(said)) return null;
  // A third party named before the verb: 「我朋友说我喜欢」 is not about the speaker.
  if (/我(?:朋友|妈|爸|同学|同事|对象|哥|姐|弟|妹)/.test(said)) return null;

  for (const { tag, re } of PATTERNS) {
    if (re.test(said)) {
      const text = condense(said);
      if (!text || text.length < 4) return null;
      return { tag, text };
    }
  }
  return null;
}

function personFile(workspaceDir) {
  return path.join(workspaceDir, "memory", "facts", "person.md");
}

/** The normalised body of a stored line, for duplicate detection. */
function bodyOf(line) {
  // Split on the field separator instead of regex-stripping each field.
  //
  // The stripping version failed on its own output: `\|\s*tag:[^|]+` matched to the
  // end of the line, because the tag field is the LAST field and everything after
  // it is the text. The prefix fields survived, `about:用户|importance:0.75` stayed
  // in the compared body, and the same sentence stored twice never matched itself.
  // Measured: 「我特别讨厌香菜」 written twice, two lines.
  const raw = String(line || "").replace(/^[-*]\s*/, "").trim();
  const body = raw
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p && !/^(\d{4}-\d{2}-\d{2}T|about:|importance:|tag:)/.test(p))
    .join("");
  return body.replace(/\s+/g, "").trim();
}

/**
 * Append one fact about a person, unless it is already there.
 *
 * Duplicate detection compares the whole body with punctuation removed: the same
 * preference said twice in different words is two lines, which is honest, but the
 * same sentence repeated is one. Without this, a person who restates a rule every
 * week fills the file with the same line seven times.
 *
 * `about` is the name the file records, not the internal target key, so the line
 * stays readable and matches what `memory-index` already indexes.
 */
export function remember(workspaceDir, { text, about = null, tag = null, importance = 0.6, at = null } = {}) {
  const body = condense(text);
  if (!body) return { ok: false, reason: "empty" };

  const file = personFile(workspaceDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let prev = "";
  try {
    prev = fs.readFileSync(file, "utf8");
  } catch {
    prev = "";
  }

  const wanted = bodyOf(body);
  if (wanted) {
    const exists = prev
      .split("\n")
      .filter(Boolean)
      .some((l) => bodyOf(l) === wanted);
    if (exists) return { ok: false, reason: "duplicate" };
  }

  const parts = [new Date(at || Date.now()).toISOString()];
  if (about) parts.push(`about: ${String(about).slice(0, 40)}`);
  parts.push(`importance: ${Math.max(0, Math.min(1, Number(importance) || 0.6))}`);
  if (tag) parts.push(`tag: ${String(tag).slice(0, 12)}`);
  const line = `- ${parts.join(" | ")} | ${body}\n`;

  let next = prev.endsWith("\n") || !prev ? `${prev}${line}` : `${prev}\n${line}`;
  // Keep the newest lines. A preference file that grows without bound stops being
  // something she can read in a prompt, which is the only place it is used.
  const lines = next.split("\n").filter(Boolean);
  if (lines.length > MAX_PER_FILE) {
    next = `${lines.slice(-MAX_PER_FILE).join("\n")}\n`;
  }
  fs.writeFileSync(file, next);
  return { ok: true, file, body };
}

/**
 * A prompt line for what she knows about this person.
 *
 * Without this, writing person.md changes nothing she can see: the file was
 * reachable by `recall_about` and by memory search, which means it only surfaced
 * if the model happened to search for it. A preference file nobody quotes back is
 * a file that does not exist as far as the conversation is concerned.
 *
 * Deliberately short. Every line here competes with the diary, the gap list and
 * the rest of the prompt, and a wall of remembered preferences reads as
 * surveillance rather than attention. Highest importance first, capped, and only
 * the statement itself — the timestamps and tags are for the file, not for her.
 */
export function describe(workspaceDir, about = null, { limit = 4, aliases = [] } = {}) {
  const raw = known(workspaceDir, about, 60, aliases);
  if (!raw.length) return "";
  const scored = raw
    .map((l) => {
      const imp = Number((/importance:\s*([\d.]+)/.exec(l) || [])[1] ?? 0.5);
      // The raw trailing text, spaces intact. `bodyOf` strips all whitespace for
      // duplicate comparison, which is right there and wrong here — it turned
      // every date into `2026-10-3122:03` and made the preamble unrecognisable.
      const body = String(l).split("|").slice(-1)[0].trim();
      const m = /\|\s*tag:\s*([^|]+)\s*\|/.exec(l);
      return { imp, body, tag: (m ? m[1] : "").trim() };
    })
    .filter((x) => x.body)
    .sort((a, b) => b.imp - a.imp)
    .slice(0, limit);
  if (!scored.length) return "";

  // Phrase it as "his own words", because they are: this module stores what he
  // said, not a summary of him. Calling it 「你知道的」 would imply the system has
  // a theory about who he is.
  // Old lines were written by hand or by `remember_about`, and they read like
  // 「用户 2026-10-31 说过不喜欢那张表情包」 — the name and the date are inside
  // the text, because there was no `about:` field to put them in. Quoting that
  // back verbatim produces 「他自己说过的用户2026-10-31说过…」, which is not his
  // words, it is a log line.
  //
  // Only the leading `name + date` preamble is removed. The rest is left alone on
  // purpose: rewriting the body would make this module the author of what he
  // said, and the whole point is that it stores his words.
  const stripPreamble = (text) => {
    // Three shapes were found in the live file, and the first attempt at a single
    // regex handled none of them. It ate `wronged` down to `d（我不是这个角色）`
    // because `[^\s，。]{0,20}` ran through the quoted word looking for a date.
    //
    //   1. `用户 2026-10-31 说过…`        name, then date
    //   2. `用户 2026-10-31 18:41 定的…`  name, date, clock
    //   3. `2026-10-31 22:03 起，用户 要求…`  date first, name after
    //
    // Anchored on the date token, which is the one thing all three share, and
    // bounded by whitespace or a comma — never by "any non-punctuation run".
    let t = String(text || "").trim();
    // Known names first, and matched literally. The regexes below used to guess
    // what a name looks like — `[A-Za-z][\w.-]{2,19}` — which silently only
    // worked for latin handles. Anyone whose name is not latin got the whole
    // preamble quoted back at them, name included. Exact-match beats guessing.
    const names = [about, ...(Array.isArray(aliases) ? aliases : [])]
      .map((n) => String(n || "").trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    // Order matters. A body can be `name date …` or `date … name …`, so the
    // date has to come off before the name is matched a second time — one pass
    // in one order leaves the other shape with the name still in it.
    const stripName = (s) => {
      for (const n of names) {
        const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        s = s.replace(new RegExp(`^${escaped}\\s*`), "");
      }
      return s;
    };
    const stripDate = (s) => s
      // date-first: `2026-10-31 22:03 起，`
      .replace(/^\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?\s*[起后]?\s*[，,]\s*/, "")
      // name-first: `<name> 2026-10-31 18:41 `
      .replace(/^\S{1,20}\s+\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?\s*/, "");
    t = stripName(stripDate(stripName(t)));
    // last resort: a bare latin handle with no date at all
    t = t.replace(/^[A-Za-z][\w.-]{2,19}\s+(?=[\u4e00-\u9fa5])/, "");
    // A `定的规矩：` / `要求…` opening loses its subject once the name is gone.
    // Put a light one back so the line reads as a sentence instead of a fragment:
    // 「定的规矩：一个回合发一到两张」 was not something a person says.
    t = t.replace(/^(定的规矩|要求|说过|明确说|提到|讲)/, "他$1");
    t = t.replace(/^[，,、\s]+/, "").trim();
    return t;
  };
  const bits = scored.map((x) => stripPreamble(x.body)).filter(Boolean);
  return `【他自己说过的】${bits.join("；")}`;
}

/**
 * What is already recorded about a person, newest last.
 *
 * Used to avoid asking about something already answered: if she already knows he
 * hates 香菜, a 「跟之前对不上」 gap about 香菜 is not new information.
 */
export function known(workspaceDir, about = null, limit = 40, aliases = []) {
  const file = personFile(workspaceDir);
  let body = "";
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  // Which names count as this person.
  //
  // The `about:` field is written with the canonical name from USER.md
  // (`用户`), while the live event carries the display name (`用户`). Two
  // names, one man. Exact matching on either one alone loses the other half:
  // measured on the real file, `known(ws, "用户")` returned 0 of 4 records.
  //
  // `aliases` is supplied by the caller from USER.md — this module does not
  // invent equivalences, because a module that guesses which names refer to the
  // same person is a module that eventually merges two people.
  const wanted = new Set(
    [about, ...(Array.isArray(aliases) ? aliases : [])]
      .map((x) => String(x || "").trim())
      .filter(Boolean),
  );

  const out = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("- ")) continue;
    if (wanted.size) {
      const m = /\|\s*about:\s*([^|]+)/.exec(line);
      const who = (m ? m[1] : "").trim();
      if (!who || !wanted.has(who)) continue;
    }
    out.push(line.replace(/^-\s*/, "").trim());
  }
  return out.slice(-limit);
}

export const CONSTANTS = Object.freeze({ MAX_PER_FILE });
