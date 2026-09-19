last updated: 2026-09-19

# 10: wording defects in H3 video prompts

MiniMax H3 prompts are checked for format in code: section order, markers, speaker-id syntax, label wiring. A class of defect gets past those checks and shows up in the render: a person who speaks or is spoken to with no stated place in the shot, an object that acts with nobody doing it, a count the scene contradicts. On 2026-09-18 the owner's render panel exposed the pattern, a Claude subagent swept the prompt bank for it, and the owner approved one-clause fixes. Every fixed prompt passed the format grader both before and after the fix. This experiment asks whether Jev can see these defects.

Status: run. The owner approved the dry run and all of it was sent on 2026-09-19; results in `docs/2026-09-19-prompt-wording-jev.md`. The placement question died against its kill condition and needs a `v2`; the count question is noise, as expected. The rule arm is built and run: it catches most of the mechanical defects the fix commit repaired, and it found more in prompts nobody flagged.

## Owner decisions, 2026-09-19

- Jev is tried as a checker, not a generator. TypeSafe lists text generation as a known failure mode of `jev-1.13`.
- Sending bank prompt text to TypeSafe is allowed in principle. The owner reads the dry run's inventory and examples before the first send.
- The fix commit and the owner's approval of each fix are the answer key. Renders come later.
- Prompts come only from the bank's `prompt_bank/` folder, never from any other folder of that repo, such as `internal/internal_prompt_bank`.

## Source

The `prompt_bank/*.txt` files of the owner's H3 prompt bank repo, and nothing else in it, read with `git show` at two commits: the parent of the fix commit (`4bd7b429^`, the defective versions) and the fix commit (`4bd7b429`, the fixed ones). The folder is fixed in code, not an option. A path outside it stops the run, every state is checked to be a verbatim slice of its file, and `sources.jsonl` records the commit, path and blob of every file read. Bank text, clause text and the answer key are never committed here. That repo is private, and the key names its prompts, so the key will be kept under `internal/`.

## Classes

Mechanical, left to rules (no Jev):
- a line of dialogue with no speaker id
- a character marked as silent who then speaks
- a woman's voice given a male register ("baritone" with she or her)

Judgment, asked of Jev:
- `unplaced_person`: someone who speaks, is spoken to or is acted on has no stated place in the shot
- `agentless_action`: an object acts as if by itself where a person would have to do it
- `contradicted_count`: a number of some object that other text contradicts

TypeSafe's notes say Jev does not count, so `contradicted_count` is reported on its own and is not expected to do well.

## Units and state

Code parses each prompt's main field (`integrated_multimodal_description`, or `detailed_description` for ref2va) and splits it on `[Shot N]`. Text before `[Shot 1]` stays with shot 1.

- Shot unit: one per prompt version and shot. State `{ shot }`, that shot's text with its header. Asked: `unplaced_person`, `agentless_action`, in one request.
- Description unit: one per prompt version. State `{ description }`, the whole main field. Asked: `contradicted_count`.

A prompt the fix commit did not touch is one version. A prompt it touched is two.

Placement is judged per shot, because that is how the fixes landed. The subagent found one shape that recurs across five prompts: in shot 1, the person being addressed has no place while a silent person does, and the fix adds the place in that same shot. In all five, the person addressed gets a speaker id only in shot 2, so in shot 1 code cannot find them and the question is asked of the whole shot.

## Questions

Nouls, version `v1`, in `src/wordingQuestions.ts`. The examples in their criteria are made up, never taken from the bank, so the questions are not tuned on the key.

The 2026-09-19 run turned this set into `v1`'s development set. A later version of a question, written with those results in view, is tested only on pairs it has not seen.

## Arms

| Arm | Kind | Status |
|---|---|---|
| format grader | rule | known result: every fixed prompt passed it before and after, so it cannot separate a pair |
| rules for the mechanical classes | rule | built, `src/wordingRules.ts`, run 2026-09-19 |
| constant and seeded-random asker | fake | computed in scoring: a coin's odds of doing as well, and a constant answer drops none |
| Jev | model | `v1` run on 2026-09-19 |
| Gemini Flash | model | planned; needs its own key and egress review |

## Measure

- Matched pairs, the headline. For each fixed prompt, compare the question's answer on the unit where the fix landed, before against after. A drop means Jev saw the defect the fix removed. Any drop counts, and each pair's before and after answers are reported, so the size of every drop is visible. Each class is reported separately, with its number of pairs.
- Untouched prompts. Answers on the prompts the fix commit left alone, as weak negatives: the subagent passed them, but nobody showed they are clean. A before version should score above most of them. The comparison is made at the same shot position, because a later shot can leave out a place stated in an earlier one, so later shots are expected to score higher on `unplaced_person`.
- Hard negatives, named in the key: a prompt whose chaos is its brief, and one the subagent named as a model of placement done right.
- Flagged but not fixed. The subagent flagged a few prompts the fix commit did not change. Whether the owner declined those or deferred them is not recorded, so they are reported apart and not scored.
- Calibration and cost, as in experiment 09.

The key measures agreement with the owner's wording fixes. It is not a video outcome.

## Kill condition

For `unplaced_person` or `agentless_action`: the answer fails to drop on more than one of that class's pairs (on any, for a class of two pairs), or the before versions do not score above the 90th percentile of the untouched prompts. Then Jev does not see that class, and the rest of this line of work does not use it for that class.

## Egress

The rules and fake askers run locally. The Jev arm sends each unit's state and the question text to TypeSafe. A state holds exactly one field: one shot's text, or one prompt's main field. It carries no prompt id, file name, brief, soundscape, music, path or key. The SDK adds its own headers: the key as a bearer token, its version, and the runtime with its platform and architecture.

Nothing is sent without a reviewed dry run. The dry run writes every body, exactly as it would be sent, into the egress ledger (`src/ledger.ts`, `data/egress.sqlite`, gitignored), with the commit, path and blob of its text. Every state passes `src/egress.ts` first. The owner reads the run with `bun run payloads` and approves it. A send takes only that run's bodies. It refuses one that is not byte for byte what was approved, or that trips the guard now. It records each response beside its body. It also needs `--egress bank` and a key.

## Running

```sh
# build every body into the ledger; sends nothing
bun run wording --dry-run --bank-repo <dir>

# read what would be sent, in the terminal or as a local page
bun run payloads show latest --where version=before --limit 5
bun run payloads html latest

# the owner's approval, then the send (--limit N for a smoke run; a later send skips what was sent)
bun run payloads approve <run>
bun run wording --send <run> --egress bank --limit 20
```

A send's answers, one row per question, go to `runs/10-prompt-wording/<time>/answers.jsonl`.
