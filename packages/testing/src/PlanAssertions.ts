/**
 * Pure assertions for already-built plan graphs.
 *
 * @since 0.0.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import { canonical, compare, same } from "./internal/Structural.ts"
import * as Plan from "./Plan.ts"
import type { PlanLike, PlanNodeLike } from "./PlanLike.ts"
import { type PlanAssertionCode, PlanAssertionError } from "./TestingError.ts"

/**
 * An expected placement: a bare tag, or a tag with an exact option payload.
 * When `options` is omitted only the tag is compared.
 *
 * @category models
 * @since 0.0.0
 */
export type PlacementExpectation =
  | string
  | { readonly tag: string; readonly options?: Readonly<Record<string, unknown>> | undefined }
  | undefined

/**
 * A plan edge accepted by {@link PlanAssertions.edges}.
 *
 * @category models
 * @since 0.0.0
 */
export type Edge = readonly [from: string, to: string] | { readonly from: string; readonly to: string }

/**
 * Options for edge assertions.
 *
 * @category models
 * @since 0.0.0
 */
export interface EdgeOptions {
  /** Whether the plan may contain edges outside the expected pairs. */
  readonly exact?: boolean | undefined
}

/**
 * Options for static plan coverage assertions.
 *
 * @category models
 * @since 0.0.0
 */
export interface CoverageOptions {
  /** Node ids or `*` patterns which may be absent from the supplied plans. */
  readonly allowUnreached?: ReadonlyArray<string> | undefined
}

/**
 * Fluent assertions scoped to a single built node.
 *
 * @category models
 * @since 0.0.0
 */
export interface NodeAssertions {
  /** Asserts the node's content-addressed key. */
  readonly key: (expected: string) => Effect.Effect<void, PlanAssertionError>
  /** Asserts the node's placement tag, and its option payload when given. */
  readonly placement: (expected: PlacementExpectation) => Effect.Effect<void, PlanAssertionError>
  /** Asserts the node's boundary mode. */
  readonly mode: (expected: string | undefined) => Effect.Effect<void, PlanAssertionError>
  /** Asserts the tier the node is keyed under. */
  readonly tier: (expected: string) => Effect.Effect<void, PlanAssertionError>
  /** Asserts the node's declared effects. */
  readonly declaresEffects: (expected: ReadonlyArray<string>) => Effect.Effect<void, PlanAssertionError>
}

/**
 * Fluent assertions scoped to one built plan.
 *
 * @category models
 * @since 0.0.0
 */
export interface PlanAssertions {
  /** Asserts the number of nodes. */
  readonly nodeCount: (expected: number) => Effect.Effect<void, PlanAssertionError>
  /** Asserts that a node id is present. */
  readonly contains: (id: string) => Effect.Effect<void, PlanAssertionError>
  /** Asserts required edges, and optionally the exact edge set. */
  readonly edges: (pairs: ReadonlyArray<Edge>, options?: EdgeOptions) => Effect.Effect<void, PlanAssertionError>
  /** Asserts node id to key mappings. */
  readonly keys: (expected: Readonly<Record<string, string>>) => Effect.Effect<void, PlanAssertionError>
  /** Asserts a node placement tag, and its option payload when given. */
  readonly placement: (id: string, expected: PlacementExpectation) => Effect.Effect<void, PlanAssertionError>
  /** Asserts a node's declared effects. */
  readonly declaresEffects: (id: string, expected: ReadonlyArray<string>) => Effect.Effect<void, PlanAssertionError>
  /** Asserts the plan envelope. */
  readonly envelope: (expected: Record<string, unknown> | undefined) => Effect.Effect<void, PlanAssertionError>
  /** Asserts the canonical rendering equals an expected snapshot. */
  readonly matchesSnapshot: (expected: string) => Effect.Effect<void, PlanAssertionError>
  /** Returns assertions scoped to a node. */
  readonly node: (id: string) => NodeAssertions
}

/**
 * Fluent assertions across a static suite of built plans.
 *
 * @category models
 * @since 0.0.0
 */
export interface PlansAssertions {
  /** Asserts that the supplied suite reaches each requested node id. */
  readonly covers: (ids: ReadonlyArray<string>, options?: CoverageOptions) => Effect.Effect<void, PlanAssertionError>
}

// Preserve the concise absence diagnostic while sharing bounded, accessor-safe
// rendering for arbitrary envelope and placement payloads.
const inspect = (value: unknown): string => value === undefined ? "undefined" : canonical(value)

