// How much a compaction removed, and how often something it removed was
// needed again. Pure; the replay feeds it a point's calls, the arm's output
// and what the log shows came after.
//
// The measure compares each call before and after the compaction. It does not
// know what the actions are, so a new action needs no change here.
//
// "Used again" follows fast-jev-compaction issue #26 so the numbers compare:
//   reread: the same file is Read again, or the same Bash/Grep/Glob input is
//     run again, after the point. For results only. A floor: a re-run can also
//     mean the file changed, and a need can be met without re-running.
//   recall: a distinctive string (a path, a number of 4+ digits, a hex hash, an
//     error line) of the removed text, which the arm's output no longer holds,
//     shows up later in assistant text or a tool input, before any later tool
//     result or user message carried it back. It counts coincidences. It also
//     misses paraphrase, and code, which rarely holds such a string: for tool
//     inputs, which are mostly code, it undercounts.
// Differences from #26: "retained" is everything the arm kept, a user message
// counts as a carrier, tool inputs are measured as well as results, and there
// is no cap on strings per result (a cap over a whole result would hide the
// tail a truncation removed).

import type { SessionMessage } from 'claude-code';
import { inputStrings, type Call } from './compact/calls.ts';

const PATH = /(?:[\w.-]+\/)+[\w.-]+\.\w+/g;
const LONG_NUMBER = /\b\d{4,}\b/g;
const HEX_HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;
const ERROR_WORD = /\b(error|errors|failed|failure|fatal|exception|traceback|panic|assert|denied|refused|timeout|cannot|unable|warning)\b/i;

/** The distinctive strings of a text, in order of first appearance per kind. */
export function featuresOf(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of [PATH, LONG_NUMBER, HEX_HASH]) for (const [match] of text.matchAll(pattern)) found.add(match);
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length >= 20 && trimmed.length <= 200 && ERROR_WORD.test(trimmed)) found.add(trimmed);
  }
  return [...found];
}

/** A tool input's strings, one per line, unescaped: what feature matching reads. */
export function inputText(input: Record<string, unknown>): string {
  return inputStrings(input).join('\n');
}

/** A tool input as the model reads it, and the key for comparing two calls. */
function inputJson(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

/** Characters a message puts in context: its text, its tool inputs as JSON, its tool results. */
export function messageChars(message: SessionMessage): number {
  let chars = message.text.length;
  for (const use of message.toolUses) chars += inputJson(use.input).length;
  for (const result of message.toolResults ?? []) chars += result.text.length;
  return chars;
}

export function totalChars(messages: readonly SessionMessage[]): number {
  return messages.reduce((sum, message) => sum + messageChars(message), 0);
}

/** Everything a list of messages holds, as one string to search. */
export function contextText(messages: readonly SessionMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    parts.push(message.text);
    for (const use of message.toolUses) parts.push(inputText(use.input));
    for (const result of message.toolResults ?? []) parts.push(result.text);
  }
  // A newline between parts: no distinctive string spans one.
  return parts.join('\n');
}

/** One stream of the future, with where each message's part starts. */
class Stream {
  readonly text: string;
  private readonly starts: number[];
  private readonly order: number[];

  constructor(parts: readonly { order: number; text: string }[]) {
    this.starts = [];
    this.order = [];
    let offset = 0;
    for (const part of parts) {
      this.starts.push(offset);
      this.order.push(part.order);
      offset += part.text.length + 1;
    }
    this.text = parts.map((part) => part.text).join('\n');
  }

  /** The message order of the first occurrence, or -1. */
  firstOrder(needle: string): number {
    const at = this.text.indexOf(needle);
    if (at < 0) return -1;
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= at) lo = mid;
      else hi = mid - 1;
    }
    return this.order[lo]!;
  }
}

/**
 * What makes two calls the same re-run. For Bash, the command alone: its
 * `description` is written fresh each call. For Grep and Glob, the whole input.
 */
function rerunKey(tool: string, input: Record<string, unknown>): string {
  return tool === 'Bash' ? `Bash ${typeof input['command'] === 'string' ? input['command'] : inputJson(input)}` : `${tool} ${inputJson(input)}`;
}

/** What the log shows after a point. */
export class Future {
  private readonly uses: Stream;
  private readonly carriers: Stream;
  private readonly memo = new Map<string, boolean>();
  private readonly reads = new Set<string>();
  private readonly runs = new Set<string>();

