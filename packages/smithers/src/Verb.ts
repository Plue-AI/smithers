/**
 * The retained Effect CLI handlers in `smthrs` 1.0.0-rc.0.
 *
 * At the import reference this module projected `SystemFlows.catalog`
 * directly, so eleven verbs existed only as bodiless reserved flows that
 * planned and exited 0. The CLI contract forbids that partial
 * appearance: a verb either ships with a handler (the shipped-command contract, {@link shipped})
 * or is removed and says so (the removed-command contract, `Unsupported.removedVerbs`).
 *
 * This table is the authority for those handlers, and `test/Verb.test.ts` pins
 * it. `Cli.makeCli` registers the canonical public Incur command tree, including
 * target commands and the `flow`, `runs`, and `approvals` groups. The reserved
 * flow ids that survive are still named here so a catalog change cannot
 * silently desynchronise the compatibility handlers and the control catalog.
 *
 * @since 1.0.0
 */

import { SystemFlows } from "@smthrs/control"

/**
 * One retained Effect CLI command in rc.0.
 *
 * `aliases` are alternate spellings accepted by the parser. They are hidden
 * from `--help`, because help lists the canonical surface; the alias set is
 * pinned by the tests instead.
 *
 * @category models
 * @since 1.0.0
 */
export interface Verb {
  readonly name: string
  readonly help: string
  readonly aliases: ReadonlyArray<string>
  /** The reserved system-flow id, for the verbs the control catalog reserves. */
  readonly flowId?: `system/${string}` | undefined
  /**
   * Whether `effect/unstable/cli` provides this one itself. `completions` is a
   * built-in global flag (`--completions <shell>`), not a subcommand, so it is
   * part of the shipped surface without being part of the command tree.
   */
  readonly builtin?: boolean | undefined
  /**
   * Whether this verb can start or resume a run, and therefore reaches a
   * completion a judge has to rule on.
   *
   * Only five do: `run` (with its `resume` alias), `up`, `approve`, `deny`,
   * and `serve`. A decision restarts the run it answers on this process's own
   * executor, and `serve` hosts a gateway and a trigger scheduler that both
   * launch runs, so every one of the five drives a run here. Everything else
   * reads, records, or ends: `ls`, `ps`, `status`, `logs` and `output` only
   * read; `plan` compiles a payload and hands it back without a launch;
   * `cancel`, `down`, `signal` and `steer` write a durable request that the
   * process driving the run picks up; `gc`, `memory`, `update`, `bug`, `init`
   * and `doctor` never touch a run at all.
   *
   * {@link startsRuns} reads it, and only the composition boundary needs it:
   * a verb that cannot reach a completion must not be refused for want of a
   * completion judge.
   */
  readonly startsRuns: boolean
}

const catalogFlowId = (name: string): `system/${string}` | undefined =>
  SystemFlows.catalog.find((entry) => entry.verb === name)?.flowId

const verb = (name: string, help: string, aliases: ReadonlyArray<string> = []): Verb => {
  const flowId = catalogFlowId(name)
  return { name, help, aliases, startsRuns: false, ...(flowId === undefined ? {} : { flowId }) }
}

/** One verb that starts or resumes a run; see {@link Verb.startsRuns}. */
const driver = (name: string, help: string, aliases: ReadonlyArray<string> = []): Verb => ({
  ...verb(name, help, aliases),
  startsRuns: true
})

/**
 * Every retained Effect CLI command in rc.0.
 *
 * @category constants
 * @since 1.0.0
 */
