/**
 * The pre-handler every canonical verb owes, whichever entry it arrives through.
 *
 * `Command.ts` reads these values from the Effect CLI's shared flags and the
 * Incur tree reads them from its typed connection options. Both call here, so
 * a notice or refusal cannot depend on which parser a verb was typed into.
 *
 * @since 1.0.0
 */
import * as UnsupportedBackend from "@smthrs/database/UnsupportedBackend"
import { Console, Effect } from "effect"
import * as CliError from "../CliError.ts"
import * as Environment from "../Environment.ts"
import * as Project from "../Project.ts"

/**
 * The shared values a verb is checked against.
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly credential?: string | undefined
  /** The hidden `--backend` flag; the Incur tree never declares it. */
  readonly backend?: string | undefined
  readonly environment?: Environment.Source | undefined
}

const credentialWarning =
  "Warning: --credential exposes secrets in process listings and shell history; SMITHERS_API_KEY is the preferred channel."

const preface = (options: Options) =>
  Effect.gen(function*() {
    if (options.credential !== undefined) yield* Console.error(credentialWarning)
    // A 0.x PostgreSQL or PGlite project still exports its connection strings.
    // rc.0 ignores them and says so, once per invocation, because a silently
    // ignored connection string is how a project ends up running against SQLite
    // while believing it runs against PostgreSQL. A notice, not a refusal: the
    // exit code and the command's result do not move (the runtime
    // names and the sentence are @smthrs/database's, pinned per name in
    // packages/smithers/flows/database/test/UnsupportedBackend.test.ts).
    for (const name of UnsupportedBackend.ignoredNames(options.environment ?? process.env)) {
      process.stderr.write(`${UnsupportedBackend.ignoredNotice(name)}\n`)
    }
  })

/** A digest of one 0.x notice, printed once per invocation. */
const legacyNotice = Effect.gen(function*() {
  // The snapshot, not a fresh walk: this invocation's own control database
  // may have created `<root>/.flows` by now, and `Project.legacyState` reads
  // that directory as proof the project already moved on.
  const found = yield* Project.LegacyState
  const first = found[0]
  if (first === undefined) return
  yield* Effect.sync(() => process.stderr.write(`${Project.legacyNotice(first)}\n`))
})

/**
 * The notices alone, for `doctor`, which reports an unsupported backend as a
 * check instead of refusing before the report exists.
 * @category constructors
 * @since 1.0.0
 */
export const notices = (options: Options): Effect.Effect<void> =>
  Effect.gen(function*() {
    yield* preface(options)
    yield* legacyNotice
  })

/**
 * The notices and the unsupported-backend refusal every other verb applies
 * before it opens durable services.
 * @category constructors
 * @since 1.0.0
 */
export const guard = (options: Options): Effect.Effect<void, CliError.UnsupportedError> =>
  Effect.gen(function*() {
    yield* preface(options)
    const refusal = Environment.unsupportedBackend(options.backend)
    if (refusal !== undefined) return yield* Effect.fail(new CliError.UnsupportedError({ message: refusal }))
    // `SMITHERS_BACKEND` reaches the same refusal: a script that exports the
    // variable must not be told everything is fine because it omitted the flag.
    const fromEnvironment = Environment.unsupportedBackend(
      Environment.read(options.environment ?? process.env, "SMITHERS_BACKEND")
    )
    if (fromEnvironment !== undefined) {
      return yield* Effect.fail(new CliError.UnsupportedError({ message: fromEnvironment }))
    }
    yield* legacyNotice
  })
