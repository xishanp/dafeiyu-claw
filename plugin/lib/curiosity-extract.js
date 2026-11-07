// Finding things she might not know.
//
// This module does one thing: given a piece of text, return the specific things
// in it that a person could plausibly need explained. Not topics, not phrases,
// not "what this paragraph is about". Particulars.
//
// Three signals, in descending order of precision:
//
//   1. Latin names — `Zink`, `gpt-4.1`, `c++`, `node.js`. A capitalised latin
//      word or anything with digits/punctuation in it. This is the reliable
//      case, because in mixed Chinese prose a capitalised latin word is almost
//      always a proper name rather than vocabulary.
//
//   2. Questions — `靠什么知道该进还是该退` / `什么是 redox`. Chinese has no
//      casing, so shape carries no information about proper-noun-hood. What
//      Chinese does have is question grammar, and a question is by definition
//      a place where understanding is missing. This is a *weaker* signal than
//      (1) — a question may be rhetorical or already answered — but it is the
//      only structural signal Chinese offers.
//
//   3. Nothing else. Chinese n-gram novelty was tried and abandoned: measured
//      against 131 KB of her own memory it produced `自制科技小玩`,
//      `是最孤独的浪`, `有人撞了你一` — fragments of ordinary prose, cut at
//      arbitrary boundaries. The failure is structural, not a tuning problem:
//      without a word segmenter and a general vocabulary, "not in my 131 KB of
//      notes" is indistinguishable from "not a word". Noise here is worse than
//      silence, because a list full of ordinary phrases teaches her that the
//      list is not worth reading.
//
// Everything returned is a *candidate*. Whether it is novel, and whether it
// pulls on her, is decided in curiosity.js.

