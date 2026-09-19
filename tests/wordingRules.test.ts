import { describe, expect, test } from 'bun:test';
import { findings, headNoun, registerMismatch, sentencesOf, silenceThenSpeech, unattributedDialogue } from '../src/wordingRules.ts';

// Made up for these tests; not from any prompt bank.
const ATTRIBUTED = '[Shot 1] A fisher in a yellow slicker (S1) says: <d>[English] Tie it off. Now.</d> Her hands drop.';
const UNATTRIBUTED = '[Shot 1] A fisher in a yellow slicker leans out and says: <d>[English] Tie it off.</d> Her hands drop.';

describe('sentencesOf', () => {
  test('dialogue is one token, so its punctuation cannot split a sentence', () => {
    const sentences = sentencesOf(ATTRIBUTED);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]!.dialogue).toEqual([0]);
    expect(sentences[1]!.text).toBe('Her hands drop.');
  });
});

describe('headNoun', () => {
  test('takes the last word of the opening noun phrase', () => {
    expect(headNoun('A young sonar operator wearing heavy headphones sits hunched.')).toBe('operator');
    expect(headNoun('The cook produces no vocal sound, arms folded.')).toBe('cook');
    expect(headNoun('Rain falls.')).toBeUndefined();
  });
});

describe('unattributedDialogue', () => {
  // The owner's rule: a line needs an id only when it is genuinely unclear who
  // speaks. A pronoun is clear enough in a two-hander.
  test('stays quiet when the sentence names the speaker, by id, pronoun or role', () => {
    expect(unattributedDialogue([ATTRIBUTED])).toEqual([]);
    expect(unattributedDialogue([UNATTRIBUTED])).toEqual([]);
    expect(unattributedDialogue(['[Shot 1] A fisher (S1) coils rope. She says at once: <d>[English] Done.</d>'])).toEqual([]);
    expect(unattributedDialogue(['[Shot 1] A fisher with a low voice (S1) coils rope. [Shot 2] The fisher calls out: <d>[English] Done.</d>'])).toEqual([]);
    expect(unattributedDialogue(['[Shot 1] Two dockers (S1,S2) chant together: <d>[English] Heave.</d>'])).toEqual([]);
  });

  test('fires when nothing before the line says who is speaking', () => {
    const shots = ['[Shot 1] A fisher with a low voice (S1) coils rope. As the winch reaches the top of its travel, a voice carries over the water: <d>[English] Done.</d>'];
    expect(unattributedDialogue(shots)).toHaveLength(1);
  });

  test('a name that appears only after the line does not attribute it', () => {
    const shots = ['[Shot 1] A fisher with a low voice (S1) coils rope. The rope goes taut: <d>[English] Done.</d> The fisher looks up.'];
    expect(unattributedDialogue(shots)).toHaveLength(1);
  });
});

describe('silenceThenSpeech', () => {
  test('fires when the silent character speaks in a later shot', () => {
    const shots = [
      '[Shot 1] A cook in a white apron produces no vocal sound, arms folded.',
      '[Shot 2] The cook (S2) answers: <d>[English] I took nothing.</d>',
    ];
    expect(silenceThenSpeech(shots)[0]!.evidence).toContain('cook');
  });

  test('stays quiet when the silent character stays silent', () => {
    const shots = [
      '[Shot 1] A cook in a white apron produces no vocal sound, arms folded.',
      '[Shot 2] A waiter at the pass (S2) answers: <d>[English] I took nothing.</d>',
    ];
    expect(silenceThenSpeech(shots)).toEqual([]);
  });
});

describe('registerMismatch', () => {
  test("fires when a male register meets the shot's own feminine words", () => {
    const shot = '[Shot 1] An operative with a low raspy baritone (S1) says: <d>[English] Go.</d> Her shoulders brace.';
    expect(registerMismatch([shot])[0]!.evidence).toBe('baritone with Her');
  });

  test('stays quiet when the register agrees, in either direction', () => {
    expect(registerMismatch(['[Shot 1] An operative with a low raspy contralto (S1) speaks. Her shoulders brace.'])).toEqual([]);
    expect(registerMismatch(['[Shot 1] A porter with a bright tenor (S1) speaks. His shoulders brace.'])).toEqual([]);
  });

  test('a man named in the same sentence as his own register is not a mismatch', () => {
    expect(registerMismatch(['[Shot 1] He answers in a flat baritone. Her hands drop.'])).toEqual([]);
  });
});

test('findings collects every rule', () => {
  const shots = ['[Shot 1] A fisher (S1) coils rope. The rope goes taut: <d>[English] Done.</d>'];
  expect(new Set(findings(shots).map((f) => f.rule))).toEqual(new Set(['unattributed_dialogue']));
});
