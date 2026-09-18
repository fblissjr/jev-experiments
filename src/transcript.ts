// Reads a Claude Code session log (one JSON record per line) into the main
// conversation as `SessionMessage`s, the shape a `session.compact` hook is
// handed, split into spans at each compaction the engine recorded.
//
// Pure: takes the file's text, does no I/O. Records are taken in file order.
// A rewind that branches from far back is not followed; on the sessions this
// was written against it was rare (see the experiment 01 README).

import type { SessionMessage, ToolResultSummary, ToolUseSummary } from 'claude-code';

/** One message of the main conversation, with what the log adds beyond `SessionMessage`. */
export interface LoggedMessage {
  message: SessionMessage;
  /** Uuids of the log records merged into this message. */
  uuids: string[];
  /**
   * For an assistant message, the context its API call read: input tokens plus
   * cache-read and cache-creation tokens, as the API reported them.
   */
  contextTokens?: number;
  /** A user message the person typed: not tool results, not injected (`isMeta`), not a summary. */
  isPrompt: boolean;
  /** Set on a compaction's own output: its summary, or a message it kept. Not new activity. */
  origin?: 'summary' | 'preserved';
}

/** A compaction the engine recorded (`compact_boundary`). */
export interface Compaction {
  trigger: string;
  preTokens?: number;
  postTokens?: number;
  /** The summary message the engine wrote, when the log holds it. */
  summary?: string;
  /** Messages the engine kept verbatim beside the summary. */
  preserved: LoggedMessage[];
  /** Uuids of the records the engine says it kept, wherever the log wrote them. */
  preservedIds: string[];
}

/** A span of the main conversation between two compactions. */
export interface Segment {
  messages: LoggedMessage[];
  /** The compaction that ended this span; absent for the last one. */
  compaction?: Compaction;
}

export interface Transcript {
  segments: Segment[];
  /** Claude Code versions named by the records, in order of first appearance. */
  versions: string[];
  /** Lines that were not JSON. */
  unparsed: number;
}

type Block = Record<string, unknown>;

/** A tool_result's or a message's content as the model read it: text blocks joined. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Block[]) {
    if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text']);
    else if (block['type'] === 'image') parts.push('[image]');
    else if (block['type'] === 'document') parts.push('[document]');
  }
  return parts.join('\n');
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface ReadOptions {
  /**
   * Ignore records stamped after this ISO time. Logs are append-only, so this
   * freezes a live log as it was then and makes runs repeatable.
   */
  until?: string;
}