export const shipped: ReadonlyArray<Verb> = [
  verb("plan", "Render a flow plan and its complete approval payload"),
  driver("run", "Run an approved plan payload, or resume a parked run", ["resume"]),
  driver("up", "Plan, approve, and run one flow; -d launches it detached"),
  driver("approve", "Approve the complete serialized approval payload"),
  driver("deny", "Deny the complete serialized approval payload"),
  verb("cancel", "Cancel a durable run"),
  verb("signal", "Deliver a durable JSON signal to a run"),
  verb("steer", "Send a durable, attributed steering message to a run"),
  verb("ls", "List the flows discovered under this project", ["workflow list"]),
  verb("ps", "List durable runs"),
  verb("status", "Show the diagnosis card for one run, or the run listing", ["inspect", "why"]),
  verb("logs", "Read run events; --follow streams future events", ["events"]),
  verb("output", "Print one registered node output"),
  verb("down", "Cancel every non-terminal run"),
  driver("serve", "Host the control server for this project", ["gateway"]),
  verb("init", "Scaffold flows/<name>/flow.mdx and ignore .flows/"),
  verb("suggest", "Read the project, stream how Smithers can help, and implement the one you pick"),
  verb("doctor", "Report registry, database, runtime, and provider readiness"),
  verb("migrate", "Convert a Smithers 0.x project to the 1.0 authoring model"),
  // No compaction: `Journal.compact` refuses a run the fence still owns, and
  // a terminal run's fence is exactly what retention deletes, so the two run
  // in the wrong order to be one pass. The contract's the shipped-command contract wording is
  // the thing that has to change; this verb says what it does.
  verb("gc", "Delete terminal runs older than a threshold, with the rows and artifacts they own"),
  verb("memory", "Read and write namespaced facts in the control database"),
  verb("claude", "Claude Code plugin mirror protocol"),
  verb("mcp", "Wire the Smithers MCP server into an agent"),
  verb("update", "Check npm for a newer @smthrs/cli"),
  verb("bug", "Preview a redacted bug report; post with --yes or TTY confirmation, or inspect with --dry-run"),
  { ...verb("completions", "Print a shell completion script"), builtin: true }
]

/**
 * The verbs that are subcommands of the command tree, which is every shipped
 * verb except the ones `effect/unstable/cli` provides as built-in flags.
 *
 * @category constants
 * @since 1.0.0
 */
export const subcommands: ReadonlyArray<Verb> = shipped.filter((entry) => entry.builtin !== true)

/**
 * Every shipped command name.
 *
 * @category constants
 * @since 1.0.0
 */
export const names: ReadonlyArray<string> = shipped.map((entry) => entry.name)

/**
 * Finds one shipped verb by name.
 *
 * @category getters
 * @since 1.0.0
 */
export const find = (name: string): Verb | undefined => shipped.find((entry) => entry.name === name)

/**
 * Finds the shipped verb one command line selects, by canonical name or by any
 * alias, including the two-word `workflow list`.
 *
 * Pass the words a command line left after the shared globals
 * (`Argv.words`). Only the first one, or the first two together, can name a
 * verb, so a flow or run id spelled like a verb cannot shadow the real one.
 *
 * @category getters
 * @since 1.0.0
 */
export const select = (words: ReadonlyArray<string>): Verb | undefined => {
  const [first, second] = words
  if (first === undefined) return undefined
  const pair = second === undefined ? undefined : `${first} ${second}`
  return shipped.find((entry) =>
    entry.name === first ||
    entry.aliases.includes(first) ||
    (pair !== undefined && entry.aliases.includes(pair))
  )
}

/**
 * Whether one command line can start or resume a run.
 *
 * A host answers `true` by composing the run executor, which needs a
 * completion judge before it opens anything; `false` composes a host that
 * observes runs and drives none, so it opens with no gateway key at all.
 *
 * A word this catalog does not know answers `true`. The unsafe direction is
 * calling a launch a read: that host would admit a run it cannot judge and
 * lose it at the first completion. Calling a read a launch only brings back
 * the refusal, which is visible the moment anyone runs the verb.
 *
 * @category getters
 * @since 1.0.0
 */
export const startsRuns = (words: ReadonlyArray<string>): boolean => select(words)?.startsRuns ?? true
