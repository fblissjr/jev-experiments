// The mechanical half of experiment 10: defects a rule can find in an H3
// prompt's shot, with no model. Pure: text in, findings out.
//
// Each rule is a heuristic, not a proof. What matters is how often it fires on
// the prompts a fix commit repaired, against how often it fires on prompts
// nobody flagged; the sweep reports both.

export interface Finding {
  rule: string;
  shot: number;
  /** The words that made the rule fire. Local only: never sent anywhere. */
  evidence: string;
}

const SPEAKER_ID = /\(S\d+(?:\s*,\s*S\d+)*\)/;
const SILENCE = /produces? no vocal sound/i;
/** Registers a listener hears as male, and as female. The guide's own words. */
const MALE_REGISTER = /\b(baritone|bass|basso)\b/i;
const FEMALE_REGISTER = /\b(contralto|mezzo|mezzo-soprano|soprano)\b/i;
const MALE_WORDS = /\b(he|him|his|himself|man|men|boy|father|son|brother|gentleman|sir)\b/i;
const FEMALE_WORDS = /\b(she|her|hers|herself|woman|women|girl|mother|daughter|sister|lady|widow|madam)\b/i;

/**
 * A shot's sentences, with each `<d>…</d>` replaced by a marker, so dialogue
 * punctuation and dialogue text cannot break sentences or match a rule.
 */
export function sentencesOf(shot: string): { text: string; dialogue: number[] }[] {
  const lines: string[] = [];
  const masked = shot.replace(/<d>[\s\S]*?<\/d>/g, (line) => {
    lines.push(line);
    return `\u0000${lines.length - 1}\u0000`;
  });
  // A sentence ends at its punctuation, and also where a line of dialogue is
  // followed by narration: the prompt writes `</d> His lips press shut`, with
  // the stop inside the quote.
  return masked
    .split(/(?<=[.!?])\s+|(?<=\u0000)\s+(?=[A-Z])/)
    .filter((text) => text.trim() !== '')
    .map((text) => ({ text, dialogue: [...text.matchAll(/\u0000(\d+)\u0000/g)].map((match) => Number(match[1])) }));
}

/** The head noun of a sentence's opening noun phrase, or undefined. */
export function headNoun(sentence: string): string | undefined {
  // A shot's first sentence opens with its header, and may open with a time.
  const text = sentence.replace(/^\s*\[Shot \d+\]\s*(?:At \d+:\d+(?:\.\d+)?,\s*)?/, '');
  const match = /^\s*(?:The|A|An)\s+([\w-]+(?:\s+[\w-]+){0,4}?)\s+(?:in|with|at|on|by|behind|beside|near|wearing|holding|sits|stands|kneels|leans|crouches|produces|does|remains|stays)\b/i.exec(text);
  const phrase = match?.[1];
  return phrase?.split(/\s+/).pop()?.toLowerCase();
}

const PRONOUN = /\b(he|him|his|himself|she|her|hers|herself|they|them|their|theirs)\b/i;
/** Words an identity phrase or a camera move leaves behind that name no one. */
const NOT_A_CHARACTER = /^(voice|tone|cadence|accent|delivery|timbre|pitch|rasp|whisper|drawl|lilt|register|camera|shot|frame|lens|microphone|line|phrase|sound|music|note|rope|belt|drawer)$/i;
const SUBJECT_LABEL = /<Subject \d+>/;

/**
 * The names this prompt uses for characters who speak: the head noun of every
 * sentence that carries a speaker id, and every noun in it that a later line
 * could refer back to.
 */
export function speakerNames(shots: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const shot of shots) {
    for (const sentence of sentencesOf(shot)) {
      if (!SPEAKER_ID.test(sentence.text)) continue;
      const head = headNoun(sentence.text);
      if (head && !NOT_A_CHARACTER.test(head)) names.add(head);
      // "the lead singer with a raw tenor (S1)" also answers to "the singer".
      for (const match of sentence.text.matchAll(/\b(?:the|a|an)\s+([\w-]+(?:\s+[\w-]+){0,3}?)\s*(?=\(S|with|in|at|,)/gi)) {
        const noun = match[1]?.split(/\s+/).pop()?.toLowerCase();
        if (noun && !NOT_A_CHARACTER.test(noun)) names.add(noun);
      }
    }
  }
  return names;
}

