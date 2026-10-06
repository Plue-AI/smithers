# Design brief: working together on one branch

You are one of four independent designers (Codex Sol, Codex Astra, Claude Fable, Claude Opus). A fifth agent will merge the four designs. Design independently; do not look for the other designs.

## Decision we need

How Smithers lets several people and the coding agent work on the same branch at the same time, correctly, with the right abstractions, built once. In scope for the MVP launch (owner ruling, 2026-10-06):

1. **One live branch.** Each awake branch has one machine. Members and the coding agent share its working copy. Presence: who is on the branch and where (a terminal, a file, a run).
2. **Per-person terminals and SSH.** Each member has their own terminal (watch-only sharing), their own unix identity and home on that machine, no sudo; editors such as VS Code or Cursor connect over SSH and their saves show up attributed.
3. **Outside changes are seen and attributed.** Saves from SSH editors, terminals, formatters and the agent appear in open cards as attributed changes, grouped into readable activity ("Maya via SSH changed 12 files"), and every change is recoverable.
4. **Two people typing in the same file at once.** Character-level co-editing in the File card, each person's cursor and edits live in their colour, saved to the machine continuously so the agent and terminals see it at once. An outside save (SSH editor, formatter) landing on a file people are typing in must merge or be recoverable, never silently lost.
5. **One shared conversation per branch.** Everyone on the branch sees the same chat with the app agent; each prompt runs with its author's identity and permissions.

Wiki pages are co-edited live too (they already merge with Yjs).

## Read first (paths relative to the repository root; use the latest `origin/frontrun`)

- Product: `.specs/product/mvp.md` §5 J3 (Join a branch), §6.7 Branches and machines, §6.8 Multiplayer on a branch, §6.15, §9 quality bar, §11 stages 2 and 3, §12 release.
- Engineering: `.specs/engineering/overview.md` (decisions E-03, E-04, E-05, E-10, E-16, E-18, E-20; top risks), `.specs/engineering/spec.md` §5.5, §7 Live channel (§7.3 presence, §7.4 live documents, §7.5 terminals), §8 Branches and machines, §9 the machine daemon (§9.1–§9.6), §14.1 shell and branch conversations, §14.5, §18 performance budgets, §19 durability. `.specs/engineering/design/machined.md`. Tickets: `.specs/engineering/tickets/T-COL-*.md`, `T-TRM-*.md`, `T-MCH-04.md`, `T-MCH-06.md`, `T-MCH-11.md`, `T-APP-11.md`, `T-APP-14*.md`, `T-APP-16.md`, `T-UI-19.md`.
- ADRs under `docs/` or `.specs/` that mention 0003 (live-document topology) and 0004.

## What exists today (measured 2026-10-05/06; verify in code)

- A spike (T-COL-01) measured the planned path browser → host → relay → machine on a contended laptop: relay round trip p95 197 ms against a 20 ms target, and a 30 Hz keystroke bridge p95 1,738 ms against a 1 s target. The reference-host rerun has not happened. ADR 0003 may move fan-out to a host-side document mirror with the machine as disk authority.
- The machine daemon (`smithers-machined`, Rust) exists as components (bursts, outbox, session credit, document pieces, an isolated Cargo test crate) but has no production binary or startup composition. Session RPC and the session broker are not implemented end to end.
- The live channel (`/api/live`, WebSocket over the existing `sse.Broker`) is composed but serves only Home, TODO and Flows topics; branch, conversation, document, members and presence topics answer "unsupported".
- Branch machines: the install composes per-lane machines owned by the machine service; the membership provider admits only the owner, so members cannot join a branch machine yet. `workspace_shares` grants exist.
- File writes through Smithers (`WriteWorkspaceFile`) carry no base digest, so stale writes are not refused (spec §7.6 requires that).
- Editor and document components exist in the app (CodeMirror File card, Yjs wiki); there is no production live-file provider.
- Conversations: chat turns run on the host for the author; branch conversation storage and member view state landed recently; shared reads, revocation and the shell cutover are not done; `app_timelines` still exists.
- Wave 1 (about 660 automated lane passes overnight) left these tickets mostly blocked on the daemon startup, the session RPC, final capture and a real reference-host microVM run.

## What to produce

Write one Markdown design (about 2,000–4,000 words) with these sections:

1. **Summary**: the design in five sentences.
2. **Abstractions**: the few core objects and who owns each (branch, machine, session, file, document, change, conversation). Name the source of truth for every piece of state and where it lives (host PostgreSQL, machine disk, daemon memory, browser).
3. **Co-editing model**: CRDT or OT or something else, which library (Yjs/Yrs, Automerge, Loro, other), where documents live (machine, host mirror, both), how the file on disk and the live document stay consistent, how outside saves and the agent's writes merge, how undo and recovery work, and how this meets the latency budget given the spike's numbers. Argue the alternatives you rejected.
4. **Attribution and change tracking**: how every write gets an author (Smithers-routed writes vs terminals vs SSH vs the agent), grouping into activity, and recovery.
5. **Sessions, identity and terminals**: unix users and homes per member, SSH, revocation within 5 s, watch-only sharing, the agent's own terminal.
6. **Presence and live updates**: transport, topics, reconnect and gap-free resume, scale per branch.
7. **Shared conversation**: storage, ordering, who runs which turn with which credential, privacy, revocation, how the agent sees context.
8. **Failure and durability**: machine sleep and wake, crash, network drop, host restart, concurrent rebase while people type; what is never lost.
9. **Reuse map**: for each piece, what existing code to keep, reshape or delete (with paths), and what is net new. Prefer reuse; the owner's rule is zero tech debt and one implementation per behavior.
10. **Build plan**: ordered, parallelizable work items (each about 1–4 agent-days) with the interfaces fixed first so many agents can build against them at once, and the tests that prove each (unit, integration with real PostgreSQL, end-to-end in a browser, and a real-machine check).
11. **Risks and open questions**: each with how to falsify it cheaply.

Be concrete: name files, protocols, message shapes and data shapes. Plain language; no padding.
