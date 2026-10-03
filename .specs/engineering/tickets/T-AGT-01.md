# T-AGT-01 External transcript mapping and Claude Code/Codex adapters

Stage S2 · Size M · Depends on — · Unblocks T-AGT-02, T-REL-02 · Issue: [#3621](https://github.com/smithersai/smithers/issues/3621)
Spec: spec.md §9.6.6, §14.5.5, §21.1 · Delta: delta.md §9 · Product: mvp.md M-38, M-34

## Goal

Normalize both agents into the existing conversation and transcript run-event model.

## Ownership

Library; smithers-38 signs off the public API under §21.1.

## Scope

In:
- Pure functions for both source formats, versioned input, typed errors, recorded golden transcripts and a complete mapping table.

Out:
- Product surfaces beyond M-38.

## Changes

- Extend an existing transcript library after naming the real host-ingest caller and showing why existing APIs cannot decode these formats. Do not introduce a generic adapter framework without two callers.
- Map user records to owner-authored prompts, assistant content to turns, tool requests/results to correlated events, file-edit reports to transcript edit events, and errors to failed transcript parts. Preserve ordering and source record identities. Do not invent executable run steps, TODO state or observed file changes.
- Commit sanitized, recorded real Claude Code and Codex transcripts, expected events and a manifest with CLI release, capture procedure, format version and record shapes. Preserve real structure and document redactions. Include tool calls/results, successful and failed edits, errors and multiple turns for each format.
- Require an explicit format-version field. Where the source has no native schema version, use an explicit validated adapter profile tied to a supported release and record shape. Missing/unknown versions and unknown semantic records return tagged errors, never a guessed latest version. Known metadata skip rules are explicit and tested.
- Keep adapters free of I/O, clocks, network calls and process discovery. Expose canonical entry/event drafts for host ingestion. Add JSDoc with @since and package docs; meet §21.1 coverage, error, interruption/replay and applicable benchmark gates.

## Tests

- C-AGT-01 covers both formats, deterministic replay, tool correlation, malformed records and version rejection.
- A golden Codex transcript with an encrypted message body (product, 2026-10-02): the entry renders as one line, "Encrypted by Codex", in place of the body, and is never dropped.

## Acceptance

- [C-AGT-01](../checks/C-AGT-01.md): C-AGT-01 passes; smithers-38 signs off exports and §21.1 evidence.

## Risks and notes

- Prior art, input only and not code to port: `~/.local/share/will-brief/README.md` (component props, the shared event model, state and timeline JSON), `CEO-FLOW.md`, and `adapters/claude_code.py`, `adapters/codex.py`, `adapters/events.py` (smithers-a6 prototype, via product 2026-10-02).

- Adapter functions run in the existing host TypeScript process. The daemon transports framed source records; it does not duplicate semantic mapping.
