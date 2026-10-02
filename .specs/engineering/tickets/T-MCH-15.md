# T-MCH-15 Per-member credential store: tool logins carry across machines

Stage S2 · Size M · Depends on T-MCH-11, T-COL-03 · Unblocks T-MNT-02 · Issue: to file
Spec: spec.md §3 (`member_credentials`), §5.6, §8.7.2, §8.7.3, §9.1.2 (`seed_credentials`), §17.4 · Delta: delta.md §3 (per-member users row) · Product: mvp.md §6.8 Terminals, J6.1, M-18

## Goal

A person logs in to Claude Code, Codex or `gh` once per install. A login made in any branch's terminal is in their home on every other machine at its next session, and a refreshed token flows back, with the newest write winning. Tool history, caches and databases never leave their machine.

## Scope

In:
- `member_credentials` (§3): one row per member and file, sealed under the install key (§17.4).
- The five tracked files (§8.7.3): `~/.claude/.credentials.json`; the account fields of `~/.claude.json` (`oauthAccount`, `userID`, `primaryApiKey` when present), merged into the file and never replacing it whole; `~/.codex/auth.json`; `~/.config/gh/hosts.yml`; `~/.gitconfig`.
- Seeding: `seed_credentials(member, files[])` on the daemon's control RPC (§9.1.2). The daemon writes each file as the member with mode 0600, at the member's first session after each wake and whenever the store changes. The host pushes a change to every awake machine where the member has a home.
- Return path: the daemon watches the five paths with inotify, apart from the working-copy watcher and never as bursts. A changed file (content differs from the last seeded copy) is sent as `credential_changed{member, file, content, written_at}`. The host keeps the newest `written_at`; a tie goes to the later arrival. Then it seeds every other awake machine. A deleted tracked file sends `content: null`; the host deletes its store row and every other machine deletes the file at once or before its first session after wake (§8.7.3, C-MCH-10 step 9).
- Revocation (§5.6): removing or suspending a member deletes their rows, and every awake machine deletes the seeded files within 5 s. A sleeping machine does it at wake, in `wake_reconcile` before any session starts.
- No read path: no flow, API, card or CLI command returns a credential value (§8.7.2).

Out:
- Homes and users (T-MCH-11). Terminal sign-in tokens for the Smithers CLI (T-TRM-02); those are delegated credentials, not tool logins.
- Other tool files (history, caches, settings beyond account fields). Adding a tracked file is a spec change.

## Changes

- `packages/backend/db/product/migrations/<next>_member_credentials.sql` (new), its queries and sqlc output.
- `packages/backend/internal/services/member_credentials.go` (new): seal and unseal with the install key, newest-wins merge, fan-out to awake machines, revocation.
- `crates/smithers-machined/src/credentials.rs` (new), in the root broker: every read and write runs in a child dropped to the member's uid and gids, opening with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS` from the home's descriptor, regular files up to 1 MiB only (§9.5.1–§9.5.2, C-COL-04 step 3); write as the member (0600), merge `~/.claude.json` account fields with `serde_json` preserving every other field, watch the five paths, debounce 500 ms, send `credential_changed` through the outbox (§9.1.4, C-COL-05).
- `crates/smithers-machined/src/rpc.rs`: `seed_credentials`; `wake_reconcile` applies pending deletions before sessions start.
- `packages/backend/internal/services/members.go`: removal and suspension call the revocation path.
- `packages/backend/docs/machined.md` and `packages/backend/docs/members.md`: the store, the five files and the merge rule; docs gates.

## Tests
- integration: a logout on one machine (Codex deletes `~/.codex/auth.json`; `gh` rewrites `hosts.yml`) reaches every other machine within 5 s, and no later seed restores the old login (C-MCH-10 step 9).


- unit (`credentials.rs`): merging account fields into a `~/.claude.json` with 40 other keys changes only those fields, byte-stable for the rest; a file equal to the last seeded copy sends nothing; a write burst within 500 ms sends one change.
- unit (`member_credentials_test.go`): newest `written_at` wins, ties go to the later arrival; a stale change is dropped and logged; ciphertext never equals plaintext and no query returns plaintext outside the service.
- integration (reference host, two real microVMs, `packages/backend/microsandbox/real_credentials_test.go`, new): C-MCH-10's steps.
- integration: suspending Ben deletes his rows and removes the five files from an awake machine within 5 s and from a sleeping one before its first session after wake.

## Acceptance
- [C-COL-04](../checks/C-COL-04.md): step 3: credential reads and writes cannot follow symlinks or escape the member's home.


- [C-MCH-10](../checks/C-MCH-10.md): log in once, use everywhere; refreshed tokens flow back; history stays local; revocation removes credentials.
- [C-REL-05](../checks/C-REL-05.md): 24 h soak with live Claude Code, Codex and `gh` logins on two machines: no login prompt

## Risks and notes

- Providers rotate refresh tokens, so when two machines refresh the same token, the loser's refresh fails. The store seeds the winner's token to the loser within 5 s, and the loser's tool must pick it up without a login. Confirmed broken if C-MCH-10 step 4 shows a login prompt, or C-REL-05's 24 h soak shows one. If a tool caches the token in memory and never re-reads the file, record that tool's behavior; don't add per-tool locking without measurement.
- `~/.claude.json` field names can change between Claude Code releases. Confirmed when a login on one machine doesn't sign in another. The tracked field list lives in one table in `credentials.rs`, covered by a fixture from the current release.
- The host stores live tool tokens. They are sealed like provider keys (§17.4) and never leave the credential service except to the member's own home.
