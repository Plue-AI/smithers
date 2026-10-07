---
title: "Repository Wiki collaboration"
description: "Real wiki reads and live document admission."
---

## Repository pages

On a self-hosted install, `/wiki` reads the selected repository's navigation
index and `/wiki.page <name>` opens its real page in an embedded card. Existing
pages resolve by slug, title or Markdown path. An absent page uses the ordinary
creation flow; a refused index read never creates a page. Outside installs the
DesignWorld seed remains the fallback.

The document endpoint remains a snapshot reader for the page and stored Yjs
state. Page history and revision content remain readable. Snapshot reads do
not authorize editing or acknowledge pending updates.

## Live documents

Wiki documents use the shared `LiveDocProvider` with `Y.Text("markdown")` on
`doc:wiki:<page-id>` over `/api/live`. The install composes the native Yrs host
with authenticated document admission, sync step 1/2, author validation and
revocation. The editor and production `wiki.edit` dispatcher share this binding.
There is no POST queue, SSE watcher or HTTP synchronization fallback.

Pending updates stay in `worldDocuments` until a committed `saved{sv,seq}`
receipt covers both their state vector and sequence. Reload and reconnect
resend admitted updates; unadmitted drafts remain local. Account, branch and page identity remain fenced; a
replacement page using the old slug cannot receive the original page's edits.

The host persists merged state, Markdown and a revision in PostgreSQL after
2 seconds idle or 10 seconds of continuous edits. It sends `saved` only after
the revision-checked transaction commits. A restarted host loads stored CRDT
state; clients replay uncovered updates without reseeding the page.

Composed native/PostgreSQL tests cover commit-before-saved, batching and host
kill/restart recovery. C-J8-02's reference Mac/LAN latency and history evidence
and C-DUR-04's complete reference-host fault matrix remain separate qualification
requirements.
