import { describe, expect, test } from 'bun:test';
import type { BranchRow } from '../src/branches.ts';
import { humanRow, JUDGE_ASKS, JudgeSession, latestLabels, orderQueue, remainingAsks, splitOf, unitKey, type CannotTell, type HumanLabelRow, type JudgeNext, type JudgeUnit } from '../src/judge.ts';
import { optionsHash, QUESTIONS, type Pair } from '../src/labels.ts';

const unit = (id: string): JudgeUnit => ({ source: 'test', native_session_id: 's', user_entry_uuid: id, assistant_entry_uuid: null, copies: 1, previous_prompt: 'fix it', reply: `reply ${id}` });
const branch = (id: string, labeler: string, kind: BranchRow['labeler_kind'], question: string, option: string, p: number, is_top: boolean): BranchRow => ({
  native_session_id: 's', user_entry_uuid: id, question_id: question, question_version: 'v1', options_hash: 'h', labeler_kind: kind, labeler, labeler_version: '1', option, p, is_top,
});
const ask = (id: string) => JUDGE_ASKS.find((a) => a.question_id === id)!;

describe('splitOf', () => {
  test('the held-out slice is fixed by the key and near its share', () => {
    const keys = Array.from({ length: 2000 }, (_, i) => `s|u${i}`);
    expect(keys.map((k) => splitOf(k))).toEqual(keys.map((k) => splitOf(k)));
    const share = keys.filter((k) => splitOf(k) === 'test').length / keys.length;
    expect(share).toBeGreaterThan(0.17);
    expect(share).toBeLessThan(0.23);
  });
});

describe('orderQueue', () => {
  const units = Array.from({ length: 40 }, (_, i) => unit(`u${i}`));
  const dev = units.filter((u) => splitOf(unitKey(u)) === 'dev');
  const [disputed, close, calm] = [dev[0]!, dev[1]!, dev[2]!];
  const branches = [
    // Jev and the rule disagree on this one.
    branch(disputed.user_entry_uuid, 'jev', 'model', 'user_response', 'correct', 0.9, true),
    branch(disputed.user_entry_uuid, 'jev', 'model', 'user_response', 'approve', 0.1, false),
    branch(disputed.user_entry_uuid, 'keyword', 'rule', 'user_response', 'approve', 1, true),
    // They agree, but Jev's top two are close.
    branch(close.user_entry_uuid, 'jev', 'model', 'user_response', 'correct', 0.52, true),
    branch(close.user_entry_uuid, 'jev', 'model', 'user_response', 'approve', 0.48, false),
    branch(close.user_entry_uuid, 'keyword', 'rule', 'user_response', 'correct', 1, true),
    // They agree, and Jev is sure.
    branch(calm.user_entry_uuid, 'jev', 'model', 'user_response', 'approve', 0.99, true),
    branch(calm.user_entry_uuid, 'jev', 'model', 'user_response', 'correct', 0.01, false),
    branch(calm.user_entry_uuid, 'keyword', 'rule', 'user_response', 'approve', 1, true),
  ];
  const queue = orderQueue(units, branches, 5);

  test('development units come most informative first: a disagreement, then a close call', () => {
    const devOrder = queue.filter((e) => e.split === 'dev').map((e) => e.unit.user_entry_uuid);
    expect(devOrder.slice(0, 3)).toEqual([disputed.user_entry_uuid, close.user_entry_uuid, calm.user_entry_uuid]);
    expect(queue.find((e) => e.unit === disputed)!.reason).toContain('labelers disagree on user_response');
  });

  test('every fifth unit is from the held-out slice, in an order no answer can move', () => {
    expect(queue.filter((_, i) => (i + 1) % 5 === 0).slice(0, 4).every((e) => e.split === 'test')).toBe(true);
    const testOrder = (bs: BranchRow[]) => orderQueue(units, bs, 5).filter((e) => e.split === 'test').map((e) => e.unit.user_entry_uuid);
    const testUnit = units.find((u) => splitOf(unitKey(u)) === 'test')!;
    const loud = [branch(testUnit.user_entry_uuid, 'jev', 'model', 'user_response', 'correct', 0.5, true), branch(testUnit.user_entry_uuid, 'keyword', 'rule', 'user_response', 'approve', 1, true)];
    expect(testOrder(loud)).toEqual(testOrder([]));
    expect(queue).toHaveLength(units.length);
  });
});

describe('humanRow', () => {
  test("a person's label is a label row any scorer reads, with the contract's options hash", () => {
    const row = humanRow(unit('u1'), ask('user_response'), 'correct', { labeler: 'owner', unsure: true, ms: 1200, now: '2026-09-21T00:00:00Z' });
    const contract = QUESTIONS.find((q) => q.question_id === 'user_response')!;
    expect(row).toMatchObject({ labeler_kind: 'human', labeler: 'owner', value: 'correct', question_version: 'v1', unsure: true, ms: 1200, probability: null });
    expect(row.options_hash).toBe(optionsHash(contract.options as Pair[]));
    expect(row.split).toBe(splitOf('s|u1'));
  });

  test('a score is stored as its level number, and an answer outside the options is refused', () => {
    expect(humanRow(unit('u1'), ask('frustration'), '2', { labeler: 'owner', unsure: false, ms: 1, now: 't' }).value).toBe(2);
    expect(() => humanRow(unit('u1'), ask('user_response'), 'maybe', { labeler: 'owner', unsure: false, ms: 1, now: 't' })).toThrow('not one of its options');
  });
});

