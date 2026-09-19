// Experiment 10's score: Jev's answers against the key. See README.md.
//
//   bun run wording-eval [--from RUN] [--key FILE] [--out DIR]
//
// Reads the answers from the ledger, where each sits beside the body that
// produced it, and the key from internal/. Reports, per class:
//   - the matched pairs: the answer on the defective unit against the answer
//     on the same unit after the fix, and how many dropped
//   - the untouched prompts as weak negatives, at the same shot position,
//     because a later shot may leave out a place an earlier one stated
//   - where each defective unit sits among those untouched units
// Writes a summary to runs/10-prompt-wording/eval-<time>/. Prompt ids stay in
// the run output, which is gitignored; a committed result carries rates only.

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Ledger } from '../../src/ledger.ts';

const EXPERIMENT = '10-prompt-wording';
const JEV_CLASSES = ['unplaced_person', 'agentless_action', 'contradicted_count'] as const;
type JevClass = (typeof JEV_CLASSES)[number];

const { values } = parseArgs({ options: { from: { type: 'string' }, key: { type: 'string' }, out: { type: 'string' } } });
const ledger = new Ledger();
const from = values.from ?? ledger.runs().filter((r) => r.kind === 'dry-run' && r.experiment === EXPERIMENT && r.approved_at).at(-1)?.run_id;
if (!from) throw new Error('no approved dry run to score');

interface KeyRow {
  prompt_id: string;
  shot: number | null;
  classes: string[];
  assigned_by: string;
}
const keyFile = values.key ?? new URL('../../internal/10-prompt-wording-key.json', import.meta.url).pathname;
const key = JSON.parse(readFileSync(keyFile, 'utf8')) as { before: string; after: string; rows: KeyRow[] };

// Every answer of every send from that dry run, with the unit it came from.
const rows = ledger.db
  .query(
    `SELECT p.meta AS meta, r.response AS response, r.status AS status
     FROM responses r
     JOIN runs s ON s.run_id = r.run_id
     JOIN payloads p ON p.run_id = s.from_run AND p.seq = r.seq
     WHERE s.from_run = ? AND r.status = 'ok'`,
  )
  .all(from) as { meta: string; response: string; status: string }[];

type Unit = { prompt_id: string; version: string; shot: string };
const answers = new Map<string, number>();
const units: Unit[] = [];
const unitKey = (u: Unit, question: string) => `${u.prompt_id}|${u.version}|${u.shot}|${question}`;
for (const row of rows) {
  const meta = JSON.parse(row.meta) as { prompt_id: string; version: string; kind: string; shot: number | string };
  const unit: Unit = { prompt_id: meta.prompt_id, version: meta.version, shot: String(meta.shot) };
  units.push(unit);
  for (const [question, answer] of Object.entries(JSON.parse(row.response) as Record<string, { noul?: number }>)) {
    if (typeof answer.noul === 'number') answers.set(unitKey(unit, question), answer.noul);
  }
}
const ask = (prompt_id: string, version: string, shot: string, question: string) => answers.get(`${prompt_id}|${version}|${shot}|${question}`);

const quantile = (values: number[], q: number) => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
/** P(at least `hits` of `n` coin flips), the chance arm's odds of doing this well. */
const atLeast = (hits: number, n: number): number => {
  let sum = 0;
  for (let k = hits; k <= n; k += 1) {
    let c = 1;
    for (let i = 0; i < k; i += 1) c = (c * (n - i)) / (i + 1);
    sum += c;
  }
  return sum / 2 ** n;
};

const share = (values: number[], below: number) => (values.length === 0 ? NaN : values.filter((v) => v < below).length / values.length);

const report: string[] = [`experiment ${EXPERIMENT}, answers from ${from}, key ${key.before}..${key.after}`];
const summary: Record<string, unknown> = { from, key: { before: key.before, after: key.after }, classes: {} };

for (const question of JEV_CLASSES) {
  const pairs = key.rows
    .filter((row) => row.classes.includes(question))
    .map((row) => {
      const shot = row.shot === null ? 'all' : String(row.shot);
      return { prompt_id: row.prompt_id, shot, before: ask(row.prompt_id, 'before', shot, question), after: ask(row.prompt_id, 'after', shot, question) };
    })
    .filter((pair): pair is { prompt_id: string; shot: string; before: number; after: number } => typeof pair.before === 'number' && typeof pair.after === 'number');

  // Weak negatives: untouched prompts, at the same shot position as the pair.
  const untouchedAt = (shot: string) =>
    units
      .filter((u) => u.version === 'same' && u.shot === shot)
      .map((u) => ask(u.prompt_id, 'same', u.shot, question))
      .filter((v): v is number => typeof v === 'number');

  const drops = pairs.filter((p) => p.before > p.after);
  const ranks = pairs.map((p) => share(untouchedAt(p.shot), p.before));
  const all = untouchedAt('1').concat(untouchedAt('2'), untouchedAt('3'), untouchedAt('4'), untouchedAt('all'));
  report.push('');
  report.push(`## ${question}`);
  report.push(`pairs: ${pairs.length}; the answer dropped after the fix in ${drops.length}`);
  report.push(`a coin would drop that often or more in ${(atLeast(drops.length, pairs.length) * 100).toFixed(0)}% of runs; a fake asker that answers the same for every unit drops none`);
  report.push(`defective units: median ${quantile(pairs.map((p) => p.before), 0.5).toFixed(3)}, fixed units: median ${quantile(pairs.map((p) => p.after), 0.5).toFixed(3)}`);
  report.push(`untouched units (${all.length}): median ${quantile(all, 0.5).toFixed(3)}, 90th ${quantile(all, 0.9).toFixed(3)}, 95th ${quantile(all, 0.95).toFixed(3)}, max ${Math.max(...all).toFixed(3)}`);
  report.push(`each defective unit's place among untouched units at the same shot: ${ranks.map((r) => `${Math.round(r * 100)}%`).join(', ')}`);
  for (const p of pairs) report.push(`  ${p.prompt_id} shot ${p.shot}: ${p.before.toFixed(3)} -> ${p.after.toFixed(3)}${p.before > p.after ? '' : '   NO DROP'}`);
  (summary['classes'] as Record<string, unknown>)[question] = {
    pairs: pairs.length,
    dropped: drops.length,
    chance_p: atLeast(drops.length, pairs.length),
    before_median: quantile(pairs.map((p) => p.before), 0.5),
    after_median: quantile(pairs.map((p) => p.after), 0.5),
    untouched: { n: all.length, median: quantile(all, 0.5), p90: quantile(all, 0.9), p95: quantile(all, 0.95), max: Math.max(...all) },
    rank_among_untouched: ranks,
    rows: pairs,
  };
}

const out = values.out ?? `runs/${EXPERIMENT}/eval-${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 1) + '\n');
writeFileSync(`${out}/report.txt`, report.join('\n') + '\n');
console.log(report.join('\n'));
console.log(`\nwrote ${out}/`);
ledger.close();
