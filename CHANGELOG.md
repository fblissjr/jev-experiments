# Changelog

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
