# T-APP-20 `/docs` flow: in-app docs from one Markdown source per page

Stage S2 · Size M · Depends on T-APP-19, T-UI-21, T-CAT-01 · Unblocks T-DOC-01 · Issue: to file
Spec: spec.md §6.1, §14.2.1 · Delta: delta.md §10 (docs move into the app) · Product: mvp.md M-35, §12.4

## Goal

`/docs` opens the product's docs inside the app, from Markdown pages the docs lanes own, so the standalone docs site can be removed.

## Ownership (Will, 2026-10-02)

Owner: smithers-b8 (frontend lead): containers and flows. Design (smithers-06) builds the `DocsView` (T-UI-21): toc rail and page view. Content comes from smithers-e8's docs lanes (T-DOC-01).

## Scope

In:
- Flows in the app registry (`apps/app/src/mainview/flows/entries/docs.ts`): `docs [page][#anchor]` opens the Docs surface at a page (default: the first page in the table of contents); it is UI-only (§14.1.4). `docs.read <page>` returns a page's Markdown and is model-invocable (`agent: run`), so the app agent answers "how do I" from the same source. `docs.search` comes later and is not in the MVP.
- Content: one Markdown file per page at `apps/app/src/docs/pages/<slug>.md`, flat, with frontmatter `title` and `summary` only, bundled at build time (Vite `?raw` glob). No backend route and no runtime fetch, so docs always match the installed version.
- Order: `apps/app/src/docs/toc.ts`. Every toc slug has a page and every page is in the toc.
- Anchors: headings get stable slugs, and `docs quickstart#put-https-in-front` scrolls to that heading. Relative `.md` links become in-app navigation.
- The DocsContainer maps content to `DocsModel {toc[{slug, title}], page {slug, title, summary, markdown}, anchor?}` (ui-components.md) and binds navigation to the `docs` flow. Rendering reuses the wiki's read-only Markdown renderer (`MarkdownEditorSurface` with `readOnly`). Until T-UI-21 lands, the container renders that existing surface directly; the View then wraps it.

Out:
- Page content (T-DOC-01). Search, versioning and editing in the app.

## Changes

- `apps/app/src/docs/pages/` and `toc.ts` (new) with the `?raw` loader; `flows/entries/docs.ts` (`docs`, `docs.read`) and their catalog descriptors (T-CAT-01); `DocsContainer.tsx`; `packages/rpc/src/DocsCard.ts`.

## Tests

- unit: every toc slug has a page and every page is in the toc; every page link and anchor resolves; an unknown page opens the first page with a not-found state; Markdown renders through the sanitizer (no raw HTML or script survives).
- unit (parity): `docs` and `docs.read` are reachable from slash, button and agent (`flows/parity.test.ts`).
- build: the built app bundle contains every page.
- e2e: `docs quickstart#put-https-in-front` from the composer and from the Settings link land on that heading; the app agent answers a "how do I" question citing `docs.read` (C-UI-09).

## Acceptance

- [C-UI-09](../checks/C-UI-09.md).
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes

- Bundled docs ship with the app version, so docs and product can't drift. A docs fix needs an app release; accepted for the MVP.
