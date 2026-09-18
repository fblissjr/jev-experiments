// Experiment 01: compaction replay. See README.md beside this file.
//
//   bun run replay [options] <session.jsonl>...
//
//   --arms a,b,...     default: every arm in ARMS below except jev, then builtin
//                      add jev to ask the real model (needs TYPESAFE_API_KEY and --egress)
//   --kinds a,b        real, synthetic (default both)
//   --threshold N      context tokens a synthetic point waits for (default 120000)
//   --min-suffix N     fewest messages after a point (default 10)
//   --seed S           varies the random arms' draws (default none)
//   --until TIME       ignore log records stamped after this ISO time, so runs repeat
//   --egress           confirms the sessions named may be sent to TypeSafe (jev arm only)
//   --out PATH         default runs/01-compaction-replay/<time>.json
//
// Prints and writes counts only, never transcript text.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import type { SessionMessage } from 'claude-code';
import { constantAsk, constantScorer, oracleScorer, randomScorer, sdkAsk, type SdkUsage } from '../../src/askers.ts';
import { collectCalls, protections, type Call, type Protection } from '../../src/compact/calls.ts';
import { applyDecisions, decide, STUB_LIMIT, type Action, type RuleActions, type Scorer } from '../../src/compact/decide.ts';
import { DEFAULT_JEV_OPTIONS, jevScorer, type JevUsage } from '../../src/compact/jev.ts';
import { emptyLoss, featuresOf, Future, inputText, measureLoss, totalChars, type Loss } from '../../src/metrics.ts';
import { findPoints, type Point } from '../../src/points.ts';
import { readTranscript } from '../../src/transcript.ts';

// fast-jev-compaction's defaults at e3f262a.
const PRESERVE_RECENT = 6;
const KEEP_THRESHOLD = 0.5;
const HEAD_CHARS = 300;
const MIN_REDUCTION = 0.25;

const jevUsage: SdkUsage = { requests: 0, inputTokens: 0, outputTokens: 0, ms: 0 };

/** What an arm's scorer may use from the point it runs on. */
interface ArmContext {
  seed: string;
  needed: (call: Call) => boolean;
  onUsage: (usage: JevUsage) => void;
}

/** An arm: which protection rules apply and with what action, then what scores the rest. */
interface ArmSpec {
  rules: RuleActions | false;
  scorer: (context: ArmContext) => Scorer;
}

const dropRest = () => constantScorer(0);

// The rules the Jev arm runs with, shared by every arm it is judged against so
// the comparison stays like for like. Edits are stubbed: see
// docs/2026-09-18-compaction-replay.md.
const JEV_RULES: RuleActions = { edit: 'stub' };

// One line per arm. `builtin` is not here: it replays what the engine did.
const ARMS = {
  'drop-all': { rules: false, scorer: dropRest },
  protect: { rules: {}, scorer: dropRest },
  'protect-stub': { rules: { edit: 'stub' }, scorer: dropRest },
  'protect-stub-read': { rules: { edit: 'stub', 'read-before-edit': 'truncate' }, scorer: dropRest },
  'truncate-all': { rules: JEV_RULES, scorer: () => constantScorer(1, 0) },
  'fake-0': { rules: JEV_RULES, scorer: (c) => jevScorer(constantAsk(0), DEFAULT_JEV_OPTIONS, c.onUsage) },
  'random-25': { rules: JEV_RULES, scorer: (c) => randomScorer(0.25, c.seed) },
  'random-50': { rules: JEV_RULES, scorer: (c) => randomScorer(0.5, c.seed) },
  oracle: { rules: JEV_RULES, scorer: (c) => oracleScorer(c.needed) },
  jev: { rules: JEV_RULES, scorer: (c) => jevScorer(sdkAsk(jevUsage), DEFAULT_JEV_OPTIONS, c.onUsage) },
} satisfies Record<string, ArmSpec>;

