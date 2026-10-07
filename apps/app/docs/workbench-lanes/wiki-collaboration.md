---
title: "Repository Wiki collaboration"
description: "Shared wiki editing over the install live channel."
---

## Repository pages

On a self-hosted install, `/wiki` reads the repository navigation index and
`/wiki.page <name>` opens a page in an embedded card. Pages resolve by slug,
title or Markdown path. Creation, navigation and history retain their existing
flows. Outside installs the DesignWorld seed remains the fallback.

The document HTTP endpoint is a read-only bootstrap snapshot. `/updates` and
`/stream` return 404; neither the POST save queue nor SSE synchronization exists.

## Live documents

The existing `wiki.edit` flow splices Markdown into `Y.Text("markdown")` in
`LiveDocProvider`. The tab's shared `/api/live` channel subscribes to
`doc:wiki:<page-id>`. The host assigns the authenticated client id; native Yrs
handles reject foreign new structs, client authors-map writes and invalid roots.
Code and wiki use the same sync codec and host-stamped awareness.

Local edits persist in the existing `worldDocuments` collection before
transmission. Unadmitted command drafts remain local. Pending admitted updates
are retained until a `saved` receipt covers both their state vector and stream
sequence; deletion-only edits therefore cannot be acknowledged by an older
vector. Reconnect and reload request the retained client id and replay updates
within the same page epoch. Account, branch and immutable page id fence edits.

The host batches persistence at 2 seconds idle or 10 seconds of continuous
editing. Markdown, CRDT state, vector and revision history commit together.
Only a successful database commit produces `saved`; failed writes retry and
never claim durability. A PostgreSQL advisory lease prevents two host processes
from independently owning the page. Stored CRDT state rebuilds the host after
restart, preserving old revisions and causal history.

## Verification

`TestWikiHostCommittedReceiptsAndRestart` uses the composed install router,
real PostgreSQL, native FFI and two authenticated members. It holds the page
row lock across the idle deadline, checks commit-before-receipt, rejects a
second page owner and reopens a receipted deletion after host recreation. It
sends 100 updates/s through the ten-second cap, then kills actual host child
processes before and after save receipts to verify retained replay and durable
restart without a graceful flush.

`C-J8-02.spec.ts` uses two Chromium contexts against that same composed router
and native/database fixture through `/wiki.page` and the production edit flow.
It keeps only unrelated shell providers as test fixtures, waits for the actual
local commit before offline reload, reads the original revision and probes the
retired routes with valid session/CSRF credentials. Reference-host
latency and real-model decision-following receipts remain separate checks.

`e2e/real/wiki-coedit.spec.ts` is the C-J8-02 reference-host driver. Run it
from the second Mac with a prepared scratch install and three existing revisions
of `decisions/retries`; revision 3 contains `Ben paragraph.`, a blank line,
and `Alice paragraph.`. It uses real Ben/Alice sessions, records 400 peer-arrival
samples on the runner's monotonic clock, and checks offline reload, persisted
text, attribution, retired routes and unchanged historical content. DOM observer
IPC is included in the latency, making it an upper bound.

Set `SMITHERS_JOURNEY=wiki-coedit.spec.ts`, `SMITHERS_REAL_BASE_URL`,
`SMITHERS_REAL_E2E_BUILD_SHA`, `SMITHERS_REAL_HEADED=1`, and the existing
`SMITHERS_JOURNEY_REPOSITORY`, `SMITHERS_JOURNEY_SMTHRS`,
`SMITHERS_JOURNEY_DATABASE_URL` and `SMITHERS_JOURNEY_{WILL,BEN,ALICE}_SESSION`
reference-install settings. From `apps/app`, run
`pnpm exec playwright test --config playwright.real.config.ts e2e/real/wiki-coedit.spec.ts --workers 1`.
The driver refuses missing reference prerequisites; ordinary real-E2E runs
exclude it. Its attachments and member videos are qualification evidence only
after the reference run passes.
