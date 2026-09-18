# Compaction replay, control arms: 2026-09-18

This is a dated record of experiment 01's control arms: every arm except Jev, which waits on a key and on sessions the owner picks. The protocol, arms and measures are in `experiments/01-compaction-replay/README.md`. Nothing left the machine.

Figures are rates, not counts: the owner's session history is not described here.

## Setup

- The code is version 0.6.0 of this repository, run on Bun, typed against the function-hook declarations of Claude Code 2.1.276. The replay itself does not run inside Claude Code.
- Input: the owner's local session logs, frozen at `2026-09-18T15:56:00Z` with `--until` so runs repeat.
- Synthetic points sit at the first turn boundary where the context reached 120,000 tokens, as in fast-jev-compaction issue #26. Real points are the compactions Claude Code recorded.
- The random arms ran with three seeds; their figures below are the range.
- The Jev arm and every arm it is judged against share the same rules: the protection rules, with edits stubbed.

"Needed again" is the share of the tool calls not pinned by position that lost something, in a result or an input, that the session used again later.

## Synthetic points

| Arm | Reduction | Needed again |
|---|---|---|
| drop-all | 84.9% | 39.3% |
| protect-stub-read | 77.8% | 21.1% |
| protect-stub | 70.7% | 19.0% |
| protect | 58.2% | 16.6% |
| random-25 | 55.0% to 56.1% | 9.4% to 9.5% |
| truncate-all | 53.7% | 5.6% |
| random-50 | 40.8% to 41.0% | 5.2% to 5.5% |
| oracle | 39.3% | 1.0% |

`fake-0`, the whole Jev path with an asker that answers 0, matches `protect-stub` exactly.

## Real points

| Arm | Reduction | Needed again |
|---|---|---|
| builtin (the engine's summary) | 97.8% | 23.8% |
| drop-all | 71.9% | 19.5% |
| protect-stub-read | 61.4% | 6.2% |
| protect-stub | 57.5% | 5.0% |
| oracle | 48.2% | 0.2% |
| random-25 | 46.6% to 47.5% | 1.9% to 2.1% |
| protect | 42.3% | 4.2% |
| random-50 | 35.6% to 36.5% | 1.1% to 1.3% |
| truncate-all | 34.9% | 1.4% |

What came after a real point was written by an agent holding only the engine's summary, so the future is shaped by what that summary kept. That flatters `builtin`.

## What the numbers say

### The protection rules pay for themselves, mostly through Edit and Write inputs

Without the rules, dropping every unpinned call removes 84.9% of characters and loses something needed later on 39.3% of calls. With the rules, the figures are 58.2% and 16.6%.

As shares of all characters before compaction, the rules keep: edits 15.4%, the read before an edit 7.9%, delegated work 2.1%, failed calls 1.3%. An edit's cost is almost all its input, the code it carries; its result is a line or two.

### Stubbing edits buys back most of that cost

A stub keeps an edit's call and result but replaces its code with a note. Measured against `protect`:

| Arm | Reduction gained | Needed again, added |
|---|---|---|
| protect-stub | 12.5 points | 2.4 points |
| protect-stub-read | 19.6 points | 4.5 points |
| drop-all | 26.7 points | 22.7 points |

The measure looks for paths, long numbers, hashes and error lines, which code rarely holds, so a stub's measured cost is a floor.

### Truncating everything already beats chance

`truncate-all` keeps every candidate and cuts its result to the first 300 characters, with no model. It removes 53.7% and loses on 5.6% of calls. Chance at a similar reduction (`random-25`) loses on 9.4% to 9.5%. A Jev arm that mostly truncates would beat chance by its choice of action alone, so the kill condition uses the line from `protect-stub` to `truncate-all`.

### There is room for a selector

The oracle keeps exactly what the future shows was needed. Its remaining loss comes from the stub rule itself, which no selector can avoid. The gap between the no-model line and the oracle is what Jev has to find.

### The reference design cannot run where this owner compacts

The reference plugin's state fitted its 25,000-token budget at every synthetic point, but at most real points it did not. Those compactions happened late in very long contexts, and even with tool results omitted, a whole history that long does not fit. A live hook for this owner would need to score the history in windows. Issue #52 found the same limit from the other side: the reference plugin trimmed the history to fit, then scored calls that were no longer in it.

## How the measure got here

- The first measure counted only what was removed from tool results. It was extended to tool inputs because dropping an edit removes its code without cost otherwise.
- The stub action and the `truncate-all` arm were added once the first results showed where the cost and the chance line sat.
- A code review found defects here: kept records that the log writes after a compaction boundary leaked into the future, Bash re-runs were matched with their description, shell-mode records could be read as typed text, and a Jev error aborted a run. The fixes moved every figure slightly and changed no conclusion. The figures above are after the fixes.

## Caveats

- Recall counts coincidences and misses paraphrase and most code.
- Reduction is in characters, not tokens.
- All sessions are one person's.
