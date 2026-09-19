// An H3 prompt's text, split into what experiment 10 asks about: the main
// description field and its shots. Pure: text in, structure out.

export type PromptKind = 'base' | 'ref2va';

export interface ParsedPrompt {
  kind: PromptKind;
  /** The main field's text, label removed. */
  description: string;
  /** Each shot's text with its `[Shot N]` header. Text before `[Shot 1]` stays with shot 1. */
  shots: string[];
}

const MAIN_FIELD: Record<PromptKind, string> = {
  base: 'integrated_multimodal_description:',
  ref2va: 'detailed_description:',
};
const NEXT_FIELD = 'overall_soundscape:';

/** The prompt's main field and shots, or undefined when it has no main field. */
export function parsePrompt(text: string): ParsedPrompt | undefined {
  const kind: PromptKind | undefined = text.includes(MAIN_FIELD.ref2va) ? 'ref2va' : text.includes(MAIN_FIELD.base) ? 'base' : undefined;
  if (!kind) return undefined;
  const start = text.indexOf(MAIN_FIELD[kind]) + MAIN_FIELD[kind].length;
  const end = text.indexOf(NEXT_FIELD, start);
  const description = text.slice(start, end < 0 ? undefined : end).trim();

  // Each shot is a slice of the description, verbatim apart from its outer
  // whitespace. A preamble (ref2va's style sentence) is not a shot: the first
  // slice starts at the top, so it opens shot 1.
  const headers = [...description.matchAll(/\[Shot \d+\]/g)].map((match) => match.index);
  const starts = [0, ...headers.slice(1)];
  const shots = starts.map((start, i) => description.slice(start, starts[i + 1] ?? description.length).trim()).filter((shot) => shot !== '');
  return { kind, description, shots };
}