type Arm = keyof typeof ARMS | 'builtin';
const ALL_ARMS = [...Object.keys(ARMS), 'builtin'] as Arm[];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    arms: { type: 'string', default: ALL_ARMS.filter((arm) => arm !== 'jev').join(',') },
    kinds: { type: 'string', default: 'real,synthetic' },
    threshold: { type: 'string', default: '120000' },
    'min-suffix': { type: 'string', default: '10' },
    seed: { type: 'string', default: '' },
    until: { type: 'string' },
    egress: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

const arms = values.arms.split(',').map((arm) => arm.trim()) as Arm[];
for (const arm of arms) if (!ALL_ARMS.includes(arm)) throw new Error(`unknown arm: ${arm}`);
const kinds = new Set(values.kinds.split(',').map((kind) => kind.trim()));
const threshold = Number(values.threshold);
const minSuffix = Number(values['min-suffix']);
if (positionals.length === 0) {
  console.error('usage: bun run replay [options] <session.jsonl>...');
  process.exit(2);
}
if (arms.includes('jev')) {
  if (!process.env['TYPESAFE_API_KEY']) throw new Error('the jev arm needs TYPESAFE_API_KEY');
  if (!values.egress) throw new Error(`the jev arm sends conversation state for ${positionals.length} session(s) to TypeSafe; pass --egress to confirm`);
}

type Counts = { kept: number; stubbed: number; truncated: number; dropped: number };
type ArmResult =
  | { fallback: string }
  | (Counts & {
      charsBefore: number;
      charsAfter: number;
      /** Tenths histograms of the scores, for arms that ask. */
      keepCallHistogram?: number[];
      keepResultHistogram?: number[];
      jev?: JevUsage & { inputTokens: number; ms: number };
    } & Loss);

interface PointRecord {
  session: string;
  kind: Point['kind'];
  segment: number;
  contextTokens?: number;
  enginePostTokens?: number;
  prefixMessages: number;
  suffixMessages: number;
  calls: number;
  pinned: number;
  ruled: Partial<Record<Protection, number>>;
  /** Characters each rule kept: results and tool inputs. */
  ruledChars: Partial<Record<Protection, number>>;
  arms: Partial<Record<Arm, ArmResult>>;
}

function counts(actions: readonly Action[]): Counts {
  const count = (action: Action) => actions.filter((a) => a === action).length;
  return { kept: count('keep'), stubbed: count('stub'), truncated: count('truncate'), dropped: count('drop') };
}

function histogram(values: number[]): number[] {
  const bins = new Array<number>(10).fill(0);
  for (const value of values) bins[Math.min(9, Math.max(0, Math.floor(value * 10)))]! += 1;
  return bins;
}

async function runArm(arm: Arm, point: Point, future: Future, context: Omit<ArmContext, 'onUsage'>): Promise<ArmResult | undefined> {
  const charsBefore = totalChars(point.prefix);

  if (arm === 'builtin') {
    const compaction = point.compaction;
    if (!compaction || compaction.summary === undefined) return undefined;
    const compacted: SessionMessage[] = [{ role: 'user', text: compaction.summary, toolUses: [] }, ...compaction.preserved.map((m) => m.message)];
    const calls = collectCalls(point.prefix, 0);
    // Kept: the call or its result survives in a preserved message.
    const kept = new Set(compacted.flatMap((m) => [...m.toolUses.map((u) => u.tool_use_id), ...(m.toolResults ?? []).map((r) => r.tool_use_id)]));
    const actions = calls.map((call): Action => (kept.has(call.tool_use_id) ? 'keep' : 'drop'));
    return { ...counts(actions), charsBefore, charsAfter: totalChars(compacted), ...measureLoss(calls, compacted, future) };
  }

  const spec: ArmSpec = ARMS[arm];
  let usage: JevUsage | undefined;
  const before = { ...jevUsage };
  const scorer = spec.scorer({ ...context, onUsage: (u) => (usage = u) });
  const decided = await decide(point.prefix, { preserveRecent: PRESERVE_RECENT, threshold: KEEP_THRESHOLD, rules: spec.rules }, scorer);
  if ('fallback' in decided) return { fallback: decided.fallback };
  const compacted = applyDecisions(point.prefix, decided.decisions, HEAD_CHARS);
  const result: ArmResult = {
    ...counts(decided.decisions.map((d) => d.action)),
    charsBefore,
    charsAfter: totalChars(compacted),
    ...measureLoss(decided.calls, compacted, future),
  };
  const asked = usage as JevUsage | undefined;
  if (asked) {
    const scored = decided.decisions.flatMap((d) => (d.scores ? [d.scores] : []));
    result.keepCallHistogram = histogram(scored.map((s) => s.keepCall));
    result.keepResultHistogram = histogram(scored.map((s) => s.keepResult));
    result.jev = { ...asked, inputTokens: jevUsage.inputTokens - before.inputTokens, ms: Math.round(jevUsage.ms - before.ms) };
  }
  return result;
}

