# Claude Code 2.1 session fixture

A sanitized excerpt of one real Claude Code session transcript, and the
entries `ExternalTranscript.decodeClaude` must produce from it.

| Field          | Value                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Agent          | Claude Code, release `2.1.277` (the `version` on every conversation record), entrypoint `cli`                       |
| Models         | `claude-opus-5`, `claude-fable-5-1`, and `<synthetic>` for Claude Code's own usage-limit message                    |
| Format version | `claude-code/2.1`: the adapter profile named by the release's `major.minor`                                         |
| Session        | `93469675-c700-423f-be09-43aefb36a280`, recorded 2026-09-18 to 2026-09-20 on macOS (Apple Silicon)                  |
| Source file    | `~/.claude/projects/-Users-williamcory-smithers/93469675-c700-423f-be09-43aefb36a280.jsonl` (3,957 rows)            |
| Files          | `session.jsonl` (133 rows), `expected.json` (final decoder state and 36 entries)                                    |
| Local evidence | All 2,472 main transcripts on the capture machine (`2.1.261` to `2.1.290`) decode with no tagged error (2026-10-05) |

A Claude Code transcript has no schema version of its own. Every
conversation record (one with a `uuid`) carries the CLI release in `version`,
so each record selects the profile. A conversation record without one, or
from a release line outside `claudeReleases`, is refused.

## Capture procedure

1. A maintainer ran Claude Code 2.1.277 interactively in the Smithers
   checkout. Claude Code wrote the transcript itself; nothing in this
   directory was typed by hand.
2. A Python script read the source file line by line with `json.loads`,
   selected the source lines in the line map below, applied the redactions
   below, and wrote each row back with `json.dumps(row, ensure_ascii=False,
   separators=(",", ":"))`. Key order and row order are the source's.
3. `expected.json` was drafted by decoding `session.jsonl` once, then
   re-derived from the fixture rows by an independent Python mapping and
   compared (no differences), then read entry by entry against its source row.
   The test compares against the committed file and never regenerates it.

To refresh for a new release line, capture a session that covers the same
record shapes, repeat steps 2 and 3, and add the release's `major.minor` to
`claudeReleases`.

## Line map

| Fixture lines | Source lines | Content                                                                                                         |
| ------------- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| 1–44          | 1–44         | Session open: metadata rows, the first prompt, context attachments, ToolSearch, ListAgents, SendMessage, then a |
|               |              | WebSearch and a Bash call issued together whose results arrive in the other order (43, 44)                      |
| 45–53         | 142–150      | Two WebFetch calls; results at 47 and 53 with metadata rows between                                             |
| 54–75         | 193–214      | Commentary, Bash, `Write` creating a file (60, 61), Bash, SendMessage, final answer, turn status rows           |
| 76            | 217          | A message from another Claude Code session (`isMeta`, origin `peer`)                                            |
| 77–81         | 226–230      | Commentary and an applied `Edit` with Claude Code's `structuredPatch`                                           |
| 82            | 256          | A second peer message                                                                                           |
| 83–85         | 266–268      | An `Edit` that failed (`is_error`, "String to replace not found in file")                                       |
| 86–96         | 283–293      | Final answer, `away_summary`, prompt "Instead of html just answer my questions concisely in this chat", answer  |
| 97            | 326          | Prompt "Design this for me and make these changees…"                                                            |
| 98–101        | 333–336      | Commentary and an `Agent` (subagent) call with its result                                                       |
| 102           | 429          | A task notification (origin `task-notification`)                                                                |
| 103–112       | 494–503      | Queued prompt, commentary cut off mid-stream (`stop_reason: null`), `[Request interrupted by user]`, the queued |
|               |              | prompt delivered (109), and the same prompt resent on a new branch (112, same `parentUuid` as 109)              |
| 113–116       | 557–560      | Commentary, a `Write` that failed, and a prompt the owner queued mid-turn (`attachment` `queued_command`)       |
| 117–119       | 892–894      | `/model`: the local-command caveat (`isMeta`), the command record and its `<local-command-stdout>`              |
| 120–122       | 940–942      | Thinking with a readable body, then a Bash call that failed with exit code 1                                    |
| 123–129       | 1147–1153    | Claude Code's usage-limit message (`isApiErrorMessage`), status rows, the automatic continuation (`isMeta`)     |
| 130–131       | 1670–1671    | A `Read` call and its result                                                                                    |
| 132           | 3007         | `system` `compact_boundary`                                                                                     |
| 133           | 3011         | The compaction summary Claude Code sends as a user record (`isCompactSummary`)                                  |

