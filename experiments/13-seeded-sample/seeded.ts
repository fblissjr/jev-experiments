// Experiment 13: a small agent-seeded sample, to see how Jev behaves on data
// with no human grounding. See README.md beside this file.
//
//   bun run seeded build                 units, the agent's key, the keyword rule's
//                                        labels, and a ledger dry run of the Jev bodies
//   bun run seeded report --dir DIR      after the owner approves and sends: Jev against
//                                        the agent's key, the rule, and any owner labels
//
// build sends nothing. The Jev bodies go into the egress ledger as a dry run;
// the owner reads them (bun run payloads show), approves them, and sends them
// (bun run payloads send <run>). report reads the answers back from the ledger.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { toBranches, type BranchRow } from '../../src/branches.ts';
import type { Unit } from '../../src/exchanges.ts';
import { latestLabels, type HumanLabelRow, type JudgeUnit } from '../../src/judge.ts';
import { answerFrom, jevQuestions } from '../../src/jevLabeler.ts';
import { KEYWORD_LABELER } from '../../src/keyword.ts';
import { asksFor, labelUnit, stateOf, type Answer, type Labeler, type LabelRow } from '../../src/labels.ts';
import { codeVersion, Ledger } from '../../src/ledger.ts';
import { score } from '../../src/scoring.ts';
import { JEV_HEADERS, jevDestination, parseBody, refuseBody } from '../../src/send.ts';

const EXPERIMENT = '13-seeded-sample';
const SOURCE = 'seeded-sample';
const SEEDS = `experiments/${EXPERIMENT}/seeds.jsonl`;

interface SeedItem {
  item_id: string;
  seed_id: string;
  permutation: 'seed' | 'paraphrase' | 'tone' | 'context' | 'edge' | 'flip';
  origin: 'model';
  author: string;
  previous_prompt: string;
  reply: string;
  key: { user_response: string; correction_kind?: string; frustration: number };
  /** The agent's own doubt about its key. */
  unsure: boolean;
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: 'string' } } });
const [command] = positionals;

const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as T)
    : [];
const writeJsonl = (path: string, rows: readonly unknown[]) => writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const seedsText = readFileSync(SEEDS, 'utf8');
const items = readJsonl<SeedItem>(SEEDS);
const unitOf = (item: SeedItem): Unit => ({
  unit_type: 'exchange', native_session_id: SOURCE, project_name: null, user_entry_uuid: item.item_id, assistant_entry_uuid: null,
  previous_prompt_uuid: null, previous_prompt: item.previous_prompt, reply: item.reply, timestamp: null, copies: 1,
});

/** The agent's key as label rows. A model wrote it, so its origin is model, whatever role it plays (VISION.md). */
function keyLabeler(item: SeedItem): Labeler {
  return {
    kind: 'model',
    name: 'agent-key',
    async label(_state, asks) {
      const answers = new Map<string, Answer>();
      for (const { question } of asks) {
        const value = (item.key as Record<string, string | number | undefined>)[question.question_id];
        if (value !== undefined) answers.set(question.question_id, { value });
      }
      return { version: item.author, answers };
    },
  };
}

async function rowsFor(labeler: (item: SeedItem) => Labeler): Promise<LabelRow[]> {
  const rows: LabelRow[] = [];
  for (const item of items) rows.push(...(await labelUnit(unitOf(item), labeler(item), SOURCE, undefined, () => 'build')).rows);
  return rows;
}

const short = (value: string | number | undefined) => (value === undefined ? '-' : String(value));

