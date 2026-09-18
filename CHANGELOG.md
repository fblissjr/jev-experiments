# Changelog

## 0.6.0

The first public version. Earlier versions were local only.

- Landscape survey of Jev inside Claude Code (`docs/2026-09-18-landscape.md`), the experiment protocol and the backlog (`experiments/README.md`).
- Experiment 01, compaction replay: a session-log reader that produces the message shape a `session.compact` hook receives; compaction points, both recorded and at a token threshold; hook-safe decision code in `src/compact/` with its own type check (`bun run check:hooks`); control arms (drop-all, the protection rules with keep, stub and truncate actions, chance, an oracle, the engine's own summary); a Jev arm, not yet run; and a loss measure over removed results and inputs. Results in `docs/2026-09-18-compaction-replay.md`.
- Experiment 09, exchange labels: a builder that turns a ccutils warehouse into the owner's typed replies, the label contract agreed with freudagent, a keyword-rule labeler and scoring against an answer key. Results in `docs/2026-09-18-exchange-units.md`.
- Nothing here passes Claude auth or login tokens anywhere. Claude Code's function-hook declarations are Anthropic's material and are generated locally, never committed.
- Results report rates and comparisons, not counts that describe the owner's usage.
