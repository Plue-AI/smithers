/**
 * Conventional TypeScript package target expansion.
 *
 * @since 0.1.0
 */
import { DocsParity } from "@smthrs/targets/DocsParity"
import { Dprint } from "@smthrs/targets/Dprint"
import { EsLint } from "@smthrs/targets/EsLint"
import { Filegroup } from "@smthrs/targets/Filegroup"
import * as Input from "@smthrs/targets/Input"
import { entrypoint, NodeTest } from "@smthrs/targets/NodeTest"
import type * as PackageManager from "@smthrs/targets/PackageManager"
import type * as Target from "@smthrs/targets/Target"
import { TsBuild } from "@smthrs/targets/TsBuild"
import { Typecheck } from "@smthrs/targets/Typecheck"
import { Vitest } from "@smthrs/targets/Vitest"

/**
 * Options accepted by {@link BuildAndCheckTypeScriptPackage}.
 *
 * `cwd` is the workspace-relative package directory every emitted target's
 * tool runs in. It is required because every default input is package-shaped,
 * so a declaration passes its own directory, for example `packages/smithers/flows/plan`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The package manager every emitted target runs its tool through. Omitted —
   * which is what a PACKAGE.ts writes — every emitted target resolves it from
   * the workspace declaration when the graph is planned. A caller passes one
   * only to run a package's tools through a second manager.
   */
  readonly packageManager?: PackageManager.PackageManager | undefined
  /** @default [] */
  readonly deps?: ReadonlyArray<Target.AnyTarget> | undefined
  readonly cwd: string
  /**
   * The package's TypeScript sources. It feeds every target that reads them:
   * `lib`, `check`, `test`, `lint`, `fmt`, and `circular`. It does not name
   * the published entry point, which is `entry`, so a package that relocates
   * its sources overrides both.
   *
   * @default src/**\/*.ts
   */
  readonly sources?: Input.Glob | undefined
  /**
   * The published entry file `lib` declares. `TsBuild` derives the emitted
   * `dist/<format>/<name>.js` and its declaration from this basename, so a
   * package whose entry is not `src/index.ts` names it here rather than
   * inheriting a path outside its own `sources`.
   *
   * @default src/index.ts
   */
  readonly entry?: Input.File | undefined
  /**
   * The glob Vitest collects cases from. It feeds `test` alone. Narrowing it
   * to a subset of the test tree, which is how a package holds a tier such as
   * fault injection out of its default suite, must not narrow what `check`
   * typechecks or what `fmt` keys on, so those read `testSources` instead.
   *
   * @default test/**\/*.test.ts
   */
  readonly tests?: Input.Glob | undefined
  /**
   * Every TypeScript file in the package's test tree, including helpers and
   * fixtures no suite collects. It feeds `check` and `fmt`, and a package
   * that keeps its tests outside `test/` overrides it beside `tests`.
   *
   * @default test/**\/*.ts
   */
  readonly testSources?: Input.Glob | undefined
  /** Package-relative globs for data read by tests, included in the test cache inputs. */
  readonly testData?: readonly string[] | undefined
  readonly tsconfig?: Input.File | undefined
  readonly testTsconfig?: Input.File | undefined
  readonly vitestConfig?: Input.File | null | undefined
  /** Optional test entrypoint for a package-owned multi-environment gate. */
  readonly testProgram?: Input.File | undefined
  /**
   * Outer deadline for the complete Vitest process. Omitted, the Vitest
   * target keeps its 20-minute default. Per-case deadlines and coverage
   * thresholds remain owned by the selected Vitest config.
   */
  readonly testTimeoutMs?: number | undefined
  readonly eslintConfigs?: ReadonlyArray<Input.File> | undefined
  readonly dprintConfig?: Input.File | undefined
  readonly readme?: Input.File | undefined
  /**
   * The program that builds the package's distribution. It defaults to the
   * conventional `scripts/build.mjs`, which is what the repository's
   * per-package `build` script runs.
   */
  readonly buildProgram?: Input.File | undefined
  /**
   * Further files the build program reads, beyond `sources` and the shared
   * build scripts. `@smthrs/cli` bundles `apps/tui` into its distribution.
   *
   * @default []
   */
  readonly buildInputs?: ReadonlyArray<Input.Glob | Input.File> | undefined
  /**
   * The circular-dependency guard this package runs. It defaults to the
   * conventional `scripts/circular.mjs`, which is what the repository's
   * per-package `circular` script runs.
   */
  readonly circularScript?: Input.File | undefined
}

