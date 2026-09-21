// The branch table (experiment 12): one row per unit, question, labeler and
// option, with the probability the labeler gave that option. Pure.
//
// A model's label row carries a distribution over every option it was
// offered. A rule's or a key's carries one answer, which becomes one row with
// p 1. Prevalence and calibration are computed from these rows against an
// answer key, joined the way src/scoring.ts joins: on the unit and question
// version, and only where the option sets match.

import type { LabelRow } from './labels.ts';
import { rowKey, type Bucket, type RowKeyed, type ScoredRow } from './scoring.ts';

export interface BranchRow extends RowKeyed {
  options_hash: string | null;
  labeler: string;
  labeler_version: string;
  /** The option's label; for a score, the level as a string. */
  option: string;
  /** Its probability, normalized over the unit's options. */
  p: number;
  /** Whether it is the answer the labeler gave. */
  is_top: boolean;
}

export type BranchSource = Pick<
  LabelRow,
  'native_session_id' | 'user_entry_uuid' | 'question_id' | 'question_version' | 'options_hash' | 'labeler' | 'labeler_version' | 'value' | 'probabilities'
>;

/**
 * Every label row as branch rows. A distribution is divided by its sum, since
 * Jev rounds each probability to two places. A distribution that does not
 * hold the labeler's own answer, or holds a negative probability, is refused:
 * the rows would say something the labeler did not.
 */
export function toBranches(rows: readonly BranchSource[]): BranchRow[] {
  const out: BranchRow[] = [];
  for (const row of rows) {
    const base = {
      native_session_id: row.native_session_id,
      user_entry_uuid: row.user_entry_uuid,
      question_id: row.question_id,
      question_version: row.question_version,
      options_hash: row.options_hash,
      labeler: row.labeler,
      labeler_version: row.labeler_version,
    };
    const top = String(row.value);
    if (row.probabilities === null || row.probabilities === undefined) {
      out.push({ ...base, option: top, p: 1, is_top: true });
      continue;
    }
    const entries = Object.entries(row.probabilities);
    const where = `${rowKey(row)} ${row.labeler}`;
    if (entries.some(([, p]) => !(p >= 0))) throw new Error(`${where}: a probability is negative or not a number`);
    const total = entries.reduce((sum, [, p]) => sum + p, 0);
    if (!(total > 0)) throw new Error(`${where}: the probabilities sum to ${total}`);
    if (!(top in row.probabilities)) throw new Error(`${where}: the answer "${top}" has no probability`);
    for (const [option, p] of entries) out.push({ ...base, option, p: p / total, is_top: option === top });
  }
  return out;
}

/** Share of units per option. */
export type Shares = Record<string, number>;

/** Total variation distance: half the summed absolute difference. 0 is identical, 1 disjoint. */
export function tvd(a: Shares, b: Shares): number {
  let sum = 0;
  for (const option of new Set([...Object.keys(a), ...Object.keys(b)])) sum += Math.abs((a[option] ?? 0) - (b[option] ?? 0));
  return sum / 2;
}

export interface Prevalence {
  question_id: string;
  labeler: string;
  /** Key rows this labeler answered over the same option set. */
  compared: number;
  /** Key rows it answered over a different option set; left out. */
  hashMismatch: number;
  /** Compared rows whose top option is the key's answer. */
  agree: number;
  key: Shares;
  counted: Shares;
  summed: Shares;
  /** The key's most common answer on the compared rows. */
  majority: string;
  tvdCounted: number;
  tvdSummed: number;
  /** The majority class as an estimate: every unit given `majority`. */
  tvdMajority: number;
  /** tvdCounted minus tvdSummed: above zero when summing is closer to the key. */
  gain: number;
  /** 90% bootstrap interval of `gain`, resampling compared units. */
  gainInterval: [number, number];
}

interface Compared {
  keyValue: string;
  branches: readonly BranchRow[];
}

function estimate(units: readonly Compared[]): { key: Shares; counted: Shares; summed: Shares } {
  const key: Shares = {};
  const counted: Shares = {};
  const summed: Shares = {};
  const n = units.length;
  for (const unit of units) {
    key[unit.keyValue] = (key[unit.keyValue] ?? 0) + 1 / n;
    for (const b of unit.branches) {
      summed[b.option] = (summed[b.option] ?? 0) + b.p / n;
      if (b.is_top) counted[b.option] = (counted[b.option] ?? 0) + 1 / n;
    }
  }
  return { key, counted, summed };
}

