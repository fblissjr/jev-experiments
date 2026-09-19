last updated: 2026-09-19

# Jev on H3 prompt wording defects: 2026-09-19

A dated record of experiment 10's first Jev run. The protocol is in `experiments/10-prompt-wording/README.md`. No prompt text, prompt name or clause is reproduced here.

## Setup

- The bodies were built at version 0.9.0 (`411e6e3`) and sent at 0.9.1 (`4d320cc`), as the ledger records them. Model `jev-1.13.0`, the versioned id in every response.
- Source: the `prompt_bank/` folder of the owner's H3 prompt bank repo, at the wording-fix commit and its parent, read through `git show`. No other folder of that repo is readable by the command.
- Every request was built into the egress ledger first, checked to be a verbatim slice of its file, and read and approved by the owner before the send. The send transmits only approved bodies and would refuse any that differed; none differed. All bodies were sent, none refused, no errors.
- The answer key was derived from the fix commit before any answer existed: which shots each fix changed, and which defects its changed clause removed.
- Three questions, one per class, as `v1` nouls. A shot's text is one request; a whole prompt's description is another.

## What was asked

Three classes that the format grader cannot see. Every prompt in this set passed that grader both before and after its fix, so the grader separates none of these pairs. That is the floor.

The measure is matched pairs: the same unit before the fix and after it. A defect Jev sees should score lower once the fix removed it. Untouched prompts are weak negatives, compared at the same shot position.

## Results

| Class | Pairs | Dropped after the fix | A coin does this well or better | Defective median | Fixed median | Untouched median | Untouched 90th |
|---|---|---|---|---|---|---|---|
| unplaced person | 8 | 5 | 36% of runs | 0.72 | 0.37 | 0.20 | 0.68 |
| agentless action | 2 | 2 | 25% of runs | 0.76 | 0.47 | 0.22 | 0.41 |
| contradicted count | 4 | 2 | 69% of runs | 0.13 | 0.13 | 0.07 | 0.10 |

Where each defective unit sits among untouched units at the same shot position:

- unplaced person: 88, 95, 90, 91, 47, 95, 88, 93 (percent of untouched units scoring lower)
- agentless action: 96, 99
- contradicted count: 87, 98, 98, 97

The control arms: the format grader cannot separate any pair, by construction. A fake asker that answers the same for every unit drops on none. A coin drops on half.

## Against the kill condition

The kill condition was written before the run: a class dies if the answer fails to drop on more than one of its pairs, or if the defective units do not score above the 90th percentile of untouched units.

- **Unplaced person: killed.** Three of eight pairs did not drop. One of those sits at the 47th percentile of untouched units, so Jev did not see that defect at all. In the other two the answer barely moved, and both versions score above the 85th percentile, which is what it looks like when something else in the shot still reads as unplaced. The class dies as worded in `v1`.
- **Agentless action: survives, on two pairs.** Both dropped, and both defective units score above every untouched unit's 90th percentile. Two pairs is not a result; a coin does this well in a quarter of runs.
- **Contradicted count: dead, as expected.** Every answer sits between 0.04 and 0.15, so the spread is noise at this scale. TypeSafe's own notes say the model does not count.

## The prompts the sweep named

The sweep that produced the fixes also named prompts it flagged and the owner did not fix, one prompt it deliberately did not flag, and one it held up as placement done right. None of them was touched by the fix commit, so all are in the untouched set. Their highest score, and where that sits among untouched units at the same shot position:

| What the sweep said about it | Unplaced person | Agentless action |
|---|---|---|
| flagged, not fixed: one rope with two holders | 0.74, 91st | 0.72, 96th |
| flagged, not fixed: the person addressed is placed only in the next shot | 0.78, 93rd | 0.31, 50th |
| flagged, not fixed: the weakest count row, two variants | 0.56 and 0.58, 68th and 71st | 0.26 and 0.37 |
| deliberately not flagged: chaos is its brief | 0.12, 41st | 0.39, 85th |
| named as a model of placement done right | 0.74, 87th | 0.48, 85th |

Two of the flags the fix left alone land in Jev's top decile, which is the strongest evidence here that it sees something real. The prompt the sweep called correct lands there too, at 0.74, above four of the eight defective units. Both readings come from the same question, which is the case for rewording it rather than keeping it.

## What the numbers do and do not say

- The separation is real but not proven by the pair test. Defective units score well above the untouched median in two classes, and above the 88th percentile in 7 of 8 placement pairs. At this many pairs, the pair test cannot rule out chance for any class.
- The untouched prompts are weak negatives. A Claude subagent passed them; nothing else did.
- The eight defective placement units share a shape that most untouched shots do not: a speaker, someone addressed, and a silent third person. So their high ranks are partly the shape, not the defect. The fixed versions still sit well above the untouched median, and the sweep's counter-example sits higher still, which says `v1` answers "this shot has someone being addressed" more than "that person has no place".
- Agreement with a wording fix is not a video outcome. Nothing here says a fixed prompt renders better.
- The three mechanical classes were not asked of Jev, and their rule arm is not built yet, so this run says nothing about them.

## Cost

554 requests, about 397,000 input tokens, about $0.017 in total, and about 100 seconds of wall clock. No errors and no refused bodies.

## Next

- A `v2` for the placement question, narrowed to the person spoken to or acted on. It would be written with these eight pairs and the counter-example in view, which makes them its development set: a `v2` counts as tested only on pairs it has not seen. `v1` asks about any person in the shot, and it scores the sweep's own counter-example as high as most defective units, which is what a question that is too broad looks like.
- The rule arm for the mechanical classes, so the cheap half of this is measured too.
- More pairs. Eight, two and four are too few to conclude anything, and the fix commit is the only source of pairs that exists today.
