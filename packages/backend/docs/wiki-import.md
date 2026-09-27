---
title: "Import an existing vault into the Smithers wiki"
description: "A staged migration plan that preserves Markdown, attachments, privacy and provenance."
---

## Preconditions

This is a future importer plan, not an executed migration. No existing vault has been read or modified. The wiki is the Smithers product; an Obsidian vault is an import source, not a second product wiki. The owner explicitly chooses the source, destination repository, private/public wiki scope and approved source revision or snapshot before migration.

Wait for the wiki UI connection and the shared document sync contract ([#1922](https://github.com/smithersai/smithers/issues/1922), [#2122](https://github.com/smithersai/smithers/issues/2122)). Implement importing as an initial reconciliation through that mechanism. Do not introduce another worker, mapping database, catalog or generator. Notion requires explicit connection credentials and a review of provider conversion losses before writes.

## Preview without mutation

1. Take an owner-approved immutable backup or git commit of the source. Read a snapshot, never the live vault while it is changing. Do not follow symlinks outside the selected root. Exclude `.git`, `.obsidian` and other application configuration by default; secrets and role/flow configuration need a separate review.
2. Inventory relative Markdown paths and attachment files with byte counts and SHA-256 digests. Preserve exact UTF-8 Markdown and frontmatter, including unknown keys. Flag invalid UTF-8, NULs, noncanonical paths, case-fold collisions, files exceeding the API limits (1 MiB Markdown, 16 MiB attachments), unsupported Obsidian syntax and ambiguous links. Never silently rewrite or drop these files.
3. Default the destination to the private wiki. Public publication is a separately reviewed copy. Private repositories still enforce repository permissions even for their public wiki scope. No automatic private-to-public propagation.
4. Assign stable page route slugs separately from file paths. Persist source identity to destination page ID in the shared sync mapping; do not infer identity from a mutable filename. Retain source snapshot/commit, original path and digest as import provenance in the shared receipt. Resolve collisions in the preview before starting.
5. Show the proposed paths, conflicts, count and total bytes. Let the owner approve the concrete inventory. The existing app must acknowledge the persisted request immediately and show its durable background run, completion or retryable failure.

## Apply and reconcile

Upload attachment content through the authorized attachment endpoint and Markdown through page CRUD, retaining each returned page ID, revision and digest in the shared reconciliation receipt. Revision-checked writes must stop on an intervening human edit. Reconcile an uncertain response by mapped identity and exact content before retrying; do not duplicate pages or blindly overwrite.

Preserve wikilink text, aliases, heading references and embeds. Paths and frontmatter remain authored source; navigation is derived by the existing index. Renames change the mapped page's path rather than recreating its identity. Deletions require explicit mirror policy and retain tombstone history. Do not infer source deletion from a partial scan or unavailable source.

Re-read the index, page content and attachment revisions through the API. Compare every approved path and digest, verify backlinks and unresolved-link counts, and retain the completed run receipt. Importing one snapshot creates one real imported version, not fabricated edit history. Importing older git history is a separate explicit requirement; retain its original commit references instead of claiming that snapshot import reproduces it.

## Cutover and acceptance

Use a temporary synthetic vault first: nested folders, duplicate basenames, frontmatter aliases/tags, heading links, Unicode/CRLF, code fences, binary attachments and private material. Demonstrate source-to-Smithers and Smithers-to-source edits, renames and deletions with the shared sync, including restart, duplicate delivery and concurrent conflicts. Check anonymous/outsider/private-member reads and attachment history after deletion.

For the real vault, keep the original backup intact, compare the approved manifest with the completion receipt, then explicitly select the source of truth/mirror policy. Continuous sync begins only after that receipt. A rollback stops the mapping and reverts imported pages through ordinary versioned edits/deletes; it never erases history or modifies the source backup. Smithers-Ops remains untouched until this later, explicitly authorized migration.
