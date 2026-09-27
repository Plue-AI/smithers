import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Targets for the `@smthrs/build` package plus the declarations it
 * carried as a standalone workspace root:
 *
 * - `lib`, `check`, `test`, `lint`, `fmt`, and `docs` are this package's own
 *   standard targets. This PACKAGE.ts suppresses default-target synthesis, so
 *   they must be declared here explicitly.
 * - `template` is the inert shared manifest every package merges under.
 * - `packageDefaults` synthesizes a standard package's targets, and its
 *   manifest targets, for any `packages/*` directory without a PACKAGE.ts.
 *   Its glob anchors at this package, so in the Smithers monorepo it matches
 *   nothing; the workspace-wide declaration lives in the root PACKAGE.ts.
 * - `newPackage` is the `run` target that creates such a directory.
 */
import { Smithers } from "@smthrs/targets"

const standard = BuildAndCheckTypeScriptPackage({ cwd: "packages/smithers/build" })

const lib = standard.lib
const check = standard.check
const fmt = standard.fmt
const docs = standard.docs
const circular = standard.circular

/**
 * The package's documentation as a file group (`docs/**`, the README, and
 * package.json), exported so the docs-site content sync in
 * `apps/docs/build/PACKAGE.ts` depends on it by label.
 */
const docsFiles = standard.docsFiles

/**
 * The package lint, over the same trees as the package's `lint` script.
 *
 * `standard.lint` names `src/**` alone, which is right for a package whose
 * flat config covers nothing else. This package's `eslint.config.js` also
 * configures `test/**` and the JavaScript self-hosted cache service, and its
 * `lint` script runs ESLint over both. The generated CI invokes the graph,
 * not the script, so a lint target narrower than the script silently dropped
 * the suite and the service from the required lane. `infra/` is linted by
 * the `@smthrs/build-infra` package that owns it. The root invariants module
 * the config imports is key material beside the JSDoc convention.
 */
const lint = Smithers.EsLint({
  sources: [
    Smithers.glob("src/**/*.ts"),
    Smithers.glob("test/**/*.ts"),
    Smithers.glob("terraform/modules/cache/service/**/*.js")
  ],
  deps: [],
  configs: [
    Smithers.file("eslint.config.js"),
    Smithers.file("//eslint.jsdoc.js"),
    Smithers.file("//eslint.invariants.js")
  ],
  maxWarnings: 0,
  fix: false,
  cwd: "packages/smithers/build"
})

/**
 * The package suite, with every file its suites read declared as key
 * material.
 *
 * `BuildAndCheckTypeScriptPackage.test` knows only `src/` and `test/`.
 * `Docs.test.ts` also reads the package's Markdown, the deployment module and
 * manifest under `infra/`, the self-hosted credential configuration, and
 * sources of the sibling `build-cli` and `targets` packages that its prose
 * contracts quote. `CacheProtocolParity.test.ts` reads both protocol
 * implementations at module load. Leaving any of those undeclared let a
 * cached test result survive a contradictory edit, so this target is the
 * standard Vitest declaration with that complete read set, and
 * `test/PackageTargets.test.ts` holds it to the literal reads in the suites.
 *
 * A glob stops at a package boundary, so the sibling packages' sources are
 * named file by file with workspace-rooted paths. `Docs.test.ts` also walks
 * the sibling packages' Markdown for one recipe check; those files belong to
 * the siblings' own `docsFiles` targets and are outside this declaration.
 */
