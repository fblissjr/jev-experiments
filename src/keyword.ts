// The no-model control for experiment 09: keyword rules over the reply.
// Pure. Deliberately plain, so a model has something honest to beat.

import type { Labeler, Pair, QuestionDef, State } from './labels.ts';

const lower = (text: string) => text.trim().toLowerCase();

export function keywordUserResponse(reply: string): string {
  const t = lower(reply);
  if (/^(no\b|nope\b|don'?t\b|do not\b|stop\b|wrong\b|undo\b|revert\b)/.test(t)) return 'correct';
  if (/(that'?s (wrong|not right|not what)|not what i (asked|wanted|meant)|i (didn'?t|never) ask|i (said|told you)|you (didn'?t|forgot|missed|broke|shouldn'?t)|why did you)/.test(t)) return 'correct';
  if (/^(continue|keep going|go on|proceed|carry on|resume)\b/.test(t)) return 'continue';
  if (/^(yes|yep|yeah|ok|okay|sure|great|perfect|nice|lgtm|looks good|sounds good|good|do it|go ahead|ship it|thanks|thank you|approved|agreed)\b/.test(t)) return 'approve';
  if (/^(instead|focus on|only do|just do|skip|first,? )/.test(t)) return 'redirect_scope';
  if (t.endsWith('?') || /^(what|why|how|where|when|which|who|can|could|does|do|is|are|should|would)\b/.test(t)) return 'question';
  return 'other';
}

export function keywordCorrectionKind(reply: string): string {
  const t = lower(reply);
  if (/(did you (test|check|run|verify)|verif|\bcheck|confirm|\btests?\b|actually run|prove)/.test(t)) return 'verification';
  if (/(\btool\b|instead of (cat|grep|head|npm|pip)|\b(uv|bun|npm|pip|cat|head|grep)\b)/.test(t)) return 'tool_use';
  if (/(wording|tone|format|emoji|bold|italic|heading|sentence case|title case|verbose|shorter|concise|plain language)/.test(t)) return 'style';
  if (/(only|just|didn'?t ask|not asked|too much|scope|unrelated|leave .* alone|don'?t (change|touch))/.test(t)) return 'scope';
  if (/(\bfirst\b|\bbefore\b|\border\b|\bstep|\bcommit|\bpush|\bbranch|workflow|ask (me )?before)/.test(t)) return 'process';
  if (/(wrong|incorrect|not true|isn'?t|doesn'?t exist|that'?s not)/.test(t)) return 'fact';
  return 'other';
}

/** Mostly capitals over enough letters to be shouting, not a couple of acronyms (README, JSON). */
function shouting(text: string): boolean {
  const letters = text.match(/[A-Za-z]/g)?.length ?? 0;
  const upper = text.match(/[A-Z]/g)?.length ?? 0;
  return letters >= 12 && upper / letters > 0.6;
}

export function keywordFrustration(reply: string): number {
  const t = reply.trim();
  if (/!{2,}/.test(t) || shouting(t) || /\b(wtf|ffs|seriously\?)/i.test(t)) return 2;
  if (/!/.test(t) || /\b(again|still|already (told|said)|i said|i told you|come on|please just)\b/i.test(t)) return 1;
  return 0;
}

const STOP = new Set(['that', 'this', 'with', 'from', 'your', 'have', 'what', 'when', 'will', 'into', 'than', 'then', 'them', 'they', 'were', 'been', 'only', 'every', 'never', 'always', 'before', 'after', 'there', 'about', 'should', 'would', 'could']);

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)));
}

/** The listed rule sharing the most words with the reply (at least two), else "none". */
export function keywordRuleViolated(reply: string, options: readonly Pair[]): string {
  const said = words(reply);
  let best = 'none';
  let bestScore = 1;
  for (const [label, description] of options) {
    if (label === 'none') continue;
    const rule = words(`${label.replace(/-/g, ' ')} ${description}`);
    let score = 0;
    for (const w of rule) if (said.has(w)) score += 1;
    if (score > bestScore) {
      best = label;
      bestScore = score;
    }
  }
  return best;
}

export const KEYWORD_LABELER: Labeler = {
  kind: 'rule',
  name: 'keyword',
  version: 'keyword-v1',
  label(question: QuestionDef, options: Pair[] | null, state: State) {
    switch (question.question_id) {
      case 'user_response':
        return keywordUserResponse(state.reply);
      case 'correction_kind':
        return keywordCorrectionKind(state.reply);
      case 'frustration':
        return keywordFrustration(state.reply);
      case 'rule_violated':
        return options ? keywordRuleViolated(state.reply, options) : undefined;
      default:
        return undefined;
    }
  },
};
