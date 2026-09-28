/**
 * Targets for the UI application: typecheck, unit suite and browser tier.
 *
 * Playwright T1 runs in the dedicated PR browser job. Packaged Electrobun
 * remains a separate operator tier; see docs/LOCAL-APP.md "Test tiers".
 *
 * The unit suite uses the declared Bun runtime. SDK preparation and typecheck
 * use the workspace's Node runtime and package manager.
 */
import { Smithers } from "@smthrs/targets"
import { Package as rpcPackage } from "../../packages/rpc/PACKAGE.ts"
import { Package as harnessDetectPackage } from "../../packages/smithers/agent/harness-detect/PACKAGE.ts"
import { Package as gatewayPackage } from "../../packages/smithers/gateway/PACKAGE.ts"
import { Package as componentPackage } from "../../packages/smithers/ui/PACKAGE.ts"

const cwd = "apps/app"

/** The application sources every suite drives. */
const sources = Smithers.glob("//apps/app/src/**/*.ts")

/** The React components, part of the typecheck's and unit suite's key material. */
const componentSources = Smithers.glob("//apps/app/src/**/*.tsx")

/** The stylesheets the SPA bundles; a CSS-only change must invalidate the unit cache too. */
const styleSources = Smithers.glob("//apps/app/src/**/*.css")

/** The build/runtime configs the bundler reads. */
const buildConfigs = [
  Smithers.file("vite.config.ts"),
  Smithers.file("tailwind.config.js"),
  Smithers.file("postcss.config.js")
]

/**
 * The harness and suite sources outside `src/`. The tsconfig compiles them, so
 * the typecheck measures them and its key has to carry them too.
 */
const harnessSources = Smithers.glob("//apps/app/scripts/**/*")

/** The lint sources outside `src/`: the literal pin and the vocabularies it derives. */
const lintSources = Smithers.glob("//apps/app/lint/**/*")
const suiteSources = Smithers.glob("//apps/app/e2e/**/*")

/** The assertion contracts the e2e tiers share; pure, so the unit suite gates them. */
const contractSources = Smithers.glob("//apps/app/e2e/contracts/**/*.ts")

/**
 * Projects the pinned Electrobun SDK before a fresh checkout can typecheck.
 * CI installs with scripts disabled, and the SDK is generated outside the
 * build cache, so this prerequisite always checks the local projection.
 *
 * @since 1.0.0-rc.0
 * @category build
 */
const devkit = Smithers.NodeBinary({
  entry: Smithers.file("scripts/ensure-devkit.mjs"),
  args: [],
  srcs: [
    Smithers.file("package.json"),
    Smithers.file("electrobun.config.ts"),
    Smithers.file("hutch.config.ts"),
    Smithers.file("//pnpm-lock.yaml")
  ],
  deps: [],
  env: { HUTCH_NO_UPDATE_CHECK: "1" },
  cwd
})

/**
 * Checks the application against its own tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  /*
   * Everything this tsconfig includes: `scripts`, `e2e`, `lint`, and the
   * bundler and Electrobun configs are compiled by this target, so a key made of `src`
   * alone would serve a green cache entry over an edit that breaks the
   * typecheck.
   */
  srcs: [
    sources,
    componentSources,
    harnessSources,
    suiteSources,
    lintSources,
    ...buildConfigs,
    Smithers.file("electrobun.config.ts"),
    Smithers.file("hutch.config.ts"),
    Smithers.file("playwright.config.ts"),
    Smithers.file("playwright.showcase.config.ts")
  ],
  deps: [devkit],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The unit suite: everything under `src/`, the e2e assertion contracts under
 * `e2e/contracts/` and the script contracts under `scripts/`, hermetic, with no
 * server and no browser.
 *
 * @since 0.1.0
 * @category test
 */
