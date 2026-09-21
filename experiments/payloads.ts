// Read the egress ledger: what each run would send, or sent, byte for byte.
// See src/ledger.ts.
//
//   bun run payloads                          list the runs
//   bun run payloads show <run> [options]     print a run's bodies
//       --where key=value   keep bodies whose unit facts match (repeatable),
//                           e.g. --where version=before --where kind=shot
//       --grep TEXT         keep bodies whose text contains TEXT
//       --limit N           print at most N bodies (default 20)
//       --body              print each exact body, not just its state
//   bun run payloads html <run> [--out FILE]  write a local page to browse
//   bun run payloads approve <run>            the owner's approval of a dry run
//
//   bun run payloads import <experiment> --from FILE
//       a dry run from JSONL lines {unit_key, meta, body, source?}, each body
//       the exact Jev request, for example duckdb-jev's jev_request() output
//       written with COPY ... TO. It goes to TYPESAFE_BASE_URL (default
//       https://api.typesafe.ai) with plain JSON headers.
//   bun run payloads send <run> [--limit N]  send an approved dry run's bodies,
//       byte for byte as stored; needs TYPESAFE_API_KEY. Takes a run id, never
//       latest. Only for dry runs whose headers hold the key placeholder.
//   bun run payloads export <run> [--out FILE]
//       the answers as JSONL {seq, unit_key, meta, model, input_tokens,
//       response}, where response is the text {"model", "answers"} that
//       duckdb-jev's jev_answer() reads. A dry run exports every send from it.
//
// <run> is a run id from the list, or `latest` for the newest dry run.
// Approving is the owner's act: run it yourself, or tell the assistant to.

import { ENV } from '@typesafe-ai/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { codeVersion, Ledger, LEDGER_PATH, sha256, type Payload } from '../src/ledger.ts';
import { renderRunHtml, sharedParts } from '../src/payloadView.ts';
import { fetchPost, importLines, JEV_HEADERS, jevDestination, sendApproved } from '../src/send.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    where: { type: 'string', multiple: true },
    grep: { type: 'string' },
    limit: { type: 'string' },
    body: { type: 'boolean', default: false },
    out: { type: 'string' },
    from: { type: 'string' },
  },
});
const showLimit = Number(values.limit ?? 20);
const apiKey = process.env[ENV.apiKey];
const destination = jevDestination(process.env[ENV.baseURL] ?? 'https://api.typesafe.ai');
const [command = 'list', runArg] = positionals;
const ledger = new Ledger();

function resolveRun(arg: string | undefined): string {
  if (!arg) throw new Error('name a run: an id from `bun run payloads`, or latest');
  if (arg !== 'latest') return arg;
  const dry = ledger.runs().filter((r) => r.kind === 'dry-run');
  const last = dry.at(-1);
  if (!last) throw new Error('no dry runs in the ledger yet');
  return last.run_id;
}

function filtered(run_id: string): Payload[] {
  const where = (values.where ?? []).map((pair) => {
    const at = pair.indexOf('=');
    if (at < 1) throw new Error(`--where takes key=value, not ${pair}`);
    return [pair.slice(0, at), pair.slice(at + 1)] as const;
  });
  const grep = values.grep?.toLowerCase();
  return ledger
    .payloads(run_id)
    .filter((p) => where.every(([k, v]) => String(p.meta[k]) === v))
    .filter((p) => !grep || p.body.toLowerCase().includes(grep));
}

