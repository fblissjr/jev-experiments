last updated: 2026-09-21

# The branch table on experiment 09's labels: 2026-09-21

A dated record of experiment 12's first run. The protocol is in `experiments/12-branch-table/README.md`. This run is a development check of the code, not a test of the hypothesis: the set it reads tuned experiment 09's unit builder.

## Setup

- Code: version 0.12.0 of this repository.
- Labels: experiment 09's Jev and keyword rows on freudagent `9833c59`'s synthetic set (`runs/09-exchange-labels/jev-synthetic-9833c59/both-labels.jsonl`), model `jev-1.13.0`.
- Key: freudagent's `data/synthetic/eval/exchange_labels.jsonl`, unchanged since `9833c59`.
- Nothing was sent. The run reads files already on disk.

## The join reproduces experiment 09

Top-choice agreement with the key matches `docs/2026-09-18-exchange-labels-jev-synthetic.md` for every question and both labelers: Jev at 91.1%, 93.3%, 94.6% and 60.7%, and the keyword rule at 46.4%, 53.3%, 83.9% and 71.4%. So the branch rows join to the key as experiment 09's scoring does.

## Prevalence

Each figure is the total variation distance from the key's shares: 0 is exact, 1 is disjoint. The interval is a 90% bootstrap interval for counted minus summed, so above zero means summing is closer.

| Question | Jev top choice agrees | Jev counted | Jev summed | Counted minus summed | Keyword rule | Majority class |
|---|---|---|---|---|---|---|
| user_response | 91.1% | 0.054 | 0.080 | -0.026 (-0.062 to 0.004) | 0.536 | 0.464 |
| correction_kind | 93.3% | 0.067 | 0.063 | 0.004 (-0.059 to 0.026) | 0.367 | 0.667 |
| rule_violated | 94.6% | 0.054 | 0.062 | -0.008 (-0.043 to 0.014) | 0.161 | 0.357 |
| frustration | 60.7% | 0.393 | 0.311 | 0.081 (0.047 to 0.114) | 0.268 | 0.286 |

- On the three questions where Jev's top choice agrees with the key more than nine times in ten, counting and summing are within noise of each other. Both are far closer to the key than the keyword rule or the majority class.
- On frustration, where the top choice agrees six times in ten, summing is clearly closer than counting. It is still further from the key than the keyword rule and the majority class. Summing narrows the gap that Jev's pull toward the middle level opens; it does not close it.
- The pattern is what one would expect. When the top choice is usually right, counting it loses little, and the doubt in the distribution is mostly spread onto wrong options. The doubt pays off only where the top choice is often wrong.

## Against the kill condition

The condition applies to a set nothing was tuned on, so it is not applied here. Had it been, summing would have lost: its interval is above zero on one question of four, and the condition needs three.

This set makes the top choice unusually accurate. Its generator planted each signal so it can be read from the reply alone, which leaves little room for a distribution to help. The test set may not behave the same way.

## Calibration over every option

Every `(unit, option, p)` is treated as a forecast that the option is the key's answer.

- For `user_response`, `correction_kind` and `rule_violated`, the calibration error is small: 0.024, 0.020 and 0.047. Options given under 10% are the key's answer under 1% of the time, and options given over 90% are always the key's answer.
- For frustration, the error is 0.202. Levels given under 10% turn out to be the key's answer about one time in nine, and levels given over 90% only about three times in four. This is experiment 09's over-confidence, now seen from the options Jev did not choose as well as the ones it did.

## What this says so far

- Keeping the distribution did not improve prevalence where Jev's top choice is reliable, and it helped where the top choice is weak. On this set, the case for keeping every option does not rest on counting.
- The calibration result points to a use worth testing. On three questions, both ends of the scale are well calibrated. But the middle, where a close call between two options would sit, holds too few options on this set to say whether a close call means real doubt. If it does, the gap between the top two options is the input to routing: which units go to a stronger reviewer. The cascade experiment in the owner's plan is what would test that.
- None of this has been tested on data the code was not developed against.

## Next

- Run on the second synthetic set when it exists, through the path in the owner's plan: bodies built in DuckDB, a ledger dry run the owner approves, then the send.
- Before that set is seen, the owner decides whether to add a second, narrower question alongside the unchanged kill condition: does summing gain where the top choice agrees less than, say, 80% of the time? This run suggests it, so it would be a new hypothesis, stated before the test and not in place of the old one.
