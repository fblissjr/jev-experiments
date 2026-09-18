// Jev as a labeler for experiment 09: every question for a unit in one
// request. The request is passed in (`SystemOneCall`): the harness builds one
// on @typesafe-ai/sdk, tests pass canned answers.
//
// Mapping, agreed with freudagent:
// - choice: value is Jev's choice; probability is the one it gave that choice.
// - score: value is the most probable level, as an integer (ties go to the
//   lower level). The expected score Jev also returns is fractional and, per
//   TypeSafe's own guidance, not a magnitude to read; the key holds levels.
// - labeler_version is the model id the response names.

import type { Answer, Ask, Labeler, LabelOutcome, Pair, State } from './labels.ts';

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface JevResponse {
  /** The model that answered, as the response names it. */
  model: string;
  answers: Record<string, unknown>;
}

export type SystemOneCall = (state: State, questions: Record<string, JevQuestion>) => Promise<JevResponse>;

/** The questions of one request, keyed by question id, instructions verbatim from the contract. */
export function jevQuestions(asks: readonly Ask[]): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  for (const { question, options } of asks) {
    if (question.type === 'score') {
      const levels = (question.options as [number, string][]).map(([, description]) => description);
      out[question.question_id] = { type: 'score', instructions: question.text, criteria: levels };
    } else {
      out[question.question_id] = { type: 'choice', instructions: question.text, criteria: Object.fromEntries(options as Pair[]) };
    }
  }
  return out;
}

const isProbabilities = (value: unknown): value is Record<string, number> =>
  typeof value === 'object' && value !== null && Object.values(value).every((p) => typeof p === 'number' && Number.isFinite(p));

/** One answer as a row value, or an error naming what is wrong with it. */
export function answerFrom(ask: Ask, raw: unknown): Answer {
  const answer = (raw ?? {}) as Record<string, unknown>;
  const id = ask.question.question_id;
  if (!isProbabilities(answer['probabilities'])) throw new Error(`${id}: no probabilities`);
  const probabilities = answer['probabilities'];
  const confidence = typeof answer['confidence'] === 'number' ? answer['confidence'] : undefined;
  if (ask.question.type === 'score') {
    const levels = Object.keys(probabilities).sort((a, b) => Number(a) - Number(b));
    if (levels.length === 0) throw new Error(`${id}: no levels`);
    let best = levels[0]!;
    for (const level of levels) if (probabilities[level]! > probabilities[best]!) best = level;
    return { value: Number(best), probability: probabilities[best]!, probabilities, confidence };
  }
  const choice = answer['choice'];
  const labels = (ask.options ?? []).map(([label]) => label);
  if (typeof choice !== 'string' || !labels.includes(choice)) throw new Error(`${id}: choice outside the options`);
  const probability = probabilities[choice];
  if (probability === undefined) throw new Error(`${id}: no probability for the choice`);
  return { value: choice, probability, probabilities, confidence };
}

/**
 * A labeler that asks Jev. `refuse` runs on the state before anything is
 * sent; a reason from it, an error from the call, or a malformed answer
 * becomes a fallback for that unit rather than a failed run.
 */
export function jevLabeler(call: SystemOneCall, refuse: (state: State) => string | undefined): Labeler {
  return {
    kind: 'model',
    name: 'jev',
    async label(state: State, asks: readonly Ask[]): Promise<LabelOutcome> {
      const refused = refuse(state);
      if (refused) return { fallback: `refused:${refused}` };
      if (asks.length === 0) return { fallback: 'nothing-asked' };
      try {
        const response = await call(state, jevQuestions(asks));
        const answers = new Map<string, Answer>();
        for (const ask of asks) answers.set(ask.question.question_id, answerFrom(ask, response.answers[ask.question.question_id]));
        return { version: response.model, answers };
      } catch (error) {
        return { fallback: `error:${(error instanceof Error ? error.message : String(error)).slice(0, 80)}` };
      }
    },
  };
}