/**
 * The conventional targets emitted by {@link BuildAndCheckTypeScriptPackage}.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackageTargets {
  readonly lib: ReturnType<typeof TsBuild>
  readonly check: ReturnType<typeof Typecheck>
  readonly test: ReturnType<typeof Vitest> | ReturnType<typeof NodeTest>
  readonly lint: ReturnType<typeof EsLint>
  readonly fmt: ReturnType<typeof Dprint>
  readonly docs: ReturnType<typeof DocsParity>
  readonly circular: ReturnType<typeof NodeTest>
  /**
   * The package's documentation as a file group: `docs/**\/*.md`, the README,
   * and `package.json`. It joins no verb; a generator elsewhere in the
   * workspace that reads a package's docs lists this target in its `data`,
   * which is the one way an input glob may reach across a package boundary.
   */
  readonly docsFiles: ReturnType<typeof Filegroup>
}

/**
 * Expands one conventional package into `lib`, `check`, `test`, `lint`,
 * `fmt`, `docs`, `circular`, and `docsFiles` targets.
 *
 * Defaults follow the Smithers repository layout: sources in `src`, tests in
 * `test`, the package `build` program over the package `tsconfig.json`, the
 * test half of the package `check` script as `tsc -p tsconfig.test.json
 * --noEmit`, Vitest with
 * the package `vitest.config.ts`, ESLint with the package flat
 * `eslint.config.js` plus the root `eslint.jsdoc.js`, and dprint with the
 * package `dprint.json`. Together `lib` + `check` cover what the repository's
 * package `check` scripts cover, and `lint` + `fmt` cover what its `lint`
 * scripts cover, and `circular` is the per-package `circular` script, so the
 * `ci` verb over these targets is gate-equivalent to the pnpm scripts. Lint covers the source glob only, matching the
 * repository's package lint scripts; the flat config declares no coverage
 * for test files, and ESLint 9 fails on a pattern whose matches are all
 * unconfigured. `check` depends on `lib` because the test tsconfig resolves
 * workspace dependencies through their built declarations. `docs` is the
 * documentation-parity target over the package README. It participates in
 * the `docs` verb alone; the aggregate `ci` command plans that verb alongside
 * build, test, and lint. `docsFiles` is the package's documentation named as
 * a `Filegroup` (`docs/**\/*.md`, the README, `package.json`); it joins no
 * verb and exists so a generator in another package, such as the site's API
 * page sync, can depend on the docs by label instead of through a glob that
 * package scoping expands to nothing. Callers can override any shared input
 * without replacing the macro; each option documents which targets it feeds.
 * `sources` and `entry` are separate options, as are `tests` and
 * `testSources`, because the published entry point is one file inside the
 * sources and because narrowing the suite one package runs must not narrow
 * what it typechecks or formats. The call returns declarations and runs no
 * tool; see "Failure contracts" in the package README for declaration and
 * execution failures.
 *
 * @category macros
 * @since 0.1.0
 */
