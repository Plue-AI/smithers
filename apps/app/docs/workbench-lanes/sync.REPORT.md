> Historical lane evidence. D-11/CUT-01 retires first-party Linear routes,
> commands, and cards. The old ADR filename is retained for provenance;
> its current scope is GitHub synchronization. The reusable `@smthrs/integrations`
> Linear SDK remains available to authored flows. These reports do not establish
> current Cloud deployment or wiki freshness.

# Lane `sync` — REPORT

Brief: `sync.md`. ADR: `../decisions/0005-linear-github-sync.md`. Status: all
steps shipped and green; the lane's gates pass, and the only failures in the
tree are the three pre-existing TargetGraph integration tests (the
`~/artsy/force` fixture). Playwright T1: 3 pass.

## What shipped, per step

## Exit gate

- Seam tests: 42 across the three seams, doubles for every route, the 422
  op error and structured-429 doubles included.
- Card tests: 11, per wizard step, connected state, GitHub half, ops rows,
  the degraded note, and the rate-limit line.
- T1: 3 playwright tests, all passing.
- Gates: `tsc --noEmit` clean; `bun test src` 1499 pass / 3 fail — exactly
  the pre-existing TargetGraph integration failures; packages/rpc 130 pass;
  apps/server 402 pass. (Full-suite runs occasionally flake the native/PTY
  integration files under parallel load; each passes in isolation, as
  before this lane.)

## Gaps carried (named, not hidden)

## Never faked

The ops feed, the per-op retry, and the sync runs (plue#468), the mirror
runs (#470), the import progress fields the wire doesn't carry (#471), the
structured 429's absence on a plain 429 (#472), the reconcile and
route is missing (#469). Each renders the ADR's wording or refuses with it;
the routes that exist are the only ones called, and every rate-limit fact
came off a wire answer.

## Review fixes (2026-09-02)

Input: the Kimi review of this lane (13 findings). Each fix below carries a
regression test that failed on the pre-fix file (proved by swapping the
index version back in) and passes after.

Skipped, as the brief allowed: 9 (the callback's first-come key; the accepted `CloudAuth.ts` pattern, untouched) and 12 (`hasOlder` has no `load older` act because the feed has no route, plue#468).

Also fixed on the way: `e2e/playwright/sync.spec.ts` located two cards by

LiteralPin conformance test flags as id prefixes the app never builds; they
are plain strings now, as in every other spec.

Gates after the fixes (apps/app): `tsc --noEmit` clean; `bun test src` 1535
pass / 3 fail, exactly the pre-existing TargetGraph integration failures
(the `~/artsy/force` fixture); packages/rpc `bun test` 131 pass.

