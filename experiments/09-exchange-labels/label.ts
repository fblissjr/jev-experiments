// Experiment 09: build exchange units from a ccutils warehouse and label them.
// See README.md beside this file.
//
//   bun run label --warehouse <archive.duckdb> --source <name> [options]
//
//   --rules-history FILE   rule versions (project_dir, rule_id, statement,
//                          effective_from, effective_to); without it
//                          rule_violated is not asked
//   --labeler NAME         keyword (default) or jev
//   --dry-run              jev: build every request and check it, send nothing
//   --egress synthetic     jev: allow sending; only synthetic sources, for now
//   --limit N              label only the first N exchange units (a smoke run)
//   --out DIR              default runs/09-exchange-labels/<time>/
//
// Writes units.jsonl (keys and counts, no text), labels.jsonl,
// questions.jsonl and summary.json; for jev, also sent.jsonl (hash, bytes,
// status, model, time per request; never the key, a header or the body).
// Prints counts only. The keyword labeler sends nothing. The jev labeler sends
// each state to TypeSafe, and only for a synthetic source: real sessions wait
// on an allowlist and the owner's review of each run.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { TypeSafeClient, type EntryType, type Questions } from '@typesafe-ai/sdk';
import { refuseState } from '../../src/egress.ts';
import { buildUnits, type MessageRow } from '../../src/exchanges.ts';
import { jevLabeler, jevQuestions, type SystemOneCall } from '../../src/jevLabeler.ts';
import { KEYWORD_LABELER } from '../../src/keyword.ts';
import { asksFor, labelUnit, questionsJsonl, stateOf, type Labeler, type LabelRow, type RuleVersion, type State } from '../../src/labels.ts';