export const BuildAndCheckTypeScriptPackage = (options: Options): PackageTargets => {
  const cwd = options.cwd
  const deps = options.deps ?? []
  const sources = options.sources ?? Input.glob("src/**/*.ts")
  const tests = options.tests ?? Input.glob("test/**/*.test.ts")
  const testSources = options.testSources ?? Input.glob("test/**/*.ts")
  const entry = options.entry ?? Input.file("src/index.ts")
  const tsconfig = options.tsconfig ?? Input.file("tsconfig.json")
  const testTsconfig = options.testTsconfig ?? Input.file("tsconfig.test.json")
  const vitestConfig = options.vitestConfig === undefined
    ? Input.file("vitest.config.ts")
    : options.vitestConfig
  const eslintConfigs = options.eslintConfigs ?? [
    Input.file("eslint.config.js"),
    Input.file("//eslint.jsdoc.js")
  ]
  const dprintConfig = options.dprintConfig ?? Input.file("dprint.json")
  // The published packages are dual: `PackageJson` derives an `import` and a
  // `require` condition from this `format`, and `scripts/pack-release.mjs`
  // refuses a package missing either half. One `tsc -p` run emits one format,
  // so the producer is the package's own build program, which compiles the
  // ESM half and its declarations with the package tsconfig and rewrites the
  // same sources as CommonJS in a second pass.
  const lib = TsBuild({
    ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
    srcs: [
      sources,
      Input.file("//packages/repo-targets/scripts/build-library.mjs"),
      Input.file("//packages/smithers/scripts/compile-commonjs.mjs"),
      ...(options.buildInputs ?? [])
    ],
    entries: [entry],
    deps,
    tsconfig,
    tool: { name: "program", entry: options.buildProgram ?? Input.file("scripts/build.mjs") },
    format: "dual",
    outDir: "dist",
    cwd
  })
  const check = Typecheck({
    ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
    srcs: [sources, testSources, Input.glob("//packages/repo-targets/test-utils/effect-property.*")],
    deps: [lib, ...deps],
    tsconfig: testTsconfig,
    buildMode: false,
    incremental: false,
    cwd
  })
  const test = options.testProgram === undefined ? Vitest({
    ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
    ...(options.testTimeoutMs === undefined ? {} : { timeoutMs: options.testTimeoutMs }),
    tests: [tests],
    sources: [sources, Input.glob("//packages/repo-targets/test-utils/effect-property.*"), ...(options.testData ?? []).map((pattern) => Input.glob(pattern))],
    deps: [lib, ...deps],
    config: vitestConfig,
    environment: "node",
    passWithNoTests: false,
    cwd
  }) : NodeTest({
    ...(options.packageManager === undefined ? {} : { runtime: options.packageManager.runtime }),
    runner: entrypoint(options.testProgram),
    srcs: [sources, testSources, Input.file("package.json"), ...(vitestConfig === null ? [] : [vitestConfig]),
      Input.glob("//packages/repo-targets/test-utils/effect-property.*"),
      ...(options.testData ?? []).map((pattern) => Input.glob(pattern))],
    deps: [lib, ...deps],
    timeout: `${options.testTimeoutMs ?? 1_200_000}ms`,
    cwd
  })
  const lint = EsLint({
    ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
    sources: [sources],
    deps: [],
    configs: eslintConfigs,
    maxWarnings: 0,
    fix: false,
    cwd
  })
  const fmt = Dprint({
    ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
    sources: [sources, testSources],
    deps: [],
    config: dprintConfig,
    fix: false,
    cwd
  })
  const readme = options.readme ?? Input.file("README.md")
  const docs = DocsParity({
    readme,
    deps: [],
    cwd
  })
  const docsFiles = Filegroup({
    srcs: [Input.glob("docs/**/*.md"), readme, Input.file("package.json")],
    cwd
  })
  const circular = NodeTest({
    // Omitted, the executor fills in the workspace runtime; a caller that
    // named a manager gets that manager's own interpreter.
    ...(options.packageManager === undefined ? {} : { runtime: options.packageManager.runtime }),
    runner: entrypoint(options.circularScript ?? Input.file("scripts/circular.mjs")),
    srcs: [sources, tsconfig],
    deps: [],
    cwd
  })
  return { lib, check, test, lint, fmt, docs, circular, docsFiles }
}
