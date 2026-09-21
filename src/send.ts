// Bodies built outside this harness, and a send that transmits stored bytes.
//
// A body can be built anywhere, for example by duckdb-jev's jev_request() in
// a SQL query. `importLines` brings such bodies into a ledger dry run, where
// the owner reviews and approves them as any other. `sendApproved` then POSTs
// each approved body exactly as stored: no parse and re-serialize, so the
// bytes that go out are the bytes that were approved. The POST and the sleep
// are passed in, so the loop is tested without a network.
//
// Harness only: it works on the ledger, which uses bun:sqlite.

import { refuseState } from './egress.ts';
import type { Ledger, PayloadInput } from './ledger.ts';

/** Stands in for the key wherever headers are stored; the send puts the key in its place. */
export const KEY_PLACEHOLDER = '<TYPESAFE_API_KEY, not stored>';

/** The headers a generic send transmits, as a dry run stores them. */
export const JEV_HEADERS: Readonly<Record<string, string>> = {
  Authorization: `Bearer ${KEY_PLACEHOLDER}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

export const jevDestination = (baseURL: string) => `POST ${baseURL.replace(/\/+$/, '')}/v1/systemone`;

const QUESTION_TYPES = new Set(['choice', 'score', 'noul']);

/** A Jev request body, parsed. Throws unless it is exactly `{state, questions, model}` with typed questions. */
export function parseBody(body: string): { state: unknown; questions: Record<string, unknown>; model: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('the body is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('the body is not a JSON object');
  const fields = Object.keys(parsed).sort().join(',');
  if (fields !== 'model,questions,state') throw new Error(`the body's fields are ${fields}, not exactly model, questions and state`);
  const { state, questions, model } = parsed as Record<string, unknown>;
  if (typeof model !== 'string' || model === '') throw new Error('model is not a non-empty string');
  if (typeof questions !== 'object' || questions === null || Array.isArray(questions) || Object.keys(questions).length === 0) {
    throw new Error('questions is not a non-empty object');
  }
  for (const [name, question] of Object.entries(questions)) {
    const type = (question as { type?: unknown } | null)?.type;
    if (typeof type !== 'string' || !QUESTION_TYPES.has(type)) throw new Error(`question ${name} has no type choice, score or noul`);
  }
  return { state, questions: questions as Record<string, unknown>, model };
}

/**
 * Why a body must not be sent, or undefined. The credential and key check
 * runs over the whole body, questions included, not only the state: a body
 * built elsewhere can carry text in either.
 */
export const refuseBody = (body: { state: unknown; questions: unknown }, apiKey: string | undefined) =>
  refuseState({ state: body.state, questions: body.questions }, apiKey);

/**
 * JSONL lines `{unit_key, meta, body, source?}` as dry-run payloads. A line
 * that is malformed, or whose body is not a Jev request, stops the import
 * with its line number: the producer is wrong, and half a dry run is worse
 * than none. A body that trips the credential check is kept, refused, so the
 * owner sees it in review.
 */
export function importLines(text: string, apiKey: string | undefined): PayloadInput[] {
  const out: PayloadInput[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const where = `line ${i + 1}`;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`${where}: not JSON`);
    }
    const { unit_key, meta, body, source } = row;
    if (typeof unit_key !== 'string' || unit_key === '') throw new Error(`${where}: unit_key is not a non-empty string`);
    if (seen.has(unit_key)) throw new Error(`${where}: unit_key ${unit_key} appears twice`);
    seen.add(unit_key);
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) throw new Error(`${where}: meta is not an object`);
    if (typeof body !== 'string') throw new Error(`${where}: body is not a string holding the exact request`);
    if (source !== undefined && (typeof source !== 'object' || source === null || Array.isArray(source))) throw new Error(`${where}: source is not an object`);
    let parsed: ReturnType<typeof parseBody>;
    try {
      parsed = parseBody(body);
    } catch (error) {
      throw new Error(`${where}: ${(error as Error).message}`);
    }
    out.push({
      unit_key,
      meta: meta as Record<string, unknown>,
      ...(source === undefined ? {} : { source: source as Record<string, unknown> }),
      body,
      refused: refuseBody(parsed, apiKey) ?? null,
    });
  });
  return out;
}

/** What a POST came back with. It throws on a network failure or timeout instead. */
export interface PostResult {
  status: number;
  text: string;
  /** Seconds, from a Retry-After header. */
  retryAfter?: number;
}

export type Post = (url: string, headers: Record<string, string>, body: string) => Promise<PostResult>;

/** The real POST: fetch, sending `body` as given, with a 30-second timeout. */
export const fetchPost: Post = async (url, headers, body) => {
  const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
  const retryAfter = Number(response.headers.get('retry-after'));
  return { status: response.status, text: await response.text(), ...(retryAfter > 0 ? { retryAfter } : {}) };
};

