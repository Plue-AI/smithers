# @smthrs/ui-styleguide

**Documentation:** https://ui-styleguide.smithers.sh

Shared CSS tokens and layout primitives for Smithers browser UIs.

Eight color palettes, each with a light and a dark variant, emitted as CSS
custom properties plus the base element and component rules that consume them.
`@smthrs/ui` builds its shadcn-anatomy components on these tokens; `apps/app` and
`flows/review` embed the sheets directly.

Private at `1.0.0-rc.0`: the package ships only inside the workspace, as
TypeScript source with no build step and no dependencies.

```ts
import { standaloneThemeCss, themeCss, themeRegistry, workflowUiStyles } from "@smthrs/ui-styleguide";

// One <style> tag for a workflow UI shell.
document.head.append(Object.assign(document.createElement("style"), { textContent: workflowUiStyles }));

// Or just the tokens, for one pinned palette.
const css = themeCss({ palettes: ["one"] });
```

## Documentation

The full site is at https://ui-styleguide.smithers.sh. Its sources live in
[`docs/`](./docs/), which is the only place to edit them.

- [`docs/README.md`](./docs/README.md) is the landing page.
- [`docs/api.md`](./docs/api.md) covers every runtime export and type, with the
  input contracts and the failure modes each one throws on.
- [`docs/theming.md`](./docs/theming.md) covers the `data-palette` and
  `data-theme` axes, why source order decides the cascade, and the specificity
  an override has to beat.
- [`docs/concepts/contrast-budget.md`](./docs/concepts/contrast-budget.md)
  covers the WCAG AA table the tests enforce and the recorded upstream gaps.

## Layout

| Path | What it holds |
| --- | --- |
| `src/index.ts` | The barrel, `workflowUiThemeCss`, `workflowUiLayoutCss`, and `themeCss`. |
| `src/themes/` | Paper, generated from portable app tokens and pinned syntax/ANSI inputs. |
| `src/themeTokens.ts` | Theme-invariant tokens: aliases, tint recipes, geometry, type scale. |
| `tests/paintedPairs.ts` | The audited (foreground, background) table and the recorded upstream gaps. |
| `tests/nodeBinary.ts` | The Node executable the two spawning suites use, because `process.execPath` under this package's runner is Bun. |
| `tests/bunTest.d.ts` | A typecheck-only stand-in for `bun-types`, so the suites are inside the TypeScript program while the package declares no dependencies. |

## Commands

```sh
pnpm --filter @smthrs/ui-styleguide test    # bun test tests
pnpm --filter @smthrs/ui-styleguide check   # tsc --noEmit over src/ and tests/
```

There is no `lint` script. `eslint` and `dprint` are package-level
devDependencies everywhere they run in this repository, and this package
declares none at all, so linting it means adding dependencies. That is the one
open item from the tooling review.

`bunfig.toml` turns coverage on for the test run and fails it below 100% line
and function coverage. The threshold covers `src/` and the shared pair table,
so there is no separate coverage command.

`tests/docs.test.ts` reads `docs/api.md` against the barrel and fails when an
export goes undocumented, so a new export is a documentation change too.

## Test failures

These four are the suite's own contracts, and each one has a specific fix.

### `the generated theme registry` fails after you edit a theme

`src/themes/paper.ts` are byte-for-byte generator output.
`tests/generatedThemes.test.ts` runs the generator in `--check` mode and
compares. Change `scripts/generate-theme-registry.ts` and regenerate:

```sh
node --experimental-strip-types packages/smithers/ui/ui-styleguide/scripts/generate-theme-registry.ts
```

Editing a generated theme file directly is not a change, it is a pending
revert.

### A `meets AA` test fails after you add a rule

Your rule paints a pair that misses 4.5:1 in at least one of the 16 variants.
The test name is `palette/mode/label`, so it says which. Correct the rule or
the generator's token seed and regenerate. Every audited UI pair must meet AA;
the table has no UI contrast exemptions.

Any new rule that puts a foreground on a background adds its pair to
`PAINTED_PAIRS`. A background expression that appears in a rule but not in that
table is an unaudited surface, and removing a rule to make a listed pair
disappear hides a token failure rather than fixing it.

### `documents every runtime export` fails

You added an export to `src/index.ts` and not to `docs/api.md`.
`tests/docs.test.ts` requires each name to appear backticked on that page,
either closed (`` `themeCss` ``) or opening a signature (`` `themeCss(` ``). A
bare mention in prose does not count.

### `ERR_MODULE_NOT_FOUND` for a relative specifier

The package ships as source and is loaded under Node ESM by `flows/review`,
where an extensionless relative specifier does not resolve. Every relative
import inside `src/` carries its `.ts` extension for that reason, and the theme
generator emits it too. If you dropped one, `tests/nodeEsmResolution.test.ts`
catches it; the suite spawns a real Node process, because the Bun that runs the
tests resolves extensionless specifiers happily.