export function readTranscript(jsonl: string, options: ReadOptions = {}): Transcript {
  const versions: string[] = [];
  let unparsed = 0;
  let current: Segment = { messages: [] };
  const segments: Segment[] = [current];
  // tool_use_id -> the ToolUseSummary its result is attached to, per segment.
  let uses = new Map<string, ToolUseSummary>();
  let lastAssistantId: string | undefined;
  const byUuid = new Map<string, LoggedMessage>();
  // The engine can write a kept record after the boundary, stamped before it.
  // Such a record belongs to the previous compaction's output, not the new span.
  let keptAfter = new Set<string>();
  const until = options.until === undefined ? undefined : Date.parse(options.until);
  if (until !== undefined && Number.isNaN(until)) throw new Error(`not a time: ${options.until}`);

  const push = (entry: LoggedMessage): void => {
    current.messages.push(entry);
    for (const uuid of entry.uuids) byUuid.set(uuid, entry);
  };
  // A kept record written after the boundary: part of the previous
  // compaction's output. Its token count is the context before compacting.
  const markKept = (entry: LoggedMessage): void => {
    entry.origin = 'preserved';
    entry.contextTokens = undefined;
    entry.isPrompt = false;
    const compaction = segments.at(-2)?.compaction;
    if (compaction && !compaction.preserved.includes(entry)) compaction.preserved.push(entry);
  };

  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    let record: Block;
    try {
      record = JSON.parse(line) as Block;
    } catch {
      unparsed += 1;
      continue;
    }
    if (record['isSidechain'] === true) continue;
    if (until !== undefined && typeof record['timestamp'] === 'string' && Date.parse(record['timestamp']) > until) continue;
    const version = record['version'];
    if (typeof version === 'string' && !versions.includes(version)) versions.push(version);
    const uuid = typeof record['uuid'] === 'string' ? record['uuid'] : '';
    const type = record['type'];

    if (type === 'system' && record['subtype'] === 'compact_boundary') {
      const meta = (record['compactMetadata'] ?? {}) as Block;
      const preservedIds = ((meta['preservedMessages'] as Block | undefined)?.['uuids'] ?? []) as string[];
      const preserved: LoggedMessage[] = [];
      for (const id of preservedIds) {
        const found = byUuid.get(id);
        if (found && !preserved.includes(found)) preserved.push(found);
      }
      current.compaction = {
        trigger: typeof meta['trigger'] === 'string' ? meta['trigger'] : 'unknown',
        preTokens: num(meta['preTokens']),
        postTokens: num(meta['postTokens']),
        preserved,
        preservedIds,
      };
      keptAfter = new Set(preservedIds.filter((id) => !byUuid.has(id)));
      current = { messages: [] };
      segments.push(current);
      uses = new Map();
      lastAssistantId = undefined;
      continue;
    }

    if (type !== 'user' && type !== 'assistant') continue;
    const message = (record['message'] ?? {}) as Block;
    const content = message['content'];

    if (type === 'assistant') {
      const id = typeof message['id'] === 'string' ? message['id'] : uuid;
      const usage = (message['usage'] ?? {}) as Block;
      const context =
        (num(usage['input_tokens']) ?? 0) +
        (num(usage['cache_read_input_tokens']) ?? 0) +
        (num(usage['cache_creation_input_tokens']) ?? 0);
      const last = current.messages.at(-1);
      let entry: LoggedMessage;
      if (last && last.message.role === 'assistant' && lastAssistantId === id) {
        entry = last;
        entry.uuids.push(uuid);
        byUuid.set(uuid, entry);
      } else {
        entry = { message: { role: 'assistant', text: '', toolUses: [] }, uuids: [uuid], isPrompt: false };
        push(entry);
      }
      lastAssistantId = id;
      if (keptAfter.has(uuid)) markKept(entry);
      else if (context > 0 && entry.origin === undefined) entry.contextTokens = context;
      if (Array.isArray(content)) {
        for (const block of content as Block[]) {
          if (block['type'] === 'text' && typeof block['text'] === 'string') {
            entry.message.text = entry.message.text ? `${entry.message.text}\n${block['text']}` : block['text'];
          } else if (block['type'] === 'tool_use') {
            const use: ToolUseSummary = {
              tool_use_id: String(block['id'] ?? ''),
              tool: String(block['name'] ?? ''),
              input: (block['input'] ?? {}) as Record<string, unknown>,
            };
            entry.message.toolUses.push(use);
            uses.set(use.tool_use_id, use);
          }
        }
      } else if (typeof content === 'string') {
        entry.message.text = entry.message.text ? `${entry.message.text}\n${content}` : content;
      }
      continue;
    }

    // A user record: typed text, injected text, tool results, or the compaction summary.
    lastAssistantId = undefined;
    const blocks = Array.isArray(content) ? (content as Block[]) : [];
    const results: ToolResultSummary[] = [];
    for (const block of blocks) {
      if (block['type'] !== 'tool_result') continue;
      const result: ToolResultSummary = {
        tool_use_id: String(block['tool_use_id'] ?? ''),
        text: contentText(block['content']),
        isError: block['is_error'] === true,
      };
      results.push(result);
      const use = uses.get(result.tool_use_id);
      if (use) {
        use.text = result.text;
        if (result.isError) use.isError = true;
      }
    }
    const text = typeof content === 'string' ? content : contentText(blocks.filter((block) => block['type'] !== 'tool_result'));

    if (record['isCompactSummary'] === true) {
      const previous = segments.at(-2);
      if (previous?.compaction) previous.compaction.summary = text;
      push({ message: { role: 'user', text, toolUses: [] }, uuids: [uuid], isPrompt: false, origin: 'summary' });
      for (const kept of previous?.compaction?.preserved ?? []) {
        // The token count it carries is the context before the compaction.
        current.messages.push({ ...kept, contextTokens: undefined, origin: 'preserved' });
        for (const use of kept.message.toolUses) uses.set(use.tool_use_id, use);
      }
      continue;
    }

    const last = current.messages.at(-1);
    if (results.length > 0 && text === '' && last && last.message.role === 'user' && last.message.text === '' && last.message.toolResults) {
      last.message.toolResults.push(...results);
      last.uuids.push(uuid);
      byUuid.set(uuid, last);
      if (keptAfter.has(uuid)) markKept(last);
      continue;
    }
    const entry: LoggedMessage = {
      message: { role: 'user', text, toolUses: [] },
      uuids: [uuid],
      isPrompt: results.length === 0 && record['isMeta'] !== true,
    };
    if (results.length > 0) entry.message.toolResults = results;
    push(entry);
    if (keptAfter.has(uuid)) markKept(entry);
  }

  return { segments, versions, unparsed };
}
