import { describe, expect, test } from 'bun:test';
import type { Unit } from '../src/exchanges.ts';
import { KEYWORD_LABELER, keywordFrustration, keywordRuleViolated, keywordUserResponse } from '../src/keyword.ts';
import { score, type ScoredRow } from '../src/scoring.ts';
import { asOfOptions, labelUnit, optionsHash, QUESTIONS, stateOf, type Pair, type RuleVersion } from '../src/labels.ts';

const ch = (...codes: number[]) => String.fromCharCode(...codes);

describe('optionsHash', () => {
  test("matches freudagent's answer key for the static questions", () => {
    const pairs = (id: string) => QUESTIONS.find((q) => q.question_id === id)!.options as Pair[];
    expect(optionsHash(pairs('user_response'))).toBe('2c0d6dc6116d56bafedefd21d11bbdda9b0bae7be19a3dc9d5ac4c9a6714063b');
    expect(optionsHash(pairs('correction_kind'))).toBe('7e71ec92adec376de8e13313dfe3a620db8cc57a7611be98a0f814c9586bea4b');
  });

  test("matches Python's json.dumps(ensure_ascii=False, separators=(',', ':')) on awkward text", () => {
    const description =
      "Keep an Edit's path " + ch(0x2014) + ' never its "code"; r' + ch(0xe9) + 'sum' + ch(0xe9) + ' ' + ch(0x65e5, 0x672c, 0x8a9e) + ch(10) +
      'second line' + ch(9) + 'tab ' + ch(1) + ' ctrl / slash ' + ch(92) + ' backslash ' + ch(0x7f) + ' del ' + ch(0x2028) + ' ls';
    expect(optionsHash([['keep-edits', description], ['none', 'the reply points at no listed rule']])).toBe('387f5f8512010b3b0c9c91ae9c3e5723bc8ffa70e068c5b5e5195d6b0708d5e8');
  });

  test('refuses text Python could not encode', () => {
    expect(() => optionsHash([['x', 'lone ' + ch(0xd800)]])).toThrow('lone surrogate');
  });
});

describe('asOfOptions', () => {
  const history: RuleVersion[] = [
    { project_dir: 'p', rule_id: 'zeta', statement: 'Z.', effective_from: '2026-04-01', effective_to: null },
    { project_dir: 'p', rule_id: 'ask-before-push', statement: 'Ask first.', effective_from: '2026-05-15', effective_to: null },
    { project_dir: 'p', rule_id: 'tables', statement: 'Tables.', effective_from: '2026-04-01', effective_to: '2026-05-10' },
    { project_dir: 'q', rule_id: 'other-project', statement: 'O.', effective_from: '2026-01-01', effective_to: null },
  ];
  const ids = (day: string) => asOfOptions(history, 'p', `${day} 12:00:00`)!.map(([id]) => id);

  test('a rule counts from its first day, sorted by id, "none" last', () => {
    expect(ids('2026-05-14')).toEqual(['zeta', 'none']);
    expect(ids('2026-05-15')).toEqual(['ask-before-push', 'zeta', 'none']);
  });

  test('a retired rule is gone on its end day', () => {
    expect(ids('2026-05-09')).toEqual(['tables', 'zeta', 'none']);
    expect(ids('2026-05-10')).toEqual(['zeta', 'none']);
  });
});

function unit(reply: string, previous: string | null = 'fix it'): Unit {
  return { unit_type: 'exchange', native_session_id: 's', project_name: 'p', user_entry_uuid: 'u', assistant_entry_uuid: 'a', previous_prompt_uuid: 'o', previous_prompt: previous, reply, timestamp: '2026-05-20 10:00:00', copies: 1 };
}

