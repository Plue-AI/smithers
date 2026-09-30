/**
 * The effect-authority controls, on the path `smithers up <flow>` drives.
 *
 * Nothing here builds a flow value in the test file. The declaration is a real
 * `flows/<name>/flow.ts` on disk, discovered by the registry, loaded through
 * `Executable.fromDescriptor`, and only then built. That is the whole chain a
 * file flow takes, so a control that fires here fires for a user.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { Graph } from "@smthrs/flow"
import type { GraphBuildError } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { fileURLToPath } from "node:url"
import type * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"

const flowsRoot = fileURLToPath(new URL("./fixtures/envelope/flows", import.meta.url))
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

/** Discovery, load, build: the file-flow path, with nothing stubbed. */
const built = Effect.gen(function*() {
  const discovery = yield* Discovery.Discovery
  const result = yield* discovery.scan({ source: "project", root: flowsRoot, naming: "path" })
  const descriptor = result.entries.find((entry) => entry.name === "envelope") as Descriptor.FlowDescriptor
  expect(descriptor, "envelope descriptor").toBeDefined()
  const executable = yield* Executable.fromDescriptor(descriptor, { delegates: [] })
  return { descriptor, graph: Graph.build(executable.flow, { input: {} }) }
}).pipe(Effect.provide(Discovery.layer.pipe(Layer.provide(platform))), Effect.provide(platform))

const refusalFor = (
  graph: Graph.Graph,
  code: string,
  member: string
): GraphBuildError.GraphBuildError | undefined =>
  Graph.diagnostics(graph).find((one) => one.code === code && one.node.includes(member))

describe("the file-flow path enforces the effect envelope", () => {
  it.effect("projects the declared envelope into the descriptor discovery records", () =>
    Effect.map(built, ({ descriptor }) => {
      // The literal `effects` on a `@smthrs/flow` declaration is what the
      // catalog shows, without importing the module.
      expect(descriptor.effects).toEqual({
        reads: ["src/**"],
        writes: ["dist/**"],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "compensable"
      })
    }))

  it.effect("refuses a callee that writes outside the envelope", () =>
    Effect.map(built, ({ graph }) => {
      const refusal = refusalFor(graph, "effect_outside_envelope", "escaping")
      expect(refusal?.path).toEqual(["etc/hosts"])
      expect(refusal?.message).toContain("test/envelope/escaping")
    }))

  it.effect("refuses a callee that loosens the mode", () =>
    Effect.map(built, ({ graph }) => {
      expect(refusalFor(graph, "effect_mode_widening", "looser")?.message)
        .toContain("test/envelope/looser")
    }))

  it.effect("refuses a callee that raises the tier", () =>
    Effect.map(built, ({ graph }) => {
      expect(refusalFor(graph, "effect_tier_widening", "riskier")?.message)
        .toContain("test/envelope/riskier")
    }))

  it.effect("records a callee requiring a capability the flow does not hold", () =>
    Effect.map(built, ({ graph }) => {
      expect(refusalFor(graph, "capability_outside_grant", "privileged")?.path).toEqual(["net"])
      // The flow's own `fs:read:**` is a well-formed grant, so the only
      // capability refusal is the callee that asks for what it does not hold:
      // a malformed pattern such as `fs:read` grants nothing, and would refuse
      // the flow against itself.
      expect(Graph.diagnostics(graph).filter((one) => one.code === "capability_outside_grant")).toHaveLength(1)
    }))

  it.effect("refuses a write beneath a sealed flow", () =>
    Effect.map(built, ({ graph }) => {
      // The sealed callee grants nothing, so the flow IT calls is refused
      // against the sealed envelope rather than against the file flow's.
      const refusal = refusalFor(graph, "effect_outside_envelope", "sealed")
      expect(refusal?.path).toEqual(["dist/x.js"])
      expect(refusal?.message).toContain("test/envelope/widener")
    }))

  it.effect("withholds the drafts, because four of the five refusals are fatal", () =>
    Effect.map(built, ({ graph }) => {
      expect(() => Graph.drafts(graph)).toThrow(
        expect.objectContaining({ code: "effect_outside_envelope" })
      )
      expect(Graph.diagnostics(graph).map((one) => one.code).sort()).toEqual([
        "capability_outside_grant",
        "effect_mode_widening",
        "effect_outside_envelope",
        "effect_outside_envelope",
        "effect_tier_widening"
      ])
    }))
})
