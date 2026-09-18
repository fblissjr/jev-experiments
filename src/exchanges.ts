// Exchange units for labeling: each typed reply of the person, with the
// prompt that opened the turn it answers. Pure: takes message rows (as the
// experiment 09 query projects them from a ccutils warehouse), does no I/O.
//
// A unit carries only text the person typed. Assistant rows arrive with no
// text at all; they only mark that the assistant took a turn.

/** One row of the experiment 09 query, in sequence order within a session. */
export interface MessageRow {
  session_id: string;
  /** The JSONL `uuid` (ccutils `fact_messages.message_id`). */
  uuid: string;
  sequence_num: number;
  timestamp: string | null;
  message_type: 'user' | 'assistant' | string;
  has_tool_result: boolean;
  is_meta: boolean;
  is_compact_summary: boolean;
  /** Text of a user row that carries no tool result; null otherwise. */
  content_text: string | null;
  project_name: string | null;
}

export type Exclusion =
  | 'meta'
  | 'compact_summary'
  | 'empty'
  | 'slash_command'
  | 'command_output'
  | 'shell_mode'
  | 'notification'
  | 'injection_only'
  | 'first_in_session'
  | 'no_assistant_between';

export interface Unit {
  unit_type: 'exchange' | 'interrupt';
  native_session_id: string;
  project_name: string | null;
  /** The reply's uuid: the key. For an interrupt, the marker's uuid. */
  user_entry_uuid: string;
  /** The last assistant entry before the reply. */
  assistant_entry_uuid: string | null;
  previous_prompt_uuid: string | null;
  /** What the person typed to open the turn; null when something else opened it (a notification). */
  previous_prompt: string | null;
  reply: string;
  timestamp: string | null;
  /** How many sessions hold this reply: forks and resumes copy history into new files. */
  copies: number;
}

export interface Units {
  units: Unit[];
  excluded: Partial<Record<Exclusion, number>>;
  /** Replies that appear in more than one session under the same uuid, collapsed to one unit. */
  collapsedCopies: number;
  /** Copies whose text differed from the kept unit's; expected to be zero. */
  copyTextMismatches: number;
}

const INTERRUPT = '[Request interrupted by user';

