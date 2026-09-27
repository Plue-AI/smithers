/**
 * Flow-valued slots and authority-narrowing decorators.
 *
 * A slot is a schema-constrained hole a caller fills with a flow; a decorator
 * wraps one flow in another and re-declares the result under the wrapped
 * flow's schemas and authority ceiling. Both read a `@smthrs/flow` declaration
 * through `internal/Decorate.ts`, which is where the capability ceiling and the
 * effect envelope are read off the annotation bag `Graph.build` consults.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import { dual } from "effect/Function"
import type * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import * as Decorate from "./internal/Decorate.ts"
import { PatternError } from "./PatternError.ts"

/**
 * A schema-constrained hole which may provide a default flow.
 *
 * @category models
 * @since 0.1.0
 */
export interface Slot<I extends Schema.Top, O extends Schema.Top> {
  readonly input: I
  readonly output: O
  readonly default?: Flow.Any | undefined
}

const schemaRefusalMessage = (subject: string, issue: Decorate.SchemaCompatibilityIssue): string => {
  if (issue._tag === "SchemaConversionFailed") {
    return `${subject} ${issue.side} schemas cannot be compared because the ${issue.schema} ${issue.side} schema ` +
      `(${issue.tag}) has no JSON Schema form`
  }
  return issue.path === undefined
    ? `${subject} has an incompatible ${issue.side} schema: expected ${issue.expectedTag}, received ${issue.actualTag}`
    : `${subject} has an incompatible ${issue.side} schema: both schemas are ${issue.expectedTag} and they first ` +
      `differ at ${issue.path}`
}

/**
 * Declares a flow-valued slot.
 *
 * Defaults are checked immediately so an invalid declaration cannot enter a
 * plan. The returned slot is a frozen copy of the options, so a later edit to
 * the caller's object does not reach {@link bind}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const slot = <I extends Schema.Top, O extends Schema.Top>(
  options: Slot<I, O>
): Slot<I, O> => {
  const issue = options.default === undefined
    ? undefined
    : Decorate.schemasCompatible(options.input, options.output, options.default)
  if (issue !== undefined) {
    throw new PatternError({
      code: "invalid_decorator",
      message: schemaRefusalMessage("The slot default", issue)
    })
  }
  // A frozen copy: `bind` reads the slot again later, and a caller's edit to
  // the options object in between must not turn a defaulted slot required or
  // swap in a default the check above never saw.
  return Object.freeze({ input: options.input, output: options.output, default: options.default })
}

/**
 * Resolves a slot to a supplied flow or its default.
 *
 * The failure is raised during pure plan construction, so a declaration that
 * does not fit its slot never reaches a graph.
 *
 * @category constructors
 * @since 0.1.0
 */
export const bind = <I extends Schema.Top, O extends Schema.Top>(
  declaration: Slot<I, O>,
  supplied?: Flow.Any | undefined
): Flow.Any => {
  const flow = supplied ?? declaration.default
  if (flow === undefined) {
    throw new PatternError({
      code: "missing_slot",
      message: "A required flow slot was not bound and has no default"
    })
  }
  const issue = Decorate.schemasCompatible(declaration.input, declaration.output, flow)
  if (issue !== undefined) {
    throw new PatternError({
      code: "invalid_decorator",
      message: schemaRefusalMessage("The bound flow", issue)
    })
  }
  return flow
}

/**
 * A transformation which wraps one flow with another flow.
 *
 * @category models
 * @since 0.1.0
 */
export type Decorator = (inner: Flow.Any) => Flow.Any

/**
 * The portions of a supplied decorator declaration removed by its template
 * envelope.
 *
 * @category models
 * @since 0.1.0
 */
export interface Clipped {
  readonly capabilities: ReadonlyArray<string>
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly mode: boolean
  readonly tier: boolean
}

/**
 * Reports authority declared by `supplied` but excluded by `template`.
 *
 * @category introspection
 * @since 0.1.0
 */
export const clipped = (template: Flow.Any, supplied: Flow.Any): Clipped => {
  const expected = Decorate.capabilitiesOf(template)
  const actual = Decorate.capabilitiesOf(supplied)
  const effects = Compose.intersectEffects(Decorate.envelopeOf(template), Decorate.envelopeOf(supplied))
  const capabilities = actual.filter(
    (capability) => !Compose.intersectCapabilities(expected, actual).includes(capability)
  )
  return {
    capabilities: [...new Set(capabilities)].sort(),
    reads: effects.reads,
    writes: effects.writes,
    mode: effects.mode,
    tier: effects.tier
  }
}

/**
 * Applies a decorator and re-declares the result under the wrapped flow's
 * schema and authority ceiling.
 *
 * The returned name derives from the decorator result (or the decorator
 * function name), and the extra flow call makes the decorator chain part of
 * declaration identity.
 *
 * @category combinators
 * @since 0.1.0
 */
export const decorate: {
  (decorator: Decorator): (self: Flow.Any) => Flow.Any
  (self: Flow.Any, decorator: Decorator): Flow.Any
} = dual(2, (self: Flow.Any, decorator: Decorator): Flow.Any => {
  const supplied = decorator(self)
  if (!Flow.isFlow(supplied)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "A flow decorator must return a Flow"
    })
  }
  const issue = Decorate.schemasCompatible(self.payloadSchema, self.successSchema, supplied)
  if (issue !== undefined) {
    throw new PatternError({
      code: "invalid_decorator",
      message: schemaRefusalMessage("The flow decorator result", issue)
    })
  }
  const innerName = Decorate.displayName(self)
  const suppliedName = supplied._tag
  const decoratorName = decorator.name.length === 0 ? "decorate" : decorator.name
  // A decorator result that named itself nothing carries the empty tag, which
  // must not be adopted as the composed name: a flow called "" is worse than
  // the derived `decorate(anonymous)`.
  const name = suppliedName.length > 0 && suppliedName !== innerName
    ? suppliedName
    : `${decoratorName}(${innerName})`
  return Decorate.redeclare(self, supplied, name)
})

/**
 * Applies decorators from left to right, so the final decorator is outermost.
 *
 * @category combinators
 * @since 0.1.0
 */
export const decorateAll = (
  flow: Flow.Any,
  decorators: ReadonlyArray<Decorator>
): Flow.Any => decorators.reduce((inner, decorator) => decorate(inner, decorator), flow)