describe('latestLabels', () => {
  test('a later label on the same unit and question supersedes the earlier one', () => {
    const first = humanRow(unit('u1'), ask('user_response'), 'approve', { labeler: 'owner', unsure: false, ms: 1, now: 't1' });
    const second = humanRow(unit('u1'), ask('user_response'), 'correct', { labeler: 'owner', unsure: false, ms: 1, now: 't2' });
    const other = humanRow(unit('u2'), ask('user_response'), 'approve', { labeler: 'owner', unsure: false, ms: 1, now: 't1' });
    expect(latestLabels([first, other, second]).map((r) => [r.user_entry_uuid, r.value])).toEqual([['u1', 'correct'], ['u2', 'approve']]);
  });
});

describe('remainingAsks', () => {
  const ids = (answered: [string, string | number][], cannotTell: string[] = []) => remainingAsks(new Map(answered), new Set(cannotTell)).map((a) => a.question_id);
  test('the kind of correction is asked only after the reply is labeled a correction', () => {
    expect(ids([])).toEqual(['user_response', 'frustration']);
    expect(ids([['user_response', 'approve']])).toEqual(['frustration']);
    expect(ids([['user_response', 'correct']])).toEqual(['correction_kind', 'frustration']);
  });
  test('a question the person cannot tell is not asked again', () => {
    expect(ids([['user_response', 'correct']], ['correction_kind'])).toEqual(['frustration']);
  });
});

describe('JudgeSession', () => {
  const units = ['a', 'b', 'c'].map(unit);
  const queue = units.map((u) => ({ unit: u, split: 'dev' as const, priority: 0, reason: '' }));
  const session = (earlier: HumanLabelRow[] = []) => {
    const written: HumanLabelRow[] = [];
    const skipped: CannotTell[] = [];
    const s = new JudgeSession(queue, 'owner', earlier, [], (r) => written.push(r), (r) => skipped.push(r), () => 't');
    return { s, written, skipped };
  };
  const at = (next: JudgeNext) => (next.done ? 'done' : `${next.unit.reply}:${next.ask.question_id}`);

  test('each unit is asked its questions in turn, the kind of correction only after a correction', () => {
    const { s, written } = session();
    expect(at(s.next())).toBe('reply a:user_response');
    expect(at(s.label(0, 'user_response', 'correct', false, 900))).toBe('reply a:correction_kind');
    expect(at(s.label(0, 'correction_kind', 'style', false, 900))).toBe('reply a:frustration');
    expect(at(s.label(0, 'frustration', '1', true, 900))).toBe('reply b:user_response');
    expect(written.map((r) => [r.user_entry_uuid, r.question_id, r.value, r.unsure])).toEqual([
      ['a', 'user_response', 'correct', false], ['a', 'correction_kind', 'style', false], ['a', 'frustration', 1, true],
    ]);
  });

  test('a session resumes after the units already labeled', () => {
    const earlier = [
      humanRow(units[0]!, ask('user_response'), 'approve', { labeler: 'owner', unsure: false, ms: 1, now: 't' }),
      humanRow(units[0]!, ask('frustration'), '0', { labeler: 'owner', unsure: false, ms: 1, now: 't' }),
      // someone else's label does not count as ours
      humanRow(units[1]!, ask('user_response'), 'approve', { labeler: 'other', unsure: false, ms: 1, now: 't' }),
    ];
    const { s } = session(earlier);
    expect(at(s.next())).toBe('reply b:user_response');
  });

  test('later moves a unit to the end; back asks the last finished unit again, and the new label supersedes', () => {
    const { s, written } = session();
    expect(at(s.later(0))).toBe('reply b:user_response');
    s.label(1, 'user_response', 'approve', false, 1);
    expect(at(s.label(1, 'frustration', '0', false, 1))).toBe('reply c:user_response');
    expect(at(s.back())).toBe('reply b:user_response');
    s.label(1, 'user_response', 'question', false, 1);
    expect(at(s.label(1, 'frustration', '0', false, 1))).toBe('reply c:user_response');
    expect(latestLabels(written).filter((r) => r.user_entry_uuid === 'b' && r.question_id === 'user_response').map((r) => r.value)).toEqual(['question']);
    expect(written.filter((r) => r.user_entry_uuid === 'b' && r.question_id === 'user_response')).toHaveLength(2);
  });

  test('a question the person cannot tell is recorded and skipped', () => {
    const { s, skipped } = session();
    expect(at(s.cannotTellIt(0, 'user_response'))).toBe('reply a:frustration');
    expect(skipped).toHaveLength(1);
    s.label(0, 'frustration', '0', false, 1);
    expect(s.next().done).toBe(false);
  });
});
