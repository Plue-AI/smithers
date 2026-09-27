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
  cwd: "packages/smithers/flows/engine-store"
})

/**
 * The operator's backup, verify, and restore entry point, driven the way an
 * operator drives it: spawned `node scripts/flows-backup.mjs` invocations
 * against a real migrated store. The script wraps `DisasterRecovery`, so it
 * lives beside the module it exercises.
 *
 * @since 0.1.0
 * @category test
 */
const disasterRecovery = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/smithers/flows/engine-store/scripts/flows-backup.test.mjs")]),
  srcs: [
    Smithers.glob("//packages/smithers/flows/engine-store/scripts/flows-backup*.mjs"),
    Smithers.glob("//packages/smithers/flows/engine-store/src/**/*.ts")
  ],
  deps: [],
  cwd: "packages/smithers/flows/engine-store"
})

/**
 * The durable-identity review: identity strings, migrations, persisted
 * schemas, and durable keys, read out of this package's own changed sources.
 *
 * @since 0.1.0
 * @category lint
 */
const reviewTagsMigrationsAndKeys = ReviewTagsMigrationsAndKeys({ cwd: "packages/smithers/flows/engine-store" })

export const Package = Smithers.Package({
  targets: { check, circular, disasterRecovery, docs, docsFiles, reviewTagsMigrationsAndKeys, fmt, lib, lint, test }
})
