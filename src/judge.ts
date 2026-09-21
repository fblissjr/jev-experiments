// Human labels, made cheap and never blocking (VISION.md, "Labeling never
// blocks"). Pure: units, branch rows and earlier labels in; a queue order, the
// next question, and label rows out. experiments/judge.ts serves it as a local
// page.
//
// A label is a LabelRow with labeler_kind human, so everything that scores
// label rows scores these too. Rows are only ever appended: a later label on
// the same unit and question supersedes an earlier one, and both stay on disk.

import { createHash } from 'node:crypto';
import type { BranchRow } from './branches.ts';
import { optionsHash, QUESTIONS, stateOf, type LabelRow, type Pair, type QuestionDef, type State } from './labels.ts';

/** A unit to be judged: its keys and the text a labeler sees. */
export interface JudgeUnit {
  source: string;
  native_session_id: string;
  user_entry_uuid: string;
  assistant_entry_uuid: string | null;
  copies: number;
  previous_prompt: string | null;
  reply: string;
}

/** One question as the page asks it: options as [label, description], a score's levels as strings. */
export interface JudgeAsk {
  question_id: string;
  question_version: string;
  type: 'choice' | 'score';
  text: string;
  options: Pair[];
  /** As the label contract hashes it; null for a score. */
  options_hash: string | null;
}

const askOf = (q: QuestionDef): JudgeAsk => {
  const options: Pair[] = q.type === 'score' ? (q.options as [number, string][]).map(([level, d]) => [String(level), d]) : (q.options as Pair[]);
  return { question_id: q.question_id, question_version: q.question_version, type: q.type, text: q.text, options, options_hash: q.type === 'score' ? null : optionsHash(options) };
};

/**
 * The questions the page asks, in order. rule_violated is left out: its
 * options are the rules in force on the reply's day, which the page does not
 * know. correction_kind is asked only of a reply labeled a correction.
 */
export const JUDGE_ASKS: readonly JudgeAsk[] = ['user_response', 'correction_kind', 'frustration'].map((id) => askOf(QUESTIONS.find((q) => q.question_id === id)!));

export const unitKey = (u: Pick<JudgeUnit, 'native_session_id' | 'user_entry_uuid'>) => `${u.native_session_id}|${u.user_entry_uuid}`;

/** A number in [0, 1) fixed by the text, so a split or an order is the same on every run. */
function fraction(text: string): number {
  return parseInt(createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8), 16) / 2 ** 32;
}

/** The share of units held out as the test. A normative setting, not an observation. */
export const TEST_SHARE = 0.2;

/** Whether a unit is in the held-out test slice. Fixed by its key, never by what anyone answered. */
export const splitOf = (key: string, share = TEST_SHARE): 'test' | 'dev' => (fraction(`split-v1|${key}`) < share ? 'test' : 'dev');

export interface QueueEntry {
  unit: JudgeUnit;
  split: 'test' | 'dev';
  priority: number;
  /** Why it sits where it does, for the page's footer. */
  reason: string;
}

/**
 * How much a label on this unit would teach: one point for each question
 * whose labelers' top answers differ, plus how close the closest call a model
 * made was (1 minus the gap between its top two options).
 */
function priorityOf(rows: readonly BranchRow[]): { priority: number; reason: string } {
  if (rows.length === 0) return { priority: 0, reason: 'no answers to compare yet' };
  const byQuestion = new Map<string, BranchRow[]>();
  for (const r of rows) (byQuestion.get(r.question_id) ?? byQuestion.set(r.question_id, []).get(r.question_id)!).push(r);
  let disagreements = 0;
  let closest = { margin: Infinity, question: '' };
  const disagreeOn: string[] = [];
  for (const [question, qrows] of byQuestion) {
    const tops = new Set(qrows.filter((r) => r.is_top).map((r) => r.option));
    if (tops.size > 1) {
      disagreements += 1;
      disagreeOn.push(question);
    }
    const byLabeler = new Map<string, number[]>();
    for (const r of qrows.filter((r) => r.labeler_kind === 'model')) (byLabeler.get(r.labeler) ?? byLabeler.set(r.labeler, []).get(r.labeler)!).push(r.p);
    for (const ps of byLabeler.values()) {
      const [first = 0, second = 0] = [...ps].sort((a, b) => b - a);
      if (first - second < closest.margin) closest = { margin: first - second, question };
    }
  }
  const close = Number.isFinite(closest.margin) ? 1 - closest.margin : 0;
  const parts = [
    ...(disagreeOn.length > 0 ? [`labelers disagree on ${disagreeOn.join(', ')}`] : []),
    ...(Number.isFinite(closest.margin) ? [`closest call ${closest.question} (gap ${closest.margin.toFixed(2)})`] : []),
  ];
  return { priority: disagreements + close, reason: parts.join('; ') || 'answers agree' };
}

