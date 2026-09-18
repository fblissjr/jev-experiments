// Scores label rows against an answer key. Pure.
//
// Rows join on (native_session_id, user_entry_uuid, question_id,
// question_version). A labeler is compared only on the key rows it joined,
// and the majority-class baseline is computed on those same rows, so the two
// numbers printed side by side describe the same set. A value chosen from a
// different option set (options_hash differs) is not comparable, so it counts
// as a disagreement and is also reported on its own.

export interface ScoredRow {
  native_session_id: string;
  user_entry_uuid: string;
  question_id: string;
  question_version: string;
  labeler: string;
  value: string | number;
  options_hash: string | null;
}

export interface Score {
  question_id: string;
  labeler: string;
  /** Key rows for the question, joined or not. */
  keyRows: number;
  /** Key rows this labeler also labeled. */
  compared: number;
  agree: number;
  /** Compared rows whose options_hash differs from the key's. */
  hashMismatch: number;
  /** The key's most common value on the compared rows, and how often it is right there. */
  majority: string;
  majorityHits: number;
}

const rowKey = (r: ScoredRow) => `${r.native_session_id}|${r.user_entry_uuid}|${r.question_id}|${r.question_version}`;

export function score(labels: readonly ScoredRow[], key: readonly ScoredRow[]): Score[] {
  const keyByRow = new Map(key.map((r) => [rowKey(r), r]));
  const questions = [...new Set(key.map((r) => r.question_id))];
  const labelers = [...new Set(labels.map((r) => r.labeler))];
  const scores: Score[] = [];
  for (const question of questions) {
    const keyRows = key.filter((r) => r.question_id === question).length;
    for (const labeler of labelers) {
      const pairs = labels
        .filter((r) => r.labeler === labeler && r.question_id === question)
        .flatMap((r) => {
          const k = keyByRow.get(rowKey(r));
          return k ? [{ ours: r, key: k }] : [];
        });
      const tally = new Map<string, number>();
      for (const { key: k } of pairs) tally.set(String(k.value), (tally.get(String(k.value)) ?? 0) + 1);
      const [majority, majorityHits] = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] ?? ['-', 0];
      const sameOptions = (p: (typeof pairs)[number]) => p.ours.options_hash === p.key.options_hash;
      scores.push({
        question_id: question,
        labeler,
        keyRows,
        compared: pairs.length,
        agree: pairs.filter((p) => sameOptions(p) && String(p.ours.value) === String(p.key.value)).length,
        hashMismatch: pairs.filter((p) => !sameOptions(p)).length,
        majority,
        majorityHits,
      });
    }
  }
  return scores;
}