describe('stateOf and labelUnit', () => {
  test('the state holds only the two typed fields', () => {
    expect(Object.keys(stateOf(unit('no')).state).sort()).toEqual(['previous_prompt', 'reply']);
  });

  test('a cut never splits a character, and the state is always well formed', () => {
    const emoji = ch(0xd83d, 0xde00);
    const { state, truncated } = stateOf(unit('a'.repeat(7999) + emoji + 'tail'));
    expect(truncated).toBe(true);
    expect(state.reply).toBe('a'.repeat(7999));
    expect(state.reply.isWellFormed()).toBe(true);
    // A lone surrogate already in the log is replaced, not passed on; the state is not marked truncated for it.
    const broken = stateOf(unit('ok ' + ch(0xd800) + ' end'));
    expect(broken.state.reply.isWellFormed()).toBe(true);
    expect(broken.truncated).toBe(false);
  });

  test('long text is cut and the state marked truncated', () => {
    const { state, truncated } = stateOf(unit('x'.repeat(9000)));
    expect(state.reply.length).toBe(8000);
    expect(truncated).toBe(true);
    expect(stateOf(unit('short')).truncated).toBe(false);
  });

  test('without a rule history rule_violated is not asked; a score has no options hash; an interrupt gets no labels', async () => {
    const { rows: labelRows } = await labelUnit(unit('no, run the tests'), KEYWORD_LABELER, 'test', undefined, () => 'now');
    expect(labelRows.map((r) => r.question_id)).toEqual(['user_response', 'correction_kind', 'frustration']);
    expect(labelRows.find((r) => r.question_id === 'frustration')!.options_hash).toBeNull();
    expect(labelRows.every((r) => r.labeler_version === 'keyword-v1' && r.probability === null)).toBe(true);
    expect((await labelUnit({ ...unit(''), unit_type: 'interrupt' }, KEYWORD_LABELER, 'test', undefined, () => 'now')).rows).toEqual([]);
  });
});

describe('keyword rule', () => {
  test('user_response', () => {
    expect(keywordUserResponse('No, revert that.')).toBe('correct');
    expect(keywordUserResponse('Looks good, ship it')).toBe('approve');
    expect(keywordUserResponse('What does the window default to?')).toBe('question');
    expect(keywordUserResponse('keep going')).toBe('continue');
  });

  test('frustration: shouting is mostly capitals, not a couple of acronyms', () => {
    expect(keywordFrustration('Update the README and the CHANGELOG for this.')).toBe(0);
    expect(keywordFrustration('Parse the JSON from the HTTP response.')).toBe(0);
    expect(keywordFrustration('STOP CHANGING THE TESTS')).toBe(2);
    expect(keywordFrustration('Again? Tests before the commit.')).toBe(1);
  });

  test('rule_violated needs two shared words, else none', () => {
    const options: Pair[] = [['run-tests-before-commit', 'Run the full test suite before every commit.'], ['none', 'no rule']];
    expect(keywordRuleViolated('You committed before running the tests. Run the suite first.', options)).toBe('run-tests-before-commit');
    expect(keywordRuleViolated('Nice work.', options)).toBe('none');
  });
});

describe('score', () => {
  const row = (uuid: string, labeler: string, value: string, options_hash: string | null = 'h'): ScoredRow => ({
    native_session_id: 's', user_entry_uuid: uuid, question_id: 'q', question_version: 'v1', labeler, value, options_hash,
  });
  const key = [row('1', 'key', 'a'), row('2', 'key', 'b'), row('3', 'key', 'b'), row('4', 'key', 'b')];

  test('the baseline is computed on the rows the labeler was compared on', () => {
    // The labeler joined only units 1 and 2: the majority there is a tie, broken by value, not the key's overall "b".
    const [s] = score([row('1', 'kw', 'a'), row('2', 'kw', 'a')], key);
    expect(s).toMatchObject({ keyRows: 4, compared: 2, agree: 1, majority: 'a', majorityHits: 1 });
  });

  test('a value chosen from a different option set does not count as agreeing', () => {
    const [s] = score([row('1', 'kw', 'a', 'other-options'), row('2', 'kw', 'b')], key);
    expect(s).toMatchObject({ compared: 2, agree: 1, hashMismatch: 1 });
  });
});
