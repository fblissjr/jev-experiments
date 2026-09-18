# Changelog

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
