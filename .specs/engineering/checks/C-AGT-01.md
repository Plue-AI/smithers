# C-AGT-01 Golden transcripts normalize both formats; version mismatch fails

Proves: mvp.md M-38, M-34 · spec.md §9.6.6, §14.5.5 · Layer: unit · Stage: S2 · Tickets: T-AGT-01
Automation: unavailable (owner-approved executable mapping pending; C-PRC-03) · Runs in: package unit runner

## Setup

Recorded real transcripts for each supported Claude Code and Codex release, sanitized fixtures, manifest and expected canonical entries/events.

Candidate Automation declaration (unapproved): packages/model-host/test/ExternalTranscripts.test.ts (new; T-AGT-01 owns the final existing-library location) · Runs in: package unit runner

Owner action before PRC-03 activation: supply an explicit approved executable command and its declared Runs in host. Do not infer a command from a path or prose. Until that mapping is approved and available, the runner refuses this check and ticket closure remains blocked. Check: C-PRC-03.

## Steps

1. Decode each fixture with its declared format version and compare complete entries/events to committed expected output.
2. Assert prompt ownership inputs, assistant turns, tool ids and paired results, reported file edits and explicit errors. Test known metadata skip rules.
3. Replay whole input and every record-boundary chunk partition with the same explicit parser state; compare event ids and order.
4. Supply missing and unknown versions, changed record shapes, malformed complete records and unknown semantic records. Supply an incomplete final record separately.

## Pass when

- Both real formats match golden output without losing semantic content; adapter functions perform no I/O.
- Replay and chunk boundaries yield identical ordered output with correlated tools.
- Missing/unknown versions and unsupported semantic records return tagged errors. An incomplete record requests more bytes rather than disappearing.
- Fixture manifests identify real CLI releases and redactions; fabricated-only transcripts do not pass.

## Fail when

- Any pass condition fails or either agent format is skipped.

## Evidence

`.artifacts/checks/C-AGT-01/<ts>/`: fixture/release manifest, expected and actual events, logs and landed commit. Include package coverage and tagged error assertions.
