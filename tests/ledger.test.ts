import { describe, expect, test } from 'bun:test';
import { Ledger, sha256, type PayloadInput, type RunInput } from '../src/ledger.ts';
import { renderRunHtml, scriptJson, sharedParts } from '../src/payloadView.ts';

const RUN: RunInput = {
  experiment: 'test',
  kind: 'dry-run',
  destination: 'POST https://example.invalid/v1/x',
  headers: { Authorization: 'Bearer <not stored>' },
  source: { commit: 'abc' },
  code_version: '0.0.0 test',
};
const QUESTIONS = { q: { type: 'noul', instructions: 'Is it wet?' } };
const body = (text: string) => JSON.stringify({ state: { shot: text }, questions: QUESTIONS, model: 'm' });
const payload = (text: string, refused: string | null = null): PayloadInput => ({ unit_key: text, meta: { kind: 'shot' }, body: body(text), refused });

function ledgerWithRun(texts: string[], refused: (string | null)[] = []): { ledger: Ledger; run: string } {
  const ledger = new Ledger(':memory:');
  const run = ledger.startRun(RUN, new Date('2026-09-19T00:00:00.000Z'));
  ledger.addPayloads(run, texts.map((t, i) => payload(t, refused[i] ?? null)));
  return { ledger, run };
}

describe('Ledger', () => {
  test('stores each body exactly, with its hash, size and order', () => {
    const { ledger, run } = ledgerWithRun(['rain on the <d> glass', 'fog']);
    const stored = ledger.payloads(run);
    expect(stored.map((p) => p.seq)).toEqual([1, 2]);
    expect(stored[0]!.body).toBe(body('rain on the <d> glass'));
    expect(stored[0]!.body_sha256).toBe(sha256(body('rain on the <d> glass')));
    expect(stored[0]!.bytes).toBe(Buffer.byteLength(body('rain on the <d> glass')));
  });

  test('a send may not read an unapproved dry run', () => {
    const { ledger, run } = ledgerWithRun(['a']);
    expect(() => ledger.approvedPayloads(run)).toThrow('has not been approved');
  });

  test('an approved dry run gives its bodies, leaving out refused ones', () => {
    const { ledger, run } = ledgerWithRun(['a', 'b', 'c'], [null, 'credential:jwt', null]);
    ledger.approve(run);
    expect(ledger.approvedPayloads(run).map((p) => p.unit_key)).toEqual(['a', 'c']);
  });

  test('a body edited after approval is refused', () => {
    const { ledger, run } = ledgerWithRun(['a']);
    ledger.approve(run);
    ledger.db.query('UPDATE payloads SET body = ? WHERE run_id = ?').run(body('tampered'), run);
    expect(() => ledger.approvedPayloads(run)).toThrow('no longer matches its hash');
  });

  test('approval happens once, and only for a dry run', () => {
    const { ledger, run } = ledgerWithRun(['a']);
    ledger.approve(run);
    expect(() => ledger.approve(run)).toThrow('already approved');
    const send = ledger.startRun({ ...RUN, kind: 'send', from_run: run }, new Date('2026-09-19T00:00:01.000Z'));
    expect(() => ledger.approve(send)).toThrow('only a dry run');
    expect(() => ledger.addPayloads(send, [payload('x')])).toThrow('bodies are stored on a dry run');
  });

  test('a later send from the same dry run skips what was already sent, but not what failed', () => {
    const { ledger, run } = ledgerWithRun(['a', 'b', 'c']);
    ledger.approve(run);
    const send = ledger.startRun({ ...RUN, kind: 'send', from_run: run }, new Date('2026-09-19T00:00:01.000Z'));
    const [a, b] = ledger.approvedPayloads(run);
    ledger.recordResponse(send, { seq: a!.seq, body_sha256: a!.body_sha256, status: 'ok', model: 'm', ms: 1, input_tokens: 10, response: { q: { noul: 0.1 } } });
    ledger.recordResponse(send, { seq: b!.seq, body_sha256: b!.body_sha256, status: 'error:RateLimitError', model: null, ms: 1, input_tokens: null, response: null });
    expect([...ledger.alreadySent(run)]).toEqual([a!.seq]);
    const summary = ledger.runs().find((r) => r.run_id === send)!;
    expect([summary.responses, summary.errors]).toEqual([2, 1]);
  });
});

describe('payload view', () => {
  test('script JSON cannot close its script element', () => {
    const json = scriptJson({ text: '</script><script>alert(1)</script>' });
    expect(json.includes('</script')).toBe(false);
    expect(JSON.parse(json)).toEqual({ text: '</script><script>alert(1)</script>' });
  });

  test('bank markup stays text: no body reaches the page outside the escaped JSON', () => {
    const { ledger, run } = ledgerWithRun(['<Subject 1> says <d>[English] hi</d></script><img src=x onerror=alert(1)>']);
    const html = renderRunHtml(ledger.run(run)!, ledger.payloads(run));
    expect(html.includes('<img')).toBe(false);
    expect(html.includes('<Subject 1>')).toBe(false);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });

  test('fields shared by many bodies are counted once, the state never', () => {
    const { ledger, run } = ledgerWithRun(['a', 'b']);
    const parts = sharedParts(ledger.payloads(run));
    expect(parts.map((p) => [p.field, p.bodies])).toEqual([['model', 2], ['questions', 2]]);
  });
});
