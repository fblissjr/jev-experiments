# Jev inside Claude Code: landscape on 2026-09-18

This is a dated record. It describes what was true when it was observed on 2026-09-18, and it is not kept up to date.

Each claim is tagged with its provenance:

- read: taken directly from the primary source. That means `gh api`, an issue body, the installed Claude Code binary, a command's output, or a repo file.
- summary: passed through a web-fetch summarizer and not checked line by line.

## Open questions

These shape the first experiments. None had been answered when this was written.

1. Why build this in-house? Each reason leads to a different design: controlling what leaves the machine, learning the function-hook surface, or the fact that the existing plugins do not work yet.
2. What problem is the target? Options are detail lost to lossy summaries, token cost, or something else. Working recommendation: lost detail. It is where Jev plausibly helps, and the one proxy benchmark below showed no cost saving.
3. What may leave the machine? Every Jev compaction request carries the conversation state, source code in tool inputs included. Working recommendation: opt-in per project.
4. What is in scope beyond compaction? Candidates are skill routing, answering the agent's own this-or-that questions, and guards. Working recommendation: compaction first, with the rest held until the replay results exist.
5. Is there a TypeSafe API key? The replay's Jev arm needs one.

## The short answer

TypeSafe's Jev can do compaction in Claude Code, but only through function hooks, an early-access Claude Code feature. The documented settings hooks cannot do it. `PreCompact` can block a compaction and `PostCompact` can read the summary, but neither can supply the compacted conversation (read: Claude Code hooks docs, snapshot from 2026-08).

## Function hooks on Claude Code 2.1.276

- (read) The installed binary includes function hooks, an early-access plugin surface, behind the `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` env var. It also has a built-in skill for writing function-hook plugins, and a `/plugin-types` command that writes the surface's TypeScript declarations for local use.
- (summary) No mention of function hooks turned up in the public Claude Code changelog. The summarizer scanned it, so read this as "not found", not "absent".
- (read) `/plugin-types` runs headless. Its output is Anthropic's material and is not reproduced or committed here; this repository generates it locally.
- (read) A hooks module runs in its own environment with no Node, so a hook reaches an HTTP API through the environment's own fetch. A `claude plugin test` command, listed only when the flag is set, runs a plugin's tests in that environment.
- (read) A compaction event lets a hook either hand back the compacted conversation itself or change what the built-in summarizer is given. Other events cover tool calls, prompts, sessions, turns and the terminal UI. Some of the harness's own model calls, such as classification, can be answered by a hook too; where core makes those calls is not known.
- (read) Issue #21 on the reference plugin reported `Hooks (0)` after install on 2.1.272. That build is older than the 2.1.274 minimum the plugins state, and the issue does not say whether the flag was set. It tells us nothing about 2.1.276.

## TypeSafe and Jev

- (summary) Jev is TypeSafe's "System One" model. It takes a state and a set of named questions, and returns typed answers with probabilities and a confidence, not text. There are three question types. `choice` picks one of several named options, `score` rates against ordered levels, and `noul` gives a yes/no probability.
- (summary) HTTP API: `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <key>` and a body of `{ state, model: "jev-latest", questions }`. Error codes: 401 for a bad key, 422 for a validation failure, 429 for a rate limit and 529 for overload. The docs give no request limits and no pricing.
- (read) The JS SDK is `@typesafe-ai/sdk`. On 2026-09-18 its latest version on the npm registry was 0.6.0, with `engines.node >= 20`. It reads `TYPESAFE_API_KEY`. Needing Node rules it out inside a hooks module.
- (summary) TypeSafe ships its own Claude Code plugin, `typesafe@typesafe-ai` from the `typesafe-ai/skills` marketplace. It is a skill that teaches an agent to write code against the API. It does not compact anything.
- (summary) The docs have a model-notes page listing known limits of jev-1.13 (`model-jaggedness/jev-1.13.md`). It has not been read.

## Community work, 2026-09-17 to 2026-09-18

### The reference plugin: tamaratran/fast-jev-compaction

- (read) Created 2026-09-17, MIT licensed, plugin version 0.3.0. How it works:
  - A `session.compact` hook sends the whole conversation to Jev as the state. Each tool result appears only as a note such as `ok, 4213 chars (omitted)`.
  - For every tool call outside the pinned first message and the newest messages, it asks two `noul` questions: keep the call, and keep the full result.
  - Below `keepThreshold` (default 0.5), the result is cut to its opening characters, or the call and result are removed together. User and assistant text is never touched.
  - A `turn.complete` hook requests compaction at a set context percentage.
  - It falls back to the built-in summary on any error, or when the estimated reduction is under `minReductionRatio`.
- (read) Its README offers `npm install fast-jev-compaction`, but the npm registry returned 404 for that name on 2026-09-18.
- (read) Forks and variants appeared within the day. One of them, `gshost1/vercel-compaction`, reaches the same model through the Vercel AI Gateway.

