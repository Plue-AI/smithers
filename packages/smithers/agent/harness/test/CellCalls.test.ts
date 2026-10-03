/**
 * Registry-backed call resolution, against a real directory on disk.
 *
 * The point of these cases is that a cell's `ctx.call` reaches a flow the
 * registry actually discovered — under the documented `flow.ts` -> `flow.mdx`
 * -> `SKILL.md` precedence — rather than a table the harness keeps on the side.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"

import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { registryError } from "@smthrs/registry/RegistryError"
import { Cause, Effect, Exit, Layer, Option, Result, Schema } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as CellCalls from "../src/CellCalls.ts"
import * as FlowBinding from "../src/FlowBinding.ts"
import { HarnessError } from "../src/HarnessError.ts"

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const moduleFlow = [
  `"use server"`,
  ``,
  `import { Flow } from "@smthrs/core"`,
  `import { Schema } from "effect"`,
  ``,
  `export default ({`,
  `  name: "list",`,
  `  description: "Lists the files the run may read.",`,
  `  input: Schema.Struct({ path: Schema.String }),`,
  `  output: Schema.Array(Schema.String),`,
  `  capabilities: ["fs:read:."],`,
  `  effects: {`,
  `    reads: ["."],`,
  `    writes: [],`,
  `    mode: "hermetic",`,
  `    onConflict: "serialize",`,
  `    tier: "sealed"`,
  `  }`,
  `})`,
  ``
].join("\n")

const skill = (description: string, body: string) =>
  ["---", `description: ${description}`, "---", "", body, ""].join("\n")

let root = ""

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "flows-cell-calls-"))
  // Both entry files in one directory: `flow.ts` outranks `SKILL.md`.
  await mkdir(join(root, "flows", "list"), { recursive: true })
  await writeFile(join(root, "flows", "list", "flow.ts"), moduleFlow)
  await writeFile(
    join(root, "flows", "list", "SKILL.md"),
    skill("The shadowed markdown entry that must lose.", "Never rendered.")
  )
  await mkdir(join(root, "flows", "summarize"), { recursive: true })
  await writeFile(
    join(root, "flows", "summarize", "SKILL.md"),
    skill("Summarizes whatever it is given.", "Summarize: {{args}}")
  )
})

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true })
})

const registryLayer = () =>
  Registry.layer({ sources: [{ source: "project", root: join(root, "flows"), naming: "path" }] }).pipe(
    Layer.provide([Discovery.layer.pipe(Layer.provide(platform)), platform]),
    Layer.orDie
  )

/** Resolves the descriptor the registry actually discovered for `name`. */
const discovered = (name: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      return yield* registry.get(name)
    }).pipe(Effect.provide(registryLayer()), Effect.orDie)
  )

const callOf = (
  descriptor: Awaited<ReturnType<typeof discovered>>,
  input: Schema.Json,
  overrides: { readonly declaration?: string } = {}
): Cell.Call =>
  new Cell.Call({
    flowName: descriptor.name,
    input,
    capabilities: descriptor.capabilities,
    effects: descriptor.effects,
    placement: descriptor.placement,
    identity: new Cell.CallIdentity({
      session: "session-1",
      frame: 0,
      cell: "cell-digest",
      ordinal: 0,
      declaration: overrides.declaration ?? Cell.declarationDigest(descriptor),
      layers: []
    })
  })

const resolve = (
  call: Cell.Call,
  options: {
    readonly implementations?: ReadonlyMap<string, CellCalls.Implementation>
    readonly prompt?: CellCalls.PromptRunner
  } = {}
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const resolver = CellCalls.make({
        registry,
        ...(options.implementations === undefined ? {} : { implementations: options.implementations }),
        ...(options.prompt === undefined ? {} : { prompt: options.prompt })
      })
      return yield* resolver.run(call)
    }).pipe(Effect.provide(registryLayer()), Effect.orDie)
  )

const succeeded = (value: Schema.Json): Cell.CallResult => new Cell.CallResult({ outcome: "success", value })