const test = Smithers.Vitest({
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [
    Smithers.glob("src/**/*.ts"),
    Smithers.file("package.json"),
    Smithers.file("README.md"),
    Smithers.file("DESIGN.md"),
    Smithers.file("WIRING.md"),
    Smithers.file("API-REVIEW.md"),
    Smithers.file("CHANGELOG.md"),
    Smithers.glob("docs/**/*.md"),
    Smithers.glob("infra/**/*.md"),
    Smithers.file("infra/alchemy.run.ts"),
    Smithers.file("infra/deployment.ts"),
    Smithers.file("infra/package.json"),
    Smithers.file("infra/worker/protocol.ts"),
    Smithers.file("terraform/modules/cache/service/config.js"),
    Smithers.file("terraform/modules/cache/service/protocol.js"),
    Smithers.file("//packages/smithers/build/build-cli/src/Cli.ts"),
    Smithers.file("//packages/smithers/build/build-cli/src/PackageLoader.ts"),
    Smithers.file("//packages/smithers/build/build-cli/src/TargetExecution.ts"),
    Smithers.file("//packages/smithers/build/targets/src/ChangesetsTarget.ts"),
    Smithers.file("//packages/smithers/build/targets/src/ExecSandbox.ts"),
    Smithers.file("//packages/smithers/build/targets/src/Target.ts")
  ],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd: "packages/smithers/build"
})

/**
 * Runs the self-hosted cache service's suite.
 *
 * `standard.test` is a Vitest target over `test/**` and `vitest.config.ts`
 * says so, so nothing ran the five suites beside
 * `terraform/modules/cache/service`: a 965-line protocol, a 409-line Postgres
 * translation, and its configuration contract were gated by no target at all,
 * and the repository invariant is that a gate becomes a target in the package
 * that owns it before CI can run it.
 *
 * It runs under Bun rather than the declared Node runtime because the service
 * is a Bun program: it hashes with `Bun.CryptoHasher` and its suites import
 * `bun:test`. The suite also runs the conformance corpus against
 * `infra/worker/protocol.ts`, which is why that file is an input. Nothing here
 * needs a database or a listener. `postgres_test.js`
 * is discovered too and guards itself with
 * `describe.skipIf(!process.env.SMITHERS_CACHE_TEST_DATABASE_URL)`, so it
 * skips here; `cacheServicePostgres` is the target that runs it. It still
 * reads the migration at module load, before the skip, so the migration is
 * an input here as well.
 *
 * @since 0.1.0
 * @category test
 */
const cacheService = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["terraform/modules/cache/service/test"]),
  srcs: [
    Smithers.glob("//packages/smithers/build/terraform/modules/cache/service/*.js"),
    Smithers.glob("//packages/smithers/build/terraform/modules/cache/service/test/*.js"),
    Smithers.file("//packages/smithers/build/terraform/modules/cache/migrations/0001_initial.sql"),
    Smithers.file("//packages/smithers/build/infra/worker/protocol.ts")
  ],
  deps: [],
  cwd: "packages/smithers/build"
})

/**
 * A throwaway Postgres for the self-hosted cache's integration seam.
 *
 * The image is pinned by digest so the engine the gate proves the SQL
 * against is one release, not whatever `postgres:17` resolves to on the day.
 * The port publishes on loopback only, on a port the manual recipe in
 * `docs/workspace/remote-caching.md` does not use, so a developer's own
 * container and this one never contend. Readiness is `pg_isready` over TCP:
 * the entrypoint's initdb phase runs a temporary server on the Unix socket
 * and `pg_isready` without `-h` would report that one ready, then lose it
 * when the real server starts.
 *
 * @since 0.1.0
 * @category test
 */
const cacheServicePostgresDatabase = Smithers.Docker.Service({
  image: "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
  env: { POSTGRES_PASSWORD: "smithers-build-cache-test", POSTGRES_DB: "smithers_build_cache_test" },
  ports: { "5432": 55434 },
  readiness: {
    exec: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "smithers_build_cache_test"],
    timeout: "120s"
  },
  stop: { signal: "SIGTERM", grace: "10s" }
})

