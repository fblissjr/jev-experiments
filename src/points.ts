// Where a replay compacts: at each compaction the engine recorded (real), and
// at the first turn boundary where the context reached a threshold (synthetic,
// as fast-jev-compaction issue #26 did at 120k tokens).

import type { SessionMessage } from 'claude-code';
import type { Compaction, Transcript } from './transcript.ts';

export interface Point {
  kind: 'real' | 'synthetic';
  /** Which span of the transcript the point is in. */
  segment: number;
  /** The transcript the compaction runs over, oldest first. */
  prefix: SessionMessage[];
  /** What was written after it, up to the next compaction or the end of the log. */
  suffix: SessionMessage[];
  /** Context at the point: the engine's `preTokens` (real) or the last API call's (synthetic). */
  contextTokens?: number;
  /** For a real point, what the engine did there. */
  compaction?: Compaction;
}

export interface PointOptions {
  /** Context tokens a synthetic point waits for. */
  threshold: number;
  /** Fewest messages after a point for it to count; a short future cannot show a need. */
  minSuffix: number;
}

export function findPoints(transcript: Transcript, options: PointOptions): Point[] {
  const points: Point[] = [];
  transcript.segments.forEach((segment, index) => {
    const messages = segment.messages;

    let context: number | undefined;
    for (let at = 0; at < messages.length; at += 1) {
      const entry = messages[at]!;
      if (entry.isPrompt && context !== undefined && context >= options.threshold) {
        if (messages.length - at >= options.minSuffix) {
          points.push({
            kind: 'synthetic',
            segment: index,
            prefix: messages.slice(0, at).map((m) => m.message),
            suffix: messages.slice(at).map((m) => m.message),
            contextTokens: context,
          });
        }
        break;
      }
      if (entry.contextTokens !== undefined) context = entry.contextTokens;
    }

    const compaction = segment.compaction;
    const next = transcript.segments[index + 1];
    if (!compaction || compaction.summary === undefined || !next) return;
    // The summary and the kept messages are the engine's output, not the
    // future, wherever the log wrote them.
    const future = next.messages.filter((m) => m.origin === undefined);
    if (future.length < options.minSuffix) return;
    points.push({
      kind: 'real',
      segment: index,
      prefix: messages.map((m) => m.message),
      suffix: future.map((m) => m.message),
      contextTokens: compaction.preTokens,
      compaction,
    });
  });
  return points;
}