export interface SendOptions {
  apiKey: string;
  /** Where this send would go; it must be where the dry run was built for. */
  destination: string;
  code_version: string;
  post: Post;
  sleep?: (ms: number) => Promise<void>;
  /** Send at most this many of the pending bodies. */
  limit?: number;
}

export interface SendSummary {
  run_id: string;
  from_run: string;
  approved: number;
  alreadySent: number;
  attempted: number;
  ok: number;
  errors: number;
  refused: number;
  left: number;
  inputTokens: number;
  models: string[];
}

/** Three attempts, as @typesafe-ai/sdk makes: the first and two retries. */
const ATTEMPTS = 3;
const retryable = (status: number) => status === 408 || status === 429 || status >= 500;
const backoff = (attempt: number, retryAfter?: number) => (retryAfter ? Math.min(60, retryAfter) * 1000 : 500 * 2 ** (attempt - 1));

/**
 * Send an approved dry run's pending bodies, one at a time, as a new send run.
 * Each body goes out byte for byte as stored, after the ledger's hash and
 * digest checks and a fresh credential check with the key loaded. Every body
 * attempted gets one response row: ok, refused, or the error it ended on.
 */
export async function sendApproved(ledger: Ledger, from_run: string, options: SendOptions): Promise<SendSummary> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const dry = ledger.run(from_run);
  if (!dry || dry.kind !== 'dry-run') throw new Error(`${from_run} is not a dry run`);
  if (dry.destination !== options.destination) throw new Error(`the dry run was built for ${dry.destination}, and this send would go to ${options.destination}`);
  if (!dry.destination.startsWith('POST ')) throw new Error(`destination ${dry.destination} is not a POST`);
  if (dry.headers['Authorization'] !== `Bearer ${KEY_PLACEHOLDER}`) throw new Error('the dry run stores no key placeholder in its Authorization header');
  const url = dry.destination.slice('POST '.length);
  const headers = Object.fromEntries(Object.entries(dry.headers).map(([name, value]) => [name, value.replace(KEY_PLACEHOLDER, () => options.apiKey)]));

  const approved = ledger.approvedPayloads(from_run);
  const done = ledger.alreadySent(from_run);
  const pending = approved.filter((p) => !done.has(p.seq));
  const batch = pending.slice(0, options.limit ?? Infinity);
  const run_id = ledger.startRun({ experiment: dry.experiment, kind: 'send', destination: dry.destination, headers: dry.headers, source: dry.source, code_version: options.code_version, from_run });

  const summary: SendSummary = { run_id, from_run, approved: approved.length, alreadySent: done.size, attempted: batch.length, ok: 0, errors: 0, refused: 0, left: pending.length - batch.length, inputTokens: 0, models: [] };
  const models = new Set<string>();
  for (const p of batch) {
    const record = (status: string, extra: { model?: string | null; ms?: number; input_tokens?: number | null; response?: unknown } = {}) =>
      ledger.recordResponse(run_id, { seq: p.seq, body_sha256: p.body_sha256, status, model: extra.model ?? null, ms: extra.ms ?? 0, input_tokens: extra.input_tokens ?? null, response: extra.response ?? null });
    const refused = refuseBody(parseBody(p.body), options.apiKey);
    if (refused) {
      summary.refused += 1;
      record(`refused:${refused}`);
      continue;
    }
    const started = performance.now();
    for (let attempt = 1; ; attempt += 1) {
      let result: PostResult;
      try {
        result = await options.post(url, headers, p.body);
      } catch (error) {
        if (attempt < ATTEMPTS) {
          await sleep(backoff(attempt));
          continue;
        }
        summary.errors += 1;
        record('error:network', { ms: Math.round(performance.now() - started), response: { error: String((error as Error).message ?? error) } });
        break;
      }
      const ms = Math.round(performance.now() - started);
      if (result.status === 200) {
        let parsed: { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown } };
        try {
          parsed = JSON.parse(result.text);
        } catch {
          parsed = {};
        }
        if (typeof parsed.answers !== 'object' || parsed.answers === null) {
          summary.errors += 1;
          record('error:bad-response', { ms, response: { error: result.text.slice(0, 2000) } });
          break;
        }
        const model = typeof parsed.model === 'string' ? parsed.model : null;
        const inputTokens = typeof parsed.usage?.input_tokens === 'number' ? parsed.usage.input_tokens : null;
        if (model) models.add(model);
        summary.ok += 1;
        summary.inputTokens += inputTokens ?? 0;
        record('ok', { model, ms, input_tokens: inputTokens, response: parsed.answers });
        break;
      }
      if (retryable(result.status) && attempt < ATTEMPTS) {
        await sleep(backoff(attempt, result.retryAfter));
        continue;
      }
      summary.errors += 1;
      record(`error:http-${result.status}`, { ms, response: { error: result.text.slice(0, 2000) } });
      break;
    }
  }
  summary.models = [...models];
  return summary;
}
