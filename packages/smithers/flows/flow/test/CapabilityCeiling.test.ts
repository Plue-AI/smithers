import { describe, expect, it } from "@effect/vitest"
import { Capability, type CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Action, Flow, FlowRuntime, Graph, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Context, Effect, Layer, Schema } from "effect"
import { withCrypto } from "./Crypto.ts"
import { layerWired, makeInstance } from "./MemoryFlowRuntime.ts"

const capability = (action: Capability["action"], resource: string) => new Capability({ action, resource })
const read = capability("fs:read", "src/main.ts")
const write = capability("fs:write", "src/main.ts")
const other = capability("fs:read", "test/main.ts")

const Touch = Action.make("ceiling/touch", {
  payload: {},
  success: Schema.Number,
  capabilities: ["fs:read:src/main.ts"]
})

const actionNode = (flow: Flow.Any) => Graph.nodes(Graph.build(flow, {})).find((node) => node.kind === "ActionCall")!

const flowWith = (tag: string, capabilities?: ReadonlyArray<string>) =>
  Flow.make(tag, {
    payload: {},
    success: Schema.Number,
    ...(capabilities === undefined ? {} : { capabilities }),
    body: () => Touch.call({})
  })

describe("flow capability ceilings", () => {
  it("distinguishes omission from an explicit empty annotation", () => {
    expect(Flow.capabilityCeilings(Context.empty())).toEqual([])
    expect(Flow.capabilityCeilings(Context.make(Flow.Capabilities, []))).toEqual([[]])
    expect(Flow.capabilityCeilings(Context.make(Flow.Capabilities, ["fs:read:**"])))
      .toEqual([["fs:read:**"]])
  })

  it.effect("inherits omitted groups and denies an explicit empty group", () =>
    Effect.gen(function*() {
      const inherited = yield* Flow.attenuateCapabilities([])(CapabilitySet.current)
      const denied = yield* Flow.attenuateCapabilities([[]])(CapabilitySet.current)
      expect(CapabilitySet.allows(inherited, read)).toBe(true)
      expect(CapabilitySet.equals(denied, CapabilitySet.none)).toBe(true)
    }))

  it.effect("invalid patterns grant no authority", () =>
    Effect.gen(function*() {
      const invalid = yield* Flow.attenuateCapabilities([["fs:read"]])(CapabilitySet.current)
      const mixed = yield* Flow.attenuateCapabilities([["fs:read", "fs:read:src/**"]])(CapabilitySet.current)
      expect(CapabilitySet.equals(invalid, CapabilitySet.none)).toBe(true)
      expect(CapabilitySet.allows(mixed, read)).toBe(true)
      expect(CapabilitySet.allows(mixed, other)).toBe(false)
    }))

  it("parses declared ceilings into groups, dropping invalid patterns", () => {
    expect(Flow.parseCapabilityCeilings([])).toEqual([])
    expect(Flow.parseCapabilityCeilings([[]])).toEqual([[]])
    const [group] = Flow.parseCapabilityCeilings([["fs:read", "*", "fs:read:src/**"]])
    expect(group?.map(({ action, resource }) => `${action} ${resource}`)).toEqual(["* **", "fs:read src/**"])
  })

  it.effect("intersects multiple groups exactly, including wildcard languages", () =>
    Effect.gen(function*() {
      const set = yield* Flow.attenuateCapabilities([
        ["fs:*:src/**", "net:get:**"],
        ["fs:read:**"],
        ["*:src/main.ts"]
      ])(CapabilitySet.current)
      expect(CapabilitySet.allows(set, read)).toBe(true)
      expect(CapabilitySet.allows(set, write)).toBe(false)
      expect(CapabilitySet.allows(set, other)).toBe(false)
      expect(CapabilitySet.allows(set, capability("net:get", "src/main.ts"))).toBe(false)
    }))

  it("accepts wildcard narrowing and diagnoses a request beneath an empty ceiling", () => {
    const Allowed = Flow.make("ceiling/allowed", {
      payload: {},
      success: Schema.Number,
      capabilities: ["fs:read:src/main.ts"],
      body: () => Touch.call({})
    })
    const Wide = Flow.make("ceiling/wide", {
      payload: {},
      success: Schema.Number,
      capabilities: ["fs:*:src/**"],
      body: () => Allowed.call({})
    })
    const Empty = Flow.make("ceiling/empty", {
      payload: {},
      success: Schema.Number,
      capabilities: [],
      body: () => Allowed.call({})
    })
    expect(Graph.diagnostics(Graph.build(Wide, {})).filter((error) => error.code === "capability_outside_grant"))
      .toEqual([])
    expect(Graph.diagnostics(Graph.build(Empty, {})).find((error) => error.code === "capability_outside_grant")?.path)
      .toEqual(["fs:read:src/main.ts"])
  })

  it("keys an action differently for omitted, empty, and narrower ancestor ceilings", () => {
    const inherited = actionNode(flowWith("ceiling/key-omitted"))
    const empty = actionNode(flowWith("ceiling/key-empty", []))
    const narrowed = actionNode(flowWith("ceiling/key-narrow", ["fs:read:src/**"]))
    expect(inherited.capabilityCeilings).toEqual([["fs:read:src/main.ts"]])
    expect(empty.capabilityCeilings).toEqual([[], ["fs:read:src/main.ts"]])
    expect(narrowed.capabilityCeilings).toEqual([["fs:read:src/**"], ["fs:read:src/main.ts"]])
    expect(inherited.draft.material.body).not.toEqual(empty.draft.material.body)
    expect(inherited.draft.material.body).not.toEqual(narrowed.draft.material.body)
    expect(empty.draft.material.body).not.toEqual(narrowed.draft.material.body)
  })

  it.effect("carries every ancestor ceiling into a handoff without widening authority", () =>
    Effect.gen(function*() {
      const Target = Flow.make("ceiling/handoff-target", {
        payload: {},
        success: Schema.Number,
        capabilities: ["fs:read:src/**"],
        body: () => Node.succeed(1)
      })
      const Source = Flow.make("ceiling/handoff-source", {
        payload: {},
        success: Schema.Number,
        capabilities: ["fs:*:src/**"],
        body: () => Target.to({})
      })
      const interpretation = yield* withCrypto(
        Interpreter.interpret(Source, {}).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Source, "ceiling-handoff")),
          Effect.provide(layerWired(Layer.empty))
        )
      )
      const outcome = interpretation.value as {
        readonly _tag: "To"
        readonly flow: string
        readonly capabilityCeilings: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
      }
      expect(outcome._tag).toBe("To")
      expect(outcome.flow).toBe(Target._tag)
      expect(outcome.capabilityCeilings).toEqual([
        [{ action: "fs:*", resource: "src/**" }],
        [{ action: "fs:read", resource: "src/**" }]
      ])
      const resumed = yield* CapabilitySet.attenuateGroups(outcome.capabilityCeilings)(CapabilitySet.current)
      expect(CapabilitySet.allows(resumed, read)).toBe(true)
      expect(CapabilitySet.allows(resumed, write)).toBe(false)
      expect(CapabilitySet.allows(resumed, other)).toBe(false)
    }))
})
