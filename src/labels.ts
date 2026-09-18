// The label contract agreed with freudagent (freudman) on 2026-09-18: the
// questions, the state a labeler sees, and the JSONL row every labeler
// writes. Harness side: hashing uses node:crypto.

import { createHash } from 'node:crypto';
import type { Unit } from './exchanges.ts';

export type Pair = [string, string];

export interface QuestionDef {
  question_id: string;
  question_version: string;
  type: 'choice' | 'score';
  text: string;
  /** Ordered [label, description] pairs; null for rule_violated, whose options depend on the unit. */
  options: Pair[] | [number, string][] | null;
}

export const QUESTIONS: readonly QuestionDef[] = [
  {
    question_id: 'user_response',
    question_version: 'v1',
    type: 'choice',
    text: "How does the user's reply respond to the assistant's turn?",
    options: [
      ['approve', 'accepts or confirms what the assistant did or proposed'],
      ['correct', 'says something the assistant did or said is wrong and must change'],
      ['redirect_scope', 'keeps the task but changes its scope, priority or direction'],
      ['question', 'asks something without judging the work'],
      ['new_task', 'starts unrelated work'],
      ['continue', 'tells the assistant to proceed, with no judgment'],
      ['other', 'none of the above'],
    ],
  },
  {
    question_id: 'correction_kind',
    question_version: 'v1',
    type: 'choice',
    text: 'If the reply corrects the assistant, what kind of correction is it?',
    options: [
      ['process', 'how the work was done (steps, order, workflow)'],
      ['fact', 'something stated was untrue'],
      ['style', 'wording, formatting or tone'],
      ['scope', 'did too much, too little, or the wrong thing'],
      ['verification', 'claimed something without checking it'],
      ['tool_use', 'used the wrong tool or misused one'],
      ['other', 'none of the above'],
    ],
  },
  {
    question_id: 'rule_violated',
    question_version: 'v1',
    type: 'choice',
    text: 'Which of the listed rules, if any, does the reply say the assistant broke?',
    options: null,
  },
  {
    question_id: 'frustration',
    question_version: 'v1',
    type: 'score',
    text: 'How frustrated does the user sound?',
    options: [
      [0, 'calm, matter-of-fact'],
      [1, 'frustrated but civil'],
      [2, 'very angry'],
    ],
  },
];

export const NONE_RULE: Pair = ['none', 'the reply points at no listed rule'];

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * sha256 of the options as sent: JSON of the [label, description] pairs with
 * no spaces, UTF-8. Byte-identical to Python's json.dumps(pairs,
 * ensure_ascii=False, separators=(",", ":")). Text Python cannot encode (a
 * lone surrogate) is refused, so the two sides cannot disagree silently.
 */
export function optionsHash(pairs: readonly Pair[]): string {
  // Checked on the text, not the JSON: JSON.stringify escapes a lone
  // surrogate to ASCII, where Python would emit it raw and then fail to encode.
  if (pairs.some((pair) => pair.some((text) => !text.isWellFormed()))) throw new Error('options hold a lone surrogate');
  return sha256(JSON.stringify(pairs));
}

/** A rule as it stood on a date, for the as-of option set. */
export interface RuleVersion {
  project_dir: string;
  rule_id: string;
  statement: string;
  effective_from: string;
  effective_to: string | null;
}

/**
 * The rules in force in a project on a unit's date, sorted by id, with
 * "none" last. Dates compare as YYYY-MM-DD strings: in force from
 * effective_from, up to but not including effective_to.
 */