/** mulberry32, seeded from a string, so a rerun draws the same resamples. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Groups branch rows by (question, labeler) and joins each unit to its key row. */
function join(branches: readonly BranchRow[], key: readonly ScoredRow[]) {
  const keyByRow = new Map(key.map((r) => [rowKey(r), r]));
  const groups = new Map<string, { question_id: string; labeler: string; units: Map<string, BranchRow[]> }>();
  for (const b of branches) {
    const id = JSON.stringify([b.question_id, b.labeler]);
    const group = groups.get(id) ?? groups.set(id, { question_id: b.question_id, labeler: b.labeler, units: new Map() }).get(id)!;
    const unit = rowKey(b);
    const rows = group.units.get(unit) ?? group.units.set(unit, []).get(unit)!;
    rows.push(b);
  }
  return [...groups.values()].map((group) => {
    const compared: Compared[] = [];
    let hashMismatch = 0;
    for (const [unit, rows] of group.units) {
      const k = keyByRow.get(unit);
      if (!k) continue;
      if (k.options_hash !== rows[0]!.options_hash) hashMismatch += 1;
      else compared.push({ keyValue: String(k.value), branches: rows });
    }
    return { question_id: group.question_id, labeler: group.labeler, compared, hashMismatch };
  });
}

/**
 * Per question and labeler: the key's shares beside the labeler's counted top
 * choices and its summed probabilities, each estimate's distance from the key,
 * and how far summing gains on counting, with a bootstrap interval.
 */
export function prevalence(branches: readonly BranchRow[], key: readonly ScoredRow[], resamples = 2000): Prevalence[] {
  const out: Prevalence[] = [];
  for (const { question_id, labeler, compared, hashMismatch } of join(branches, key)) {
    if (compared.length === 0) continue;
    const point = estimate(compared);
    const [majority] = Object.entries(point.key).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
    const tvdCounted = tvd(point.key, point.counted);
    const tvdSummed = tvd(point.key, point.summed);
    const random = seeded(`${question_id}|${labeler}`);
    const gains: number[] = [];
    for (let i = 0; i < resamples; i += 1) {
      const sample = compared.map(() => compared[Math.floor(random() * compared.length)]!);
      const e = estimate(sample);
      gains.push(tvd(e.key, e.counted) - tvd(e.key, e.summed));
    }
    gains.sort((a, b) => a - b);
    out.push({
      question_id,
      labeler,
      compared: compared.length,
      hashMismatch,
      agree: compared.filter((u) => u.branches.some((b) => b.is_top && b.option === u.keyValue)).length,
      ...point,
      majority,
      tvdCounted,
      tvdSummed,
      tvdMajority: tvd(point.key, { [majority]: 1 }),
      gain: tvdCounted - tvdSummed,
      gainInterval: [gains[Math.floor(0.05 * resamples)] ?? 0, gains[Math.ceil(0.95 * resamples) - 1] ?? 0],
    });
  }
  return out;
}

export interface OptionCalibration {
  question_id: string;
  labeler: string;
  /** Options scored: every option of every compared unit. */
  n: number;
  /** Options that are the key's answer. */
  hits: number;
  meanP: number;
  /** Expected calibration error: each bucket's gap between hit rate and mean p, weighted by its size. */
  ece: number;
  /** In each bucket, `agree` counts options that are the key's answer. */
  buckets: Bucket[];
}

/**
 * Calibration over every option, not only the chosen one: each (unit, option,
 * p) is a forecast that the option is the key's answer. Bucketed by tenths of
 * p, as in src/scoring.ts. Only meaningful for a labeler with distributions;
 * a rule's single row at p 1 measures its accuracy and nothing else.
 */
export function optionCalibration(branches: readonly BranchRow[], key: readonly ScoredRow[]): OptionCalibration[] {
  const out: OptionCalibration[] = [];
  for (const { question_id, labeler, compared } of join(branches, key)) {
    if (compared.length === 0) continue;
    const byBucket = new Map<number, { n: number; agree: number; sum: number }>();
    let n = 0;
    let hits = 0;
    let sum = 0;
    for (const unit of compared) {
      for (const b of unit.branches) {
        const from = Math.min(9, Math.floor(b.p * 10)) / 10;
        const bucket = byBucket.get(from) ?? byBucket.set(from, { n: 0, agree: 0, sum: 0 }).get(from)!;
        const hit = b.option === unit.keyValue;
        bucket.n += 1;
        bucket.sum += b.p;
        if (hit) bucket.agree += 1;
        n += 1;
        if (hit) hits += 1;
        sum += b.p;
      }
    }
    const buckets = [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([from, b]) => ({ from, n: b.n, agree: b.agree, meanProbability: b.sum / b.n }));
    out.push({
      question_id,
      labeler,
      n,
      hits,
      meanP: sum / n,
      ece: buckets.reduce((total, b) => total + (b.n / n) * Math.abs(b.agree / b.n - b.meanProbability), 0),
      buckets,
    });
  }
  return out;
}
