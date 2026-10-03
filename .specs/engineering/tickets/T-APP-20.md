# T-APP-20 `/docs` flow: in-app docs from one Markdown source per page

Stage S2 · Size M · Depends on T-UI-21, T-CAT-01 · Unblocks T-APP-24, T-DOC-01, T-REL-02 · Issue: [#3481](https://github.com/smithersai/smithers/issues/3481)
Spec: spec.md §6.1, §14.2.1 · Delta: delta.md §10 (docs move into the app) · Product: mvp.md M-35, §12.4

## Goal

`/docs` opens the product's docs inside the app, from Markdown pages the docs lanes own, so the standalone docs site can be removed.

## Ownership (Will, 2026-10-02)

Owner: smithers-b8 (frontend lead): the card file and flows. Design (smithers-06) builds the `DocsView` (T-UI-21): toc rail and page view. Content comes from smithers-e8's docs lanes (T-DOC-01). This ticket owns the Docs card file; T-UI-21 adds back the props type in `packages/rpc/src/DocsCard.ts`.

## Scope

In:
- Flows in the app registry (`apps/app/src/mainview/flows/entries/docs.ts`): `docs [page][#anchor]` opens the Docs surface at a page (default: the first page in the table of contents); it is UI-only (§14.1.4). `docs.read <page>` returns a page's Markdown and is model-invocable (`agent: run`), so the app agent answers "how do I" from the same source. `docs.search` comes later and is not in the MVP.
- Content: one Markdown file per page at `apps/app/src/docs/pages/<slug>.md`, flat, with frontmatter `title` and `summary` only, bundled at build time (Vite `?raw` glob). No backend route and no runtime fetch, so docs always match the installed version.
- Order: `apps/app/src/docs/toc.ts`. Every toc slug has a page and every page is in the toc.
- Anchors: headings get stable slugs, and `docs quickstart#put-https-in-front` scrolls to that heading. Relative `.md` links become in-app navigation.
- The Docs card file maps content to `DocsView` props `{toc[{slug, title}], page {slug, title, summary, markdown}, anchor?}` and binds navigation to the `docs` flow. `DocsView` (T-UI-21) renders it, reusing the wiki's read-only Markdown renderer (`MarkdownEditorSurface` with `readOnly`). The card file never renders Markdown itself.

Out:
- Page content (T-DOC-01). Search, versioning and editing in the app.

## Changes

- `apps/app/src/docs/pages/` and `toc.ts` (new) with the `?raw` loader; `flows/entries/docs.ts` (`docs`, `docs.read`) and their catalog descriptors (T-CAT-01).
- `apps/app/src/mainview/cards/DocsCard.tsx` (new card file, the only mount point through `CardRenderers.tsx`): no docs card exists, and the wiki's `world` card reads repository pages, not bundled ones. It replaces no legacy card.

## Tests

- unit: every toc slug has a page and every page is in the toc; every page link and anchor resolves; an unknown page opens the first page with a not-found state; the props carry each page's Markdown verbatim. Sanitized rendering (no raw HTML or script survives) is T-UI-21's test.
- unit (parity): `docs` and `docs.read` are reachable from slash, button and agent (`flows/parity.test.ts`).
- build: the built app bundle contains every page.
- e2e (`apps/app/e2e/playwright/docs.spec.ts`, new; an install with no network beyond its own origin):
  - `/docs` opens the first page of `toc.ts`, and the toc rail lists exactly its pages, in order.
  - `/docs quickstart#put-https-in-front` lands on the "Put HTTPS in front" heading. The Settings hint path is T-APP-24's.
  - Asked "how do I put HTTPS in front?", the app agent's answer cites `docs.read quickstart`.
  - Every internal link in the quickstart and the flows reference opens its page and anchor; no link 404s and no request leaves the install origin.
  - `/docs no-such-page` shows the first page with a not-found state and no error toast.

## Acceptance

- [C-UI-13](../checks/C-UI-13.md): `DocsView` is reachable from `CardRenderers`; it replaces no legacy card.

## Risks and notes

- M-35 (in-app docs) awaits Will's product decision (synthesis v2, "Still for Will"); this ticket stays specified until he rules.
- Bundled docs ship with the app version, so docs and product can't drift. A docs fix needs an app release; accepted for the MVP.
