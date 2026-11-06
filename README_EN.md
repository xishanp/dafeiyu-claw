<h1 align="center">dafeiyu-claw</h1>

<p align="center">
  <strong>Give an AI agent a continuous self — emotion, relationships, memory, intent, curiosity.</strong>
</p>

<p align="center">
  Seven copy-paste prompt templates · An optional reference implementation · Hard-won lessons
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <b>English</b> ·
  <a href="ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/LESSONS.md">Lessons</a>
</p>

<p align="center">
  <img alt="Prompts" src="https://img.shields.io/badge/Prompts-7%20files-DC2626">
  <img alt="Reference" src="https://img.shields.io/badge/Reference%20impl-61%20tools-2563EB">
  <img alt="Modules" src="https://img.shields.io/badge/Modules-39-7C3AED">
  <img alt="Tests" src="https://img.shields.io/badge/Tests-232%20passing-16A34A">
  <img alt="Deps" src="https://img.shields.io/badge/Dependencies-0-6B7280">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-16A34A">
</p>

<p align="center">
  <sub>Prompts work standalone · Implementation is optional · Runtime-agnostic · No personal data</sub>
</p>

---

## What this is

Most agents only exist after you speak. You ask, it answers; you stop, it disappears.

This repository handles the rest: **what it is when nobody is talking.**

Three things must hold at once:

| | Problem solved | Failure mode |
|---|---|---|
| **Memory is on disk** | What it thought last turn is readable this turn | A restart erases the person |
| **Emotion decays** | How much of this morning's compliment is left tonight, as a number | Frozen at `mood: happy` forever |
| **It moves without a prompt** | Picks something from its own unfinished work | Either random messages, or nothing at all |

Only with all three does "continuous" become real. Miss one and you have a chat interface.

---

## 1. The seven prompts (the main body)

In the repo root. **Runtime-agnostic.**

| File | Governs | In one line |
|---|---|---|
| [`prompt-IDENTITY.md`](prompt-IDENTITY.md) | Who she is | A boundary declaration, not character decoration |
| [`prompt-SOUL.md`](prompt-SOUL.md) | How she talks | Typing style matters more than personality description |
| [`prompt-AGENTS.md`](prompt-AGENTS.md) | Where she works | What may be touched, what may not |
| [`prompt-USER.md`](prompt-USER.md) | User model | Preferences, not biography |
| [`prompt-MEMORY.md`](prompt-MEMORY.md) | Memory structure | Three layers, each with a job |
| [`prompt-COGNITION.md`](prompt-COGNITION.md) | How she thinks | Contains the full **curiosity** mechanism |
| [`prompt-PROACTIVE.md`](prompt-PROACTIVE.md) | When to speak up | And when to say nothing |

```bash
cp prompt-IDENTITY.md  <your-workspace>/IDENTITY.md
cp prompt-SOUL.md      <your-workspace>/SOUL.md
cp prompt-AGENTS.md    <your-workspace>/AGENTS.md
cp prompt-USER.md      <your-workspace>/USER.md
cp prompt-MEMORY.md    <your-workspace>/MEMORY.md
cp prompt-COGNITION.md <your-workspace>/COGNITION.md
cp prompt-PROACTIVE.md <your-workspace>/PROACTIVE.md
```

> [!NOTE]
> Every file has `<...>` placeholders. Replace them all before use.
> It won't crash if you don't, but it will describe itself incorrectly.

---

## 2. Curiosity: a separate mechanism

The part most often built wrong. Covered in detail in
[`prompt-COGNITION.md`](prompt-COGNITION.md) section 15.

### 2.1 The problem it solves

> **You cannot feel the things you don't know.**

There is no alarm that rings when you lack a piece of knowledge. So you cannot
drive this by instruction — "think about what you don't know" has no answer.

The only workable path is **passive capture**: record the gap at the moment
the friction actually happens.

### 2.2 What counts as friction

| Type | Trigger |
|---|---|
| **Question** | She said "I don't know" / "never heard of it" |
| **Recall** | Memory search came back empty or incomplete |
| **Search** | Search returned nothing, or clearly wrong results |
| **Browse** | Hit an unfamiliar term while scrolling |

Captured by an `after_tool_call` hook, not by self-report.

### 2.3 How it differs from the other three

