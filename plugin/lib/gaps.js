// 缺口 — the things that do not add up.
//
// Why this is not `curiosity-extract.js`
// --------------------------------------
// That module finds *names*: a capitalised word, a Chinese noun after 什么是.
// Measured 2026-11-06 against 113 real lines of her own diary, 19 of them were
// actual questions and it extracted **none** — because a question like
// 「为什么我给你发消息你却收不到呢」 has no noun in it. A dictionary lookup and a
// thing that bothers you are not the same event, and a lexicon cannot see the
// second one.
//
// What a gap is
// -------------
// Something in front of her that does not resolve from what she already has:
//
//   question    a question nobody answered. The sentence itself is the gap.
//   mismatch    the same person said contradictory things. Not a fact to store —
//               a reason to ask.
//   dangling    a name or thing appears and nobody explains it. (This is the one
//               case the old extractor already handled; it stays, but it is now
//               one of four rather than the only one.)
//
// Each gap carries a `kind` and the sentence it came from, because "why do I care
// about this" is unanswerable once the sentence is thrown away.
//
// What this refuses to do
// -----------------------
//   · It never decides that she does not know something. It records that a
//     question went unanswered *in the text*, which is a fact about the text.
//   · It never treats her own words as a gap. She is allowed to be uncertain
//     without it becoming a task.
//   · It never invents the thing being asked. If the sentence cannot be read as a
//     question or a contradiction, nothing is produced.

const QUESTION_MARK = /[？?]/;
// Interrogatives that make a sentence a question whether or not it has a mark.
// Kept to the ones that actually ask something; 什么 alone appears in exclamations
// too often ("有什么好笑的") to be a reliable signal by itself.

const ASKS = /(为什么|为啥|怎么会|怎么才|是不是|能不能|可不可以|要不要|到底|究竟|哪来的|哪儿来|凭什么|如何|咋办|咋回事|怎么办|什么原理|是什么意思|是干什么|怎么回事|什么情况|啥意思|什么用)/;
// A question that was answered in the same breath is not a gap.
const ANSWERED = /(因为|所以|原来|答案是|是因为|也就是说|其实就是|其实就|归根到底)/;

