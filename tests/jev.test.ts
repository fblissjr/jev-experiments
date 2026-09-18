import { describe, expect, test } from 'bun:test';
import type { Unit } from '../src/exchanges.ts';
import { KEY_SLICE, refuseState } from '../src/egress.ts';
import { answerFrom, jevLabeler, jevQuestions, type SystemOneCall } from '../src/jevLabeler.ts';
import { asksFor, labelUnit, optionsHash, QUESTIONS, type Pair, type RuleVersion } from '../src/labels.ts';
import { calibration, type ScoredRow } from '../src/scoring.ts';

function unit(reply: string): Unit {
  return { unit_type: 'exchange', native_session_id: 's', project_name: 'p', user_entry_uuid: 'u', assistant_entry_uuid: 'a', previous_prompt_uuid: 'o', previous_prompt: 'fix it', reply, timestamp: '2026-05-20 10:00:00', copies: 1 };
}
const history: RuleVersion[] = [{ project_dir: 'p', rule_id: 'run-tests', statement: 'Run the tests before a commit.', effective_from: '2026-04-01', effective_to: null }];
const q = (id: string) => QUESTIONS.find((x) => x.question_id === id)!;

// A canned response in the SDK's answer shapes.
const canned: SystemOneCall = async (_state, questions) => ({
  model: 'jev-1.13.0',
  answers: Object.fromEntries(
    Object.entries(questions).map(([id, question]) =>
      question.type === 'score'
        ? [id, { type: 'score', score: 1.2, confidence: 0.6, probabilities: { '0': 0.2, '1': 0.5, '2': 0.3 } }]
        : [id, { type: 'choice', choice: Object.keys(question.criteria)[0], confidence: 0.8, probabilities: Object.fromEntries(Object.keys(question.criteria).map((l, i) => [l, i === 0 ? 0.7 : 0.3 / (Object.keys(question.criteria).length - 1)])) }],
    ),
  ),
});
const noRefusal = () => undefined;

describe('jevQuestions', () => {
  test('instructions are the contract text; choice criteria keep the option order; a score sends its level descriptions', () => {
    const questions = jevQuestions(asksFor(unit('no'), history));
    expect(Object.keys(questions)).toEqual(['user_response', 'correction_kind', 'rule_violated', 'frustration']);
    expect(questions['user_response']).toMatchObject({ type: 'choice', instructions: q('user_response').text });
    const criteria = (questions['rule_violated'] as { criteria: Record<string, string> }).criteria;
    expect(Object.keys(criteria)).toEqual(['run-tests', 'none']);
    expect(questions['frustration']).toEqual({ type: 'score', instructions: q('frustration').text, criteria: ['calm, matter-of-fact', 'frustrated but civil', 'very angry'] });
  });
});

describe('answerFrom', () => {
  const choiceAsk = { question: q('user_response'), options: q('user_response').options as Pair[] };
  test('a choice keeps the chosen label and its probability', () => {
    expect(answerFrom(choiceAsk, { choice: 'correct', confidence: 0.9, probabilities: { correct: 0.8, approve: 0.2 } })).toEqual({ value: 'correct', probability: 0.8, probabilities: { correct: 0.8, approve: 0.2 }, confidence: 0.9 });
  });
  test('a score is its most probable level, as an integer', () => {
    const answer = answerFrom({ question: q('frustration'), options: null }, { score: 1.4, probabilities: { '0': 0.3, '1': 0.3, '2': 0.4 } });
    expect(answer).toMatchObject({ value: 2, probability: 0.4 });
    // A tie goes to the lower level.
    expect(answerFrom({ question: q('frustration'), options: null }, { probabilities: { '0': 0.5, '1': 0.5 } }).value).toBe(0);
  });
  test('a choice outside the options, or missing probabilities, is an error', () => {
    expect(() => answerFrom(choiceAsk, { choice: 'shrug', probabilities: { shrug: 1 } })).toThrow('outside the options');
    expect(() => answerFrom(choiceAsk, { choice: 'correct' })).toThrow('no probabilities');
  });
});

