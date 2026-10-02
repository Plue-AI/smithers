# C-REL-01 In-app docs are one quickstart plus the flows reference; the site keeps one install page; docs gates pass

Proves: mvp.md M-35, §12.4, §6.13 API, §8 (CLI and Smithers skill row), M-12 · spec.md §16.1.2, §16.3.4, §17.6 (quickstart content) · Layer: unit · Stage: R · Tickets: T-DOC-01..03
Automation: `apps/app/src/docs/pages.test.ts` (new, beside T-APP-20's loader), `apps/site/scripts/install-page.test.mjs` (new), `scripts/mvp-docs.test.mjs` (new), `pnpm docs:check` · Runs in: CI

## Setup
- Commit X, `pnpm install` done.
- The CLI from source (`makeCli()` in `packages/smithers/src/Cli.ts`), never an installed `smthrs` (an installed rc.1 still lists removed commands).
- `catalog.mvp.json` from T-CAT-01.
- The banned-term list from C-UI-02.

## Steps
1. `pnpm docs:sync`, then check the working copy for changes.
2. `pnpm docs:check`; `smthrs lint //apps/site:supportDocs`; `smthrs docs //packages/smithers:docs`.
3. App test: list the in-app docs index. Site test: list the site's docs sidebar.
4. App and site tests: extract every `smthrs …` invocation and every `/slash` command from the quickstart, the flows reference and the install page. Resolve each CLI path and its flags against `makeCli()` (a command on the planned-commands allowlist passes until it ships, then the allowlist entry fails), and each slash command against `catalog.mvp.json`.
5. App test: scan both pages for banned terms and for links to deleted pages; check that the quickstart names both HTTPS examples (Tailscale serve and a reverse proxy), the launchd fallback (§16.1.2) and a link to the API reference, the anchor `put-https-in-front`, and that Tailscale appears nowhere else in the docs.
6. Repo test (runs from S1, with T-DOC-02): `docs/architecture/0002-mac-install.md` exists with `Status: accepted`; the status line of `docs/architecture/0001-shared-product.md` links it; `docs/architecture/self-host-implementation.md` has no `native-own` row.
7. Repo test (R): every relative Markdown link in `AGENTS.md`, `docs/**/*.md` and `apps/site/docs/**` resolves; `docs/mvp/` holds only the pointer pages and evidence files something reads; every decision ID cited in `apps/`, `packages/` and `flows/` has a row in `docs/mvp/PRODUCT.md`.

## Pass when
- Step 1 produces no change; step 2 exits 0 for all three commands.
- Step 3: the in-app index equals exactly {Quickstart, Flows reference}; the site sidebar equals exactly {Install} plus the API reference, which the quickstart links.
- Steps 4 to 7 report zero failures.

## Fail when
- A quickstart command exists only in an installed build, or a flag in the docs differs from the command's schema.
- A cut surface (Docker self-host, five-job setup, TUI, Cloud pricing, create-app) is reachable from the in-app docs or the site.
- A site page other than the install page and the API reference remains.
- A generated copy was edited by hand, so `docs:sync` rewrites it.
- `AGENTS.md`'s D-16 link or a `.specs/` link is dead.

## Evidence
`.artifacts/checks/C-REL-01/<UTC timestamp>/`: test output, the sidebar JSON, the command resolution table, the link report, commit X.