if (command === 'list') {
  const runs = ledger.runs();
  if (runs.length === 0) console.log(`no runs yet in ${LEDGER_PATH}`);
  for (const r of runs) {
    const status = r.kind === 'dry-run' ? (r.approved_at ? `approved ${r.approved_at}` : 'not approved') : `from ${r.from_run}: ${r.responses} sent, ${r.errors} errors`;
    console.log(`${r.run_id}  ${r.kind}  ${r.kind === 'dry-run' ? `${r.payloads} bodies, ${r.refused} refused, ${r.bytes} bytes` : ''}  ${status}`);
  }
} else if (command === 'show') {
  const run_id = resolveRun(runArg);
  const run = ledger.run(run_id);
  if (!run) throw new Error(`no run ${run_id}`);
  const all = ledger.payloads(run_id);
  const kept = filtered(run_id);
  console.log(`${run_id}: ${run.kind}, ${run.approved_at ? `approved ${run.approved_at}` : 'not approved'}`);
  console.log(`destination: ${run.destination}`);
  console.log(`headers: ${Object.entries(run.headers).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
  console.log(`source: ${JSON.stringify(run.source)}`);
  console.log(`bodies: ${all.length} in the run, ${kept.length} match\n`);
  if (!values.body) {
    console.log('Sent with the matching bodies (shown once here):');
    for (const s of sharedParts(kept)) console.log(`  ${s.field}, in ${s.bodies} of ${kept.length}:\n${JSON.stringify(s.value, null, 1).replace(/^/gm, '    ')}`);
    console.log('');
  }
  for (const p of kept.slice(0, showLimit)) {
    console.log(`--- #${p.seq} ${p.unit_key}  ${p.bytes} bytes${p.refused ? `  REFUSED: ${p.refused}` : ''}`);
    if (p.source) console.log(`    ${Object.entries(p.source).map(([k, v]) => `${k} ${v}`).join('   ')}`);
    if (values.body) console.log(p.body);
    else {
      const state = (JSON.parse(p.body) as { state?: unknown }).state;
      console.log(typeof state === 'object' && state !== null ? Object.entries(state).map(([k, v]) => `${k}:\n${v}`).join('\n') : p.body);
    }
    console.log('');
  }
  if (kept.length > showLimit) console.log(`${kept.length - showLimit} more; raise --limit, narrow with --where or --grep, or use html`);
} else if (command === 'html') {
  const run_id = resolveRun(runArg);
  const run = ledger.run(run_id);
  if (!run) throw new Error(`no run ${run_id}`);
  const out = values.out ?? new URL(`../data/views/${run_id.replace(/[^A-Za-z0-9._-]+/g, '_')}.html`, import.meta.url).pathname;
  mkdirSync(out.slice(0, out.lastIndexOf('/')), { recursive: true });
  writeFileSync(out, renderRunHtml(run, ledger.payloads(run_id)));
  console.log(`wrote ${out}\nopen it with: open "${out}"`);
} else if (command === 'approve') {
  const run_id = resolveRun(runArg);
  const run = ledger.run(run_id);
  if (!run) throw new Error(`no run ${run_id}`);
  const payloads = ledger.payloads(run_id);
  ledger.approve(run_id);
  const refused = payloads.filter((p) => p.refused !== null).length;
  console.log(`approved ${run_id}: ${payloads.length - refused} bodies may be sent to ${run.destination} (${refused} refused bodies never will)`);
} else if (command === 'import') {
  const experiment = runArg;
  if (!experiment || !values.from) throw new Error('usage: bun run payloads import <experiment> --from FILE');
  const text = readFileSync(values.from, 'utf8');
  const payloads = importLines(text, apiKey);
  if (payloads.length === 0) throw new Error(`${values.from} holds no bodies`);
  const run_id = ledger.startRun({
    experiment,
    kind: 'dry-run',
    destination,
    headers: { ...JEV_HEADERS },
    source: { imported_from: values.from, file_sha256: sha256(text), bodies: payloads.length },
    code_version: codeVersion(),
  });
  ledger.addPayloads(run_id, payloads);
  const refused = payloads.filter((p) => p.refused !== null).length;
  console.log(`dry run ${run_id}: ${payloads.length} bodies for ${destination}, ${refused} refused${apiKey ? '' : ' (no key loaded, so the key check runs again at send)'}`);
  console.log(`read it:    bun run payloads show "${run_id}"   (or: bun run payloads html "${run_id}")`);
  console.log(`approve it: bun run payloads approve "${run_id}"`);
} else if (command === 'send') {
  if (!runArg || runArg === 'latest') throw new Error('name the approved dry run to send by its id; a send never guesses');
  if (!apiKey) throw new Error(`a send needs ${ENV.apiKey} (in .env at the repo root)`);
  const summary = await sendApproved(ledger, runArg, {
    apiKey,
    destination,
    code_version: codeVersion(),
    post: fetchPost,
    ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
  });
  console.log(`send ${summary.run_id} from ${summary.from_run}: ${summary.ok} ok, ${summary.errors} errors, ${summary.refused} refused; ${summary.left} approved bodies left unsent`);
  console.log(`jev: ${summary.inputTokens} input tokens; model ${summary.models.join(', ') || 'none'}`);
  console.log(`export: bun run payloads export "${summary.from_run}"`);
} else if (command === 'export') {
  const run_id = resolveRun(runArg);
  const run = ledger.run(run_id);
  if (!run) throw new Error(`no run ${run_id}`);
  const rows = ledger.answered(run_id);
  const out = values.out ?? `runs/${run.experiment}/${run_id.slice(run.experiment.length + 1).replace(/[:.]/g, '-')}/responses.jsonl`;
  mkdirSync(out.slice(0, out.lastIndexOf('/')), { recursive: true });
  const lines = rows.map((r) => JSON.stringify({ seq: r.seq, unit_key: r.unit_key, meta: r.meta, model: r.model, input_tokens: r.input_tokens, response: JSON.stringify({ model: r.model, answers: r.answers }) }));
  writeFileSync(out, lines.length > 0 ? lines.join('\n') + '\n' : '');
  console.log(`wrote ${rows.length} answered bodies of ${run_id} to ${out}`);
} else {
  console.error(`unknown command ${command}: list, show, html, approve, import, send or export`);
  process.exit(2);
}
ledger.close();
