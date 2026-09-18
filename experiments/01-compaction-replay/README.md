last updated: 2026-09-18

# 01: compaction replay

At a compaction, which tool results can go? This replays the owner's session logs through several ways of deciding, including Jev, and counts how much each removes and how often something it removed was needed again.

Status: the control arms have run (results in `docs/`). The Jev arm is built and waits on a `TYPESAFE_API_KEY` and on sessions the owner picks.

## Assumptions

The landscape doc's open questions had no answer from the owner when this was built, so its working recommendations stand in:

- The target is detail lost at compaction, not token cost.
- Compaction comes before the rest of the backlog.
- Egress is opt-in per session.

If an answer changes one of these, this README changes with it.

## Hypothesis

With the protection rules applied first, Jev's scores on the remaining tool calls lose fewer calls that were needed again than any no-model arm does at the same reduction.

## Arms

Every arm pins the first message and the newest 6, and cuts a truncated result to its first 300 characters. These are fast-jev-compaction's defaults at e3f262a.

| Arm | Decides by | What it is for |
|---|---|---|
| `drop-all` | nothing: every unpinned call goes, call and result | The bar from the landscape doc, and what the reference plugin does in practice |
| `protect` | the protection rules, then drop the rest | The rules alone, with no model |
| `protect-stub` | as `protect`, but an edit is stubbed: the call and result stay, its code becomes a note | What keeping edits costs, and how much a stub buys back |
| `protect-stub-read` | as `protect-stub`, and the Read from before an edit is truncated | The same question for the read-before-edit rule |
| `truncate-all` | the Jev rules, then keep every remaining call and cut its result to the head | The no-model version of Jev's third action. Keeping a head saves some strings, so a Jev arm that mostly truncates has to beat this, not only chance |
| `fake-0` | the Jev rules, then the whole Jev path with an asker that answers 0 | The Jev arm's exact control: same state, same questions, no request. Matches `protect-stub` wherever the state fits |
| `random-25`, `random-50` | the Jev rules, then keep each remaining call with probability 0.25 or 0.5, seeded | Chance at lower reductions. With `protect-stub` as p = 0, these draw the chance line, one of the two lines a selector has to beat |
| `oracle` | the Jev rules, then keep exactly what the future shows was needed | The best any selector could do under the Jev rules: it loses nothing on the calls it decides, and what it loses comes from the rules. Not buildable, and not the maximum reduction: it also keeps results whose strings a kept tool input already holds |
| `builtin` | the summary the engine actually wrote (real points only) | The harness's own behaviour |
| `jev` | the Jev rules, then Jev with the reference plugin's questions and state | The arm under test. Needs a key and `--egress` |

The protection rules cover, without asking: Edit and Write calls, failed calls, Agent, Task and AskUserQuestion results, and the newest Read of a file before an edit to it. The reasons are in `src/compact/calls.ts`. By default a rule keeps what it covers; an arm can give a rule another action (`stub`, `truncate`). Each arm is one line in the `ARMS` table in `replay.ts`.

The Jev rules are the protection rules with edits stubbed (`JEV_RULES` in `replay.ts`). The Jev arm and every arm it is judged against share them. `drop-all`, `protect`, `protect-stub` and `protect-stub-read` are the study of the rules themselves.

## Points

- Real: each `compact_boundary` the engine recorded. The prefix is the span the engine compacted. The future is what was written after, up to the next compaction.
- Synthetic: the first turn boundary in a span where the last API call's context (input plus cache tokens) reached 120,000. This matches fast-jev-compaction issue #26.

A point needs at least 10 messages after it and at least one unpinned tool call.

## Measures

- Reduction: characters removed over characters before. Characters are message text, tool inputs and tool results. Tokens would be better. The engine's own token counts exist only for real points, so characters keep every arm on one scale.
The measure compares each call before and after the compaction, so it does not depend on which actions exist.

- Lost (`lost`, `in-lost`): results, and tool inputs, that lost any text.
- Reread (a floor, results only): the same file is Read again later, or the same Bash, Grep or Glob input runs again.
- Recall (`recall`, `in-recall`): a path, a number of 4 or more digits, a hex hash or an error line in the removed text, which the arm's output no longer holds, shows up later in assistant text or a tool input, before any later tool result or user message carried it back. It counts coincidences, and it misses paraphrase and most code: for tool inputs, which are mostly code, it undercounts.
- Either: results hit by reread or recall.
- Needed (`needed`): calls that lost anything, result or input, hit by any of these.

These follow issue #26, with these differences. "Retained" is everything the arm kept, kept results included. A user message also counts as carrying a string back. Tool inputs are measured. There is no cap on strings per result: a cap over a whole result would hide the tail a truncation removed.

## Kill condition

On synthetic points, Jev's `needed` count must fall below the no-model line at its own reduction. That line is the lower of two: the chance line through `protect-stub`, `random-25` and `random-50`, and the line from `protect-stub` to `truncate-all`, each interpolated linearly. The margin must be larger than the spread across three random seeds. If it is not, Jev adds latency and egress for nothing on this measure. The live hook (04) then stays blocked, and 02 and 03 are the last chance for the approach.

## Egress

The egress minimum agreed for experiment 09 excludes tool inputs and results. This arm's state holds tool inputs by construction (results are only notes), so it needs the owner's explicit say before it runs.

- Control arms: nothing leaves the machine.
- Jev arm: for each point, the state goes to TypeSafe. The state is the conversation history with each message's text cut to its first 400 and last 150 characters, tool inputs capped at 1000 characters, and results replaced by a note such as `ok, 4213 chars (omitted)`. It runs only for session files named on the command line, and only with `--egress` and a key.

## Running

```sh
# control arms, over sessions named on the command line, frozen at a time so runs repeat
bun run replay --until 2026-09-18T15:56:00Z <HOME>/.claude/projects/<project>/*.jsonl

# the chance line's spread
bun run replay --arms random-25,random-50 --seed b <files...>

# the Jev arm, on sessions the owner picked
bun run replay --arms protect,fake-0,random-25,random-50,oracle,jev --egress <picked files...>
```

Output goes to `runs/01-compaction-replay/` as JSON: counts per point and per arm, never transcript text.

## Known limits

- Records are read in file order. A rewind that branches from far back is not followed. A scratch check over the sessions with a recorded compaction found such a rewind rare.
- The future after a real point was written by an agent holding only the engine's summary. It is biased toward what that summary kept, which flatters `builtin`. Synthetic points have no such bias, because the future there was written with the full context.
- Recall grows with the length of the future, and a long future holds more coincidences. Compare arms on the same points. Do not compare absolute rates with issue #26, whose report does not give the length of its futures.
- Live logs grow, and the replay's own session is among them. Pass `--until` to compare runs.
- The state size estimate is three characters a token. The Jev arm records TypeSafe's reported input tokens beside it.