const records: PointRecord[] = [];
const versions = new Set<string>();
let sessionsRead = 0;
let sessionsWithPoints = 0;
let unreadable = 0;
const noCandidates: Record<Point['kind'], number> = { real: 0, synthetic: 0 };

for (const [index, path] of positionals.entries()) {
  if (index > 0 && index % 200 === 0) console.error(`${index} of ${positionals.length} sessions`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    unreadable += 1;
    continue;
  }
  sessionsRead += 1;
  const transcript = readTranscript(text, { until: values.until });
  const points = findPoints(transcript, { threshold, minSuffix }).filter((point) => kinds.has(point.kind));
  if (points.length === 0) continue;
  sessionsWithPoints += 1;
  for (const version of transcript.versions) versions.add(version);
  const session = basename(path, '.jsonl');

  for (const point of points) {
    const calls = collectCalls(point.prefix, PRESERVE_RECENT);
    // Nothing for any arm to decide; counting it would only dilute reduction.
    if (!calls.some((call) => !call.pinned)) {
      noCandidates[point.kind] += 1;
      continue;
    }
    const future = new Future(point.suffix);
    const ruledMap = protections(calls);
    const ruled: Partial<Record<Protection, number>> = {};
    const ruledChars: Partial<Record<Protection, number>> = {};
    for (const call of calls) {
      const rule = ruledMap.get(call.tool_use_id);
      if (!rule || call.pinned) continue;
      ruled[rule] = (ruled[rule] ?? 0) + 1;
      ruledChars[rule] = (ruledChars[rule] ?? 0) + call.resultText.length + JSON.stringify(call.input).length;
    }
    // The oracle's view of need: re-run later, or a distinctive string of the
    // result or the input used later that the message text, which no arm
    // removes, does not already hold. It loses nothing on the calls it decides;
    // what it does lose comes from the rules (stubbed edits).
    const prose = point.prefix.map((m) => m.text).join('\n');
    const needed = (call: Call) =>
      future.rerun(call.tool, call.input) ||
      featuresOf(`${call.resultText}\n${inputText(call.input)}`).some((f) => future.usedLater(f) && !prose.includes(f));

    const record: PointRecord = {
      session,
      kind: point.kind,
      segment: point.segment,
      contextTokens: point.contextTokens,
      enginePostTokens: point.compaction?.postTokens,
      prefixMessages: point.prefix.length,
      suffixMessages: point.suffix.length,
      calls: calls.length,
      pinned: calls.filter((call) => call.pinned).length,
      ruled,
      ruledChars,
      arms: {},
    };
    for (const arm of arms) {
      // An error on one point (a Jev request failing, a missing answer) is
      // recorded as that point's result, so a run keeps what it already paid for.
      try {
        const result = await runArm(arm, point, future, { needed, seed: `${values.seed}:${session}:${point.segment}:${point.kind}` });
        if (result) record.arms[arm] = result;
      } catch (error) {
        record.arms[arm] = { fallback: `error: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}` };
      }
    }
    records.push(record);
  }
}

