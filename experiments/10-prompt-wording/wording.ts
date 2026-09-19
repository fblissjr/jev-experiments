// Experiment 10: ask Jev about wording defects in H3 prompts, before and
// after the fix commit. See README.md beside this file.
//
//   bun run wording --dry-run --bank-repo <dir>      build every body into the ledger
//   bun run payloads show latest                     the owner reads them (or: html latest)
//   bun run payloads approve <run>                   the owner approves that dry run
//   bun run wording --send <run> --egress bank       send the approved bodies
//
//   --bank-repo DIR     dry run: the prompt bank repo (read with git show; never modified)
//   --before REV        dry run: the defective versions (default 4bd7b429^)
//   --after REV         dry run: the fixed versions (default 4bd7b429)
//   --send RUN          send the bodies of this approved dry run (or `latest`)
//   --egress bank       required to send: bank text leaves the machine
//   --limit N           send: at most N more bodies (a smoke run); a later send
//                       from the same dry run skips what was already sent
//
// A dry run reads only `prompt_bank/*.txt` in the bank repo, at the two
// commits. There is no option to read anything else, and a path outside that
// folder stops the run: the owner's rule is that no prompt from any other
// folder, such as internal/internal_prompt_bank, is ever used here.
//
// Every body goes into the egress ledger (src/ledger.ts, data/egress.sqlite)
// exactly as it would be sent, with the commit, path and blob of its text. A
// send transmits only an approved dry run's bodies, checks each is byte for
// byte what was approved, and records each response beside it. It also writes
// answers.jsonl, one row per question, to runs/10-prompt-wording/<time>/.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ENV, TypeSafeClient, VERSION, type EntryType, type Questions } from '@typesafe-ai/sdk';
import { refuseState } from '../../src/egress.ts';
import { codeVersion, Ledger, type PayloadInput } from '../../src/ledger.ts';
import { QUESTION_VERSION, questionsFor, stateField, unitsFor, type WordingUnit } from '../../src/wordingQuestions.ts';

const EXPERIMENT = '10-prompt-wording';

const { values } = parseArgs({
  options: {
    'bank-repo': { type: 'string' },
    before: { type: 'string', default: '4bd7b429^' },
    after: { type: 'string', default: '4bd7b429' },
    'dry-run': { type: 'boolean', default: false },
    send: { type: 'string' },
    egress: { type: 'string' },
    limit: { type: 'string' },
  },
});
if (values['dry-run'] === (values.send !== undefined)) {
  console.error('usage: bun run wording --dry-run --bank-repo <dir>  |  bun run wording --send <run> --egress bank [--limit N]');
  process.exit(2);
}

const apiKey = process.env[ENV.apiKey];
const model = process.env[ENV.defaultModel] ?? 'jev-latest';
const destination = `POST ${(process.env[ENV.baseURL] ?? 'https://api.typesafe.ai').replace(/\/+$/, '')}/v1/systemone`;
// The headers @typesafe-ai/sdk sends, as it builds them; the key's value is never stored.
const headers = {
  Authorization: 'Bearer <TYPESAFE_API_KEY, not stored>',
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': `typesafe-sdk/${VERSION}`,
  'X-TypeSafe-SDK': `typesafe-sdk/${VERSION}`,
  'X-TypeSafe-Runtime': `bun/${Bun.version} (${process.platform}; ${process.arch})`,
};
// The body exactly as the SDK builds it: the request, then the model.
const bodyOf = (unit: WordingUnit) => JSON.stringify({ state: unit.state, questions: questionsFor(unit), model });
// A state holds exactly one text field, and no credential or piece of the key.
const guardState = (state: Record<string, unknown>, field: string): string | undefined => {
  const keys = Object.keys(state).join(',');
  if (keys !== field) return `state-fields:${keys}`;
  return refuseState(state, apiKey);
};

const ledger = new Ledger();

