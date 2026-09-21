// The labeling page experiments/judge.ts serves on 127.0.0.1. Pure: a token
// in, a self-contained HTML string out.
//
// The page loads nothing from the network and holds no data of its own. It
// asks the local server for the next question and posts each answer back, so
// all of the logic (queue order, the held-out slice, which question comes
// next) lives in src/judge.ts, where it is tested. Text is placed with
// textContent, never parsed as markup. The page is blind: it never shows what
// a model or a rule answered, or why a unit was queued where it was.

import { scriptJson } from './payloadView.ts';

export function renderJudgePage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Judge</title>
<style>
:root { --bg: #fbfaf7; --fg: #1d1d1b; --muted: #6b6a66; --line: #e2e0da; --accent: #2f5d8a; --pick: #e8eef5; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecebe7; --muted: #9a9892; --line: #2c2b29; --accent: #8fb3d9; --pick: #1f2a36; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; justify-content: space-between; gap: 16px; color: var(--muted); font-size: 14px; border-bottom: 1px solid var(--line); padding-bottom: 10px; }
.label { color: var(--muted); font-size: 13px; margin: 20px 0 4px; }
.before { color: var(--muted); white-space: pre-wrap; max-height: 9em; overflow: auto; }
.reply { font-size: 18px; white-space: pre-wrap; }
.question { font-weight: 600; margin-top: 28px; }
ol { list-style: none; padding: 0; margin: 10px 0 0; }
li button { display: flex; gap: 12px; width: 100%; text-align: left; background: none; color: inherit; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin: 6px 0; font: inherit; cursor: pointer; }
li button:hover { background: var(--pick); }
kbd { font: 13px ui-monospace, monospace; border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; color: var(--accent); min-width: 1.6em; text-align: center; }
.desc { color: var(--muted); }
.unsure { color: var(--accent); font-size: 14px; min-height: 1.5em; margin-top: 8px; }
footer { margin-top: 28px; color: var(--muted); font-size: 13px; border-top: 1px solid var(--line); padding-top: 10px; }
.done { font-size: 18px; margin-top: 40px; }
</style>
</head>
<body>
<main>
<header><span id="progress"></span><span id="pace"></span></header>
<div id="item">
  <div class="label" id="before-label">The turn it answers</div>
  <div class="before" id="before"></div>
  <div class="label">The reply</div>
  <div class="reply" id="reply"></div>
  <div class="question" id="question"></div>
  <ol id="options"></ol>
  <div class="unsure" id="unsure"></div>
</div>
<div class="done" id="done" hidden></div>
<footer><kbd>1</kbd>-<kbd>9</kbd> answer · <kbd>u</kbd> unsure, then answer · <kbd>x</kbd> cannot tell · <kbd>n</kbd> later · <kbd>b</kbd> back to the last unit. The assistant's turn is not shown, as the model does not see it either.</footer>
</main>
<script>
const TOKEN = ${scriptJson(token)};
let current = null, shownAt = 0, unsure = false, busy = false;
const $ = (id) => document.getElementById(id);

async function call(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Judge-Token': TOKEN }, body: JSON.stringify(body) };
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function render(next) {
  current = next;
  const p = next.progress;
  $('progress').textContent = p.units + ' units: ' + p.unitsDone + ' done, ' + p.labels + ' labels this session';
  $('pace').textContent = p.medianSeconds === null ? '' : 'median ' + p.medianSeconds.toFixed(1) + ' s a label';
  $('done').hidden = !next.done;
  $('item').hidden = next.done;
  if (next.done) {
    $('done').textContent = 'Nothing left to ask. Labels are in ' + next.labelsFile + '.';
    return;
  }
  const before = next.unit.previous_prompt;
  $('before').textContent = before === null ? '(the turn was opened by something other than a typed prompt)' : before;
  $('reply').textContent = next.unit.reply + (next.unit.truncated ? '\\n[cut at the state limit]' : '');
  $('question').textContent = next.ask.text;
  const list = $('options');
  list.replaceChildren();
  next.ask.options.forEach(([label, description], i) => {
    const button = document.createElement('button');
    const key = document.createElement('kbd');
    key.textContent = String(i + 1);
    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = next.ask.type === 'score' ? 'level ' + label : label;
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = ' ' + description;
    text.append(name, desc);
    button.append(key, text);
    button.addEventListener('click', () => answer(i));
    const item = document.createElement('li');
    item.append(button);
    list.append(item);
  });
  unsure = false;
  $('unsure').textContent = '';
  shownAt = performance.now();
}

async function act(path, body) {
  if (busy) return;
  busy = true;
  try { render(await call(path, body)); } catch (error) { $('unsure').textContent = 'error: ' + error.message; } finally { busy = false; }
}

function answer(i) {
  const option = current && !current.done ? current.ask.options[i] : undefined;
  if (!option) return;
  act('/api/label', { index: current.index, question_id: current.ask.question_id, value: option[0], unsure, ms: Math.round(performance.now() - shownAt) });
}

document.addEventListener('keydown', (event) => {
  if (!current || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'b') return act('/api/back', {});
  if (current.done) return;
  if (event.key >= '1' && event.key <= '9') return answer(Number(event.key) - 1);
  if (event.key === 'u') { unsure = !unsure; $('unsure').textContent = unsure ? 'marked unsure: the next answer carries it' : ''; return; }
  if (event.key === 'x') return act('/api/cannot-tell', { index: current.index, question_id: current.ask.question_id });
  if (event.key === 'n') return act('/api/later', { index: current.index });
});

call('/api/next').then(render);
</script>
</body>
</html>
`;
}
