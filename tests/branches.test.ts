import { describe, expect, test } from 'bun:test';
import { optionCalibration, prevalence, toBranches, tvd, type BranchSource } from '../src/branches.ts';
import type { ScoredRow } from '../src/scoring.ts';

const label = (uuid: string, labeler: string, value: string | number, probabilities: Record<string, number> | null, options_hash: string | null = 'h'): BranchSource => ({
  native_session_id: 's', user_entry_uuid: uuid, question_id: 'q', question_version: 'v1', options_hash, labeler_kind: probabilities === null ? 'rule' : 'model', labeler, labeler_version: `${labeler}-1`, value, probabilities,
});
const keyRow = (uuid: string, value: string, options_hash: string | null = 'h'): ScoredRow => ({
  native_session_id: 's', user_entry_uuid: uuid, question_id: 'q', question_version: 'v1', labeler: 'key', value, options_hash,
});

describe('toBranches', () => {
  test("a model's distribution becomes one row per option, normalized, with its answer marked", () => {
    const rows = toBranches([label('1', 'jev', 'a', { a: 0.7, b: 0.29 })]);
    expect(rows.map((r) => [r.option, r.is_top])).toEqual([['a', true], ['b', false]]);
    expect(rows[0]!.p + rows[1]!.p).toBeCloseTo(1, 12);
    expect(rows[0]!.p).toBeCloseTo(0.7 / 0.99, 12);
  });

  test('a score keeps its level strings, and a numeric answer marks its level', () => {
    const rows = toBranches([label('1', 'jev', 1, { '0': 0.2, '1': 0.5, '2': 0.3 }, null)]);
    expect(rows.filter((r) => r.is_top).map((r) => r.option)).toEqual(['1']);
  });

  test("a rule's answer is one row at p 1", () => {
    expect(toBranches([label('1', 'keyword', 'b', null)]).map((r) => [r.option, r.p, r.is_top])).toEqual([['b', 1, true]]);
  });

  test('every row keeps the origin of the label it came from', () => {
    const rows = toBranches([label('1', 'jev', 'a', { a: 0.6, b: 0.4 }), label('1', 'keyword', 'b', null)]);
    expect(rows.map((r) => [r.labeler, r.labeler_kind])).toEqual([['jev', 'model'], ['jev', 'model'], ['keyword', 'rule']]);
  });

  test('a distribution without the answer, or with a negative probability, is refused', () => {
    expect(() => toBranches([label('1', 'jev', 'c', { a: 0.5, b: 0.5 })])).toThrow('has no probability');
    expect(() => toBranches([label('1', 'jev', 'a', { a: 1.2, b: -0.2 })])).toThrow('negative');
  });
});

describe('prevalence', () => {
  // The key splits evenly. The labeler picks "a" every time but gives "b" 0.4:
  // counting says all "a"; summing says 60/40, much closer to the key.
  const key = [keyRow('1', 'a'), keyRow('2', 'a'), keyRow('3', 'b'), keyRow('4', 'b')];
  const doubtful = ['1', '2', '3', '4'].map((u) => label(u, 'jev', 'a', { a: 0.6, b: 0.4 }));

  test('summed probabilities and counted top choices differ, and each is measured against the key', () => {
    const [p] = prevalence(toBranches(doubtful), key);
    expect(p).toMatchObject({ compared: 4, agree: 2, majority: 'a' });
    expect(p!.counted).toEqual({ a: 1 });
    expect(p!.tvdCounted).toBeCloseTo(0.5, 12);
    // Summing only the top option would give {a: 0.6} and a distance of 0.3.
    expect(p!.tvdSummed).toBeCloseTo(0.1, 12);
    expect(p!.gain).toBeCloseTo(0.4, 12);
    expect(p!.tvdMajority).toBeCloseTo(0.5, 12);
  });

  test('a unit asked over a different option set is left out and counted', () => {
    const rows = [...doubtful.slice(0, 3), label('4', 'jev', 'a', { a: 0.6, b: 0.4 }, 'other')];
    const [p] = prevalence(toBranches(rows), key);
    expect(p).toMatchObject({ compared: 3, hashMismatch: 1 });
  });

  test('the bootstrap is seeded: the same input gives the same interval', () => {
    const [first] = prevalence(toBranches(doubtful), key, 500);
    const [second] = prevalence(toBranches(doubtful), key, 500);
    expect(first!.gainInterval).toEqual(second!.gainInterval);
    expect(first!.gainInterval[0]).toBeLessThanOrEqual(first!.gainInterval[1]);
  });

  test('tvd is half the summed absolute difference', () => {
    expect(tvd({ a: 1 }, { b: 1 })).toBe(1);
    expect(tvd({ a: 0.5, b: 0.5 }, { a: 0.5, b: 0.5 })).toBe(0);
  });
});

describe('optionCalibration', () => {
  test('every option is a forecast that it is the key answer, bucketed by tenths', () => {
    const rows = toBranches([label('1', 'jev', 'a', { a: 0.8, b: 0.2 }), label('2', 'jev', 'a', { a: 0.8, b: 0.2 })]);
    const [c] = optionCalibration(rows, [keyRow('1', 'a'), keyRow('2', 'b')]);
    expect(c).toMatchObject({ n: 4, hits: 2 });
    expect(c!.meanP).toBeCloseTo(0.5, 12);
    expect(c!.buckets.map((b) => [b.from, b.n, b.agree])).toEqual([[0.2, 2, 1], [0.8, 2, 1]]);
    // Each bucket is off by 0.3 and holds half the options.
    expect(c!.ece).toBeCloseTo(0.3, 12);
  });
});