/**
 * The order units are asked in. Development units go most informative first.
 * Test units go in a fixed random order, one after every `testEvery - 1`
 * development units, so the held-out slice fills evenly and stays a random
 * sample however far the labeling gets.
 */
export function orderQueue(units: readonly JudgeUnit[], branches: readonly BranchRow[], testEvery = 5): QueueEntry[] {
  const rowsByUnit = new Map<string, BranchRow[]>();
  for (const b of branches) (rowsByUnit.get(unitKey(b)) ?? rowsByUnit.set(unitKey(b), []).get(unitKey(b))!).push(b);
  const entries = units.map((unit) => ({ unit, split: splitOf(unitKey(unit)), tie: fraction(`order-v1|${unitKey(unit)}`), ...priorityOf(rowsByUnit.get(unitKey(unit)) ?? []) }));
  const dev = entries.filter((e) => e.split === 'dev').sort((a, b) => b.priority - a.priority || a.tie - b.tie);
  const test = entries.filter((e) => e.split === 'test').sort((a, b) => a.tie - b.tie);
  const out: QueueEntry[] = [];
  while (dev.length > 0 || test.length > 0) {
    const next = (out.length + 1) % testEvery === 0 ? (test.shift() ?? dev.shift()) : (dev.shift() ?? test.shift());
    const { unit, split, priority, reason } = next!;
    out.push({ unit, split, priority, reason: split === 'test' ? 'held-out test slice, random order' : reason });
  }
  return out;
}

/**
 * What a labeler sees: the model's v1 state, cut by the same code, so a
 * person's row and a model's row for one reply carry the same content hash.
 */
export function judgeState(unit: JudgeUnit): { state: State; truncated: boolean } {
  return stateOf({ ...unit, unit_type: 'exchange', project_name: null, previous_prompt_uuid: null, timestamp: null });
}

/** A person's label: a LabelRow any scorer reads, plus whether they were unsure and how long it took. */
export interface HumanLabelRow extends LabelRow {
  split: 'test' | 'dev';
  unsure: boolean;
  ms: number;
}

export function humanRow(
  unit: JudgeUnit,
  ask: JudgeAsk,
  value: string,
  opts: { labeler: string; unsure: boolean; ms: number; now: string },
): HumanLabelRow {
  if (!ask.options.some(([label]) => label === value)) throw new Error(`${ask.question_id}: ${value} is not one of its options`);
  const { state, truncated } = judgeState(unit);
  return {
    unit_type: 'exchange',
    source: unit.source,
    native_session_id: unit.native_session_id,
    user_entry_uuid: unit.user_entry_uuid,
    assistant_entry_uuid: unit.assistant_entry_uuid,
    copies: unit.copies,
    question_id: ask.question_id,
    question_version: ask.question_version,
    options_hash: ask.options_hash,
    labeler_kind: 'human',
    labeler: opts.labeler,
    labeler_version: 'judge-v1',
    value: ask.type === 'score' ? Number(value) : value,
    probability: null,
    probabilities: null,
    confidence: null,
    input_content_hash: createHash('sha256').update(JSON.stringify(state), 'utf8').digest('hex'),
    state_truncated: truncated,
    labeled_at: opts.now,
    split: splitOf(unitKey(unit)),
    unsure: opts.unsure,
    ms: opts.ms,
  };
}

/** The label in force for each unit, question version and labeler: the last one written. */
export function latestLabels<T extends Pick<LabelRow, 'native_session_id' | 'user_entry_uuid' | 'question_id' | 'question_version' | 'labeler'>>(rows: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const r of rows) latest.set(`${unitKey(r)}|${r.question_id}|${r.question_version}|${r.labeler}`, r);
  return [...latest.values()];
}

/**
 * The questions still to ask of one unit, given its answers so far (question
 * id to value) and the ones the person said they cannot tell. A correction's
 * kind is asked only once the reply has been labeled a correction.
 */
export function remainingAsks(answered: ReadonlyMap<string, string | number>, cannotTell: ReadonlySet<string>): JudgeAsk[] {
  return JUDGE_ASKS.filter((ask) => {
    if (answered.has(ask.question_id) || cannotTell.has(ask.question_id)) return false;
    if (ask.question_id === 'correction_kind') return answered.get('user_response') === 'correct';
    return true;
  });
}

/** A question a person cannot answer for a unit, recorded so it is not asked again. */
export interface CannotTell {
  native_session_id: string;
  user_entry_uuid: string;
  question_id: string;
  question_version: string;
  labeler: string;
  at: string;
}

export interface JudgeProgress {
  units: number;
  unitsDone: number;
  /** Labels given in this session. */
  labels: number;
  medianSeconds: number | null;
}

export type JudgeNext =
  | { done: false; index: number; unit: { previous_prompt: string | null; reply: string; truncated: boolean }; ask: JudgeAsk; progress: JudgeProgress }
  | { done: true; progress: JudgeProgress };

