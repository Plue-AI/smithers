/**
 * A Trellis whose generated work inherits one memory policy.
 *
 * `Trellis.make` declares the topology a model-authored plan fits inside. The
 * leaf slots that topology reserves are filled at run time, so the goals a leaf
 * runs are not known at declaration time and cannot each be handed a namespace.
 * The policy is attached to the flows instead: the author and the leaf carry it,
 * and so does every memory flow they declare, which is where the memory
 * bindings in `./Flows.ts` read it back from.
 *
 * An annotation takes no part in flow identity, so the graph a memory trellis
 * plans is the graph the plain trellis plans, node for node. See
 * https://memory.smithers.sh/reference/api/.
 *
 * @since 0.1.0
 */

import type * as Flow from "@smthrs/core/Flow"
import * as Trellis from "@smthrs/patterns/Trellis"
import type * as WithMemoryModule from "./WithMemory.ts"
import { withMemory } from "./WithMemory.ts"

/**
 * Configuration for {@link make}: everything `Trellis.make` accepts plus the
 * memory policy the authored plan runs under.
 *
 * `Trellis.make` takes its author and its leaf as `Member`, which states only
 * a name and a way to record a call. A policy is an annotation, so a memory
 * trellis asks for the wider thing a `@smthrs/core` signature is: the author
 * and the leaf here are declarations that carry an annotation bag and the
 * collaborator list the policy is inherited through.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions extends Omit<Trellis.MakeOptions, "author" | "leaf"> {
  readonly author: Flow.Any
  readonly leaf: Flow.Any
  readonly memory: WithMemoryModule.Policy
}

/**
 * The author and leaf flows a memory trellis calls, each carrying the policy.
 *
 * Hold these when you drive the plan yourself with `Trellis.run`: the flows
 * `make` composes are these, and calling the originals instead loses the
 * policy.
 *
 * @category introspection
 * @since 0.1.0
 */
export interface Parts {
  readonly author: Flow.Any
  readonly leaf: Flow.Any
}

/**
 * Applies the policy to the author and the leaf without composing them.
 *
 * @category constructors
 * @since 0.1.0
 */
export const parts = (options: MakeOptions): Parts => ({
  author: withMemory(options.author, options.memory),
  leaf: withMemory(options.leaf, options.memory)
})

/**
 * Declares a trellis whose author, leaves, and the memory flows those declare
 * all run under one memory policy.
 *
 * The answer is the `@smthrs/flow` flow `Trellis.make` states, carrying the
 * policy annotation. Its requirement channel is `unknown` because the author
 * and the leaf arrive as the existential {@link Flow.Any}, which states an
 * obligation it cannot name; run the plan a model authors with `Trellis.run`
 * over {@link parts}, which holds both flows with their own types.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Trellis.TrellisFlow<unknown> =>
  withMemory(
    Trellis.make({
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.description === undefined ? {} : { description: options.description }),
      ...parts(options),
      envelope: options.envelope
    }),
    options.memory
  )