// Blocks the harness puts inside a user message. A message that is nothing
// but these is excluded; one that has typed text beside them keeps the text.
const INJECTED_BLOCK = /<(system-reminder|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g;

/** A slash command as the person typed it, from the harness's wrapper: "/name args". */
export function slashCommandText(text: string): string {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim() ?? '';
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
  return [name, args].filter(Boolean).join(' ');
}

export type UserKind =
  | { kind: 'typed'; text: string }
  | { kind: 'interrupt' }
  | { kind: 'slash_command'; text: string }
  | { kind: 'notification' }
  | { kind: 'excluded'; reason: Exclusion };

/** What a user row is, for a row that carries no tool result. */
export function classifyUser(row: Pick<MessageRow, 'is_meta' | 'is_compact_summary' | 'content_text'>): UserKind {
  if (row.is_meta) return { kind: 'excluded', reason: 'meta' };
  if (row.is_compact_summary) return { kind: 'excluded', reason: 'compact_summary' };
  const raw = row.content_text ?? '';
  if (raw.trim() === '') return { kind: 'excluded', reason: 'empty' };
  if (raw.startsWith(INTERRUPT)) return { kind: 'interrupt' };
  if (raw.includes('<command-name>')) return { kind: 'slash_command', text: slashCommandText(raw) };
  if (raw.includes('<local-command-')) return { kind: 'excluded', reason: 'command_output' };
  // The `!` shell mode: the command and its output, run locally, never answered.
  if (/<bash-(input|stdout|stderr)>/.test(raw)) return { kind: 'excluded', reason: 'shell_mode' };
  const start = raw.trimStart();
  if (start.startsWith('<task-notification>') || start.startsWith('<cross-session-message')) return { kind: 'notification' };
  const text = raw.replace(INJECTED_BLOCK, '').trim();
  if (text === '') return { kind: 'excluded', reason: 'injection_only' };
  return { kind: 'typed', text };
}

/**
 * Builds the units of every session. Rows must be in (session, sequence)
 * order. A typed reply is a unit when something opened a turn before it and
 * the assistant took that turn. An interrupt marker is its own unit and does
 * not end the turn, so the reply after it answers the same opener.
 */
export function buildUnits(rows: readonly MessageRow[]): Units {
  const excluded: Partial<Record<Exclusion, number>> = {};
  const count = (reason: Exclusion) => (excluded[reason] = (excluded[reason] ?? 0) + 1);
  const all: Unit[] = [];

  let session = '';
  let opener: { uuid: string; text: string | null } | undefined;
  // A slash command or a notification opens a turn only if the assistant
  // answers it; a local command such as /cost does not.
  let pending: { uuid: string; text: string | null } | undefined;
  let assistantSince = false;
  let lastAssistant: string | null = null;
  let seen = new Set<string>();

  for (const row of rows) {
    if (row.session_id !== session) {
      session = row.session_id;
      opener = undefined;
      pending = undefined;
      assistantSince = false;
      lastAssistant = null;
      seen = new Set();
    }
    // A file can replay its own history: the same uuid again, lines later.
    // The first occurrence stands; a replay is not a new turn.
    if (seen.has(row.uuid)) continue;
    seen.add(row.uuid);
    if (row.message_type === 'assistant') {
      if (pending) {
        opener = pending;
        pending = undefined;
      }
      assistantSince = true;
      lastAssistant = row.uuid;
      continue;
    }
    if (row.message_type !== 'user' || row.has_tool_result) continue;

    const what = classifyUser(row);
    const base = { native_session_id: row.session_id, project_name: row.project_name, timestamp: row.timestamp, copies: 1 };
    switch (what.kind) {
      case 'excluded':
        // Includes a compaction summary: it changes what the model holds, not
        // the turn the person answers next, so it resets nothing.
        count(what.reason);
        break;
      case 'interrupt':
        all.push({ ...base, unit_type: 'interrupt', user_entry_uuid: row.uuid, assistant_entry_uuid: lastAssistant, previous_prompt_uuid: opener?.uuid ?? null, previous_prompt: opener?.text ?? null, reply: '' });
        break;
      case 'notification':
      case 'slash_command':
        // Not a reply to label. It becomes the opener if the assistant answers it.
        count(what.kind === 'notification' ? 'notification' : 'slash_command');
        pending = { uuid: row.uuid, text: what.kind === 'slash_command' ? what.text : null };
        break;
      case 'typed':
        if (!opener) count('first_in_session');
        else if (!assistantSince) count('no_assistant_between');
        else all.push({ ...base, unit_type: 'exchange', user_entry_uuid: row.uuid, assistant_entry_uuid: lastAssistant, previous_prompt_uuid: opener.uuid, previous_prompt: opener.text, reply: what.text });
        opener = { uuid: row.uuid, text: what.text };
        pending = undefined;
        assistantSince = false;
        break;
    }
  }

  // Collapse copies across files: one unit per uuid, kept under the lowest
  // session id. Rows within a session were already deduplicated above.
  const byUuid = new Map<string, Unit[]>();
  for (const unit of all) {
    const group = byUuid.get(unit.user_entry_uuid);
    if (group) group.push(unit);
    else byUuid.set(unit.user_entry_uuid, [unit]);
  }
  const units: Unit[] = [];
  let collapsedCopies = 0;
  let copyTextMismatches = 0;
  for (const group of byUuid.values()) {
    group.sort((a, b) => (a.native_session_id < b.native_session_id ? -1 : a.native_session_id > b.native_session_id ? 1 : 0));
    const kept = group[0]!;
    if (group.length > 1) {
      collapsedCopies += group.length - 1;
      copyTextMismatches += group.slice(1).filter((u) => u.reply !== kept.reply).length;
    }
    units.push({ ...kept, copies: group.length });
  }
  return { units, excluded, collapsedCopies, copyTextMismatches };
}
