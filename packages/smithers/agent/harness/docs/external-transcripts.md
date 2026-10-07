# External transcripts

`ExternalTranscript` from `@smthrs/harness` exposes pure decoders:
`decodeCodex(state, chunk)` and `decodeClaude(state, chunk)`. Start with
`codexStart` or `claudeStart`, then persist the returned state with each
accepted batch. Results contain ordered, read-only external entries or a
tagged `harness/ExternalTranscriptError` with a code and source line.

Chunks are newline-framed strings. The final unterminated line remains in
`state.pending`, including a complete JSON object without its newline. Replay
with the same input and checkpoint preserves source IDs, sequence and order.
Source IDs combine session, line and, for multiple Claude parts, part index.
Neither decoder reads files, executes tools, publishes entries or creates runs.
Reported edits describe what the agent reported, never observed filesystem writes.

## Profiles

Codex selects `codex-rollout/<major.minor>` from `session_meta.cli_version`;
`codexReleases` currently lists `0.159` and `0.160`. Claude selects
`claude-code/<major.minor>` from each conversation record's `version`;
`claudeReleases` currently lists `2.1`. Missing releases and unsupported release
lines are rejected. Invalid JSON records return `malformed_record`.

The release lists describe decoder support, not reference-machine capture
certification. Unknown semantic records return `unsupported_record`; malformed
records return `malformed_record`. Known duplicate and bookkeeping records skip.

## Mapping

| Source | Entry part / skip |
| --- | --- |
| Codex completed `UserMessage` | Prompt |
| Codex completed `AgentMessage` | Text; an encrypted content block replaces its entire body with one encrypted part |
| Codex completed `Reasoning` | Readable summary, encrypted part if reported, otherwise skip |
| Codex completed `CommandExecution` | Tool ID, command, reported output, duration and status |
| Codex completed `FileChange` | Reported files, diffs and applied/failed outcome |
| Codex completed `ContextCompaction` | Compaction |
| Codex completed helper/collaboration items | Helper |
| Codex completed `Extension` | Search |
| Codex `thread_goal_updated` | Goal when objective or status changes |
| Codex `event_msg.error` / `turn_aborted` | Error with the reported message/reason; malformed empty reports reject |
| Codex code-mode tool calls / outputs | Keep inert requests in the checkpoint; successful outputs duplicate native items; failed scripts retain the paired request and report |
| Codex failed apply_patch verification | Additional failed edit with the reported path; no observed diff is invented |
| Codex other event notifications / non-event rows | Skip; other `response_item` rows are the model-facing duplicate |
| Claude owner user text / queued command | Prompt |
| Claude assistant text / readable thinking | Text / reasoning |
| Claude assistant `isApiErrorMessage` | Error |
| Claude `tool_use` / paired `tool_result` | Hold request in state, emit correlated tool/edit/search/helper part when result arrives |
| Claude `system.compact_boundary` | Compaction |
| Claude metadata without UUID, sidechains, other system status, context attachments | Skip |
| Claude injected user content, peers, task notifications, summaries | Skip as owner prompts |
| Claude unknown conversation record/content | Tagged rejection |

The per-format fixture manifests describe complete recorded shapes, tool mapping,
redactions and constructed-only cases:
[Codex](../test/fixtures/external/codex-0.160/MANIFEST.md) and
[Claude Code](../test/fixtures/external/claude-code-2.1/MANIFEST.md).
The [member-machine Codex capture](../test/fixtures/external/codex-machine-0.160/MANIFEST.md)
adds authenticated reference-host receipts, successful and failed edits, and
explicit script/command failures. `test/fixtures/external/manifest.json` indexes
these current fixtures; retired fixtures for the replaced decoder API are removed.
Tests call the public package export, compare committed expected output and
exercise chunk partitions and serialized checkpoints. They do not regenerate
expected output at runtime.

## Host caller (T-AGT-02)

`packages/backend/internal/compose/external_transcript_checkpoint.go` calls
`NormalizeExternalTranscript` through the injected host provider. It stores
returned parser state with the machine receipt in the same transaction as
conversation entries; rejected records do not advance the checkpoint. Replay
checks the retained record hash before reusing the checkpoint.

Current main has no model-host normalization endpoint or production construction
of `TranscriptIngest`. The Go host contract expects caller-owned identities,
explicit profile, byte range and parser checkpoint. `Transcript.decodeClaudeCode(profile, context, chunk, state?)` and
`Transcript.decodeCodex(profile, context, chunk, state?)` adapt the same parsers
to canonical backend drafts. Context supplies trusted owner, participant, session
and source generation; checkpoints bind all four, profiles and UTF-8 byte offsets.
Profiles `claude-code/2.1.0` and `codex/0.160.0` pin CLI releases 2.1.277 and
0.160.0 respectively. Tool requests/results remain inert. Missing or unknown
profiles, release drift, invalid context and checkpoint rebinding reject.
T-AGT-02 must supply registered context and compose this API before activation.
T-AGT-03 owns rendering. Provider tests alone do not prove install/browser ingestion.

## Evidence limits

The committed real Claude excerpt includes multiple turns, applied and failed
edits, command failure and a usage-limit error. It lacks an authenticated
unprivileged member-machine capture receipt on the reference install. The new
real Codex machine capture supplies that boundary proof, two turns, successful
and failed edits, and script/command errors. Provider-level Codex error records
and encrypted agent-message bodies remain constructed cases. The older Codex
excerpt retains real encrypted reasoning source records.

Claude machine capture/profile validation and smithers-38's post-hoc sign-off
remain required for C-AGT-01 completion. The browser check retains its fixme
until real ingestion and rendering pass.