### What replays of it found

Issues filed on 2026-09-18 replayed real session logs through the library at commit `e3f262a`.

- (read) Issue #26 covered 8 compaction points from one person's sessions, with 256 calls scored.
  - Real Jev cut 87.7% of characters. A fake asker that answered 0 to every question cut 88.5%.
  - No result score reached 0.3.
  - The issue's proxy for "a dropped fact was needed again later" counted 16 in both arms.
  - The cause the issue proposes: Jev cannot see the result it is scoring, and the state tells it the assistant can always re-run a tool.
- (read) Issue #52 replayed one session of 1084 messages.
  - With the default questions and a threshold of 0.5, none of 337 calls was kept. At 0.3, four calls survived without their results, and no result was kept.
  - The default questions ask whether a result must stay verbatim because re-running would not do. The issue reworded both to ask whether the task still needs the call or result, and retried on the first 120 messages. That gave a usable spread: 5 kept, 10 truncated and 19 dropped, a 40% cut against 81% with the default wording.
  - On the full session, fitting the state into the token budget had already removed the old messages. Jev was scoring calls it could not see, and the new wording did not help.
- (read) Issue #25 replayed a Codex session export.
  - 114 of 116 tool calls were dropped, along with their results.
  - One lost result was a point-in-time calculation. Its code and output file had changed since, so re-running produced a different value.
  - The point: a result being irrelevant now does not mean it can be regenerated. Some results need a fixed rule, not a probability.
- (read) None of these issues had a reply from the maintainer when they were read.

### compozy/yoshi: a proxy instead of a hook

- (read) A local proxy that Claude Code reaches through `ANTHROPIC_BASE_URL`. Jev judges spans of history once, above a size gate, and the proxy forwards the pruned request. It needs no function hooks. It reaches Jev through the Vercel AI Gateway, and its README says that route has no zero-data-retention option.
- (read) Its benchmark page has an evidence date of 2026-09-18 and one trial per arm.
  - On a Fable diagnostic, yoshi cut accumulated input by 34%. Wall clock went from 39.77 s to 210.54 s.
  - On a Sonnet session it cut nothing. Wall clock went from 35.14 s to 171.99 s.
  - A third arm used Anthropic's native tool-result clearing. On the Sonnet session it had the lowest input of the three arms and ran in 28.01 s. On the Fable diagnostic, yoshi had the lowest input.

### BeLazy167/typesafe-mod

- (read) A function-hook plugin that uses Jev for two other decisions:
  - On `tool.call` for AskUserQuestion, it shows Jev's probability for each option, and it can answer when confident.
  - On `prompt.submit`, it ranks the installed skills against the prompt. This part is off by default because of cost.

### Anthropic issue #95328

- (summary) Opened on 2026-09-18 against 2.1.276, and still open. `claude --resume` undoes a compaction done by a `session.compact` hook. Records the hook kept still point back across the compaction boundary, so the resume loader recovers the history that was dropped. The issue's workaround is to return kept tool results and older assistant messages without their `handle`. This affects any design built on the event, including one built here.

## What this means for the experiments

- Connecting a hook is the easy part. The hard part is the question, and whether Jev can see what it is being asked about.
- The bar is not the built-in summary. It is a rule that drops every non-pinned tool result, which is what the reference plugin does in practice. If Jev cannot beat that rule on the same sessions, it only adds latency and sends data out of the machine.
- So the order is:
  1. A replay harness, with the rule as the control arm.
  2. Question wording and result visibility.
  3. A live hook, only if Jev wins.
- Some things should be protected by rule, not by score: Edit and Write calls, failed calls, and results that cannot be regenerated.
- When the state sent to Jev no longer holds the messages being scored, fall back rather than act on the scores.
- A live hook needs a plan for #95328.

## Sources

- TypeSafe docs: https://docs.typesafe.ai, https://docs.typesafe.ai/llms.txt, https://docs.typesafe.ai/api.md, https://docs.typesafe.ai/sdk/javascript.md, https://docs.typesafe.ai/agent-skill
- https://github.com/tamaratran/fast-jev-compaction, issues #21, #25, #26, #52
- https://github.com/anthropics/claude-code/issues/95328
- https://github.com/compozy/yoshi, `docs/BENCHMARKS.md`
- https://github.com/BeLazy167/typesafe-mod
- https://github.com/gshost1/vercel-compaction
- https://github.com/golgor/dotfiles/pull/57, which reports that the npm package is not published
- https://alphasignal.ai/news/tamara-tran-s-fast-jev-compaction-stops-claude-code-from-forgetting-critical
- https://github.com/yibie/awesome-jev
- https://claudefa.st/blog/tools/hooks/function-hooks
