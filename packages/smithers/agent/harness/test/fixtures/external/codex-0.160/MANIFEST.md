# Codex CLI 0.160 rollout fixture

A sanitized excerpt of one real Codex CLI rollout, and the entries
`ExternalTranscript.decodeCodex` must produce from it.

| Field          | Value                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Agent          | Codex CLI, release `0.160.0` (`session_meta.cli_version`)                                                |
| Originator     | `codex-tui`, source `vscode`, model provider `openai`                                                    |
| Format version | `codex-rollout/0.160`: the adapter profile named by the release's `major.minor`                          |
| Session        | `01a10d62-91c7-7163-b038-72dab55a2e8c`, recorded 2026-10-05 on macOS (Apple Silicon)                     |
| Source file    | `$CODEX_HOME/sessions/2026/10/05/rollout-2026-10-05T11-45-26-01a10d62-91c7-7163-b038-72dab55a2e8c.jsonl` |
| Files          | `rollout.jsonl` (107 rows), `expected.json` (final decoder state and 32 entries)                         |

A rollout carries no schema version of its own, so the release in
`session_meta` selects the profile. A rollout without that row, or from a
release outside `codexReleases`, is refused.

## Capture procedure

1. A maintainer ran Codex CLI 0.160.0 interactively in the Smithers checkout.
   Codex wrote the rollout itself; nothing in this directory was typed by hand.
2. A Python script read the source file line by line with `json.loads`,
   selected the source lines in the line map below, applied the redactions
   below, and wrote each row back with `json.dumps(row, ensure_ascii=False,
   separators=(",", ":"))`. Key order and row order are the source's.
3. `expected.json` was drafted by decoding `rollout.jsonl` once, then
   re-derived from the fixture rows by an independent Python mapping and
   compared (no differences), then read entry by entry against its source row.
   The test compares against the committed file and never regenerates it.

To refresh for a new release, capture a session that covers the same record
shapes, repeat steps 2 and 3, and add the release's `major.minor` to
`codexReleases`.

## Line map

| Fixture lines | Source lines  | Content                                                                                                 |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| 1             | 1             | `session_meta`                                                                                          |
| 2–52          | 2–52          | Turn 1, every row: prompt "How do I use ultrafast", commentary, commands, web searches, final answer    |
| 53–94         | 53–94         | Turn 2, every row: prompt "how do I do it in codex?", commands (one failed), web searches, final answer |
| 95, 96, 98    | 145, 189, 472 | `SubAgentActivity` started, interacted, completed                                                       |
| 97            | 256           | `inter_agent_communication_metadata`                                                                    |
| 99            | 581           | `CollabAgentToolCall` `wait` with no receivers                                                          |
| 100, 101      | 696, 701      | `compacted`, then the `ContextCompaction` item                                                          |
| 102           | 704           | `CommandExecution` whose parsed command only lists files                                                |
| 103           | 774           | Failed `CommandExecution` whose parsed command searches a path (exit 2)                                 |
| 104           | 1337          | `thread_goal_updated`: "finish the spec", active                                                        |
| 105           | 1481          | `FileChange` `update` of two files (`unified_diff`, `move_path: null`)                                  |
| 106           | 1747          | `FileChange` `add` (`content`, no diff)                                                                 |
| 107           | 2519          | `thread_goal_updated` repeating line 104's objective and status with new usage: no entry                |

The `ordinal` field keeps the source numbering, so its gaps mark the excerpt.

## Record shapes

