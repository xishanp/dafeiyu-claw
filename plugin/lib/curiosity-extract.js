// Gap extraction: turning what happened in a turn into a topic worth knowing.
//
// The original (dsh-brainagent) had one signal — empty recall — and one caller.
// One signal in a system that produces four kinds of ignorance means the gap
// list stays empty, which is exactly the failure we already had with
// `activity-inject`: a mechanism that is correct and never fires.
//
// So the extraction is split out from the store (`lib/curiosity.js`) and given
// four explicitly attributed inputs. Attribution matters beyond bookkeeping:
//
// - `recall`   she went looking, shelf was empty. The strongest signal.
// - `question` she said out loud that she does not know. Rare, very strong.
// - `search`   she looked something up. Means the gap was already felt — a
//              record of it, not a discovery.
// - `browse`   she saw a word or name she does not recognise while scrolling.
//              Weakest, and the one that fires most, which is why it is the
//              one that most needs a floor.
//
// Everything here is pure: text in, topics out. No I/O, no model calls. That
// keeps it testable without a workspace and cheap enough to run inside
// `after_tool_call`, which must never stall a turn.
//
// The deliberate refusal: no extraction from *her own output*. Her own words
// are already in the loop as wants and notes. Reading them back as gaps would
// make her curious about herself, which is a different (and much louder)
// failure mode than being curious about the world.

/** Words that mean "I do not know", in the forms she actually uses. */
const NOT_KNOWING = [
  "不知道",
  "不清楚",
  "没听说过",
  "没听过",
  "不太懂",
  "不懂",
  "不了解",
  "没概念",
  "啥是",
  "什么是",
  "是啥",
  "怎么回事",
  "没搞明白",
  "没弄明白",
  "想不起来",
  "记不清",
];

/** Phrases that only look like ignorance. Excluded so the list stays honest. */
const FALSE_POSITIVES = [
  "不知道你",
  "不知道该怎么",
  "不知道说什么",
  "不懂事",
  "不管",
  "不认识路",
];

/** A candidate must be at least this long after trimming to count as a topic. */
const MIN_TOPIC = 2;
const MAX_TOPIC = 60;

