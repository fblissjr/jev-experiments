// A dry run's payloads as one self-contained local HTML page, for the owner to
// read before approving a send. Pure: rows in, a string out.
//
// The page loads nothing from the network. Every body is embedded as JSON and
// placed on the page with textContent, so text such as `<d>` or `<Subject 1>`
// is shown as written and never read as markup. The page is written under
// data/, which is gitignored, and is never published.

import type { Payload, Run } from './ledger.ts';

/** JSON that is safe inside a <script> element: no `<` survives to close it. */
export function scriptJson(value: unknown): string {
  const lineSeparator = String.fromCharCode(0x2028);
  const paragraphSeparator = String.fromCharCode(0x2029);
  return JSON.stringify(value).replace(/</g, '\\u003c').replaceAll(lineSeparator, '\\u2028').replaceAll(paragraphSeparator, '\\u2029');
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Split each body into its state and its other fields. Fields that are the
 * same in many bodies (a question set, the model id) are shown once, with how
 * many bodies carry them; the page then shows each body's state alone.
 */
export function sharedParts(payloads: readonly Payload[]): { field: string; value: unknown; bodies: number }[] {
  const counts = new Map<string, { field: string; value: unknown; bodies: number }>();
  for (const p of payloads) {
    let body: unknown;
    try {
      body = JSON.parse(p.body);
    } catch {
      continue;
    }
    if (typeof body !== 'object' || body === null) continue;
    for (const [field, value] of Object.entries(body)) {
      if (field === 'state') continue;
      const key = `${field}:${JSON.stringify(value)}`;
      const entry = counts.get(key) ?? { field, value, bodies: 0 };
      entry.bodies += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => a.field.localeCompare(b.field) || b.bodies - a.bodies);
}

export function renderRunHtml(run: Run, payloads: readonly Payload[]): string {
  const bytes = payloads.reduce((sum, p) => sum + p.bytes, 0);
  const data = {
    run: { ...run },
    totals: { payloads: payloads.length, refused: payloads.filter((p) => p.refused !== null).length, bytes },
    shared: sharedParts(payloads),
    payloads: payloads.map((p) => {
      let state: unknown = null;
      try {
        state = (JSON.parse(p.body) as { state?: unknown }).state ?? null;
      } catch {
        state = null;
      }
      return { seq: p.seq, unit_key: p.unit_key, meta: p.meta, source: p.source, bytes: p.bytes, refused: p.refused, body_sha256: p.body_sha256, state, body: p.body };
    }),
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payloads ${escapeHtml(run.run_id)}</title>
<style>
:root { --bg: #fbfbfa; --fg: #1d1d1b; --muted: #6b6a66; --line: #e2e1dc; --card: #ffffff; --accent: #2f5d8a; --warn: #9a3b1b; --chip: #efeee9; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #e8e7e3; --muted: #9b9a95; --line: #2e2d2a; --card: #1e1e1c; --accent: #8fb3d9; --warn: #e39a7c; --chip: #2a2a27; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 28px 0 8px; color: var(--muted); font-weight: 600; }
.sub { color: var(--muted); margin: 0 0 16px; overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin: 8px 0; }
.head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; margin-bottom: 8px; }
.key { font-weight: 600; overflow-wrap: anywhere; }
.chip { background: var(--chip); border-radius: 999px; padding: 0 8px; font-size: 12px; color: var(--muted); }
.refused { color: var(--warn); font-weight: 600; font-size: 12px; }
.src { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
details { margin-top: 8px; }
summary { cursor: pointer; color: var(--accent); font-size: 13px; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 4px; }
.filters input, .filters select { font: inherit; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); }
.filters input { flex: 1 1 220px; min-width: 0; }
#count { color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<main>
<h1>Payloads</h1>
<p class="sub" id="runid"></p>
<dl id="summary"></dl>
<h2>Sent with every matching body</h2>
<div id="shared"></div>
<h2>Bodies</h2>
<div class="filters" id="filters"><input id="q" type="search" placeholder="Search the text"></div>
<div id="count"></div>
<div id="list"></div>
</main>
<script type="application/json" id="data">${scriptJson(data)}</script>
<script>
const data = JSON.parse(document.getElementById('data').textContent);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const show = (v) => typeof v === 'string' ? v : JSON.stringify(v, null, 1);
document.getElementById('runid').textContent = data.run.run_id;
const summary = document.getElementById('summary');
const rows = [
  ['Experiment', data.run.experiment],
  ['Made', data.run.created_at],
  ['Approved', data.run.approved_at || 'not approved'],
  ['Code', data.run.code_version],
  ['Destination', data.run.destination],
  ['Headers', Object.entries(data.run.headers).map(([k, v]) => k + ': ' + v).join('\\n')],
  ['Source', JSON.stringify(data.run.source, null, 1)],
  ['Bodies', data.totals.payloads + ' (' + data.totals.refused + ' refused, never sent)'],
  ['Bytes', data.totals.bytes + ' in all bodies'],
];
for (const [k, v] of rows) { summary.append(el('dt', '', k)); const dd = el('dd'); dd.append(el('pre', '', v)); summary.append(dd); }
const shared = document.getElementById('shared');
for (const s of data.shared) {
  const card = el('div', 'card');
  const head = el('div', 'head');
  head.append(el('span', 'key', s.field), el('span', 'chip', 'in ' + s.bodies + ' of ' + data.totals.payloads + ' bodies'));
  card.append(head, el('pre', '', show(s.value)));
  shared.append(card);
}
const metaKeys = [...new Set(data.payloads.flatMap((p) => Object.keys(p.meta)))];
const filters = document.getElementById('filters');
const selects = {};
for (const k of metaKeys) {
  const values = [...new Set(data.payloads.map((p) => String(p.meta[k])))].sort();
  if (values.length < 2 || values.length > 200) continue;
  const s = el('select');
  s.append(new Option(k + ': all', ''));
  for (const v of values) s.append(new Option(k + ': ' + v, v));
  s.addEventListener('change', render);
  selects[k] = s;
  filters.append(s);
}
document.getElementById('q').addEventListener('input', render);
function render() {
  const q = document.getElementById('q').value.toLowerCase();
  const list = document.getElementById('list');
  list.replaceChildren();
  let n = 0;
  for (const p of data.payloads) {
    if (Object.entries(selects).some(([k, s]) => s.value !== '' && String(p.meta[k]) !== s.value)) continue;
    if (q && !p.body.toLowerCase().includes(q) && !p.unit_key.toLowerCase().includes(q)) continue;
    n += 1;
    if (n > 300) continue;
    const card = el('div', 'card');
    const head = el('div', 'head');
    head.append(el('span', 'key', '#' + p.seq + '  ' + p.unit_key), el('span', 'chip', p.bytes + ' bytes'));
    if (p.refused) head.append(el('span', 'refused', 'refused: ' + p.refused));
    card.append(head);
    if (p.source) card.append(el('div', 'src', Object.entries(p.source).map(([k, v]) => k + ' ' + v).join('   ')));
    card.append(el('pre', '', p.state === null ? p.body : show(p.state)));
    const d = el('details');
    d.append(el('summary', '', 'Exact body, as sent (sha256 ' + p.body_sha256.slice(0, 12) + ')'), el('pre', '', p.body));
    card.append(d);
    list.append(card);
  }
  document.getElementById('count').textContent = n + ' bodies' + (n > 300 ? ', first 300 shown; narrow the filters' : '');
}
render();
</script>
</body>
</html>
`;
}
