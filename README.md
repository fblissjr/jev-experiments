last updated: 2026-09-21

# typesafe-experiments

experimenting with jev inside claude code and agy and other harnesses

Why it is done this way is in [VISION.md](VISION.md): models like Jev are transformation functions whose branches are worth keeping, and they mean something only when grounded in people's judgments.

## Setup

```sh
bun install
```

### Tools outside npm

Experiment 09 also needs these, which `bun install` does not provide:

- The `duckdb` command-line tool. The label script calls it to read a warehouse.
- [ccutils](https://github.com/fblissjr/ccutils), which builds a DuckDB warehouse from Claude Code session logs. The results so far used ccutils commit `76533fc`.

Experiment 09's synthetic sessions and answer key come from [freudagent](https://github.com/fblissjr/freudagent), under `data/synthetic/`.

Experiment 10 reads the owner's H3 prompt bank repo, which is private, through `git show`. Pass its checkout with `--bank-repo`.

### Claude Code

These settings are needed for the parts that touch Jev or Claude Code:

- `TYPESAFE_API_KEY` for any arm that calls Jev. Arms that use a rule or a fake asker run without it.
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` for anything that loads a hooks module into Claude Code. Function hooks are an early-access feature.

Keep both in `.env` (gitignored; Bun loads it) or in the shell, never in a committed file.

### Function-hook types

The code is typed against Claude Code's function-hook declarations. They are Anthropic's material, so they are not in this repository: generate them locally, and again after each Claude Code upgrade, before type-checking.

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p "/plugin-types"
```

The command writes `.claude/types/`, which is gitignored.

## What leaves the machine

Every request to an outside service is stored first, as the exact body, in the egress ledger (`data/egress.sqlite`). Read it before approving a send:

```sh
bun run payloads                     # the runs
bun run payloads show latest         # a run's bodies in the terminal; --where key=value, --grep, --body
bun run payloads html latest         # the same as a local page under data/views/
bun run payloads approve <run>       # the owner's approval; a send reads only approved runs
```

Approval records a digest of the run's destination, headers, bodies and refusals. A send refuses the run if any of them changed afterwards, and an approved run takes no new bodies.

Bodies built outside the harness come in the same way. A SQL query can write exact Jev requests to a JSONL file of `{unit_key, meta, body}` lines, and then:

```sh
bun run payloads import <experiment> --from bodies.jsonl   # a dry run, reviewed and approved as above
bun run payloads send <run> [--limit N]                     # posts each approved body byte for byte
bun run payloads export <run> [--out FILE]                  # the answers as JSONL, for DuckDB
```

## Checks

```sh
bun test              # unit tests, on hand-made records only
bun run check         # type-check everything (needs the function-hook types above)
bun run check:hooks   # type-check src/compact/ as a hooks module sees it: no Node, no Bun
```

## Why TypeScript and Bun

A Claude Code hooks module is TypeScript, and it runs in an environment with no Node and no filesystem. The replay harness has to call the same decision code the hook will ship. Otherwise the experiments measure one thing and the hook runs another. So decision logic is pure TypeScript with the Jev call passed in: the harness passes one built on `@typesafe-ai/sdk`, and a hook passes one built on `$.http.fetch`. That code lives in `src/compact/`, and `bun run check:hooks` fails if it reaches for Node or Bun.

## Layout

```
VISION.md        why: grounded branches, borrowed from freudagent's vision
docs/            dated records: landscape surveys, experiment results
experiments/     one folder per experiment, plus the protocol
src/compact/     hook-safe decision code: tool calls, protection rules, decisions, the Jev scorer
src/             harness code: session-log reader, compaction points, metrics, scorers for the arms, exchange units, labels and label scoring, branch rows and prevalence, H3 prompt parsing and wording questions
tests/           unit tests
.claude/types/   function-hook declarations written by /plugin-types (local, gitignored)
internal/        unshared notes and session logs (gitignored)
runs/            raw experiment output (gitignored)
data/            the egress ledger, every body sent or to be sent, and its local views (gitignored)
```
