# T-DOC-01 Quickstart and flows reference as in-app pages; one install page on the site

Stage R · Size M · Depends on T-INS-05, T-APP-20 · Unblocks T-DOC-04 · Issue: [#3458](https://github.com/smithersai/smithers/issues/3458)
Spec: spec.md §16.3.4 and §17.6 (the quickstart documents Tailscale serve and Caddy and recommends HTTPS in front), §16.1.2 (the launchd fallback); content follows §1.4, §5.1.0, §5.3.1, §8.10.5, §11, §16 · Delta: delta.md §10 (Add: public docs) · Product: mvp.md M-35 (docs in the app), §12.4, §6.13 API, §8 (CLI and Smithers skill row), J1, J5, M-11, M-28, M-30

## Goal
The app's `/docs` flow (T-APP-20) offers one quickstart (install, setup, first TODO, teammates) and one flows reference, and every command, slash command and step they show exists in the release. The website keeps only the README and one install page (product M-35, 2026-10-02).

## Scope
In addition to the scope below, the proxy examples (Tailscale serve, Caddy) pass the original `Host` header, and the page says a proxy on another host must (§16.3.4). Restoring on another Mac requires stopping the original install first (§16.5.3). Check: C-REL-01.

In:
- Quickstart: requirements (Apple Silicon macOS, Homebrew, a GitHub repository with squash merging, a provider key and an AI Gateway key); `brew install smithersai/tap/smithers`; `smthrs host start [--bind <addr>] [--origin <url>]` and its one-time setup URLs (§1.4, §5.1.0), which work from the Mac or a LAN laptop; the setup card steps; ask a question; the first TODO to Merged; add members; secrets; the SSH line `ssh -p 2222 <branch>@<install host>` (§8.10.5); a laptop agent's `smthrs login <install origin>` (§5.3.1); `smthrs host status`, `upgrade`, `backup` and `restore`.
- The launchd fallback when Hypervisor.framework refuses the daemon: a launchd agent plus macOS automatic login (§16.1.2, T-INS-08).
- Reaching the install from other machines: Settings bind address and public origins (T-INS-04); plain HTTP on a LAN works, and an http origin sends the session cookie unencrypted (§17.6); two examples of HTTPS in front: `tailscale serve --bg --https=443 http://127.0.0.1:4000` (with `--tcp=2222` for SSH) and a Caddy reverse proxy. These are the only Tailscale and Caddy mentions in the product (spec §0, §16.3.4).
- A link to the HTTP API reference. It stays published where it is today (`apps/site/src/content/docs/docs/reference/api/`, mvp.md §6.13) until T-APP-21's playground reads the same OpenAPI source.
- Flows reference: overridable flows (`todo`, `learning`, `review`, repository flows) and system flows (M-30); `flows/<name>/flow.ts` with `Flow.make("<name>", {…})` (AGENTS.md "Flow layering"); `/flow.edit`; versions (proposed, merged and syncing, active, merged but not active) and pinning (§11.3, §11.4); install-stored config and `.smithers/*` precedence (§11.2); learning proposals (§11.8); running a flow on a scratch branch (§11.4.3).
- The in-app docs index (T-APP-20) lists exactly these two pages.
- The website's only docs page is the install page: requirements, `brew install smithersai/tap/smithers`, `smthrs host start` and the setup link. It links to nothing else on the site. Every other page under `apps/site/src/content/docs/docs/` is deleted (the inventory goes in the change description); the API reference is the exception below.

Out:
- The 50 generated library sites (`apps/docs/shared/manifest.mjs`): libraries stay published (mvp.md §8).
- ADR 0002 (T-DOC-02); `docs/mvp/` (T-DOC-03); TUI docs (deferred).

## Changes
- `apps/app/src/docs/pages/quickstart.md` and `apps/app/src/docs/pages/flows.md` (new, frontmatter `title` and `summary`), listed in `apps/app/src/docs/toc.ts` (T-APP-20). The docs lanes own the content.
- `apps/site/src/content/docs/docs/install.mdx` (new, from `apps/site/docs/install.mdx` through `apps/site/scripts/sync-support-docs.mjs`): the one site page. Every other page in that tree is deleted except the API reference; the sidebar config lists only the install page.
- `apps/site/src/content/docs/docs/self-hosting.mdx` (Docker) is deleted with the image by T-INS-05.
- CLI text quoted from the generated CLI data (`//apps/site:cliData`, `apps/site/scripts/gen-cli-data.mjs`) so a renamed command fails lint.
- Gates: `pnpm docs:sync`, `pnpm docs:check`, `smthrs lint //apps/site:supportDocs`, `smthrs docs //packages/smithers:docs`.

## Anchors

The in-app quickstart's HTTPS section has the fixed heading "Put HTTPS in front" (anchor `put-https-in-front`). The Settings line "Notifications need HTTPS ↗" opens `docs quickstart#put-https-in-front` (T-APP-20), so a test asserts the anchor exists.

## Tests
- unit `apps/app/src/docs/pages.test.ts` (new, beside T-APP-20's loader): the in-app docs index is exactly {Quickstart, Flows reference}; the quickstart links the API reference; every `smthrs …` invocation in both pages resolves in source `makeCli()` with valid flags (the technique of `packages/smithers/test/McpDocs.test.ts`); a planned-commands allowlist names commands the docs may cite before they ship, and the test fails when a listed command ships, so the list can't go stale; every slash command exists in `catalog.mvp.json` (T-CAT-01); no banned term from the C-UI-02 list; "Tailscale" appears only in the HTTPS examples; the anchor `put-https-in-front` exists; no link to a deleted page.
- unit `apps/site/scripts/install-page.test.mjs` (new): the site's docs sidebar is exactly the install page (plus the API reference); its commands resolve in `makeCli()`; it links no deleted page.
- journey: the C-J1-04 operator at stage R uses only the install page and the in-app quickstart.

## Acceptance
- [C-REL-01](../checks/C-REL-01.md): the in-app docs are one quickstart plus the flows reference, the site keeps one install page, every quoted command resolves, and docs gates pass.

## Risks and notes
- A CLI test against an installed `smthrs` would pass on stale builds (research/cli-api-cuts.md: the installed rc.1 still lists `create-app`). Tests resolve against source `makeCli()` only.
- Screenshots go stale. Use none, or only those captured by the release run (`apps/site/scripts/capture-ui-docs.mjs`).