  constructor(suffix: readonly SessionMessage[]) {
    const uses: { order: number; text: string }[] = [];
    const carriers: { order: number; text: string }[] = [];
    suffix.forEach((message, order) => {
      if (message.role === 'assistant') {
        uses.push({ order, text: [message.text, ...message.toolUses.map((use) => inputText(use.input))].join('\n') });
        for (const use of message.toolUses) {
          if (use.tool === 'Read' && typeof use.input['file_path'] === 'string') this.reads.add(use.input['file_path']);
          if (use.tool === 'Bash' || use.tool === 'Grep' || use.tool === 'Glob') this.runs.add(rerunKey(use.tool, use.input));
        }
      } else {
        carriers.push({ order, text: [message.text, ...(message.toolResults ?? []).map((result) => result.text)].join('\n') });
      }
    });
    this.uses = new Stream(uses);
    this.carriers = new Stream(carriers);
  }

  /** The string is used later, before anything carried it back in. */
  usedLater(feature: string): boolean {
    const known = this.memo.get(feature);
    if (known !== undefined) return known;
    const used = this.uses.firstOrder(feature);
    let answer = false;
    if (used >= 0) {
      const carried = this.carriers.firstOrder(feature);
      answer = carried < 0 || carried > used;
    }
    this.memo.set(feature, answer);
    return answer;
  }

  /** The same call is made again later. Only Read, Bash, Grep and Glob are compared. */
  rerun(tool: string, input: Record<string, unknown>): boolean {
    if (tool === 'Read') return typeof input['file_path'] === 'string' && this.reads.has(input['file_path']);
    if (tool === 'Bash' || tool === 'Grep' || tool === 'Glob') return this.runs.has(rerunKey(tool, input));
    return false;
  }
}

export interface Loss {
  /** Results that lost any text, and the characters removed from them. */
  lost: number;
  lostChars: number;
  recall: number;
  reread: number;
  /** Results that lost text hit by either measure. */
  either: number;
  /** Tool inputs that lost any text, and the characters removed from them. */
  inputsLost: number;
  inputChars: number;
  /** Tool inputs with a removed string that was used again. */
  inputRecall: number;
  /** Calls that lost anything, result or input, needed again: `either` or `inputRecall`. */
  needed: number;
}

export function emptyLoss(): Loss {
  return { lost: 0, lostChars: 0, recall: 0, reread: 0, either: 0, inputsLost: 0, inputChars: 0, inputRecall: 0, needed: 0 };
}

/**
 * Compares each call as it was with what `compacted` still holds of it, and
 * counts what was removed and used again. A string `compacted` still holds
 * anywhere is not lost.
 */
export function measureLoss(calls: readonly Call[], compacted: readonly SessionMessage[], future: Future): Loss {
  const retained = contextText(compacted);
  const after = new Map<string, { input?: string; result?: string }>();
  const slot = (id: string) => after.get(id) ?? after.set(id, {}).get(id)!;
  for (const message of compacted) {
    for (const use of message.toolUses) slot(use.tool_use_id).input = inputText(use.input);
    for (const result of message.toolResults ?? []) slot(result.tool_use_id).result = result.text;
  }
  const usedAgain = (text: string) => featuresOf(text).some((feature) => future.usedLater(feature) && !retained.includes(feature));

  const loss = emptyLoss();
  for (const call of calls) {
    const kept = after.get(call.tool_use_id);
    let needed = false;

    const result = kept?.result ?? '';
    if (result !== call.resultText) {
      loss.lost += 1;
      loss.lostChars += Math.max(0, call.resultText.length - result.length);
      const recall = usedAgain(call.resultText);
      const reread = future.rerun(call.tool, call.input);
      if (recall) loss.recall += 1;
      if (reread) loss.reread += 1;
      if (recall || reread) {
        loss.either += 1;
        needed = true;
      }
    }

    const before = inputText(call.input);
    const input = kept?.input ?? '';
    if (input !== before) {
      loss.inputsLost += 1;
      loss.inputChars += Math.max(0, before.length - input.length);
      if (usedAgain(before)) {
        loss.inputRecall += 1;
        needed = true;
      }
    }

    if (needed) loss.needed += 1;
  }
  return loss;
}
