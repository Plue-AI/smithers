# External transcripts

A person runs Codex or Claude Code in a branch terminal with their own login.
`ExternalTranscript` from `@smthrs/harness` decodes the transcript file that
agent writes into ordered, read-only entries, so the branch conversation can
show the session (mvp.md M-38). The module has two decoders and nothing else:

```ts
import { ExternalTranscript } from "@smthrs/harness"

ExternalTranscript.decodeCodex(state, chunk) // rollout-*.jsonl under $CODEX_HOME/sessions
ExternalTranscript.decodeClaude(state, chunk) // <session>.jsonl under ~/.claude/projects/<project>
```

Each returns `Result<Decoded<State>, ExternalTranscriptError>`: the entries the
chunk completed and the state to pass with the next chunk. Both are pure. They
read no file, clock, network or process, register no importer and publish
nothing. The reference for every type is [api.md](api.md#externaltranscript).

## Host caller

```
machine (member's uid)                 host                         PostgreSQL
┌──────────────────────┐   record    ┌──────────────────────┐
│ owner-uid reader     │──variant 5─▶│ backend ingest       │
│ frames whole lines   │   (bytes)   │  registry binding ───┼──▶ who owns it
└──────────────────────┘             │  POST /v1/transcript/│
                                     │       normalize ─────┼─▶ model-host: decodeCodex / decodeClaude
                                     │  entries + checkpoint│
                                     │  + receipt, one tx ──┼──▶ chat_turns, machine_event_receipts
                                     └──────────────────────┘
```

The install-shipped caller is `apps/model-host/src/transcript.ts`, served at
`POST /v1/transcript/normalize` behind the host bearer. The backend sends one
framed record, the profile the registry pinned, the registry's owner,
participant and session, and the decoder state from the previous committed
receipt. The host decodes that one record and returns drafts and the next
state. It keeps no state between requests.

```ts
const result = profile.startsWith("codex-rollout/")
  ? ExternalTranscript.decodeCodex(state ?? ExternalTranscript.codexStart, record + "\n")
  : ExternalTranscript.decodeClaude(state ?? ExternalTranscript.claudeStart, record + "\n")
if (Result.isFailure(result)) {
  // Refuse the request with result.failure.code. The backend commits no entry and does not advance the receipt.
} else {
  // Stamp each entry with the registry's owner and participant, then return result.success.state as the checkpoint.
}
```

Rules the caller keeps:

- **Identity comes from the registry.** An entry's `role` says whether the
  owner or the agent side authored it. The caller maps `user` to the
  registered owner and `assistant` to the registered agent participant. A
  name, session or role written in a transcript confers nothing; the decoded
  `session_id` is the agent's own id and never selects a member or a branch.
- **One record per call, in order, per source.** A failed decode returns no
  entries from its chunk, so a caller that sends one record keeps every entry
  before the refused one.
- **The state is the checkpoint.** It is plain JSON, held tool requests
  included. Decoding the same record from the same state yields the same
  entries and `source_id`s, so a replay after a crash is idempotent.
- **A refusal stops that source.** The caller shows the import as stopped and
  never retries under a newer profile.
- **Nothing decoded runs.** A command, a patch or a script in an entry is
  text. No prompt is queued, no model is called and no run is created.

T-AGT-02 owns discovery, the owner-uid reader, framing, the receipt
transaction and publication. T-AGT-03 owns the conversation view.

## Why two decoders and no framework

`Transcript.projectResult` projects harness journal entries into model
messages; it does not parse another agent's JSONL.
`GatewayProjection.transcript` needs an executable `runId`, so feeding it an
external record would invent a run. `EntryRowCard` and `CardPrimitives.Actor`
describe presentation and participants; neither decodes a source record. The
smallest missing piece is one decoder per format. There is no adapter
interface: two callers of two functions do not need one.

## Profiles

Neither format carries a schema version, so the profile is the CLI release
line that wrote the record.

| Agent       | Profile                       | Named by                               | Releases read                 |
| ----------- | ----------------------------- | -------------------------------------- | ----------------------------- |
| Codex       | `codex-rollout/<major.minor>` | `session_meta.payload.cli_version`     | `codexReleases`: 0.159, 0.160 |
| Claude Code | `claude-code/<major.minor>`   | `version` on every conversation record | `claudeReleases`: 2.1         |

| Error code            | When                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `missing_version`     | A Codex row before `session_meta`; a Claude Code conversation record with no `version`     |
| `unsupported_version` | A release outside the lists above, or none                                                 |
| `unsupported_record`  | A complete record, event, item, status line, attachment or block of a kind not named below |
| `malformed_record`    | A complete line that is not a JSON record, or a named kind in another shape                |

An incomplete last line is not an error: it waits in `state.pending` for its
newline.

## Mapping: Codex

| Source                                                                                                 | Entry                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `event_msg` `item_completed` `UserMessage`                                                             | The owner's `prompt`                                                                                        |
| `item_completed` `AgentMessage`                                                                        | `text`, `final` for the turn's answer; `encrypted` when the body is ciphertext                              |
| `item_completed` `Reasoning`                                                                           | `reasoning` when Codex wrote a summary; otherwise nothing                                                   |
| `item_completed` `CommandExecution`                                                                    | `tool`: command, `reads` labels, status, exit code, output, duration                                        |
| `item_completed` `FileChange`                                                                          | `edit`: each file's unified diff, `applied` or `failed`                                                     |
| `item_completed` `Extension` (web search)                                                              | `search`                                                                                                    |
| `item_completed` `SubAgentActivity`, `CollabAgentToolCall`                                             | `helper`                                                                                                    |
| `item_completed` `McpToolCall`, `FunctionCallOutput`, `ImageView`                                      | `tool`                                                                                                      |
| `item_completed` `ContextCompaction`                                                                   | `compaction`                                                                                                |
| `event_msg` `thread_goal_updated`                                                                      | The owner's `goal`, once per objective and status                                                           |
| `event_msg` `task_complete` with `error`                                                               | `error` with Codex's message (usage limit, capacity, a refused request)                                     |
| `event_msg` `turn_aborted`, `error`                                                                    | `error` with the reason or message                                                                          |
| `response_item` `agent_message` with `encrypted_content`                                               | One `encrypted` placeholder for the whole body, header included                                             |
| `response_item` `agent_message`, readable                                                              | The agent side's `text`                                                                                     |
| `response_item` `custom_tool_call`                                                                     | Held in `state.calls` until its output; no entry                                                            |
| `response_item` `custom_tool_call_output` reporting a failed script                                    | Failed `tool` with the requested script as its command; plus a failed `edit` for a patch that did not apply |
| `response_item` `custom_tool_call_output`, script completed or still running                           | Nothing: its completed items already say it                                                                 |
| `response_item` `message`, `reasoning`, `function_call`, `function_call_output`                        | Skipped by name: the model-facing copy                                                                      |
| `event_msg` `task_started`, `token_count`, `thread_settings_applied`, `task_complete` without `error`  | Skipped by name                                                                                             |
| `session_meta`                                                                                         | Selects the profile and session                                                                             |
| `turn_context`, `world_state`, `token_usage_record`, `compacted`, `inter_agent_communication_metadata` | Skipped by name                                                                                             |
| Anything else                                                                                          | `unsupported_record`                                                                                        |

Codex encrypts every `response_item` `reasoning` body. Reasoning is not a
message: without a summary it has nothing to show, like Claude Code's
signature-only thinking, and it is skipped. A failed edit's diff is empty
because the report names a file and no change; the patch the agent asked for
stays in the failed `tool`'s command. An edit is what the agent reported, never
an observed write.

## Mapping: Claude Code

| Source                                                                                                                                                                                                        | Entry                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `user` text the owner wrote (`origin` `human` or none)                                                                                                                                                        | `prompt`; a slash command reads `/<name> <args>`, a shell command `!<command>`        |
| `user` `[Request interrupted by user…]`                                                                                                                                                                       | `error` with that text                                                                |
| `user` `isMeta`, `isCompactSummary`, another origin, local command output                                                                                                                                     | Nothing: skill bodies, summaries, task notifications, peer messages                   |
| `assistant` `text`                                                                                                                                                                                            | `text`, `final` when `stop_reason` is `end_turn`                                      |
| `assistant` `thinking` with a body                                                                                                                                                                            | `reasoning`                                                                           |
| `assistant` empty `thinking`, `redacted_thinking`, `fallback`                                                                                                                                                 | Nothing                                                                               |
| `assistant` with `isApiErrorMessage`                                                                                                                                                                          | `error` with Claude Code's message                                                    |
| `assistant` `tool_use`                                                                                                                                                                                        | Held in `state.calls` until its result; no entry                                      |
| `user` `tool_result` for `Bash` and any other tool                                                                                                                                                            | `tool`: command, `ok` or `error`, exit code, output, duration                         |
| `tool_result` for `Read`, `Grep`, `Glob`, `LS`                                                                                                                                                                | `tool` with a `reads` label                                                           |
| `tool_result` for `Edit`, `Write`, `MultiEdit`, `NotebookEdit`                                                                                                                                                | `edit`: reported hunks, or the requested change; `failed` when the result is an error |
| `tool_result` for `WebSearch`, `WebFetch`                                                                                                                                                                     | `search`                                                                              |
| `tool_result` for `Agent`, `Task`                                                                                                                                                                             | `helper`                                                                              |
| `system` `compact_boundary`                                                                                                                                                                                   | `compaction`                                                                          |
| `system` `turn_duration`, `informational`, `stop_hook_summary`, `away_summary`, `api_error`, `local_command`, `scheduled_task_fire`, `agents_killed`, `model_refusal_fallback`                                | Skipped by name: status lines                                                         |
| `attachment` `queued_command` the owner typed                                                                                                                                                                 | `prompt`                                                                              |
| `attachment` of the 44 named context types                                                                                                                                                                    | Skipped by name: context for the model                                                |
| `mode`, `permission-mode`, `atis-latch`, `last-prompt`, `ai-title`, `custom-title`, `agent-name`, `queue-operation`, `file-history-snapshot`, `file-history-delta`, `cost-state`, `pr-link`, `bridge-session` | Skipped by name: bookkeeping                                                          |
| `isSidechain` records                                                                                                                                                                                         | Nothing: a subagent's own transcript                                                  |
| Anything else                                                                                                                                                                                                 | `unsupported_record`                                                                  |

A tool call becomes one entry at its result's record, so two calls issued
together appear in the order their results arrive. A call whose result has
not arrived stays in `state.calls` and has no entry yet.

## Evidence

`test/fixtures/external/manifest.json` lists five captures. Each directory has
the transcript the CLI wrote, the committed `expected.json` and a `MANIFEST.md`
with the capture procedure, record shapes and redactions.

| Capture                      | Release | Where                                      | Covers                                                                                                |
| ---------------------------- | ------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `codex-0.160`                | 0.160.0 | Maintainer's interactive session, macOS    | Two turns, commands, searches, edits, helpers, an encrypted message body, a goal                      |
| `codex-machine-0.160`        | 0.160.0 | Unprivileged member in a microVM, Mac mini | Applied edits, a failed edit, a command that exited 7                                                 |
| `codex-signed-out-0.160`     | 0.160.1 | `codex exec` in an empty temporary home    | A turn that ended in a failure Codex reported                                                         |
| `claude-code-2.1`            | 2.1.277 | Maintainer's interactive session, macOS    | Turns, commands, searches, applied and failed edits, an interruption, a usage-limit error, compaction |
| `claude-code-signed-out-2.1` | 2.1.291 | `claude -p` in an empty temporary home     | An authentication error Claude Code reported                                                          |

Tests compare decoder output with the committed files and never regenerate
them. Every capture is replayed whole, from every split at a record boundary
and one record at a time from a state restored from JSON. Rows a test builds
by hand are labeled constructed and are not golden evidence.

The named kinds come from every transcript on the capture machine: 4,309
Claude Code files from 2.1.261 to 2.1.291 and 1,029 Codex rollouts from
0.159.0 to 0.160.1 decode with no tagged error (2026-10-08).

`test/ExternalTranscript.live.test.ts` runs the installed `claude` and `codex`
in empty temporary homes, lets each write its own transcript and decodes it as
a tail would. It reaches the network, so it runs only with
`SMITHERS_REAL_AGENT_CLI=1`.

## Limits

- A member's Claude Code session captured inside a machine, with tool calls
  and edits, is pending on the reference Mac mini. The Claude Code captures
  here ran on a maintainer's Mac.
- A release line outside the lists is refused. Reading a new line means
  capturing a session, adding its `major.minor` and naming any new kinds.
- smithers-38 has not signed off the exports or the §21.1 evidence.
- No §21.1 benchmark hot path changes: decoding is linear in the bytes given.
