# C-AGT-02 Live external sessions appear read-only with attribution and home isolation

Proves: mvp.md M-38, M-34 · spec.md §9.6.6, §14.5.5 · Layer: e2e · Stage: S2 · Tickets: T-AGT-02, T-AGT-03
Automation: unavailable (owner-approved executable mapping pending; C-PRC-03) · Runs in: reference host and browser runner

## Setup

Real branch machine with Linux inotify/cgroups, real PostgreSQL, Ben and Maya homes, supported installed Claude Code and Codex, test provider accounts and two authenticated browsers. No fake agent transcript producer.

Candidate Automation declaration (unapproved): packages/backend/microsandbox/real_external_transcripts_test.go and apps/app/e2e/external-transcripts.spec.ts (new) · Runs in: reference host and browser runner

Owner action before PRC-03 activation: supply an explicit approved executable command and its declared Runs in host. Do not infer a command from a path or prose. Until that mapping is approved and available, the runner refuses this check and ticket closure remains blocked. Check: C-PRC-03.

## Steps

1. In Ben's branch terminal, start real Claude Code, then real Codex. Prompt each for an assistant answer, a tool call and file edit. Record complete transcript-record append and browser-render times.
2. Watch the branch conversation as Ben and Maya. Verify prompts, assistant/tool content, errors and separate agent participants in conversation, presence and terminal data.
3. Attempt imported edit, resend, answer, approve, retry, stop and steer through UI and direct backend mutations. Check that import did not queue an app-agent turn or execute a command.
4. As Maya, attempt reads of Ben's raw transcript and unrelated history through terminal, file APIs and crafted tail/source requests. Try a symlink to Ben's transcript from Maya's allowed root and a forged session/uid. Reverse owners and repeat. Confirm an unrelated historical session was not imported.
5. Reload both browsers, interrupt/reconnect the daemon connection and replay unacknowledged records. Exercise truncation, replacement, partial writes and inotify overflow in a real transcript tail. Change a source to an unsupported version.
6. Remove the session owner and check reads/watches stop within the existing 5 s revocation bound.

## Pass when

- For both real agents, every measured complete record appears within 5 s on a healthy connection. Parsed entries persist and reload without duplication or lost complete records.
- Assistant/tool events have the agent's own avatar and for_member; user prompts name the owner. Agent and member avatars remain separate.
- Imported content is read-only for both viewers. Copy/disclosure/navigation work; mutations are absent and backend requests are refused without side effects.
- Only normalized linked-session content is shared. Raw files, unrelated home history, cross-owner requests and symlink escapes are refused; no import reads another member's home.
- Reconnect/lifecycle tests preserve ordering and correlation. Unsupported version produces a visible import error, never silent success.
- Revocation stops reads within 5 s. Imported file-edit reports do not alter observed-write attribution.

## Fail when

- Any pass condition fails or either agent format is skipped.

## Evidence

`.artifacts/checks/C-AGT-02/<ts>/`: fixture/release manifest, expected and actual events, logs and landed commit. Include append-to-render timings, redacted browser traces, isolation denials and replay receipts.