export function asOfOptions(history: readonly RuleVersion[], project: string | null, timestamp: string | null): Pair[] | undefined {
  if (project === null || timestamp === null) return undefined;
  const day = timestamp.slice(0, 10);
  const inForce = history.filter((r) => r.project_dir === project && r.effective_from <= day && (r.effective_to === null || day < r.effective_to));
  const pairs = inForce.map((r): Pair => [r.rule_id, r.statement]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return [...pairs, NONE_RULE];
}

/** Characters kept of each state field; longer text is cut and the state marked truncated. */
export const FIELD_LIMIT = 8000;

/** What any labeler sees for a unit: only text the person typed. */
export interface State {
  previous_prompt: string | null;
  reply: string;
}

/**
 * A field as a labeler gets it: cut at `FIELD_LIMIT` UTF-16 units without
 * splitting a character, and well formed, so a Python labeler can encode it.
 */
function field(text: string): string {
  let cut = text.length > FIELD_LIMIT ? text.slice(0, FIELD_LIMIT) : text;
  const last = cut.charCodeAt(cut.length - 1);
  if (cut.length < text.length && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.toWellFormed();
}

export function stateOf(unit: Unit): { state: State; truncated: boolean } {
  const state: State = { previous_prompt: unit.previous_prompt === null ? null : field(unit.previous_prompt), reply: field(unit.reply) };
  const truncated = (unit.previous_prompt?.length ?? 0) > FIELD_LIMIT || unit.reply.length > FIELD_LIMIT;
  return { state, truncated };
}

export type LabelerKind = 'model' | 'human' | 'rule' | 'key';

export interface LabelRow {
  unit_type: Unit['unit_type'];
  source: string;
  native_session_id: string;
  user_entry_uuid: string;
  assistant_entry_uuid: string | null;
  copies: number;
  question_id: string;
  question_version: string;
  options_hash: string | null;
  labeler_kind: LabelerKind;
  labeler: string;
  labeler_version: string;
  value: string | number;
  probability: number | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  input_content_hash: string;
  state_truncated: boolean;
  labeled_at: string;
}

/** The options a unit is asked for a question, or undefined when the question is not asked of it. */
export function optionsFor(question: QuestionDef, unit: Unit, history: readonly RuleVersion[] | undefined): Pair[] | null | undefined {
  if (question.question_id === 'rule_violated') return history ? asOfOptions(history, unit.project_name, unit.timestamp) : undefined;
  if (question.type === 'score') return null;
  return question.options as Pair[];
}

/** One question put to a labeler for a unit, with the options it is asked over (null for a score). */
export interface Ask {
  question: QuestionDef;
  options: Pair[] | null;
}

/** A labeler's answer to one question. Probabilities are a model's; rules and people leave them out. */
export interface Answer {
  value: string | number;
  probability?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

/** A labeler's answers for one unit, with the version that produced them, or a reason it gave none. */
export type LabelOutcome = { version: string; answers: ReadonlyMap<string, Answer> } | { fallback: string };

export interface Labeler {
  kind: LabelerKind;
  name: string;
  /** Answers the asks it can for one unit's state; a question it leaves out is not labeled. */
  label(state: State, asks: readonly Ask[]): Promise<LabelOutcome>;
}

/** The questions a unit is asked, with their options. */
export function asksFor(unit: Unit, history: readonly RuleVersion[] | undefined): Ask[] {
  return QUESTIONS.flatMap((question) => {
    const options = optionsFor(question, unit, history);
    return options === undefined ? [] : [{ question, options }];
  });
}

/**
 * Every label row one labeler writes for one unit, or the reason it wrote
 * none. `clock` stamps `labeled_at` when the answers arrive.
 */
export async function labelUnit(
  unit: Unit,
  labeler: Labeler,
  source: string,
  history: readonly RuleVersion[] | undefined,
  clock: () => string,
): Promise<{ rows: LabelRow[]; fallback?: string }> {
  if (unit.unit_type !== 'exchange') return { rows: [] };
  const { state, truncated } = stateOf(unit);
  const asks = asksFor(unit, history);
  const outcome = await labeler.label(state, asks);
  if ('fallback' in outcome) return { rows: [], fallback: outcome.fallback };
  const labeledAt = clock();
  const inputHash = sha256(JSON.stringify(state));
  const rows: LabelRow[] = [];
  for (const { question, options } of asks) {
    const answer = outcome.answers.get(question.question_id);
    if (!answer) continue;
    rows.push({
      unit_type: unit.unit_type,
      source,
      native_session_id: unit.native_session_id,
      user_entry_uuid: unit.user_entry_uuid,
      assistant_entry_uuid: unit.assistant_entry_uuid,
      copies: unit.copies,
      question_id: question.question_id,
      question_version: question.question_version,
      options_hash: options === null ? null : optionsHash(options),
      labeler_kind: labeler.kind,
      labeler: labeler.name,
      labeler_version: outcome.version,
      value: answer.value,
      probability: answer.probability ?? null,
      probabilities: answer.probabilities ?? null,
      confidence: answer.confidence ?? null,
      input_content_hash: inputHash,
      state_truncated: truncated,
      labeled_at: labeledAt,
    });
  }
  return { rows };
}

/** The questions file written beside every label file. */
export function questionsJsonl(): string {
  return QUESTIONS.map((q) => JSON.stringify(q)).join('\n') + '\n';
}
