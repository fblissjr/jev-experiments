// Tool calls of a transcript, paired with their results, and the rules that
// keep some of them without asking anyone.
//
// Hook-safe: no I/O, no Node, no Bun (checked by tsconfig.hooks.json).

import type { SessionMessage } from 'claude-code';

export interface Call {
  /** Short id for the state and question names: t1, t2, ... in transcript order. */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use. */
  callIndex: number;
  /** Index of the message holding the tool_result. */
  resultIndex: number;
  resultText: string;
  isError: boolean;
  /** In the first message or the newest `preserveRecent`; never a candidate. */
  pinned: boolean;
}

/**
 * Why a call is kept by rule. Each names something a probability should not
 * decide:
 * - edit: an Edit or Write. Dropping it leaves an earlier Read showing the
 *   file as it was before the change (fast-jev-compaction issue #26).
 * - error: a failed call; the failure is the fact.
 * - delegated: an agent's report or the person's answer. Re-running gives a
 *   different answer, or asks the person again.
 * - read-before-edit: the newest Read of a file before an edit to it, the
 *   content the edit was made against.
 */
export type Protection = 'edit' | 'error' | 'delegated' | 'read-before-edit';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DELEGATED_TOOLS = new Set(['Agent', 'Task', 'AskUserQuestion']);

function pathOf(call: Pick<Call, 'input'>): string | undefined {
  const path = call.input['file_path'] ?? call.input['notebook_path'];
  return typeof path === 'string' ? path : undefined;
}

/** Every string in a tool input, depth first; numbers as their digits. */
export function inputStrings(input: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value);
    else if (typeof value === 'number') out.push(String(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(input);
  return out;
}

export function isPinned(index: number, total: number, preserveRecent: number): boolean {
  return index === 0 || index >= total - preserveRecent;
}

/** Pairs every tool_use with its tool_result. A call with no result yet is not collected. */
export function collectCalls(messages: readonly SessionMessage[], preserveRecent: number): Call[] {
  const results = new Map<string, { index: number; text: string; isError: boolean }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, text: result.text, isError: result.isError });
    }
  });
  const calls: Call[] = [];
  messages.forEach((message, callIndex) => {
    for (const use of message.toolUses) {
      const result = results.get(use.tool_use_id);
      if (!result) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: use.tool_use_id,
        tool: use.tool,
        input: use.input,
        callIndex,
        resultIndex: result.index,
        resultText: result.text,
        isError: result.isError || use.isError === true,
        pinned:
          isPinned(callIndex, messages.length, preserveRecent) ||
          isPinned(result.index, messages.length, preserveRecent),
      });
    }
  });
  return calls;
}

/** The rule that keeps each call, for the calls one keeps. */
export function protections(calls: readonly Call[]): Map<string, Protection> {
  const kept = new Map<string, Protection>();
  calls.forEach((call, at) => {
    if (EDIT_TOOLS.has(call.tool)) {
      kept.set(call.tool_use_id, 'edit');
      const path = pathOf(call);
      if (path === undefined) return;
      for (let back = at - 1; back >= 0; back -= 1) {
        const earlier = calls[back]!;
        if (earlier.tool === 'Read' && pathOf(earlier) === path) {
          if (!kept.has(earlier.tool_use_id)) kept.set(earlier.tool_use_id, 'read-before-edit');
          break;
        }
      }
    } else if (call.isError) {
      kept.set(call.tool_use_id, 'error');
    } else if (DELEGATED_TOOLS.has(call.tool)) {
      kept.set(call.tool_use_id, 'delegated');
    }
  });
  return kept;
}
