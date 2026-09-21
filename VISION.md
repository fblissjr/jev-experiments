last updated: 2026-09-21

# Vision: grounded branches

The idea behind these experiments, sized for one person tinkering: one model step, its outputs, and what they are measured against. A few of its principles are borrowed from the owner's vision in freudagent, which is written for a whole organization; the ones kept here are those that still hold with one person doing the judging.

## The short version

Jev, GLiNER, a small classifier and a frontier LLM are the same kind of thing: a universal transformation function. Unstructured state goes in and a typed answer comes out. From the models that expose it, you also get a probability for every answer the model could have given. Those are probabilistic branches, and keeping them is better than keeping one reply. A chat turn hands back one sampled answer and throws away the rest of what the model computed.

But a branch is a model's opinion with a number attached. Suppose a model proposes the answers and weighs them, and is then scored against a key another model wrote. Nothing has checked it. The important part, deciding what counts as right, has been outsourced to the thing under test.

The way is to ground it:

- People seed trusted context: the answers they wrote down, the corrections they made, the fixes they approved.
- Models grow branches from that seed: permutations and variations, many questions asked of one state, alternatives weighed against each other.
- Every branch keeps its origin and a link back to the seed it grew from.
- People check a sample of the branches against their own judgment.
- A slice that only people have judged stays the measure of everything else.

Seeded by people, extended by models, measured against people. There can be as many branches as the seed supports. The seed cannot be generated.

## Models are transformation functions

The contract is the same whatever fills it: state in, typed answers out, with a distribution where the model gives one and the versions recorded. Jev answers choice, score and yes-or-no questions. GLiNER finds typed spans. An LLM writes the text leaves no smaller model can. A rule answers whatever can be stated precisely.

So the model is not the asset. It can be swapped, and it will be. The asset is the data that says which answers are right, and that data outlives every model measured against it.

Three kinds of work, each where it fits:

- Deterministic first. Code decides what a stated rule can decide. Every experiment here has a control arm that needs no Jev: a rule, a fake asker, or the harness's own behaviour. A rule that does as well as the model is the answer, not a baseline.
- A model step only where it can be scored. The condition is a set of items with answers people gave, measured against before the step runs at volume and sampled after.
- Agent runs explore and propose. What they produce is a proposal a person approves, not a change.
- Inference is where new rules are discovered. Code is where settled rules live.

A model step here is registered as data:

- the question and its version, where a changed question is a new version and never an edit
- the options and their hash
- the model version that answered
- the content hash of the input

The label contract, the egress ledger, and duckdb-jev's `jev_request` and `jev_answer` exist to hold exactly this.

## Branches are the output

A single request already branches three ways:

- Across questions: many typed questions about one state, answered together.
- Within a question: the probability of every option, not only the top one.
- Down a hierarchy: the branch taken at one level goes into the state of the next. Experiment 11 plans a scene this way: subjects, then their attributes, then their actions, then shots.

They are kept as rows, one per unit, question and option: experiment 12's branch table, and duckdb-jev's `_p` maps. A row never carries more authority than its origin. A branch's weight means something only once it has been checked against people. Calibration is measured per question version, and measured again when the model changes. A probability nobody has calibrated will route work wrongly, and with confidence.

## What grounds it

Evidence has ranks. A usage signal is weak. An explicit judgment is stronger. An approval by the person who owns the question is strongest. In this repository:

- the owner's blind labels on their own replies (experiment 09)
- a fix commit, and the owner's approval of each fix in it (experiment 10)
- the owner's blind choice between outputs, and the renders (experiment 11)
- the owner's approval of every body before it leaves the machine (the egress ledger)

What does not ground anything:

- A key a model wrote, however careful. A synthetic set is a rehearsal to build and debug against, never the verdict.
- One model agreeing with another.
- A model's confidence, until it has been checked against people.

Human judgments are the one thing here that cannot be rebuilt from anything. The branches, the permutations, even the model outputs can be generated again. So judgments are never edited in place: a correction is another row, and both are kept.

People judge what they can judge confidently. Capture goes all the way down: every option, every question, every run. The asking sits at the level where the owner can answer at a glance, because a judgment asked too finely is a guess and one asked too coarsely cannot be acted on.

Disagreement is data. Two judgments that differ on the same item are both kept. Low agreement across a class of items is a finding about the question, not the person. The wording experiment showed this when its placement question scored the example of placement done right above half of the defective units.

