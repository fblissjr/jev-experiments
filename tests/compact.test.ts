import { describe, expect, test } from 'bun:test';
import type { SessionMessage } from 'claude-code';
import { constantScorer, oracleScorer, randomScorer } from '../src/askers.ts';
import { collectCalls, protections } from '../src/compact/calls.ts';
import { actionFor, applyDecisions, decide, STUB_LIMIT, stubbedInput, truncatedText } from '../src/compact/decide.ts';
import { batchCalls, DEFAULT_JEV_OPTIONS, jevScorer, type NoulQuestions } from '../src/compact/jev.ts';
import { conversation } from './fixtures.ts';

const long = 'x'.repeat(1000);

// Seven calls, then the newest six messages pinned: the last three calls.
function sample(): SessionMessage[] {
  return conversation([
    { prompt: 'fix the parser' },
    { call: 'r1', tool: 'Read', input: { file_path: 'src/parse.ts' }, result: long },
    { call: 'b1', tool: 'Bash', input: { command: 'bun test' }, result: '3 failed', isError: true },
    { call: 'e1', tool: 'Edit', input: { file_path: 'src/parse.ts', old_string: 'a', new_string: 'b' }, result: 'ok' },
    { call: 'g1', tool: 'Grep', input: { pattern: 'parse' }, result: long },
    { call: 'x1', tool: 'Bash', input: { command: 'ls' }, result: 'a b c' },
    { call: 'x2', tool: 'Bash', input: { command: 'pwd' }, result: 'here' },
    { call: 'x3', tool: 'Bash', input: { command: 'date' }, result: 'today' },
  ]);
}

