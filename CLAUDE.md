# typesafe-experiments

Read `README.md` for setup and layout, and the newest dated doc in `docs/` for where things stand.

## Rules

- Every experiment has a control arm that needs no Jev: a rule, a fake asker, or the harness's own behaviour. A Jev result without its control is not a finding.
- Session transcripts are never committed. Raw run output goes in `runs/` (gitignored). A committed result carries rates and comparisons between arms: no transcript text, and no count that describes the owner's usage (sessions, projects, messages, replies, context sizes).
- A real-Jev arm sends conversation state, source code included, to TypeSafe. Run it only on sessions the owner picked.
- Anything sent to an outside service goes through the egress ledger (`src/ledger.ts`, `data/egress.sqlite`). A dry run stores every exact body, the owner reviews it with `bun run payloads` and approves it, and a send transmits only that approved run's bodies. Experiment 09's synthetic labeler predates the ledger.
- Decision logic stays pure: no I/O, with the Jev call passed in. The hooks-module environment has no Node, so `@typesafe-ai/sdk` is for the harness only. A hook calls the HTTP API through `$.http.fetch`. Decision logic lives in `src/compact/`, and `bun run check:hooks` checks that it stays hook-safe.
- `.claude/types/claude-code.d.ts` is the function-hook contract, written locally by `/plugin-types`. It is Anthropic's material: never commit it, never hand-edit it, and regenerate it after a Claude Code upgrade. Do not reproduce its contents in docs.
- In anything committed, write the session-log location as `<HOME>/.claude/projects/<project>/*.jsonl`.