const { values } = parseArgs({
  options: {
    warehouse: { type: 'string' },
    source: { type: 'string' },
    'rules-history': { type: 'string' },
    labeler: { type: 'string', default: 'keyword' },
    'dry-run': { type: 'boolean', default: false },
    egress: { type: 'string' },
    limit: { type: 'string' },
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

const built = buildUnits(rows);
const { excluded, collapsedCopies, copyTextMismatches } = built;
const limit = values.limit === undefined ? Infinity : Number(values.limit);
const units = built.units.filter((unit) => unit.unit_type === 'exchange').slice(0, limit).concat(Number.isFinite(limit) ? [] : built.units.filter((unit) => unit.unit_type !== 'exchange'));
const now = new Date().toISOString();
const out = values.out ?? `runs/09-exchange-labels/${now.replace(/[:.]/g, '-')}`;
mkdirSync(out, { recursive: true });

const useJev = values.labeler === 'jev';
if (!useJev && values.labeler !== 'keyword') throw new Error(`unknown labeler: ${values.labeler}`);
const apiKey = process.env['TYPESAFE_API_KEY'];
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
// A state holds exactly the two v1 fields, and no credential or piece of the key.
const guard = (state: State): string | undefined => {
  const keys = Object.keys(state).sort().join(',');
  if (keys !== 'previous_prompt,reply') return `state-fields:${keys}`;
  return refuseState(state, apiKey);
};

if (useJev && values['dry-run']) {
  // What would leave, checked, with nothing sent.
  const plan = units
    .filter((unit) => unit.unit_type === 'exchange')
    .map((unit) => {
      const { state } = stateOf(unit);
      const body = JSON.stringify({ state, questions: jevQuestions(asksFor(unit, history)) });
      return { user_entry_uuid: unit.user_entry_uuid, body_sha256: sha256(body), bytes: Buffer.byteLength(body), refused: guard(state) ?? null };
    });
  writeFileSync(`${out}/dry-run.jsonl`, plan.map((p) => JSON.stringify(p)).join('\n') + '\n');
  const refused = plan.filter((p) => p.refused);
  const bytes = plan.map((p) => p.bytes).sort((a, b) => a - b);
  console.log(`dry run: ${plan.length} requests would be built, ${refused.length} refused (${[...new Set(refused.map((p) => p.refused))].join(', ') || 'none'})`);
  console.log(`request bytes: min ${bytes[0] ?? 0}, median ${bytes[Math.floor(bytes.length / 2)] ?? 0}, max ${bytes.at(-1) ?? 0}; nothing sent`);
  console.log(`wrote ${out}/dry-run.jsonl`);
  process.exit(0);
}

const jevUsage = { requests: 0, inputTokens: 0, ms: 0, versions: new Set<string>(), errors: 0 };
let labeler: (unit: (typeof units)[number]) => Labeler = () => KEYWORD_LABELER;
if (useJev) {
  if (values.egress !== 'synthetic') throw new Error('the jev labeler sends states to TypeSafe: pass --egress synthetic (real sessions are not sent yet)');
  if (!values.source!.startsWith('synthetic')) throw new Error('only a source named synthetic-... may be sent; real sessions wait on an allowlist and owner review');
  if (!apiKey) throw new Error('the jev labeler needs TYPESAFE_API_KEY (in .env at the repo root)');
  const client = new TypeSafeClient({ logLevel: 'off' });
  labeler = (unit) => {
    const call: SystemOneCall = async (state, questions) => {
      const body = JSON.stringify({ state, questions });
      const started = performance.now();
      const entry = { user_entry_uuid: unit.user_entry_uuid, body_sha256: sha256(body), bytes: Buffer.byteLength(body), status: 'ok', model: null as string | null, ms: 0, input_tokens: 0 };
      try {
        const response = await client.systemOne({ state: state as unknown as EntryType, questions: questions as unknown as Questions });
        entry.model = response.model;
        entry.input_tokens = response.usage.input_tokens;
        jevUsage.inputTokens += response.usage.input_tokens;
        jevUsage.versions.add(response.model);
        return { model: response.model, answers: response.answers as unknown as Record<string, unknown> };
      } catch (error) {
        entry.status = `error:${error instanceof Error ? error.constructor.name : 'unknown'}`;
        jevUsage.errors += 1;
        throw error;
      } finally {
        entry.ms = Math.round(performance.now() - started);
        jevUsage.ms += entry.ms;
        jevUsage.requests += 1;
        appendFileSync(`${out}/sent.jsonl`, JSON.stringify(entry) + '\n');
      }
    };
    return jevLabeler(call, guard);
  };
}

const started = performance.now();
const labels: LabelRow[] = [];
const fallbacks: Record<string, number> = {};
for (const unit of units) {
  const result = await labelUnit(unit, labeler(unit), values.source!, history, () => (useJev ? new Date().toISOString() : now));
  labels.push(...result.rows);
  if (result.fallback) fallbacks[result.fallback] = (fallbacks[result.fallback] ?? 0) + 1;
}
const wallMs = Math.round(performance.now() - started);
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
  labeler: values.labeler,
  labels: labels.length,
  fallbacks,
  values: byQuestion,
  jev: useJev
    ? { requests: jevUsage.requests, errors: jevUsage.errors, input_tokens: jevUsage.inputTokens, cost_usd: (jevUsage.inputTokens * 0.042) / 1e6, request_ms: jevUsage.ms, wall_ms: wallMs, versions: [...jevUsage.versions] }
    : null,
};
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 1) + '\n');

console.log(`rows ${summary.rows_read}, sessions ${summary.sessions}`);
console.log(`units: exchange ${summary.units.exchange}, interrupt ${summary.units.interrupt}; copies collapsed ${collapsedCopies} (text mismatches ${copyTextMismatches})`);
console.log(`excluded: ${Object.entries(excluded).map(([why, n]) => `${why} ${n}`).join(', ') || 'none'}`);
console.log(`labeler ${values.labeler}: labels ${labels.length}; fallbacks ${Object.entries(fallbacks).map(([why, n]) => `${why} ${n}`).join(', ') || 'none'}; truncated states ${summary.truncated_states}; rule history ${summary.rule_history ?? 'none (rule_violated not asked)'}`);
if (summary.jev) {
  const j = summary.jev;
  console.log(`jev: ${j.requests} requests, ${j.errors} errors, ${j.input_tokens} input tokens, about $${j.cost_usd.toFixed(6)}, ${(j.wall_ms / 1000).toFixed(1)} s wall; model ${j.versions.join(', ') || 'none'}`);
  if (j.versions.some((v) => v === 'jev-latest' || v === 'jev-preview')) console.log('note: the response named an alias, not a versioned model id');
}
for (const [question, counts] of Object.entries(byQuestion)) console.log(`  ${question}: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
console.log(`wrote ${out}/`);
