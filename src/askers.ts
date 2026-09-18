// Scorers for the replay's arms, and the SDK-backed Jev call. Harness only:
// the SDK needs Node or Bun, which a hooks module does not have.

import { TypeSafeClient, type EntryType } from '@typesafe-ai/sdk';
import type { Call } from './compact/calls.ts';
import type { Scorer, Scores } from './compact/decide.ts';
import type { NoulAsk } from './compact/jev.ts';

/**
 * Every candidate gets the same scores: (0) is a rule that drops them all,
 * (1, 0) one that truncates them all.
 */
export function constantScorer(keepCall: number, keepResult = keepCall): Scorer {
  return async (candidates) => ({ scores: new Map(candidates.map((call) => [call.tool_use_id, { keepCall, keepResult }])) });
}

/** A fake Jev: answers every question with `p`. Runs the whole Jev path with no request. */
export function constantAsk(p: number): NoulAsk {
  return async (_state, questions) => Object.fromEntries(Object.keys(questions).map((name) => [name, p]));
}

function unitHash(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296;
}

/** Keeps each candidate whole with probability `p`, drops it otherwise. Seeded, so reruns agree. */
export function randomScorer(p: number, seed: string): Scorer {
  return async (candidates) => {
    const scores = new Map<string, Scores>();
    for (const call of candidates) {
      const keep = unitHash(`${seed}:${call.tool_use_id}`) < p ? 1 : 0;
      scores.set(call.tool_use_id, { keepCall: keep, keepResult: keep });
    }
    return { scores };
  };
}

/** Keeps exactly the candidates the future shows were needed. Not buildable: a ceiling. */
export function oracleScorer(needed: (call: Call) => boolean): Scorer {
  return async (candidates) => {
    const scores = new Map<string, Scores>();
    for (const call of candidates) {
      const keep = needed(call) ? 1 : 0;
      scores.set(call.tool_use_id, { keepCall: keep, keepResult: keep });
    }
    return { scores };
  };
}

export interface SdkUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

/** Jev through @typesafe-ai/sdk. Reads TYPESAFE_API_KEY. `usage` accumulates across calls. */
export function sdkAsk(usage: SdkUsage, client = new TypeSafeClient()): NoulAsk {
  return async (state, questions) => {
    const started = performance.now();
    // The state is built from JSON-parsed log records, so it is JSON.
    const response = await client.systemOne({ state: state as EntryType, questions });
    usage.ms += performance.now() - started;
    usage.requests += 1;
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    const out: Record<string, number> = {};
    for (const [name, answer] of Object.entries(response.answers)) if (answer.type === 'noul') out[name] = answer.noul;
    return out;
  };
}
