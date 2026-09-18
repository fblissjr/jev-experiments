import { describe, expect, test } from 'bun:test';
import { findPoints } from '../src/points.ts';
import { readTranscript } from '../src/transcript.ts';
import { assistant, jsonl, prompt, text, toolResult, toolUse } from './fixtures.ts';

describe('readTranscript', () => {
  test('merges an assistant message split across records and attaches results to its calls', () => {
    const records = [
      prompt('look at the config'),
      ...assistant([text('reading it'), toolUse('c1', 'Read', { file_path: 'src/a.ts' }), toolUse('c2', 'Read', { file_path: 'src/b.ts' })], 5000),
      toolResult('c1', 'contents of a'),
      toolResult('c2', 'no such file', true),
    ];
    const { segments, versions } = readTranscript(jsonl(records));
    expect(segments).toHaveLength(1);
    const messages = segments[0]!.messages;
    expect(messages.map((m) => m.message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[0]!.isPrompt).toBe(true);
    const reply = messages[1]!;
    expect(reply.message.text).toBe('reading it');
    expect(reply.message.toolUses.map((u) => u.tool_use_id)).toEqual(['c1', 'c2']);
    expect(reply.message.toolUses[0]!.text).toBe('contents of a');
    expect(reply.message.toolUses[1]!.isError).toBe(true);
    expect(reply.contextTokens).toBe(5000);
    // The two result records are one message, as the API sends them.
    expect(messages[2]!.message.toolResults?.map((r) => r.tool_use_id)).toEqual(['c1', 'c2']);
    expect(messages[2]!.isPrompt).toBe(false);
    expect(versions).toEqual(['2.1.276']);
  });

  test('skips sidechains, metadata rows and unparseable lines; injected text is not a prompt', () => {
    const records = [
      prompt('hello'),
      { type: 'attachment', uuid: 'x1' },
      { type: 'user', uuid: 's1', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } },
      prompt('<command-name>/foo</command-name>', { isMeta: true }),
    ];
    const { segments, unparsed } = readTranscript(`${jsonl(records)}\nnot json`);
    const messages = segments[0]!.messages;
    expect(messages.map((m) => m.message.text)).toEqual(['hello', '<command-name>/foo</command-name>']);
    expect(messages.map((m) => m.isPrompt)).toEqual([true, false]);
    expect(unparsed).toBe(1);
  });

  test('ignores records stamped after `until`', () => {
    const records = [
      prompt('early', { timestamp: '2026-09-18T10:00:00.000Z' }),
      prompt('late', { timestamp: '2026-09-18T11:00:00.100Z' }),
    ];
    // As strings, '...00.100Z' sorts before '...00Z'; as times it is later.
    const { segments } = readTranscript(jsonl(records), { until: '2026-09-18T11:00:00Z' });
    expect(segments[0]!.messages.map((m) => m.message.text)).toEqual(['early']);
  });

  test('splits at a compaction, and opens the next span with the summary and the preserved messages', () => {
    const kept = assistant([text('the last thing I said')]);
    const records = [
      prompt('first'),
      ...kept,
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'b1',
        compactMetadata: { trigger: 'auto', preTokens: 900_000, postTokens: 20_000, preservedMessages: { uuids: [kept[0]!.uuid] } },
      },
      prompt('This session is being continued...', { isCompactSummary: true }),
      prompt('next'),
    ];
    const { segments } = readTranscript(jsonl(records));
    expect(segments).toHaveLength(2);
    const compaction = segments[0]!.compaction!;
    expect(compaction).toMatchObject({ trigger: 'auto', preTokens: 900_000, postTokens: 20_000, summary: 'This session is being continued...' });
    expect(compaction.preserved.map((m) => m.message.text)).toEqual(['the last thing I said']);
    expect(segments[1]!.messages.map((m) => m.message.text)).toEqual(['This session is being continued...', 'the last thing I said', 'next']);
    expect(segments[1]!.messages[0]!.isPrompt).toBe(false);
  });

  test('a preserved message does not carry its pre-compaction context into the next span', () => {
    const kept = assistant([text('kept')], 990_000);
    const records = [
      prompt('first'),
      ...kept,
      { type: 'system', subtype: 'compact_boundary', uuid: 'b3', compactMetadata: { trigger: 'auto', preservedMessages: { uuids: [kept[0]!.uuid] } } },
      prompt('summary', { isCompactSummary: true }),
      prompt('next'),
      ...assistant([text('reply')], 30_000),
      prompt('again'),
      ...assistant([text('reply')], 31_000),
    ];
    const { segments } = readTranscript(jsonl(records));
    expect(segments[0]!.messages[1]!.contextTokens).toBe(990_000);
    expect(segments[1]!.messages[1]!.contextTokens).toBeUndefined();
    expect(findPoints(readTranscript(jsonl(records)), { threshold: 120_000, minSuffix: 1 }).filter((p) => p.kind === 'synthetic')).toHaveLength(0);
  });
});

