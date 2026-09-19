import { describe, expect, test } from 'bun:test';
import { parsePrompt } from '../src/h3Prompt.ts';
import { DESCRIPTION_QUESTIONS, SHOT_QUESTIONS, questionsFor, unitsFor } from '../src/wordingQuestions.ts';

// Made up for these tests; not from any prompt bank.
const BASE = [
  'integrated_multimodal_description: [Shot 1] Live-action, a harbour at dusk. A fisher in a yellow slicker (S1) turns to the deckhand and says: <d>[English] Tie it off.</d> [Shot 2] The shot cuts to the deckhand at the stern (S2), who says: <d>[English] Done.</d>',
  '',
  'overall_soundscape: Gulls and slapping water.',
  '',
  'non_diegetic_music: N/A',
].join('\n');

const REF = [
  'subject_definitions: <Subject 1> a fisher.',
  'detailed_description: Watercolor, soft paper grain. [Shot 1] <Subject 1> coils a rope at the stern. [Shot 2] The shot cuts to a close-up of the knot.',
  'overall_soundscape: Wind.',
].join('\n');

describe('parsePrompt', () => {
  test('takes the main field up to the soundscape, and splits it into shots with their headers', () => {
    const parsed = parsePrompt(BASE)!;
    expect(parsed.kind).toBe('base');
    expect(parsed.description.startsWith('[Shot 1] Live-action')).toBe(true);
    expect(parsed.description.includes('overall_soundscape')).toBe(false);
    expect(parsed.shots).toHaveLength(2);
    expect(parsed.shots[1]!.startsWith('[Shot 2] The shot cuts')).toBe(true);
  });

  test("keeps ref2va's style sentence with shot 1", () => {
    const parsed = parsePrompt(REF)!;
    expect(parsed.kind).toBe('ref2va');
    expect(parsed.shots).toHaveLength(2);
    expect(parsed.shots[0]!.startsWith('Watercolor, soft paper grain. [Shot 1]')).toBe(true);
  });

  test('a main field with no shot headers is one shot', () => {
    expect(parsePrompt('integrated_multimodal_description: A still pond.\n\noverall_soundscape: Frogs.')!.shots).toEqual(['A still pond.']);
  });

  test('text with no main field is not a prompt', () => {
    expect(parsePrompt('overall_soundscape: Wind.')).toBeUndefined();
  });
});

describe('unitsFor', () => {
  test('one unit per shot and one for the description, each state holding exactly one field', () => {
    const units = unitsFor('harbour', 'before', BASE);
    expect(units.map((u) => [u.kind, u.shot])).toEqual([['shot', 1], ['shot', 2], ['description', null]]);
    for (const unit of units) expect(Object.keys(unit.state)).toEqual([unit.kind]);
  });

  test('nothing but the text goes in the state: no id, no version', () => {
    for (const unit of unitsFor('harbour-secret-id', 'before-secret-version', BASE)) {
      const sent = JSON.stringify({ state: unit.state, questions: questionsFor(unit) });
      expect(sent.includes('harbour-secret-id')).toBe(false);
      expect(sent.includes('before-secret-version')).toBe(false);
    }
  });

  test('a shot is asked the shot questions, a description the description question', () => {
    const [shot, , description] = unitsFor('harbour', 'same', BASE);
    expect(Object.keys(questionsFor(shot!))).toEqual(Object.keys(SHOT_QUESTIONS));
    expect(Object.keys(questionsFor(description!))).toEqual(Object.keys(DESCRIPTION_QUESTIONS));
  });
});
