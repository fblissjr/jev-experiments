# Exchange units and the keyword baseline: 2026-09-18

This is a dated record of experiment 09's first runs: the unit builder checked against freudagent's synthetic answer key, and the same builder on the owner's real sessions. No model labeled anything, and nothing left the machine. The protocol is in `experiments/09-exchange-labels/README.md`.

The owner's own sessions are described only in words; figures below come from the synthetic set.

## Setup

- The code is version 0.6.0 of this repository.
- The ccutils warehouses were built from a clean export of ccutils `76533fc` (0.20.1), with `--no-thinking` and no facets.
- Synthetic: freudagent `9833c59`, `data/synthetic/`, with its answer key, questions and rule history.
- Real: one project of the owner's, subagents included. `ccutils audit` flagged only columns this one project never fills or fills with a single value; none touch `fact_messages` or its keys.

## Synthetic: units match the key

The builder finds exactly the key's exchange units: none missing, none extra. That includes the replies copied into a planted resumed session, each collapsed under its original session. Every options hash agrees with the key, including `rule_violated`, whose options are the rules in force on each reply's day. freudagent's own label ingest accepted the files with no rejections, and its comparison view gives the same agreement figures as ours.

The first run missed units, for two rules in the builder, and the key was right both times:

- A compaction summary between the assistant's turn and the reply had ended the turn. The owner saw the turn before compacting, so the reply still answers it.
- A local slash command (`/cost`) had opened a new turn. The assistant never answers a local command, so it does not.

These were found against this key, so the synthetic set is now the builder's development set. The real sessions are the check.

Keyword rule against the key:

| Question | Keyword agrees | Majority class on the same rows |
|---|---|---|
| user_response | 46.4% | 53.6% ("correct") |
| correction_kind | 53.3% | 33.3% ("style") |
| rule_violated | 83.9% | 64.3% ("none") |
| frustration | 71.4% | 71.4% ("0") |

On `user_response` the keyword rule does worse than always answering "correct". The synthetic set is built around corrections, so the majority class is unusually strong there.

## Real sessions

The builder runs cleanly on the owner's sessions. Replies copied into forked or resumed sessions collapse to one unit with no text mismatch, and a few long states are cut at the 8,000-character limit.

The keyword rule calls very few of the owner's replies corrections. That is the rule's output, not a measurement. On the synthetic set the same rule caught under a quarter of the planted corrections (23%) and called nothing else a correction, so the real share is likely much higher. The owner's blind labels are what will say.

## Next

- A blind labeling sheet for the owner over a sample of the real replies, with a held-out slice.
- The as-of rule history for real projects, from git history of rule files and ccutils's memory versions, so `rule_violated` can be asked of real replies.
- Claude and Jev arms, after the owner rules on usage and egress.