describe('jevLabeler through labelUnit', () => {
  test('rows carry the model version from the response, probabilities, and the same options hash as the keyword rows', async () => {
    const { rows, fallback } = await labelUnit(unit('no, run the tests'), jevLabeler(canned, noRefusal), 'synthetic-x', history, () => 'then');
    expect(fallback).toBeUndefined();
    expect(rows.map((r) => r.question_id)).toEqual(['user_response', 'correction_kind', 'rule_violated', 'frustration']);
    expect(rows.every((r) => r.labeler === 'jev' && r.labeler_kind === 'model' && r.labeler_version === 'jev-1.13.0' && typeof r.probability === 'number')).toBe(true);
    expect(rows.find((r) => r.question_id === 'user_response')!.options_hash).toBe(optionsHash(q('user_response').options as Pair[]));
    expect(rows.find((r) => r.question_id === 'frustration')).toMatchObject({ value: 1, probability: 0.5, options_hash: null });
  });

  test('a refused state is never sent', async () => {
    let called = false;
    const spy: SystemOneCall = async (...args) => ((called = true), canned(...args));
    const { rows, fallback } = await labelUnit(unit('x'), jevLabeler(spy, () => 'holds-api-key'), 's', history, () => 'then');
    expect(called).toBe(false);
    expect(rows).toEqual([]);
    expect(fallback).toBe('refused:holds-api-key');
  });

  test('an error from the call is a fallback for the unit, not a thrown run', async () => {
    const failing: SystemOneCall = async () => {
      throw new Error('529 overloaded');
    };
    expect(await labelUnit(unit('x'), jevLabeler(failing, noRefusal), 's', history, () => 'then')).toEqual({ rows: [], fallback: 'error:529 overloaded' });
  });
});

describe('refuseState', () => {
  const key = 'tsk_live_0123456789abcdefghijklmnopqrstuv';
  test('the loaded key, or any piece of it at least as long as a slice, is refused', () => {
    expect(refuseState({ reply: `use ${key}` }, key)).toBe('holds-api-key');
    expect(refuseState({ reply: `half: ${key.slice(10, 10 + KEY_SLICE)}` }, key)).toBe('holds-api-key');
    expect(refuseState({ reply: `short: ${key.slice(0, KEY_SLICE - 1)}` }, key)).toBeUndefined();
  });
  test('common credential shapes are refused; ordinary text passes', () => {
    expect(refuseState({ reply: 'AKIAABCDEFGHIJKLMNOP' }, undefined)).toBe('credential:aws-access-key');
    expect(refuseState({ reply: '-----BEGIN OPENSSH PRIVATE KEY-----' }, undefined)).toBe('credential:private-key');
    expect(refuseState({ reply: 'please run the tests before committing' }, key)).toBeUndefined();
  });
});

describe('calibration', () => {
  const row = (uuid: string, labeler: string, value: string, probability?: number): ScoredRow => ({
    native_session_id: 's', user_entry_uuid: uuid, question_id: 'q', question_version: 'v1', labeler, value, options_hash: 'h', probability,
  });
  test('rows group by probability tenths; agreement is counted per group', () => {
    const key = [row('1', 'key', 'a'), row('2', 'key', 'a'), row('3', 'key', 'b'), row('4', 'key', 'b')];
    const labels = [row('1', 'jev', 'a', 0.95), row('2', 'jev', 'a', 1.0), row('3', 'jev', 'a', 0.55), row('4', 'jev', 'b', 0.62)];
    const [c] = calibration(labels, key);
    expect(c).toMatchObject({ n: 4, accuracy: 0.75 });
    expect(c!.buckets.map((b) => [b.from, b.n, b.agree])).toEqual([[0.5, 1, 0], [0.6, 1, 1], [0.9, 2, 2]]);
  });
  test("rows without a probability, such as a rule's, are not calibrated", () => {
    expect(calibration([row('1', 'keyword', 'a')], [row('1', 'key', 'a')])).toEqual([]);
  });
});
