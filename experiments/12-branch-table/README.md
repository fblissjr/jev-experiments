last updated: 2026-09-21

# 12: the branch table

Every Jev answer comes with a probability for each option it was offered, and every score with a probability for each level. The SQL integrations built on Jev so far keep only the top option and a confidence: duckdb-jev's functions, and `prompt_jev()` as MotherDuck's announcement shows it. This experiment keeps all of them, one row per option, and asks whether the options Jev did not choose carry information worth keeping.

The first use tested is prevalence: what share of units falls in each option. It is what a table of labels is usually for ("which complaints are growing"), and it is where the two readings of the same answers differ. Counting top choices throws away every unit's doubt; summing probabilities keeps it.

Status: protocol written 2026-09-21. The code runs on experiment 09's existing labels, which is a development check, not the test (see Sets).

## Hypothesis

Summing Jev's probabilities over units estimates each option's share closer to the answer key than counting each unit's top choice.

It can fail, and for a known reason. Summing is only as good as the probabilities: a labeler that is accurate but under-confident spreads mass onto options that are wrong, and counting its top choices would do better. Experiment 09 found Jev slightly under-confident on three questions and over-confident on frustration.

## Controls

None of these needs Jev's distribution:

- Counted top choices, from the same Jev answers.
- The keyword rule's counts. A rule puts all its weight on one option, so its counted and summed estimates are the same.
- The majority class: every unit given the key's most common option on the compared rows.

## Measure

Per question and labeler, on the units the key labels and the labeler answered with the same option set:

- The shares: the key's, counted and summed.
- The total variation distance of each estimate from the key's shares: half the sum over options of the absolute difference. 0 is exact; 1 is disjoint.
- The difference, counted minus summed, with a 90% bootstrap interval over units (2,000 resamples, seeded).
- Agreement of the top choice with the key. It must reproduce experiment 09's figures, which checks the join.
- Calibration over every option, not only the chosen one: each `(unit, option, p)` binned by tenths of `p`, the share of those options that are the key's answer beside the bin's mean `p`, and the expected calibration error (the bins' gaps weighted by their size).

Each unit's probabilities are divided by their sum before use. Jev rounds them to two places, so they sum to between 0.99 and 1.0.

## Kill condition

On a set nothing was tuned on, summing loses if its difference from counting has a 90% interval above zero on fewer than three of the four questions. Then prevalence is not a reason to keep the distribution, and the table's case rests on the other uses (margins for escalation, calibration) until they are tested.

## Sets

- Development: freudagent `9833c59`'s synthetic set, labeled in experiment 09 (`runs/09-exchange-labels/jev-synthetic-9833c59/`). It tuned the unit builder and was planted to be readable from the reply alone, so its result is a check of the code, not of the hypothesis.
- Test: the second synthetic set planned in experiment 09, when it exists. Its Jev answers are to come through the path in the owner's 2026-09-21 plan: bodies built in DuckDB, stored as a ledger dry run, approved by the owner, then sent.

## The branch table

One row per unit, question, labeler and option. It is the contract for every producer: this experiment's reader of label rows now, and SQL over duckdb-jev's answers later.

| Field | Meaning |
|---|---|
| `native_session_id`, `user_entry_uuid`, `question_id`, `question_version` | the unit and question, as in label rows |
| `options_hash` | the option set asked, as in label rows; null for a score |
| `labeler`, `labeler_version` | who answered; for Jev, the versioned model id |
| `option` | the option's label; for a score, the level as a string (`"0"`, `"1"`, ...) |
| `p` | its probability, normalized; 1 for a rule's or key's single answer |
| `is_top` | whether it is the answer the labeler gave |

A labeler with no distribution writes one row per answer, with `p` 1. An option offered to one unit and not another contributes nothing where it was not offered.

## Egress

None. The code reads label files already on disk and sends nothing.

## Running

```sh
bun run branches --labels <labels.jsonl> --key <exchange_labels.jsonl>
```

`--labels` may be given more than once. Output goes to `runs/12-branch-table/<time>/`: `branches.jsonl` (every labeler's rows and the key's) and `summary.json`.
