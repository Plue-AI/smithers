# T-DOC-04 Delete the generated library docs sites; one wildcard redirect to package docs

Stage S1 · Size M · Depends on — · Unblocks T-REL-02 · Issue: [#3510](https://github.com/smithersai/smithers/issues/3510)
Spec: spec.md §6.1 · Delta: delta.md §10 · Product: mvp.md M-35, §8 ("libraries stay published on npm, each with its README and colocated `docs/` in the package"; product ruling 2026-10-02 at abd79a91)
Ready: 2026-10-03 smithers-8a sha256:0d018e51d250

## Goal

The 48 generated `<slug>.smithers.sh` library sites are gone with the standalone docs site (M-35), and every existing library link still lands on that package's `docs/` folder on GitHub through one redirect rule.

## Ownership

Content and deletion: smithers-e8 (docs) with smithers-38 (packages/), tracked with #3478. Redirect rule: smithers-3f (infra). Who decides: product (smithers-98) for scope; smithers-3f for the redirect mechanism.

## Scope

In:
- Delete `apps/docs/` (the generator, its per-site Alchemy stacks and `apps/docs/shared/manifest.mjs`, 1,313 files / 14,207 lines) and every build, CI and `PACKAGE.ts` reference to it, in the same change.
- Each package's colocated `docs/` stays the source and ships in the npm tarball with its README (`files` includes `docs/`).
- One wildcard redirect: `https://<slug>.smithers.sh/<path>` → `https://github.com/smithersai/smithers/tree/main/<package-dir>/docs` (one rule with a slug → package-dir map generated from the package list, not one stack per site). Unknown slugs redirect to the repository README.

Out:
- The in-app docs (T-APP-20, T-DOC-01). Re-hosting library docs anywhere else. Any change to the packages' APIs.

## Changes

- Delete `apps/docs/**`; remove its targets from the workspace graph and CI.
- The redirect rule in the infra that serves `*.smithers.sh` (3f names the file).
- `packages/*/package.json` `files` includes `docs/` where missing.

## Tests

- unit: a script lists every published package and asserts its tarball (`npm pack --dry-run`) contains `README.md` and `docs/`.
- integration (against the deployed rule): 5 sampled `<slug>.smithers.sh` URLs, including a deep path and an unknown slug, return 301 to the expected GitHub URL.
- repo: no file references `apps/docs` after the change (`rg`), and the workspace graph builds.

## Acceptance

- [C-REL-01](../checks/C-REL-01.md): no standalone docs site remains; quoted links resolve.

## Risks and notes

- Search engines and old blog posts link deep pages; the redirect lands them on the package folder, not the exact page. Accepted by product (one rule, not 48 stacks).

## Ready checklist

1. Depends on: nothing to start. Taking the 48 sites offline waits until 3f's wildcard redirect is live; deleting the apps/docs source and copy step lands first (docs lead, 2026-10-02: unblocks ~600 package-docs fixes under the disk freeze).
2. Out of scope: re-hosting, API changes, per-page redirects.
3. Acceptance at the real boundary: deployed redirect probes and `npm pack` contents.
4. Who decides: product for scope, 3f for the redirect mechanism.
5. Owner pre-review: smithers-38 (package `files`), smithers-3f (redirect).
6. Security: no repository code runs; none.