describe("CellCalls.make", () => {
  it("calls the discovered flow.ts body, which outranks the SKILL.md beside it", async () => {
    const descriptor = await discovered("list")
    // Precedence is the registry's: the module entry won, so the body is a
    // module and no markdown runner is ever consulted.
    expect(descriptor.body._tag).toBe("Module")
    expect(descriptor.description).toBe("Lists the files the run may read.")

    const seen: Array<unknown> = []
    const result = await resolve(callOf(descriptor, { path: "." }), {
      implementations: new Map([[
        "list",
        (call) => Effect.sync(() => (seen.push(call.input), succeeded(["alpha.md"])))
      ]])
    })

    expect(result).toMatchObject({ outcome: "success", value: ["alpha.md"] })
    expect(seen).toEqual([{ path: "." }])
  })

  it("renders a discovered markdown flow and hands it to the prompt runner", async () => {
    const descriptor = await discovered("summarize")
    expect(descriptor.body._tag).toBe("Markdown")

    const rendered: Array<string> = []
    const result = await resolve(callOf(descriptor, { args: "the release notes" }), {
      prompt: (prompt) => Effect.sync(() => (rendered.push(prompt.text), succeeded("summarized")))
    })

    expect(result).toMatchObject({ outcome: "success", value: "summarized" })
    expect(rendered[0]).toContain("the release notes")
  })

  it("refuses an unknown flow catchably instead of failing the run", async () => {
    const descriptor = await discovered("list")
    const result = await resolve(
      new Cell.Call({ ...callOf(descriptor, { path: "." }), flowName: "does-not-exist" })
    )

    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("is not in the registry")
  })

  it("refuses a module flow this host bound no implementation for", async () => {
    const descriptor = await discovered("list")
    const result = await resolve(callOf(descriptor, { path: "." }))

    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("no implementation bound")
  })

  it("refuses a markdown flow when the host runs none", async () => {
    const descriptor = await discovered("summarize")
    const result = await resolve(callOf(descriptor, { args: "x" }))

    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("runs none")
  })

  it("refuses a markdown flow whose input is not the fixed { args: string }", async () => {
    const descriptor = await discovered("summarize")
    const result = await resolve(callOf(descriptor, { wrong: 1 }), {
      prompt: () => Effect.succeed(succeeded("never"))
    })

    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("{ args: string }")
  })

  it("refuses a call whose declaration drifted from the one the cell chose", async () => {
    const descriptor = await discovered("list")
    const result = await resolve(
      callOf(descriptor, { path: "." }, { declaration: "a-stale-declaration-digest" }),
      {
        implementations: new Map([["list", () => Effect.succeed(succeeded(["never"]))]])
      }
    )

    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("changed after this cell was written")
  })

  it("refuses a call whose entry only changed its input schema", async () => {
    // The digest used to cover name, capabilities, effects, placement, the
    // body's PATH and provenance, so a refreshed registry could change what a
    // flow accepts behind an unchanged path and the drift check said nothing.
    // The call was then dispatched to a declaration the model had never seen
    // and came back as `invalid_input`, which asks the model to fix a call that
    // was right when it was written.
    const descriptor = await discovered("list")
    const moved = new Descriptor.FlowDescriptor({
      ...descriptor,
      input: new Descriptor.SchemaRefInline({ document: { type: "object", required: ["root"] } })
    })
    const result = await resolve(
      callOf(descriptor, { path: "." }, { declaration: Cell.declarationDigest(moved) }),
      { implementations: new Map([["list", () => Effect.succeed(succeeded(["never"]))]]) }
    )

    expect(result.code).toBe("declaration_changed")
    expect(result.message).toContain("changed after this cell was written")
  })

  it("lets an implementation failure travel in the error channel the cell cannot catch", async () => {
    const descriptor = await discovered("list")
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const resolver = CellCalls.make({
          registry,
          implementations: new Map<string, CellCalls.Implementation>([[
            "list",
            () => Effect.fail(new HarnessError({ code: "engine_failed", message: "permission required" }))
          ]])
        })
        return yield* resolver.run(callOf(descriptor, { path: "." }))
      }).pipe(Effect.provide(registryLayer()))
    )

    // A park is not a value the cell may observe, so it stays a failed effect
    // rather than becoming a catchable `failure` result.
    expect(exit._tag).toBe("Failure")
  })

  it("dispatches to an executable binding disclosed through the same registry", async () => {
    const seen: Array<unknown> = []
    const count = {
      capabilities: [],
      effects: undefined,
      name: "count",
      description: "Counts characters.",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ length: Schema.Number })
    } as const
    const binding = FlowBinding.make({
      flow: count,
      handler: (input) => Effect.sync(() => (seen.push(input), { length: input.text.length }))
    })
    const catalog = Result.getOrThrow(FlowBinding.catalogResult([binding]))

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = FlowBinding.registry(yield* Registry.Registry, catalog)
        const resolver = CellCalls.make({ registry, catalog })
        return yield* resolver.run(callOf(binding.descriptor, { text: "four" }))
      }).pipe(Effect.provide(registryLayer()), Effect.orDie)
    )

    expect(result).toMatchObject({ outcome: "success", value: { length: 4 } })
    expect(seen).toEqual([{ text: "four" }])
  })

  it("refuses a bound name whose disclosed declaration is a different flow", async () => {
    // The registry discovered `list`; a binding claims the same name with a
    // different declaration. Dispatching either one would be wrong, so the call
    // is refused catchably.
    const descriptor = await discovered("list")
    let ran = false
    const binding = FlowBinding.make({
      flow: ({
        capabilities: [],
        effects: undefined,
        name: "list",
        description: "A different list.",
        input: Schema.Struct({}),
        output: Schema.Struct({})
      } as const),
      handler: () => Effect.sync(() => ((ran = true), {}))
    })
    const catalog = Result.getOrThrow(FlowBinding.catalogResult([binding]))

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = FlowBinding.registry(yield* Registry.Registry, catalog)
        const resolver = CellCalls.make({ registry, catalog })
        return yield* resolver.run(callOf(descriptor, { path: "." }))
      }).pipe(Effect.provide(registryLayer()), Effect.orDie)
    )

    expect(ran).toBe(false)
    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("does not match the bound implementation")
  })

  it("fails the run when a markdown body cannot be loaded, without consulting the runner", async () => {
    const descriptor = await discovered("summarize")
    let ran = false
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const resolver = CellCalls.make({
          registry: Registry.makeNoop({
            getOption: () => Effect.succeed(Option.some(descriptor)),
            runPrompt: () =>
              Effect.fail(registryError({ code: "body_unavailable", method: "runPrompt", description: "gone" }))
          }),
          prompt: () =>
            Effect.sync(() => {
              ran = true
              return succeeded("never")
            })
        })
        return yield* resolver.run(callOf(descriptor, { args: "x" }))
      })
    )

    // The body vanished between disclosure and the call: that is the host's
    // problem, not a refusal the model could correct, so it is not a result.
    expect(ran).toBe(false)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toMatchObject({
      _tag: "/harness/HarnessError",
      code: "engine_failed",
      message: "The body of markdown flow summarize could not be loaded"
    })
  })

  it("answers from the executable binding even when an implementation shares the name", async () => {
    const seen: Array<string> = []
    const count = {
      capabilities: [],
      effects: undefined,
      name: "count",
      description: "Counts characters.",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ length: Schema.Number })
    } as const
    const binding = FlowBinding.make({
      flow: count,
      handler: (input) => Effect.sync(() => (seen.push("binding"), { length: input.text.length }))
    })
    const catalog = Result.getOrThrow(FlowBinding.catalogResult([binding]))

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = FlowBinding.registry(yield* Registry.Registry, catalog)
        const resolver = CellCalls.make({
          registry,
          catalog,
          implementations: new Map<string, CellCalls.Implementation>([[
            "count",
            () => Effect.sync(() => (seen.push("implementation"), succeeded({ length: 0 })))
          ]])
        })
        return yield* resolver.run(callOf(binding.descriptor, { text: "four" }))
      }).pipe(Effect.provide(registryLayer()), Effect.orDie)
    )

    // A binding is the implementation of the declaration it projected, so it
    // answers before the host's side table is consulted at all.
    expect(seen).toEqual(["binding"])
    expect(result).toMatchObject({ outcome: "success", value: { length: 4 } })
  })

  it("refuses input the bound declaration's own schema rejects", async () => {
    const count = {
      capabilities: [],
      effects: undefined,
      name: "count",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ length: Schema.Number })
    } as const
    const binding = FlowBinding.make({
      flow: count,
      handler: (input) => Effect.succeed({ length: input.text.length })
    })
    const catalog = Result.getOrThrow(FlowBinding.catalogResult([binding]))

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = FlowBinding.registry(yield* Registry.Registry, catalog)
        const resolver = CellCalls.make({ registry, catalog })
        return yield* resolver.run(callOf(binding.descriptor, { text: 7 }))
      }).pipe(Effect.provide(registryLayer()), Effect.orDie)
    )

    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("rejected its input")
  })

  it("prefers a bound markdown flow over the prompt runner that would render it", async () => {
    const descriptor = await discovered("summarize")
    let rendered = false
    const binding: FlowBinding.Binding = {
      descriptor,
      run: () => Effect.succeed(succeeded("bound answer"))
    }
    const catalog = Result.getOrThrow(FlowBinding.catalogResult([binding]))

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const resolver = CellCalls.make({
          registry,
          catalog,
          prompt: () =>
            Effect.sync(() => {
              rendered = true
              return succeeded("rendered answer")
            })
        })
        return yield* resolver.run(callOf(descriptor, { args: "the release notes" }))
      }).pipe(Effect.provide(registryLayer()), Effect.orDie)
    )

    expect(rendered).toBe(false)
    expect(result).toMatchObject({ outcome: "success", value: "bound answer" })
  })

  it("refuses a module flow when the catalog and the implementation table are both empty", async () => {
    const descriptor = await discovered("list")
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const resolver = CellCalls.make({
          registry,
          catalog: FlowBinding.empty(),
          implementations: new Map()
        })
        return yield* resolver.run(callOf(descriptor, { path: "." }))
      }).pipe(Effect.provide(registryLayer()), Effect.orDie)
    )

    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("no implementation bound")
  })

  it("refuses a name the implementation table holds under a different key", async () => {
    const descriptor = await discovered("list")
    const result = await resolve(callOf(descriptor, { path: "." }), {
      implementations: new Map<string, CellCalls.Implementation>([[
        "summarize",
        () => Effect.succeed(succeeded(["never"]))
      ]])
    })

    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("no implementation bound")
  })

  it("keeps a flow the registry hides from model invocation out of reach", async () => {
    const descriptor = await discovered("list")
    const hidden = new Descriptor.FlowDescriptor({ ...descriptor, modelInvocable: false })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const resolver = CellCalls.make({
          registry,
          implementations: new Map([["list", () => Effect.succeed(succeeded(["never"]))]])
        })
        return yield* resolver.run(callOf(hidden, { path: "." }))
      }).pipe(
        Effect.provide(Registry.layerFromDescriptors([hidden]).pipe(Layer.provide(platform))),
        Effect.orDie
      )
    )

    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("not model-invocable")
  })
})