function tidy(s) {
  return String(s ?? "")
    .replace(/[「」『』"'“”‘’]/g, "")
    .replace(/[\s\u3000]+/g, " ")
    .replace(/^[，,、；;：:。\.\s]+/, "")
    .replace(/[，,、；;：:。\.\s]+$/, "")
    .trim();
}

/** Strip a trailing particle clause so "X是什么" yields "X". */
function stripQuestionTail(s) {
  return tidy(
    String(s ?? "")
      .replace(/(是什么东西|是什么|是啥|是怎么回事|怎么回事|怎么办|为什么|为啥|是谁|吗|呢|啊|呀|吧)\s*$/g, "")
      .replace(/^(为什么|为啥|什么是|啥是|请问)/g, ""),
  );
}

function accept(candidate) {
  const t = stripQuestionTail(candidate);
  if (t.length < MIN_TOPIC || t.length > MAX_TOPIC) return null;
  // A topic made only of punctuation or only of one repeated character is not
  // a topic. Both happen when a regex slice lands on a fragment.
  if (!/[\p{L}\p{N}]/u.test(t)) return null;
  if (/^(.)\1+$/u.test(t)) return null;
  return t;
}

/**
 * Signals from a `recall_about` / `who_is` / `recall_links` result.
 *
 * The wording is the contract: these tools already say plainly when the shelf
 * was empty ("没找到关于「X」的牵连", "查不到就是真没连上"). Parsing our own
 * tool's prose is not elegant, but it is the only place the emptiness is
 * *stated* — inferring it from a short result would guess wrong on a genuinely
 * short answer.
 *
 * Returns [] when the call found something. A hit is not a gap; that is the
 * entire point of the distinction.
 */
export function fromRecall(evt) {
  // `event` comes from a hook and is typed optional. Destructuring a null
  // throws before any guard can run, so the guard has to be the first line.
  const { params, result } = evt && typeof evt === "object" ? evt : {};
  const text = resultText(result);
  if (!text) return [];

  const query = tidy(params?.query || params?.about || params?.name || "");
  const empty =
    /没找到|查不到|没有找到|没有关于|没有相关|真没连上|找不到/.test(text);
  if (!empty) return [];

  // Prefer the phrase the tool itself quoted when it echoed the query, because
  // it is already the display form she used.
  const quoted = text.match(/[「『]([^」』]{2,60})[」』]/);
  const topic = accept(quoted?.[1] || query);
  if (!topic) return [];
  return [{ topic, domain: "knowledge", context: text.slice(0, 100) }];
}

/**
 * Signals from a person-lookup that did not resolve.
 *
 * Separate from `fromRecall` because the domain differs: "who is this" is a
 * person gap, and a person gap should be phrased as a question about a person
 * rather than about a fact. Kept narrow on purpose — `who_is` returning
 * nothing is common for strangers she has merely seen, and recording every one
 * of those would fill the list with strangers.
 */
export function fromWhoIs(evt) {
  const { params, result } = evt && typeof evt === "object" ? evt : {};
  const text = resultText(result);
  if (!text) return [];
  if (!/不认识|没见过|没记录|查不到|没找到|没有关于/.test(text)) return [];

  const name = tidy(params?.name || params?.query || "");
  // Only names she addressed by name, not ids or blank lookups.
  if (!name || /^\d+$/.test(name)) return [];
  const topic = accept(`「${name}」是谁`);
  if (!topic) return [];
  return [{ topic, domain: "person", context: text.slice(0, 100) }];
}

/**
 * Signals from her own prose: "我不知道 X 是什么".
 *
 * This is the highest-precision source and the rarest. It only fires on
 * explicit self-report, which is why the false-positive list matters: "不知道
 * 你在说什么" and "我不知道该怎么办" are the same surface form and neither is
 * a knowledge gap.
 */
/**
 * The topic of "X 我不知道", where the marker comes LAST.
 *
 * Forward extraction cannot see this at all — there is nothing after 不知道 —
 * and it is the more natural Chinese order. Walk back to the previous clause
 * boundary, then peel the conjunction and the pronoun/verb scaffolding that
 * sits between the topic and the marker.
 */
function backwardTopic(scan, at) {
  const before = scan.slice(Math.max(0, at - 60), at);
  const chunks = before.split(/[。！？!?\n；;，,、]/).map((c) => c.trim()).filter(Boolean);

  // Walk back across chunks, not just the last one. "某某为什么掉得最快，我
  // 不知道" puts the topic one comma earlier than the pronoun, so taking only
  // the final chunk yields "我" — a pronoun, not a topic.
  for (let i = chunks.length - 1; i >= 0 && i >= chunks.length - 3; i--) {
    const candidate = peel(chunks[i]);
    if (!candidate) continue;
    // A lone pronoun or filler is scaffolding, not a topic. Keep walking.
    if (/^(我|我们|你|他|她|它|这|那|这个|那个|什么|怎么)$/.test(candidate)) continue;
    if (candidate.length < 2) continue;
    return candidate;
  }
  return "";
}

/** Strip conjunctions in front and pronouns/auxiliaries behind. */
function peel(clause) {
  // A clause that is already a question ("某某为什么掉得最快") is the topic
  // verbatim — it must not be peeled, or the question mark survives as the
  // whole topic and `accept` rejects it as punctuation.
  const unpunctuated = clause.replace(/[？?]+\s*$/, "").trim();
  if (/为什么|为啥|怎么|如何|多少|哪里|什么/.test(unpunctuated)) {
    return unpunctuated;
  }
  let t = clause.replace(/^(但|但是|不过|而且|然后|所以|因此|只是|可|却)\s*/g, "").trim();
  for (let i = 0; i < 3; i++) {
    const next = t
      .replace(/(我|我们|也|都|还|真的|确实|其实|就是|好像|一直|从来)\s*$/g, "")
      .trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

export function fromQuestion(text, opts) {
  const { context = null } = opts && typeof opts === "object" ? opts : {};
  const raw = String(text ?? "");
  if (!raw) return [];

  // The false positives are phrases, not sentences: "我不知道你在说什么" and
  // "我不知道 Zink 是什么" share a prefix and only one is a gap. Blank the
  // offending phrase out spatially rather than skipping the whole sentence,
  // so a sentence carrying both still yields its honest half.
  let scan = raw;
  for (const bad of FALSE_POSITIVES) {
    if (scan.includes(bad)) {
      scan = scan.split(bad).join("　".repeat(bad.length));
    }
  }

  const out = [];
  const seen = new Set();
  for (const marker of NOT_KNOWING) {
    let from = 0;
    while (true) {
      const at = scan.indexOf(marker, from);
      if (at === -1) break;
      from = at + marker.length;

      // Everything after the marker up to a natural stop. Capped tightly: a
      // long tail is almost always the rest of a sentence, not the topic.
      const tail = scan.slice(at + marker.length, at + marker.length + 80);
      const cut = tail.split(/[。！？!?\n；;，,]/)[0];
      let topic = accept(cut);
      // Nothing after the marker is the commonest real form in Chinese:
      // "Zink 我确实不知道" has the topic in front and no tail at all.
      if (!topic) {
        topic = accept(backwardTopic(scan, at));
      }
      if (!topic || seen.has(topic)) continue;
      seen.add(topic);
      out.push({ topic, domain: "knowledge", context: context || marker });
    }
  }
  return out.slice(0, 3);
}

/**
 * Signals from a search she ran herself.
 *
 * She used Tavily, so she was already chasing something. Recording the query
 * is not discovering a gap — it is keeping the receipt. That distinction is
 * why this is a lower-confidence source than `recall`, and why it never
 * proposes the same query twice in a day (`recent` filter in the caller).
 */
export function fromSearch(evt) {
  const { params } = evt && typeof evt === "object" ? evt : {};
  const q = tidy(params?.query || params?.q || "");
  const topic = accept(q);
  if (!topic) return [];
  // Single words are too ambiguous to be a topic ("天气", "Vulkan"). A gap
  // needs enough shape to be recognisable a week later.
  if (topic.length < 4) return [];
  return [{ topic, domain: "knowledge", context: "她自己去搜的" }];
}

/**
 * Signals from scrolling: an unfamiliar capitalised word or a latin term.
 *
 * The weakest source by a wide margin, and the one with the loudest failure
 * mode: a scroller full of product names would otherwise mint a gap per video.
 * Two guards: only latin-script terms of 4+ characters, and only when the
 * buffer does not already look like it taught her the term (no glossary line).
 */
export function fromBrowse(evt) {
  const { text, known = [] } = evt && typeof evt === "object" ? evt : {};
  const raw = String(text ?? "");
  if (!raw) return [];

  const out = [];
  const seen = new Set();
  const latin = raw.match(/\b[A-Za-z][A-Za-z0-9.+#_-]{3,24}\b/g) ?? [];
  // Known terms are stored as whole topics, and a topic that came from a
  // Chinese sentence looks like `transformer 的注意力机制` — one string with a
  // latin word buried in it. Comparing the bare word against that string never
  // matches, so a word she had already recorded got minted again. Splitting the
  // known set into its latin tokens is what makes the filter actually work.
  const knownSet = new Set();
  for (const k of known || []) {
    const s = String(k).toLowerCase();
    knownSet.add(s);
    for (const w of s.match(/[a-z][a-z0-9.+#_-]{3,24}/g) ?? []) knownSet.add(w);
  }

  for (const word of latin) {
    const low = word.toLowerCase();
    if (seen.has(low) || knownSet.has(low)) continue;
    // Skip anything that is clearly structural rather than a term.
    if (/^(https?|www|com|html|json|true|false|null)$/i.test(word)) continue;
    seen.add(low);
    out.push({ topic: word, domain: "word", context: raw.slice(0, 60) });
    if (out.length >= 2) break; // two per scroll, never more
  }
  return out;
}

function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  // Tool results arrive as { content: [{ type, text }] } in this plugin's own
  // tools and as plain objects from harness tools. Flatten both shapes rather
  // than branching at every call site.
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

export const INTERNALS = Object.freeze({ accept, stripQuestionTail, resultText });
