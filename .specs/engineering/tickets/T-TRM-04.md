# T-TRM-04 Import GitHub SSH keys

Stage S2 · Size S · Depends on T-ACC-02 · Unblocks T-REL-02 · Issue: [#3576](https://github.com/smithersai/smithers/issues/3576)
Spec: spec.md §8.10.2, §12.2 (members' rows, conditional requests), §5.6 · Delta: delta.md §5 (GitHub key import row) · Product: mvp.md J3.2, §6.15 SSH into a branch, M-24

## Goal

A member who has SSH keys on GitHub can `ssh` into a branch right after their first sign-in, without adding a key in Smithers, and a key they delete on GitHub stops working within an hour.

## Scope

In:
- Fetch `GET /users/{login}/keys` at each sign-in and hourly for every active member, with a conditional request (`If-None-Match`, §12.2.1) and the shared GitHub budget (`github_budget.go`, T-GH-02).
- Store each key in `ssh_keys` with `source = github`. Keys added with `smthrs ssh-key` stay `source = manual`, and sync never touches them.
- Sync is a set difference over GitHub-sourced keys: add new ones, delete missing ones, and publish `ssh_key_revoked` (`packages/backend/internal/revocation/event.go:62`) for each deleted key so live sessions on it close.
- A fingerprint already registered to another member is refused for this member and logged, never silently shared.
- A suspended or removed member's GitHub keys stop authenticating at once (§5.6), because the gateway checks membership on every login.

Out:
- The SSH gateway (T-TRM-03). The members roster and hourly access re-check (T-ACC-02); this ticket hooks into the same hourly job.
- Deploy keys (never shell credentials).

## Changes

- `packages/backend/db/product/migrations/0108_ssh_key_source.sql` (new; number at landing): `ssh_keys.source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','github'))`. A unique index on `fingerprint` for `key_type='user'`; today `idx_ssh_keys_fingerprint` (`0001_product_baseline.sql:10883`) isn't unique.
- `packages/backend/db/product/queries/ssh_keys.sql`: `ListGitHubSSHKeys`, `UpsertGitHubSSHKey`, `DeleteGitHubSSHKeysNotIn`; `sqlc generate`; `scripts/check-sqlc-drift.sh`.
- `packages/backend/internal/services/github_ssh_keys.go` (new): fetch, ETag in `github_sync`-style storage per member, diff, revoke.
- Hook points: the sign-in path in `packages/backend/internal/services/auth.go` (T-ACC-01's GitHub sign-in) and the hourly member re-check job (T-ACC-02).
- `packages/backend/internal/routes/ssh_keys.go`: list responses include `source`; deleting a `github` key through the API returns 409 "remove it on GitHub ↗". `docs/api/openapi/user.yaml:1131` (`/api/user/keys`) updated; rebundle; regenerate clients.

## Tests

- unit (`github_ssh_keys_test.go`, new): diff over {new, unchanged, removed on GitHub, manual key with the same fingerprint, another member's fingerprint}; 304 does nothing; 404 (user renamed or deleted) keeps the keys and marks the sync failed.
- integration (real PostgreSQL, fake GitHub server with ETags): first sign-in imports 2 keys; a second hourly run sends `If-None-Match` and gets 304; removing one key on the fake server deletes it and publishes one `ssh_key_revoked`.
- integration (`packages/backend/internal/ssh/server_test.go`): a GitHub-sourced key authenticates; after its revocation an open session closes within 5 s.
- e2e: C-J3-06 step 1 (no manual key added).

## Acceptance



- [C-J3-06](../checks/C-J3-06.md): the SSH step uses only the member's GitHub key, imported at sign-in.

## Risks and notes

- Adding a unique index fails on an existing database with duplicate fingerprints. Confirmed by `SELECT fingerprint, count(*) FROM ssh_keys GROUP BY 1 HAVING count(*) > 1` on a dogfood install before migrating. The migration must refuse with a readable error, not drop rows.
- Two members who share a key (one laptop, two GitHub accounts) can't both use it. That is correct, since a key must identify one person, but it surprises them. The refusal names the other account only to maintainers.
- Budget: 8 members hourly is about 8 calls/h, which C-GH-08's budget already counts (spec §12.2 members' row).
