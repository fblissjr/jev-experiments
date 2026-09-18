-- Experiment 09: the rows the exchange-unit builder reads, from a ccutils
-- warehouse (built at ccutils 76533fc). Text is selected only for user rows
-- that carry no tool result: what the person typed, plus harness wrappers the
-- builder filters. Assistant rows come back with no text; they only mark turns.
-- Subagent sessions (session_id 'agent-...') are excluded: their "user" is the
-- orchestrating agent. message_id is the JSONL uuid; entry_id is not.
SELECT
  m.session_id,
  m.message_id AS uuid,
  m.sequence_num,
  CAST(m.timestamp AS VARCHAR) AS timestamp,
  m.message_type,
  m.has_tool_result,
  m.is_meta,
  m.is_compact_summary,
  CASE WHEN m.message_type = 'user' AND NOT m.has_tool_result THEN m.content_text END AS content_text,
  p.project_name
FROM fact_messages m
LEFT JOIN dim_project p USING (project_key)
WHERE m.session_id NOT LIKE 'agent-%'
  AND NOT m.is_sidechain
  AND NOT m.is_deleted
ORDER BY m.session_id, m.sequence_num;