// Coverage policy: assertion-only for Bun UI units, with required offline
// Playwright in browserE2e. No source coverage percentage is claimed; see
// scripts/repo-contract/README.md for the denominator exception.
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["src", "e2e/contracts", "e2e/real/coverage", "e2e/real/support", "e2e/real/auth-permissions/profile.test.ts", "scripts"]),
  srcs: [
    sources,
    componentSources,
    styleSources,
    contractSources,
    harnessSources,
    suiteSources,
    ...buildConfigs,
    Smithers.glob("//apps/app/*.ts"),
    Smithers.file("tsconfig.json"),
    Smithers.file("package.json"),
    Smithers.file("bunfig.toml"),
    Smithers.file("//package.json"),
    Smithers.file("//pnpm-lock.yaml"),
    Smithers.file("//scripts/require-toolchain.mjs"),
    Smithers.file("//packages/backend/internal/compose/bootstrap.go"),
    Smithers.file("//packages/rpc/fixtures/force/graph.json"),
    Smithers.file("//packages/rpc/fixtures/force/plan-typeCheck.json")
  ],
  // Globs cannot cross PACKAGE.ts boundaries; dependency keys carry these sources.
  deps: [rpcPackage.check, componentPackage.check, gatewayPackage.check, harnessDetectPackage.check],
  cwd
})

/**
 * The conformance lint: the literal pin under `lint/conformance/`.
 *
 * It is a lint, not a unit suite. It derives the app's vocabularies — flow
 * names, card kinds, card-id prefixes, emitted `data-*` attributes — from
 * product source and the running store, then refuses any literal the e2e
 * suites and the `scripts/` runners assert against that no longer resolves.
 * Because it reads harnesses, configuration and workspace vocabularies by
 * path, its key carries every tree it scans; discovery paths alone do not
 * contribute to a target's input identity.
 *
 * @since 1.0.0
 * @category lint
 */
const conformance = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["lint/conformance"]),
  srcs: [
    sources,
    componentSources,
    styleSources,
    contractSources,
    harnessSources,
    suiteSources,
    lintSources,
    ...buildConfigs,
    Smithers.glob("//apps/app/*.ts"),
    Smithers.file("tsconfig.json"),
    Smithers.file("package.json"),
    Smithers.file("bunfig.toml"),
    Smithers.file("//package.json"),
    Smithers.file("//pnpm-lock.yaml"),
    Smithers.file("//scripts/require-toolchain.mjs"),
    Smithers.file("//packages/backend/internal/services/issue_sync.go")
  ],
  // Globs cannot cross PACKAGE.ts boundaries; dependency keys carry these sources.
  deps: [rpcPackage.check, componentPackage.check, gatewayPackage.check, harnessDetectPackage.check],
  cwd
})

/**
 * Runs pinned Playwright and Bun browser OAuth tests, with no live provider
 * calls, the built smithers.sh landing and its AppIsland (e2e/site), and the
 * flow-graph tier: the app over a real control plane and a real engine on
 * localhost, with nothing intercepted (e2e/graph/README.md). The steps run
 * serially (scripts/run-pr-e2e.mjs says why) in ~22 min on ubuntu-latest;
 * 30m keeps 30% headroom inside the apps-e2e job's 70.
 */
const browserE2e = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("scripts/run-pr-e2e.mjs")),
  timeout: "30m",
  srcs: [sources, componentSources, styleSources, harnessSources, suiteSources, ...buildConfigs,
    Smithers.file("playwright.config.ts"), Smithers.file("playwright.site.config.ts"), Smithers.file("playwright.graph.config.ts"),
    Smithers.file("playwright.showcase.config.ts"), Smithers.file("package.json"), Smithers.file("//pnpm-lock.yaml"),
    // `bun test` steps preload the toolchain floor.
    Smithers.file("bunfig.toml"), Smithers.file("//package.json"), Smithers.file("//scripts/require-toolchain.mjs")],
  deps: [],
  env: { SMITHERS_CHAT_STUB: "1" },
  cwd
})

/**
 * Everything a web host needs to bundle the app as a React island: the
 * mainview tree (AppIsland.tsx and the CSS it imports), the Tailwind config
 * index.css names, the build stamp both builds share, and package.json for
 * the pinned react version. apps/site's build target lists it as an input so
 * the site rebuilds when the app changes.
 *
 * @since 1.0.0
 * @category build
 */
const webSources = Smithers.Filegroup({
  srcs: [
    Smithers.glob("src/mainview/**/*"),
    Smithers.file("tailwind.config.js"),
    Smithers.file("scripts/build-stamp.ts"),
    Smithers.file("package.json")
  ],
  cwd
})

/** Complete React source input for the reproducible Solid projection. */
const solidCodegenInputs = Smithers.Filegroup({
  srcs: [Smithers.glob("src/**/*"), Smithers.file("package.json")],
  cwd
})

export const Package = Smithers.Package({
  targets: { solidCodegenInputs, devkit, check, unitTests, conformance, browserE2e, webSources }
})