if (command === 'build') {
  const dir = `runs/${EXPERIMENT}/${new Date().toISOString().replace(/[:.]/g, '-')}`;
  mkdirSync(dir, { recursive: true });
  const units: JudgeUnit[] = items.map((item) => ({ source: SOURCE, native_session_id: SOURCE, user_entry_uuid: item.item_id, assistant_entry_uuid: null, copies: 1, previous_prompt: item.previous_prompt, reply: item.reply }));
  const agentKey = await rowsFor(keyLabeler);
  const keyword = await rowsFor(() => KEYWORD_LABELER);
  writeJsonl(`${dir}/units.jsonl`, units);
  writeJsonl(`${dir}/agent-key.jsonl`, agentKey);
  writeJsonl(`${dir}/keyword.jsonl`, keyword);
  writeJsonl(`${dir}/branches.jsonl`, toBranches([...agentKey, ...keyword]));

  // The exact bodies, as the SDK would build them, into a ledger dry run for the owner to read.
  const apiKey = process.env['TYPESAFE_API_KEY'];
  const model = process.env['TYPESAFE_DEFAULT_MODEL'] ?? 'jev-latest';
  const destination = jevDestination(process.env['TYPESAFE_BASE_URL'] ?? 'https://api.typesafe.ai');
  const payloads = items.map((item) => {
    const unit = unitOf(item);
    const body = JSON.stringify({ state: stateOf(unit).state, questions: jevQuestions(asksFor(unit, undefined)), model });
    return { unit_key: item.item_id, meta: { item_id: item.item_id, seed_id: item.seed_id, permutation: item.permutation, question_version: 'v1' }, body, refused: refuseBody(parseBody(body), apiKey) ?? null };
  });
  const ledger = new Ledger();
  const run = ledger.startRun({
    experiment: EXPERIMENT,
    kind: 'dry-run',
    destination,
    headers: { ...JEV_HEADERS },
    source: { seeds: SEEDS, seeds_sha256: createHash('sha256').update(seedsText, 'utf8').digest('hex'), items: items.length, author: items[0]?.author, origin: 'model' },
    code_version: codeVersion(),
  });
  ledger.addPayloads(run, payloads);
  ledger.close();
  writeFileSync(`${dir}/run.json`, JSON.stringify({ dry_run: run }, null, 1) + '\n');

  const refused = payloads.filter((p) => p.refused !== null).length;
  console.log(`${items.length} agent-written items from ${new Set(items.map((i) => i.seed_id)).size} seeds; wrote ${dir}/`);
  console.log(`keyword rule against the agent's key (rehearsal: a model wrote the key):`);
  for (const s of score(keyword, agentKey)) console.log(`  ${s.question_id}: ${s.agree} of ${s.compared}`);
  console.log(`\nledger dry run ${run}: ${payloads.length} bodies for ${destination}, ${refused} refused. Nothing is sent until the owner approves:`);
  console.log(`  read it:     bun run payloads show "${run}" --limit 30     (or: bun run payloads html "${run}")`);
  console.log(`  approve it:  bun run payloads approve "${run}"`);
  console.log(`  send it:     bun run payloads send "${run}"`);
  console.log(`  then:        bun run seeded report --dir ${dir}`);
  console.log(`label them yourself, blind, any time: bun run judge --units ${dir}/units.jsonl --branches ${dir}/branches.jsonl --open`);
} else if (command === 'report') {
  const dir = values.dir;
  if (!dir) throw new Error('usage: bun run seeded report --dir runs/13-seeded-sample/<time>');
  const { dry_run } = JSON.parse(readFileSync(`${dir}/run.json`, 'utf8')) as { dry_run: string };
  const agentKey = readJsonl<LabelRow>(`${dir}/agent-key.jsonl`);
  const keyword = readJsonl<LabelRow>(`${dir}/keyword.jsonl`);
  const owner = latestLabels(readJsonl<HumanLabelRow>(new URL('../../data/labels/owner.jsonl', import.meta.url).pathname).filter((r) => r.source === SOURCE));

  const ledger = new Ledger();
  const answered = ledger.answered(dry_run);
  ledger.close();
  const byItem = new Map(answered.map((a) => [String(a.meta['item_id']), a]));
  const jev: LabelRow[] = [];
  for (const item of items) {
    const a = byItem.get(item.item_id);
    if (!a) continue;
    const unit = unitOf(item);
    const answers = new Map(asksFor(unit, undefined).map((ask) => [ask.question.question_id, answerFrom(ask, (a.answers as Record<string, unknown>)[ask.question.question_id])]));
    jev.push(...(await labelUnit(unit, { kind: 'model', name: 'jev', label: async () => ({ version: a.model ?? 'unknown', answers }) }, SOURCE, undefined, () => 'report')).rows);
  }
  if (jev.length > 0) writeJsonl(`${dir}/jev.jsonl`, jev);
  const branches: BranchRow[] = toBranches([...agentKey, ...keyword, ...jev]);
  writeJsonl(`${dir}/branches.jsonl`, branches);

  if (jev.length === 0) console.log(`no Jev answers yet for ${dry_run}: approve and send it, then run this again. The rest still reports.\n`);
  const rowOf = (rows: LabelRow[], item: string, q: string) => rows.find((r) => r.user_entry_uuid === item && r.question_id === q);
  const jevCell = (item: string, q: string) => {
    const r = rowOf(jev, item, q);
    if (!r || !r.probabilities) return '-';
    const [, second] = Object.entries(r.probabilities).sort((x, y) => y[1] - x[1]);
    return `${r.value} ${r.probability!.toFixed(2)}${second ? ` (next ${second[0]} ${second[1].toFixed(2)})` : ''}`;
  };
  for (const q of ['user_response', 'correction_kind', 'frustration']) {
    console.log(`\n${q}: item, permutation, agent key, keyword${owner.length ? ', owner' : ''}, jev`);
    for (const item of items) {
      const agent = rowOf(agentKey, item.item_id, q);
      if (q === 'correction_kind' && !agent) continue;
      const cells = [short(agent?.value) + (item.unsure ? '?' : ''), short(rowOf(keyword, item.item_id, q)?.value), ...(owner.length ? [short(rowOf(owner, item.item_id, q)?.value)] : []), jevCell(item.item_id, q)];
      console.log(`  ${item.item_id.padEnd(15)} ${item.permutation.padEnd(10)} ${cells.map((c) => c.padEnd(16)).join(' ')}`);
    }
  }

  console.log(`\nagreement with the agent's key (rehearsal: a model wrote it; ? above marks items the agent was unsure of):`);
  for (const s of score([...keyword, ...jev], agentKey)) console.log(`  ${s.question_id} / ${s.labeler}: ${s.agree} of ${s.compared}`);
  if (owner.length > 0) {
    console.log(`\nagreement with the owner's labels, on the ${new Set(owner.map((r) => r.user_entry_uuid)).size} items the owner labeled:`);
    for (const s of score([...agentKey, ...keyword, ...jev], owner)) console.log(`  ${s.question_id} / ${s.labeler}: ${s.agree} of ${s.compared}`);
  } else {
    console.log(`\nno owner labels on this sample yet; label it with bun run judge --units ${dir}/units.jsonl --branches ${dir}/branches.jsonl --open`);
  }

  if (jev.length > 0) {
    // Checks that need no ground truth: does Jev keep its answer when the judgment is kept, and change it when it is flipped?
    console.log(`\nstability of Jev's user_response, which needs no ground truth:`);
    for (const seed of new Set(items.map((i) => i.seed_id))) {
      const family = items.filter((i) => i.seed_id === seed);
      const seedItem = family.find((i) => i.permutation === 'seed')!;
      const at = (i: SeedItem) => short(rowOf(jev, i.item_id, 'user_response')?.value);
      const kept = family.filter((i) => i !== seedItem && i.key.user_response === seedItem.key.user_response);
      const flipped = family.filter((i) => i.key.user_response !== seedItem.key.user_response);
      const keptSame = kept.filter((i) => at(i) === at(seedItem)).length;
      const flipsMoved = flipped.filter((i) => at(i) !== at(seedItem)).length;
      console.log(`  ${seed}: seed ${at(seedItem)}; same judgment kept ${keptSame} of ${kept.length}; flipped judgment moved ${flipsMoved} of ${flipped.length}`);
    }
  }
} else {
  console.error('usage: bun run seeded build | bun run seeded report --dir DIR');
  process.exit(2);
}
