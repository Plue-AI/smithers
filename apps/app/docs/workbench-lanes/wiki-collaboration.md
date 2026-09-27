# Embedded repository Wiki collaboration

Updated 2026-09-09. Owner: `apps/app`. Backend contract: Plue's repository Wiki API.
This page specifies the client implementation and the backend contract it
expects. Client fixtures do not establish deployment readiness.

The Wiki uses the existing conversation card, Markdown editor, frame graph and
`worldDocuments` TanStack DB collection. Opening a repository page shows a concise
outline and its recorded source/revision. The Document button exposes the same
Milkdown editor used elsewhere in the app. Maximize presents the same component.
The embedded conversation test host retains its composer; shell visibility follows
[the current onboarding brief](../ONBOARDING.md), with Command-K conversation
hidden by default. The existing `wiki`, `wiki.open`, `wiki.graph`, and
`wiki.new-note` doors now embed for humans as well as Smithers.

## New app flow APIs

All new actions have slash, button and agent doors. Missing required input opens
the existing schema-derived form; the model does not need to teach the user a
command grammar. These are app flow registrations, not public package primitives.

```text
/wiki.cloud smithersai/smithers
/wiki.cloud.open architecture smithersai/smithers
/wiki.sync wiki:smithersai/smithers:42
/wiki.edit wiki:smithersai/smithers:42 "# Architecture\n\nUse Effect."
/wiki.card.select world-embedded wiki:smithersai/smithers:42
/wiki.card.view wiki-open-wiki:smithersai/smithers:42 document
```

The typed flow inputs are `{repo, page?}`, `{slug, repo}`, `{documentId}`,
`{documentId, body}`, `{cardId, documentId}`, and `{cardId, view}` respectively.
`view` is `outline | document`. Slash Markdown is a JSON string so newlines and
leading whitespace survive the same grammar the form and button use. The editor
dispatches `wiki.edit`; actor-specific controller bindings preserve `user` versus
`smithers`. `wiki.cloud` uses Plue's existing page pagination in groups of 50;
page rows load their document only when opened.

## Internal data and dependencies

`WorldDocument.cloud` is an optional addition to the existing persisted row:

```ts
{
  repo, pageId, slug,
  remoteRevision, remoteAuthor, remoteUpdatedAt,
  state, // base64 Yjs-v1 state for Y.Text("markdown")
  accountLogin, branchId,
  phase: "cached" | "live" | "offline" | "deleted",
  error: string | null,
  pending: [{ updateId, update, actor }]
}
```

`WorldDocument.revision` remains the app transition revision. It is never used as
the Plue page revision. The row's stable ID contains the repository and Plue page
ID; its path contains the repository and current slug. Reusing a deleted slug
cannot retarget pending updates to a new page. All readable Markdown, causal
bytes and immutable pending updates persist through the existing SQLite-backed
collection/dispatcher, with no Yjs IndexedDB provider or separate SQLite ledger.

The private RPC `world` card payload gains optional document IDs, per-entry cloud
index metadata `{repo, slug, revision}`, `selectedDocumentId`, `view`, and
`index: {repo, page, hasNext}`. Legacy path-only entries continue to resolve. Card
selection and view are durable; React stores no copy. A React `useId` identifies
only an editor's ephemeral mount, so two presentations of the same card can
receive remote Markdown through distinct existing editor handles.

`CloudWikiTransport` is an internal Effect Context service. Its implementation
receives the controller's existing tapped `fetch` and cloud proxy URL. It exposes
Effect reads/writes and an Effect Stream of page revisions; it adds no public
gateway mechanism, database interface, process or Node sidecar. Production code
uses Web fetch/AbortController/Uint8Array and the existing Effect SSE decoder.
Yjs 13.6.32 is the browser codec interoperating with Plue's Yrs 0.27.4 backend.
Controller disposal and account/branch changes abort requests and interrupt
streams. Network state is never synchronized with a React effect.

## Causal update and retry rules

Bootstrap reads `GET /api/repos/{owner}/{repo}/wiki/{slug}/document`. Text is
derived from its Yjs state and checked against the returned Markdown before it
enters the collection. Local Markdown edits splice the changed UTF-16 range into
the existing `Y.Text("markdown")`; surrogate pairs remain intact. A per-mount
Yjs client ID is reused across that controller's edits. It is a codec identity,
not a new application entity or a replacement for native JJ change IDs.

Human typing prepares the local document through the dispatcher during the input
event, before waiting for command admission. Its pending delta records
`admitted: false`. The accepted flow authorizes that edit and its earlier local
deltas without replaying their Markdown over newer typing. Agents continue to
wait for admission and authorization before changing the document.

