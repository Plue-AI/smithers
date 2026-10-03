# T-AGT-02 Session-owned transcript tail and branch ingestion

Stage S2 · Size L · Depends on T-AGT-01, T-TRM-07, T-TRM-01, T-COL-02, T-COL-06, T-APP-16, T-COL-03r · Unblocks T-AGT-03, T-REL-02 · Issue: [#3622](https://github.com/smithersai/smithers/issues/3622)
Spec: spec.md §7.2, §7.3, §8.7.2, §9.1.2, §9.6.6, §14.5.5 · Delta: delta.md §9 · Product: mvp.md M-38, M-34
Ready: 2026-10-03 smithers-8a sha256:0435c9e09b24

## Goal

Tail the terminal owner's identified external-agent transcript and publish its parsed conversation live.

## Ownership

smithers-3f owns daemon/backend and accepts discovery, privilege, framing limits, receipt transactions and revocation decisions. smithers-38 approves adapter/presence library seams and any public API diff under §21.1. smithers-b8 approves the host TypeScript integration and user-facing mutation contract. smithers-06 approves shared-chat presentation seams; T-AGT-03 owns their implementation. Will decides any change to M-38 scope. Owner pre-review questions are listed below; reviews follow the parallel-build directive post hoc.

## Scope

In:
- Process-tree discovery, owner-uid reader, separate inotify tail, outbox, host normalization, attribution and read-only enforcement.
- Land dark against the specified contracts of every unlanded dependency in Depends on. Until adapters (T-AGT-01), registered owner sessions (T-TRM-07/T-TRM-01), authenticated live delivery (T-COL-02), presence (T-COL-06), conversation storage (T-APP-16) and transcript wire support (T-COL-03r) are available and validated, refuse import as unavailable before discovery, home reads or persistence. Missing identity, revocation, confinement or receipt providers also refuse; never fall back to host execution, history scanning or a second store. C-AGT-02 TestExternalImportUnavailable exercises each missing provider through production ingress.

Out:
- Browser component wiring and controls (T-AGT-03); adapter semantics and supported-release fixtures (T-AGT-01).
- Other agent formats, historical/home-wide imports, raw transcript downloads, credential sharing, host execution of repository code, executing imported tool text, writable imported conversations, new presence rosters and generic adapter frameworks. No changes to session admission, Unix identity allocation or observed-write attribution.

## Changes

- Reuse `packages/backend/internal/chat/store.go:792` (Commit), `http.go:399` (History) and `dispatcher.go:38` (Dispatcher) through T-APP-16's reshaped storage/replay paths; imports never enter Dispatcher. Reuse T-COL-06's `packages/smithers/flows/sync/src/BranchPresence.ts:77` roster and T-COL-03's transactional event-receipt path. Extend T-COL-03r/T-COL-03a's `crates/smithers-machined/` and T-TRM-07's registry, broker confinement and outbox; these paths are dependency deliverables, not existing code today.
- New transcript discovery, owner-reader and framing/tail code is required because the existing `packages/backend/internal/routes/terminal_session_manager.go:59` manages terminal viewers, and `packages/backend/microsandbox/guest/smithers-guest.py:140` runs one-shot commands; neither identifies or continuously tails an external transcript. Extend the shared daemon, not a second broker or ingestion service.
- Add broker discovery using T-TRM-07's registry. Verify agent executable, process lifetime, cgroup, uid and source linkage. Support both default roots and fixture-documented overrides. Import only the linked session source; do not scan unrelated history or other homes.
- Read through an owner-uid child with beneath-root, no-symlink regular-file checks. Add bounded record framing and partial-line buffering; document limits in the profile and report malformed/oversized records visibly.
- Add inotify tail plus 1 s reconciliation. Handle file replacement, truncation, overflow and reconnect with source generation/offset identity and §9.1.4 receipts.
- The existing install-shipped host TypeScript process calls T-AGT-01's pure adapters and passes canonical drafts to the authenticated backend ingestion path. Commit entries/events and the §9.1.4 receipt atomically, then acknowledge and publish `conversation:<branch>` deltas. Failed commits publish nothing and remain replayable. No model launch, delegated credential or executable run is created. Reuse `chat_turns`, `chat_turn_batches` and T-COL-03's receipt table; no new table is in scope. An added table requires rescoping and a `planned:T-AGT-02` ownership reservation accepted by smithers-8a with encoding approved by smithers-3f before Ready (C-PRC-02).
- Register an agent participant per process lifetime with for_member from the registry; reuse it in presence, terminal data and conversation. Stop reads on revocation while preserving shared history.
- Refuse imported-content mutations server-side. Provide no raw-transcript-file endpoint. Imported edit reports do not change §9.3 attribution.

## Tests

C-AGT-02 (folded steps and assertions):
- Production boundaries: launch through the authenticated terminal route and T-TRM-07 `open_session`; discover through the real broker; send records through the authenticated daemon connection, host adapter and backend ingestion handler; read through authenticated conversation history/replay and `/api/live` subscriptions to `conversation:<branch>`. Exercise mutations through production routes/dispatch, not direct store calls. Keep Dispatcher running and observe that imports never launch a turn. Browser presentation assertions belong to T-AGT-03's portion of this shared check.
- Commit literal expected normalized entries, actor identities, tool correlations, refusal outcomes and sentinel bytes from sanitized real-agent fixtures; capture live output separately. No test reads the spec or computes expected policy/output with production parsers, encoders or constants at runtime.
- `TestExternalImportUnavailable`: omit each provider named in Scope at production ingress; every attempt refuses with no watcher, home read, entry, receipt, model launch or command execution.
- `TestExternalTranscriptRootInputs`: exercise the real broker discovery/socketpair/child path in a machine with hostile configuration, executable links, PID reuse, forged session/uid/cgroup, malformed/oversized IPC, home symlink swaps and special files. Observe non-root UID/GID and owner supplementary groups before any home/config/transcript read; outside sentinel content/owner/mode stay unchanged. Include valid default and fixture-supported override controls. This test gates every branch/member input listed below.
- `TestExternalImportCommitReplay`: drive production ingestion with real PostgreSQL; fail before transaction commit and after commit before acknowledgement/publication, restart and replay. Literal expected entries/events occur once, ordered; receipt and entries commit together, and no pre-commit delta appears.
1. In Ben's branch terminal, start real Claude Code, then real Codex. Prompt each for an assistant answer, a tool call and file edit. Record complete transcript-record append and browser-render times.
2. Watch the branch conversation as Ben and Maya. Verify prompts, assistant/tool content, errors and separate agent participants in conversation, presence and terminal data.
3. Attempt imported edit, resend, answer, approve, retry, stop and steer through UI and direct backend mutations. Check that import did not queue an app-agent turn or execute a command.
4. As Maya, attempt reads of Ben's raw transcript and unrelated history through terminal, file APIs and crafted tail/source requests. Try a symlink to Ben's transcript from Maya's allowed root and a forged session/uid. Reverse owners and repeat. Confirm an unrelated historical session was not imported.
5. Reload both browsers, interrupt/reconnect the daemon connection and replay unacknowledged records. Exercise truncation, replacement, partial writes and inotify overflow in a real transcript tail. Change a source to an unsupported version.
6. Remove the session owner and check reads/watches stop within the existing 5 s revocation bound.

Pass when:
- For both real agents, every measured complete record appears within 5 s on a healthy connection. Parsed entries persist and reload without duplication or lost complete records.
- Assistant/tool events have the agent's own avatar and for_member; user prompts name the owner. Agent and member avatars remain separate.
- Imported content is read-only for both viewers. Copy/disclosure/navigation work; mutations are absent and backend requests are refused without side effects.
- Only normalized linked-session content is shared. Raw files, unrelated home history, cross-owner requests and symlink escapes are refused; no import reads another member's home.
- Reconnect/lifecycle tests preserve ordering and correlation. Unsupported version produces a visible import error, never silent success.
- Revocation stops reads within 5 s. Imported file-edit reports do not alter observed-write attribution.

Fail when:
- Any pass condition fails or either agent format is skipped.


- C-AGT-02 uses real Linux inotify/cgroups, PostgreSQL and real agent sessions; covers isolation, latency, replay and lifecycle.

## Acceptance

- [C-AGT-02](../checks/C-AGT-02.md): C-AGT-02 daemon/backend assertions pass.

## Risks and notes

- Framing occurs in Rust; semantic normalization occurs in the host TypeScript library before live deltas. No S1 ticket depends on this work.

## Security preconditions and root inputs

Repository code, including the real agent CLIs and test commands, executes only as unprivileged users inside machines (M-29, §1.3). The host runs only install-shipped adapters and treats transcript bytes as data. Members and agents have no sudo. smithers-3f reviews the following root boundary; C-AGT-02 TestExternalTranscriptRootInputs must pass before privileged consumption of branch/member data is enabled.

- Root discovery consumes: broker binary, compiled agent profiles, fixed socketpair protocol/limits and fixed cgroup subtree from main in the install package; session id, owner UID/GID/groups/home and revocation state from the authenticated host registry (main implementation, member-derived identity data); process-tree PID/start time, uid, cgroup and executable metadata from the guest kernel, influenced by branch/member processes; argv, cwd, environment, executable links and configured agent-home/override hints from branch/member processes and files. Validate bounded hints against the live registry and process lifetime; do not accept a caller-selected owner. Read home configuration only after dropping to the registered owner. Never load or execute a branch binary/profile/configuration as root.
- Root reader creation consumes: main-shipped child code, fixed startup environment and IPC schema; owner identity and root descriptor bound to the authenticated session registry; source identifiers, path hints, IPC lengths and lifecycle requests from the unprivileged daemon, derived from branch/member data; passwd/group, directory ownership/modes and filesystem/kernel responses from the installed guest with member-controlled retained home entries. Validate identity, bounds, root binding and lifecycle before use. Drop supplementary groups to the owner's registered set, then GID/UID before resolving configuration or transcript paths. No branch-sourced executable, import path or environment controls child startup.
- The owner-uid reader, not root, consumes branch/member configuration bytes, transcript bytes, path components, symlinks, file types, replacement/truncation state and inotify events. Use held root descriptors, beneath-root/no-symlink regular-file opens and bounded framing. Root watch teardown consumes only validated registry process/session identities and kernel handles, never an arbitrary path or PID from a request. TestExternalTranscriptRootInputs covers stale lifetimes and revocation as well as read setup. Session creation/cgroup management remain T-TRM-07/T-COL-03a's existing root steps; this ticket adds no root package install, shell or repository execution.

## Ready checklist
1. Depends on adds T-APP-16 for shared storage/mutation guards and T-COL-03r for transcript transport. T-TRM-07/T-TRM-01 transitively require T-COL-03/T-COL-03a and T-MCH-11; live/presence require access and revocation providers. All edges are S1/S2. Scope names each unavailable contract and C-AGT-02 proves dark refusal.
2. Out names T-AGT-01/T-AGT-03 ownership, other formats, history scans, raw files, credentials, host execution, imported execution/mutations, duplicate rosters/frameworks and identity/attribution changes.
3. C-AGT-02 names production terminal, broker, ingestion, history/replay, live and mutation boundaries; literal real-agent fixtures define expectations. Root, unavailable-provider and transactional replay tests supplement the existing lifecycle cases; browser wiring remains T-AGT-03.
4. smithers-3f accepts daemon/backend/security and storage decisions; smithers-38 accepts library/public API seams; smithers-b8 accepts host integration/mutation contracts; smithers-06 accepts presentation seams; Will decides product scope changes. Reuse is named first; new discovery/tail code states why existing code cannot serve it. No new table is proposed; any reservation requires smithers-8a/3f approval under C-PRC-02.
5. Owner pre-review, recorded post hoc under the parallel-build directive: smithers-3f: Does registry binding survive PID reuse/revocation? Does every branch-derived root input pass validation before use? Are entries/events and receipts atomic? smithers-38: Do adapter drafts and presence use existing exports? Does any public API change meet §21.1? smithers-b8: Which install-shipped host caller invokes the adapter and backend handler? Do all mutation doors reject external identities without dispatch? smithers-06: Can T-AGT-03 render the imported identity/read-only contract with existing shared components?
6. M-29 confines execution to unprivileged machine users. Security lists inputs and main/branch/member sources for root discovery, reader creation and teardown; smithers-3f reviews them. C-AGT-02 TestExternalTranscriptRootInputs gates privileged use of branch/member data; unvalidated providers stay dark.
