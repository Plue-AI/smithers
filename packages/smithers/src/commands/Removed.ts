/**
 * The removed-command contract refusals, as Effect CLI wiring.
 *
 * Every removed verb is a hidden subcommand that exits 1 with its reason, and
 * every removed flag is a hidden flag whose presence is a refusal.
 *
 * @since 1.0.0
 */

import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import type * as CliError from "../CliError.ts"
import * as Unsupported from "../Unsupported.ts"

/**
 * Removed verbs that are registered by hand instead of by `commands`,
 * because `workflow list` is the `ls` alias.
 */
const ownGroupCommands = new Set(["workflow"])

/**
 * One removed verb by name, so a handler cannot cite the wrong entry.
 * @category getters
 * @since 1.0.0
 */
export const verb = (name: string): Unsupported.RemovedVerb =>
  Unsupported.removedVerbs.find((verb) => verb.name === name)!

/**
 * A hidden boolean flag whose presence is a refusal.
 * @category constructors
 * @since 1.0.0
 */
export const flag = (_parent: string, name: string) => Flag.Boolean(name).pipe(Flag.withDefault(false), Flag.withHidden)

/**
 * A hidden value flag whose presence is a refusal.
 * @category constructors
 * @since 1.0.0
 */
export const valueFlag = (name: string) => Flag.String(name).pipe(Flag.optional, Flag.withHidden)

/**
 * Fails when a removed flag was passed.
 *
 * Taking the whole flag record and the names to check keeps the refusal in one
 * place: a handler that forgot one would accept a flag the contract removed.
 * @category constructors
 * @since 1.0.0
 */
export const refuse = (
  parent: string,
  passed: Readonly<Record<string, boolean | Option.Option<string>>>
): Effect.Effect<void, CliError.UnsupportedError> => {
  for (const [name, value] of Object.entries(passed)) {
    const present = typeof value === "boolean" ? value : Option.isSome(value)
    if (present) return Effect.fail(Unsupported.flagError(Unsupported.findFlag(parent, name)))
  }
  return Effect.void
}

/**
 * Every removed verb, as a hidden subcommand that exits 1 with its reason.
 *
 * `workflows` is registered here under its own spelling like the rest. The
 * singular `workflow` is a separate command group, because `workflow list`
 * survives as the `ls` alias, and it refuses on its own with the same reason.
 * @category constructors
 * @since 1.0.0
 */
export const commands = Unsupported.removedVerbs
  .filter((verb) => !ownGroupCommands.has(verb.name))
  .map((verb) =>
    Command.make(
      verb.name,
      { rest: Argument.String("argument").pipe(Argument.variadic()) },
      (config) => Effect.fail(Unsupported.verbError(verb, verb.subcommands === undefined ? undefined : config.rest[0]))
    ).pipe(
      Command.withDescription(`Removed in 1.0.0-rc.0: ${verb.reason}`),
      Command.unlisted
    )
  )
