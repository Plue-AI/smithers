# External transcripts

`ExternalTranscript` from `@smthrs/harness` exposes pure decoders:
`decodeCodex(state, chunk)` and `decodeClaude(state, chunk)`. Start with
`codexStart` or `claudeStart`, then persist the returned state with each
accepted batch. `Transcript` re-exports the same functions; it has no separate
external decoder. Results contain ordered, read-only external entries or a
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
certification. Unknown semantic items currently become error parts or are
skipped, rather than returning a tagged rejection. This remains a gap against
T-AGT-01's fail-closed acceptance contract.

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
| Codex other event notifications / non-event rows | Skip; `response_item` is the model-facing duplicate |
| Claude owner user text / queued command | Prompt |
| Claude assistant text / readable thinking | Text / reasoning |
| Claude assistant `isApiErrorMessage` | Error |
| Claude `tool_use` / paired `tool_result` | Hold request in state, emit correlated tool/edit/search/helper part when result arrives |
| Claude `system.compact_boundary` | Compaction |
| Claude metadata without UUID, sidechains, other system status, context attachments | Skip |
| Claude injected user content, peers, task notifications, summaries | Skip as owner prompts |
| Claude unknown conversation record/content | Error part |

The per-format fixture manifests describe complete recorded shapes, tool mapping,
redactions and constructed-only cases:
[Codex](../test/fixtures/external/codex-0.160/MANIFEST.md) and
[Claude Code](../test/fixtures/external/claude-code-2.1/MANIFEST.md).
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
explicit profile, byte range and parser checkpoint. The current public decoder
API produces source-session entries and has no trusted owner/participant input;
T-AGT-02 must not treat transcript identities as authenticated member authority.
The host contract and decoder drafts still need reconciliation before activation.
T-AGT-03 owns rendering. Provider tests alone do not prove install/browser ingestion.

## Evidence limits

The committed real Claude excerpt includes multiple turns, applied and failed
edits, command failure and a usage-limit error. The real Codex excerpt includes
multiple turns and applied edits; failed edits and encrypted agent bodies remain
constructed test cases. Neither manifest establishes an authenticated capture
inside an unprivileged member machine on the reference install. Those receipts,
complete Codex error/edit evidence, fail-closed semantics, trusted attribution
and smithers-38's post-hoc sign-off remain required for C-AGT-01 completion.
The browser check retains its fixme until real ingestion and rendering pass.
