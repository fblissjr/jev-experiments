// Experiment 10's answer key, derived from the fix commit before any answer
// from Jev exists. See README.md beside this file.
//
//   bun run wording-key --bank-repo <dir> [--before REV] [--after REV] [--out FILE]
//
// For each prompt the fix commit changed, it finds which shots changed, and
// what kind of defect each change removed, from the clause that changed. A
// change can remove more than one. What the rules do not recognise is assigned
// by hand in REVIEWED, with its reason, and anything left over is printed as
// UNCLASSIFIED for review rather than guessed at.
//
// The key names prompts of a private repo, so it is written under internal/,
// which is gitignored, and never committed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parsePrompt } from '../../src/h3Prompt.ts';

const { values } = parseArgs({
  options: {
    'bank-repo': { type: 'string' },
    before: { type: 'string' },
    after: { type: 'string' },
    out: { type: 'string' },
  },
});
const repo = values['bank-repo'];
if (!repo) {
  console.error('usage: bun run wording-key --bank-repo <dir> [--before REV] [--after REV] [--out FILE]');
  process.exit(2);
}
const git = (...args: string[]): string => {
  const run = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.toString().slice(0, 300)}`);
  return run.stdout.toString();
};
const BANK_FILE = /^prompt_bank\/[^/]+\.txt$/;
const before = git('rev-parse', '--short', values.before ?? '4bd7b429^').trim();
const after = git('rev-parse', '--short', values.after ?? '4bd7b429').trim();
const changed = git('diff', '--name-only', before, after, '--', 'prompt_bank')
  .split('\n')
  .filter((path) => path.endsWith('.txt'));
for (const path of changed) if (!BANK_FILE.test(path)) throw new Error(`refusing a path outside prompt_bank/: ${path}`);

/** The words one text has and the other does not, in order. */
function wordDiff(from: string, to: string): { removed: string; added: string } {
  const a = from.split(/\s+/);
  const b = to.split(/\s+/);
  // Longest common subsequence over words: small texts, so the table is fine.
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      removed.push(a[i]!);
      i += 1;
    } else {
      added.push(b[j]!);
      j += 1;
    }
  }
  removed.push(...a.slice(i));
  added.push(...b.slice(j));
  return { removed: removed.join(' '), added: added.join(' ') };
}

/**
 * What a change removed, from the words it changed. A change can remove more
 * than one defect, so every rule is tested and all that match are recorded.
 */
export function classify(removed: string, added: string): string[] {
  const r = removed.toLowerCase();
  const a = added.toLowerCase();
  const classes: string[] = [];
  if (/produces? no vocal sound/.test(r) && /does not answer|stays silent/.test(a)) classes.push('silence_then_speech');
  if (/no vocal sound/.test(a) && !/vocal sound/.test(r)) classes.push('missing_silence_marker');
  if (/baritone|tenor/.test(r) && /contralto|mezzo|alto|soprano/.test(a)) classes.push('wrong_register');
  if (/\(s\d+(,\s*s\d+)*\)/.test(a) && !/\(s\d+/.test(r)) classes.push('missing_speaker_id');
  if (/\b(both|second|two|three|pair|row|each)\b/.test(a) || /\b(both|crates|row)\b/.test(r)) classes.push('contradicted_count');
  if (/\b(unseen hand|hand inside)\b/.test(a) || /^(a|an)$/.test(r.trim())) classes.push('agentless_action');
  if (/\b(at|behind|across|beside|on (his|her)|to (his|her)|opposite|seated|kneeling|crouched|standing)\b/.test(a)) classes.push('unplaced_person');
  return classes;
}

/**
 * Changes the rules above do not recognise, read and assigned by hand, with
 * the reason. Recorded here so the key says how every row was decided.
 */
const REVIEWED: Record<string, { classes: string[]; why: string }> = {
  't2va_cyber_hacker_den#3': {
    classes: ['agentless_action'],
    why: 'a person was inserted before a verb that already had none, so the breaker no longer throws itself',
  },
};

interface KeyRow {
  prompt_id: string;
  shot: number | null;
  classes: string[];
  assigned_by: 'rule' | 'reviewed';
  why?: string;
  removed: string;
  added: string;
}

const rows: KeyRow[] = [];
for (const path of changed) {
  const id = path.slice(path.lastIndexOf('/') + 1).replace(/\.txt$/, '');
  const from = parsePrompt(git('show', `${before}:${path}`));
  const to = parsePrompt(git('show', `${after}:${path}`));
  if (!from || !to) throw new Error(`${id} has no main field`);
  if (from.shots.length !== to.shots.length) throw new Error(`${id} changed its shot count; the key cannot pair its shots`);
  from.shots.forEach((text, i) => {
    const fixed = to.shots[i]!;
    if (text === fixed) return;
    const { removed, added } = wordDiff(text, fixed);
    const reviewed = REVIEWED[`${id}#${i + 1}`];
    const classes = classify(removed, added);
    rows.push(
      reviewed && classes.length === 0
        ? { prompt_id: id, shot: i + 1, classes: reviewed.classes, assigned_by: 'reviewed', why: reviewed.why, removed, added }
        : { prompt_id: id, shot: i + 1, classes, assigned_by: 'rule', removed, added },
    );
  });
}

// A description unit carries a prompt's count question, so a count fixed in
// any shot is also a defect of that prompt's whole description.
for (const row of rows.filter((r) => r.classes.includes('contradicted_count'))) {
  rows.push({ prompt_id: row.prompt_id, shot: null, classes: ['contradicted_count'], assigned_by: row.assigned_by, removed: row.removed, added: row.added });
}

const key = {
  built_at: new Date().toISOString(),
  before,
  after,
  note: 'Positives: the before version of these units. The after version of the same unit is the negative of the pair. Prompts the fix commit did not touch are weak negatives: a subagent sweep passed them, nothing else did.',
  rows: rows.sort((a, b) => a.prompt_id.localeCompare(b.prompt_id) || (a.shot ?? 99) - (b.shot ?? 99)),
};
const out = values.out ?? new URL('../../internal/10-prompt-wording-key.json', import.meta.url).pathname;
mkdirSync(out.slice(0, out.lastIndexOf('/')), { recursive: true });
writeFileSync(out, JSON.stringify(key, null, 1) + '\n');

const byClass = new Map<string, number>();
for (const row of rows) for (const c of row.classes) byClass.set(c, (byClass.get(c) ?? 0) + 1);
console.log(`${changed.length} prompts changed between ${before} and ${after}; ${rows.length} changed units`);
for (const [c, n] of [...byClass].sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);
for (const row of rows.filter((r) => r.classes.length === 0)) console.log(`  UNCLASSIFIED: ${row.prompt_id} shot ${row.shot}\n    removed: ${row.removed}\n    added:   ${row.added}`);
for (const row of rows) console.log(`  ${row.prompt_id} shot ${row.shot ?? 'description'}: ${row.classes.join(', ') || 'none'} (${row.assigned_by})`);
console.log(`wrote ${out}`);