// Names, same shape the old extractor used. Kept local so this module does not
// depend on the other one's internals.
const LATIN_NAME = /[A-Za-z][A-Za-z0-9.+#_-]{2,}/g;
// Verbs and ordinary English that a Chinese sentence borrows without meaning a
// proper name. Measured: without this, "ok" and "api" became gaps.
const LATIN_STOP = new Set([
  "the","and","for","with","you","are","but","not","this","that","have","from",
  "can","will","just","like","get","got","see","use","new","one","two","all",
  "app","api","url","ok","okay","yes","no","lol","haha","btw","plz","thx",
  "png","jpg","gif","mp4","pdf","html","css","js","ts","md","exe","zip",
  "http","https","www","com","cn","org","net",
]);

// Contradiction: same subject, opposite polarity, about the same thing.
// Deliberately narrow. A wide net here produces a machine that says "你刚才说
// 不一样" whenever someone changes their mind about lunch, which reads as
// pedantry rather than attention.
// Polarity words. `别` is NOT here: it is a substring of 特别, and including it
// turned 「我特别讨厌香菜」 into polarity -1 with the stem 「我特讨厌香菜」, which
// then never matched 「我最近喜欢上香菜了」. Two full-width characters of context
// cost nothing and remove the entire class of false stem splits.
const NEGATION = /(讨厌|不喜欢|不爱|受不了|吃不惯|过敏|戒了|拒绝|不想|再也不|没兴趣)/;
const AFFIRM = /(喜欢|爱吃|想吃|爱喝|喝|吃|要|经常|每天|总是|爱)/;

// Words that carry no subject at all. Stripped before comparing, because
// 「我最近喜欢上香菜了」 and 「我特别讨厌香菜」 share only 香菜 once the framing
// (我/最近/特别/上/了) is gone.
const STOPWORDS = /(我|你|他|她|它|我们|你们|他们|最近|现在|特别|真的|其实|有点|挺|很|太|最|比较|还|也|都|又|再|就|才|刚|已经|一直|从来|平时|以前|之前|后来|然后|但是|可是|不过|所以|因为|觉得|感觉|认为|知道|发现|确实|好像|应该|可能|一样|这个|那个|这种|那种|东西|事情)/g;
// Aspect particles and directional complements. 「喜欢上香菜了」 leaves 「上香菜了」
// once the verb is removed, and that never equals 「香菜」. Stripping these is not
// cosmetic: without it the comparison silently never fires, which is worse than a
// crude rule because the feature looks present.
const PARTICLES = /(上|下|起来|起|了|过|着|的|地|得|吧|呢|啊|呀|嘛|哦|嗯)/g;

// Resuming something the old sentence rejected (抽烟 after 戒了烟) and going
// somewhere the old sentence avoided (人多的地方…还是去了) are both "I changed my
// mind", even though neither uses a preference verb. Kept separate from AFFIRM so
// they only ever conflict with a stand already on record.
const RESUME = /(又开始|还是去|还是吃|还是喝|还是买|又去|又吃|又喝|又开始)/;
const FLIP = /(再也不|不想|没兴趣|受够了)/;

function key(s) {
  return String(s || "").toLowerCase().replace(/[\s，。！？、,.!?~…]+/g, "").slice(0, 40);
}

function clean(s) {
  return String(s || "")
    .replace(/^[\s「」"'“”]+/, "")
    .replace(/[\s「」"'“”]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is this sentence a question the text never answers?
 *
 * A trailing 呢/吗/吧 without a mark still asks; "为什么…" at the start always
 * asks. The `ANSWERED` check is what keeps a rhetorical run-on from becoming
 * four separate gaps.
 */
export function isOpenQuestion(text) {
  const s = clean(text);
  if (s.length < 6) return false;
  const asks = QUESTION_MARK.test(s) || ASKS.test(s) || /[呢吗][？?]?$/.test(s);
  if (!asks) return false;
  if (ANSWERED.test(s)) return false;
  return true;
}

/**
 * Pull the names out of a line, minus the borrowed-English noise.
 */
export function namesIn(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || "").matchAll(LATIN_NAME)) {
    const raw = m[0];
    if (raw.length < 3) continue;
    if (LATIN_STOP.has(raw.toLowerCase())) continue;
    // Must look like a name, not a word.
    //
    // Capital, digit, or a dot/plus/hash are the obvious signals. But the names
    // she actually meets are lowercase far more often than not — remotion, vulkan,
    // mongodb — and requiring a capital meant 「这个 remotion 是什么原理啊」 gave
    // nothing while `Zink` came through. A length floor separates those from
    // ordinary English: no common short word is six letters of consonant soup, and
    // the stop list above removes the ones that are.
    // Shape, not spelling. Two attempts at guessing "does this lowercase word
    // look like a product name" failed on real examples — `morning` matched a
    // consonant-cluster test and `vulkan` did not, because English and product
    // names overlap too much for orthography to separate them. The signals that
    // do hold are structural: a capital letter, a digit, or a symbol that appears
    // inside identifiers and never inside an English word.
    //
    // Lowercase names are not lost — they arrive through the question path
    // (「这个 remotion 是什么原理」 is a question before it is a name), which is a
    // stronger reason to remember them anyway.
    const namey = /[A-Z]/.test(raw) || /\d/.test(raw) || /[.+#_]/.test(raw);
    if (!namey) continue;
    const low = raw.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(raw);
  }
  return out;
}

/**
 * Find gaps in what one person just said.
 *
 * `prior` is what this same person said before, as an array of { what, at }.
 * It is passed in rather than read here so this stays pure and testable, and so
 * the caller decides how far back "before" reaches.
 *
 * Returns at most `max` gaps, each { kind, text, about }.
 *   kind   "question" | "mismatch" | "dangling"
 *   text   the sentence, cleaned
 *   about  the subject a mismatch concerns, or the name for a dangling gap
 */
export function find(text, { prior = [], max = 3, speaker = "other" } = {}) {
  const said = clean(text);
  if (!said || said.length < 4) return [];

  const out = [];
  const push = (g) => {
    if (out.length >= max) return;
    if (!g.text || g.text.length < 4) return;
    if (out.some((x) => key(x.text) === key(g.text))) return;
    out.push(g);
  };

  // 1. A question nobody answered.
  //
  // Only when SHE is the one who asked.
  //
  // This module reads two different kinds of text and used to treat them the
  // same: her own diary (where an unanswered question really is something she
  // is carrying) and an incoming message (where a question is somebody asking
  // her for something).
  //
  // Measured 2026-11-06, and this was the whole cause of a loop that survived
  // every earlier fix: the owner wrote 「这个角色在干嘛呢？研究如何用电饭煲做白饭吗⚆_⚆」,
  // gaps recorded it as `question / 问了但没人答`, curiosity gave it weight 0.7,
  // and it became a candidate on every wake. She picked it three times in six
  // wakes, each run reaching the streak alarm, and the alarm could only swap in
  // a different candidate — nothing removed this one, so it came back.
  //
  // A question aimed at her is a turn to answer, not a gap to explore. Answering
  // it does not close it either, because she never asked it.
  if (speaker !== "other" && isOpenQuestion(said)) {
    push({ kind: "question", text: said, about: null });
  }

  // 2. Something said now that contradicts something said before.
  //
  // Compared on the *stem* after stripping polarity words, so 讨厌香菜 and
  // 喜欢香菜 land on the same subject. Only a polarity flip on a shared stem
  // counts; two unrelated statements never collide because the stems differ.
  // Compare on what is left after removing the framing and the polarity word.
  // That residue is the subject: 香菜 in both 「我特别讨厌香菜」 and 「我最近喜欢上
  // 香菜了」. Comparing whole sentences never matches, because the framing differs
  // every time; comparing residue is what a person actually does when they hear a
  // contradiction.
  // A stand is what this sentence says about the subject, not a property of the
  // verb. Two failed versions of this came before:
  //   · requiring a polarity word on both sides — missed 「人多的地方我还是去了」
  //     and 「我又开始抽烟了」, which state a stand without using 喜欢 or 讨厌;
  //   · comparing whole stems — never matched, because the framing differs.
  // What actually holds is narrower: the *old* sentence must have taken a stand
  // (that is what makes it worth remembering), and the *new* one must now pull in
  // the other direction about the same subject.
  const polarity = (s) =>
    (NEGATION.test(s) ? -1 : AFFIRM.test(s) ? 1 : FLIP.test(s) ? -1 : RESUME.test(s) ? 1 : 0);
  const subject = (s) =>
    key(
      String(s || "")
        .replace(NEGATION, "")
        .replace(AFFIRM, "")
        .replace(RESUME, "")
        .replace(FLIP, "")
        .replace(STOPWORDS, "")
        .replace(PARTICLES, ""),
    );
  const mine = polarity(said);
  if (mine !== 0) {
    const stem = subject(said);
    // Two characters is the floor: a one-character residue is a coincidence, not
    // a subject. Below it, every sentence with a shared 上/下 would collide.
    if (stem.length >= 2) {
      for (const p of prior) {
        const before = clean(p?.what || "");
        if (!before) continue;
        const theirs = polarity(before);
        if (theirs === 0 || theirs === mine) continue;
        const other = subject(before);
        // Exact equality is too strict for Chinese: 烟 and 抽烟 are the same
        // subject, and neither is a substring-the-other by accident — one is a
        // bound morpheme of the other. Require that the shorter contains nothing
        // the longer lacks, using containment only when the shorter is at least
        // two characters, so 上/下 cannot collide.
        if (!other || !stem) continue;
        const short = other.length <= stem.length ? other : stem;
        const long = other.length <= stem.length ? stem : other;
        // A single character is a real subject when it is a bound morpheme:
        // 烟 lives inside 抽烟. Allowing it only as a suffix of the longer form
        // (「抽烟」endsWith「烟」) keeps 上/下/了 out, since those do not sit at the
        // end of a noun they are supposed to name.
        const same =
          short.length >= 2 ? long.includes(short)
          : long.length <= 3 && long.endsWith(short);
        if (!same) continue;
        push({ kind: "mismatch", text: said, about: before });
        break;
      }
    }
  }

  // 3. A name that showed up and nobody explained.
  //
  // An explanation in the same line ("Zink 是 Mesa 里的驱动") means it is not a
  // gap, which is the difference between "he mentioned it" and "it was answered".
  const explained = /(是|就是|指的是|叫做|叫做|全称|等于|意思是|即)/.test(said);
  if (!explained) {
    for (const n of namesIn(said)) {
      push({ kind: "dangling", text: said, about: n });
    }
  }

  return out;
}

/**
 * Score how much a gap should pull at her.
 *
 * A question is worth asking now; a dangling name is worth noting and waiting.
 * This is the ordering the old numeric pull could not express: 「为什么收不到
 * 消息」 and 「Zygote」 are not on the same scale, and treating them as such is why
 * the pool only ever offered vocabulary.
 */
export function weight(kind) {
  switch (kind) {
    case "mismatch": return 0.9;   // about a person; rarest and most valuable
    case "question": return 0.7;   // an unanswered question is already a task
    case "dangling": return 0.35;  // a word; wait and see whether it recurs
    default: return 0;
  }
}

export const KINDS = Object.freeze(["question", "mismatch", "dangling"]);