// Totals per kind and arm. Every count sums, so a new Loss field needs no change here.
const SUMMED = ['kept', 'stubbed', 'truncated', 'dropped', 'charsBefore', 'charsAfter', ...(Object.keys(emptyLoss()) as (keyof Loss)[])] as const;
type Total = { points: number; fallbacks: Record<string, number>; belowMinReduction: number } & Record<(typeof SUMMED)[number], number>;
const totals: Record<string, Partial<Record<Arm, Total>>> = {};
for (const record of records) {
  const byArm = (totals[record.kind] ??= {});
  for (const [arm, result] of Object.entries(record.arms) as [Arm, ArmResult][]) {
    const total = (byArm[arm] ??= { points: 0, fallbacks: {}, belowMinReduction: 0, ...(Object.fromEntries(SUMMED.map((key) => [key, 0])) as Record<(typeof SUMMED)[number], number>) });
    if ('fallback' in result) {
      total.fallbacks[result.fallback] = (total.fallbacks[result.fallback] ?? 0) + 1;
      continue;
    }
    total.points += 1;
    if (result.charsBefore > 0 && (result.charsBefore - result.charsAfter) / result.charsBefore < MIN_REDUCTION) total.belowMinReduction += 1;
    for (const key of SUMMED) total[key] += result[key];
  }
}

const pct = (part: number, whole: number) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : '-');
const COLUMNS: [string, (t: Total) => string | number][] = [
  ['points', (t) => t.points],
  ['kept', (t) => t.kept],
  ['stub', (t) => t.stubbed],
  ['trunc', (t) => t.truncated],
  ['dropped', (t) => t.dropped],
  ['reduction', (t) => pct(t.charsBefore - t.charsAfter, t.charsBefore)],
  ['lost', (t) => t.lost],
  ['recall', (t) => t.recall],
  ['reread', (t) => t.reread],
  ['either', (t) => t.either],
  ['in-lost', (t) => t.inputsLost],
  ['in-recall', (t) => t.inputRecall],
  ['needed', (t) => t.needed],
  ['fallbacks', (t) => Object.entries(t.fallbacks).map(([why, n]) => `${why}:${n}`).join(' ') || '-'],
];
console.log(`sessions read: ${sessionsRead}; with points: ${sessionsWithPoints}; unreadable: ${unreadable}`);
console.log(`points skipped, no unpinned tool call: real ${noCandidates.real}, synthetic ${noCandidates.synthetic}`);
console.log(`options: preserve ${PRESERVE_RECENT} newest, threshold ${KEEP_THRESHOLD}, head ${HEAD_CHARS} chars, stub over ${STUB_LIMIT}; synthetic at ${threshold} tokens; min suffix ${minSuffix}${values.until ? `; until ${values.until}` : ''}`);
for (const [kind, byArm] of Object.entries(totals)) {
  const points = records.filter((record) => record.kind === kind);
  console.log(`\n${kind} points: ${points.length}; tool calls ${points.reduce((s, r) => s + r.calls, 0)}, pinned ${points.reduce((s, r) => s + r.pinned, 0)}`);
  console.log(['arm'.padEnd(17), ...COLUMNS.map(([head]) => head)].join('\t'));
  for (const arm of ALL_ARMS) {
    const t = byArm[arm];
    if (t) console.log([arm.padEnd(17), ...COLUMNS.map(([, cell]) => cell(t))].join('\t'));
  }
}
if (jevUsage.requests > 0) console.log(`\nJev: ${jevUsage.requests} requests, ${jevUsage.inputTokens} input tokens, mean ${Math.round(jevUsage.ms / jevUsage.requests)} ms`);

const out = values.out ?? `runs/01-compaction-replay/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      experiment: '01-compaction-replay',
      options: { arms, kinds: [...kinds], threshold, minSuffix, seed: values.seed, until: values.until, preserveRecent: PRESERVE_RECENT, keepThreshold: KEEP_THRESHOLD, headChars: HEAD_CHARS, stubLimit: STUB_LIMIT },
      claudeCodeVersions: [...versions].sort(),
      sessions: { given: positionals.length, read: sessionsRead, withPoints: sessionsWithPoints, unreadable },
      skippedNoCandidates: noCandidates,
      totals,
      jev: jevUsage,
      points: records,
    },
    null,
    1,
  ),
);
console.log(`\nwrote ${out}`);