describe('collectCalls and protections', () => {
  test('pins the first message and the newest six', () => {
    const calls = collectCalls(sample(), 6);
    expect(calls.map((c) => c.id)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7']);
    expect(calls.filter((c) => c.pinned).map((c) => c.tool_use_id)).toEqual(['x1', 'x2', 'x3']);
  });

  test('keeps edits, the read an edit was made against, and failures', () => {
    const ruled = protections(collectCalls(sample(), 6));
    expect(Object.fromEntries(ruled)).toEqual({ r1: 'read-before-edit', b1: 'error', e1: 'edit' });
  });

  test('keeps delegated work', () => {
    const messages = conversation([{ prompt: 'go' }, { call: 'a1', tool: 'Agent', input: { prompt: 'look' }, result: 'report' }]);
    expect(protections(collectCalls(messages, 0)).get('a1')).toBe('delegated');
  });
});

describe('decide', () => {
  test('the drop-all rule drops every call that is not pinned', async () => {
    const decided = await decide(sample(), { preserveRecent: 6, threshold: 0.5, rules: false }, constantScorer(0));
    if ('fallback' in decided) throw new Error('fell back');
    expect(decided.decisions.map((d) => [d.call.tool_use_id, d.action])).toEqual([
      ['r1', 'drop'], ['b1', 'drop'], ['e1', 'drop'], ['g1', 'drop'], ['x1', 'keep'], ['x2', 'keep'], ['x3', 'keep'],
    ]);
  });

  test('with rules, only unprotected calls are scored', async () => {
    let seen: string[] = [];
    const decided = await decide(sample(), { preserveRecent: 6, threshold: 0.5, rules: {} }, async (candidates) => {
      seen = candidates.map((c) => c.tool_use_id);
      return constantScorer(0)(candidates, [], []);
    });
    if ('fallback' in decided) throw new Error('fell back');
    expect(seen).toEqual(['g1']);
    expect(decided.decisions.find((d) => d.call.tool_use_id === 'r1')?.reason).toBe('rule:read-before-edit');
  });

  test('a rule can take another action than keep', async () => {
    const decided = await decide(sample(), { preserveRecent: 6, threshold: 0.5, rules: { edit: 'stub', 'read-before-edit': 'truncate' } }, constantScorer(0));
    if ('fallback' in decided) throw new Error('fell back');
    const action = (id: string) => decided.decisions.find((d) => d.call.tool_use_id === id)?.action;
    expect([action('e1'), action('r1'), action('b1')]).toEqual(['stub', 'truncate', 'keep']);
  });

  test('scores map to actions at the threshold', () => {
    expect(actionFor({ keepCall: 0.49, keepResult: 1 }, 0.5)).toBe('drop');
    expect(actionFor({ keepCall: 0.5, keepResult: 0.49 }, 0.5)).toBe('truncate');
    expect(actionFor({ keepCall: 0.5, keepResult: 0.5 }, 0.5)).toBe('keep');
  });

  test('a scorer that leaves a candidate unscored is an error, not a silent keep', async () => {
    const scorer = async () => ({ scores: new Map() });
    await expect(decide(sample(), { preserveRecent: 6, threshold: 0.5, rules: {} }, scorer)).rejects.toThrow('no score');
  });

  test('the random scorer is seeded and keeps about p', async () => {
    const calls = Array.from({ length: 2000 }, (_, i) => ({ id: `t${i}`, tool_use_id: `c${i}` })) as never[];
    const a = await randomScorer(0.25, 'seed')(calls, [], []);
    const b = await randomScorer(0.25, 'seed')(calls, [], []);
    if ('fallback' in a || 'fallback' in b) throw new Error('fell back');
    const kept = [...a.scores.values()].filter((s) => s.keepCall === 1).length;
    expect(kept).toBeGreaterThan(400);
    expect(kept).toBeLessThan(600);
    expect([...a.scores.entries()]).toEqual([...b.scores.entries()]);
  });

  test('the oracle keeps what it is told was needed', async () => {
    const decided = await decide(sample(), { preserveRecent: 6, threshold: 0.5, rules: false }, oracleScorer((c) => c.tool === 'Grep'));
    if ('fallback' in decided) throw new Error('fell back');
    expect(decided.decisions.filter((d) => d.action === 'keep' && !d.call.pinned).map((d) => d.call.tool_use_id)).toEqual(['g1']);
  });
});

describe('applyDecisions', () => {
  test('a dropped call loses both blocks and any message left empty; others pass through untouched', async () => {
    const messages = sample();
    messages[0] = { ...messages[0]!, handle: 'h0' };
    const decided = await decide(messages, { preserveRecent: 6, threshold: 0.5, rules: false }, constantScorer(0));
    if ('fallback' in decided) throw new Error('fell back');
    const out = applyDecisions(messages, decided.decisions, 300);
    expect(out).toHaveLength(1 + 6);
    expect(out[0]).toBe(messages[0]!);
    expect(out[0]!.handle).toBe('h0');
    expect(out.flatMap((m) => m.toolUses.map((u) => u.tool_use_id))).toEqual(['x1', 'x2', 'x3']);
  });

  test('a truncated result keeps its head, says what went, and its message loses the handle', async () => {
    const messages = sample().map((m, i) => ({ ...m, handle: `h${i}` }));
    const decided = await decide(messages, { preserveRecent: 6, threshold: 0.5, rules: {} }, constantScorer(1, 0));
    if ('fallback' in decided) throw new Error('fell back');
    const out = applyDecisions(messages, decided.decisions, 300);
    const grep = out.find((m) => m.toolResults?.some((r) => r.tool_use_id === 'g1'))!;
    expect(grep.toolResults![0]!.text).toBe(truncatedText(long, 300));
    expect(grep.toolResults![0]!.text.startsWith('x'.repeat(300))).toBe(true);
    expect(grep.toolResults![0]!.text).toContain('700 more characters');
    expect(grep.handle).toBeUndefined();
  });

  test('a stub replaces long input strings with a note and leaves short ones, nested ones included', () => {
    const code = Array.from({ length: 40 }, (_, i) => `line ${i} of the old code`).join('\n');
    const input = { file_path: 'src/parse.ts', edits: [{ old_string: code, new_string: 'b' }], replace_all: false };
    const stub = stubbedInput(input);
    expect(stub).toEqual({ file_path: 'src/parse.ts', edits: [{ old_string: `[40 lines, ${code.length} characters removed at compaction]`, new_string: 'b' }], replace_all: false });
    expect(code.length).toBeGreaterThan(STUB_LIMIT);
    const short = { file_path: 'src/parse.ts', old_string: 'a', new_string: 'b' };
    expect(stubbedInput(short)).toBe(short);
  });

  test('a stubbed call keeps its result, and its message loses the handle', async () => {
    const messages = conversation([
      { prompt: 'go' },
      { call: 'w1', tool: 'Write', input: { file_path: 'a.ts', content: long }, result: 'File created' },
    ]).map((m, i) => ({ ...m, handle: `h${i}` }));
    const decided = await decide(messages, { preserveRecent: 0, threshold: 0.5, rules: { edit: 'stub' } }, constantScorer(0));
    if ('fallback' in decided) throw new Error('fell back');
    const out = applyDecisions(messages, decided.decisions, 300);
    expect(out[1]!.toolUses[0]!.input).toEqual({ file_path: 'a.ts', content: '[1 lines, 1000 characters removed at compaction]' });
    expect(out[1]!.handle).toBeUndefined();
    expect(out[2]).toBe(messages[2]!);
  });

  test('a short result is not truncated', () => {
    expect(truncatedText('short', 300)).toBe('short');
  });
});

describe('jevScorer', () => {
  test('asks two questions per candidate and maps each answer back to its call', async () => {
    const asked: NoulQuestions[] = [];
    let state: unknown;
    const scorer = jevScorer(async (s, questions) => {
      state = s;
      asked.push(questions);
      // Keep the call t4 (the Grep) and its result; nothing else.
      return Object.fromEntries(Object.keys(questions).map((name) => [name, name.endsWith('_t4') ? 0.9 : 0.1]));
    });
    const decided = await decide(sample(), { preserveRecent: 6, threshold: 0.5, rules: false }, scorer);
    if ('fallback' in decided) throw new Error('fell back');
    expect(Object.keys(asked[0]!).sort()).toEqual(['call_t1', 'call_t2', 'call_t3', 'call_t4', 'result_t1', 'result_t2', 'result_t3', 'result_t4']);
    expect(decided.decisions.filter((d) => d.action === 'keep').map((d) => d.call.tool_use_id)).toEqual(['g1', 'x1', 'x2', 'x3']);
    // Every call asked about is in the state Jev sees, with its result omitted.
    const json = JSON.stringify(state);
    for (const id of ['t1', 't2', 't3', 't4']) expect(json).toContain(`"id":"${id}"`);
    expect(json).not.toContain(long);
  });

  test('declines when the state does not fit with every message in it', async () => {
    let called = false;
    const scorer = jevScorer(async () => ((called = true), {}), { ...DEFAULT_JEV_OPTIONS, maxStateTokens: 10 });
    const decided = await decide(sample(), { preserveRecent: 6, threshold: 0.5, rules: false }, scorer);
    expect(decided).toEqual({ fallback: 'state-too-large' });
    expect(called).toBe(false);
  });

  test('a missing answer is an error', async () => {
    const scorer = jevScorer(async () => ({}));
    await expect(decide(sample(), { preserveRecent: 6, threshold: 0.5, rules: false }, scorer)).rejects.toThrow('no answer');
  });

  test('batches questions to fit the request budget', () => {
    const calls = collectCalls(sample(), 0);
    const one = batchCalls(calls, 0, DEFAULT_JEV_OPTIONS)!;
    expect(one).toHaveLength(1);
    const many = batchCalls(calls, 0, { ...DEFAULT_JEV_OPTIONS, maxRequestTokens: 400 })!;
    expect(many.length).toBeGreaterThan(1);
    expect(many.flat().map((c) => c.id)).toEqual(calls.map((c) => c.id));
  });
});