// Words that show up in this plugin's own tool output and in ordinary English
// prose. The latin branch below only accepts capitalised words and words with
// digits or punctuation, which already excludes most vocabulary — but sentence-
// initial words pass that shape test, so the common openers are listed here.
// Kept short on purpose: a long blocklist ages badly and silently rots.
const COMMON = new Set([
  "the", "this", "that", "these", "those", "there", "their", "them", "then",
  "they", "with", "from", "which", "while", "when", "where", "what", "whom",
  "whose", "would", "could", "should", "about", "after", "before", "other",
  "also", "than", "more", "most", "some", "such", "only", "over", "into",
  "just", "like", "made", "make", "many", "much", "must", "need", "next",
  "once", "part", "same", "seen", "take", "thing", "think", "through", "time",
  "told", "took", "turn", "under", "until", "very", "want", "well", "were",
  "will", "within", "without", "word", "work", "world", "year", "your",
  "here", "have", "been", "does", "did", "was", "are", "but", "not", "you",
  "all", "any", "can", "for", "and", "its", "our", "out", "one", "two", "new",
  "use", "used", "using", "see", "seen", "get", "got", "how", "why", "who",
  "now", "may", "way", "day", "let", "say", "said", "she", "him", "her",
  // Structural noise from tool output and JSON-ish payloads.
  "http", "https", "www", "json", "null", "none", "true", "false", "error",
  "warning", "status", "result", "output", "input", "value", "count", "text",
  "data", "type", "name", "size", "utf", "ascii", "hash", "index", "total",
  "undefined", "async", "await", "const", "function", "return", "import",
  "export", "default", "void", "false",
  // Interface labels, not things in the world.
  //
  // Measured 2026-11-06: `Fetch` reached seen=9 and sat at pull=0.70, making it
  // the top candidate on every wake — the system kept telling her to go and
  // find out what "Fetch" means. The words came from tool envelopes (`## Web
  // Fetch`, `Search results`), where they are headings, not nouns. Sentence-
  // initial position made them pass the capital-letter shape test.
  //
  // These are titles of sections, buttons and verbs. None of them is ever a
  // proper name, in either language.
  "fetch", "search", "page", "click", "query", "results", "result",
  // `web` and `http`-family labels are the envelope of every fetched page.
  // Kept separate from the verb list above because they are not verbs: they are
  // the transport the text arrived on, which is never the thing worth learning.
  "web", "http", "https", "url", "uri", "api", "app", "site", "website",
  "open", "close", "load", "loaded", "save", "saved", "send", "read",
  "write", "edit", "delete", "copy", "paste", "run", "start", "stop",
  "add", "remove", "update", "create", "list", "view", "show", "hide",
  "next", "back", "home", "menu", "login", "logout", "signin", "signup",
  "submit", "cancel", "confirm", "continue", "retry", "refresh", "reload",
  "download", "upload", "share", "follow", "like", "comment", "post",
  "reply", "message", "notification", "settings", "profile", "account",
  "help", "about", "contact", "privacy", "terms", "policy", "more",
  "loading", "ready", "done", "success", "failed", "failure", "skip",
  "previous", "current", "total", "count", "index", "page", "pages",
  "header", "footer", "sidebar", "content", "main", "section", "article",
  "step", "note", "warning", "error", "info", "debug", "trace", "log",
  "summary", "details", "expand", "collapse", "toggle", "filter", "sort",
  "browser", "chrome", "firefox", "safari", "screenshot", "snapshot",
  // HTTP / fetch envelopes. Measured 2026-11-06 on her real store: `Source`,
  // `External`, `AUTH`, `Fwd` and `Domai` all reached the pool because a
  // capital letter was the only admission test. None of them is a thing in the
  // world — they are the transport headers around a fetched page.
  "source", "external", "auth", "fwd", "domain", "domai", "host",
  "header", "headers", "cookie", "cookies", "agent", "referer", "origin",
  "endpoint", "payload", "response", "request", "method", "protocol",
  "cache", "redirect", "timeout", "retry", "fallback", "proxy",
  // Calendar / pagination labels from scraped listings.
  "day", "days", "week", "month", "year", "today", "yesterday",
  "january", "february", "march", "april", "june", "july", "august",
  "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

// Extensions that mean "this token is a filename", not "this token is a name".
// Matched only when the token actually ends in one, so `node.js` and `gpt-4.1`
// still pass: neither extension is in this list.
const FILE_EXT = new Set([
  "md", "txt", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf",
  // `js`, `ts`, `py`, `go`, `rs`, `c` are deliberately absent: they are also
  // language names, and `node.js` / `learn.py` are things she might legitimately
  // not know. A file called `x.js` is caught by the multi-segment check below.
  "mjs", "cjs", "tsx", "jsx", "rb", "java", "cpp", "hpp", "bash", "ps1",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "pdf",
  "mp4", "mov", "mp3", "wav", "m4a", "webm", "flac",
  "log", "tmp", "bak", "zip", "tar", "gz", "dmg", "iso",
  "html", "css", "scss", "lock", "env", "sql", "db", "sqlite",
]);

// Question grammar in Chinese. Each entry captures the part *after* or
// *before* the interrogative, because that is where the unknown sits.
const ZH_QUESTION = [
  /(?:什么是|什么叫|啥是|是啥|啥意思|什么意思|怎么理解|是什么东西|是干什么的)[\s「"']*([\u4e00-\u9fa5A-Za-z0-9][\u4e00-\u9fa5A-Za-z0-9.\-+#_]{1,14})/g,
  /([\u4e00-\u9fa5A-Za-z0-9][\u4e00-\u9fa5A-Za-z0-9.\-+#_]{1,14})\s*(?:是什么|是啥|什么意思|是干什么的|怎么用|干嘛的)/g,
];

// A whole question, for the case where the unknown is not a noun but the
// question itself ("靠什么知道该进还是该退"). Bounded so a paragraph does not
// come back as one giant entry.
// Note: ASCII space is a separator too. `为什么不直接烤 非用 2.45GHz？` is one
// question; letting it run across spaces truncated real ones at the length cap.
const ZH_WHOLE_QUESTION = /([^，。！？\n「」\t]{6,44})[？?]/g;
const HAS_INTERROGATIVE = /什么|为什么|怎么|如何|到底|是否|能不能|为啥|多少|哪|谁/;

/**
 * Latin-shaped names in the text.
 *
 * Acceptance: starts uppercase, OR carries digits/punctuation (`gpt-4.1`,
 * `c++`, `node.js`, `h264`). Rejecting lowercase vocabulary by shape is what
 * keeps `language` and `driver` out — an earlier version accepted every word
 * of four letters or more and produced both of those from one sentence.
 */
export function latin(text) {
  const raw = String(text ?? "");
  if (!raw) return [];

  // Latin-1 accented letters are included on purpose. `Schrödinger` without `ö`
  // matches as `Schr`, which is not a name anyone can look up — and a truncated
  // name is worse than no name, because it enters the list looking legitimate
  // and then never matches anything she reads later.
  // `\b` is not used at the tail: in JavaScript `\b` is defined against
  // `[A-Za-z0-9_]`, so `Poincaré` ends on a non-word character and the boundary
  // test cuts the last letter. Explicit lookarounds over the same class keep the
  // accented tail inside the token.
  const found = raw.match(/(?<![A-Za-z\u00c0-\u024f])[A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f0-9.+#_-]{2,30}(?![A-Za-z\u00c0-\u024f0-9])/g) ?? [];
  const out = [];
  const seen = new Set();

  for (const word of found) {
    // Trailing sentence punctuation is not part of the name.
    const clean = word.replace(/[.+#_-]+$/, "");
    if (clean.length < 3) continue;

    const low = clean.toLowerCase();
    if (seen.has(low)) continue;
    if (COMMON.has(low)) continue;

    // The discriminator: must look like a name, not like vocabulary.
    const looksNamed = /^[A-Z]/.test(clean) || /[0-9.+#_-]/.test(clean);
    if (!looksNamed) continue;

    // API attribute chains (`ImageDraw.text`) are code, not names. A capitalised
    // stem followed by a lowercase member is the shape of a method call site
    // pasted into a log, which is where these came from.
    if (/^[A-Z][A-Za-z0-9]+\.[a-z][a-z0-9]+$/.test(clean)) continue;

    // `h264`-style model numbers explain themselves rarely and clutter the
    // list; a bare letter plus digits is not worth an entry.
    if (/^[a-z]\d+$/i.test(clean)) continue;
    if (/^(.)\1+$/i.test(clean)) continue;

    // Web-fetch envelopes are not names either.
    //
    // Measured on the first live run after restart (2026-11-06 07:40): all three
    // first noticings were `EXTERNAL_UNTRUSTED_CONTENT`, `www.gotohui.com` and
    // `show-819136` — the scaffolding around a fetched page, not anything inside
    // it. She would have gone looking for the meaning of a boundary marker.
    //
    // Cause: `web_fetch` wraps third-party text in tags plus a source header, and
    // extraction runs over the wrapped result rather than the page body. Filtering
    // here covers any future tool that returns a similar envelope.
    //
    // ALL-CAPS with an underscore is a constant; a bare caps word (`DSH`, `DAO`)
    // is a real name and must survive, so the underscore is required.
    if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(clean)) continue;
    // Domains and URLs. `com` is not in FILE_EXT, so the filename rule let
    // `www.gotohui.com` straight through.
    if (/^(?:www[.])?[a-z0-9-]+([.][a-z0-9-]+)*[.](?:com|org|net|cn|io|dev|edu|gov|co|info|xyz|uk|jp|de|fr|ru|au|ca|ac|eu|me|tv|cc)([/:?#].*)?$/i.test(clean)) continue;
    // Long lowercase pinyin runs are URL slugs, not names:
    // `xinxiangshi_pingyuanshifanqu` is a path segment from a government site,
    // five words glued together with underscores. A real name does not look like
    // that in either language.
    if (/^[a-z]{4,}(?:_[a-z]{2,})+$/.test(clean) && clean.replace(/_/g, '').length >= 12) continue;
    // Bare markup words from fetched pages.
    if (/^(?:raw-html|html|json|text|markdown|content|body|head|title)$/i.test(clean)) continue;
    // Hash-like tokens: no vowel structure worth pronouncing, all hex.
    if (/^[a-f0-9]{8,}$/i.test(clean) && !/[g-z]/i.test(clean)) continue;

    // A URL search query is not a name. `water+absorption`,
    // `aged+rice+water+absorption`, `Koch+2004+Nature+maximum+tree` — every one
    // of these reached her store on 2026-11-06. The `+` is a URL-encoded space,
    // so what got stored was the query she had just typed, handed back to her as
    // the thing she does not understand. Two or more `+` is the tell: a real
    // name never glues three words with plus signs.
    if ((clean.match(/\+/g) ?? []).length >= 2) continue;
    // A bare `A+B` pair is the same shape at smaller size (`AD+IH`, `B9+103`).
    // Legitimate names never use `+` as an internal separator.
    if (/^[A-Za-z0-9.]+\+[A-Za-z0-9.+]+$/.test(clean)) continue;
    // Social handles: a pronounces-nothing tail of digits glued to letters.
    // `ljwxxs695`, `Benfish03`, `fanlai1030133`, `laosanjia1111317` — these came
    // from Douyin comment metadata and are account ids, not concepts. She can
    // never look up what "ljwxxs695" means, so storing it only wastes a wake.
    // Bound is 4 trailing digits so `gpt-4`, `h264`, `b9` and `Li526` survive.
    if (/^[A-Za-z][A-Za-z0-9]*[0-9]{4,}$/.test(clean) && !/^[A-Z][a-z]+[0-9]{4}$/.test(clean)) {
      const letters = (clean.match(/[A-Za-z]/g) ?? []).length;
      if (letters / clean.length >= 0.5) continue;
    }
    // Social handles. Measured 2026-11-06: eleven Douyin account ids reached
    // her store — `ljwxxs695`, `Benfish03`, `fanlai1030133.5`,
    // `laosanjia1111317.4`, `Jingyu_81815.3`, `meishaonvchepin5.6`. These are
    // the handles of people whose videos she watched, not concepts. She can
    // never look up what "ljwxxs695" means, so each one is a wasted wake.
    //
    // The shape is a word run glued to a digit run with no separator, or a
    // trailing `.digits` weight suffix that the platform appends. Legitimate
    // version-like names (`gpt-4.1`, `node.js`, `h264`, `B9`) are all rejected
    // by neither test: they keep a one- or two-digit tail, and `node.js` ends in
    // a known extension that the filename rule already handles.
    if (/\.[0-9]+$/.test(clean)) {
      // `gpt-4.1` is a version, not a handle. A hyphen before the digit run is
      // the tell: platforms never put a hyphen between a name and its weight.
      if (!/^[A-Za-z][A-Za-z0-9]{1,}-[0-9]/.test(clean)) continue;
    }
    if (/[A-Za-z]{4,}[0-9]{3,}$/.test(clean)) continue;
    // `Benfish03` — a capitalised word plus a two-digit suffix. `h264` and `b9`
    // are lowercase-led or all-digits, so they survive this one.
    if (/^[A-Z][a-z]{3,}[0-9]{2,}$/.test(clean)) continue;
    // Scrabble-free consonant runs longer than any real word: `ljwxxs`, `dypl`.
    // Vowel ratio alone misses these because the digit tail pads the length.
    if (/^[bcdfghjklmnpqrstvwxz]{4,}/i.test(clean) && !/[aeiou]/i.test(clean.slice(0, 8)) && !/-/.test(clean)) continue;
    // Douyin-style handle: letters and digits interleaved with no separator, and
    // an opening consonant run that no word contains. `dypl8iw7rto40` — 8
    // letters, 4 digits, opening on `dypl` which is unpronounceable in any
    // language. A hyphen anywhere means it is a product version (`gpt-4.1`),
    // so that escape is required.
    if (!/-/.test(clean) && /[0-9]/.test(clean) && /^[bcdfghjklmnpqrstvwxz]{3,}/i.test(clean)) continue;
    if (!/-/.test(clean) && /[0-9]/.test(clean) && /^[bcdfghjklmnpqrstvwxyz]{3,}/i.test(clean)) continue;

    // `Day29`-style calendar labels: an English word glued to a small number.
    if (/^(?:day|week|month|year|page|step|part|vol|no|item)[0-9]{1,3}$/i.test(clean)) continue;

    // Any dotted multi-label token where the last label is short and has no
    // vowel is a host or a namespace (`.ebi.ac.uk` already fails the TLD list
    // below; this catches anything TLD-shaped that the list has not learned
    // yet). Guarded so `node.js` survives: `js` is an extension and is on the
    // FILE_EXT list, which is handled further down.
    if (/^(?:[a-z0-9-]+\.){2,}[a-z]{2,}$/i.test(clean)) {
      const tld = clean.split(".").pop().toLowerCase();
      if (!FILE_EXT.has(tld)) continue;
    }

    // API chains in either case: `page.goto`, `browserType.connectOverCDP`,
    // `ImageDraw.text`. The original rule required a capital stem, so the
    // lowercase ones came straight through on 2026-11-06.
    if (!/\.[a-z0-9]{1,5}$/i.test(clean) && /^\w+\.[a-z][A-Za-z0-9]*$/.test(clean)) continue;
    if (/^(?:page|browser|window|document|element|console|driver|client|context)\.[a-z]/.test(clean)) continue;

    // Mixed-case random strings: `ZxWkhrGqVqihBVl6ZY8QtPHg1T9i`, `x9G9QDmMXq`.
    //
    // Both reached her store on 2026-11-06 from fetched page text. The pure-hex
    // test above misses them because they carry letters past `f`. Their shape is
    // the tell: real names alternate consonant and vowel runs a human can
    // pronounce, while an id switches case mid-word and sprinkles digits without
    // a separator. Requiring *both* a digit and an interior case flip keeps
    // `NodeJS`, `JavaScript`, `PowerShell` and `iOS` out of the reject list.
    const body = clean.replace(/[^A-Za-z0-9]/g, "");
    const hasDigit = /[0-9]/.test(body);
    const midCaseFlip = /[a-z][A-Z]/.test(body) || /[A-Z][A-Z][a-z]/.test(body);
    const vowelish = (body.match(/[aeiouAEIOU]/g) ?? []).length;
    if (body.length >= 8 && hasDigit && midCaseFlip) continue;
    // A long token with almost no vowels is not pronounceable, so not a name.
    if (body.length >= 10 && vowelish / body.length < 0.15) continue;
    // Generated ids: a lowercase slug glued to a long digit run (`show-819136`).
    // Bound is 4 digits so `gpt-4` and `h264` survive — those are the sort of
    // thing this module exists to notice.
    if (/^[a-z]{2,12}-[0-9]{4,}$/i.test(clean)) continue;
    // Filenames and paths are not unknowns. Measured on her real notes, this
    // branch produced `SKILL.md`, `USER.md`, `percapita.png`, `claims_of.py`,
    // `dafeiyu-normal.png` — her own file inventory, offered back to her as
    // things she does not understand. The extension is the tell.
    if (/\.[a-z0-9]{1,5}$/i.test(clean) && FILE_EXT.has(clean.split(".").pop().toLowerCase())) continue;
    // `x.js` slips past the extension list above, so a minimal stem plus a code
    // extension is treated as a filename. The bound is 2 characters, not 4:
    // `node.js`, `vue.js` and `deno.ts` are product names she may genuinely not
    // know, while `a.js` and `x.py` are always files. A stem carrying a digit or
    // underscore (`v2.py`, `my_mod.ts`) is a file too.
    if (/^[a-z0-9]{1,2}\.(?:js|ts|py|go|rs|c|h|sh)$/i.test(clean)) continue;
    if (/^[a-z0-9]*[0-9_][a-z0-9_]*\.(?:js|ts|py|go|rs|c|h|sh)$/i.test(clean)) continue;
    // Hyphenated paths she works in every day. These are her own tooling, not
    // things she needs explained. Deliberately an allowlist of *prefixes* rather
    // than a shape: a shape rule also swallowed `node.js` and `vue.js`, which are
    // exactly the kind of thing this module is supposed to notice.
    if (/^(?:workspace|agent|state|memory|lib|test|scripts|dafeiyu|openclaw)(?:[-_.][a-z0-9]+)+$/i.test(clean)) continue;
    if (/^(?:workspace|agent|state|memory|lib|test|scripts)$/i.test(clean)) continue;

    seen.add(low);
    out.push(clean);
  }
  return out;
}

/**
 * Questions in Chinese text, reduced to the thing being asked about.
 *
 * Returns the noun after `什么是`, or the whole question when the interrogative
 * sits inside the clause. The whole-question form is deliberately included:
 * measured against her own logs, the interesting unknowns were questions
 * (`为什么不直接烤 非用 2.45GHz`), not nouns.
 */
export function zhQuestions(text) {
  const raw = String(text ?? "");
  if (!raw) return [];

  const out = [];
  const seen = new Set();
  const nouns = [];

  const push = (s) => {
    const t = String(s).trim().replace(/^[，、。：\s「」"']+/, "").replace(/[的了呢吧啊呀嘛哦诶嗯]+$/, "");
    if (t.length < 2 || t.length > 44) return null;
    const low = t.toLowerCase();
    if (seen.has(low)) return null;
    seen.add(low);
    out.push(t);
    return t;
  };

  // Noun form first: `什么是 redox` yields `redox`, which is what a lookup
  // actually needs.
  for (const re of ZH_QUESTION) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw))) {
      // The noun branch runs the same pronoun test as the sentence branch. Without
      // it, `两万人在底下问本鱼的钥匙是什么` yielded the 15 characters before
      // `是什么` as a thing-to-look-up, because the reversed capture happily
      // crossed a clause boundary to fill its length budget.
      if (/[你我他她它咱本鱼]/.test(m[1])) continue;
      const t = push(m[1]);
      if (t) nouns.push(t.toLowerCase());
    }
  }

  // Whole-question form. Requires an interrogative so a plain declarative
  // sentence ending in `?` does not qualify.
  //
  // The separators in ZH_WHOLE_QUESTION include ASCII space so a sentence like
  // `为什么不直接烤 非用 2.45GHz` does not run past its own full stop and get
  // truncated at 38 characters. See the note on that constant.
  ZH_WHOLE_QUESTION.lastIndex = 0;
  let q;
  while ((q = ZH_WHOLE_QUESTION.exec(raw))) {
    const body = q[1].trim();
    if (!HAS_INTERROGATIVE.test(body)) continue;
    // Sentences that are about a person, or addressed *to* someone, are
    // conversational rather than curious. `你为什么这样` is not a gap, and
    // neither is `两万人问我主人的钥匙` — measured on her real notes, that line
    // came back as a curiosity about the world, which it is not.
    // Pronouns anywhere disqualify it. Measured on her real notes, the line
    // `两万人在底下问本鱼的钥匙是什么，本鱼留了一句…` came back as a curiosity
    // about the world purely because the comma kept the pronoun out of the first
    // clause. A question with `我/你/他` in it is about people, not about how
    // something works, and the thing worth knowing from that line was `API`.
    if (/[你我他她它咱本鱼]/.test(body)) continue;
    // If the question merely *contains* an already-captured noun and adds no
    // other unknown, the noun is the better entry: `redox` is searchable, the
    // sentence is not. Only drop it when the whole body adds nothing beyond
    // that noun.
    const lower = body.toLowerCase();
    const redundant = nouns.some((n) => lower.includes(n) && lower.replace(n, "").replace(/[\s什么是叫啥意思]/g, "").length < 3);
    if (redundant) continue;
    push(body);
  }

  return out;
}

/** All candidates worth offering from a block of prose. Capped. */
export function names(text, { max = 3 } = {}) {
  const out = [];
  const seen = new Set();
  for (const n of [...latin(text), ...zhQuestions(text)]) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

/** From a search result. Search is where she most often meets something new. */
export function fromSearchResult(result, { max = 3 } = {}) {
  const text = resultText(result);
  if (!text) return [];
  return names(text, { max });
}

/**
 * From a comment thread.
 *
 * Comments are the richest text she meets while browsing, because they are
 * written by people reacting rather than by whoever made the thing. Someone
 * asking "这什么原理" under a video is naming a gap that the video itself did
 * not close — which is exactly the shape of the thing worth looking up.
 *
 * The bar is higher than plain text: only questions, and only ones about the
 * world rather than about the person. A comment saying "你为什么这样做" is
 * conversation, not curiosity.
 */
export function fromComments(text, { max = 2 } = {}) {
  const raw = String(text ?? "");
  if (!raw) return [];
  return zhQuestions(raw).slice(0, max);
}

/**
 * From something a person said.
 *
 * Same rules, but capped harder. A person's sentence is usually *about* the
 * thing already under discussion, so offering several names per message would
 * mean offering the conversation back to her.
 */
export function fromSpeech(text, { max = 2 } = {}) {
  return names(text, { max });
}

/**
 * Flatten a tool result of any known shape into text.
 *
 * Tool results arrive as a plain string, as `{content:[{text}]}` for this
 * plugin's own tools, and as arbitrary objects from harness tools. Flattening
 * in one place keeps every caller from branching on shape.
 */
export function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result?.content)) {
    return result.content
      .map((c) => (typeof c === "string" ? c : c?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof result?.text === "string") return result.text;
  if (typeof result?.output === "string") return result.output;
  try {
    return JSON.stringify(result).slice(0, 4000);
  } catch {
    return "";
  }
}

export const INTERNALS = Object.freeze({ resultText, COMMON, FILE_EXT });
