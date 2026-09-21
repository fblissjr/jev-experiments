# Changelog

## 0.15.0

- `bun run judge`: human labels, made quick and never blocking (`src/judge.ts`, `src/judgeView.ts`, `experiments/judge.ts`).
  - A local page on 127.0.0.1, one keypress per question, blind to every model and rule answer. It asks experiment 09's `user_response`, `frustration`, and `correction_kind` after a correction.
  - Disagreements and close calls come first. A fixed fifth of the units, chosen by hash, is interleaved in random order as the held-out test.
  - Labels are appended to `data/labels/<labeler>.jsonl` as label rows every scorer reads, with whether the person was unsure and how long it took. A later label supersedes an earlier one, and both stay. It resumes where it stopped, and "cannot tell", "later" and "back" are one key each.
  - Units come from a JSONL file or straight from a ccutils warehouse. Writes need a per-session token, so no other page in the browser can post labels.
- Experiment 13, an agent-seeded sample (`experiments/13-seeded-sample/`, `bun run seeded`): five seed exchanges, their permutations and a key, all written by an agent, to show how Jev behaves before any grounding. The agent's key is stored with origin model. `build` writes the units, the key, the keyword rule's labels, and a ledger dry run of the Jev bodies. `report` reads the answers after the owner approves and sends. It adds checks that need no ground truth: does Jev keep its answer on paraphrases, and change it on flips. Nothing has been sent.
- `VISION.md` stands on its own, crediting freudagent once. It adds that one person is the ground truth here, with that person's later relabels as the check on themselves, and that labeling never blocks.

## 0.14.0

- `VISION.md`: models such as Jev, GLiNER or any LLM are transformation functions, and their probabilistic branches are worth keeping. They mean something only when grounded: seeded by people, extended by models, measured against people. It borrows freudagent's vision for the parts that apply here: deterministic first, model steps only where they can be scored, evidence ranked by who gave it, disagreement as data, and model-generated feedback that amplifies a human seed without substituting for it.
- The protocol and `CLAUDE.md` now require every experiment to name its ground truth and who wrote it. A result scored only against a key a model wrote, including freudagent's synthetic sets, is rehearsal and is labeled so.
- Branch rows carry their origin (`labeler_kind`).
- Experiment 12's test is now the owner's blind labels with a held-out slice, not a second synthetic set, and its first run is labeled rehearsal against a model's key.

## 0.13.1

- CLAUDE.md: duckdb-jev's sending functions are never called here. Bodies built in SQL with `jev_request` come in through `bun run payloads import`, and `jev_answer` reads the answers. The whole path was run against a mock server on 127.0.0.1: bodies built in DuckDB, imported, approved, sent byte-identical, exported, and read back as typed columns and one row per option. Nothing was sent to TypeSafe.

## 0.13.0

- The egress ledger closes three gaps (`src/ledger.ts`):
  - Approval records a digest of the run's destination, headers, and each body's order, hash and refusal. A send refuses the run if any of them changed, so an edit that rewrites a body together with its hash is caught, and so is a lifted refusal.
  - An approved dry run takes no new bodies.
  - Two runs started in the same millisecond get distinct ids.
  - The ledger adds its new column on first open. A dry run approved before digests existed can no longer be sent. Experiment 10's approved run is the only one, and every body in it was already sent.
- Bodies built outside the harness, and a send that transmits stored bytes (`src/send.ts`):
  - `bun run payloads import <experiment> --from FILE` makes a dry run from JSONL lines `{unit_key, meta, body}`. Each body must be exactly a Jev request, and the credential and key check runs over the whole body, questions included. It is for bodies a SQL query builds, such as duckdb-jev's.
  - `bun run payloads send <run>` posts each approved body byte for byte with `fetch`, rather than parsing it and letting a client rebuild it. It puts the key in place of the stored header placeholder, checks the body again with the key loaded, and retries 408, 429, 5xx and dropped connections twice, honouring Retry-After. It never takes `latest`.
  - `bun run payloads export <run>` writes the answers as JSONL, each with a `response` string `{"model", "answers"}` for DuckDB.
- A run against a mock server on 127.0.0.1 confirmed every body arrived byte-identical, including one with a JSON escape that re-serializing would change. Nothing was sent to TypeSafe.

## 0.12.0

- Experiment 12, the branch table (`experiments/12-branch-table/`, `src/branches.ts`, `bun run branches`). Every label row becomes one row per option, with the probability the labeler gave it; a rule's or a key's answer is one row at p 1. Per question, the key's shares go beside counted top choices and summed probabilities, with each estimate's distance from the key, a seeded 90% bootstrap interval for the difference, and calibration over every option rather than only the chosen one. It reads files on disk and sends nothing. `branches.jsonl` is written for DuckDB.
- A development run on experiment 09's synthetic labels (`docs/2026-09-21-branch-table.md`). The join reproduces experiment 09's agreement figures. Summing is clearly closer to the key only on frustration, the one question where Jev's top choice is weak, and even there it stays behind the keyword rule and the majority class. The set tuned the unit builder, so this checks the code; the test waits on a second synthetic set.
- `src/scoring.ts` exports its join key, `rowKey`.

## 0.11.1

- The dialogue rule follows the owner's ruling: a line needs a speaker id only where it is genuinely unclear who speaks, so a pronoun, a subject label, a name the prompt already gave a speaker, or the sentence's own subject all count. Across the bank it goes from 35 findings in 22 prompts to one, where a `<d>` block quotes a reused audio track rather than a character.

