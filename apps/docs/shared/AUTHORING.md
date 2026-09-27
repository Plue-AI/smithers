# Authoring package docs

Package documentation lives in `<pkg>/docs/`. Packages in the docs manifest
also have a generated site. The site at
`https://<slug>.smithers.sh` is stitched from those files by
`apps/docs/shared/sync-content.mjs` and deployed by Alchemy; you never edit
anything under `apps/docs/`.

The manifest at `apps/docs/shared/manifest.mjs` maps each package to its slug
(for example `@smthrs/flow` is `flow`, so its site is `flow.smithers.sh`).
Build, build-cli, and targets have no standalone sites in this fleet; their
aggregate references are on smithers.sh under `/docs/reference/api/`.

## Where files go and what they become

Files live in the package directory next to `src/`, and sync maps them onto
site routes:

| Source file            | Site page             | Route                |
| ---------------------- | --------------------- | -------------------- |
| `docs/README.md`       | `index.md`            | `/`                  |
| `docs/api.md`          | `reference/api.md`    | `/reference/api/`    |
| `docs/testing.md`      | `testing.md`          | `/testing/`          |
| `docs/guides/x.md`     | `guides/x.md`         | `/guides/x/`         |
| `docs/a/README.md`     | `a/index.md`          | `/a/`                |

Everything else mirrors its path under `docs/`. Only the root `api.md` moves
into `reference/`; a nested `api.md` keeps its path.

`README.md` is the landing and overview page. `api.md` is the API reference.
Add `installation.md`, `quickstart.md`, `guides/`, `concepts/`, `tutorials/`,
and `troubleshooting.md` only where the package has the substance: a small
utility package stays small. A package with two real pages ships two pages.

## Frontmatter and page rules

Every page needs a frontmatter block with `title` and `description`:

```markdown
---
title: "Retry policy"
description: "How @smthrs/flow retries a failed action, and the policy values that control it."
---

Body starts here, at heading level two or deeper.
```

If you omit the block, sync synthesizes one: the title from the file mapping
(the package name for `README.md`, "API reference" for `api.md`, the
Title-Cased file name otherwise) and the description from the package's
`package.json`. Write the block yourself on every page you author; the
synthesized text is a fallback, not a voice.

Sync appends `editUrl` pointing at the source file on GitHub when a page does
not set one, so the site's edit link always lands on the real source.

Hard rules, enforced on smithers.sh by `apps/site/scripts/check-docs.mjs` and
expected here:

- `title` and `description` on every page.
- No `#` heading in the body. The frontmatter title is the page heading; body
  headings start at `##`. Sync strips one leading H1 if a source has one.
- No em dash or en dash outside fenced code. Use a colon, a comma, or two
  sentences.
- Every fenced code block names a language: ```` ```ts ````, ```` ```bash ````,
  ```` ```text ```` for output.

## Links

Write links the way the colocated docs already do; sync rewrites them
deterministically when it stitches the site.

- **Same package, relative.** Link sibling pages by file:
  `[testing](./testing.md)`, `[labels](../concepts/labels.md)`. Sync resolves
  them against the docs tree and turns them into this site's routes
  (`/testing/`, `/concepts/labels/`). A link that escapes the docs tree
  (`../README.md`, `../../src/index.ts`) becomes a GitHub link to that file.
  A relative `.md` link whose target does not exist also becomes a GitHub
  link, with a sync warning, so a rename shows up the day you run it.
- **Another package's API.** `/api/<slug>`:
  `[the engine API](/api/engine)`. Sync sends it to
  `https://engine.smithers.sh/reference/api/`. Your own slug stays on your
  own site. Never hand-write `https://<slug>.smithers.sh/...` in prose; the
  `/api/<slug>` form is the contract and it survives domain changes.
- **Any other page of another package's site.** `/pkg/<slug>/<path>`:
  `[the delegation guide](/pkg/patterns/delegation)` becomes
  `https://patterns.smithers.sh/delegation/`, and `/pkg/patterns` becomes that
  site's landing page. `<path>` is the target's route on that site, which is
  its path under `docs/` without the `.md` (so `docs/guides/loops.md` is
  `/pkg/patterns/guides/loops`). Use it whenever you mean a guide or concept
  rather than an API page; a relative `../../other-package/docs/x.md` reaches
  a file on GitHub, not a page, and fails the smithers.sh link gate.
- **CLI verbs.** `/cli/<verb>`: `[smthrs flow](/cli/flow)`. Sync sends it to
  the CLI reference on smithers.sh.
- **Guides, concepts, and every other smithers.sh page.** `/docs/<rest>`:
  `[durable execution](/docs/concepts/durable-execution/)`. Sync makes it an
  absolute smithers.sh URL. `/migration/1.0` maps under `/docs/migration/`.
- **A root path that is one of your own pages.** `/testing` resolves to this
  site's `/testing/`. Any other root path goes to smithers.sh docs with a
  sync warning; prefer one of the explicit forms above.
- **`./docs/x.md` names a file, not a page.** It links the file itself on
  GitHub, for prose about the docs tree (as in "edit `docs/api.md`").
- Anchors (`#fragment`) survive every rewrite unchanged.
- Images and other assets are not synced. Host them outside the docs tree
  (an absolute URL), or keep them out of the docs.

## Sidebar

The sidebar is computed from the synced tree; you never configure it.

- "Start here": the overview (`README.md`), `installation.md`,
  `quickstart.md`, when present.
- Every other top-level page, alphabetical.
- One group per directory: guides, tutorials, concepts, reference,
  troubleshooting in that order, then any other directory alphabetically.

Inside a group, order comes from each page's `sidebar.order` frontmatter
(lower first), then its title. Set it on pages whose order matters:

```markdown
---
title: "Install"
description: "..."
sidebar:
  order: 1
---
```

## Release status

`shared/release-notice.mjs` adds the current prerelease notice to every rendered
package page and the main docs. Remove it from both Starlight configurations
when 1.0 is published, and update the source-checkout notice in the main
installation guide and `generate-project-copy.mjs` at the same time. Package
installation pages that describe unpublished packages must also be refreshed
against the release manifest and registry.

## Verify your work

From the repo root, with your slug:

```bash
pnpm exec dprint fmt 'docs/**/*.md' 'README.md'  # from the SOURCE package directory
pnpm --filter @smithers/docs-flow sync:docs     # stitch your docs into the site
pnpm --filter @smithers/docs-flow build         # astro build must pass
pnpm --filter @smithers/docs-flow check         # astro check must pass
pnpm --filter @smithers/docs-flow check:docs    # the committed copy matches your sources
```

Format first, and in that order. Each package's `dprint.json` includes
`**/*.md`, and its `lint` script runs `dprint check`, so an unformatted docs
page fails `pnpm lint` and the `//packages/...` gate in CI, in the package
rather than in the site. Formatting after syncing leaves the committed copy
stale, which then fails `check:docs`.

The whole fleet at once: `pnpm run docs:sync`, then `pnpm run docs:build`.
`pnpm run docs:check` is the drift gate lint runs.

Commit the source docs and the synced `apps/docs/<slug>/src/content/docs/`
tree together. The synced copy is the cache; CI fails on drift, not on
content.
