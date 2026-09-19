// The egress ledger: every request an experiment would send to an outside
// service, stored as the exact body, before anything is sent. The owner reads
// a dry run with `bun run payloads`, approves it, and a send transmits only
// that run's bodies, byte for byte, recording each response beside its body.
//
// Harness only: it uses bun:sqlite. The database lives in data/, which is
// gitignored, because bodies carry whatever text an experiment sends.

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The ledger shared by every experiment, beside the repo's other local data.
 * EGRESS_LEDGER points elsewhere, for a test run that must not mix with it.
 */
export const LEDGER_PATH = process.env['EGRESS_LEDGER'] ?? new URL('../data/egress.sqlite', import.meta.url).pathname;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id       TEXT PRIMARY KEY,
  experiment   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('dry-run', 'send')),
  created_at   TEXT NOT NULL,
  destination  TEXT NOT NULL,
  headers      TEXT NOT NULL,
  source       TEXT NOT NULL,
  code_version TEXT NOT NULL,
  approved_at  TEXT,
  from_run     TEXT REFERENCES runs(run_id)
);
CREATE TABLE IF NOT EXISTS payloads (
  run_id      TEXT NOT NULL REFERENCES runs(run_id),
  seq         INTEGER NOT NULL,
  unit_key    TEXT NOT NULL,
  meta        TEXT NOT NULL,
  source      TEXT,
  body        TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  refused     TEXT,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS responses (
  run_id       TEXT NOT NULL REFERENCES runs(run_id),
  seq          INTEGER NOT NULL,
  body_sha256  TEXT NOT NULL,
  status       TEXT NOT NULL,
  model        TEXT,
  ms           INTEGER,
  input_tokens INTEGER,
  response     TEXT,
  sent_at      TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
`;

export interface RunInput {
  experiment: string;
  kind: 'dry-run' | 'send';
  /** Method and URL every body goes to. */
  destination: string;
  /** Header names and values as sent, with the key's value never stored. */
  headers: Record<string, string>;
  /** What the bodies were built from: commits, folders, counts. */
  source: Record<string, unknown>;
  /** This repo's version and commit when the run was made. */
  code_version: string;
  /** For a send: the approved dry run whose bodies it transmits. */
  from_run?: string;
}

export interface Run extends Omit<RunInput, 'headers' | 'source' | 'from_run'> {
  run_id: string;
  created_at: string;
  headers: Record<string, string>;
  source: Record<string, unknown>;
  approved_at: string | null;
  from_run: string | null;
}

export interface PayloadInput {
  /** The experiment's own key for the unit, e.g. `prompt@before#2`. */
  unit_key: string;
  /** Local facts about the unit. Never sent. */
  meta: Record<string, unknown>;
  /** Where the text in the body came from, e.g. commit, path and blob. */
  source?: Record<string, unknown>;
  /** The exact body that would be sent. */
  body: string;
  /** Why the experiment's guard refuses to send this body, or null. */
  refused: string | null;
}

export interface Payload extends Omit<PayloadInput, 'meta' | 'source'> {
  run_id: string;
  seq: number;
  meta: Record<string, unknown>;
  source: Record<string, unknown> | null;
  body_sha256: string;
  bytes: number;
}

export interface ResponseInput {
  seq: number;
  body_sha256: string;
  status: string;
  model: string | null;
  ms: number;
  input_tokens: number | null;
  /** The answers as the service returned them. */
  response: unknown;
}

export interface RunSummary {
  run_id: string;
  experiment: string;
  kind: string;
  created_at: string;
  approved_at: string | null;
  from_run: string | null;
  payloads: number;
  refused: number;
  bytes: number;
  responses: number;
  errors: number;
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

type Row = Record<string, string | number | null>;

export class Ledger {
  readonly db: Database;

  constructor(path: string = LEDGER_PATH) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** A new run. Its id is the experiment and the time, to the millisecond. */
  startRun(input: RunInput, now = new Date()): string {
    const run_id = `${input.experiment}/${now.toISOString()}`;
    this.db
      .query('INSERT INTO runs (run_id, experiment, kind, created_at, destination, headers, source, code_version, from_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run_id, input.experiment, input.kind, now.toISOString(), input.destination, JSON.stringify(input.headers), JSON.stringify(input.source), input.code_version, input.from_run ?? null);
    return run_id;
  }

  /** Store a dry run's bodies, in order, in one transaction. */
  addPayloads(run_id: string, payloads: readonly PayloadInput[]): void {
    const run = this.run(run_id);
    if (!run) throw new Error(`no run ${run_id}`);
    if (run.kind !== 'dry-run') throw new Error('bodies are stored on a dry run; a send reads them from one');
    const insert = this.db.query(
      'INSERT INTO payloads (run_id, seq, unit_key, meta, source, body, body_sha256, bytes, refused) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const start = (this.db.query('SELECT COUNT(*) AS n FROM payloads WHERE run_id = ?').get(run_id) as { n: number }).n;
    this.db.transaction(() => {
      payloads.forEach((p, i) => {
        insert.run(run_id, start + i + 1, p.unit_key, JSON.stringify(p.meta), p.source ? JSON.stringify(p.source) : null, p.body, sha256(p.body), Buffer.byteLength(p.body), p.refused);
      });
    })();
  }

  run(run_id: string): Run | undefined {
    const row = this.db.query('SELECT * FROM runs WHERE run_id = ?').get(run_id) as Row | null;
    if (!row) return undefined;
    return {
      ...(row as unknown as Run),
      headers: JSON.parse(String(row['headers'])),
      source: JSON.parse(String(row['source'])),
    };
  }

  runs(): RunSummary[] {
    return this.db
      .query(
        `SELECT r.run_id, r.experiment, r.kind, r.created_at, r.approved_at, r.from_run,
                (SELECT COUNT(*) FROM payloads p WHERE p.run_id = r.run_id) AS payloads,
                (SELECT COUNT(*) FROM payloads p WHERE p.run_id = r.run_id AND p.refused IS NOT NULL) AS refused,
                (SELECT COALESCE(SUM(bytes), 0) FROM payloads p WHERE p.run_id = r.run_id) AS bytes,
                (SELECT COUNT(*) FROM responses s WHERE s.run_id = r.run_id) AS responses,
                (SELECT COUNT(*) FROM responses s WHERE s.run_id = r.run_id AND s.status <> 'ok') AS errors
         FROM runs r ORDER BY r.created_at`,
      )
      .all() as unknown as RunSummary[];
  }

  payloads(run_id: string): Payload[] {
    return (this.db.query('SELECT * FROM payloads WHERE run_id = ? ORDER BY seq').all(run_id) as Row[]).map((row) => ({
      ...(row as unknown as Payload),
      meta: JSON.parse(String(row['meta'])),
      source: row['source'] === null ? null : JSON.parse(String(row['source'])),
    }));
  }

  /** The owner's approval of a dry run: after it, a send may transmit its bodies. */
  approve(run_id: string, now = new Date()): void {
    const run = this.run(run_id);
    if (!run) throw new Error(`no run ${run_id}`);
    if (run.kind !== 'dry-run') throw new Error('only a dry run is approved');
    if (run.approved_at) throw new Error(`already approved at ${run.approved_at}`);
    this.db.query('UPDATE runs SET approved_at = ? WHERE run_id = ?').run(now.toISOString(), run_id);
  }

  /**
   * The bodies a send may transmit: an approved dry run's, refused ones left
   * out, each checked against its stored hash.
   */
  approvedPayloads(run_id: string): Payload[] {
    const run = this.run(run_id);
    if (!run) throw new Error(`no run ${run_id}`);
    if (run.kind !== 'dry-run') throw new Error(`${run_id} is not a dry run`);
    if (!run.approved_at) throw new Error(`${run_id} has not been approved: review it with bun run payloads, then approve it`);
    const payloads = this.payloads(run_id);
    for (const p of payloads) if (sha256(p.body) !== p.body_sha256) throw new Error(`body ${p.seq} of ${run_id} no longer matches its hash`);
    return payloads.filter((p) => p.refused === null);
  }

  recordResponse(run_id: string, r: ResponseInput, now = new Date()): void {
    this.db
      .query('INSERT INTO responses (run_id, seq, body_sha256, status, model, ms, input_tokens, response, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run_id, r.seq, r.body_sha256, r.status, r.model, r.ms, r.input_tokens, r.response === undefined ? null : JSON.stringify(r.response), now.toISOString());
  }

  /** Seqs of the dry run that earlier sends from it already transmitted successfully. */
  alreadySent(from_run: string): Set<number> {
    const rows = this.db
      .query("SELECT s.seq FROM responses s JOIN runs r ON r.run_id = s.run_id WHERE r.from_run = ? AND s.status = 'ok'")
      .all(from_run) as { seq: number }[];
    return new Set(rows.map((row) => row.seq));
  }
}

/** This repo's package version and commit, marked when the tree has changes. */
export function codeVersion(): string {
  const root = new URL('..', import.meta.url).pathname;
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe' }).stdout.toString().trim();
  const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version: string };
  const dirty = git('status', '--porcelain', '--untracked-files=no') !== '' ? '+dirty' : '';
  return `${pkg.version} ${git('rev-parse', '--short', 'HEAD')}${dirty}`;
}
