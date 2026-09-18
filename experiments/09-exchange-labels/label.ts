// Experiment 09: build exchange units from a ccutils warehouse and label them.
// See README.md beside this file.
//
//   bun run label --warehouse <archive.duckdb> --source <name> [options]
//
//   --rules-history FILE   rule versions (project_dir, rule_id, statement,
//                          effective_from, effective_to); without it
//                          rule_violated is not asked
//   --out DIR              default runs/09-exchange-labels/<time>/
//
// Writes units.jsonl (keys and counts, no text), labels.jsonl and
// questions.jsonl, and summary.json. Prints counts only. Sends nothing
// anywhere: the only labeler here is the keyword rule.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildUnits, type MessageRow } from '../../src/exchanges.ts';
import { KEYWORD_LABELER } from '../../src/keyword.ts';
import { labelUnit, questionsJsonl, type LabelRow, type RuleVersion } from '../../src/labels.ts';

const { values } = parseArgs({
  options: {
    warehouse: { type: 'string' },
    source: { type: 'string' },
    'rules-history': { type: 'string' },
    out: { type: 'string' },
  },
});
if (!values.warehouse || !values.source) {
  console.error('usage: bun run label --warehouse <archive.duckdb> --source <name> [--rules-history FILE] [--out DIR]');
  process.exit(2);
}

function duckdb<T>(sql: string): T[] {
  const run = Bun.spawnSync(['duckdb', '-readonly', '-json', values.warehouse!, '-c', sql], { stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`duckdb failed: ${run.stderr.toString().slice(0, 300)}`);
  const text = run.stdout.toString().trim();
  return text === '' ? [] : (JSON.parse(text) as T[]);
}

const rows = duckdb<MessageRow>(readFileSync(`${import.meta.dir}/candidates.sql`, 'utf8'));
const build = duckdb<Record<string, unknown>>(
  'SELECT b.batch_run_id, b.status, b.sessions_seen, s.schema_fingerprint, s.ccutils_version FROM etl.batch_runs b, etl.schema_version s ORDER BY b.started_at',
);
const history: RuleVersion[] | undefined = values['rules-history']
  ? readFileSync(values['rules-history'], 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as RuleVersion)
  : undefined;

const { units, excluded, collapsedCopies, copyTextMismatches } = buildUnits(rows);
const now = new Date().toISOString();
const labels: LabelRow[] = units.flatMap((unit) => labelUnit(unit, KEYWORD_LABELER, values.source!, history, now));

const out = values.out ?? `runs/09-exchange-labels/${now.replace(/[:.]/g, '-')}`;
mkdirSync(out, { recursive: true });
const jsonl = (items: unknown[]) => items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
writeFileSync(
  `${out}/units.jsonl`,
  jsonl(units.map(({ previous_prompt, reply, ...keys }) => ({ ...keys, previous_prompt_chars: previous_prompt?.length ?? null, reply_chars: reply.length }))),
);
writeFileSync(`${out}/labels.jsonl`, jsonl(labels));
writeFileSync(`${out}/questions.jsonl`, questionsJsonl());

const byType = (type: string) => units.filter((unit) => unit.unit_type === type).length;
const byQuestion: Record<string, Record<string, number>> = {};
for (const row of labels) {
  const counts = (byQuestion[row.question_id] ??= {});
  counts[String(row.value)] = (counts[String(row.value)] ?? 0) + 1;
}
const summary = {
  experiment: '09-exchange-labels',
  source: values.source,
  warehouse_build: build,
  rows_read: rows.length,
  sessions: new Set(rows.map((row) => row.session_id)).size,
  units: { exchange: byType('exchange'), interrupt: byType('interrupt') },
  excluded,
  collapsed_copies: collapsedCopies,
  copy_text_mismatches: copyTextMismatches,
  truncated_states: labels.filter((row) => row.question_id === 'user_response' && row.state_truncated).length,
  rule_history: history ? history.length : null,
  labels: labels.length,
  keyword_values: byQuestion,
};
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 1) + '\n');

console.log(`rows ${summary.rows_read}, sessions ${summary.sessions}`);
console.log(`units: exchange ${summary.units.exchange}, interrupt ${summary.units.interrupt}; copies collapsed ${collapsedCopies} (text mismatches ${copyTextMismatches})`);
console.log(`excluded: ${Object.entries(excluded).map(([why, n]) => `${why} ${n}`).join(', ') || 'none'}`);
console.log(`labels ${labels.length}; truncated states ${summary.truncated_states}; rule history ${summary.rule_history ?? 'none (rule_violated not asked)'}`);
for (const [question, counts] of Object.entries(byQuestion)) console.log(`  ${question}: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
console.log(`wrote ${out}/`);