/**
 * A line of dialogue whose sentence says nothing about who is speaking.
 *
 * The owner's rule, 2026-09-19: a speaker id is wanted when it is genuinely
 * unclear who speaks, not on every line. "She says" is clear enough in a scene
 * with one man and one woman. So a line counts only when its sentence carries
 * no speaker id, no pronoun, no subject label, and no name this prompt has
 * already used for someone who speaks.
 */
export function unattributedDialogue(shots: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const names = speakerNames(shots);
  shots.forEach((shot, i) => {
    for (const sentence of sentencesOf(shot)) {
      if (sentence.dialogue.length === 0) continue;
      // Only what comes before the line can say who is about to speak.
      const before = sentence.text.slice(0, sentence.text.indexOf('\u0000'));
      // Who the line belongs to can be said by an id, a pronoun, a subject
      // label, a name this prompt already gave a speaker, or the plain subject
      // of the sentence itself.
      const subject = headNoun(before);
      const named =
        SPEAKER_ID.test(sentence.text) ||
        PRONOUN.test(before) ||
        SUBJECT_LABEL.test(before) ||
        (subject !== undefined && !NOT_A_CHARACTER.test(subject)) ||
        [...names].some((name) => new RegExp(`\\b${name}\\b`, 'i').test(before));
      if (!named) findings.push({ rule: 'unattributed_dialogue', shot: i + 1, evidence: sentence.text.replace(/\u0000(\d+)\u0000/g, '<d>…</d>').trim() });
    }
  });
  return findings;
}

/** A character marked as producing no vocal sound who speaks later. */
export function silenceThenSpeech(shots: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const sentences = shots.flatMap((shot, i) => sentencesOf(shot).map((sentence) => ({ ...sentence, shot: i + 1 })));
  sentences.forEach((sentence, at) => {
    if (!SILENCE.test(sentence.text)) return;
    const noun = headNoun(sentence.text);
    if (!noun) return;
    const speaks = sentences
      .slice(at + 1)
      .find((later) => later.dialogue.length > 0 && SPEAKER_ID.test(later.text) && new RegExp(`\\b${noun}\\b`, 'i').test(later.text));
    if (speaks) findings.push({ rule: 'silence_then_speech', shot: sentence.shot, evidence: `${noun}: silent in shot ${sentence.shot}, speaks in shot ${speaks.shot}` });
  });
  return findings;
}

/**
 * A voice register the prompt's own words contradict.
 *
 * The register belongs to one character, named once and then carried by
 * pronouns, sometimes only in a later shot. So the words consulted are: the
 * sentence naming the register, later sentences in that shot whose subject is
 * not somebody else, every sentence anywhere that names the same character,
 * and the sentence after each of those. A two-hander's other character is left
 * out, because their pronouns say nothing about this one.
 */
export function registerMismatch(shots: readonly string[]): Finding[] {
  const out: Finding[] = [];
  const all = shots.flatMap((shot, i) => sentencesOf(shot).map((sentence) => ({ ...sentence, shot: i + 1 })));
  all.forEach((sentence, at) => {
    const male = MALE_REGISTER.exec(sentence.text);
    const female = FEMALE_REGISTER.exec(sentence.text);
    if (!male && !female) return;
    const subject = headNoun(sentence.text);
    const about = [sentence.text];
    // The rest of this shot, other characters' own sentences left out.
    for (const later of all.slice(at + 1).filter((s) => s.shot === sentence.shot)) {
      const other = headNoun(later.text);
      if (other === undefined || other === subject) about.push(later.text);
    }
    // Wherever the character is named again, and whatever follows it.
    if (subject) {
      const names = new RegExp(`\\b${subject}\\b`, 'i');
      all.forEach((other, index) => {
        if (index <= at || !names.test(other.text)) return;
        about.push(other.text);
        const next = all[index + 1];
        if (next && headNoun(next.text) === undefined) about.push(next.text);
      });
    }
    const text = about.join(' ');
    if (male && FEMALE_WORDS.test(text) && !MALE_WORDS.test(text)) out.push({ rule: 'register_mismatch', shot: sentence.shot, evidence: `${male[1]} with ${FEMALE_WORDS.exec(text)![1]}` });
    if (female && MALE_WORDS.test(text) && !FEMALE_WORDS.test(text)) out.push({ rule: 'register_mismatch', shot: sentence.shot, evidence: `${female[1]} with ${MALE_WORDS.exec(text)![1]}` });
  });
  return out;
}

export const RULES = [unattributedDialogue, silenceThenSpeech, registerMismatch] as const;

/** Every rule's findings for one prompt's shots. */
export function findings(shots: readonly string[]): Finding[] {
  return RULES.flatMap((rule) => rule(shots));
}
