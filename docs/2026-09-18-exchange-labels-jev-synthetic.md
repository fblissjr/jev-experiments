# Jev on the synthetic exchange set: 2026-09-18

This is a dated record of experiment 09's first Jev run. Jev labeled freudagent's synthetic exchanges, and its labels are scored against the synthetic answer key next to the keyword rule and the majority class. Only synthetic text was sent. The owner's own sessions were not sent and are not described here. The protocol is in `experiments/09-exchange-labels/README.md`.

## Setup

- The code is version 0.7.0 of this repository.
- Model: `jev-1.13.0`, the versioned id named in every response.
- The corpus is freudagent `9833c59`, `data/synthetic/`, read from a ccutils `76533fc` warehouse. freudagent's generator wrote it, and its answer key was fixed before the run.
- State v1: `{ previous_prompt, reply }`, the typed text only. Jev sees no assistant text, so it judges how a reply responds to a turn without seeing that turn.
- All four questions went in one request per exchange, with the contract's question text verbatim. For `frustration`, a score, the recorded value is the most probable level.
- A dry run checked every request first: each state held exactly the two v1 fields, and the key and credential checks refused none.

## Agreement with the key

Each labeler is compared on the same rows as the majority class. Every options hash agreed with the key's.

| Question | Jev | Keyword rule | Majority class |
|---|---|---|---|
| user_response | 91.1% | 46.4% | 53.6% ("correct") |
| correction_kind | 93.3% | 53.3% | 33.3% ("style") |
| rule_violated | 94.6% | 83.9% | 64.3% ("none") |
| frustration | 60.7% | 71.4% | 71.4% ("0") |

## Calibration

Agreement with the key, grouped by the probability Jev gave its answer:

- For `user_response`, `correction_kind` and `rule_violated`, every answer Jev gave at 0.9 or more agreed with the key. Across each question, Jev's mean probability was a few points below its accuracy: slightly under-confident.
- `frustration` is the exception. At 0.9 or more, about three answers in four agreed, against a mean probability near 97%, so Jev was over-confident there.
- The groups below 0.9 hold a handful of rows each; at this size they carry no signal.

## Frustration, broken down

A single accuracy figure hides two different problems here:

- Jev pulls toward the middle of the scale. It never chose "very angry", even for the replies the key rates at that level. Where the key says calm, it said "frustrated but civil" about half the time.
- About half of those calm-to-civil answers are polite corrections, such as a request to drop emojis. That is arguable: "frustrated but civil" is loose wording, and the key may be strict.
- The other half are approvals, questions, redirects, a "continue" and a new task. Those are plain misses.

So the result mixes a vague question with a real bias toward level 1. The level descriptions need sharper wording in a new question version before frustration belongs in any headline.

## Independent check

freudagent loaded these labels through its own ingest and comparison view, in a scratch database, with the answer key beside them. It rejected nothing, accepted the questions as identical to its own, and reproduced every agreement and calibration figure above.

## Cost and time

About $0.002 in total: TypeSafe bills input at $0.042 per million tokens, and each request was about 1.6 KB. The requests ran one after another in about 11 seconds, with no errors or fallbacks.

## How far this goes

- The set is small. Differences under about 15 points are noise, so the `frustration` gap to the majority class is inside it. The over-confidence at 0.9 or more is the more telling part.
- The set is the unit builder's development set, and Claude wrote it, planting each signal so it can be read from the reply alone. That favours a text model over a keyword rule, and it is easier than real replies.
- On real sessions, the owner's blind labels are the test. Nothing real is sent until ccutils's allowlist and the owner's review of each run exist.

## Next

- A second synthetic set that the builder and the question wording were never tuned against.
- A v2 state with the assistant's visible text, measured against v1 on synthetic text first. It stays off for real sessions unless the owner opts in.
- `frustration`: a v2 question with sharper level wording, checked on a second set, before Jev's frustration labels are used for anything.
