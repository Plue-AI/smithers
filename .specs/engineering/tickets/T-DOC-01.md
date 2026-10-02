# T-DOC-01 Quickstart and flows reference

Stage R · Size M · Depends on T-INS-05 · Unblocks — · Issue: [#3458](https://github.com/smithersai/smithers/issues/3458)
Spec: spec.md §16.3.4 and §17.5a (the quickstart documents Tailscale serve and Caddy and recommends HTTPS in front), §16.1.2 (the launchd fallback); content follows §1.4, §5.1.0, §5.3.1, §8.10.5, §11, §16 · Delta: delta.md §10 (Add: public docs) · Product: mvp.md §12.4, §6.13 API, §8 (CLI and Smithers skill row), J1, J5, M-11, M-28, M-30

## Goal
smithers.sh/docs offers one quickstart (install, setup, first TODO, teammates) and one flows reference, and every command, slash command and step they show exists in the release.

## Scope
In:
- Quickstart: requirements (Apple Silicon macOS, Homebrew, a GitHub repository with squash merging, a provider key and an AI Gateway key); `brew install smithersai/tap/smithers`; `smthrs host start [--bind <addr>] [--origin <url>]` and its one-time setup URLs (§1.4, §5.1.0), which work from the Mac or a LAN laptop; the setup card steps; ask a question; the first TODO to Merged; add members; secrets; the SSH line `ssh -p 2222 <branch>@<install host>` (§8.10.5); a laptop agent's `smthrs login <install origin>` (§5.3.1); `smthrs host status`, `upgrade`, `backup` and `restore`.
- The launchd fallback when Hypervisor.framework refuses the daemon: a launchd agent plus macOS automatic login (§16.1.2, T-INS-05).
- Reaching the install from other machines: Settings bind address and public origins (T-INS-04); plain HTTP on a LAN works, and an http origin sends the session cookie unencrypted (§17.5a); two examples of HTTPS in front: `tailscale serve --bg --https=443 http://127.0.0.1:4000` (with `--tcp=2222` for SSH) and a Caddy reverse proxy. These are the only Tailscale and Caddy mentions in the product (spec §0, §16.3.4).
- A link to the HTTP API reference, which stays published where it is today (`apps/site/src/content/docs/docs/reference/api/`, mvp.md §6.13).
- Flows reference: overridable flows (`todo`, `learning`, `review`, repository flows) and system flows (M-30); `flows/<name>/flow.ts` with `Flow.make("<name>", {…})` (AGENTS.md "Flow layering"); `/flow.edit`; versions (proposed, merged and syncing, active, merged but not active) and pinning (§11.3, §11.4); install-stored config and `.smithers/*` precedence (§11.2); learning proposals (§11.8); running a flow on a scratch branch (§11.4.3).
- The `/docs` sidebar holds these two pages. Every page under `apps/site/src/content/docs/docs/` that documents a cut or deferred surface (mvp.md §8: five-job setup, Docker self-host, TUI, Cloud pricing, create-app) is deleted or removed from the sidebar; the inventory goes in the change description.

Out:
- The 50 generated library sites (`apps/docs/shared/manifest.mjs`): libraries stay published (mvp.md §8).
- ADR 0002 (T-DOC-02); `docs/mvp/` (T-DOC-03); TUI docs (deferred).

## Changes
- `apps/site/docs/quickstart.mdx` (new) and `apps/site/docs/flows.mdx` (new), projected by `apps/site/scripts/sync-support-docs.mjs` (add both to `pages`, `:12-17`) to `apps/site/src/content/docs/docs/quickstart.mdx` (replacing today's five-job quickstart) and `…/docs/flows.mdx`; add both outputs to `supportDocs.changes` in `apps/site/PACKAGE.ts:74-85`.
- `apps/site/src/content/docs/docs/installation.mdx` (source `apps/site/docs/installation.mdx`, a source-checkout CLI install) → replaced by the quickstart's install section.
- `apps/site/src/content/docs/docs/self-hosting.mdx` (Docker) is deleted with the image by T-INS-05; the quickstart replaces it.
- CLI text quoted from the generated CLI data (`//apps/site:cliData`, `apps/site/scripts/gen-cli-data.mjs`) so a renamed command fails lint.
- Gates: `pnpm docs:sync`, `pnpm docs:check`, `smthrs lint //apps/site:supportDocs`, `smthrs docs //packages/smithers:docs`.

## Anchors

The quickstart's HTTPS section has the fixed heading "Put HTTPS in front" (anchor `#put-https-in-front`). The Settings line "Notifications need HTTPS ↗" links to `/docs/quickstart/#put-https-in-front`, so a test asserts the anchor exists.

## Tests
- unit `apps/site/scripts/mvp-docs.test.mjs` (new): the `/docs` sidebar's top level is exactly the two pages; the quickstart links the API reference; every `smthrs …` invocation in both pages resolves in source `makeCli()` with valid flags (the technique of `packages/smithers/test/McpDocs.test.ts`); every slash command exists in `catalog.mvp.json` (T-CAT-01); no banned term from the C-UI-02 list; "Tailscale" appears only in the HTTPS examples; no link to a deleted page.
- journey: the C-J1-04 operator at stage R uses only this quickstart.

## Acceptance
- [C-REL-01](../checks/C-REL-01.md): the public docs are one quickstart plus the flows reference; every quoted command resolves; docs gates pass.

## Risks and notes
- A CLI test against an installed `smthrs` would pass on stale builds (research/cli-api-cuts.md: the installed rc.1 still lists `create-app`). Tests resolve against source `makeCli()` only.
- Screenshots go stale. Use none, or only those captured by the release run (`apps/site/scripts/capture-ui-docs.mjs`).