const fail = (
  code: PlanAssertionCode,
  message: string,
  expected?: unknown,
  actual?: unknown
): Effect.Effect<never, PlanAssertionError> =>
  Effect.fail(
    new PlanAssertionError({
      code,
      message,
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual })
    })
  )

const nodeOrFail = (plan: PlanLike, id: string): Effect.Effect<PlanNodeLike, PlanAssertionError> => {
  const found = Plan.node(plan, id)
  return found === undefined
    ? fail(
      "missing_node",
      `Expected node '${id}' to exist. Available nodes: ${
        plan.nodes.map((node) => node.id).sort().join(", ") || "(none)"
      }.`,
      id,
      plan.nodes.map((node) => node.id).sort()
    )
    : Effect.succeed(found)
}

const assertValue = (
  code: PlanAssertionCode,
  label: string,
  expected: unknown,
  actual: unknown
): Effect.Effect<void, PlanAssertionError> =>
  Effect.suspend(() =>
    same(expected, actual)
      ? Effect.void
      : fail(code, `${label} differs. Expected ${inspect(expected)}; actual ${inspect(actual)}.`, expected, actual)
  )

const placementView = (
  expected: PlacementExpectation,
  actual: PlanNodeLike["placement"]
): readonly [expected: unknown, actual: unknown] => {
  if (typeof expected === "string") return [expected, actual?.tag]
  if (expected !== undefined && expected.options === undefined) return [expected.tag, actual?.tag]
  return [expected, actual]
}

const diffLines = (expected: string, actual: string): string => {
  const expectedLines = expected.split("\n")
  const actualLines = actual.split("\n")
  const lines: Array<string> = []
  for (let index = 0; index < Math.max(expectedLines.length, actualLines.length); index++) {
    const want = expectedLines[index]
    const got = actualLines[index]
    if (want === got) {
      lines.push(`  ${want}`)
      continue
    }
    if (want !== undefined) lines.push(`- ${want}`)
    if (got !== undefined) lines.push(`+ ${got}`)
  }
  return lines.join("\n")
}

const edgePair = (edge: Edge): readonly [string, string] => "from" in edge ? [edge.from, edge.to] : edge

const edgeName = ([from, to]: readonly [string, string]): string => `${from} -> ${to}`

const matches = (id: string, pattern: string): boolean => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")
  return new RegExp(`^${escaped}$`).test(id)
}

/**
 * Creates fluent pure assertions for a built plan.
 *
 * @category constructors
 * @since 0.0.0
 */
export const expectPlan = (plan: PlanLike): PlanAssertions => {
  const nodeAssertions = (id: string): NodeAssertions => ({
    key: (expected) =>
      nodeOrFail(plan, id).pipe(
        Effect.flatMap((found) => assertValue("key_mismatch", `Key for node '${id}'`, expected, found.key))
      ),
    placement: (expected) =>
      nodeOrFail(plan, id).pipe(
        Effect.flatMap((found) => {
          const [want, got] = placementView(expected, found.placement)
          return assertValue("placement_mismatch", `Placement for node '${id}'`, want, got)
        })
      ),
    mode: (expected) =>
      nodeOrFail(plan, id).pipe(
        Effect.flatMap((found) =>
          assertValue("declared_effect_mismatch", `Effect mode for node '${id}'`, expected, found.mode)
        )
      ),
    tier: (expected) =>
      nodeOrFail(plan, id).pipe(
        Effect.flatMap((found) =>
          assertValue("declared_effect_mismatch", `Effect tier for node '${id}'`, expected, found.tier)
        )
      ),
    declaresEffects: (expected) =>
      nodeOrFail(plan, id).pipe(
        Effect.flatMap((found) =>
          assertValue(
            "declared_effect_mismatch",
            `Declared effects for node '${id}'`,
            [...expected].sort(),
            [...found.effects].sort()
          )
        )
      )
  })

  return {
    nodeCount: (expected) => assertValue("node_count_mismatch", "Plan node count", expected, plan.nodes.length),
    contains: (id) => nodeOrFail(plan, id).pipe(Effect.asVoid),
    edges: (pairs, options) => {
      const expected = pairs.map(edgePair).sort((left, right) => compare(edgeName(left), edgeName(right)))
      const actual = Plan.make(plan).edges.map((edge) => [edge.from, edge.to] as const)
      const actualNames = new Set(actual.map(edgeName))
      const missing = expected.filter((pair) => !actualNames.has(edgeName(pair)))
      if (missing.length > 0) {
        return fail(
          "missing_edge",
          `Missing edge${missing.length === 1 ? "" : "s"}: ${missing.map(edgeName).join(", ")}. Actual edges: ${
            actual.map(edgeName).join(", ") || "(none)"
          }.`,
          expected,
          actual
        )
      }
      if (options?.exact) {
        const expectedNames = new Set(expected.map(edgeName))
        const unexpected = actual.filter((pair) => !expectedNames.has(edgeName(pair)))
        if (unexpected.length > 0) {
          return fail(
            "unexpected_edge",
            `Unexpected edge${unexpected.length === 1 ? "" : "s"}: ${
              unexpected.map(edgeName).join(", ")
            }. Expected edges: ${expected.map(edgeName).join(", ") || "(none)"}.`,
            expected,
            actual
          )
        }
      }
      return Effect.void
    },
    keys: (expected) =>
      Effect.forEach(
        Object.entries(expected),
        ([id, key]) =>
          nodeOrFail(plan, id).pipe(
            Effect.flatMap((found) => assertValue("key_mismatch", `Key for node '${id}'`, key, found.key))
          )
      ).pipe(Effect.asVoid),
    placement: (id, expected) => nodeAssertions(id).placement(expected),
    declaresEffects: (id, expected) => nodeAssertions(id).declaresEffects(expected),
    envelope: (expected) => assertValue("envelope_mismatch", "Plan envelope", expected, plan.envelope),
    matchesSnapshot: (expected) => {
      const actual = Plan.render(plan)
      return actual === expected
        ? Effect.void
        : fail(
          "snapshot_mismatch",
          `Plan snapshot differs.\n${diffLines(expected, actual)}`,
          expected,
          actual
        )
    },
    node: nodeAssertions
  }
}

