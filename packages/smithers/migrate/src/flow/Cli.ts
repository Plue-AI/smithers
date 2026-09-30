/**
 * The `smithers-migrate` command: its flags, its handler, and the program the
 * executable runs.
 *
 * It exists because the tool has to run inside a project that does not have
 * Smithers 1.0 yet: `npx @smthrs/migrate` is the first command an operator
 * types, before `@smthrs/cli` is anywhere near the tree. The 1.0 CLI exposes
 * the same migration as `smthrs migrate`; an application-owned durable host
 * invokes `Command.launch` after surveying the project.
 *
 * The default mode is `plan`. Editing is never the default: `--apply` is a
 * thing the operator types after reading `report.md`.
 *
 * The command lives here and not in `bin.ts` so a test can run it in process
 * with an argument list: `bin.ts` is the three lines that hand {@link main} to
 * the Node runtime when the module is evaluated, which is exactly the side
 * effect a test must not import.
 *
 * @since 1.0.0-rc.0
 */

import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { Command, Flag } from "effect/unstable/cli"
import type { MigrateError } from "../MigrateError.ts"
import * as CommandModule from "./Command.ts"

const optional = <A>(value: { readonly _tag: "Some"; readonly value: A } | { readonly _tag: "None" }): A | undefined =>
  value._tag === "Some" ? value.value : undefined

const flags = {
  root: Flag.String("root").pipe(Flag.optional),
  scan: Flag.Boolean("scan").pipe(Flag.withDefault(false)),
  apply: Flag.Boolean("apply").pipe(Flag.withDefault(false)),
  seat: Flag.String("seat").pipe(Flag.optional),
  allowUnsafe: Flag.String("allow-unsafe").pipe(Flag.optional),
  acknowledgeRunState: Flag.Boolean("acknowledge-run-state").pipe(Flag.withDefault(false)),
  allowNoVcs: Flag.Boolean("allow-no-vcs").pipe(Flag.withDefault(false)),
  keepOldSources: Flag.Boolean("keep-old-sources").pipe(Flag.withDefault(false)),
  unit: Flag.String("unit").pipe(Flag.optional),
  maxRepairRounds: Flag.Int("max-repair-rounds").pipe(Flag.optional),
  reportDir: Flag.String("report-dir").pipe(Flag.optional),
  flowsDir: Flag.String("flows-dir").pipe(Flag.optional),
  // What the project really runs to verify itself. The detection ladder reads
  // the manifests and the lockfile and is right about most projects; these are
  // for the rest. The orchestrator verifies each rewrite with these commands.
  // Agents cannot run a shell or bypass the configured verification.
  verifyInstall: Flag.String("verify-install").pipe(
    Flag.withDescription("The command that installs dependencies, instead of the one the lockfile implies"),
    Flag.optional
  ),
  verifyFormat: Flag.String("verify-format").pipe(
    Flag.withDescription("The command that formats the project, instead of the one its config implies"),
    Flag.optional
  ),
  verifyTypecheck: Flag.String("verify-typecheck").pipe(
    Flag.withDescription(
      "The command that typechecks the project, repeatable; one empty value runs no typecheck at all"
    ),
    Flag.atLeast(0)
  ),
  verifyTest: Flag.String("verify-test").pipe(
    Flag.withDescription("The command that runs the tests, instead of the project's own test script"),
    Flag.optional
  ),
  json: Flag.Boolean("json").pipe(Flag.withDefault(false))
}

/**
 * The version `smithers-migrate --version` prints and every report records
 * as its tool version. It is the package's own release version; the release
 * bump rewrites it through `scripts/set-release-version.mjs`, and
 * `test/flow/Dependencies.test.ts` pins it to `package.json`.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const version = "1.0.0-rc.1"

/**
 * The command: one migration, one report, one exit code.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const command = Command.make("smithers-migrate", flags, (config) =>
  Effect.gen(function*() {
    const options = CommandModule.optionsOf(
      {
        root: optional(config.root),
        scan: config.scan,
        apply: config.apply,
        seat: optional(config.seat),
        allowUnsafe: optional(config.allowUnsafe),
        acknowledgeRunState: config.acknowledgeRunState,
        allowNoVcs: config.allowNoVcs,
        keepOldSources: config.keepOldSources,
        unit: optional(config.unit),
        maxRepairRounds: optional(config.maxRepairRounds),
        reportDir: optional(config.reportDir),
        flowsDir: optional(config.flowsDir),
        verifyInstall: optional(config.verifyInstall),
        verifyFormat: optional(config.verifyFormat),
        verifyTypecheck: config.verifyTypecheck,
        verifyTest: optional(config.verifyTest)
      },
      process.cwd(),
      process.env
    )
    const outcome = yield* Effect.result(CommandModule.runNode(options, { environment: process.env }))
    if (outcome._tag === "Failure") {
      const error: MigrateError = outcome.failure
      // A refused gate is not a crash, and neither is a second apply finding
      // the first one's lock. Both print the operator's own instructions,
      // exit 3, and leave the project untouched.
      yield* Console.error(
        `smthrs migrate: ${error.message}${error.details === undefined ? "" : `\n${error.details}`}`
      )
      process.exitCode = error.code === "run-state-blocked" || error.code === "unsafe-blocked" ||
          error.code === "apply-in-progress"
        ? 3
        : 1
      return
    }
    const report = outcome.success
    yield* Console.log(
      CommandModule.render(report, config.json ? "json" : "human", CommandModule.reportDirectory(options))
    )
    process.exitCode = CommandModule.exitCode(report)
  })).pipe(
    Command.withDescription("Upgrade a Smithers 0.x project to Smithers 1.0 flows and write an auditable report")
  )

/**
 * The executable's entry point.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const main = Command.run(command, { version }).pipe(
  Effect.provide(NodeServices.layer)
)
