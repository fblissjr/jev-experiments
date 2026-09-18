// What happens to each tool call at a compaction, and the transcript that
// results. The scorer is passed in: a rule, a fake asker, or Jev.
//
// Hook-safe: no I/O, no Node, no Bun (checked by tsconfig.hooks.json).

import type { SessionMessage, ToolResultSummary, ToolUseSummary } from 'claude-code';
import { collectCalls, protections, type Call, type Protection } from './calls.ts';

/**
 * keep: call and result stay. stub: the result stays, and the call's long
 * input strings (an edit's code) become a note. truncate: the call stays, the
 * result keeps its head. drop: both go.
 */
export type Action = 'keep' | 'stub' | 'truncate' | 'drop';

export interface Scores {
  /** Probability that the call itself still matters. */
  keepCall: number;
  /** Probability that the full result still has to stay. */
  keepResult: number;
}

export type ScoreOutcome = { scores: ReadonlyMap<string, Scores> } | { fallback: string };

/** Scores the candidate calls (keyed by `tool_use_id`), or declines with a reason. */
export type Scorer = (candidates: readonly Call[], messages: readonly SessionMessage[], calls: readonly Call[]) => Promise<ScoreOutcome>;

/** What each protection rule does to the calls it covers; a rule left out keeps them. */
export type RuleActions = Partial<Record<Protection, Action>>;

export interface DecideOptions {
  /** Newest messages never touched; the first message is always kept. */
  preserveRecent: number;
  /** A score below this drops the call, or truncates the result. */
  threshold: number;
  /** The protection rules and their actions (`{}`: every rule keeps), or false for none. */
  rules: RuleActions | false;
}

export type Reason = 'pinned' | `rule:${Protection}` | 'scored';

export interface Decision {
  call: Call;
  action: Action;
  reason: Reason;
  scores?: Scores;
}

export type Decided = { calls: Call[]; decisions: Decision[] } | { fallback: string };

export function actionFor(scores: Scores, threshold: number): Action {
  if (scores.keepCall < threshold) return 'drop';
  if (scores.keepResult < threshold) return 'truncate';
  return 'keep';
}

export async function decide(messages: readonly SessionMessage[], options: DecideOptions, scorer: Scorer): Promise<Decided> {
  const calls = collectCalls(messages, options.preserveRecent);
  const rules = options.rules;
  const ruled = rules ? protections(calls) : new Map<string, Protection>();
  const candidates = calls.filter((call) => !call.pinned && !ruled.has(call.tool_use_id));
  const outcome = candidates.length > 0 ? await scorer(candidates, messages, calls) : { scores: new Map<string, Scores>() };
  if ('fallback' in outcome) return { fallback: outcome.fallback };
  const decisions = calls.map((call): Decision => {
    if (call.pinned) return { call, action: 'keep', reason: 'pinned' };
    const rule = ruled.get(call.tool_use_id);
    if (rule) return { call, action: (rules && rules[rule]) || 'keep', reason: `rule:${rule}` };
    const scores = outcome.scores.get(call.tool_use_id);
    if (!scores) throw new Error(`no score for ${call.id} (${call.tool})`);
    return { call, action: actionFor(scores, options.threshold), reason: 'scored', scores };
  });
  return { calls, decisions };
}

/** What stays of a truncated result: its head, and a note of what went. */
export function truncatedText(text: string, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  return `${text.slice(0, headChars)}\n[${text.length - headChars} more characters of this result were removed at compaction; re-run the tool if they are needed]`;
}

/** Input strings longer than this become a note in a stub; shorter ones, such as a file path, stay. */
export const STUB_LIMIT = 200;

/** What stays of a stubbed input: every string longer than `STUB_LIMIT` becomes a note. The same object when nothing changes. */
export function stubbedInput(input: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.length > STUB_LIMIT ? `[${value.split('\n').length} lines, ${value.length} characters removed at compaction]` : value;
    }
    if (Array.isArray(value)) {
      const out = value.map(walk);
      return out.some((item, i) => item !== value[i]) ? out : value;
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value).map(([key, item]) => [key, walk(item)] as const);
      return entries.some(([key, item]) => item !== (value as Record<string, unknown>)[key]) ? Object.fromEntries(entries) : value;
    }
    return value;
  };
  return walk(input) as Record<string, unknown>;
}

/**
 * The transcript after the decisions. A dropped call loses its tool_use and
 * its tool_result, and a message left with nothing is removed. A stubbed call
 * loses its long input strings; a truncated one, all but the head of its
 * result. A message that
 * changes loses its `handle`, so the engine reads it as built; one that does
 * not change keeps it.
 */
export function applyDecisions(messages: readonly SessionMessage[], decisions: readonly Decision[], headChars: number): SessionMessage[] {
  const actions = new Map(decisions.map((d) => [d.call.tool_use_id, d.action]));
  const out: SessionMessage[] = [];
  for (const message of messages) {
    let changed = false;
    const toolUses: ToolUseSummary[] = [];
    for (const use of message.toolUses) {
      const action = actions.get(use.tool_use_id);
      if (action === 'drop') {
        changed = true;
      } else if (action === 'stub') {
        const input = stubbedInput(use.input);
        if (input !== use.input) changed = true;
        toolUses.push({ ...use, input });
      } else if (action === 'truncate' && use.text !== undefined) {
        const text = truncatedText(use.text, headChars);
        if (text !== use.text) changed = true;
        toolUses.push({ ...use, text });
      } else {
        toolUses.push(use);
      }
    }
    let toolResults: ToolResultSummary[] | undefined;
    if (message.toolResults) {
      toolResults = [];
      for (const result of message.toolResults) {
        const action = actions.get(result.tool_use_id);
        if (action === 'drop') {
          changed = true;
        } else if (action === 'truncate') {
          const text = truncatedText(result.text, headChars);
          if (text !== result.text) changed = true;
          toolResults.push({ ...result, text });
        } else {
          toolResults.push(result);
        }
      }
    }
    if (!changed) {
      out.push(message);
      continue;
    }
    if (message.text === '' && toolUses.length === 0 && (toolResults?.length ?? 0) === 0) continue;
    const built: SessionMessage = { role: message.role, text: message.text, toolUses };
    if (toolResults) built.toolResults = toolResults;
    out.push(built);
  }
  return out;
}