/**
 * Asserts key digests against checked-in goldens: the same logical input must
 * keep producing byte-identical `key1_` keys.
 *
 * @category assertions
 * @since 0.0.0
 */
export const expectKeyGoldens = (
  actual: Readonly<Record<string, string>>,
  golden: Readonly<Record<string, string>>
): Effect.Effect<void, PlanAssertionError> =>
  Effect.forEach(
    Object.entries(golden),
    ([name, expected]) =>
      same(expected, actual[name])
        ? Effect.void
        : fail(
          "key_golden_mismatch",
          `Key golden '${name}' differs. Expected ${inspect(expected)}; actual ${
            inspect(actual[name])
          }. Canonical key serialization drifted; this is a cache-identity break.`,
          expected,
          actual[name]
        )
  ).pipe(Effect.asVoid)

/**
 * Runs a plan computation that must be pure. Any failure or defect — for
 * example a poisoned Host or Model capability being reached during planning —
 * is surfaced as a `purity_violation` plan assertion error.
 *
 * The original value travels in `actual`, not only in the message. The
 * poisoned layers raise a `CapabilityContractError` carrying `capability` and
 * `operation` as typed fields precisely so a consumer can separate "the plan
 * called FileSystem.readFile" from "the plan called Jj.status" from "the input
 * schema failed to decode"; stringifying collapsed all three into prose a test
 * could only match with a regular expression.
 *
 * @category assertions
 * @since 0.0.0
 */
export const expectPure = <A, E, R>(
  computation: Effect.Effect<A, E, R>
): Effect.Effect<A, PlanAssertionError, R> =>
  computation.pipe(
    Effect.catchCause((cause) =>
      fail(
        "purity_violation",
        `Plan computation touched a capability or failed during planning: ${String(cause)}.`,
        undefined,
        Cause.squash(cause)
      )
    )
  )

/**
 * Creates static coverage assertions across built plans for a suite's inputs.
 *
 * @category constructors
 * @since 0.0.0
 */
export const expectPlans = (plans: ReadonlyArray<PlanLike>): PlansAssertions => ({
  covers: (ids, options) => {
    const reached = new Set(plans.flatMap((plan) => plan.nodes.map((node) => node.id)))
    const missing = ids.filter((id) =>
      !reached.has(id) && !options?.allowUnreached?.some((pattern) => matches(id, pattern))
    )
    return missing.length === 0
      ? Effect.void
      : fail(
        "coverage_mismatch",
        `Unreached node${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Reached nodes: ${
          [...reached].sort().join(", ") || "(none)"
        }.`,
        ids,
        [...reached].sort()
      )
  }
})
