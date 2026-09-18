// Experiment 09: score a label file against an answer key.
//
//   bun run eval-labels --labels <dir>/labels.jsonl --units <dir>/units.jsonl --key <exchange_labels.jsonl>
//
// Reconciles units, then scores each labeler per question with src/scoring.ts:
// agreement and the majority-class baseline on the same compared rows, and
// options_hash mismatches. Prints counts only.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { calibration, score, type ScoredRow } from '../../src/scoring.ts';

const { values } = parseArgs({ options: { labels: { type: 'string' }, units: { type: 'string' }, key: { type: 'string' } } });
if (!values.labels || !values.units || !values.key) {
  console.error('usage: bun run eval-labels --labels FILE --units FILE --key FILE');
  process.exit(2);
}

type Row = ScoredRow;
const read = <T>(path: string): T[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);

const labels = read<Row>(values.labels);
const key = read<Row>(values.key);
const units = read<{ unit_type: string; native_session_id: string; user_entry_uuid: string }>(values.units);

const unitKey = (r: { native_session_id: string; user_entry_uuid: string }) => `${r.native_session_id}|${r.user_entry_uuid}`;

// Units: the key's exchange units against ours.
const keyUnits = new Set(key.map(unitKey));
const ourUnits = new Set(units.filter((u) => u.unit_type === 'exchange').map(unitKey));
const missing = [...keyUnits].filter((u) => !ourUnits.has(u));
const extra = [...ourUnits].filter((u) => !keyUnits.has(u));
console.log(`units: key ${keyUnits.size}, ours ${ourUnits.size}, in both ${[...keyUnits].filter((u) => ourUnits.has(u)).length}, missing from ours ${missing.length}, extra in ours ${extra.length}`);

const pct = (part: number, whole: number) => `${((100 * part) / Math.max(1, whole)).toFixed(1)}%`;
let question = '';
for (const s of score(labels, key)) {
  if (s.question_id !== question) {
    question = s.question_id;
    console.log(`\n${question}: ${s.keyRows} key rows`);
  }
  console.log(
    `  ${s.labeler}: compared ${s.compared}, agree ${s.agree} (${pct(s.agree, s.compared)}); on the same rows, majority "${s.majority}" gets ${s.majorityHits} (${pct(s.majorityHits, s.compared)}); options_hash mismatches ${s.hashMismatch}`,
  );
}

const calibrated = calibration(labels, key);
if (calibrated.length > 0) {
  console.log('\ncalibration: agreement with the key by the probability the labeler gave its answer');
  for (const c of calibrated) {
    console.log(`  ${c.question_id} / ${c.labeler}: mean probability ${pct(c.meanProbability, 1)}, agreement ${pct(c.accuracy, 1)} over ${c.n}`);
    for (const b of c.buckets) console.log(`    ${b.from.toFixed(1)}-${(b.from + 0.1).toFixed(1)}: ${b.n} rows, mean probability ${pct(b.meanProbability, 1)}, agreement ${pct(b.agree, b.n)}`);
  }
}
