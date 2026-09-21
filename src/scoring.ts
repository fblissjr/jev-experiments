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
  /** The chosen option's probability, for a model's rows; absent or null otherwise. */
  probability?: number | null;
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

/** The join key: one unit's answer to one question version. */
export type RowKeyed = Pick<ScoredRow, 'native_session_id' | 'user_entry_uuid' | 'question_id' | 'question_version'>;

export const rowKey = (r: RowKeyed) => `${r.native_session_id}|${r.user_entry_uuid}|${r.question_id}|${r.question_version}`;

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

export interface Bucket {
  /** Lower edge of the probability range, in tenths: 0.9 covers 0.9 to 1.0 inclusive. */
  from: number;
  n: number;
  agree: number;
  meanProbability: number;
}

export interface Calibration {
  question_id: string;
  labeler: string;
  n: number;
  meanProbability: number;
  accuracy: number;
  buckets: Bucket[];
}

/**
 * For each question and labeler with probabilities: compared rows grouped by
 * the chosen option's probability, each group's agreement with the key beside
 * its mean probability. A calibrated labeler's agreement tracks its
 * probability. Rows whose options differ from the key's are left out.
 */
export function calibration(labels: readonly ScoredRow[], key: readonly ScoredRow[]): Calibration[] {
  const keyByRow = new Map(key.map((r) => [rowKey(r), r]));
  const groups = new Map<string, { ours: ScoredRow; key: ScoredRow }[]>();
  for (const ours of labels) {
    if (typeof ours.probability !== 'number') continue;
    const k = keyByRow.get(rowKey(ours));
    if (!k || k.options_hash !== ours.options_hash) continue;
    const id = `${ours.question_id}|${ours.labeler}`;
    const group = groups.get(id) ?? groups.set(id, []).get(id)!;
    group.push({ ours, key: k });
  }
  const out: Calibration[] = [];
  for (const [id, pairs] of groups) {
    const [question_id, labeler] = id.split('|') as [string, string];
    const byBucket = new Map<number, { n: number; agree: number; sum: number }>();
    let agreeAll = 0;
    let sumAll = 0;
    for (const { ours, key: k } of pairs) {
      const p = ours.probability as number;
      const from = Math.min(9, Math.floor(p * 10)) / 10;
      const bucket = byBucket.get(from) ?? byBucket.set(from, { n: 0, agree: 0, sum: 0 }).get(from)!;
      const agrees = String(ours.value) === String(k.value);
      bucket.n += 1;
      bucket.sum += p;
      if (agrees) {
        bucket.agree += 1;
        agreeAll += 1;
      }
      sumAll += p;
    }
    out.push({
      question_id,
      labeler,
      n: pairs.length,
      meanProbability: sumAll / pairs.length,
      accuracy: agreeAll / pairs.length,
      buckets: [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([from, b]) => ({ from, n: b.n, agree: b.agree, meanProbability: b.sum / b.n })),
    });
  }
  return out;
}
