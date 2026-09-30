/** Unit controls for the private locator projection; loaders are tested independently with real files. */
import { Registry } from "@smthrs/registry"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as RegistryWorkspace from "../src/internal/RegistryWorkspace.ts"

const descriptor = (path: string, markdown = false) =>
  new Descriptor.FlowDescriptor({
    name: "steps",
    description: "Retained",
    path,
    body: markdown
      ? new Descriptor.BodyRefMarkdown({ path: `${path}/SKILL.md`, baseDirectory: path, contentDigest: "a".repeat(64) })
      : new Descriptor.BodyRefModule({
        path: `${path}/flow.ts`,
        contentDigest: "a".repeat(64),
        imports: [{ path: "../shared.ts", contentDigest: "b".repeat(64) }]
      }),
    input: new Descriptor.SchemaRefModule({ path: `${path}/flow.ts`, field: "input" }),
    output: new Descriptor.SchemaRefModule({ path: `${path}/flow.ts`, field: "output" }),
    model: Option.none(),
    placement: Option.none(),
    modelInvocable: true,
    flows: [],
    capabilities: [],
    frontmatter: {},
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    provenance: new Descriptor.Provenance({ source: "project", root: "/retained/flows" })
  })

describe("retained workspace registry identity", () => {
  it("keeps an ordinary registry unchanged", () => {
    const original = Registry.layerNoop()
    expect(RegistryWorkspace.layer(original, "/project", "/project/.")).toBe(original)
  })

  it.each([false, true])("projects every locator while loading the retained bytes (markdown=%s)", async (markdown) => {
    let entry = descriptor("/retained/flows/steps", markdown)
    const reads: Array<{ name: string; digest: string | undefined }> = []
    let refreshes = 0
    const physical = Registry.makeNoop({
      list: () => Effect.succeed([entry]),
      visible: () => Effect.succeed([entry]),
      get: () => Effect.succeed(entry),
      getOption: (name) => Effect.succeed(name === entry.name ? Option.some(entry) : Option.none()),
      refresh: () =>
        Effect.sync(() => {
          refreshes++
          entry = new Descriptor.FlowDescriptor({ ...entry, description: "Changed" })
        }),
      loadBody: (name, digest) =>
        Effect.sync(() => {
          reads.push({ name, digest })
          return new Descriptor.FlowBodyModule({ path: entry.body.path })
        })
    })
    await Effect.runPromise(
      Effect.gen(function*() {
        const projected = yield* Registry.Registry
        const selected = yield* projected.get("steps")
        expect(selected.path).toBe("/project/flows/steps")
        expect(selected.body.path).toBe(`/project/flows/steps/${markdown ? "SKILL.md" : "flow.ts"}`)
        expect(selected.provenance.root).toBe("/project/flows")
        expect(selected.input).toMatchObject({ _tag: "Module", path: "/project/flows/steps/flow.ts" })
        expect(selected.output).toMatchObject({ _tag: "Module", path: "/project/flows/steps/flow.ts" })
        if (selected.body._tag === "Markdown") expect(selected.body.baseDirectory).toBe(selected.path)
        else expect(selected.body.imports).toEqual(entry.body._tag === "Module" ? entry.body.imports : undefined)
        expect((yield* projected.list())[0]).toEqual(selected)
        expect((yield* projected.visible())[0]).toEqual(selected)
        expect(Option.getOrUndefined(yield* projected.getOption("steps"))).toEqual(selected)
        expect(yield* projected.getOption("missing")).toEqual(Option.none())
        const digest = Descriptor.executionDigest(selected)
        expect(digest).not.toBe(Descriptor.executionDigest(entry))
        expect(yield* projected.loadBody("steps", digest)).toMatchObject({ path: entry.body.path })
        yield* projected.loadBody("steps")
        expect(reads).toEqual(
          Array.from({ length: 2 }, () => ({ name: "steps", digest: Descriptor.executionDigest(entry) }))
        )
        // A physical-workspace digest is never interchangeable with the approved
        // identity digest, even though the underlying loader would accept it.
        for (const wrong of [Descriptor.executionDigest(entry), "0".repeat(64)]) {
          expect((yield* Effect.flip(projected.loadBody("steps", wrong))).code).toBe("execution_changed")
        }
        expect(reads).toHaveLength(2)
        yield* projected.refresh()
        expect(refreshes).toBe(1)
        expect((yield* projected.get("steps")).description).toBe("Changed")
      }).pipe(
        Effect.provide(RegistryWorkspace.layer(Layer.succeed(Registry.Registry, physical), "/project", "/retained"))
      )
    )
  })

  it.each(["/external/steps", "/retained-sibling/steps", "file:///retained/flows/steps"])(
    "preserves external provenance and file URL spelling: %s",
    async (path) => {
      const entry = new Descriptor.FlowDescriptor({
        ...descriptor(path),
        input: new Descriptor.SchemaRefNone(),
        output: new Descriptor.SchemaRefInline({ document: {} })
      })
      const value = await Effect.runPromise(
        Effect.flatMap(Registry.Registry, (registry) => registry.get("steps")).pipe(
          Effect.provide(
            RegistryWorkspace.layer(Registry.layerNoop({ get: () => Effect.succeed(entry) }), "/project", "/retained")
          )
        )
      )
      expect(value.path).toBe(path.startsWith("file:") ? "file:///project/flows/steps" : path)
      expect(value.body.path).toBe(path.startsWith("file:") ? "file:///project/flows/steps/flow.ts" : entry.body.path)
      expect(value.input).toEqual(entry.input)
      expect(value.output).toEqual(entry.output)
    }
  )
})