The dispatcher persists the updated state and `{UUID, exact delta bytes, actor}`
before `POST /updates`. Publication reads the committed, admitted prefix of the
pending queue; a newer optimistic edit cannot leave through an older save.
Older saved updates without an admission field remain compatible because their
handlers already passed admission. Storage schema 15 fences older writers that
would discard the admission field; compatible version-14 data still upgrades.
Only one POST per page is outstanding. A returned
acknowledgement must match the UUID and page ID and its causal state must contain
the submitted delta, including deletions. It removes only that pending UUID and
merges the server state with any newer locally queued edits. A lost response
leaves the original UUID and bytes available for an idempotent retry. A timer,
an unrelated revision, or a newer page body never counts as an acknowledgement.

`GET /stream?page_id=…&after=…` resumes from the last applied **page** revision.
The existing Effect SSE decoder handles arbitrary chunk boundaries; event ID,
page ID and revision must agree. Events trigger a bootstrap refresh, with rename
events using their new slug. The stream reconnects after interruption with a
two-second backoff. Reconnection does not resend a pending edit by itself;
Refresh or a subsequent edit retries the persisted queue.

A refused or interrupted command leaves its prepared text local. Refresh can
explicitly admit recovered edits, but excludes gestures still awaiting their
own command receipts. Resubmitting the same text reuses the saved update identity
and bytes. Merely reopening a page does not admit an unaccepted draft.

An explicit refresh is required to resume collaboration after reload or a branch
change. Restoring a frame snapshot marks its cloud rows cached inside the existing
restore transaction. Subscription callbacks cancel handles only: dispatching a
second row mutation from inside that transaction would corrupt its ordering.
Refreshing a fork replaces the recorded remote projection from the server and
does not publish the source branch's pending edits; that branch's snapshot retains
them. A definitive sign-out/account replacement scrubs cloud Wiki rows with the
rest of account-owned state. A revoked stream clears its live page. Deletion
retains unsent edits locally and disables writes to the removed page.

Limits match Plue: 1 MiB of UTF-8 Markdown, 1 MiB per decoded update, 8 MiB of
causal state. The server proxy's route-specific 2 MiB envelope allowance covers
base64 overhead; see `apps/server/docs/wiki-collaboration.md`.

## UI decisions and prior art

- [Notion's sidebar navigation](https://www.notion.com/help/navigate-with-the-sidebar)
  keeps page selection in a compact hierarchy. Here the existing embedded file
  tree selects a Wiki page, keeping the surrounding conversation in view.
- [Obsidian's Outline](https://help.obsidian.md/plugins/outline) derives section
  structure from the page's headings. The existing vault parser supplies this
  compact first view; document/source detail is available on demand.
- [Yjs document updates](https://docs.yjs.dev/api/document-updates) establish
  commutative/idempotent causal updates and state-vector synchronization. The
  app uses those bytes directly; it does not emulate collaboration by replacing
  whole server bodies on every edit. [Y.Text's UTF-16 indexing](https://docs.yjs.dev/api/shared-types/y.text)
  matches JavaScript string offsets.
- [TanStack DB persistence](https://tanstack.com/intent/registry/%2540tanstack%252Fdb/db-core%2Fpersistence)
  separates collection consumers from the persistence adapter. The current app
  collection stays the sole UI projection. No Electric deployment is assumed;
  Plue's Postgres revision log and SSE are the installed sync authority.

These are implementation references, not claims of feature parity. This slice
does not implement presence cursors, collaborative selection/undo, an editor
binding to ProseMirror's operation stream, or generated-prose semantic validation.
External changes use the existing echo-suppressed Markdown replacement handle;
that can move the caret during a peer update. The outline and source line state
what is actually recorded, and never claim that a page is semantically fresh
because a transport request succeeded. Semantic freshness belongs to the
dependency-bound Wiki workflow.

## Validation

`CloudWiki.test.ts` exercises real Yjs merging, Unicode splices, bounds, duplicate
updates and SSE decoding. Its checked-in synthetic Yrs deletion fixture verifies
that acknowledgement containment includes deleted text and concurrent insertions. `cloud-wiki.test.ts` covers peer rename/editor refresh,
lost acknowledgement and actual store reload, newer typing while POST waits,
acknowledgement containment, account revocation, deletion/slug reuse, and historic
fork fencing. Delayed and reversed command receipts cover native text retention,
peer merges, held acknowledgements, refused admission, explicit retry and private
reload recovery. `WikiFlows.test.ts` checks schema forms and actor parity. The
Chromium and WebKit Wiki test edits through the real Milkdown adapter, reloads persisted
state and view, and checks unchanged component identity on maximize/restore with
the composer visible in that test host. The current shell separately owns
Command-K visibility and keyboard focus. Backend native/Postgres tests and proxy bounds tests are
owned by their respective implementations; browser fixtures do not substitute
for a deployed two-client canary.
