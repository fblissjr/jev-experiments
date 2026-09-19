// Experiment 10's questions for Jev, and the units they are asked of. Pure.
//
// The examples in the criteria are made up. None is taken from the prompt
// bank, so the questions are not tuned on the answer key. A change to any
// text here is a new QUESTION_VERSION, never an edit to v1.

import { parsePrompt } from './h3Prompt.ts';

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

export const QUESTION_VERSION = 'v1';

/** Asked of one shot's text. */
export const SHOT_QUESTIONS: Record<string, NoulQuestion> = {
  unplaced_person: {
    type: 'noul',
    instructions: "In this shot's text, is there a person who speaks, is spoken to, or is acted on, but whose place in the scene is never stated?",
    criteria: {
      true: "At least one such person has no stated place: the shot's text never says where they are relative to the camera, an object, or another person. For example, 'she turns to the deckhand and shouts' when nothing in the shot says where the deckhand is.",
      false: "Every person who speaks, is spoken to, or is acted on has a stated place, such as 'the deckhand coiling rope at the stern' or 'the clerk behind the counter'. People mentioned only as a crowd, and voices from off screen, do not need a place.",
    },
  },
  agentless_action: {
    type: 'noul',
    instructions: "Does this shot's text describe an object doing something that a person would have to do, with no person named as doing it?",
    criteria: {
      true: "An object moves or acts as if by itself where a hand is needed, and no person is named as doing it. For example, 'a drawer slides open' or 'the cash register rings up the sale' with nobody at it.",
      false: 'Every such action names who does it, or the motion needs no hand: weather, water, steam, smoke, flickering or moving light, a running machine, a supernatural event the scene is about, or a crowd moving in general.',
    },
  },
};

/** Asked of a prompt's whole main field. */
export const DESCRIPTION_QUESTIONS: Record<string, NoulQuestion> = {
  contradicted_count: {
    type: 'noul',
    instructions: 'Does the description give a number of some object, then contradict that number elsewhere?',
    criteria: {
      true: "The text says or implies how many of an object there are, and other text disagrees. For example, 'picks up a pair of dice' and later 'rolls all three dice'.",
      false: 'Every count of an object agrees wherever it appears, or the text gives no count.',
    },
  },
};

export type WordingState = { shot: string } | { description: string };

export interface WordingUnit {
  /** Local only: the prompt's file stem. Never sent. */
  prompt_id: string;
  /** Local only: which text this is, e.g. `before`, `after` or `same`. Never sent. */
  version: string;
  kind: 'shot' | 'description';
  /** 1-based shot number, or null for a description unit. */
  shot: number | null;
  state: WordingState;
}

/** A prompt's units: one per shot, and one for the whole main field. Empty when it has no main field. */
export function unitsFor(promptId: string, version: string, text: string): WordingUnit[] {
  const parsed = parsePrompt(text);
  if (!parsed) return [];
  const shots: WordingUnit[] = parsed.shots.map((shot, i) => ({ prompt_id: promptId, version, kind: 'shot', shot: i + 1, state: { shot } }));
  return [...shots, { prompt_id: promptId, version, kind: 'description', shot: null, state: { description: parsed.description } }];
}

export function questionsFor(unit: WordingUnit): Record<string, NoulQuestion> {
  return unit.kind === 'shot' ? SHOT_QUESTIONS : DESCRIPTION_QUESTIONS;
}

/** The one field a unit's state may hold. */
export function stateField(unit: WordingUnit): 'shot' | 'description' {
  return unit.kind;
}
