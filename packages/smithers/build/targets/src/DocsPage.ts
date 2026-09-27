/**
 * `S.Docs.Page`: one generated documentation page, written by an agent under
 * the `docs` verb.
 *
 * A page is the docs-shaped subset of `Agent.Diff`. The writer reads one
 * `brief` (the human-owned paragraph saying what the page is for), one
 * `prompt` (the page-type instructions), the `references` it may consult,
 * and the `inputs` the page describes, then writes exactly one `output`
 * file. The output path is the whole write-set: a page writer that touches
 * any other path is rejected whole, the same as an `Agent.Diff` candidate
 * escaping `changes`.
 *
 * The rule exists because of verbs, not payloads. `Agent.Diff` is a `run`
 * target, and `run` is the interactive verb: it is not aggregated by `ci`,
 * and `smithers-build docs //apps/site/...` cannot select it. A page writer
 * has to answer the `docs` verb so a person regenerates stale pages with one
 * command. It must also stay out of the aggregate `ci` verb, which plans
 * `docs`: the package executor lists `Docs.Page` among the attended rules
 * `ci` skips, because CI never spawns an agent. The freshness check that
 * makes a stale committed page fail under `ci` is a separate, deterministic
 * rule.
 *
 * The body is one sealed {@link AgentTarget.AgentDiff} call: the attrs project
 * to the same {@link AgentTarget.DiffPayload} an equivalent `Agent.Diff`
 * declaration plans, so the executor's existing diff lane runs the page
 * writer and no second agent loop exists.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as AgentTarget from "./AgentTarget.ts"
import * as Attr from "./Attr.ts"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

/**
 * Attrs for {@link Page}.
 *
 * `brief` and `prompt` are declared file inputs, so editing either re-keys
 * the page. `references` are the files the writer may read for style and
 * taxonomy; `inputs` are the code the page describes. Both take the same
 * members `Agent.Diff`'s `data` takes: file and glob inputs, filegroups,
 * and other targets. `output` is the one workspace-relative or
 * package-relative path the page lands at.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PageAttrs = Schema.Struct({
  agent: Schema.optional(AgentTarget.AgentSelector),
  brief: Input.File,
  prompt: Input.File,
  references: Attr.Data,
  inputs: Attr.Data,
  output: Schema.NonEmptyString,
  gates: Attr.Gates,
  sandbox: Schema.optional(Attr.Sandbox),
  approval: Schema.optional(Attr.Approval),
  maxRounds: AgentTarget.RoundCount
})

/**
 * Attrs for {@link Page}.
 *
 * @category models
 * @since 0.1.0
 */
export type PageAttrs = typeof PageAttrs.Type

/**
 * The `Agent.Diff` attrs one page declaration stands for: the brief,
 * references, and inputs become `data` in that order, and the single output
 * becomes the whole `changes` write-set.
 *
 * @category accessors
 * @since 0.1.0
 */
export const asDiffAttrs = (attrs: PageAttrs): (typeof AgentTarget.DiffAttrs)["Type"] => ({
  ...(attrs.agent === undefined ? {} : { agent: attrs.agent }),
  prompt: attrs.prompt,
  data: [attrs.brief, ...attrs.references, ...attrs.inputs],
  changes: [attrs.output],
  gates: attrs.gates,
  ...(attrs.sandbox === undefined ? {} : { sandbox: attrs.sandbox }),
  ...(attrs.approval === undefined ? {} : { approval: attrs.approval }),
  maxRounds: attrs.maxRounds
})

/**
 * The `data` members the executor resolves to dependency labels for a page:
 * its references and inputs, in declaration order.
 *
 * @category accessors
 * @since 0.1.0
 */
export const dataOf = (attrs: PageAttrs): (typeof Attr.Data)["Type"] => [...attrs.references, ...attrs.inputs]

/**
 * Projects decoded Docs.Page attrs into the {@link AgentTarget.AgentDiff}
 * payload, byte-for-byte the payload the equivalent `Agent.Diff` plans.
 *
 * @category accessors
 * @since 0.1.0
 */
export const pagePayload = (
  attrs: PageAttrs,
  context: Target.ImplementationContext
): AgentTarget.DiffPayload => AgentTarget.diffPayload(asDiffAttrs(attrs), context)

const pageDefinition = Target.make("Docs.Page", {
  attrs: PageAttrs,
  kinds: ["docs"],
  success: AgentTarget.DiffResult,
  error: AgentTarget.DiffError,
  cache: false,
  implementation: (attrs, context) => AgentTarget.AgentDiff.call(pagePayload(attrs, context))
})

/**
 * One agent-written documentation page: the writer reads the brief, the
 * references, and the inputs, and lands one output file that the gates
 * accept, within `maxRounds`. Selected by `smithers-build docs`; skipped by
 * `ci`.
 *
 * @category targets
 * @since 0.1.0
 */
export const Page = pageDefinition
