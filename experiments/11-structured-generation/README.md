last updated: 2026-09-19

# 11: structured generation of H3 prompts

The owner's H3 prompt engine turns an idea into a MiniMax H3 prompt with one planner call. A large system prompt goes in, and the whole document comes back as JSON. The owner's vision for the engine is different: structured, relational data that goes as granular as it can and rolls up into a scene plan. A scene has subjects, subjects have granular attributes, actions belong to subjects, shots are made of actions, and every level is filled on its own. This experiment builds that on a branch of the engine and compares it with the single call.

Status: draft protocol. No code. It starts once experiment 10's checker exists, because that checker is one of its measures.

## Owner decisions, 2026-09-19

- The plan is hierarchical and relational, parent to child: scene, subjects, their attributes, actions, shots. A model fills it, whether Jev or another.
- The branch may change anything that helps: the schema, the contract, the serializer. It is experimental.
- It is built with the engine repo's own session.
- Shot headers carry no timestamps. The engine repo's session has been asked to make that change on the engine's main branch, which the experiment branch starts from.

## Where Jev fits

Jev does not write text. It chooses. In a relational plan, many fields are choices among things that already exist:
- which subject performs an action
- where a subject stands, and relative to what: the camera, an object, another subject
- a voice register, from a fixed set that has to agree with the subject
- which of the guide's cut phrasings a cut uses
- camera words from the guide's closed vocabulary

A generative model writes the text leaves: traits, action wording, dialogue, soundscape.

Several of experiment 10's defects become fields in this design, so a plan cannot be missing them. Placement is a field. Silence is derived from whether a speaker has a line in that shot. Register sits next to the subject it describes. Objects carry counts.

## Arms (draft)

| Arm | What fills the plan |
|---|---|
| A | the engine's current planner on main: one call, the whole document |
| B | the relational plan, with a generative model filling every field |
| C | the relational plan, with Jev filling the choice fields and a generative model the text leaves |

A and B are the controls and need no Jev. B is there to separate the effect of the structure from the effect of Jev: without it, a gain for C cannot be credited to either.

## Measure (draft)

- Defects: experiment 10's checker and rules on every output.
- The engine's own validator: how far each output gets.
- Calls, cost and latency per prompt.
- The owner's blind pairwise choice between outputs for the same idea.
- Renders, later, in the owner's H3 render repo.

## Open

- Inputs. The prompt bank's briefs describe which format features a prompt exercises, not scene ideas, so they cannot be the inputs as they stand. The owner writes or picks the ideas.
- Coherence. Filling one field at a time loses the whole-scene view a single call has, and most of experiment 10's defects cross shots. The likely order is to block out the whole scene first, then write each leaf with that blocking in view.
- Kill condition, to be set with the owner before code: roughly, C neither has fewer defects than A nor wins the blind choice, or C does no better than B.

## Egress

The ideas and plan fields go to the generative model, as the engine already sends ideas to Gemini today, and the choice fields' state goes to TypeSafe. As in experiment 10, the owner reads a dry run's inventory and examples before the first send.
