import { describe, expect, test } from 'bun:test';
import { Ledger } from '../src/ledger.ts';
import { importLines, JEV_HEADERS, jevDestination, KEY_PLACEHOLDER, parseBody, sendApproved, type Post, type PostResult } from '../src/send.ts';

const KEY = 'ts-test-0123456789abcdefghij'; // matches no credential shape, so only the key check can catch it
const DEST = jevDestination('https://example.invalid/');
const QUESTIONS = { intent: { type: 'choice', instructions: 'What does the reply want?', criteria: { refund: 'money back', bug: 'broken' } } };
// Bytes as another producer might write them: its own field order, a space
// after each colon, and an escaped character. A parse and re-stringify changes
// the spacing and the escape, so it cannot pass for the stored body.
const oddOrder = (state: string) => `{"model": "jev-latest", "questions": ${JSON.stringify(QUESTIONS)}, "state": ${JSON.stringify(state + ' caf\u00e9').replace('\u00e9', '\\u00e9')}}`;
const line = (unit_key: string, body: string, meta: Record<string, unknown> = { unit: unit_key }) => JSON.stringify({ unit_key, meta, body });
const OK = (model = 'jev-1.13.0'): PostResult => ({ status: 200, text: JSON.stringify({ model, answers: { intent: { type: 'choice', choice: 'refund', confidence: 0.9, probabilities: { refund: 0.9, bug: 0.1 } } }, usage: { input_tokens: 40, output_tokens: 5 } }) });

function fakePost(results: (PostResult | Error)[]) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const post: Post = async (url, headers, body) => {
    calls.push({ url, headers, body });
    const next = results.shift() ?? OK();
    if (next instanceof Error) throw next;
    return next;
  };
  return { post, calls };
}

function approvedRun(lines: string[], importKey?: string) {
  const ledger = new Ledger(':memory:');
  const run = ledger.startRun({ experiment: '12-branch-table', kind: 'dry-run', destination: DEST, headers: { ...JEV_HEADERS }, source: { from: 'bodies.jsonl' }, code_version: 'test' }, new Date('2026-09-21T00:00:00.000Z'));
  ledger.addPayloads(run, importLines(lines.join('\n'), importKey));
  ledger.approve(run);
  return { ledger, run };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};
const options = (post: Post, extra: Partial<Parameters<typeof sendApproved>[2]> = {}) => ({ apiKey: KEY, destination: DEST, code_version: 'test', post, sleep, ...extra });

describe('parseBody', () => {
  test('a Jev request in any field order is accepted', () => {
    expect(parseBody(oddOrder('x')).model).toBe('jev-latest');
  });
  test('an extra field, or a question with no known type, is refused', () => {
    expect(() => parseBody(JSON.stringify({ state: 'x', questions: QUESTIONS, model: 'm', stream: true }))).toThrow('not exactly');
    expect(() => parseBody(JSON.stringify({ state: 'x', questions: { q: { type: 'text' } }, model: 'm' }))).toThrow('no type');
  });
});

describe('importLines', () => {
  test('each body is kept byte for byte, with its unit and meta', () => {
    const [p] = importLines(line('u1', oddOrder('a refund please'), { question_version: 'v1' }), undefined);
    expect(p).toEqual({ unit_key: 'u1', meta: { question_version: 'v1' }, body: oddOrder('a refund please'), refused: null });
  });

  test('a credential in the questions, not only the state, is refused and kept for review', () => {
    const body = JSON.stringify({ state: 'x', questions: { q: { type: 'noul', instructions: 'AKIAABCDEFGHIJKLMNOP' } }, model: 'm' });
    expect(importLines(line('u1', body), undefined)[0]!.refused).toBe('credential:aws-access-key');
  });

  test('a malformed line or a repeated unit stops the import at its line', () => {
    expect(() => importLines([line('u1', oddOrder('a')), 'not json'].join('\n'), undefined)).toThrow('line 2: not JSON');
    expect(() => importLines([line('u1', oddOrder('a')), line('u1', oddOrder('b'))].join('\n'), undefined)).toThrow('line 2: unit_key u1 appears twice');
    expect(() => importLines(line('u1', '{"state":"x"}'), undefined)).toThrow('line 1: the body');
  });
});

