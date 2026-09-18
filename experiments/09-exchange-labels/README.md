last updated: 2026-09-18

# 09: exchange labels

Label each typed reply the owner gave the assistant: did it approve, correct, redirect or ask? If it corrected, what kind of correction was it, and did the reply say a rule in force was broken? The labels feed freudagent, which rolls them up into recurring patterns and proposes rules for the owner to approve. The experiment asks whether Jev labels these better than a keyword rule, and whether its confidence can be trusted.

Status: the unit builder, label contract, keyword rule, Jev labeler and scoring are built. Jev has labeled the synthetic set only (`docs/2026-09-18-exchange-labels-jev-synthetic.md`). The owner's blind labels come next; real sessions are not sent until an allowlist and the owner's review of each run exist.

## Owner decisions, 2026-09-18

- Synthetic data first. Nothing real is sent anywhere until the pipeline passes on freudagent's synthetic sessions.
- No Claude auth, login or subscription token is used or passed anywhere. The owner's words were "dont send over any claude tokens", clarified the same day as meaning auth and login tokens. The assistant's visible text may be sent, within the egress minimum below.
- The first real sessions are one project the owner picked, read from a local ccutils warehouse.
- freudagent's schema change for these labels is freudagent's to make.

## Unit

One exchange is one typed reply by the owner, with the prompt that opened the turn it answers. Rules, in `src/exchanges.ts`:

- A reply is a unit when something opened a turn before it and the assistant took that turn. A session's first message is not a unit. Neither is a message sent before the assistant replied.
- Tool results, meta entries, command output and harness-injected blocks are not replies.
- A slash command or a notification opens a turn only if the assistant answers it. A local command such as `/cost` does not.
- A compaction does not end a turn: the reply after it still answers the turn before it.
- An interrupt marker is its own unit (`unit_type: interrupt`), labeled by rule, not asked of a model.
- The key is the reply's JSONL uuid: `fact_messages.message_id` in ccutils, not `entry_id`, which hashes the file path and line. A resumed or forked session copies earlier messages into a new file. Copies collapse to one unit, kept under the lowest session id, with a `copies` count. A uuid replayed later within the same file is read once.

Subagent sessions are excluded: their "user" is the orchestrating agent.

## State

v1: `{ previous_prompt, reply }`, only text the owner typed, each field cut at 8,000 characters (`state_truncated` marks it). The query in `candidates.sql` selects no assistant text at all. v1 was set while the owner's rule was misread as excluding anything Claude wrote. A v2 state that adds the visible assistant text of the turn is allowed, and will be proposed to freudagent when a model arm is built.

## Questions and rows

The contract agreed with freudagent: `user_response`, `correction_kind`, `rule_violated` (the rules in force in that project on the reply's day, "none" last) and `frustration` (0 to 2), all `v1`. `src/labels.ts` holds them. One JSONL row per unit, question and labeler, with `options_hash` (sha256 of the option pairs as sent; null for scores) and `input_content_hash`. `labeler_kind` is `model`, `human`, `rule` or `key`. A `questions.jsonl` file is written beside every label file.

The question definitions live in both repositories: `src/labels.ts` here and freudagent's `exchange_questions.jsonl`. Each side's tests pin the same option hashes, so drift on either side fails both suites; neither reads the other repo. freudagent's ingest also refuses a questions file that redefines a registered question and version, which covers the question text. Changes: any change to a question's text or options is a new `question_version`, never an edit to `v1`. Whoever makes it updates both pins and tells the other side first. A change to the state, such as the planned v2 that adds visible assistant text, changes only `input_content_hash`; questions stay at `v1`.

## Arms

| Arm | Status |
|---|---|
| `keyword` (rule) | built, `src/keyword.ts` |
| majority class | computed in scoring |
| owner, blind (human) | next: a labeling sheet over a sample |
| Claude as reviewer (model) | not built; needs the owner's go-ahead on usage |
| Jev (model) | built, `src/jevLabeler.ts`; run on synthetic text only (`--egress synthetic`) |

## Hypothesis and kill condition

Jev's labels agree with the owner's held-out labels more than the keyword rule's and the majority class's do, and its confidence is calibrated on them. If Jev is no better than the keyword rule on the held-out slice, or its confidence does not track accuracy, it adds egress for nothing here.

## Egress

The keyword rule runs locally, and the warehouses live under the ccutils archive directory, outside any checkout. The Jev labeler sends each exchange's state to TypeSafe, and today only for a synthetic source: it refuses without `--egress synthetic`, a key, and a source named `synthetic-...`. Before any request, a state must hold exactly the v1 fields and pass `src/egress.ts`, which refuses the loaded API key or any slice of it and common credential shapes. `sent.jsonl` records each request's hash, size, status, model and time, never the key, a header or the body. `--dry-run` builds and checks every request without sending.

The minimum for any model arm that sends data, agreed with freudagent: only text the owner typed and the assistant's visible text; never thinking, tool inputs or tool results; a secret scan that skips a unit on a hit; a log of what was sent by content hash; only sessions the owner picked.

## Running

```sh
# a ccutils warehouse, built from a clean export of the ccutils commit
ccutils --source <dir> --format duckdb --no-thinking -o <HOME>/.ccutils/claude-archive/<name>

# units and keyword labels
bun run label --warehouse <archive.duckdb> --source <name> [--rules-history <file>]

# score against an answer key
bun run eval-labels --labels <run>/labels.jsonl --units <run>/units.jsonl --key <exchange_labels.jsonl>
```

Output goes to `runs/09-exchange-labels/`: units (keys and character counts, no text), labels, questions and a summary.
