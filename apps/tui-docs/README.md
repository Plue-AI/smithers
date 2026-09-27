# TUI playground and recordings

Two things live here:

- **The playground** at tui.smithers.sh: the production agent on a two-file
  browser sandbox. Every former TUI guide URL redirects to its page on
  smithers.sh, where the TUI docs now live (`apps/site/src/content/docs/docs/tui/`
  and the TUI tabs of `docs/learn/`).
- **The recorder** that turns the scripts in `apps/tui/docs/recordings/` into
  the TUI GIFs on smithers.sh.

```bash
pnpm --filter @smithers/tui-docs build
pnpm --filter @smithers/tui-docs start
```

Open http://localhost:4388. `dev` runs Astro's editor server; use `start` for the
same-origin sponsored endpoint.

## Recordings

A `tui-script` fence selects a reviewed scenario and drives the production TUI
in a private PTY. The [authoring reference](../tui/docs/README.md) lists the
grammar. `Wait for answer` and worker/monitor status waits inspect persisted
receipts; visible source text cannot satisfy a completion assertion. Repeated
IDs must have identical scripts. `browser-script` drives the real playground in
Chromium with controlled responses at its HTTP provider boundary.

Scenarios supply deterministic model responses and disposable projects. Cells,
files, workers, flows, approvals, conversation recovery, and controls execute
for real. None of these recordings measures live model quality. The recorder
captures terminal cells and colors through xterm, renders PNG frames in
Chromium, and encodes GIFs with FFmpeg into `public/recordings/`.
`pnpm --filter @smithers/site run capture:learn tui` records the ones the site
uses and copies them to `apps/site/public/images/learn/`.

`//apps/tui-docs:recordings` declares the scripts, TUI inputs, workspace
runtime source closure, and lockfile, and is a cached build. The recorder
verifies content hashes before a local cache hit and restores missing public
artifacts from `.cache/recordings`.

Recording requires Node from `.node-version`, Bun >=1.4, Python 3, Git, FFmpeg,
Chromium, and the native workspace helper for flow examples. Set
`SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` to its installed path.
`SMITHERS_DOCS_BUN`, `FFMPEG`, and `CHROME_BIN` select installed tools.

## Browser host and recovery

The playground runs `Agent.Agent` on `Flow.make` using the production QuickJS
cell sandbox. Its only capabilities are `ls`, `read`, `write`, and `check` over
a bounded virtual volume. `check` evaluates addition in a separate QuickJS
runtime with memory and execution limits. Neither runtime receives DOM,
network, host filesystem, or process access.

The engine is the existing memory engine. Reload durability comes from the
playground host's atomic journal, not from that engine: each completed model
response is persisted before the cell executes; each flow result, file state,
and visible event are committed in one localStorage write. Recovery runs the
same production loop from the original prompt, rehydrates the model responses
and call results, and reconstructs the private execution volume in order.
Previously committed operations do not execute again. Web Locks allow one
writer across tabs. Persistence failure stops progression.

Every checkpoint contains a consistent transcript and files. Branching starts a
new task from those files while retaining the original branch. Storage is capped
at 4 MB; files are capped at 16 × 8 KB. Browser storage eviction or clearing site
data deletes the sandbox. A model request that had no committed response may
be billed again on explicit resume. This is a bounded sandbox guarantee, not a
claim that native shell effects, network changes, or billing can be undone.

## Provider access

Settings accept a base URL, model, and API key. HTTPS and local HTTP providers
are supported; the provider must allow browser CORS. The key stays in tab
memory and is sent only to that provider. Re-enter settings after a reload to
resume a personal-provider run with the same model and endpoint.

The portable Node server offers sponsored access when `OPENROUTER_API_KEY` is
set server-side. It reads the current OpenRouter catalog and chooses the lowest
estimated price among text models with at least 32K context. Free entries sort
first. It forces a 2,048-token output ceiling and rejects oversized requests.
SQLite reserves spend before each call, retains reservations on ambiguous
failure, and caches successful responses. Limits default to $0.50 and 100
calls per UTC day, plus 16 calls per visitor cookie. Missing credentials or
exhausted limits produce a visible, retryable refusal.

Self-hosting variables: `PORT`, `HOST`, `DOCS_ORIGIN`, `DOCS_BUDGET_DB`,
`DOCS_DAILY_DOLLARS`, and `DOCS_DAILY_CALLS`. Use a persistent budget database
shared by requests to the same server. Hosted deployment, keys, domain setup,
and multi-instance routing belong in the private deployment repository.

The Commands and Keys pages on smithers.sh come from the TUI registries. After
changing either, run `pnpm --filter @smithers/tui-docs sync:reference`. Coverage
tests require a script for every TUI GIF the site uses and every registered
command and key on those pages.

## Evidence

```bash
pnpm --filter @smithers/tui-docs check
pnpm --filter @smithers/tui-docs test
pnpm --filter @smithers/tui-docs build
pnpm --filter @smithers/tui-docs test:browser
pnpm exec smthrs test '//apps/tui-docs:browserTests'
pnpm exec smthrs lint '//:targetIndex'
```

Browser tests run the production agent with a controlled HTTP provider response.
They start the portable server on an unused port; `DOCS_TEST_URL` selects an
existing server instead.
They cover unresolved transport, editable chat, duplicate submission, cross-tab
exclusion, historical visibility, reload during a model request, branch isolation,
personal credentials, provider refusal, mobile width, and the former guide redirects. Unit tests
also interrupt the real agent and recover it without duplicate completed calls.
These are offline correctness tests, not evidence of a live OpenRouter model's
quality or a hosted deployment. Release tracking: issue #1774.

The existing Cloud `docs` gate runs this site's typecheck and unit tests.
`:browserTests` builds recordings and the site before launching its browser;
that gate needs a runner with the recording toolchain above. It is not covered
by the current unprivileged Cloud image's JavaScript-only docs gate.
