// Experiment 10: ask Jev about wording defects in H3 prompts, before and
// after the fix commit. See README.md beside this file.
//
//   bun run wording --bank-repo <dir> --dry-run
//
//   --bank-repo DIR     the prompt bank repo (read with git show; never modified)
//   --before REV        the defective versions (default 4bd7b429^)
//   --after REV         the fixed versions (default 4bd7b429)
//   --dry-run           build and check every request, write examples, send nothing
//   --egress bank       allow sending to TypeSafe; the owner reads a dry run first
//   --limit N           send only the first N requests (a smoke run)
//   --out DIR           default runs/10-prompt-wording/<time>/
//
// Reads only `prompt_bank/*.txt` in that repo, at the two commits. There is no
// option to read anything else, and a path outside that folder stops the run:
// the owner's rule is that no prompt from any other folder, such as
// internal/internal_prompt_bank, is ever used here.
//
// Writes units.jsonl (keys and character counts, no text) and sources.jsonl
// (the commit, path and blob of every text read). A dry run also
// writes dry-run.jsonl (hash, bytes, refusal per request), questions.json and
// examples/ (complete request bodies, bank text included; runs/ is gitignored).
// A send writes answers.jsonl and sent.jsonl (hash, bytes, status, model, time
// per request; never the key, a header or the body).

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { TypeSafeClient, type EntryType, type Questions } from '@typesafe-ai/sdk';
import { refuseState } from '../../src/egress.ts';
import { DESCRIPTION_QUESTIONS, QUESTION_VERSION, SHOT_QUESTIONS, questionsFor, stateField, unitsFor, type WordingUnit } from '../../src/wordingQuestions.ts';

const { values } = parseArgs({
  options: {
    'bank-repo': { type: 'string' },
    before: { type: 'string', default: '4bd7b429^' },
    after: { type: 'string', default: '4bd7b429' },
    'dry-run': { type: 'boolean', default: false },
    egress: { type: 'string' },
    limit: { type: 'string' },
    out: { type: 'string' },
  },
});
const repo = values['bank-repo'];
if (!repo) {
  console.error('usage: bun run wording --bank-repo <dir> [--dry-run | --egress bank] [--before REV] [--after REV] [--out DIR]');
  process.exit(2);
}
// The only folder read. Not an option, on purpose.
const dir = 'prompt_bank';
const BANK_FILE = /^prompt_bank\/[^/]+\.txt$/;

