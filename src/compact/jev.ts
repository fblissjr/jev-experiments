// A scorer that asks Jev two yes/no questions per tool call: keep the call,
// keep its full result. The Jev call is passed in (`NoulAsk`): the replay
// passes one built on @typesafe-ai/sdk, a hook one built on `$.http.fetch`.
//
// The default wording and the state's layout reproduce fast-jev-compaction at
// e3f262a (MIT, tamaratran/fast-jev-compaction), so experiment 01 measures
// that design on the owner's sessions. Experiments 02 and 03 vary them.
//
// One deliberate difference: when the state does not fit the budget with every
// message in it, this declines (`fallback`) rather than scoring calls Jev
// cannot see (fast-jev-compaction issue #52).
//
// Hook-safe: no I/O, no Node, no Bun (checked by tsconfig.hooks.json).

import type { SessionMessage } from 'claude-code';
import type { Call } from './calls.ts';
import type { Scorer, Scores } from './decide.ts';

export type JevState = string | Record<string, unknown>;
export type NoulQuestions = Record<string, { type: 'noul'; instructions: string }>;

/** One Jev request: the state and yes/no questions in, each question's probability out. */
export type NoulAsk = (state: JevState, questions: NoulQuestions) => Promise<Record<string, number>>;

export interface Wording {
  /** Tells Jev what the state is and what the questions decide. */
  context: string;
  keepCall(call: Call): string;
  keepResult(call: Call): string;
}

/** fast-jev-compaction's defaults at e3f262a, quoted. */
export const REFERENCE_WORDING: Wording = {
  context:
    'A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.',
  keepCall: (call) =>
    `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
  keepResult: (call) =>
    `The full output of tool call ${call.id} (${call.tool}, ${call.resultText.length} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
};

export interface JevScorerOptions {
  wording: Wording;
  /** Estimated token ceiling for the state. */
  maxStateTokens: number;
  /** Estimated token ceiling for the state plus one batch of questions. */
  maxRequestTokens: number;
  /** How many of the newest prompts make up the goal. */
  goalPrompts: number;
}

export const DEFAULT_JEV_OPTIONS: JevScorerOptions = {
  wording: REFERENCE_WORDING,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  goalPrompts: 3,
};

/**
 * A deliberately high estimate: three characters a token. JSON-heavy states
 * run near that; prose runs nearer four. The replay records Jev's reported
 * input tokens beside it, so the estimate can be checked.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function abridge(text: string, head = 400, tail = 150): string {
  if (text.length <= head + tail + 40) return text;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} chars omitted …]\n${text.slice(-tail)}`;
}

function inputJson(input: Record<string, unknown>, limit: number): string {
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    json = '[unserializable input]';
  }
  return clip(json, limit);
}

function resultNote(call: Call): string {
  return `${call.isError ? 'error' : 'ok'}, ${call.resultText.length} chars (omitted)`;
}

/** The newest prompts, oldest first; command wrappers and injected blocks skipped. */
export function goalOf(messages: readonly SessionMessage[], count: number): string {
  const prompts: string[] = [];
  for (let at = messages.length - 1; at >= 0 && prompts.length < count; at -= 1) {
    const message = messages[at]!;
    if (message.role !== 'user' || message.toolResults?.length || message.text.trim() === '') continue;
    if (message.text.trimStart().startsWith('<')) continue;
    prompts.unshift(clip(message.text.trim(), 300));
  }
  return prompts.join('\n---\n');
}

type Stage = { name: string; inputChars: number; oneLine: boolean };
const STAGES: readonly Stage[] = [
  { name: 'full', inputChars: 1000, oneLine: false },
  { name: 'short-inputs', inputChars: 200, oneLine: false },
  { name: 'one-line-calls', inputChars: 60, oneLine: true },
];

export function buildState(messages: readonly SessionMessage[], calls: readonly Call[], wording: Wording, goal: string, stage: Stage): JevState {
  const byUse = new Map(calls.map((call) => [call.tool_use_id, call]));
  const history: Record<string, unknown>[] = [];
  messages.forEach((message, i) => {
    const toolCalls = message.toolUses.flatMap((use): unknown[] => {
      const call = byUse.get(use.tool_use_id);
      if (!call) return [];
      return stage.oneLine
        ? [`${call.id} ${call.tool} ${inputJson(call.input, stage.inputChars)} -> ${resultNote(call)}`]
        : [{ id: call.id, tool: call.tool, input: inputJson(call.input, stage.inputChars), result: resultNote(call) }];
    });
    if (message.text === '' && toolCalls.length === 0) return;
    const entry: Record<string, unknown> = { i, role: message.role, text: abridge(message.text) };
    if (toolCalls.length > 0) entry['tool_calls'] = toolCalls;
    history.push(entry);
  });
  return { context: wording.context, goal, history };
}

export interface FittedState {
  state: JevState;
  tokens: number;
  stage: string;
}

/** The first stage whose state fits, with every message in it; undefined when none does. */
export function fitState(messages: readonly SessionMessage[], calls: readonly Call[], options: JevScorerOptions): FittedState | undefined {
  const goal = goalOf(messages, options.goalPrompts);
  for (const stage of STAGES) {
    const state = buildState(messages, calls, options.wording, goal, stage);
    const tokens = estimateTokens(JSON.stringify(state));
    if (tokens <= options.maxStateTokens) return { state, tokens, stage: stage.name };
  }
  return undefined;
}

export function questionsFor(call: Call, wording: Wording): NoulQuestions {
  return {
    [`call_${call.id}`]: { type: 'noul', instructions: wording.keepCall(call) },
    [`result_${call.id}`]: { type: 'noul', instructions: wording.keepResult(call) },
  };
}

/** Splits the candidates into batches whose questions fit one request beside the state. */
export function batchCalls(candidates: readonly Call[], stateTokens: number, options: JevScorerOptions): Call[][] | undefined {
  const budget = options.maxRequestTokens - stateTokens - 200;
  const batches: Call[][] = [];
  let current: Call[] = [];
  let used = 0;
  for (const call of candidates) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call, options.wording)));
    if (tokens > budget) return undefined;
    if (used + tokens > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(call);
    used += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** What one scoring pass sent, for the replay's record. Counts only. */
export interface JevUsage {
  stage: string;
  stateTokens: number;
  requests: number;
}

export function jevScorer(ask: NoulAsk, options: JevScorerOptions = DEFAULT_JEV_OPTIONS, onUsage?: (usage: JevUsage) => void): Scorer {
  return async (candidates, messages, calls) => {
    const fitted = fitState(messages, calls, options);
    if (!fitted) return { fallback: 'state-too-large' };
    const batches = batchCalls(candidates, fitted.tokens, options);
    if (!batches) return { fallback: 'no-room-for-questions' };
    onUsage?.({ stage: fitted.stage, stateTokens: fitted.tokens, requests: batches.length });
    const scores = new Map<string, Scores>();
    for (const batch of batches) {
      const questions: NoulQuestions = Object.assign({}, ...batch.map((call) => questionsFor(call, options.wording)));
      const answers = await ask(fitted.state, questions);
      for (const call of batch) {
        const keepCall = answers[`call_${call.id}`];
        const keepResult = answers[`result_${call.id}`];
        if (typeof keepCall !== 'number' || typeof keepResult !== 'number') throw new Error(`Jev gave no answer for ${call.id}`);
        scores.set(call.tool_use_id, { keepCall, keepResult });
      }
    }
    return { scores };
  };
}