describe('sendApproved', () => {
  test('the stored bytes go out unchanged, with the key in place of its placeholder, and the answers come back per unit', async () => {
    const { ledger, run } = approvedRun([line('u1', oddOrder('a refund please')), line('u2', oddOrder('it crashes'))]);
    const { post, calls } = fakePost([OK(), OK()]);
    expect(JSON.stringify(JSON.parse(oddOrder('x')))).not.toBe(oddOrder('x'));
    const summary = await sendApproved(ledger, run, options(post));
    expect(calls.map((c) => c.body)).toEqual([oddOrder('a refund please'), oddOrder('it crashes')]);
    expect(calls[0]!.url).toBe('https://example.invalid/v1/systemone');
    expect(calls[0]!.headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(summary).toMatchObject({ approved: 2, attempted: 2, ok: 2, errors: 0, refused: 0, inputTokens: 80, models: ['jev-1.13.0'] });
    const answered = ledger.answered(run);
    expect(answered.map((a) => [a.unit_key, a.model, a.input_tokens])).toEqual([['u1', 'jev-1.13.0', 40], ['u2', 'jev-1.13.0', 40]]);
    expect(answered[0]!.answers).toMatchObject({ intent: { choice: 'refund', probabilities: { refund: 0.9, bug: 0.1 } } });
    // The run's stored headers still hold the placeholder, never the key.
    expect(JSON.stringify(ledger.run(summary.run_id)!.headers)).toContain(KEY_PLACEHOLDER);
    expect(JSON.stringify(ledger.run(summary.run_id)!.headers)).not.toContain(KEY);
  });

  test('a 429 is retried after its Retry-After; a 422 is not retried', async () => {
    sleeps.length = 0;
    const { ledger, run } = approvedRun([line('u1', oddOrder('a')), line('u2', oddOrder('b'))]);
    const { post, calls } = fakePost([{ status: 429, text: '{}', retryAfter: 2 }, OK(), { status: 422, text: '{"detail":"bad criteria"}' }]);
    const summary = await sendApproved(ledger, run, options(post));
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000]);
    expect(summary).toMatchObject({ ok: 1, errors: 1 });
    const statuses = ledger.db.query('SELECT status, response FROM responses WHERE run_id = ? ORDER BY seq').all(summary.run_id) as { status: string; response: string }[];
    expect(statuses.map((s) => s.status)).toEqual(['ok', 'error:http-422']);
    expect(statuses[1]!.response).toContain('bad criteria');
  });

  test('a dropped connection is retried with backoff, and gives up after three attempts', async () => {
    sleeps.length = 0;
    const { ledger, run } = approvedRun([line('u1', oddOrder('a'))]);
    const { post, calls } = fakePost([new Error('socket closed'), new Error('socket closed'), new Error('socket closed')]);
    const summary = await sendApproved(ledger, run, options(post));
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
    expect(summary).toMatchObject({ ok: 0, errors: 1 });
    // A failure is not "already sent": the next send tries it again.
    const again = await sendApproved(ledger, run, options(fakePost([OK()]).post));
    expect(again).toMatchObject({ alreadySent: 0, attempted: 1, ok: 1 });
    expect(await sendApproved(ledger, run, options(fakePost([]).post))).toMatchObject({ alreadySent: 1, attempted: 0 });
  });

  test('a body holding the key is refused at send, when the key is first known, and never posted', async () => {
    const { ledger, run } = approvedRun([line('u1', oddOrder(`my key is ${KEY}`)), line('u2', oddOrder('fine'))]);
    const { post, calls } = fakePost([OK()]);
    const summary = await sendApproved(ledger, run, options(post));
    expect(calls.map((c) => c.body)).toEqual([oddOrder('fine')]);
    expect(summary).toMatchObject({ refused: 1, ok: 1 });
  });

  test('a send goes only where the dry run was built for, only from an approved run, and only with a key placeholder', async () => {
    const { ledger, run } = approvedRun([line('u1', oddOrder('a'))]);
    await expect(sendApproved(ledger, run, options(fakePost([]).post, { destination: jevDestination('https://other.invalid') }))).rejects.toThrow('built for');
    const unapproved = ledger.startRun({ experiment: 'x', kind: 'dry-run', destination: DEST, headers: { ...JEV_HEADERS }, source: {}, code_version: 'test' }, new Date('2026-09-21T00:00:01.000Z'));
    await expect(sendApproved(ledger, unapproved, options(fakePost([]).post))).rejects.toThrow('has not been approved');
    const bare = ledger.startRun({ experiment: 'x', kind: 'dry-run', destination: DEST, headers: { Authorization: 'Bearer sk-live' }, source: {}, code_version: 'test' }, new Date('2026-09-21T00:00:02.000Z'));
    ledger.approve(bare);
    await expect(sendApproved(ledger, bare, options(fakePost([]).post))).rejects.toThrow('no key placeholder');
  });

  test('the limit sends only the first pending bodies and reports what is left', async () => {
    const { ledger, run } = approvedRun([line('u1', oddOrder('a')), line('u2', oddOrder('b')), line('u3', oddOrder('c'))]);
    const { post, calls } = fakePost([]);
    expect(await sendApproved(ledger, run, options(post, { limit: 1 }))).toMatchObject({ attempted: 1, ok: 1, left: 2 });
    expect(calls).toHaveLength(1);
  });
});