function git(...args: string[]): string {
  const run = Bun.spawnSync(['git', '-C', repo!, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.toString().slice(0, 300)}`);
  return run.stdout.toString();
}
const lines = (text: string) => text.split('\n').filter((line) => line.trim() !== '');
const stem = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.txt$/, '');

const before = git('rev-parse', '--short', values.before!).trim();
const after = git('rev-parse', '--short', values.after!).trim();
const files = lines(git('ls-tree', '--name-only', before, `${dir}/`)).filter((path) => path.endsWith('.txt'));
const changed = new Set(lines(git('diff', '--name-only', before, after, '--', dir)).filter((path) => path.endsWith('.txt')));
for (const path of [...files, ...changed]) if (!BANK_FILE.test(path)) throw new Error(`refusing a path outside ${dir}/: ${path}`);

const units: WordingUnit[] = [];
const unparsed: string[] = [];
const sources: { prompt_id: string; version: string; commit: string; path: string; blob: string }[] = [];
// One version of one bank file: its units, each state checked to be a verbatim
// slice of the file, and its source recorded.
function read(path: string, version: string, commit: string): WordingUnit[] {
  const text = git('show', `${commit}:${path}`);
  const found = unitsFor(stem(path), version, text);
  for (const unit of found) {
    const sent = Object.values(unit.state)[0] as string;
    if (!text.includes(sent)) throw new Error(`a state is not a verbatim slice of ${path} at ${commit}`);
  }
  sources.push({ prompt_id: stem(path), version, commit, path, blob: git('rev-parse', `${commit}:${path}`).trim() });
  return found;
}
for (const path of files) {
  const found = changed.has(path) ? [...read(path, 'before', before), ...read(path, 'after', after)] : read(path, 'same', before);
  if (found.length === 0) unparsed.push(stem(path));
  units.push(...found);
}

const now = new Date().toISOString();
const out = values.out ?? `runs/10-prompt-wording/${now.replace(/[:.]/g, '-')}`;
mkdirSync(out, { recursive: true });
const jsonl = (items: unknown[]) => items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
const unitKey = (unit: WordingUnit) => `${unit.prompt_id}@${unit.version}#${unit.shot ?? 'description'}`;
writeFileSync(`${out}/sources.jsonl`, jsonl(sources));
writeFileSync(
  `${out}/units.jsonl`,
  jsonl(units.map((unit) => ({ key: unitKey(unit), prompt_id: unit.prompt_id, version: unit.version, kind: unit.kind, shot: unit.shot, chars: JSON.stringify(unit.state).length }))),
);

const apiKey = process.env['TYPESAFE_API_KEY'];
const model = process.env['TYPESAFE_DEFAULT_MODEL'] ?? 'jev-latest';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
// The body exactly as @typesafe-ai/sdk 0.6.0 builds it: the request, then the model.
const bodyOf = (unit: WordingUnit) => JSON.stringify({ state: unit.state, questions: questionsFor(unit), model });
// A state holds exactly its unit's one field, and no credential or piece of the key.
const guard = (unit: WordingUnit): string | undefined => {
  const keys = Object.keys(unit.state).join(',');
  if (keys !== stateField(unit)) return `state-fields:${keys}`;
  return refuseState(unit.state, apiKey);
};

const count = (kind: string, version?: string) => units.filter((unit) => unit.kind === kind && (version === undefined || unit.version === version)).length;
console.log(`source: ${dir}/ only, at ${before} (before) and ${after} (after): ${files.length} prompts, ${changed.size} changed by the fix, ${unparsed.length} with no main field`);
console.log(`files read: ${sources.length}, all under ${dir}/: ${sources.every((s) => BANK_FILE.test(s.path))}; every state a verbatim slice of its file`);
console.log(`units: shot ${count('shot')}, description ${count('description')}; versions: same ${new Set(units.filter((u) => u.version === 'same').map((u) => u.prompt_id)).size}, before ${new Set(units.filter((u) => u.version === 'before').map((u) => u.prompt_id)).size}, after ${new Set(units.filter((u) => u.version === 'after').map((u) => u.prompt_id)).size}`);

if (values['dry-run']) {
  const plan = units.map((unit) => {
    const body = bodyOf(unit);
    return { key: unitKey(unit), body_sha256: sha256(body), bytes: Buffer.byteLength(body), state_bytes: Buffer.byteLength(JSON.stringify(unit.state)), refused: guard(unit) ?? null };
  });
  writeFileSync(`${out}/dry-run.jsonl`, jsonl(plan));
  writeFileSync(`${out}/questions.json`, JSON.stringify({ question_version: QUESTION_VERSION, shot: SHOT_QUESTIONS, description: DESCRIPTION_QUESTIONS }, null, 1) + '\n');

  // One complete body per kind of example: a fixed prompt's shot before the
  // fix, an untouched prompt's shot, and a fixed prompt's whole description.
  mkdirSync(`${out}/examples`, { recursive: true });
  const examples = [
    units.find((unit) => unit.version === 'before' && unit.kind === 'shot'),
    units.find((unit) => unit.version === 'same' && unit.kind === 'shot'),
    units.find((unit) => unit.version === 'before' && unit.kind === 'description'),
  ].filter((unit): unit is WordingUnit => unit !== undefined);
  for (const [i, unit] of examples.entries()) {
    writeFileSync(`${out}/examples/${i + 1}-${unit.kind}-${unit.version}.json`, JSON.stringify(JSON.parse(bodyOf(unit)), null, 1) + '\n');
  }

  const refused = plan.filter((p) => p.refused);
  const bytes = plan.map((p) => p.bytes).sort((a, b) => a - b);
  const total = bytes.reduce((a, b) => a + b, 0);
  const stateTotal = plan.reduce((a, p) => a + p.state_bytes, 0);
  // Tokens are estimated at four bytes each; the response reports the real count.
  const tokens = Math.round(total / 4);
  console.log(`dry run: ${plan.length} requests would be built, ${refused.length} refused (${[...new Set(refused.map((p) => p.refused))].join(', ') || 'none'})`);
  console.log(`request bytes: min ${bytes[0] ?? 0}, median ${bytes[Math.floor(bytes.length / 2)] ?? 0}, max ${bytes.at(-1) ?? 0}, total ${total} (bank text ${stateTotal}, question text and model id the rest)`);
  console.log(`estimate: about ${tokens} input tokens, about $${((tokens * 0.042) / 1e6).toFixed(4)} at $0.042 per million; nothing sent`);
  console.log(`each request: POST https://api.typesafe.ai/v1/systemone, body { state, questions, model: "${model}" }`);
  console.log(`headers: Authorization (the key), Accept, Content-Type, User-Agent and X-TypeSafe-SDK "typesafe-sdk/0.6.0", X-TypeSafe-Runtime "bun/${Bun.version} (${process.platform}; ${process.arch})"`);
  console.log(`wrote ${out}/ (dry-run.jsonl, questions.json, examples/${examples.length} bodies)`);
  process.exit(0);
}

if (values.egress !== 'bank') throw new Error('this sends prompt bank text to TypeSafe: pass --egress bank, after the owner has read a dry run');
if (!apiKey) throw new Error('needs TYPESAFE_API_KEY (in .env at the repo root)');
const client = new TypeSafeClient({ logLevel: 'off' });
const limit = values.limit === undefined ? Infinity : Number(values.limit);
const usage = { requests: 0, errors: 0, refused: 0, inputTokens: 0, ms: 0, versions: new Set<string>() };
for (const unit of units.slice(0, limit)) {
  const refused = guard(unit);
  if (refused) {
    usage.refused += 1;
    appendFileSync(`${out}/answers.jsonl`, JSON.stringify({ key: unitKey(unit), fallback: `refused:${refused}` }) + '\n');
    continue;
  }
  const body = bodyOf(unit);
  const entry = { key: unitKey(unit), body_sha256: sha256(body), bytes: Buffer.byteLength(body), status: 'ok', model: null as string | null, ms: 0, input_tokens: 0 };
  const started = performance.now();
  try {
    const response = await client.systemOne({ state: unit.state as unknown as EntryType, questions: questionsFor(unit) as unknown as Questions, model });
    entry.model = response.model;
    entry.input_tokens = response.usage.input_tokens;
    usage.inputTokens += response.usage.input_tokens;
    usage.versions.add(response.model);
    for (const [question_id, answer] of Object.entries(response.answers as unknown as Record<string, { noul?: number }>)) {
      const row = { key: unitKey(unit), prompt_id: unit.prompt_id, version: unit.version, kind: unit.kind, shot: unit.shot, question_id, question_version: QUESTION_VERSION, noul: answer.noul ?? null, model: response.model };
      appendFileSync(`${out}/answers.jsonl`, JSON.stringify(row) + '\n');
    }
  } catch (error) {
    entry.status = `error:${error instanceof Error ? error.constructor.name : 'unknown'}`;
    usage.errors += 1;
  } finally {
    entry.ms = Math.round(performance.now() - started);
    usage.ms += entry.ms;
    usage.requests += 1;
    appendFileSync(`${out}/sent.jsonl`, JSON.stringify(entry) + '\n');
  }
}
const summary = { experiment: '10-prompt-wording', before, after, prompts: files.length, changed: changed.size, units: units.length, ...usage, versions: [...usage.versions], cost_usd: (usage.inputTokens * 0.042) / 1e6 };
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 1) + '\n');
console.log(`jev: ${usage.requests} requests, ${usage.errors} errors, ${usage.refused} refused, ${usage.inputTokens} input tokens, about $${summary.cost_usd.toFixed(6)}; model ${summary.versions.join(', ') || 'none'}`);
console.log(`wrote ${out}/`);
