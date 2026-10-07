# External transcripts

`Transcript` from `@smthrs/harness` exposes two pure decoders:
`decodeClaudeCode(profile, context, chunk, state?)` and
`decodeCodex(profile, context, chunk, state?)`. Both return an Effect `Result`
containing inert drafts and a serializable checkpoint, or a tagged rejection.
No file discovery, registration, model dispatch, tool execution, publication,
clock or I/O belongs to either decoder.

## Host caller (T-AGT-02)

```ts
import { Transcript } from "@smthrs/harness"
import { Result } from "effect"

const result = Transcript.decodeCodex(
  frame.format_version,
  trustedRegistration, // owner_id, participant_id, session_id, source_generation
  frame.completeRecordText,
  receipt.parserState
)
if (Result.isFailure(result)) {
  // Stop this source and surface result.failure; do not advance its receipt.
} else {
  // Atomically commit entries, parser state and source receipt, then publish.
  // Do not enqueue prompts or create executable runs from these drafts.
}
```

The install-shipped caller is `apps/model-host/src/transcript.ts`, served at
`POST /v1/transcript/normalize` with the existing host bearer. It calls these
public transcript exports with trusted registration context and one framed
record, retaining the checkpoint between requests. The packaged host HTTP tests replay committed real-agent fixtures and verify
inert identities, checkpoint replay and tool correlations across records.
Synthetic fixtures remain regression evidence only.

T-AGT-02 owns atomic storage,
receipt deduplication, UID/source validation and publication; T-AGT-03 owns the
conversation view. The host forwards daemon-framed complete records with their
line terminators, or persists `pending` until the next chunk. A complete JSON
object without its line terminator is still incomplete framing. State is bound
to the profile and all four trusted context identities. The host must serialize
chunks per source and bind its checkpoint to its transport receipt. Replay from
the same checkpoint yields identical IDs; generations distinguish rotation.
Offsets count UTF-8 bytes in the source; metadata records advance offsets too.
A rejection returns no partial batch and leaves the input checkpoint untouched.

## Existing projections

`Transcript.projectResult` projects durable harness journal records into
`ModelRequest.Message`, including harness demands and compaction. It does not
parse either external JSONL format. `GatewayProjection.transcript` requires an
executable `runId`, so feeding external records to it invents run identity.
`EntryRowCard` and `CardPrimitives.Actor` already describe presentation and
participant identity, but neither decodes source records. The smallest missing
API is these two source-specific decoders. Draft `kind: prompt` maps to the
existing prompt entry, `assistant` to its answer, and tool/edit/error parts to
shared transcript components. Trusted owner/participant IDs resolve against the
existing actor provider; source-provided owners and sessions never confer
identity or authority. No second actor enum, graph or executable event model is
introduced. Existing internal journal projections are unchanged.

## Profiles and errors

- `codex/0.160.0`: release identified in the recorded rollout's `session_meta`.
  Validate any encountered `cli_version`; unknown response-item/event semantics
  are rejected. Default layout: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`
  (`CODEX_HOME` defaults to `~/.codex`). Discovery is outside this module.
- `claude-code/2.1.0`: **provisional**, synthetic regression evidence only. Any
  encountered `version` must be `2.1.0`. Default layout:
  `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session>.jsonl`, default `~/.claude`.
  A real release-matched capture and owner validation are required before host
  activation; no tested release compatibility is claimed for this profile.

Missing versions return `MissingVersion`, unknown profiles `UnsupportedVersion`.
Malformed JSON/known record shapes or unpaired/duplicate tool IDs return
`MalformedRecord`; unknown semantic records return `UnsupportedRecord`.
Missing trusted registration returns `InvalidContext`; a foreign checkpoint
returns `StateMismatch`. Every error carries the record offset and detail.
Callers must not guess a newer profile or discard an error and advance a receipt.

## Mapping

| Source                                                                                                        | Draft / explicit skip                                                                            |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Claude user string / text                                                                                     | Owner-authored prompt                                                                            |
| Claude assistant string / text                                                                                | Participant-authored assistant part                                                              |
| Claude `isApiErrorMessage`                                                                                    | Failed error part                                                                                |
| Claude `thinking`, `redacted_thinking`                                                                        | Thinking text / retained redaction                                                               |
| Claude `image`                                                                                                | Attachment payload                                                                               |
| Claude `tool_use`                                                                                             | Tool request with its ID, name, inert input                                                      |
| Claude `tool_result`                                                                                          | Paired result with `tool_use_id` and `is_error`                                                  |
| Claude Edit / Write / MultiEdit results                                                                       | Additional reported edit, success/failure; never an observed write                               |
| Claude system `compact_boundary`                                                                              | Retained boundary data in transcript                                                             |
| Claude `queue-operation`, `file-history-snapshot`, `progress`                                                 | Explicit bookkeeping skip                                                                        |
| Codex `response_item.message` user / assistant text                                                           | Prompt / assistant part                                                                          |
| Codex message encrypted body                                                                                  | One placeholder replaces the entire body, including adjacent plaintext/images                    |
| Codex message image                                                                                           | Attachment                                                                                       |
| Codex developer / system messages                                                                             | Model instruction skip; never owner prompts                                                      |
| Codex reasoning summary / content                                                                             | Thinking parts                                                                                   |
| Codex encrypted reasoning                                                                                     | One `Encrypted by Codex` placeholder for its encrypted body                                      |
| Codex `agent_message`                                                                                         | Plain text, or one placeholder for an encrypted body; source author/recipient confer no identity |
| Codex function / custom tool calls                                                                            | Correlated request; raw arguments/input remain inert                                             |
| Codex function / custom tool outputs                                                                          | Correlated string or structured result, retained without execution                               |
| Codex apply_patch output                                                                                      | Additional reported edit; recognized textual failure markers remain reported failures            |
| Codex event_msg error / turn_aborted                                                                          | Failed error / interruption part                                                                 |
| Codex task start/completion, token_count, item_completed, user_message, agent_message, agent_reasoning events | Explicit notification skip; canonical bodies are response_item records                           |
| Codex session_meta, turn_context, world_state, token_usage_record                                             | Explicit context/usage skip                                                                      |
| Any other semantic type                                                                                       | Tagged rejection; no silent fallback                                                             |

Encrypted message and agent-message bodies are validated before one placeholder
is emitted. Unknown or malformed adjacent parts still reject the record;
plaintext and images adjacent to ciphertext are not emitted separately.

Tool-result failure text patterns are `Process exited with code [1-9]`, `Error:`
and `Failed to`; these describe source reports, never inferred file changes or
TODO state. Claude tool results retain structured bodies. The decoders preserve
input order, including sidechains; they do not rewrite parent chains into runs.
Source UUIDs/response IDs are retained; records without native IDs use byte
offsets. Deterministic draft IDs include agent, registered session, generation,
record offset, source ID and part index.

## Evidence and limitations

`test/fixtures/external/manifest.json` records capture procedure, shapes,
redactions and evidence limits. Expected outputs are committed independently;
tests never derive expectations from production decoders or spec Markdown.
The public package entry point is the acceptance boundary for this library;
there is no person-facing route in this ticket. The real Codex excerpt includes
multiple messages, paired tools and one encrypted reasoning body. Claude inputs,
edit failures, explicit errors and encrypted agent-message examples are labeled
synthetic. **C-AGT-01 is not complete** until real Claude and edit/error captures
replace that missing evidence, supported profiles are validated, and the library
owner signs off §21.1. No benchmark-gate hot path listed in §21.1 is changed.
