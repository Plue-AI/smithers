import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { ReviewTagsMigrationsAndKeys } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  testProgram: Smithers.file("//packages/smithers/flows/database/scripts/test-matrix.mjs"),
  deps: [],
  cwd: "packages/smithers/flows/database",
  tests: Smithers.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] }),
  buildProgram: Smithers.file("//packages/repo-targets/scripts/build.mjs"),
  circularScript: Smithers.file("//packages/repo-targets/scripts/circular.mjs"),
  eslintConfigs: [
    Smithers.file("eslint.config.js"),
    Smithers.file("//eslint.package.js"),
    Smithers.file("//eslint.jsdoc.js"),
    Smithers.file("//eslint.invariants.js")
  ]
})

/**
 * The durable-identity review: identity strings, migrations, persisted
 * schemas, and durable keys, read out of this package's own changed sources.
 *
 * @since 0.1.0
 * @category lint
 */
const reviewTagsMigrationsAndKeys = ReviewTagsMigrationsAndKeys({ cwd: "packages/smithers/flows/database" })

/**
 * The package's fault-injection cases.
 *
 * A package opts into the matrix by declaring this key, so
 * `//packages/...:faults` is the whole matrix and nothing central lists which
 * packages are in it. The tier is separate from `test` because its cases are
 * machine-global — they kill process groups, bind ephemeral ports, and read
 * the process table — so they run serially, without coverage, from
 * `vitest.faults.config.ts`.
 */
const faults = Smithers.FaultSuite({ cwd: "packages/smithers/flows/database" })

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, reviewTagsMigrationsAndKeys, faults, fmt, lib, lint, test }
})
