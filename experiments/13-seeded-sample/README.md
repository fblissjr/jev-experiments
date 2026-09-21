last updated: 2026-09-21

# 13: an agent-seeded sample

What Jev does with data no person has grounded. An agent (Claude, in the session that wrote this) wrote a handful of seed exchanges: a prompt the owner might type to a coding assistant, and a reply to what came back. It wrote permutations of each seed and its own answer key for all of them, and marked the items where it doubts its own key. Nothing here was written or checked by a person.

This is the ungrounded case in `VISION.md`, run on purpose and small, so the owner can see what it looks like before grounded data exists.

Status: seeds written 2026-09-21. The Jev bodies are a ledger dry run waiting for the owner's review.

## The sample

`seeds.jsonl`, one item per line: `item_id`, `seed_id`, `permutation`, `origin` (always model), `author`, the two texts, the agent's `key`, and `unsure`. The permutations, each against its seed:

| Permutation | What changes | What the agent's key does |
|---|---|---|
| seed | nothing | the agent's reading |
| paraphrase | the words | stays the same |
| tone | how heated it is | the response stays; frustration moves |
| context | the prompt it answers | mostly stays |
| edge | the wording, toward a close call | the agent is unsure of its own key |
| flip | the meaning | the response changes |

The questions are experiment 09's `user_response`, `correction_kind` and `frustration`, `v1`, asked of every item in one request. `rule_violated` is left out: it needs a project's rules.

## Ground truth

None. The key is the agent's, so every agreement figure is one model agreeing with another. This is rehearsal by construction. The owner can label the same items blind with `bun run judge`, and the report then scores everything, the agent's key included, against those labels too.

## What to expect, and what can be learned anyway

- Jev will agree with the agent's key where the agent planted a clear signal, which is what agreement on an ungrounded set mostly measures.
- Disagreements should gather on the items the agent marked unsure. Neither side is right there until a person says so.
- Two checks need no ground truth at all. Does Jev keep its answer when a paraphrase or a change of tone keeps the judgment? Does it change its answer when a flip changes the meaning? A model that is unstable on paraphrases is not ready for any use, grounded or not.

## Control

The keyword rule on the same items (`src/keyword.ts`), and the majority class. Neither needs Jev.

## Kill condition

None as a test: it has no ground truth to fail against. The one finding that would count is instability. If Jev changes its `user_response` on most paraphrases that keep the judgment, it counts against using Jev for these questions before any grounding.

## Egress

The Jev bodies hold only the agent-written text in `seeds.jsonl`: no owner text, no session data. They go into the egress ledger as a dry run. Nothing is sent until the owner reads and approves them.

## Running

```sh
bun run seeded build                       # units, the agent's key, the keyword rule, and the dry run
bun run payloads show "<run>" --limit 30   # read the bodies; then approve and send them
bun run payloads approve "<run>"
bun run payloads send "<run>"
bun run seeded report --dir runs/13-seeded-sample/<time>
bun run judge --units runs/13-seeded-sample/<time>/units.jsonl --branches runs/13-seeded-sample/<time>/branches.jsonl --open
```
