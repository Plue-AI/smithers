# Maintaining public setup docs

The public site keeps one install page and the HTTP reference. Pricing stays held for Will's rewrite. Product guides live in the app; retained library references move into package docs under #3478.

| Page | Source | Projection |
| --- | --- | --- |
| Install | `docs/installation.mdx` | `src/content/docs/docs/installation.mdx` |
| HTTP reference | `src/content/docs/docs/reference/http-api.mdx` | None |

Edit the install source, then run:

```bash
node apps/site/scripts/sync-support-docs.mjs
node apps/site/scripts/generate-llms.mjs
```

Keep Will's generated description unchanged. `generate-project-copy.mjs` refreshes its marker block from `src/data/project.json`; the README copy belongs to Will.

Every public install section carries an availability label. Verify commands against `packages/smithers/src/Cli.ts`; planned host commands are bound to engineering tickets in `scripts/install-page.test.mjs`.

The retirement inventory is `docs/retired-pages.json`. Retired pages must be absent, with both URL forms redirected to `/docs/installation/`. Only held pricing links may rely on those redirects; retained guides must link to instructions that teach the named operation.

CLI prerequisites live in `packages/smithers/docs/installation.md`; library linking lives in `packages/smithers/flows/flow/docs/installation.md`. Use relative links within a package and absolute GitHub blob URLs across packages.

Run the source checks:

```bash
node apps/site/scripts/check-docs.mjs
node --test apps/site/scripts/install-page.test.mjs apps/site/scripts/generate-project-copy.test.mjs
```
