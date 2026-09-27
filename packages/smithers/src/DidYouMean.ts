/**
 * The one line an unknown command earns, decided by Jev.
 *
 * A command the parser does not know is a closed question: the answer is one
 * of the commands the canonical Incur tree serves, or none of them. So it is
 * asked as a classifier `choice` over that tree, each option described by the
 * same line `--help` prints, rather than measured by a string distance that
 * knows nothing about what the commands do. The options are read from the
 * tree itself, so a hidden transition alias is never one of them. A removed
 * verb is never asked about: it has its own migration sentence in
 * {@link Unsupported}.
 *
 * There is no fallback. Below {@link floor} the suggestion is withheld, and a
 * transport that cannot answer says so by name, because a guess an operator
 * cannot tell from an answer is worse than no line at all.
 *
 * @since 1.0.0
 */

import * as Classifier from "@smthrs/model/Classifier"
import type * as Evaluator from "@smthrs/model/Evaluator"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Cli } from "incur"
import * as Unsupported from "./Unsupported.ts"

/** The option that means no command is what the person typed. */
const none = "none"

/** The confidence a suggestion reaches before an operator is shown it. */
const floor = 0.7

/**
 * One command the canonical tree serves: its full path and its help line.
 *
 * @category models
 * @since 1.0.0
 */
export interface Command {
  readonly name: string
  readonly description: string
}

interface Entry {
  readonly _alias?: true
  readonly _fetch?: true
  readonly _group?: true
  readonly description?: string | undefined
  readonly root?: { readonly description?: string | undefined } | undefined
  readonly commands?: ReadonlyMap<string, Entry>
}

/**
 * Every command `cli` serves, by the path `--help` prints, aliases excluded.
 *
 * A group is a command only when it has a root handler of its own.
 *
 * @category getters
 * @since 1.0.0
 */
export const commands = (cli: Cli.Cli<any, any, any, any>): ReadonlyArray<Command> => {
  const found: Array<Command> = []
  const walk = (entries: ReadonlyMap<string, Entry>, prefix: string): void => {
    for (const [name, entry] of entries) {
      if (entry._alias === true) continue
      const path = prefix === "" ? name : `${prefix} ${name}`
      if (entry._group === true) {
        if (entry.root !== undefined) found.push({ name: path, description: entry.root.description ?? "" })
        walk(entry.commands ?? new Map(), path)
      } else {
        found.push({ name: path, description: entry.description ?? "" })
      }
    }
  }
  walk((Cli.toCommands.get(cli as never) ?? new Map()) as ReadonlyMap<string, Entry>, "")
  return found
}

const meant = (candidates: ReadonlyArray<Command>) =>
  Classifier.make("cli/did-you-mean", {
    description:
      "Judge one unknown command line against the commands smthrs serves: which one, if any, the person meant.",
    state: Schema.Struct({
      typed: Schema.String.annotate({ description: "The command the person typed, which the parser refused" }),
      args: Schema.String.annotate({ description: "The rest of the command line, as they typed it" })
    }),
    // Jev permits 255 options per question; include none in every partition.
    // One request still evaluates the entire public command tree.
    questions: Object.fromEntries(Array.from({ length: Math.ceil(candidates.length / 254) }, (_, index) => [
      index === 0 ? "meant" : `meant${index + 1}`,
      Classifier.choice({
        instructions: "Which command did the person mean? Choose none if it is outside these options.",
        criteria: {
          ...Object.fromEntries(
            candidates.slice(index * 254, (index + 1) * 254).map((command) => [command.name, command.description])
          ),
          [none]: "No command is what they meant"
        }
      })
    ]))
  })

/**
 * The suggestion line for a typed command, or `undefined` when there is none
 * to give.
 *
 * `candidates` is the tree {@link commands} reads. The line is appended to
 * the refusal the parser already prints; it never changes the exit code and
 * never runs the command it names.
 *
 * @category getters
 * @since 1.0.0
 */
export const didYouMean = (
  typed: string,
  args: ReadonlyArray<string>,
  candidates: ReadonlyArray<Command>
): Effect.Effect<string | undefined, never, Evaluator.Evaluator> => {
  if (
    candidates.some((command) => command.name === typed) ||
    Unsupported.removedVerbs.some((verb) => verb.name === typed)
  ) {
    return Effect.succeed(undefined)
  }
  return meant(candidates).evaluate({ typed, args: args.join(" ") }).pipe(
    Effect.map((answers) => {
      const matches = Object.values(answers).filter((answer) => answer.value !== none && answer.confidence >= floor)
        .sort((left, right) => right.confidence - left.confidence)
      const first = matches[0]
      return first === undefined || first.confidence === matches[1]?.confidence
        ? undefined :
        `Did you mean: smthrs ${first.value}?`
    }),
    Effect.catch((error) => Effect.succeed(`Could not ask Jev for a suggestion: ${error.code}`))
  )
}