`turn_id` is the `promptId` of the latest user record, so an excerpt that drops
a turn's opening record (a peer message, say) leaves that turn's first entries
on the previous turn's id.

## Record shapes

| Row (`type`)                                                                                                    | Decoder                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`: `{uuid, parentUuid, isSidechain, promptId, message: {role, content}, origin, isMeta, toolUseResult, …}` | `tool_result` blocks end their call; the owner's text is a `prompt`                                                                                |
| `assistant`: `{uuid, message: {model, content: [one block], stop_reason}, isApiErrorMessage, …}`                | `text`, `thinking` with a body, `tool_use` held until its result; an API error message is an `error`                                               |
| `system`: `{uuid, subtype, content, …}`                                                                         | `compact_boundary` is a `compaction`; `informational`, `stop_hook_summary`, `turn_duration`, `away_summary` and other status lines are skipped     |
| `attachment`: `{uuid, attachment: {type, …}, rendered}`                                                         | A `queued_command` the owner typed (`commandMode: "prompt"`, origin `human` or none) is a `prompt`; context attachments are skipped                |
| `mode`, `permission-mode`, `atis-latch`, `last-prompt`, `ai-title`, `queue-operation`, `file-history-snapshot`, | Skipped: no `uuid`, so not part of the conversation. Other such rows in local captures: `custom-title`, `agent-name`, `cost-state`, `pr-link`, ... |
| `file-history-delta`                                                                                            |                                                                                                                                                    |

User records the decoder does not read as the owner's: `isMeta` (skill bodies,
caveats, peer messages, automatic continuations), `isCompactSummary`, any
`origin` other than `human` (task notifications, peers, coordinators), and
Claude Code's output of a local command (`<local-command-stdout>`,
`<bash-stdout>`). A slash command record reads as `/<name> <args>`.

Tools in this capture: `Bash`, `Read`, `Write`, `Edit`, `WebSearch`,
`WebFetch`, `Agent`, `ToolSearch`, `ListAgents`, `SendMessage`.

No local 2.1 capture contains `MultiEdit`, `NotebookEdit`, `LS` or `Task`
calls, `redacted_thinking`, an assistant record with two blocks, a user
record with two `tool_result` blocks, or `isSidechain: true` rows in a main
transcript. This session has no `Grep` or `Glob` call, `<bash-input>` record
or unknown content block (other local captures have them; across all 2,472,
the only block the decoder does not read is `fallback`, three times). The test builds those rows by hand and labels them as
constructed; they are not golden evidence.

## Redactions and truncations

1. Context attachments (every `attachment` except `queued_command`, lines
   7–19, 30, 31 and the `total_tokens_reminder` rows): every string inside
   `attachment` and `rendered`, except `attachment.type`, became
   `[fixture: N chars redacted]`, and every list there keeps its first three
   items. These carried the system prompt, tool schemas, skill and agent
   listings, instruction files, the account email address and git status.
2. Every other string over 400 characters keeps its first 400 characters
   followed by `…[fixture: N chars truncated]`. This shortens prompts (6, 97),
   assistant text, thinking signatures, tool inputs (`Write` content, `Edit`
   strings, `Agent` and `SendMessage` prompts), tool results, `toolUseResult`
   fields and `structuredPatch` lines. Hunk headers keep their counts.
3. Secret scan of the result for API keys (`sk-`, `gh*_`, `github_pat_`,
   `AKIA`, `vck_`), bearer tokens, JWTs, private keys, `*_KEY=`/`*TOKEN=`
   assignments, email addresses and IP addresses: no match (the only `sk-`
   hit is the word `task-notification`). Home-directory paths, session names
   such as `smithers-2f`, and request and message ids stay; they are not
   credentials.
