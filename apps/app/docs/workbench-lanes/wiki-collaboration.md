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
`doc:wiki:<page-id>`. The install currently refuses document subscriptions and
binary frames: the Wiki authority and durable client binding are not composed. The editor
stays read-only and the production `wiki.edit` dispatcher refuses new edits.
There is no POST queue, SSE watcher or HTTP synchronization fallback.

Previously persisted pending updates stay in `worldDocuments`, including
unadmitted drafts. Refresh and reload merge them for reading without sending
or acknowledging them. Account, branch and page identity remain fenced; a
replacement page using the old slug cannot receive the original page's edits.

The remaining live integration needs authenticated assignment, sync step 1/2,
author validation and revocation, batched PostgreSQL persistence at 2 seconds
idle or 10 seconds of continuous edits, and commit-before-`saved` receipts.
No live convergence or host-crash guarantee is claimed until that integration
passes the real-install checks.