/**
 * Runs `postgres_test.js` against a real Postgres.
 *
 * The other service suites drive `storage.js` through fakes that dispatch on
 * statement text and never parse SQL, so they cannot say whether
 * `FOR NO KEY UPDATE`, the `FOR KEY SHARE` reference CTE, the array
 * membership casts, or the two `SKIP LOCKED` release functions are
 * statements Postgres accepts. `postgres_test.js` is the one suite that
 * does, and it skips itself unless `SMITHERS_CACHE_TEST_DATABASE_URL` names
 * a database. Nothing set that variable in any target or workflow, so a
 * syntax error in `storage.js` passed every automated gate and would have
 * surfaced first in a deployed cache. This target supplies the database as
 * a declared service and the URL as the consumer's environment, so the
 * suite runs under `smithers-build test` and in the CI lane that invokes it.
 *
 * The migration, the storage module, and the suite are the read set; the
 * Bun runs from the workspace root, as every `Shell` declaration
 * does. The sandbox opens loopback alone, which is where the published port
 * is.
 *
 * @since 0.1.0
 * @category test
 */
const cacheServicePostgres = Smithers.Shell.Test({
  // This target intentionally runs Bun's test runner. `Runtime.bin` names
  // the workspace runtime (Node in CI), which treats `test` as a script path.
  bin: Smithers.Host.bin("bun"),
  args: ["test", "packages/smithers/build/terraform/modules/cache/service/test/postgres_test.js"],
  // The required Linux lane owns this Docker-backed integration. The hosted
  // macOS runner has no Docker daemon, and Windows cannot run this Linux image.
  hosts: ["linux"],
  env: {
    SMITHERS_CACHE_TEST_DATABASE_URL:
      "postgres://postgres:smithers-build-cache-test@127.0.0.1:55434/smithers_build_cache_test"
  },
  data: [
    Smithers.file("terraform/modules/cache/migrations/0001_initial.sql"),
    Smithers.file("terraform/modules/cache/service/storage.js"),
    Smithers.file("terraform/modules/cache/service/test/postgres_test.js")
  ],
  services: [cacheServicePostgresDatabase],
  sandbox: { network: "loopback" },
  timeout: "10m"
})

/**
 * The manifest fields every package in this workspace shares.
 *
 * Scripts here are literal commands: a template is workspace wide and cannot
 * name one package's targets. A package binds its own targets in its own
 * `scripts`, where the command is derived from the resolved label.
 */
export const template = Smithers.PackageJsonTemplate.make({
  type: "module",
  license: "MIT",
  author: "Smithers",
  sideEffects: [],
  engines: { node: ">=26.4.0" },
  scripts: Smithers.PackageJsonTemplate.standardScripts
})

/**
 * Standard package defaults.
 *
 * A directory under `packages/`, at any of the three nesting depths, with a
 * `package.json` and no `PACKAGE.ts` gets
 * the six conventional targets plus `packageJsonCheck`, `packageJsonWrite`,
 * and `packageJsonRefresh`. `packageJsonCheck` runs under `lint` and `ci`; the
 * two writing targets run under `run` alone.
 */
export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/{*,*/*,*/*/*}",
  marker: "package.json",
  macro: (attrs: { readonly cwd: string }) => {
    const standard = BuildAndCheckTypeScriptPackage({ deps: [], cwd: attrs.cwd })
    return {
      ...standard,
      packageJson: Smithers.PackageJson({
        name: `@smthrs/${attrs.cwd.split("/").at(-1) ?? attrs.cwd}`,
        version: "0.1.0",
        template,
        scripts: { build: standard.lib, lint: standard.lint },
        publish: { entry: standard.lib }
      })
    }
  }
})

/**
 * Scaffolds a new workspace package.
 *
 * ```sh
 * smithers-build run //:newPackage --name @smthrs/widget
 * ```
 */
const newPackage = Smithers.NewPackage({
  directory: "packages",
  version: "0.1.0",
  license: "MIT",
  fields: template.fields,
  tsconfigExtends: "../../../tsconfig.json"
})

export const Package = Smithers.Package({
  targets: {
    cacheService,
    cacheServicePostgres,
    cacheServicePostgresDatabase,
    check,
    circular,
    docs,
    docsFiles,
    fmt,
    lib,
    lint,
    newPackage,
    test
  }
})
