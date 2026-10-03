# T-AGT-01 External transcript mapping and Claude Code/Codex adapters

Stage S2 · Size M · Depends on T-APP-16, T-APP-09 · Unblocks T-AGT-02, T-REL-02 · Issue: [#3621](https://github.com/smithersai/smithers/issues/3621)
Spec: spec.md §9.6.6, §14.5.5, §21.1 · Delta: delta.md §9 · Product: mvp.md M-38, M-34
Ready: 2026-10-03 smithers-8a sha256:29aa84c2e61e

## Goal

Normalize both agents into the existing conversation and transcript run-event model.

## Ownership

Library; smithers-38 decides package placement, supported adapter profiles, semantic mapping, metadata skip rules and public exports, and signs off §21.1 evidence. smithers-3f approves the T-AGT-02 host-ingest seam and security boundary. Existing owner answers stand; remaining owner review follows the parallel-build directive post hoc.

## Scope

In:
- Pure functions for both source formats, versioned input, typed errors, recorded golden transcripts and a complete mapping table.

- Land dark against T-APP-16's conversation-entry contract and T-APP-09's actor contract. If either dependency is unavailable, export only inert normalization functions; do not register an importer, publish entries or fall back to executable run identities. T-AGT-02 owns activation and refuses unavailable ingestion providers. C-AGT-01 tests this ticket's absence of activation and side effects.

Out:
- Transcript discovery, file reads, inotify, daemon framing, outbox transport, persistence, live publication, revocation and backend mutation enforcement (T-AGT-02).
- Conversation views, avatars and controls (T-AGT-03); agent process registration and credential minting.
- Additional agent formats, a generic plugin framework, decryption, executable run creation, tool execution, TODO transitions and observed-write attribution.
- The internal `/ceo` flow (T-AGT-04) and product surfaces beyond M-38.

## Changes

- Reshape the existing transcript library first: `packages/smithers/agent/harness/src/Transcript.ts` projects harness journal entries, not raw Claude Code or Codex records. Reuse its message types and error/replay conventions; compare `packages/smithers/gateway/src/GatewayProjection.ts`'s transcript projection and `packages/rpc/src/EntryRowCard.ts` and `CardPrimitives.ts` before adding fields. These existing projections do not decode external source formats or retain external session/source identity. The production caller is T-AGT-02's host TypeScript source-record ingestion, between daemon outbox delivery and the atomic conversation-entry/receipt commit (§9.6.6); it is not implemented by this ticket. Record the caller sketch and the smallest missing decode API for smithers-38. Add only the two agent-specific decoders that composition cannot supply; do not introduce a generic adapter framework without two callers.
- Map user records to owner-authored prompts, assistant content to turns, tool requests/results to correlated events, file-edit reports to transcript edit events, and errors to failed transcript parts. Preserve ordering and source record identities. Do not invent executable run steps, TODO state or observed file changes.
- Commit sanitized, recorded real Claude Code and Codex transcripts, expected events and a manifest with CLI release, capture procedure, format version and record shapes. Preserve real structure and document redactions. Include tool calls/results, successful and failed edits, errors and multiple turns for each format.
- Require an explicit format-version field. Where the source has no native schema version, use an explicit validated adapter profile tied to a supported release and record shape. Missing/unknown versions and unknown semantic records return tagged errors, never a guessed latest version. Known metadata skip rules are explicit and tested.
- Keep adapters free of I/O, clocks, network calls and process discovery. Expose canonical entry/event drafts for host ingestion. Add JSDoc with @since and package docs; meet §21.1 coverage, error, interruption/replay and applicable benchmark gates.

## Tests

C-AGT-01 (folded steps and assertions):
- Boundary: call the production public adapter exports from the package entry point, exactly as T-AGT-02's host ingest will call them; do not test a private decoder in isolation as acceptance evidence. Commit expected outputs independently of the implementation. Tests never read the spec to build expectations or regenerate expectations from production code at runtime.
1. Decode each fixture with its declared format version and compare complete entries/events to committed expected output, including `origin: external`, `read_only: true`, agent kind, source format version, session and participant ids. Owner and participant identities come from explicit caller context, never identities asserted inside transcript text.
2. Assert prompt ownership inputs, assistant turns, tool ids and paired results, reported file edits and explicit errors. Test known metadata skip rules.
3. Replay whole input and every record-boundary chunk partition with the same explicit parser state; compare event ids and order.
4. Supply missing and unknown versions, changed record shapes, malformed complete records and unknown semantic records. Supply an incomplete final record separately.
5. Supply transcript text containing shell commands, paths, forged owner/participant ids and mutation requests. Assert it remains inert content with the caller's identities. Exercise the public exports with unavailable conversation/actor providers: no importer registration, I/O, model dispatch, command execution or publication occurs. The functions require only explicit input and parser state, not live providers.
6. Decode the recorded encrypted Codex body through the same exports and assert exactly one retained body placeholder, "Encrypted by Codex", with the original source identity and order. Rendering that placeholder is T-AGT-03's responsibility.

Pass when:
- Both real formats match golden output without losing semantic content; adapter functions perform no I/O.
- Replay and chunk boundaries yield identical ordered output with correlated tools.
- Missing/unknown versions and unsupported semantic records return tagged errors. An incomplete record requests more bytes rather than disappearing.
- Fixture manifests identify real CLI releases and redactions; fabricated-only transcripts do not pass.

Fail when:
- Any pass condition fails or either agent format is skipped.


- C-AGT-01 covers both formats, deterministic replay, tool correlation, malformed records and version rejection.
- A golden Codex transcript with an encrypted message body (product, 2026-10-02): the entry renders as one line, "Encrypted by Codex", in place of the body, and is never dropped.

## Acceptance

- [C-AGT-01](../checks/C-AGT-01.md): C-AGT-01 passes; smithers-38 signs off exports and §21.1 evidence.

## Risks and notes

- Prior art, input only and not code to port: `~/.local/share/will-brief/README.md` (component props, the shared event model, state and timeline JSON), `CEO-FLOW.md`, and `adapters/claude_code.py`, `adapters/codex.py`, `adapters/events.py` (smithers-a6 prototype, via product 2026-10-02).

- Adapter functions run in the existing host TypeScript process. The daemon transports framed source records; it does not duplicate semantic mapping.
- Security: only install-shipped adapter code runs on the host. Branch transcripts are untrusted data, never modules, commands or authority. Repository code and real CLI fixture captures run only in machines (M-29, §1.3), as an unprivileged member. smithers-3f reviews this boundary; C-AGT-01 proves inert decoding and caller-owned attribution. Owner-uid source validation remains T-AGT-02's C-AGT-02 prerequisite for activation. This ticket adds no root step and consumes no input as root; root discovery and reads are excluded.

## Ready checklist

1. Dependencies: T-APP-16 owns conversation entries; T-APP-09 owns actor identity. Scope lands dark if either contract is unavailable; T-AGT-02 owns later activation, so no ingestion dependency cycle is introduced.
2. Exclusions: Scope names ingestion, UI, credentials, extra formats, decryption, executable runs, observed writes and `/ceo` explicitly.
3. Acceptance boundary: C-AGT-01 calls production public adapter exports with independently committed real-fixture expectations; covers errors, replay, inert input, external metadata and encrypted bodies.
4. Decisions: smithers-38 accepts mapping, profiles, package placement, API and §21.1 evidence; smithers-3f accepts the ingest and security seam. No ADR or UI decision is delegated to the implementer.
5. Owner pre-review questions: smithers-38: Does the existing transcript API plus composition need these two decoders? Do the mapping, profiles and golden outputs preserve every semantic record? smithers-3f: Does the host-ingest draft contract preserve caller-owned identities and keep branch input inert without root reads? Recorded answers stand; remaining review is post hoc under the parallel-build directive. No apps/ or UI view change is in scope.
6. Security: install-shipped pure host code decodes branch data without execution; real repository/CLI execution stays in machines. smithers-3f reviews it; C-AGT-01 tests inertness. No root step or root-consumed input is added.
