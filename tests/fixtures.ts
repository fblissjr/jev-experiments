// Hand-made session-log records and transcripts for the tests. No real
// transcript text is used anywhere in the tests.

import type { SessionMessage } from 'claude-code';

let counter = 0;
const id = (prefix: string) => `${prefix}-${++counter}`;

export function prompt(text: string, extra: Record<string, unknown> = {}) {
  return { type: 'user', uuid: id('u'), isSidechain: false, version: '2.1.276', message: { role: 'user', content: text }, ...extra };
}

/** One assistant API message written as one record per content block, as the logs do. */
export function assistant(blocks: Record<string, unknown>[], contextTokens = 1000) {
  const messageId = id('msg');
  return blocks.map((block) => ({
    type: 'assistant',
    uuid: id('a'),
    isSidechain: false,
    version: '2.1.276',
    message: {
      id: messageId,
      role: 'assistant',
      content: [block],
      usage: { input_tokens: 2, cache_read_input_tokens: contextTokens - 2, cache_creation_input_tokens: 0, output_tokens: 10 },
    },
  }));
}

export const text = (value: string) => ({ type: 'text', text: value });
export const toolUse = (useId: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: useId, name, input });

export function toolResult(useId: string, content: string, isError = false) {
  return {
    type: 'user',
    uuid: id('r'),
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content, is_error: isError }] },
  };
}

export const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n');

/** A transcript in the hook's shape: each call is an assistant message and a result message. */
export function conversation(steps: ({ prompt: string } | { say: string } | { call: string; tool: string; input: Record<string, unknown>; result: string; isError?: boolean })[]): SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (const step of steps) {
    if ('prompt' in step) messages.push({ role: 'user', text: step.prompt, toolUses: [] });
    else if ('say' in step) messages.push({ role: 'assistant', text: step.say, toolUses: [] });
    else {
      messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: step.call, tool: step.tool, input: step.input, text: step.result }] });
      messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: step.call, text: step.result, isError: step.isError ?? false }] });
    }
  }
  return messages;
}
