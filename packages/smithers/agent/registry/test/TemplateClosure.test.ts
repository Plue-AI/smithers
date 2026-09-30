/** Executable template substitutions retain the same closure identity as ordinary imports. */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { fileURLToPath } from "node:url"
import * as Descriptor from "../src/Descriptor.ts"
import * as Executable from "../src/Executable.ts"
import * as ModuleClosure from "../src/internal/ModuleClosure.ts"
import * as Registry from "../src/Registry.ts"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const modulesRoot = fileURLToPath(new URL("./fixtures/executable/modules", import.meta.url))
const template = (expression: string) => "`${" + expression + "}`"
const nested = (expression: string, depth: number) => {
  for (let index = 0; index < depth; index++) expression = template(expression)
  return expression
}
const literal = "(await import(\"./helper.ts\")).priority"
const source = (expression: string, prefix = "") =>
  [
    "import { Annotations } from \"@smthrs/core\"",
    "import { Flow } from \"@smthrs/flow\"",
    "import { Node } from \"@smthrs/plan\"",
    "import { Schema } from \"effect\"",
    prefix,
    `const priority = Number(${expression})`,
    "export default Flow.make(\"entry\", {",
    "description: \"A measured template flow.\", payload: {}, success: Schema.Number,",
    "body: () => Node.succeed(priority)",
    "}).annotate(Annotations.Priority, priority)"
  ].join("\n")

const project = (entry: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ directory: modulesRoot, prefix: ".template-" })
    yield* fs.makeDirectory(`${root}/flows/entry`, { recursive: true })
    yield* fs.writeFileString(`${root}/flows/entry/flow.ts`, entry)
    yield* fs.writeFileString(`${root}/flows/entry/helper.ts`, "export const priority = 7")
    return root
  })

describe("template closure tokens", () => {
  it.each([1, 2, 3, 64])("measures literal imports at nesting depth %i", (depth) => {
    const found = ModuleClosure.specifiersOf(source(nested(literal, depth)))
    expect(found.relative).toEqual(["./helper.ts"])
    expect(found.opaque).toBe(0)
  })

  it.each([
    template("({ closing: \"}\" }).closing && " + literal),
    template("/[}]/.test(\"}\") ? " + literal + " : 0"),
    template("/* } ` */ " + literal + " // }\n"),
    template("(() => { const v = { end: \"}\" }; return " + literal + " })()")
  ])("keeps expression braces, comments and regular expressions distinct: %s", (expression) => {
    expect(ModuleClosure.specifiersOf(source(expression)).relative).toEqual(["./helper.ts"])
  })

  it("measures every substitution while leaving text and escaped substitutions inert", () => {
    const found = ModuleClosure.specifiersOf(
      "`import(\"./text.ts\") \\${import(\"./escaped.ts\")} ${import(\"./one.ts\")} tail ${import(\"./two.ts\")}`"
    )
    expect(found.relative).toEqual(["./one.ts", "./two.ts"])
    expect(found.opaque).toBe(0)
  })

  it.each([
    template("await import(\"./\" + \"helper.ts\")"),
    nested(literal, 65),
    "`unfinished ${import(\"./helper.ts\")",
    "`unfinished text"
  ])("refuses computed, excessive or unfinished source: %s", (expression) => {
    expect(ModuleClosure.specifiersOf(source(expression)).opaque).toBeGreaterThan(0)
  })
})

describe("native loading of template closures", () => {
  for (const depth of [1, 2, 3]) {
    it.effect(`measures depth ${depth} and refuses runtime loading before importing`, () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* project(source(nested(literal, depth)))
        const registry = Registry.layerProject({ root })
        const read = Effect.flatMap(Registry.Registry, (registry) => registry.get("entry")).pipe(
          Effect.provide(registry)
        )
        const before = yield* read
        expect((before.body as Descriptor.BodyRefModule).imports?.map((item) => item.path)).toEqual(["helper.ts"])
        const unsupported = yield* Effect.flip(Executable.fromDescriptor(before, { delegates: [] }))
        expect(unsupported.code).toBe("body_unavailable")
        expect(unsupported.message).toContain("runtime module cache")
        yield* fs.writeFileString(`${root}/flows/entry/helper.ts`, "export const priority = 9")
        const failure = yield* Effect.flip(Executable.fromDescriptor(before, { delegates: [] }))
        expect(failure.code).toBe("body_unavailable")
        expect(failure.message).toContain("changed")
        const after = yield* read
        expect(Descriptor.executionDigest(after)).not.toBe(Descriptor.executionDigest(before))
        expect((yield* fs.readDirectory(`${root}/flows/entry`)).filter((name) => name.startsWith(".smithers-")))
          .toEqual([])
      }).pipe(Effect.scoped, Effect.provide(platform)))
  }

  it.effect("retains the ordinary static-import refusal control", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* project(source("helper", "import { priority as helper } from \"./helper.ts\""))
      const before = yield* Effect.flatMap(Registry.Registry, (registry) => registry.get("entry")).pipe(
        Effect.provide(Registry.layerProject({ root }))
      )
      expect((yield* Executable.fromDescriptor(before, { delegates: [] })).lowered.priority).toBe(7)
      yield* fs.writeFileString(`${root}/flows/entry/helper.ts`, "export const priority = 9")
      expect((yield* Effect.flip(Executable.fromDescriptor(before, { delegates: [] }))).code).toBe("body_unavailable")
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("refuses a computed interpolation through the default native loader", () =>
    Effect.gen(function*() {
      const root = yield* project(source(template("(await import(\"./\" + \"helper.ts\")).priority")))
      const descriptor = yield* Effect.flatMap(Registry.Registry, (registry) => registry.get("entry")).pipe(
        Effect.provide(Registry.layerProject({ root }))
      )
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, { delegates: [] }))
      expect(failure.code).toBe("body_unavailable")
      expect(failure.message).toContain("cannot pin")
    }).pipe(Effect.scoped, Effect.provide(platform)))
})
