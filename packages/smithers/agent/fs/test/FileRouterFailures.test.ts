import * as NodePath from "@effect/platform-node/NodePath"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { discoveryError } from "@smthrs/registry/RegistryError"
import { Cause, Effect, FileSystem, Layer, Option } from "effect"
import { describe, expect, it, vi } from "vitest"

const discovery = vi.hoisted(() => ({
  scan: undefined as undefined | ((options: unknown) => unknown)
}))

vi.mock("@smthrs/registry/Discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@smthrs/registry/Discovery")>()
  return {
    ...actual,
    make: () => ({
      scan: (options: unknown) => discovery.scan!(options)
    })
  }
})

import * as CommandTree from "../src/CommandTree.ts"
import * as FileRouter from "../src/FileRouter.ts"

const descriptor = (path: string): Descriptor.FlowDescriptor => ({
  path,
  body: new Descriptor.BodyRefModule({ path }),
  description: "fixture",
  input: new Descriptor.SchemaRefNone({}),
  output: new Descriptor.SchemaRefNone({}),
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  modelInvocable: true,
  placement: Option.none()
} as unknown as Descriptor.FlowDescriptor)

const result = (entries: ReadonlyArray<Descriptor.FlowDescriptor>) => ({ entries, warnings: [] })

const fileSystem = (
  exists: FileSystem.FileSystem["exists"] = () => Effect.succeed(false)
): FileSystem.FileSystem => ({ exists } as FileSystem.FileSystem)

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | import("effect/Path").Path>
): Promise<A> =>
  Effect.runPromise(effect.pipe(
    Effect.provide(Layer.merge(
      Layer.succeed(FileSystem.FileSystem, fileSystem()),
      NodePath.layer
    ))
  ))

const errorOf = async (
  effect: Effect.Effect<unknown, unknown, FileSystem.FileSystem | import("effect/Path").Path>
): Promise<any> => {
  const exit = await run(Effect.exit(effect))
  expect(exit._tag).toBe("Failure")
  if (exit._tag !== "Failure") throw new Error("expected failure")
  return Option.getOrThrow(Cause.findErrorOption(exit.cause))
}

describe("FileRouter failure projection", () => {
  it("preserves every registry discovery category and sanitizes foreign failures", async () => {
    for (
      const [source, expected] of [
        ["root_missing", "root_missing"],
        ["invalid_root", "invalid_root"],
        ["read_failed", "read_failed"],
        ["unknown", "discovery_failed"]
      ] as const
    ) {
      discovery.scan = () => Effect.fail(discoveryError({ code: source, method: "scan" }))
      expect((await errorOf(FileRouter.scan({ root: "/flows" }))).code).toBe(expected)
    }

    discovery.scan = () => Effect.fail(new Error("TOP-SECRET"))
    const foreign = await errorOf(FileRouter.scan({ root: "/flows" }))
    expect(foreign.code).toBe("discovery_failed")
    expect(JSON.stringify(foreign)).not.toContain("TOP-SECRET")
  })

  it("bounds scan results before inspecting route companions", async () => {
    discovery.scan = () =>
      Effect.succeed(result(
        Array.from({ length: CommandTree.maximumRoutes + 1 }, (_, index) => descriptor(`/flows/r${index}/flow.ts`))
      ))
    expect((await errorOf(FileRouter.scan({ root: "/flows" }))).code).toBe("resource_limit")
  })

  it("skips root entries and refuses paths collapsing to one route", async () => {
    discovery.scan = () =>
      Effect.succeed(result([
        descriptor("/flows/flow.ts"),
        descriptor("/flows/kept/flow.ts")
      ]))
    expect((await run(FileRouter.scan({ root: "/flows" }))).routes.map((route) => route.name)).toEqual(["kept"])

    discovery.scan = () =>
      Effect.succeed(result([
        descriptor("/flows/duplicate/flow.ts"),
        descriptor("/flows/duplicate/other.ts")
      ]))
    expect((await errorOf(FileRouter.scan({ root: "/flows" }))).code).toBe("duplicate_route")
  })

  it("maps companion inspection failures without retaining their cause", async () => {
    discovery.scan = () => Effect.succeed(result([descriptor("/flows/route/flow.ts")]))
    const effect = FileRouter.scan({ root: "/flows" }).pipe(
      Effect.provide(Layer.merge(
        Layer.succeed(FileSystem.FileSystem, fileSystem(() => Effect.fail(new Error("TOP-SECRET")) as never)),
        NodePath.layer
      ))
    )
    const exit = await Effect.runPromise(Effect.exit(effect))
    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") return
    const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
    expect(error.code).toBe("read_failed")
    expect(JSON.stringify(error)).not.toContain("TOP-SECRET")
  })

  it("refuses a UI companion whose real path cannot be resolved", async () => {
    discovery.scan = () => Effect.succeed(result([descriptor("/flows/route/flow.ts")]))
    const unresolvable = {
      exists: () => Effect.succeed(true),
      realPath: () => Effect.fail(new Error("TOP-SECRET"))
    } as unknown as FileSystem.FileSystem
    const exit = await Effect.runPromise(Effect.exit(
      FileRouter.scan({ root: "/flows" }).pipe(
        Effect.provide(Layer.merge(Layer.succeed(FileSystem.FileSystem, unresolvable), NodePath.layer))
      )
    ))
    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") return
    const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
    expect(error.code).toBe("read_failed")
    expect(JSON.stringify(error)).not.toContain("TOP-SECRET")
  })
})