## 0.11.0

- The rule arm for experiment 10's mechanical classes (`src/wordingRules.ts`, `bun run wording-rules`): a line of dialogue whose sentence names no speaker, a character marked silent who speaks later, and a voice register the prompt's own words contradict. It reports both the prompts the fix commit repaired and a sweep of those it never touched, where it found more of all three. Results added to `docs/2026-09-19-prompt-wording-jev.md`. No model and no network.

## 0.10.0

- Experiment 10 ran. The owner approved the dry run, every body was sent, and the answers are scored against the key (`experiments/10-prompt-wording/eval.ts`, `bun run wording-eval`): matched pairs per class, the odds a coin does as well, and where each defective unit sits among untouched units at the same shot position. Results in `docs/2026-09-19-prompt-wording-jev.md`: the placement question dies against its own kill condition, agentless action survives on two pairs, and the count question is noise.

## 0.9.1

- Experiment 10's answer key (`experiments/10-prompt-wording/key.ts`, `bun run wording-key`), derived from the fix commit before any answer exists: which shots each fix changed, and which defects the changed clause removed. A change can carry more than one class; what the rules do not recognise is assigned by hand with its reason, and anything left is printed for review. The key names prompts of a private repo, so it is written under `internal/` and never committed.

## 0.9.0

- An egress ledger (`src/ledger.ts`) in `data/egress.sqlite`, gitignored. A dry run stores every body exactly as it would be sent, with where its text came from. `bun run payloads` lists runs, shows a run's bodies in the terminal with filters, writes a self-contained local page to browse them (`src/payloadView.ts`), and records the owner's approval of a dry run. `EGRESS_LEDGER` points a test run at another file.
- Experiment 10 builds its bodies into the ledger. A send reads only an approved dry run, refuses a body that is not byte for byte what was approved, records each response beside its body, and skips what an earlier send from the same run already sent, so a smoke run can come first. The runs/ examples and dry-run files are gone; the ledger replaces them.
- CLAUDE.md: anything sent to an outside service goes through the ledger.

## 0.8.1

- Experiment 10 reads only the bank's `prompt_bank/` folder, by the owner's rule. The folder is fixed in code rather than an option, a path outside it stops the run, and `sources.jsonl` records the commit, path and blob of every file read.
- Each shot is now a verbatim slice of its file. The parser used to join a preamble on its own line to shot 1 with a space, and the command now stops if any state is not found verbatim in its file.

## 0.8.0

- Experiment 10, wording defects in H3 video prompts: the protocol (`experiments/10-prompt-wording/README.md`), a prompt parser (`src/h3Prompt.ts`), three `v1` Noul questions (`src/wordingQuestions.ts`), and a `wording` command. The command reads the prompt bank through `git show` at the fix commit and its parent. Its `--dry-run` prints what would be sent and writes complete example requests. Sending needs `--egress bank`, which waits on the owner reading a dry run. Nothing has been sent.
- Experiment 11, structured generation of H3 prompts on an engine branch: the owner's decisions and a draft protocol. No code.
- The backlog adds rows 10 and 11.

## 0.7.1

- The Jev synthetic results doc adds freudagent's independent check, which reproduced every figure, and a frustration breakdown. Jev pulls toward the middle level and never picks the top one. About half of its misses on calm replies are arguable polite corrections, the rest plain misses. Frustration needs sharper level wording before it is used.

## 0.7.0

- Experiment 09 gains a Jev labeler (`src/jevLabeler.ts`): all four questions per exchange in one request, choice answers kept with their probabilities, and a score kept as its most probable level. `labeler_version` comes from the response's model id.
- A sending guard (`src/egress.ts`) refuses a state that holds the loaded API key, any slice of it, or a common credential shape. The label command sends only a synthetic source, only with `--egress synthetic`, logs requests by hash, and has `--dry-run` and `--limit`.
- Labelers answer a unit's questions together and asynchronously. The keyword labels are byte-identical after the change, apart from timestamps.
- Scoring adds calibration: agreement with the key grouped by the labeler's probability.
- First results in `docs/2026-09-18-exchange-labels-jev-synthetic.md`. On the synthetic set, Jev is well ahead of the keyword rule and the majority class on the three choice questions. It is behind both, and over-confident, on frustration.

## 0.6.0

The first public version. Earlier versions were local only.

- Landscape survey of Jev inside Claude Code (`docs/2026-09-18-landscape.md`), the experiment protocol and the backlog (`experiments/README.md`).
- Experiment 01, compaction replay: a session-log reader that produces the message shape a `session.compact` hook receives; compaction points, both recorded and at a token threshold; hook-safe decision code in `src/compact/` with its own type check (`bun run check:hooks`); control arms (drop-all, the protection rules with keep, stub and truncate actions, chance, an oracle, the engine's own summary); a Jev arm, not yet run; and a loss measure over removed results and inputs. Results in `docs/2026-09-18-compaction-replay.md`.
- Experiment 09, exchange labels: a builder that turns a ccutils warehouse into the owner's typed replies, the label contract agreed with freudagent, a keyword-rule labeler and scoring against an answer key. Results in `docs/2026-09-18-exchange-units.md`.
- Nothing here passes Claude auth or login tokens anywhere. Claude Code's function-hook declarations are Anthropic's material and are generated locally, never committed.
- Results report rates and comparisons, not counts that describe the owner's usage.
