> Historical lane evidence. D-11/CUT-01 retires first-party Linear routes,
> commands, and cards. The old ADR filename is retained for provenance;
> its current scope is GitHub synchronization. The reusable `@smthrs/integrations`
> Linear SDK remains available to authored flows. These reports do not establish
> current Cloud deployment or wiki freshness.

# Lane L5 — Sync actions against live plue routes — REPORT

Brief: `L5-sync-live.md`. ADR: `../decisions/0005-linear-github-sync.md`.
Predecessor: `sync.REPORT.md` (what was degraded).

## Verdict in one line

Every degraded wording is gone: the ops feed, the per-op retry, the sync
`mirror_status` are all real calls now, shaped against plue's own source —
but **not one of them was observed answering in production**, because every
marked `unverified` against a live server.

## How the shapes were established

The brief said epic #474 is live. It is **merged**, not **serving**.

  the SAME chi route group, so the 404 is not a missing deploy of that


Everything marked `unverified` below means: shape taken from plue's source,
double-tested, never seen on a live wire.

## Route and field mismatches (route, expected, observed)

## Files changed

Seams:

Cards:

- `src/mainview/cards/SyncCards.tsx` — `opGlyph`; op rows gained the glyph,
  the age, and `StatusPill` on the wire's own word; header gained the run id
  and the mirror status word; `Load older`; Show more names its count.
- `src/mainview/cards/RepoImportCard.tsx` — renders `stage · <word>`.
- `src/mainview/cards/IssueCards.tsx` — **unchanged** (it already rendered
  behind them was fake).

Schema, flows, wiring:

**Not changed, deliberately:** `state/controller/connectors.ts` (it owns the
LOCAL repository connector flow only; nothing in this brief touches it) and
`styles/cards.css` (every new row reuses `world-card-row` /
`world-card-path` / `connect-store-icon` — no new class was needed, so
adding a sync section would have been dead CSS).

**One-line note as the brief allowed:** connector *rows* on the Connectors
pane (`ConnectorsSurface.tsx`) belong to another lane this hour and were not
touched; connector STATE still reaches the user as cards
(`connector-setup`, `sync-ops`) which `App.tsx` already renders through
`ChatCards.tsx`.

## Tests added, by name

`state/seams/GitHubSeam.test.ts` (20 tests, 7 new/replaced):

- reconcile posts plue's own route — /api/admin/github-app/reconcile
- reconcile refused for the admin scope reads plue's sentence and still re-reads the status
- mirrorSync starts a run and carries the repository's own mirror_status word
- a repository DTO the app cannot read leaves the header with NO state word
- the run poll renders one row per ref and stops when the run settles
- parseMirrorRef keeps the wire's status word and error, and never offers a per-ref retry
- a run read the server refuses lands its words on the card and stops the poll

`state/seams/IssuesSeam.test.ts` (21 tests, 4 new/replaced):


- a link plue refuses reads its own sentence, never a product paraphrase
- a 404 on the link route means the repository isn't imported, and never falls back


`cards/SyncCards.test.tsx` (23 tests, 10 new/replaced) — one per ADR 0005 state:

- ADR 0005 authorizing: step 1 is the only act, and no later step claims anything
- a started run with no run DTO yet claims no state and no counts
- ADR 0005 active: the live run wears the wire's own state word and its summed counts
- ADR 0005 failed op: the error is verbatim on the row, with Retry naming the op
- a mirror run renders one row per ref and the repository's own mirror_status word
- past the cut, Show more widens the window; older ops offer Load older
- ADR 0005 importing: the counts and the raw stage word, with no act while it runs
- ADR 0005 failed import: the job's error verbatim, with Retry naming the job
- a done import links the repository and the workspace it created
- (kept, widened) a null run state (nothing has answered yet) is never done, and a wire word is never renamed
- (kept) a refused call holds Re-check and Reconcile until the reset, with the time on them
- (kept) RepoImportCardBody — a structured 429 holds Try again until the reset, with the time on it

## Gates

Run from `apps/app`, after the tree recovery described below.

Counts are the FINAL run, taken after lane L1's own files landed (an earlier
run mid-recovery showed 6 extra failures, all L1's, now gone).

- `bun x tsc --noEmit -p .` — **0 errors**.
- `bun test src/mainview/state/seams src/mainview/cards` — **517 pass,
  0 fail**. The six L5-owned suites run alone: **111 pass, 0 fail**.
- `bun test src` (once) — **1650 pass, 13 fail, 8 errors**. None in L5:
  - 3 × the pre-existing TargetGraph fixture failures the brief said not to
    chase (`a real run of //src:typeCheck streams node frames and a critical
    path`, `history and replay round-trip through the repository's own
    disk`, `the graph route answers the force workspace's real DAG`).
  - 10 × `src/bun/Main.test.ts` (`the native main process starts the local
    origin`, `the native RPC surface`). **Not load flake** — I checked: the
    file fails the same way in isolation (4 pass / 6 fail / 4 errors,
    `the native main process printed no report (exit 143)`, i.e. each spawn
    is SIGTERMed at the test's own 5,000 ms deadline). It spawns the built
    native main process and has zero references to anything in this lane
    `src/bun/main.ts` was touched by this lane. Pre-existing on this machine;
    left alone as an out-of-lane defect.

Playwright was not run (the brief's verification list does not include it);
`e2e/playwright/sync.spec.ts` was updated to the live shapes and typechecks.

## Tree incident (not caused by this lane, but it cost time)

At 20:36 another session ran `jj new` onto an unrelated revision
(`pzxvtpyt`, a `worktree-agent` commit), which moved the working copy to an
empty commit and wiped every lane's uncommitted files from disk. My work
survived in the abandoned working-copy commit `oskxxrxuvlrz` /
`d21ed26ebc55`; I restored my 19 paths from it, then the coordinator
squashed that commit back tree-wide. All L5 markers verified present
`loadOlderSyncOps`, the parity pin at 14). Seven of my restored paths are
shared with other lanes — `Cards.ts`, `Flows.ts`, `SlashPayload.ts`,
`parity.test.ts`, `registry.test.ts`, `AppController.ts`, `ChatCards.tsx` —
and other lanes had already begun re-writing some of them on the new base
when I restored, so up to a minute of their post-reset work on those seven
files may have been overwritten; the coordinator was told, and the tree-wide
squash subsumes it. The remaining red in the full run is that recovery still
settling in lane L1, not a defect this lane introduced.

## Left unbuilt, with the reason


2. **A per-repo, user-scoped GitHub reconcile.** Only
   `POST /api/admin/github-app/reconcile` exists, admin-scoped and global.
   `github.reconcile` calls it and shows the platform's refusal verbatim for
   everyone else. The ADR's step-2 Reconcile is therefore not usable by a
   normal user against today's backend.
3. **Per-ref retry on a mirror run.** No route. A failed ref shows its error
   and the run is re-run whole.
4. **A real cursor for `load older`.** plue's ops feed pages with
   `since` + `limit≤100` only, so "older" is a second read at the maximum
   page size rather than a true page-back. More than 100 ops in a window
   cannot be walked past today.
5. **`behind GitHub · 3 refs`** (ADR's mirror header). The wire gives the
   word `behind` and no ref count, so the header shows the word alone.
   `unverified` against a live server — shaped from plue's source and proved
   are `unverified` for a different reason: they are repo-scoped and I had
   no authenticated repository to probe.

