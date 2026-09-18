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
- `frustration` is the exception. At 0.9 or more, about three answers in four agreed, against a mean probability near 97%, so Jev was over-confident there. It mostly rated the synthetic corrections as frustrated where the key calls them calm.
- The groups below 0.9 hold a handful of rows each; at this size they carry no signal.

## Cost and time

About $0.002 in total: TypeSafe bills input at $0.042 per million tokens, and each request was about 1.6 KB. The requests ran one after another in about 11 seconds, with no errors or fallbacks.

## How far this goes

- The set is small. Differences under about 15 points are noise, so the `frustration` gap to the majority class is inside it. The over-confidence at 0.9 or more is the more telling part.
- The set is the unit builder's development set, and Claude wrote it, planting each signal so it can be read from the reply alone. That favours a text model over a keyword rule, and it is easier than real replies.
- On real sessions, the owner's blind labels are the test. Nothing real is sent until ccutils's allowlist and the owner's review of each run exist.

## Next

- An independent check: freudagent runs these labels through its own ingest and comparison view.
- A second synthetic set that the builder and the question wording were never tuned against.
- A v2 state with the assistant's visible text, measured against v1 on synthetic text first. It stays off for real sessions unless the owner opts in.
- `frustration`: check whether the over-confidence persists on a second set before treating Jev's frustration labels as usable.
