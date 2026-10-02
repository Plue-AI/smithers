# T-FLW-12 Obsidian folder sync as a Settings control

Stage S2 · Size S · Depends on T-ACC-03 · Unblocks C-J8-03 · Issue: [#3463](https://github.com/smithersai/smithers/issues/3463)
Spec: spec.md §13.3 · Delta: delta.md §4 · Product: mvp.md §6.11 Obsidian (v2.5), J8

## Goal
The owner points the wiki at a folder on the install's Mac from Settings. Obsidian edits in that folder become page revisions, and app edits appear in the folder.

## Scope
In:
- An owner-only Settings control for the folder path.
- The worker reads `wiki_sync.obsidian` from `install_settings` instead of host config.
- Attribution of imported edits to the owner.

Out:
- Laptop access to the vault over git ([D], spec §13.3).
- Notion or any other adapter (cut).

## Changes
- `packages/backend/internal/config/wiki_sync.go:15` (`Obsidian []WikiFolderSyncConfig`) → the install composition loads the folder list from `install_settings` (key `wiki_sync.obsidian`). Host-config loading stays for Plue only, marked composition-specific (spec §6.2.4).
- `packages/backend/internal/services/wiki_sync_obsidian.go` (`NewObsidianSync`) → unchanged adapter. Validate the path is a directory the install user owns, and refuse paths inside `$STATE`.
- The `wiki_sync.obsidian requires feature_flags.wiki` check (`wiki_sync.go:43`) → the wiki is on by default on the Mac install. Remove the gate there.
- `PUT /api/install` settings key plus the Settings card row (T-APP-03 area) → folder picker as a path field, with a last-sync time.
- Docs: one quickstart paragraph, "Open the wiki in Obsidian".

## Tests
- Integration (real PostgreSQL, temp folder): set the folder; a file edited on disk imports as a new revision attributed to the owner within the sync interval (60 s default). An app edit writes the file with frontmatter preserved.
- Integration: a path inside `$STATE`, a missing path or another user's directory is refused with a typed error.
- Unit: settings round-trip, and the worker picks up a changed folder without a restart.

## Acceptance
- [C-J8-03](../checks/C-J8-03.md)

## Risks and notes
- Risk: two-way sync and live co-editing (stage 3 wiki on the live channel) race on the same page. Confirm with a test that edits the file during a live session. Imports must apply as one attributed Yjs transaction, not a wholesale replace.
