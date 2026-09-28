/**
 * Targets for the private Smithers theme tokens.
 *
 * `@smthrs/ui` and `apps/review` import this package. See
 * `packages/smithers/ui/PACKAGE.ts` for why this package declares its own targets: the
 * root `packageDefaults` would otherwise
 * synthesize a `BuildAndCheckTypeScriptPackage` library build and vitest suite for it, and
 * this package ships as source with a Bun suite instead.
 *
 * It does own a `tsconfig.json` and a `Typecheck` target, so `pnpm run check`
 * and `smithers-build ci` cover it like every other package, and `bunfig.toml`
 * puts the 1.0 baseline's 100% coverage threshold on the Bun suite. What it
 * still owes is the repository's own Vitest configuration with isolated
 * reports, which is what
 * `packages/smithers/flows/test/vitestCoverageIsolation.test.ts` asserts and the only
 * reason the `ui-styleguide` entry stays in its `zeroXUiKits` carve-out.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/ui/ui-styleguide"

/**
 * `tsc --noEmit` over the sources and tests.
 *
 * The suites import `bun:test`, and `tests/bunTest.d.ts` supplies the local
 * ambient declaration that stands in for `bun-types`. Runtime sources remain
 * dependency-free.
 *
 * @since 1.0.0-rc.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: [
    Smithers.glob("//packages/smithers/ui/ui-styleguide/src/**/*.ts"),
    Smithers.glob("//packages/smithers/ui/ui-styleguide/tests/**/*.ts")
  ],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

// Shiki is pinned by this package's manifest and the workspace lockfile.
const shikiThemes = Smithers.Filegroup({
  srcs: [
    Smithers.file("package.json"),
    Smithers.file("//pnpm-lock.yaml"),
    Smithers.file("node_modules/@shikijs/themes/package.json"),
    ...[
      "index", "night-owl", "night-owl-light", "one-dark-pro", "one-light",
      "github-dark", "github-light", "catppuccin-mocha", "catppuccin-latte",
      "solarized-dark", "solarized-light", "gruvbox-dark-medium", "gruvbox-light-medium",
      "rose-pine", "rose-pine-dawn"
    ].map((id) => Smithers.file(`node_modules/@shikijs/themes/dist/${id}.mjs`))
  ],
  cwd
})

/**
 * The token suite: everything under `tests/`, run by Bun.
 *
 * `tests/generatedThemes.test.ts` spawns `packages/smithers/ui/ui-styleguide/scripts/generate-theme-registry.ts`
 * from the repository root and byte-compares its output against `src/themes/*`,
 * so the generator and the lockfile that pins its `@shikijs/themes` input are
 * declared inputs here. Without them the target's key would not change when the
 * generator does, and a cache hit would skip the exact drift check the test
 * exists to perform.
 *
 * `bunfig.toml` is an input for the same reason: it carries the 100% coverage
 * threshold this suite is gated on, so lowering it must re-key the target
 * rather than land behind a cache hit.
 *
 * So are `README.md` and every Markdown file under `docs/`. `tests/docs.test.ts` reads them against
 * the barrel and fails when an export goes undocumented, which is how the
 * missing `Rgb` row was found; a documentation edit that drops an export has to
 * re-key this target rather than land behind a cache hit.
 *
 * @since 0.1.0
 * @category test
 */
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["tests"]),
  srcs: [
    Smithers.glob("//packages/smithers/ui/ui-styleguide/src/**/*.ts"),
    Smithers.glob("//packages/smithers/ui/ui-styleguide/tests/**/*.ts"),
    Smithers.glob("//packages/smithers/ui/ui-styleguide/docs/**/*.md"),
    Smithers.file("//packages/smithers/ui/ui-styleguide/README.md"),
    Smithers.file("//packages/smithers/ui/ui-styleguide/bunfig.toml"),
    Smithers.glob("//packages/smithers/ui/ui-styleguide/scripts/**/*.ts"),
    Smithers.file("//pnpm-lock.yaml")
  ],
  deps: [shikiThemes],
  cwd
})

/**
 * The package's documentation as a file group (`docs/**`, the README, and
 * package.json), matching the filegroup BuildAndCheckTypeScriptPackage emits. The docs-site
 * content sync in `apps/docs/ui-styleguide/PACKAGE.ts` depends on it by
 * label, the one way an input reaches across a package boundary.
 */
const docsFiles = Smithers.Filegroup({
  srcs: [Smithers.glob("docs/**/*.md"), Smithers.file("README.md"), Smithers.file("package.json")],
  cwd
})

/**
 * Security review: `security` reviews the diff against origin/main and
 * `securityAudit` audits every reviewed file. The package emits CSS that hosts
 * interpolate into `<style>` elements, so the checks focus on that sink.
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "scripts/**", "docs/**", "README.md"],
  checks: [
    {
      id: "css-token-injection",
      title: "Every token interpolated into emitted CSS is validated before it reaches the stylesheet",
      threat: "A caller or theme source that controls a token value injects CSS rules or closes the host's <style> element to run markup in the page of every viewer.",
      lookFor: [
        "A declaration in serializeThemeVariant, paletteThemeCss, standaloneThemeCss, or themeTokens built from a value that bypasses checkedValue.",
        "A delimiter CSS_UNSAFE does not reject that ends a declaration or element, such as an escaped newline, `</style`, or a non-ASCII lookalike.",
        "A token value such as `url(//host/x)` or `image-set(...)` that passes CSS_UNSAFE and makes the viewer's browser fetch an attacker-chosen URL."
      ],
      paths: ["src/serializeThemeVariant.ts", "src/paletteThemeCss.ts", "src/standaloneThemeCss.ts", "src/themeTokens.ts"]
    },
    {
      id: "palette-key-selector-injection",
      title: "Palette keys reach attribute selectors only after a registry own-property lookup",
      threat: "A palette key read from localStorage, a query parameter, or a server response breaks out of a `[data-palette=...]` selector or resolves a prototype property.",
      lookFor: [
        "A key interpolated into `attr(\"palette\", key)` that was not checked by findTheme or taken from Object.entries(themeRegistry).",
        "findTheme or themeRegistry indexed with `in` or bracket access instead of Object.hasOwn, so `__proto__` or `constructor` resolves."
      ],
      paths: ["src/paletteThemeCss.ts", "src/themeRegistry.ts"]
    },
    {
      id: "generated-theme-provenance",
      title: "Generated theme files contain only validated colors from the pinned @shikijs/themes",
      threat: "A compromised or unpinned @shikijs/themes release writes code or unvalidated values into src/themes/*.ts, which every Smithers UI imports.",
      lookFor: [
        "An upstream color copied into the generated record without `opaque` or a hex check, such as `terminal.selectionBackground`.",
        "A generated string emitted without JSON.stringify, or a key emitted unquoted without the identifier regex.",
        "A path in writeFileSync or import() derived from theme data instead of the fixed specs table and outputDir."
      ],
      paths: ["scripts/generate-theme-registry.ts", "src/themes/*.ts"]
    },
    {
      id: "docs-unsafe-snippets",
      title: "Copyable doc snippets never interpolate untrusted input into HTML or CSS",
      threat: "A developer who copies a documented snippet ships a page where a user-supplied palette key or token injects markup or CSS.",
      lookFor: [
        "A snippet that writes a localStorage, query, or server value into data-palette, innerHTML, or a style string without checking it with findTheme.",
        "A snippet that interpolates caller data next to standaloneThemeCss() in a server-rendered template without escaping."
      ],
      paths: ["docs/**/*.md", "README.md"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, docsFiles, shikiThemes, unitTests, ...securityReview }
})
