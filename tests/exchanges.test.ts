import { describe, expect, test } from 'bun:test';
import { buildUnits, classifyUser, type MessageRow } from '../src/exchanges.ts';

let seq = 0;
function rows(session: string, spec: (string | { a: true } | { tool: true } | { meta: string } | { summary: true } | { uuid: string; text: string })[]): MessageRow[] {
  return spec.map((item) => {
    const base = { session_id: session, sequence_num: seq, timestamp: '2026-05-01 10:00:00', has_tool_result: false, is_meta: false, is_compact_summary: false, project_name: 'p' };
    seq += 1;
    if (typeof item === 'string') return { ...base, uuid: `u${seq}`, message_type: 'user', content_text: item };
    if ('a' in item) return { ...base, uuid: `a${seq}`, message_type: 'assistant', content_text: null };
    if ('tool' in item) return { ...base, uuid: `t${seq}`, message_type: 'user', has_tool_result: true, content_text: null };
    if ('meta' in item) return { ...base, uuid: `m${seq}`, message_type: 'user', is_meta: true, content_text: item.meta };
    if ('summary' in item) return { ...base, uuid: `s${seq}`, message_type: 'user', is_compact_summary: true, content_text: 'This session is being continued...' };
    return { ...base, uuid: item.uuid, message_type: 'user', content_text: item.text };
  });
}
const A = { a: true } as const;
const replies = (built: ReturnType<typeof buildUnits>) => built.units.filter((u) => u.unit_type === 'exchange').map((u) => [u.previous_prompt, u.reply]);

describe('classifyUser', () => {
  test('harness wrappers and markers', () => {
    const k = (content_text: string) => classifyUser({ is_meta: false, is_compact_summary: false, content_text });
    expect(k('[Request interrupted by user]')).toEqual({ kind: 'interrupt' });
    expect(k('<command-name>/review</command-name><command-message>review</command-message><command-args>pr 12</command-args>')).toEqual({ kind: 'slash_command', text: '/review pr 12' });
    expect(k('<local-command-stdout>Total cost: $0.42</local-command-stdout>')).toEqual({ kind: 'excluded', reason: 'command_output' });
    expect(k('<task-notification>done</task-notification>')).toEqual({ kind: 'notification' });
    expect(k('<system-reminder>hook ran</system-reminder>')).toEqual({ kind: 'excluded', reason: 'injection_only' });
    expect(k('<bash-input>cat .env</bash-input>')).toEqual({ kind: 'excluded', reason: 'shell_mode' });
    expect(k('<bash-stdout>SECRET=abc</bash-stdout><bash-stderr></bash-stderr>')).toEqual({ kind: 'excluded', reason: 'shell_mode' });
  });

  test('shell-mode output never becomes a reply or an opener', () => {
    const built = buildUnits(rows('s10', ['check the config', A, '<bash-input>cat .env</bash-input>', '<bash-stdout>SECRET=abc</bash-stdout>', 'looks fine']));
    expect(replies(built)).toEqual([['check the config', 'looks fine']]);
  });

  test('an injected block beside typed text is stripped and the text kept; a typed placeholder tag is kept', () => {
    const k = (content_text: string) => classifyUser({ is_meta: false, is_compact_summary: false, content_text });
    expect(k('<system-reminder>ctx</system-reminder>\nplease rerun it')).toEqual({ kind: 'typed', text: 'please rerun it' });
    expect(k('push to <branch> when done')).toEqual({ kind: 'typed', text: 'push to <branch> when done' });
  });
});

describe('buildUnits', () => {
  test('a typed reply after an assistant turn is a unit; the session opener is not', () => {
    const built = buildUnits(rows('s1', ['fix the parser', A, { tool: true }, A, 'no, run the tests first']));
    expect(replies(built)).toEqual([['fix the parser', 'no, run the tests first']]);
    expect(built.excluded.first_in_session).toBe(1);
  });

  test('two typed messages with no assistant turn between: the second is not a unit', () => {
    const built = buildUnits(rows('s2', ['one', A, 'two', 'three']));
    expect(replies(built)).toEqual([['one', 'two']]);
    expect(built.excluded.no_assistant_between).toBe(1);
  });

  test('an interrupt is its own unit and the reply after it answers the same opener', () => {
    const built = buildUnits(rows('s3', ['do the thing', A, '[Request interrupted by user]', 'not that way']));
    expect(built.units.map((u) => u.unit_type)).toEqual(['interrupt', 'exchange']);
    expect(replies(built)).toEqual([['do the thing', 'not that way']]);
  });

  test('a local slash command the assistant never answers does not end the turn', () => {
    const built = buildUnits(rows('s4', ['migrate it', A, '<command-name>/cost</command-name>', '<local-command-stdout>$0.42</local-command-stdout>', 'did you run it?']));
    expect(replies(built)).toEqual([['migrate it', 'did you run it?']]);
  });

  test('a slash command the assistant answers opens the turn, as the person typed it', () => {
    const built = buildUnits(rows('s5', ['start', A, '<command-name>/review</command-name><command-args>pr 12</command-args>', A, 'looks good']));
    expect(replies(built)).toEqual([['/review pr 12', 'looks good']]);
  });

  test('a notification the assistant answers opens the turn, with no typed text', () => {
    const built = buildUnits(rows('s6', ['start', A, '<task-notification>build done</task-notification>', A, 'ship it']));
    expect(replies(built)).toEqual([[null, 'ship it']]);
  });

  test('a compaction between the turn and the reply does not end the turn', () => {
    const built = buildUnits(rows('s7', ['restructure the page', A, { summary: true }, 'I only asked for the typo']));
    expect(replies(built)).toEqual([['restructure the page', 'I only asked for the typo']]);
  });

  test('meta entries are excluded and change nothing', () => {
    const built = buildUnits(rows('s8', ['go', A, { meta: 'skill text' }, 'thanks']));
    expect(replies(built)).toEqual([['go', 'thanks']]);
    expect(built.excluded.meta).toBe(1);
  });

  test('a uuid replayed later in the same file is read once', () => {
    const r = rows('s9', ['go', A, { uuid: 'r1', text: 'no' }, A, { uuid: 'r1', text: 'no' }]);
    expect(buildUnits(r).units.map((u) => u.user_entry_uuid)).toEqual(['r1']);
  });

  test('a reply copied into a resumed session is one unit, under the lowest session id', () => {
    const original = rows('sess-a', ['go', A, { uuid: 'shared', text: 'wrong file' }]);
    const resumed = rows('sess-b', ['go', A, { uuid: 'shared', text: 'wrong file' }, A, 'now the tests']);
    const built = buildUnits([...original, ...resumed]);
    const shared = built.units.find((u) => u.user_entry_uuid === 'shared')!;
    expect(shared.native_session_id).toBe('sess-a');
    expect(shared.copies).toBe(2);
    expect(built.collapsedCopies).toBe(1);
    expect(built.units.filter((u) => u.native_session_id === 'sess-b').map((u) => u.reply)).toEqual(['now the tests']);
  });
});