describe('kept records written after the boundary', () => {
  test('belong to the compaction, not the next span: out of the future, in the engine\'s output, no stale context', () => {
    const early = assistant([text('kept, logged before')], 900_000);
    const late = assistant([text('kept, logged after')], 900_000);
    const records = [
      prompt('first'),
      ...early,
      { type: 'system', subtype: 'compact_boundary', uuid: 'b9', compactMetadata: { trigger: 'auto', preTokens: 900_000, preservedMessages: { uuids: [early[0]!.uuid, late[0]!.uuid] } } },
      prompt('summary', { isCompactSummary: true }),
      ...late,
      prompt('next'),
      ...assistant([text('reply')], 30_000),
    ];
    const transcript = readTranscript(jsonl(records));
    const compaction = transcript.segments[0]!.compaction!;
    expect(compaction.preserved.map((m) => m.message.text)).toEqual(['kept, logged before', 'kept, logged after']);
    const lateEntry = transcript.segments[1]!.messages.find((m) => m.message.text === 'kept, logged after')!;
    expect(lateEntry.origin).toBe('preserved');
    expect(lateEntry.contextTokens).toBeUndefined();
    const real = findPoints(transcript, { threshold: 120_000, minSuffix: 1 }).find((p) => p.kind === 'real')!;
    expect(real.suffix.map((m) => m.text)).toEqual(['next', 'reply']);
  });
});

describe('findPoints', () => {
  const turn = (n: number, context: number) => [prompt(`prompt ${n}`), ...assistant([text(`reply ${n}`)], context)];

  test('a synthetic point sits at the first prompt after the context reached the threshold', () => {
    const records = [...turn(1, 50_000), ...turn(2, 130_000), ...turn(3, 140_000), ...turn(4, 150_000)];
    const points = findPoints(readTranscript(jsonl(records)), { threshold: 120_000, minSuffix: 2 });
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ kind: 'synthetic', contextTokens: 130_000 });
    expect(points[0]!.prefix).toHaveLength(4);
    expect(points[0]!.suffix.map((m) => m.text)).toEqual(['prompt 3', 'reply 3', 'prompt 4', 'reply 4']);
  });

  test('no point when too little follows', () => {
    const records = [...turn(1, 130_000), ...turn(2, 140_000)];
    expect(findPoints(readTranscript(jsonl(records)), { threshold: 120_000, minSuffix: 3 })).toHaveLength(0);
  });

  test("a real point's future excludes the engine's own output", () => {
    const records = [
      ...turn(1, 10_000),
      { type: 'system', subtype: 'compact_boundary', uuid: 'b2', compactMetadata: { trigger: 'manual', preTokens: 10_000 } },
      prompt('summary text', { isCompactSummary: true }),
      ...turn(2, 3_000),
    ];
    const points = findPoints(readTranscript(jsonl(records)), { threshold: 120_000, minSuffix: 2 });
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ kind: 'real', contextTokens: 10_000 });
    expect(points[0]!.suffix.map((m) => m.text)).toEqual(['prompt 2', 'reply 2']);
  });
});
