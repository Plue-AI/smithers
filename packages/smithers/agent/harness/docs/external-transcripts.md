# External transcripts

The public `ExternalTranscript` export from `@smthrs/harness` exposes
`decodeCodex(state, chunk)` and `decodeClaude(state, chunk)`. Start with
`codexStart` or `claudeStart`, then thread the returned serializable state
through each chunk. `Transcript` also re-exports these functions.

```ts
import { ExternalTranscript } from "@smthrs/harness"
import { Result } from "effect"

const decoded = ExternalTranscript.decodeCodex(
  ExternalTranscript.codexStart,
  completeOrPartialJsonl
)
if (Result.isSuccess(decoded)) {
  const { entries, state } = decoded.success
  // Retain state for the next chunk; entries are inert display data.
}
```

Decoders perform no discovery, I/O, publication, tool execution or model calls.
A final line without a newline remains in `state.pending`. A rejection returns
no partial batch. Entries carry external origin, read-only status, agent kind,
format version, session and source identity, sequence and transcript parts.
Source session metadata identifies content; it does not authorize a person or
an executable run.

## Production caller

The composed install serves authenticated session chunks at
`GET /api/external/sessions`. The app's
`apps/app/src/mainview/state/seams/ExternalSessionSeam.ts` calls both decoders,
retains state and advances the host byte offset only after a successful decode.
It validates the response agent, session, owner and offsets. Owner attribution
comes from that authenticated response, not transcript content. The mounted
conversation renders these inert entries through `ExternalEntries`.

This is the current raw-session/browser composition, rather than the earlier
proposed daemon-outbox/host-ingest API. The old `decodeClaudeCode(profile,
context, chunk, state)` caller sketch is no longer an available export.

## Profiles and mapping

Codex `session_meta.cli_version` selects `codex-rollout/0.160`; Claude
conversation-record `version` selects `claude-code/2.1`. Supported release lines
are explicitly listed in `codexReleases` and `claudeReleases`. These profiles
use major/minor release lines, rather than the historical patch-version names.
Missing or unsupported versions and malformed JSON return
`ExternalTranscriptError` with `missing_version`, `unsupported_version` or
`malformed_record`, or `unsupported_record` and a line number.

| Source | Display mapping |
| --- | --- |
| Codex completed user/assistant items | Prompt, text, thinking or encrypted-body placeholder |
| Codex completed command/file-change items | Reported tool or edit result, with source outcome |
| Codex goals, helpers, searches and extensions | Corresponding inert transcript parts |
| Claude owner user records | Prompts; injected metadata is not owner-authored |
| Claude assistant blocks | Text, thinking, tool calls and explicit API errors |
| Claude tool results | Correlated tool/edit parts, including reported failures |
| Claude attachments and system records | Supported transcript parts or metadata skips |

No reported edit is an observed filesystem write. No entry creates an
executable run, TODO transition or authority to mutate a repository.

## Evidence and remaining acceptance

The active golden fixtures are `test/fixtures/external/codex-0.160/` and
`test/fixtures/external/claude-code-2.1/`. Each has a recorded source excerpt,
committed expected entries and a `MANIFEST.md` with release, source-line map,
capture procedure and redactions. Both include multiple turns and tool results;
the manifests identify real edit and error evidence. The earlier flat fixtures
are historical evidence for the replaced API, not the active acceptance inputs.

The current public-export tests cover deterministic chunk replay, incomplete
records, errors, inert content and both recorded formats. Decoder-only coverage
does not establish package-wide §21.1 evidence or owner sign-off.

Unknown Codex record/event types and completed items, and unknown Claude
conversation records/content blocks, return `unsupported_record` without a
partial batch. Known Codex metadata and model-facing duplicate records are
explicit skips; Claude context attachments and system status records retain
the existing profile mapping.

C-AGT-01 remains incomplete. The library owner must reconcile the supported semantic mapping and profiles
with the ticket and sign off exports and §21.1. The browser C-AGT-01 check exercises both recorded captures through the real
raw-session seam, reload and visible semantic refusal with an HTTP contract fake.
It does not establish authenticated reference-machine capture or owner sign-off.