if (values['dry-run']) {
  const repo = values['bank-repo'];
  if (!repo) throw new Error('a dry run needs --bank-repo <dir>');
  const git = (...args: string[]): string => {
    const run = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (run.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.toString().slice(0, 300)}`);
    return run.stdout.toString();
  };
  const lines = (text: string) => text.split('\n').filter((line) => line.trim() !== '');
  const stem = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.txt$/, '');

  // The only folder read. Not an option, on purpose.
  const dir = 'prompt_bank';
  const BANK_FILE = /^prompt_bank\/[^/]+\.txt$/;
  const before = git('rev-parse', '--short', values.before!).trim();
  const after = git('rev-parse', '--short', values.after!).trim();
  const files = lines(git('ls-tree', '--name-only', before, `${dir}/`)).filter((path) => path.endsWith('.txt'));
  const changed = new Set(lines(git('diff', '--name-only', before, after, '--', dir)).filter((path) => path.endsWith('.txt')));
  for (const path of [...files, ...changed]) if (!BANK_FILE.test(path)) throw new Error(`refusing a path outside ${dir}/: ${path}`);

  const payloads: PayloadInput[] = [];
  const unparsed: string[] = [];
  // One version of one bank file: a body per unit, each state checked to be a
  // verbatim slice of the file, and the file's commit, path and blob beside it.
  const read = (path: string, version: string, commit: string): number => {
    const text = git('show', `${commit}:${path}`);
    const source = { commit, path, blob: git('rev-parse', `${commit}:${path}`).trim() };
    const units = unitsFor(stem(path), version, text);
    for (const unit of units) {
      const sent = Object.values(unit.state)[0] as string;
      if (!text.includes(sent)) throw new Error(`a state is not a verbatim slice of ${path} at ${commit}`);
      const meta = { prompt_id: unit.prompt_id, version: unit.version, kind: unit.kind, shot: unit.shot ?? 'all', question_version: QUESTION_VERSION };
      payloads.push({ unit_key: `${unit.prompt_id}@${unit.version}#${unit.shot ?? 'description'}`, meta, source, body: bodyOf(unit), refused: guardState(unit.state, stateField(unit)) ?? null });
    }
    return units.length;
  };
  for (const path of files) {
    const found = changed.has(path) ? read(path, 'before', before) + read(path, 'after', after) : read(path, 'same', before);
    if (found === 0) unparsed.push(stem(path));
  }

  const run_id = ledger.startRun({
    experiment: EXPERIMENT,
    kind: 'dry-run',
    destination,
    headers,
    source: { bank_dir: dir, before, after, prompts: files.length, changed_by_fix: changed.size, prompt_versions: files.length + changed.size, no_main_field: unparsed },
    code_version: codeVersion(),
  });
  ledger.addPayloads(run_id, payloads);

  const refused = payloads.filter((p) => p.refused !== null);
  const bytes = payloads.map((p) => Buffer.byteLength(p.body)).sort((a, b) => a - b);
  const total = bytes.reduce((a, b) => a + b, 0);
  // Tokens are estimated at four bytes each; a response reports the real count.
  const tokens = Math.round(total / 4);
  console.log(`source: ${dir}/ only, at ${before} (before) and ${after} (after): ${files.length} prompts, ${changed.size} changed by the fix, ${files.length + changed.size} prompt versions`);
  console.log(`bodies: ${payloads.length} (${payloads.filter((p) => p.meta['kind'] === 'shot').length} shot, ${payloads.filter((p) => p.meta['kind'] === 'description').length} description), ${refused.length} refused; every state a verbatim slice of its file`);
  console.log(`bytes: min ${bytes[0] ?? 0}, median ${bytes[Math.floor(bytes.length / 2)] ?? 0}, max ${bytes.at(-1) ?? 0}, total ${total}; about ${tokens} input tokens, about $${((tokens * 0.042) / 1e6).toFixed(4)} at $0.042 per million`);
  console.log(`nothing sent. Stored as dry run ${run_id}`);
  console.log(`read it:    bun run payloads show latest   (or: bun run payloads html latest)`);
  console.log(`approve it: bun run payloads approve "${run_id}"`);
} else {
  if (values.egress !== 'bank') throw new Error('a send puts prompt bank text on the network: pass --egress bank');
  if (!apiKey) throw new Error('a send needs TYPESAFE_API_KEY (in .env at the repo root)');
  const from = values.send === 'latest' ? ledger.runs().filter((r) => r.kind === 'dry-run' && r.experiment === EXPERIMENT).at(-1)?.run_id : values.send;
  if (!from) throw new Error('no dry run to send from');
  const dry = ledger.run(from);
  if (!dry || dry.experiment !== EXPERIMENT) throw new Error(`${from} is not a dry run of ${EXPERIMENT}`);
  if (dry.destination !== destination) throw new Error(`the dry run was built for ${dry.destination}, and this send would go to ${destination}`);
  const approved = ledger.approvedPayloads(from);
  const done = ledger.alreadySent(from);
  const pending = approved.filter((p) => !done.has(p.seq));
  const batch = pending.slice(0, values.limit === undefined ? Infinity : Number(values.limit));

  const run_id = ledger.startRun({ experiment: EXPERIMENT, kind: 'send', destination, headers, source: dry.source, code_version: codeVersion(), from_run: from });
  const out = `runs/${EXPERIMENT}/${run_id.slice(EXPERIMENT.length + 1).replace(/[:.]/g, '-')}`;
  mkdirSync(out, { recursive: true });
  const client = new TypeSafeClient({ logLevel: 'off' });
  const usage = { sent: 0, errors: 0, refused: 0, inputTokens: 0, ms: 0, versions: new Set<string>() };

  for (const p of batch) {
    const request = JSON.parse(p.body) as { state: Record<string, unknown>; questions: unknown; model: string };
    // Refuse anything that is not exactly what was approved, or that now trips the guard.
    const again = JSON.stringify({ ...request, model: request.model });
    const refused = again !== p.body ? 'body-changed' : guardState(request.state, String(p.meta['kind']));
    if (refused) {
      usage.refused += 1;
      ledger.recordResponse(run_id, { seq: p.seq, body_sha256: p.body_sha256, status: `refused:${refused}`, model: null, ms: 0, input_tokens: null, response: null });
      continue;
    }
    const started = performance.now();
    try {
      const response = await client.systemOne({ state: request.state as unknown as EntryType, questions: request.questions as unknown as Questions, model: request.model });
      const ms = Math.round(performance.now() - started);
      usage.sent += 1;
      usage.ms += ms;
      usage.inputTokens += response.usage.input_tokens;
      usage.versions.add(response.model);
      ledger.recordResponse(run_id, { seq: p.seq, body_sha256: p.body_sha256, status: 'ok', model: response.model, ms, input_tokens: response.usage.input_tokens, response: response.answers });
      for (const [question_id, answer] of Object.entries(response.answers as unknown as Record<string, { noul?: number }>)) {
        appendFileSync(`${out}/answers.jsonl`, JSON.stringify({ seq: p.seq, key: p.unit_key, ...p.meta, question_id, noul: answer.noul ?? null, model: response.model }) + '\n');
      }
    } catch (error) {
      usage.errors += 1;
      const status = `error:${error instanceof Error ? error.constructor.name : 'unknown'}`;
      ledger.recordResponse(run_id, { seq: p.seq, body_sha256: p.body_sha256, status, model: null, ms: Math.round(performance.now() - started), input_tokens: null, response: null });
    }
  }
  const summary = { run_id, from_run: from, approved: approved.length, already_sent: done.size, this_send: batch.length, left: pending.length - batch.length, ...usage, versions: [...usage.versions], cost_usd: (usage.inputTokens * 0.042) / 1e6 };
  writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 1) + '\n');
  console.log(`send ${run_id} from ${from}: ${usage.sent} sent, ${usage.errors} errors, ${usage.refused} refused; ${summary.left} approved bodies left unsent`);
  console.log(`jev: ${usage.inputTokens} input tokens, about $${summary.cost_usd.toFixed(6)}; model ${summary.versions.join(', ') || 'none'}`);
  console.log(`wrote ${out}/`);
}
ledger.close();