| Row (`type` / `payload.type`)                                                                           | Decoder                                                |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `session_meta`: `payload.{id, session_id, timestamp, cwd, cli_version, …}`                              | Selects the profile and session; no entry              |
| `event_msg` / `item_completed`: `payload.{thread_id, turn_id, item, started_at_ms, completed_at_ms}`    | One entry per item, except `Reasoning` with no summary |
| `event_msg` / `thread_goal_updated`: `payload.goal.{objective, status, tokensUsed, timeUsedSeconds, …}` | A `goal` entry when objective or status changes        |
| `event_msg` / `task_started`, `task_complete`, `token_count`, `thread_settings_applied`                 | Skipped                                                |
| `response_item` / `message`, `reasoning`, `custom_tool_call`, `custom_tool_call_output`                 | Skipped: the model-facing copy of items                |
| `turn_context`, `world_state`, `token_usage_record`, `compacted`, `inter_agent_communication_metadata`  | Skipped                                                |

Items in this capture:

| `item.type`           | Fields the decoder reads                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UserMessage`         | `content[].text`                                                                                                                                                       |
| `AgentMessage`        | `content[].{type: "Text", text}`, `phase` (`commentary` or `final_answer`)                                                                                             |
| `Reasoning`           | `summary_text` (always `[]` here; the body is in the skipped `response_item`, encrypted)                                                                               |
| `CommandExecution`    | `id`, `command` (argv; the last element is the shell string), `parsed_cmd[].{type, name, path, query}`, `status`, `exit_code`, `aggregated_output`, `formatted_output` |
| `Extension`           | `kind: "web.search"`, `id`, `query`, `action.{type, query, url, pattern}`                                                                                              |
| `FileChange`          | `id`, `status`, `changes` (path to `{type: "add", content}` or `{type: "update", unified_diff, move_path}`)                                                            |
| `SubAgentActivity`    | `id`, `kind`, `agent_path`                                                                                                                                             |
| `CollabAgentToolCall` | `id`, `tool`, `receiver_agents`                                                                                                                                        |
| `ContextCompaction`   | `id`                                                                                                                                                                   |

No local capture (15 rollouts from 0.159.2 and 0.160.0) contains an
encrypted `AgentMessage` body, a `Reasoning` summary, a `FileChange` delete,
rename or failure, or a `CollabAgentToolCall` with receivers. The test builds
those rows by hand and labels them as constructed; they are not golden
evidence.

## Redactions and truncations

1. `session_meta` (line 1): dropped `creator_user_id` and `creator_account_id`
   (account identifiers), `base_instructions` (the 21,769-character system
   prompt) and `git` (commit hash and remote URL).
2. `world_state` (line 7): kept `full` and the scalar fields of `state`;
   dropped every object and array field (`agents_md`, `skills`, `host_skills`,
   `permissions`, `environments`, `managed_developer_instructions`, and the
   mode settings) and `multi_agent_usage_hint`.
3. `compacted` (line 100): kept `message`, `window_number` and the window ids;
   dropped `replacement_history`, `replacement_history_metadata`,
   `retained_context`, `compaction_response_id`, `latest_token_usage_record`
   and `resume_metadata`.
4. Every other string over 400 characters, outside `FileChange`, keeps its
   first 400 characters followed by `…[fixture: N chars truncated]`. This
   shortens command output (`stdout`, `aggregated_output`, `formatted_output`),
   two final answers (lines 48 and 90) and their `task_complete` copies,
   instruction text in `response_item` messages, `turn_context` and
   `thread_settings_applied`, and tool call input and output.
5. `encrypted_content` (`response_item` reasoning): first 48 characters and
   the same marker.
6. `Extension` `results`: the first two results.
7. `FileChange` `update` diffs: whole hunks while a file's kept diff stays
   under 1,200 characters, and always the first hunk, so every kept hunk header
   still counts its lines. `FileChange` `add` content: the first 14 lines.
8. Secret scan of the result for API keys (`sk-`, `gh*_`, `github_pat_`,
   `AKIA`), bearer tokens, JWTs, private keys, email addresses and IP
   addresses: the only match is the variable name `$OPENAI_API_KEY` inside a
   documentation excerpt (line 45), with no value. Home-directory paths and the
   account directory label `codex-acct-2` stay; they are not credentials.
