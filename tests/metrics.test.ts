import { describe, expect, test } from 'bun:test';
import { collectCalls } from '../src/compact/calls.ts';
import { applyDecisions, type Action } from '../src/compact/decide.ts';
import { emptyLoss, featuresOf, Future, measureLoss, totalChars } from '../src/metrics.ts';
import { conversation } from './fixtures.ts';

describe('featuresOf', () => {
  test('finds paths, long numbers, hashes and error lines', () => {
    const found = featuresOf('see src/lib/parse.ts at line 12, pid 48213, commit 3f9a2c1d\nError: cannot open the config file here');
    expect(found).toContain('src/lib/parse.ts');
    expect(found).toContain('48213');
    expect(found).toContain('3f9a2c1d');
    expect(found).toContain('Error: cannot open the config file here');
    expect(found).not.toContain('12');
  });

  test('has no cap: a truncated tail keeps its strings in view', () => {
    const many = Array.from({ length: 80 }, (_, i) => String(10000 + i)).join(' ');
    expect(featuresOf(many)).toHaveLength(80);
  });
});

describe('Future', () => {
  test('a string used in assistant text or a tool input before anything carries it back is used later', () => {
    const future = new Future(conversation([{ prompt: 'go on' }, { say: 'the pid was 48213' }]));
    expect(future.usedLater('48213')).toBe(true);
    expect(future.usedLater('99999')).toBe(false);
  });

  test('a string a later result or the person brought back first is not', () => {
    const viaResult = new Future(conversation([{ call: 'c', tool: 'Bash', input: { command: 'ps' }, result: 'pid 48213' }, { say: 'kill 48213' }]));
    expect(viaResult.usedLater('48213')).toBe(false);
    const viaPerson = new Future(conversation([{ prompt: 'it is 48213' }, { say: 'kill 48213' }]));
    expect(viaPerson.usedLater('48213')).toBe(false);
  });

  test('a string used, then carried, still counts', () => {
    const future = new Future(conversation([{ call: 'c', tool: 'Bash', input: { command: 'kill 48213' }, result: 'killed 48213' }]));
    expect(future.usedLater('48213')).toBe(true);
  });

  test('a re-run counts only for the same file, or the same Bash, Grep or Glob input', () => {
    const future = new Future(conversation([
      { call: 'c1', tool: 'Read', input: { file_path: 'a.ts', offset: 10 }, result: '' },
      { call: 'c2', tool: 'Bash', input: { command: 'ls' }, result: '' },
    ]));
    expect(future.rerun('Read', { file_path: 'a.ts' })).toBe(true);
    expect(future.rerun('Bash', { command: 'ls' })).toBe(true);
    expect(future.rerun('Bash', { command: 'ls -la' })).toBe(false);
    expect(future.rerun('WebFetch', { url: 'x' })).toBe(false);
  });

  test('a Bash re-run is the same command, whatever description was written with it', () => {
    const future = new Future(conversation([{ call: 'c', tool: 'Bash', input: { command: 'bun test', description: 'Run the suite again' }, result: '' }]));
    expect(future.rerun('Bash', { command: 'bun test', description: 'Run tests' })).toBe(true);
    expect(future.rerun('Bash', { command: 'bun test tests/a.ts', description: 'Run tests' })).toBe(false);
  });
});

describe('measureLoss', () => {
  const prefix = conversation([
    { prompt: 'start' },
    { call: 'c1', tool: 'Bash', input: { command: 'ps' }, result: 'pid 48213 running' },
    { call: 'c2', tool: 'Bash', input: { command: 'env' }, result: 'nothing to see' },
    { call: 'e1', tool: 'Edit', input: { file_path: 'src/lib/parse.ts', old_string: 'x', new_string: 'y' }, result: 'ok' },
  ]);
  const calls = collectCalls(prefix, 0);
  const future = new Future(conversation([{ say: 'stop 48213, then look at src/lib/parse.ts' }]));
  const after = (actions: Record<string, Action>) =>
    applyDecisions(prefix, calls.map((call) => ({ call, action: actions[call.tool_use_id] ?? 'keep', reason: 'scored' as const })), 300);

  test('a compaction that changes nothing loses nothing', () => {
    expect(measureLoss(calls, prefix, future)).toEqual(emptyLoss());
  });

  test('a dropped call loses its result and its input, each counted on its own', () => {
    const loss = measureLoss(calls, after({ c1: 'drop', c2: 'drop', e1: 'drop' }), future);
    expect(loss).toMatchObject({ lost: 3, recall: 1, reread: 0, either: 1, inputsLost: 3, inputRecall: 1, needed: 2 });
    expect(loss.lostChars).toBe('pid 48213 running'.length + 'nothing to see'.length + 'ok'.length);
  });

  test('not lost while the output still holds the string somewhere', () => {
    const kept = [...after({ c1: 'drop' }), ...conversation([{ prompt: 'the pid was 48213' }])];
    expect(measureLoss(calls, kept, future)).toMatchObject({ lost: 1, recall: 0, needed: 0 });
  });

  test('a stub loses input, not result', () => {
    const edit = conversation([{ call: 'w1', tool: 'Write', input: { file_path: 'b.ts', content: `${'z'.repeat(300)} see 11448b4` }, result: 'written' }]);
    const stubbed = applyDecisions(edit, collectCalls(edit, 0).map((call) => ({ call, action: 'stub' as const, reason: 'scored' as const })), 300);
    const loss = measureLoss(collectCalls(edit, 0), stubbed, new Future(conversation([{ say: 'as in 11448b4' }])));
    expect(loss).toMatchObject({ lost: 0, inputsLost: 1, inputRecall: 1, needed: 1 });
  });

  test('a truncation loses only strings past the head', () => {
    const body = `${'a'.repeat(400)} 77777 ${'b'.repeat(400)} 88888`;
    const one = conversation([{ call: 'r1', tool: 'Bash', input: { command: 'cat log' }, result: `11111 ${body}` }]);
    const truncated = applyDecisions(one, collectCalls(one, 0).map((call) => ({ call, action: 'truncate' as const, reason: 'scored' as const })), 300);
    const lossIf = (said: string) => measureLoss(collectCalls(one, 0), truncated, new Future(conversation([{ say: said }])));
    expect(lossIf('it was 11111')).toMatchObject({ lost: 1, recall: 0 });
    expect(lossIf('it was 88888')).toMatchObject({ lost: 1, recall: 1 });
  });

  test('chars count text, tool inputs and results once each', () => {
    const one = conversation([{ call: 'c', tool: 'Bash', input: { command: 'ls' }, result: 'abc' }]);
    expect(totalChars(one)).toBe(JSON.stringify({ command: 'ls' }).length + 3);
  });
});
