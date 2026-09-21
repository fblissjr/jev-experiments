// Label units by hand, fast, on a local page. See src/judge.ts and VISION.md,
// "Labeling never blocks".
//
//   bun run judge --units FILE [--units FILE] [options]
//   bun run judge --warehouse <archive.duckdb> --source NAME [options]
//
//   --units FILE       JSONL units with their text: native_session_id,
//                      user_entry_uuid, reply, and optionally previous_prompt,
//                      source, assistant_entry_uuid, copies
//   --warehouse FILE   build exchange units from a ccutils warehouse, as
//                      experiment 09 does; --source names them
//   --branches FILE    branch rows (experiment 12's format) that order the
//                      queue: disagreements and close calls first
//   --labeler NAME     whose labels these are (default owner)
//   --port N           default 4848
//   --open             open the page in the browser
//
// Serves on 127.0.0.1 only; nothing leaves the machine. Labels are appended to
// data/labels/<labeler>.jsonl as label rows (labeler_kind human), and questions
// the person cannot tell to data/labels/<labeler>.cannot-tell.jsonl. data/ is
// gitignored: real replies stay local. Stop it with ctrl-c; the next run
// resumes where this one stopped.

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { BranchRow } from '../src/branches.ts';
import { buildUnits, type MessageRow } from '../src/exchanges.ts';
import { JudgeSession, orderQueue, type CannotTell, type HumanLabelRow, type JudgeUnit } from '../src/judge.ts';
import { renderJudgePage } from '../src/judgeView.ts';

const { values } = parseArgs({
  options: {
    units: { type: 'string', multiple: true },
    warehouse: { type: 'string' },
    source: { type: 'string' },
    branches: { type: 'string', multiple: true },
    labeler: { type: 'string', default: 'owner' },
    port: { type: 'string', default: '4848' },
    open: { type: 'boolean', default: false },
  },
});
if (!values.units?.length && !values.warehouse) {
  console.error('usage: bun run judge --units FILE [--branches FILE] | --warehouse FILE --source NAME');
  process.exit(2);
}

const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as T)
    : [];

function unitsFromFile(path: string): JudgeUnit[] {
  return readJsonl<Partial<JudgeUnit>>(path).map((u, i) => {
    if (typeof u.native_session_id !== 'string' || typeof u.user_entry_uuid !== 'string' || typeof u.reply !== 'string') {
      throw new Error(`${path} line ${i + 1}: a unit needs native_session_id, user_entry_uuid and reply`);
    }
    return {
      source: u.source ?? path,
      native_session_id: u.native_session_id,
      user_entry_uuid: u.user_entry_uuid,
      assistant_entry_uuid: u.assistant_entry_uuid ?? null,
      copies: u.copies ?? 1,
      previous_prompt: u.previous_prompt ?? null,
      reply: u.reply,
    };
  });
}

function unitsFromWarehouse(warehouse: string, source: string): JudgeUnit[] {
  const sql = readFileSync(`${import.meta.dir}/09-exchange-labels/candidates.sql`, 'utf8');
  const run = Bun.spawnSync(['duckdb', '-readonly', '-json', warehouse, '-c', sql], { stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`duckdb failed: ${run.stderr.toString().slice(0, 300)}`);
  const text = run.stdout.toString().trim();
  const rows = text === '' ? [] : (JSON.parse(text) as MessageRow[]);
  return buildUnits(rows)
    .units.filter((u) => u.unit_type === 'exchange')
    .map((u) => ({ source, native_session_id: u.native_session_id, user_entry_uuid: u.user_entry_uuid, assistant_entry_uuid: u.assistant_entry_uuid, copies: u.copies, previous_prompt: u.previous_prompt, reply: u.reply }));
}

const units = [...(values.units ?? []).flatMap(unitsFromFile), ...(values.warehouse ? unitsFromWarehouse(values.warehouse, values.source ?? values.warehouse) : [])];
const branches = (values.branches ?? []).flatMap((path) => readJsonl<BranchRow>(path));
const labeler = values.labeler!;
const dir = new URL('../data/labels/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const labelsFile = `${dir}${labeler}.jsonl`;
const cannotTellFile = `${dir}${labeler}.cannot-tell.jsonl`;

const session = new JudgeSession(
  orderQueue(units, branches),
  labeler,
  readJsonl<HumanLabelRow>(labelsFile),
  readJsonl<CannotTell>(cannotTellFile),
  (row) => appendFileSync(labelsFile, JSON.stringify(row) + '\n'),
  (record) => appendFileSync(cannotTellFile, JSON.stringify(record) + '\n'),
  () => new Date().toISOString(),
);

// Any page in the browser can post to 127.0.0.1; only this one knows the token,
// and a cross-site request cannot set the header without a preflight this
// server never answers.
const token = randomBytes(16).toString('hex');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(values.port),
  async fetch(request) {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === 'GET' && pathname === '/') return new Response(renderJudgePage(token), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (request.method === 'GET' && pathname === '/api/next') return json({ ...session.next(), labelsFile });
      if (request.method !== 'POST' || !pathname.startsWith('/api/')) return new Response('not found', { status: 404 });
      if (request.headers.get('X-Judge-Token') !== token) return new Response('forbidden', { status: 403 });
      const body = (await request.json()) as { index: number; question_id: string; value: string; unsure: boolean; ms: number };
      const next =
        pathname === '/api/label' ? session.label(body.index, body.question_id, String(body.value), Boolean(body.unsure), Math.max(0, Math.round(Number(body.ms) || 0)))
        : pathname === '/api/cannot-tell' ? session.cannotTellIt(body.index, body.question_id)
        : pathname === '/api/later' ? session.later(body.index)
        : pathname === '/api/back' ? session.back()
        : undefined;
      return next === undefined ? new Response('not found', { status: 404 }) : json({ ...next, labelsFile });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
    }
  },
});

const url = `http://127.0.0.1:${server.port}/`;
const first = session.next();
console.log(`judging ${units.length} units as ${labeler}: ${first.progress.unitsDone} already done`);
console.log(`labels go to ${labelsFile}`);
console.log(`open ${url}   (ctrl-c to stop; the next run resumes)`);
if (values.open) Bun.spawn(['open', url]);