## One person, for now

Here the ground truth is one person: the owner. That removes most of what an organization needs, such as a registry of who may judge what and co-approval across teams. It also removes the second opinion that would disagree with a bad judgment.

So the second opinion is the same person, later. A sample of items is labeled again, blind, some time after the first pass, and the agreement is measured. Low agreement with oneself is a finding about the question, not about the person, and it caps what any model can be shown to do on that question.

## Labeling never blocks

The experiments do not wait for labels. They run as rehearsal until labels exist, and they use whatever labels exist once they do. Every report says how many of its units a person labeled.

Labels are made cheap to give. `bun run judge` is a local page, one keypress per question, and blind: it never shows what a model or rule answered. It orders the queue so each label informs the most: close calls and disagreements first. A fixed random slice, a fifth of the units chosen by hash, is interleaved as the held-out test, so the test fills evenly while the labeling effort goes where it teaches most. A later label on the same item supersedes an earlier one, and both are kept.

## Seeds and permutations

This is how branches multiply without leaving the ground:

1. People write the seed: real items with the answers they would give.
2. A model writes permutations of each seed. That means the same judgment in other words, in another context or combination, and counterfactuals that should flip the answer.
3. Every generated item carries its origin (human, model, rule or unattributed) and the seed it came from. The origin is a closed set, because filters are written against it. An item nobody vouched for is unattributed, never human.
4. People review a sample of the permutations, chosen on purpose: spread across seeds, and weighted toward thin coverage and toward close calls, where the branches disagree.
5. The test is a slice that only people have judged, that no model process has touched and that no question was tuned against. Nothing generated is ever scored as evidence.

Permutations are model-generated labels in another form, so the same controls apply:

- The seed's diversity matters more than its size. A narrow seed extended by a model gives labels that are consistent, plausible and wrong outside the slice they came from, and the errors compound instead of averaging out.
- A floor on the share of judgments made by people, so generated volume cannot drown the signal it was meant to extend.
- When a person and the permutations disagree, believe the person and find out why.

Permutations can be endless. They serve coverage, rehearsal and regression. Evidence comes only from people.

## What this asks of the experiments here

- Every experiment names its ground truth and who wrote it, next to its control arm. A result scored only against a key a model wrote is labeled as rehearsal wherever it is reported.
- Every row carries its origin: a person, a model or a rule. A key is a role, not an origin. A key a model wrote is a model's row, whatever role it plays.
- New synthetic sets are seeded, not invented:
  - Each item is a permutation of a reply the owner labeled, linked to its seed and carrying the owner's label.
  - A slice judged only by the owner is held out as the test.
  - A permutation of a real reply carries the owner's text, so it goes through the same egress review its seed would.
- Calibration comes before routing. No threshold on a model's probability decides anything until that probability's hit rate has been measured against people.
- The owner's attention is the scarce input. Tools here make review cheap, never optional: the payloads page for what leaves the machine, and `bun run judge` for labels.

Where each experiment stands:

- 09, exchange labels: the synthetic run is rehearsal. The test is the owner's blind labels, with a held-out slice.
- 10, wording defects: grounded in the owner's fix commit and approvals. What it needs is more pairs. Permutations of the fixed clauses can grow a development set, never the test.
- 11, structured generation: the owner's blind choice between outputs, and the renders, are the ground truth. Jev's branches for a field are proposals those choices rank.
- 12, the branch table: its first result is agreement with a key a model wrote. Its test needs units people labeled.
- duckdb-jev and the ledger: the transformation function in SQL, and the owner's approval of every body before it leaves.

## What would show this is wrong

- Permutations seeded from the owner's judgments do no better, against the human-only slice, than the same model with no seed.
- Keeping the branches does no better, against people, than keeping the top answer.
- The owner disagrees with their own earlier judgments on the same items often enough to swamp any difference between models. Then the questions need work before any model does.
- Keeping a human slice costs more review than the grounded result is worth.

## Non-goals

- Not a benchmark of Jev. Jev is the function under study because it returns every branch cheaply. The method is meant to hold for any model.
- Not scaling judgment by replacing people with models. The speed comes from making review cheap, never from skipping it.
- Not a record of the owner's usage. Results are rates and comparisons, as `CLAUDE.md` requires.