| Mechanism | Question asked | Example |
|---|---|---|
| Wants | What do I **want** to do? | "Go see that exhibition" |
| Activities | What haven't I **done** lately? | "Haven't drawn in two weeks" |
| Topics | What did I **leave unsaid**? | "That conversation got cut off" |
| **Curiosity** | What do I **not understand**? | "What does this word actually mean" |

The first three are "what I owe." The fourth is "what I don't know."

**This distinction decides whether she degrades into a filing system.**
Model curiosity as a to-do list and you get "re-read the things I half-watched" —
that's tidying, not curiosity. Tidying is comforting; curiosity moves forward.

### 2.4 Three core decisions

**One: rank by urgency, not by time.**

```
urgency = 0.42 × times_encountered
        + 0.30 × freshness
        + 0.28 × confidence
        + 0.08 × never_proposed
```

A five-times-encountered old gap outranks a brand new one, because repeated
friction is stronger evidence of a real gap. Count is sqrt-compressed:
`min(1, sqrt(n)/4)`.

**Two: "resolved" and "dropped" are recorded separately.**

```
resolved  ← figured it out, with a note
dropped   ← gave up, no reason needed
```

Both are legitimate endings. But **giving up is not learning**, and the system
must not let it look like progress.

**Three: each source has its own kill switch.**

Not one global toggle — four independent ones. Because a source can be entirely
noise while another is precise, and turning off curiosity wholesale would lose the
good one.

### 2.5 Measured: why the kill switch matters

Ran the "browse" source against 29 real short-video records:

```
Videos triggered    3 / 29
Terms minted        astra, deepseek, python, DeepSeek
Actually unknown    0 / 4
```

**All four were terms she already knew.** `deepseek` is the name of her own model.

Result: **that source is off by default.**

> [!IMPORTANT]
> **Better nothing than noise.**
>
> A false gap is worse than no gap — she learns "this list is noise" and stops
> reading it. An ignored feature is worse than a missing one.

### 2.6 Where the code is

| File | Role |
|---|---|
| `plugin/lib/curiosity.js` | Storage, urgency, eviction, stats |
| `plugin/lib/curiosity-extract.js` | Extraction from tool results |
| `plugin/index.js` | `after_tool_call` hook, two tool registrations |

---

## 2.5 Circling: why trying harder does not help

**The symptom.** Two or three days on the same thing, each round feeling closer.
No anxiety, no block, in fact quite absorbed — so no moment ever suggests
stopping. If that thing has no finish line (make the image look better), then
version 52 and version 5 are the same object.

**Four causes, none of which is "lack of discipline".**

| Cause | What it looked like | Fix |
|---|---|---|
| Someone else's question recorded as her curiosity | You ask "what are you working on?"; that becomes a question she never answered | Track the speaker; only her own writing counts |
| The streak counter resets on any interruption | alarm -> switch -> counter zeroed -> four more rounds | Count within a window |
| Exploration competing on score | 0.42 vs 0.45; three percentile points decided an afternoon | Remove from the pool; offer only when empty-handed |
| Filler when idle | "try taking a picture" plugged the gap | Empty hands means go out |

**The key one: exploration cannot be scored.** One is "the work I am doing",
the other is "should I change direction at all", which is a precondition, not a
rival. The test is existence, not score.

**Repetition: the first four times do not count.** Then it starts decaying, with
no floor. The prompt also names it: "you have touched this one 7 times". The
right response is to answer *what is different now from the first time?* If you
can answer, close it. If you cannot, pick a version and declare it finished.
**Work with no finish line is complete wherever you declare it.**

---

## 3. Reference implementation (optional)

`plugin/` is a complete, runnable implementation.

```bash
cp -r plugin ~/.openclaw/extensions/dafeiyu-core
```

**Self-contained.** `shared/` lives inside `plugin/`, not outside it.

```
index.js         7,500+ lines
lib/             39 modules, 10,700 lines
test/            232 tests, all passing
tools            61 registered
hooks            11 registered
dependencies     0
```

---

## 4. Boundaries

- **No personal data.** Accounts, group IDs, paths, keys are all placeholders.
- **No real memory contents.** `workspace/memory/` is entirely example templates.
- **No hardcoded paths.** Everything goes through `os.homedir()` or config.
- MIT.

---

<p align="center">
  <sub>"She isn't answering you. She's living."</sub>
</p>
