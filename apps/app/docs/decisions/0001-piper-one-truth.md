# ADR 0001 — Piper: one truth, one address space (2026-09-01, will)

> Partly superseded 2026-09-27 (smithersai/smithers#2239): the local repository inventory (`repos.loaded`), pins (`repo.pinned`, `repo.unpinned`, `repo.unpin`), `repo.open`, `local:` working copies and `POST /api/repo/files` are gone. Working copies are boxes and shared copies.

## Decision

1. Smithers Cloud is the source of truth. Repos live under users or orgs and mirror
   GitHub (Smithers is the source, GitHub the destination remote). A local
   checkout is a working copy of a Smithers Cloud repo; a cloud workspace is another.
2. Smithers Cloud presents as one file system: every file has a global path
   `/org/repo/path`. Cross-repo changes and versioning are implemented
   server-side as jj-submodule "ghost monorepos". Users never see a submodule.
3. Builds are maximally cached and incremental (the Smithers build graph on
   Nix sandboxes).

## UI consequences (the brief for lane `piper`)

- Sidebar: one tree, `org/ → repo → working copies`. Repo row carries mirror
  state (`synced` / `behind GitHub`) and `bookmark @ changeId`. Copy rows:
  `~/path · N ahead` for a local checkout, `name · state` for a workspace.
- Composer origin chip: the active working copy and its drift, else
  `head @ changeId`.
- Card headers (file, file-list, search, diff): the global path and the
  change id they were read at. When head moves, one mono line
  `head moved to <id> · refresh`. Nothing auto-refreshes.
- Bare command rule: the active working copy if one is active, else head.
- The GitHub watch-list chooser (`repos.watch*`) is retired. GitHub is import
  in and mirror out, both existing plue acts.
- Local-only with no session stays valid and labeled (`no cloud repository`).
- The change card (next row) groups files by repo with per-repo landing
  state; head is a vector, one "moved" line per repo row.

## Settled with the backend (plue-0c, 2026-09-01)

- Cross-repo landing is ATOMIC. One Land button per changeset, disabled with
  the blocking reason. No per-row Land, no stable "2 of 3 landed": a blocked
  changeset names the blocking member and every row stays open. Partial
  landing only through an explicit "Split ready members" act.
- "Head moved" compares COMMIT ids (a change id survives a rebase). Show the
  change id; keep the commit id underneath.
- Mirror status (synced / behind GitHub) does NOT exist on the backend yet.
  Do not fake it: render no mirror glyph until the API carries it.
- Ahead/behind counts: a local checkout computes them with jj; a cloud
  workspace has no API field yet, so its row shows state only.
- OWNERS: nothing on the backend; omit the tab until it lands.

- Repo list contract (today): `GET /api/user/repos` rows carry owner (bare
  login), name, full_name, default_bookmark, no head. Head is
  `GET /api/repos/{owner}/{repo}/bookmarks` items `{ name, target_change_id,
  target_commit_id }` in an `{ items, next_cursor }` envelope. Inventory
  follows cursors until the default bookmark is found, with at most six
  repository lookups in flight and 100 pages per lookup (`limit=100`). Failed
  or incomplete pagination preserves a previously loaded head. Org vs user:
  `GET /api/user/orgs` once, match logins. plue#445 adds `owner_type` and
  `default_bookmark_head { change_id, commit_id }` to the row; the collection
  reads those directly. When a majority of repositories with a default
  bookmark carry the inline head, inventory skips fallback lookups for the
  remaining rows. Working copies from `GET /api/user/workspaces` use
  `workspace_id`, `repository_owner`, `repository_name`, `workspace_title`,
  and `state`, retaining `workspace:<workspace_id>` identities on refresh.
  Legacy bookmark arrays and per-repository workspace DTOs remain readable.
  plue#446: workspace head and
  ahead/behind. A third issue: per-repo mirror status.
- Auth from the native app: the CLI's browser login, not an env token. Bun
  listens on `127.0.0.1:<random>` with `/callback`, opens the browser at
  `${API}/api/auth/github/cli?callback_port=<port>&callback_state=<state>&scopes=<scopes>`, receives
  a fragment containing `{ token, username, email, expires_at, callback_state }`
  (a `smithers_` PAT), verifies the per-attempt state, stores the token in
  the OS keychain, never exposes it to the renderer. `SMITHERS_CLOUD_TOKEN`
  is a dev/CI override only. No device-code flow; bearers cannot mint tokens.
  Scopes the app needs: read:user, read:organization, read:repository,
  write:repository, read:workspace, write:workspace, write:agent,
  write:approval. The app requests these explicitly through the API's
  `scopes=` parameter. Restored legacy tokens can still lack workspace,
  agent and approval access, so the app degrades honestly: probe
  once with `GET /api/user/workspaces`; a 403 insufficient-scope answer sets
  a `degraded` state and every workspace, agent-launch, and approval act
  shows "sign in again to enable" instead of failing silently. The callback
  browser page clears the fragment immediately and posts it to Bun with a
  page nonce; Bun requires the API-echoed state before claiming the attempt.
  API callback-state support must roll out before this native version:
  missing or mismatched state is refused, never accepted as a legacy fallback.
- The org superproject (ghost monorepo) is server-side only. A workspace
  never checks out a superproject; working copies are local checkouts and
  cloud workspaces.

## Open

- (settled above) How the native app authenticates to the Smithers Cloud API (today: only the
  identity seam is proxied). First cut: a Bun-side token from
  `SMITHERS_CLOUD_TOKEN`; never in renderer-visible state.
