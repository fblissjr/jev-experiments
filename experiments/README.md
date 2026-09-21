last updated: 2026-09-21

# Experiments

## Protocol

Each experiment gets a folder `experiments/NN-slug/`. Its README states these before any code runs:

- Hypothesis: what Jev should decide better, and better than what.
- Control: the arm without Jev. A rule, a fake asker that gives a fixed answer, or the harness's own behaviour.
- Ground truth: what the arms are scored against, and who wrote it. Only people ground a result (`VISION.md`). Against a key a model wrote, the experiment is rehearsal, and its results say so.
- Measure: the numbers compared across arms, and how each one is computed.
- Kill condition: the result that ends the experiment.
- Egress: what leaves the machine, and to whom.

Results go in a dated doc under `docs/`, naming the published version or commit and the Claude Code version they ran against. They report rates and comparisons, not counts that describe the owner's usage. Raw output stays in `runs/`.

A replay reads session logs from `<HOME>/.claude/projects/<project>/*.jsonl`. Pick the sessions deliberately. A real-Jev arm sends their content to TypeSafe.

## Backlog

Ordered by dependency. Compaction comes first because it is what prompted the repo. 01 to 03 are offline replays, so none of them needs function hooks.

| ID | Experiment | Control | Status |
|---|---|---|---|
| 00 | Function-hook surface probe | none | Types generated headless on 2.1.276. Still to do: a live no-op `session.compact` hook that logs trigger and message count, then a `--resume` check against Anthropic issue #95328 |
| 01 | Compaction replay over the owner's session logs: reduction, and how often a dropped fact is needed again later | a rule that drops every non-pinned tool result, the protection rules alone, chance, and the engine's own summary | control arms run 2026-09-18; the Jev arm waits on a key and sessions the owner picks |
| 02 | Question wording for the keep decisions | the reference plugin's default wording | not started |
| 03 | Result visibility: the head and tail of each result in the state | results hidden, as in the reference plugin | not started |
| 04 | Live `session.compact` hook | the built-in summary | blocked until 01 to 03 show Jev beating the rule |
| 05 | AskUserQuestion: Jev's pick against the answer the owner actually gave, replayed from session logs | the first option, or the recommended one | not started |
| 06 | Skill routing on `prompt.submit` or `prompt.context` | the harness's own skill selection | not started |
| 07 | Answering the harness's own `$.model.classify` calls with Jev | core's classifier | unverified: where core calls it is not known |
| 08 | `tool.call` guard for risky actions | permission rules alone | not started |
| 09 | Exchange labels: each typed reply of the owner labeled for approval, correction kind, rule broken and frustration, feeding freudagent | a keyword rule, the majority class, and the owner's blind labels | unit builder, keyword and Jev arms built; Jev run on the synthetic set 2026-09-18; real sessions wait on an allowlist and the owner's review |
| 10 | Wording defects in H3 video prompts that the format checks miss: an unplaced person, an action with no agent, a contradicted count. Matched pairs from the prompt bank's fix commit | the format grader, rules for the mechanical classes, a fake asker | run 2026-09-19: placement killed as worded, agentless action survives on two pairs, counts are noise (`docs/2026-09-19-prompt-wording-jev.md`) |
| 11 | Structured generation of H3 prompts on an engine branch: a hierarchical scene plan filled field by field and rolled up into the prompt | the engine's current single-call planner, and the same plan filled by an LLM alone | owner decisions recorded 2026-09-19; built with the engine repo's session once 10's checker exists |
| 12 | The branch table: every option Jev gave, one row each, and whether summing its probabilities estimates prevalence better than counting its top choices | counted top choices, the keyword rule, the majority class | rehearsal on 09's synthetic labels 2026-09-21, against a key a model wrote: summing is clearly closer only on frustration, the one question where the top choice is weak (`docs/2026-09-21-branch-table.md`); the test waits on the owner's blind labels |
| 13 | An agent-seeded sample: seeds, permutations and a key an agent wrote, to see how Jev behaves with no grounding, and whether it keeps its answer on paraphrases and changes it on flips | the keyword rule, the majority class | built 2026-09-21; the Jev bodies are a dry run waiting for the owner's review |
