/**
 * Keeps a bound language server in step with the files the mutation flows
 * write, and reads back the errors an edit leaves.
 *
 * The server is optional: a host that binds no `LanguageServer` edits files
 * exactly as before, and a server that fails or times out never fails the
 * write that already happened.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as LanguageServer from "../LanguageServer.ts"

/**
 * Most errors attached to one result.
 *
 * @category internal
 * @since 1.0.0
 */
export const MAX_ERRORS = 20

/**
 * One error-severity diagnostic, at its 1-based position.
 *
 * @category internal
 * @since 1.0.0
 */
export const Problem = Schema.Struct({
  line: Schema.Number.annotate({ description: "1-based line" }),
  character: Schema.Number.annotate({ description: "1-based character" }),
  message: Schema.String
})

/**
 * A decoded {@link Problem}.
 *
 * @category internal
 * @since 1.0.0
 */
export type Problem = typeof Problem.Type

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined

/**
 * The error-severity items of a document diagnostic report, 1-based.
 *
 * @category internal
 * @since 1.0.0
 */
export const errors = (report: unknown): ReadonlyArray<Problem> => {
  const items = record(report)?.items
  if (!Array.isArray(items)) return []
  const found: Array<Problem> = []
  for (const item of items) {
    const diagnostic = record(item)
    const start = record(record(diagnostic?.range)?.start)
    if (
      diagnostic?.severity !== 1 || typeof diagnostic.message !== "string" ||
      typeof start?.line !== "number" || typeof start.character !== "number"
    ) continue
    found.push({ line: start.line + 1, character: start.character + 1, message: diagnostic.message })
    if (found.length === MAX_ERRORS) break
  }
  return found
}

/**
 * Sends a written file's new text to the bound server, if any. Succeeds with
 * the server that took it.
 *
 * @category internal
 * @since 1.0.0
 */
export const sync = (path: string, text: string): Effect.Effect<LanguageServer.LanguageServer | undefined> =>
  Effect.serviceOption(LanguageServer.LanguageServer).pipe(
    Effect.flatMap(Option.match({
      onNone: () => Effect.succeed(undefined),
      onSome: (server) =>
        server.sync(path, text).pipe(
          Effect.as(server),
          Effect.orElseSucceed(() => undefined)
        )
    }))
  )

/**
 * Tells the bound server, if any, that a file is gone.
 *
 * @category internal
 * @since 1.0.0
 */
export const close = (path: string): Effect.Effect<void> =>
  Effect.serviceOption(LanguageServer.LanguageServer).pipe(
    Effect.flatMap(Option.match({
      onNone: () => Effect.void,
      onSome: (server) => server.close(path).pipe(Effect.ignore)
    }))
  )

/**
 * Tells the bound server, if any, to re-read every file it has open, after
 * something other than the mutation flows may have changed them.
 *
 * @category internal
 * @since 1.0.0
 */
export const refresh: Effect.Effect<void> = Effect.serviceOption(LanguageServer.LanguageServer).pipe(
  Effect.flatMap(Option.match({
    onNone: () => Effect.void,
    onSome: (server) => server.refresh.pipe(Effect.ignore)
  }))
)

/**
 * The errors `server` reports for `path`, or `undefined` when it could not
 * answer.
 *
 * @category internal
 * @since 1.0.0
 */
export const errorsOf = (
  server: LanguageServer.LanguageServer,
  path: string
): Effect.Effect<ReadonlyArray<Problem> | undefined> =>
  server.diagnostics(path).pipe(
    Effect.map(errors),
    Effect.orElseSucceed(() => undefined)
  )
