# C-REL-01 Public docs are one quickstart plus the flows reference; docs gates pass

Proves: mvp.md §12.4, §6.13 API, §8 (CLI and Smithers skill row), M-12 · spec.md §16.1.2, §16.3.4, §17.5a (quickstart content) · Layer: unit · Stage: R · Tickets: T-DOC-01..03
Automation: `apps/site/scripts/mvp-docs.test.mjs` (new), `scripts/mvp-docs.test.mjs` (new), `pnpm docs:check` · Runs in: CI

## Setup
- Commit X, `pnpm install` done.
- The CLI from source (`makeCli()` in `packages/smithers/src/Cli.ts`), never an installed `smthrs` (an installed rc.1 still lists removed commands).
- `catalog.mvp.json` from T-CAT-01.
- The banned-term list from C-UI-02.

## Steps
1. `pnpm docs:sync`, then check the working copy for changes.
2. `pnpm docs:check`; `smthrs lint //apps/site:supportDocs`; `smthrs docs //packages/smithers:docs`.
3. Site test: read the `/docs` sidebar configuration and list its top-level entries.
4. Site test: extract every `smthrs …` invocation and every `/slash` command from the quickstart and the flows reference. Resolve each CLI path and its flags against `makeCli()`, and each slash command against `catalog.mvp.json`.
5. Site test: scan both pages for banned terms and for links to deleted pages; check that the quickstart names both HTTPS examples (Tailscale serve and a reverse proxy), the launchd fallback (§16.1.2) and a link to the API reference, and that Tailscale appears nowhere else on the site.
6. Repo test (runs from S1, with T-DOC-02): `docs/architecture/0002-mac-install.md` exists with `Status: accepted`; the status line of `docs/architecture/0001-shared-product.md` links it; `docs/architecture/self-host-implementation.md` has no `native-own` row.
7. Repo test (R): every relative Markdown link in `AGENTS.md`, `docs/**/*.md` and `apps/site/docs/**` resolves; `docs/mvp/` holds only the pointer pages and evidence files something reads; every decision ID cited in `apps/`, `packages/` and `flows/` has a row in `docs/mvp/PRODUCT.md`.

## Pass when
- Step 1 produces no change; step 2 exits 0 for all three commands.
- Step 3 equals exactly {Quickstart, Flows reference}; the API reference stays published where it is today and the quickstart links it.
- Steps 4 to 7 report zero failures.

## Fail when
- A quickstart command exists only in an installed build, or a flag in the docs differs from the command's schema.
- A cut surface (Docker self-host, five-job setup, TUI, Cloud pricing, create-app) is reachable from the `/docs` sidebar.
- A generated copy was edited by hand, so `docs:sync` rewrites it.
- `AGENTS.md`'s D-16 link or a `.specs/` link is dead.

## Evidence
`.artifacts/checks/C-REL-01/<UTC timestamp>/`: test output, the sidebar JSON, the command resolution table, the link report, commit X.