/**
 * One labeling session over a queue. It resumes from the labels already
 * written, asks what is left in queue order, and hands every new row to
 * `write`. "Later" moves a unit to the end of this session's order. "Back"
 * asks the last finished unit again from the start; the new labels supersede
 * the old ones, which stay on disk.
 */
export class JudgeSession {
  private readonly order: number[];
  private readonly answered = new Map<string, Map<string, string | number>>();
  private readonly cannotTell = new Map<string, Set<string>>();
  private readonly redo = new Map<string, Map<string, string | number>>();
  private readonly finished: string[] = [];
  private readonly sessionMs: number[] = [];

  constructor(
    readonly queue: readonly QueueEntry[],
    readonly labeler: string,
    earlier: readonly Pick<LabelRow, 'native_session_id' | 'user_entry_uuid' | 'question_id' | 'question_version' | 'labeler' | 'value'>[],
    earlierCannotTell: readonly CannotTell[],
    private readonly write: (row: HumanLabelRow) => void,
    private readonly writeCannotTell: (record: CannotTell) => void,
    private readonly now: () => string,
  ) {
    this.order = queue.map((_, i) => i);
    for (const row of latestLabels(earlier.filter((r) => r.labeler === labeler))) this.mapOf(this.answered, unitKey(row)).set(row.question_id, row.value);
    for (const record of earlierCannotTell.filter((r) => r.labeler === labeler)) this.setOf(unitKey(record)).add(record.question_id);
  }

  private mapOf(maps: Map<string, Map<string, string | number>>, key: string): Map<string, string | number> {
    return maps.get(key) ?? maps.set(key, new Map()).get(key)!;
  }

  private setOf(key: string): Set<string> {
    return this.cannotTell.get(key) ?? this.cannotTell.set(key, new Set()).get(key)!;
  }

  private remaining(key: string): JudgeAsk[] {
    return remainingAsks(this.redo.get(key) ?? this.answered.get(key) ?? new Map(), this.redo.has(key) ? new Set() : (this.cannotTell.get(key) ?? new Set()));
  }

  private progress(): JudgeProgress {
    const sorted = [...this.sessionMs].sort((a, b) => a - b);
    return {
      units: this.queue.length,
      unitsDone: this.queue.filter((e) => this.remaining(unitKey(e.unit)).length === 0).length,
      labels: this.sessionMs.length,
      medianSeconds: sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)]! / 1000,
    };
  }

  private ask(index: number, ask: JudgeAsk): JudgeNext {
    const { state, truncated } = judgeState(this.queue[index]!.unit);
    return { done: false, index, unit: { previous_prompt: state.previous_prompt, reply: state.reply, truncated }, ask, progress: this.progress() };
  }

  next(): JudgeNext {
    const redoIndex = this.order.find((i) => this.redo.has(unitKey(this.queue[i]!.unit)));
    for (const i of redoIndex === undefined ? this.order : [redoIndex, ...this.order]) {
      const [first] = this.remaining(unitKey(this.queue[i]!.unit));
      if (first) return this.ask(i, first);
    }
    return { done: true, progress: this.progress() };
  }

  private settle(key: string): void {
    if (this.remaining(key).length > 0) return;
    this.redo.delete(key);
    const at = this.finished.indexOf(key);
    if (at >= 0) this.finished.splice(at, 1);
    this.finished.push(key);
  }

  label(index: number, question_id: string, value: string, unsure: boolean, ms: number): JudgeNext {
    const entry = this.queue[index];
    const ask = JUDGE_ASKS.find((a) => a.question_id === question_id);
    if (!entry || !ask) throw new Error(`no unit ${index} or question ${question_id}`);
    const row = humanRow(entry.unit, ask, value, { labeler: this.labeler, unsure, ms, now: this.now() });
    this.write(row);
    const key = unitKey(entry.unit);
    this.mapOf(this.answered, key).set(question_id, row.value);
    this.redo.get(key)?.set(question_id, row.value);
    this.sessionMs.push(ms);
    this.settle(key);
    return this.next();
  }

  cannotTellIt(index: number, question_id: string): JudgeNext {
    const entry = this.queue[index];
    const ask = JUDGE_ASKS.find((a) => a.question_id === question_id);
    if (!entry || !ask) throw new Error(`no unit ${index} or question ${question_id}`);
    const key = unitKey(entry.unit);
    this.writeCannotTell({ native_session_id: entry.unit.native_session_id, user_entry_uuid: entry.unit.user_entry_uuid, question_id, question_version: ask.question_version, labeler: this.labeler, at: this.now() });
    this.setOf(key).add(question_id);
    this.redo.get(key)?.set(question_id, '?');
    this.settle(key);
    return this.next();
  }

  later(index: number): JudgeNext {
    const at = this.order.indexOf(index);
    if (at >= 0) this.order.push(...this.order.splice(at, 1));
    return this.next();
  }

  back(): JudgeNext {
    const key = this.finished.pop();
    if (key !== undefined) this.redo.set(key, new Map());
    return this.next();
  }
}
