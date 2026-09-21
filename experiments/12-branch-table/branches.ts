// Experiment 12: the branch table, and prevalence from it.
//
//   bun run branches --labels <labels.jsonl> [--labels <more.jsonl>] --key <exchange_labels.jsonl> [--out DIR]
//
// Flattens every label row into one row per option (src/branches.ts), writes
// them with the key's rows to branches.jsonl for DuckDB, and prints, per
// question: agreement of the top choice, the key's shares beside counted and
// summed estimates, their distances from the key, and calibration over every
// option for labelers with distributions. Reads files on disk; sends nothing.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { optionCalibration, prevalence, toBranches, type BranchSource, type Shares } from '../../src/branches.ts';
import type { ScoredRow } from '../../src/scoring.ts';

const { values } = parseArgs({ options: { labels: { type: 'string', multiple: true }, key: { type: 'string' }, out: { type: 'string' } } });
if (!values.labels?.length || !values.key) {
  console.error('usage: bun run branches --labels FILE [--labels FILE] --key FILE [--out DIR]');
  process.exit(2);
}

const read = <T>(path: string): T[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);

type Row = BranchSource & ScoredRow;
const labels = values.labels.flatMap((path) => read<Row>(path));
const key = read<Row>(values.key);

const branches = toBranches(labels);
const withDistribution = new Set(labels.filter((r) => r.probabilities !== null && r.probabilities !== undefined).map((r) => r.labeler));

const out = values.out ?? `runs/12-branch-table/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/branches.jsonl`, [...branches, ...toBranches(key)].map((b) => JSON.stringify(b)).join('\n') + '\n');

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const shares = (s: Shares) =>
  Object.entries(s)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([option, share]) => `${option} ${pct(share)}`)
    .join(', ');

const prevalences = prevalence(branches, key);
let question = '';
for (const p of prevalences) {
  if (p.question_id !== question) {
    question = p.question_id;
    console.log(`\n${question}: key ${shares(p.key)}`);
  }
  console.log(`  ${p.labeler}: compared ${p.compared}, top choice agrees ${pct(p.agree / p.compared)}; options_hash mismatches ${p.hashMismatch}`);
  console.log(`    counted: ${shares(p.counted)}  (distance ${p.tvdCounted.toFixed(3)})`);
  if (withDistribution.has(p.labeler)) {
    console.log(`    summed:  ${shares(p.summed)}  (distance ${p.tvdSummed.toFixed(3)})`);
    console.log(`    counted minus summed: ${p.gain.toFixed(3)}, 90% interval ${p.gainInterval[0].toFixed(3)} to ${p.gainInterval[1].toFixed(3)}`);
  }
  console.log(`    majority "${p.majority}" as the estimate: distance ${p.tvdMajority.toFixed(3)}`);
}

const calibrations = optionCalibration(branches, key).filter((c) => withDistribution.has(c.labeler));
if (calibrations.length > 0) {
  console.log('\ncalibration over every option: the share of options that are the key answer, by the probability given');
  for (const c of calibrations) {
    console.log(`  ${c.question_id} / ${c.labeler}: ${c.n} options, mean p ${pct(c.meanP)}, key answers ${pct(c.hits / c.n)}, calibration error ${c.ece.toFixed(3)}`);
    for (const b of c.buckets) console.log(`    ${b.from.toFixed(1)}-${(b.from + 0.1).toFixed(1)}: ${b.n} options, mean p ${pct(b.meanProbability)}, key answers ${pct(b.agree / b.n)}`);
  }
}

writeFileSync(
  `${out}/summary.json`,
  JSON.stringify({ experiment: '12-branch-table', labels: values.labels, key: values.key, branches: branches.length, prevalence: prevalences, calibration: calibrations }, null, 1) + '\n',
);
console.log(`\nwrote ${out}/branches.jsonl and summary.json`);
