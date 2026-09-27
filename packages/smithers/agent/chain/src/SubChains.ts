/**
 * Sub-agents as an ordinary catalog entry — recursion is the primitive.
 *
 * The `agent` entry runs a nested chain under a deterministic child id
 * derived from its call slot (`parent-chain/link.ordinal`), in the same
 * journal: the child's events are scoped by that id, so a re-executed
 * spawning call resumes the child from its own settled events — child
 * chains are incrementally durable for free. A child's `done` and
 * terminal parks settle as data the parent script inspects; a child
 * waiting on approval bubbles as an in-place park so a later grant
 * resumes the child through the same slot. Children run unattended —
 * the chain core never drains steering under a child scope
 * (https://chain.smithers.sh/contract/).
 *
 * Composition invariants: the catalog layer must be built over the SAME
 * journal/author/runner layers the chain runs on (the services are
 * captured at construction), root chain ids must not contain `/` or look
 * like `<digits>.<digits>`, and the reserved names (`agent`, `author`,
 * the system entries) may not appear in the host's entries. Invalid root
 * ids fail Chain.run with ChainError; reserved entries die at construction.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import { Effect, Layer, Schema } from "effect"
import * as Author from "./Author.ts"
import * as AuthorDeclaration from "./AuthorDeclaration.ts"
import * as Catalog from "./Catalog.ts"
import * as Chain from "./Chain.ts"
import { childRun } from "./internal/childRun.ts"
import { ChildRunError } from "./internal/ChildRunError.ts"
import * as Journal from "./Journal.ts"
import * as ScriptRunner from "./ScriptRunner.ts"

/**
 * The catalog name a script spawns a sub-agent by.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const agentName = "agent"

/**
 * The agent entry's description, as the model reads it in the catalog block.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const agentDescription = "Run a sub-agent chain to completion and return its terminal outcome as data"

/**
 * The capability the agent entry claims: spawning a sub-agent is a
 * process-spawn-shaped authority hosts grant deliberately. The child's
 * own calls are gated individually by the same seam.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const agentCapability = "proc:spawn:agent"

/**
 * The nesting bound a catalog inherits when {@link Options.maxDepth} is
 * unset, counted in derived child segments. It is part of the agent entry's
 * contract digest, so changing it re-keys every settled spawn.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultMaxDepth = 4

const AgentInput = Schema.Struct({
  goal: Schema.String,
  context: Schema.optional(Schema.Array(Schema.String))
})

const decodeInput = Schema.decodeUnknownOption(AgentInput)

/**
 * What the recursive catalog needs: the host's own entries, the nesting
 * bound, and the budgets and prefix every child runs under.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  /** Entries every chain in the tree can call; the agent and system entries are appended. */
  readonly entries: ReadonlyArray<Catalog.Entry>
  /** Maximum nesting depth, counted in derived child segments. */
  readonly maxDepth?: number | undefined
  /** Per-child budgets and prefix, independent of the parent's. */
  readonly maxLinks?: number | undefined
  readonly maxCallsPerLink?: number | undefined
  readonly prefix?: string | undefined
}

const reserved: ReadonlyArray<string> = [
  agentName,
  AuthorDeclaration.authorName,
  ...Catalog.system.map((entry) => entry.name)
]

const derivedSegment = /^\d+\.\d+$/

/**
 * The digest of the agent entry's behavior contract: redeclaring the
 * child budgets, prefix, or depth bound re-keys every settled spawn.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const contractDigest = (options: Options): string =>
  Digest.digest(Digest.canonical({
    description: agentDescription,
    maxCallsPerLink: options.maxCallsPerLink ?? null,
    maxDepth: options.maxDepth ?? defaultMaxDepth,
    maxLinks: options.maxLinks ?? null,
    name: agentName,
    prefix: options.prefix ?? null
  }))

/**
 * Builds the recursive catalog: the given entries plus the `agent` entry
 * (whose handler runs a nested chain against this same catalog, so
 * children recurse up to `maxDepth`) and the system entries, which
 * nothing can shadow.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  options: Options
): Effect.Effect<
  Catalog.Service,
  never,
  Journal.Journal | Author.Author | ScriptRunner.ScriptRunner
> =>
  Effect.gen(function*() {
    const shadowed = options.entries.filter((entry) => reserved.includes(entry.name)).map((entry) => entry.name)
    if (shadowed.length > 0) {
      return yield* Effect.die(
        new Error(`entries shadow reserved catalog names: ${shadowed.join(", ")}`)
      )
    }
    // Captured at construction on purpose: a child must run on the very
    // same journal/author/runner the parent chain runs on. Build the
    // catalog layer over those same layers (see the module invariants).
    const journal = yield* Journal.Journal
    const author = yield* Author.Author
    const runner = yield* ScriptRunner.ScriptRunner
    const maxDepth = options.maxDepth ?? defaultMaxDepth

    const agent: Catalog.Entry = {
      capabilities: [agentCapability],
      description: agentDescription,
      digest: contractDigest(options),
      handler: (payload, slot) =>
        Effect.gen(function*() {
          const input = decodeInput(payload)
          if (input._tag === "None") {
            return yield* new Catalog.CallError({
              message: `"${agentName}" takes { goal, context? }`,
              name: agentName
            })
          }
          if (slot === undefined) {
            // Without a slot there is no derivable child identity: two
            // slotless spawns would alias one scope and replay each
            // other's outcomes.
            return yield* new Catalog.CallError({
              message: `"${agentName}" requires a call slot; invoke it through a running chain`,
              name: agentName
            })
          }
          const child = `${slot.chain === "" ? "" : `${slot.chain}/`}${slot.link}.${slot.ordinal}`
          if (child.split("/").filter((segment) => derivedSegment.test(segment)).length > maxDepth) {
            return yield* new Catalog.CallError({
              message: `"${agentName}" refused: nesting deeper than ${maxDepth} chains`,
              name: agentName
            })
          }
          const outcome = yield* Chain.run({
            [childRun]: true,
            chain: child,
            context: input.value.context ?? [],
            goal: input.value.goal,
            maxCallsPerLink: options.maxCallsPerLink,
            maxLinks: options.maxLinks,
            prefix: options.prefix
          }).pipe(
            Effect.provideService(Catalog.Catalog, catalog),
            Effect.provideService(Journal.Journal, journal),
            Effect.provideService(Author.Author, author),
            Effect.provideService(ScriptRunner.ScriptRunner, runner),
            // Only a terminal is data. Preserve run failures as typed,
            // un-settled failures of the parent, with their original cause.
            Effect.mapError((error) => new ChildRunError(error))
          )
          if (outcome._tag === "ApprovalWait") {
            // A child waiting on approval must not settle as data: bubble
            // it as the typed approval cause so the parent parks in place
            // and a later grant resumes the child through this same slot.
            return yield* new Catalog.CallError({
              cause: "approval_required",
              message: outcome.reason.message,
              name: agentName
            })
          }
          return outcome
        }),
      name: agentName
    }

    // The handler above closes over this binding, not a second state
    // holder: `Catalog.make` only snapshots handler references, so the
    // entry can never run before the binding is initialized.
    const catalog: Catalog.Service = Catalog.make(Catalog.withSystem([...options.entries, agent]))
    return catalog
  })

/**
 * The recursive catalog layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (
  options: Options
): Layer.Layer<Catalog.Catalog, never, Journal.Journal | Author.Author | ScriptRunner.ScriptRunner> =>
  Layer.effect(Catalog.Catalog)(make(options))
