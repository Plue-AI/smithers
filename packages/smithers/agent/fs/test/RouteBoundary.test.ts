import * as Descriptor from "@smthrs/registry/Descriptor"
import { Cause, Effect, Option } from "effect"
import { describe, expect, it, vi } from "vitest"
import * as Route from "../src/Route.ts"
import { invalidModule, makeRoute, visibleModule } from "./helpers.ts"

const errorOf = async (effect: Effect.Effect<unknown, unknown>): Promise<any> => {
  const exit = await Effect.runPromise(Effect.exit(effect))
  expect(exit._tag).toBe("Failure")
  if (exit._tag !== "Failure") throw new Error("expected failure")
  return Option.getOrThrow(Cause.findErrorOption(exit.cause))
}

describe("Route boundary", () => {
  it("loads a canonical tagged flow and projects its schemas", async () => {
    const modulePath = new URL("./fixtures/three-projections/flows/review/flow.ts", import.meta.url).pathname
    const loaded = await Effect.runPromise(Route.load(makeRoute("review", modulePath)))
    expect(loaded.name).toBe("review")
    expect(loaded.description).toBeUndefined()
    const { Schema } = await import("effect")
    const { default: canonical } = await import("./fixtures/three-projections/flows/review/flow.ts")
    expect(loaded.input).toBe(canonical.payloadSchema)
    expect(loaded.output).toBe(canonical.successSchema)
    expect(Schema.decodeUnknownSync(canonical.payloadSchema)({ number: 7 })).toEqual({ number: 7 })
    expect(Schema.decodeUnknownSync(canonical.successSchema)({ accepted: true, number: 7 })).toEqual({
      accepted: true,
      number: 7
    })
  })

  it("copies and freezes complete route metadata", async () => {
    const source = makeRoute("review", visibleModule, {
      capabilities: ["fs:read:**"],
      effects: {
        reads: ["src/**"],
        writes: ["dist/**"],
        mode: "expected",
        onConflict: "lane",
        tier: "compensable"
      },
      input: new Descriptor.SchemaRefInline({
        document: { type: "object", properties: { value: { type: "string" } } }
      }),
      output: new Descriptor.SchemaRefNone({}),
      placement: Option.some("sandbox"),
      ui: Option.some("/absolute/ui.tsx")
    })
    const snapshot = await Effect.runPromise(Route.snapshot(source))
    ;(source.capabilities as Array<string>)[0] = "changed"
    ;(source.effects.reads as Array<string>)[0] = "changed"

    expect(snapshot).toMatchObject({
      name: "review",
      capabilities: ["fs:read:**"],
      effects: { reads: ["src/**"], writes: ["dist/**"], mode: "expected", onConflict: "lane" },
      modelInvocable: true
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.effects)).toBe(true)
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true)
  })

  it("copies every schema locator variant", async () => {
    const refs: ReadonlyArray<Descriptor.SchemaRef> = [
      new Descriptor.SchemaRefMarkdownArgs({}),
      new Descriptor.SchemaRefMarkdownOutput({}),
      new Descriptor.SchemaRefNone({}),
      new Descriptor.SchemaRefModule({ path: visibleModule, field: "input" }),
      new Descriptor.SchemaRefInline({ document: { type: "string" } })
    ]
    for (const [index, input] of refs.entries()) {
      const output = refs[(index + 1) % refs.length]!
      const snapshot = await Effect.runPromise(
        Route.snapshot(makeRoute(`route-${index}`, visibleModule, { input, output }))
      )
      expect(snapshot.input).not.toBe(input)
      expect(snapshot.input._tag).toBe(input._tag)
      expect(snapshot.output._tag).toBe(output._tag)
    }
  })

  it("rejects malformed top-level fields without invoking accessors", async () => {
    const base = makeRoute("review")
    const malformed: ReadonlyArray<Route.Route> = [
      { ...base, name: "different" },
      { ...base, segments: [] },
      { ...base, segments: ["."] },
      { ...base, segments: ["a/b"] },
      { ...base, segments: ["x".repeat(Route.maximumSegmentLength + 1)] },
      { ...base, kind: "other" as never },
      { ...base, sourcePath: "relative.ts" },
      { ...base, sourcePath: "file:relative.ts" },
      { ...base, sourcePath: "\ud800" },
      { ...base, description: "not-an-option" as never },
      { ...base, description: Option.some("") },
      { ...base, capabilities: [""] },
      { ...base, modelInvocable: "yes" as never },
      { ...base, placement: "not-an-option" as never },
      { ...base, placement: Option.some("elsewhere" as never) },
      { ...base, ui: Option.some("") }
    ]
    for (const route of malformed) expect((await errorOf(Route.snapshot(route))).code).toBe("invalid_route")

    const getter = vi.fn(() => "review")
    const accessor = Object.defineProperty({ ...base }, "name", { enumerable: true, get: getter })
    expect((await errorOf(Route.snapshot(accessor))).code).toBe("invalid_route")
    expect(getter).not.toHaveBeenCalled()

    const hostileOption = new Proxy({}, {
      has: () => {
        throw new Error("trap")
      }
    })
    expect((await errorOf(Route.snapshot({ ...base, description: hostileOption as never }))).code).toBe(
      "invalid_route"
    )
    expect((await errorOf(Route.snapshot({ ...base, placement: hostileOption as never }))).code).toBe(
      "invalid_route"
    )
  })

  it("rejects malformed schema locators and effect declarations", async () => {
    const base = makeRoute("review")
    const badRefs = [
      null,
      [],
      {},
      { _tag: "Unknown" },
      { _tag: "Module", path: "", field: "input" },
      { _tag: "Module", path: visibleModule, field: "other" },
      { _tag: "Inline", document: { value: undefined } },
      Object.defineProperty({ _tag: "None" }, "extra", { value: true, enumerable: true })
    ]
    for (const input of badRefs) {
      expect((await errorOf(Route.snapshot({ ...base, input: input as never }))).code).toBe("invalid_route")
    }

    const nullPrototype = Object.assign(Object.create(null), { _tag: "None" })
    expect((await Effect.runPromise(Route.snapshot({ ...base, input: nullPrototype }))).input._tag).toBe("None")
    const inherited = Object.create({ _tag: "None" })
    expect((await errorOf(Route.snapshot({ ...base, input: inherited }))).code).toBe("invalid_route")
    const tagGetter = vi.fn(() => "None")
    const accessorTag = Object.defineProperty({}, "_tag", { enumerable: true, get: tagGetter })
    expect((await errorOf(Route.snapshot({ ...base, input: accessorTag as never }))).code).toBe("invalid_route")
    expect(tagGetter).not.toHaveBeenCalled()
    const pathGetter = vi.fn(() => visibleModule)
    const accessorPath = Object.defineProperty({ _tag: "Module", field: "input" }, "path", {
      enumerable: true,
      get: pathGetter
    })
    expect((await errorOf(Route.snapshot({ ...base, input: accessorPath as never }))).code).toBe("invalid_route")
    expect(pathGetter).not.toHaveBeenCalled()
    const hostileRef = new Proxy({ _tag: "None" }, {
      getPrototypeOf: () => {
        throw new Error("trap")
      }
    })
    expect((await errorOf(Route.snapshot({ ...base, input: hostileRef as never }))).code).toBe("invalid_route")

    for (
      const effects of [
        { ...base.effects, reads: [""] },
        { ...base.effects, writes: [1] },
        { ...base.effects, mode: "other" },
        { ...base.effects, onConflict: "other" },
        { ...base.effects, tier: "other" }
      ]
    ) {
      expect((await errorOf(Route.snapshot({ ...base, effects: effects as never }))).code).toBe("invalid_route")
    }
  })

  it("canonicalizes route identity to NFC", async () => {
    const route = await Effect.runPromise(Route.snapshot(makeRoute("cafe\u0301/list")))
    expect(route.name).toBe("caf\u00e9/list")
    expect(route.segments).toEqual(["caf\u00e9", "list"])
  })

  it("classifies executable routes and returns typed loader failures", async () => {
    expect(Route.isCommandRoute(makeRoute("visible"))).toBe(true)
    expect(Route.isCommandRoute(makeRoute("hidden", undefined, { modelInvocable: false }))).toBe(false)
    expect(Route.isCommandRoute(makeRoute("markdown", undefined, { kind: "markdown" }))).toBe(false)

    expect((await errorOf(Route.load(makeRoute("markdown", undefined, { kind: "markdown" })))).code).toBe(
      "unsupported_body"
    )
    // One stable code, two descriptions: a caller can tell a bad path from a
    // module that loads but exports no flow.
    expect(await errorOf(Route.load(makeRoute("invalid", invalidModule)))).toMatchObject({
      code: "load_failed",
      description: "The selected flow module has no default flow export"
    })
    expect(await errorOf(Route.load(makeRoute("missing", "/definitely/missing/flow.ts")))).toMatchObject({
      code: "load_failed",
      description: "The selected flow module could not be imported"
    })
  })
})
