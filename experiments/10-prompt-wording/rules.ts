// Experiment 10's rule arm: the three mechanical classes, found with no model
// and no network. See README.md beside this file.
//
//   bun run wording-rules --bank-repo <dir> [--before REV] [--after REV] [--out DIR]
//
// Two things are reported. The pairs: a rule should fire on a prompt the fix
// commit repaired and fall silent on its fixed version. The sweep: how often
// the same rule fires on prompts the fix commit never touched, which is the
// false-positive rate if those prompts are clean, and a list of defects nobody
// has looked at if they are not.
//
// Reads only `prompt_bank/*.txt`, like the rest of the experiment. Findings
// carry prompt names and text, so they go to runs/, which is gitignored.

import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parsePrompt } from '../../src/h3Prompt.ts';
import { findings, type Finding } from '../../src/wordingRules.ts';

const { values } = parseArgs({
  options: { 'bank-repo': { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, out: { type: 'string' } },
});
const repo = values['bank-repo'];
if (!repo) {
  console.error('usage: bun run wording-rules --bank-repo <dir> [--before REV] [--after REV] [--out DIR]');
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
const files = git('ls-tree', '--name-only', before, 'prompt_bank/').split('\n').filter((path) => path.endsWith('.txt'));
const changed = new Set(git('diff', '--name-only', before, after, '--', 'prompt_bank').split('\n').filter((path) => path.endsWith('.txt')));
for (const path of [...files, ...changed]) if (!BANK_FILE.test(path)) throw new Error(`refusing a path outside prompt_bank/: ${path}`);

const stem = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.txt$/, '');
const findingsAt = (path: string, commit: string): Finding[] => {
  const parsed = parsePrompt(git('show', `${commit}:${path}`));
  return parsed ? findings(parsed.shots) : [];
};

const RULE_NAMES = ['unattributed_dialogue', 'silence_then_speech', 'register_mismatch'] as const;
const pairs: { prompt_id: string; rule: string; before: number; after: number; evidence: string[] }[] = [];
const sweep: { prompt_id: string; rule: string; shot: number; evidence: string }[] = [];

for (const path of files) {
  const id = stem(path);
  if (changed.has(path)) {
    const was = findingsAt(path, before);
    const now = findingsAt(path, after);
    for (const rule of RULE_NAMES) {
      const from = was.filter((f) => f.rule === rule);
      const to = now.filter((f) => f.rule === rule);
      if (from.length > 0 || to.length > 0) pairs.push({ prompt_id: id, rule, before: from.length, after: to.length, evidence: from.map((f) => f.evidence) });
    }
  } else {
    for (const finding of findingsAt(path, before)) sweep.push({ prompt_id: id, ...finding });
  }
}

const out = values.out ?? `runs/10-prompt-wording/rules-${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/pairs.jsonl`, pairs.map((p) => JSON.stringify(p)).join('\n') + '\n');
writeFileSync(`${out}/sweep.jsonl`, sweep.map((s) => JSON.stringify(s)).join('\n') + '\n');

const untouched = files.length - changed.size;
console.log(`rules over prompt_bank/ at ${before}, with ${changed.size} prompts the fix commit repaired and ${untouched} it did not\n`);
for (const rule of RULE_NAMES) {
  const mine = pairs.filter((p) => p.rule === rule);
  const fixed = mine.filter((p) => p.before > 0 && p.after === 0);
  const missed = mine.filter((p) => p.before === 0 && p.after > 0);
  const stillFiring = mine.filter((p) => p.before > 0 && p.after > 0);
  const hits = sweep.filter((s) => s.rule === rule);
  const prompts = new Set(hits.map((s) => s.prompt_id));
  console.log(`## ${rule}`);
  console.log(`repaired prompts: fires before the fix and not after in ${fixed.length}; still fires after the fix in ${stillFiring.length}; fires only after in ${missed.length}`);
  console.log(`untouched prompts: ${hits.length} findings in ${prompts.size} of ${untouched} prompts (${((prompts.size / untouched) * 100).toFixed(0)}%)`);
  for (const hit of hits.slice(0, 8)) console.log(`   ${hit.prompt_id} shot ${hit.shot}: ${hit.evidence.slice(0, 120)}`);
  if (hits.length > 8) console.log(`   ${hits.length - 8} more in ${out}/sweep.jsonl`);
  console.log('');
}
console.log(`wrote ${out}/`);
