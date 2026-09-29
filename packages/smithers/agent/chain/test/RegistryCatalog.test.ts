import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Author from "../src/Author.ts"
import * as Catalog from "../src/Catalog.ts"
import type * as Event from "../src/Event.ts"
import * as RegistryCatalog from "../src/RegistryCatalog.ts"
import { flow, runChain, runOn } from "./harness.ts"

const effects = {
  mode: "expected",
  onConflict: "serialize",
  reads: ["**"],
  tier: "irreversible",
  writes: ["**"]
} as const

const descriptor = (options: {
  readonly name: string
  readonly description?: string
  readonly markdown?: boolean
  readonly model?: string
  readonly modelInvocable?: boolean
}): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    body: options.markdown === true
      ? new Descriptor.BodyRefMarkdown({ baseDirectory: "/flows", path: `/flows/${options.name}/flow.mdx` })
      : new Descriptor.BodyRefModule({ path: `/flows/${options.name}/flow.ts` }),
    capabilities: ["*"],
    description: options.description ?? `test flow ${options.name}`,
    effects,
    flows: [],
    frontmatter: {},
    input: new Descriptor.SchemaRefNone(),
    model: options.model === undefined ? Option.none() : Option.some(options.model),
    modelInvocable: options.modelInvocable ?? true,
    name: options.name,
    output: new Descriptor.SchemaRefNone(),
    path: `/flows/${options.name}`,
    placement: Option.none(),
    provenance: { root: "/flows", source: "test" }
  })

const registryOf = (
  descriptors: ReadonlyArray<Descriptor.FlowDescriptor>,
  overrides: Partial<Registry.Registry> = {}
): Layer.Layer<Registry.Registry> =>
  Layer.succeed(Registry.Registry)(
    Registry.makeNoop({
      getOption: (name) =>
        Effect.sync(() => {
          const found = descriptors.find((entry) => entry.name === name)
          return found === undefined ? Option.none() : Option.some(found)
        }),
      list: () => Effect.succeed(descriptors),
      visible: () => Effect.succeed(descriptors.filter((entry) => entry.modelInvocable)),
      ...overrides
    })
  )

const catalogFrom = (
  descriptors: ReadonlyArray<Descriptor.FlowDescriptor>,
  options: RegistryCatalog.Options = {},
  overrides: Partial<Registry.Registry> = {}
): Promise<Catalog.Service> =>
  runOn(registryOf(descriptors, overrides), RegistryCatalog.make(options))

const echoImplementation: RegistryCatalog.Implementation = (payload) => Effect.succeed({ echoed: payload })

describe("RegistryCatalog", () => {
  it("projects callable descriptors, hides invisible ones, and always carries the system entries", async () => {
    const implementations = new Map([["greet", echoImplementation], ["hidden", echoImplementation]])
    const catalog = await catalogFrom(
      [descriptor({ name: "greet" }), descriptor({ modelInvocable: false, name: "hidden" })],
      { implementations }
    )
    expect(catalog.entries.map((entry) => entry.name)).toEqual(["greet", "sys/now", "sys/random"])
    expect(catalog.lookup("hidden")).toBeUndefined()
    expect(catalog.lookup("sys/now")).toBeDefined()
  })

  it("honors a custom visibility predicate over the full list", async () => {
    const implementations = new Map([["greet", echoImplementation], ["hidden", echoImplementation]])
    const catalog = await catalogFrom(
      [descriptor({ name: "greet" }), descriptor({ modelInvocable: false, name: "hidden" })],
      { implementations, visible: () => true }
    )
    expect(catalog.entries.map((entry) => entry.name)).toEqual(["greet", "hidden", "sys/now", "sys/random"])
  })

  it("does not project a markdown flow without a prompt runner, nor a module flow without an implementation", async () => {
    const catalog = await catalogFrom([
      descriptor({ markdown: true, name: "summarize" }),
      descriptor({ name: "unbound" })
    ])
    expect(catalog.entries.map((entry) => entry.name)).toEqual(["sys/now", "sys/random"])
  })

  it("dies at construction when implementations bind unknown flows", async () => {
    const implementations = new Map([["typo/greet", echoImplementation]])
    await expect(
      catalogFrom([descriptor({ name: "greet" })], { implementations })
    ).rejects.toThrow("implementations bind flows the registry does not know: typo/greet")
  })

  it("pins the full declaration digest, including model and body axes", async () => {
    const base = descriptor({ name: "greet" })
    expect(RegistryCatalog.declarationDigest(base))
      .not.toBe(RegistryCatalog.declarationDigest(descriptor({ description: "changed", name: "greet" })))
    expect(RegistryCatalog.declarationDigest(base))
      .not.toBe(RegistryCatalog.declarationDigest(descriptor({ model: "anthropic:claude-fable-5", name: "greet" })))
    expect(RegistryCatalog.declarationDigest(base))
      .not.toBe(RegistryCatalog.declarationDigest(descriptor({ markdown: true, name: "greet" })))

    const implementations = new Map([["greet", echoImplementation]])
    const catalog = await catalogFrom([base], { implementations })
    const entry = catalog.lookup("greet") as Catalog.Entry
    expect(entry.digest).toBe(RegistryCatalog.declarationDigest(base))
    expect(Catalog.entryDigest(entry)).toBe(RegistryCatalog.declarationDigest(base))
  })

  it("keys entries on the registry's declaration identity, not a second one", () => {
    // Two hand-rolled digests of one `FlowDescriptor` meant a field added to
    // the descriptor had to be remembered in two packages, and a miss silently
    // changed what one of them re-keyed. There is one identity, and it is
    // owned by the package that owns the type.
    expect(RegistryCatalog.declarationDigest).toBe(Descriptor.declarationDigest)
  })

  it.each([
    ["modelInvocable", { modelInvocable: false }],
    ["path", { path: "/elsewhere/greet" }],
    ["frontmatter", { frontmatter: { title: "Greet" } }],
    ["budget", { budget: { tokens: 4_096 } }],
    ["provenance.root", { provenance: new Descriptor.Provenance({ root: "/elsewhere", source: "test" }) }],
    ["provenance.source", { provenance: new Descriptor.Provenance({ root: "/flows", source: "installed" }) }]
  ] as ReadonlyArray<readonly [string, Partial<Descriptor.FlowDescriptor>]>)(
    "re-keys when %s changes",
    (_field, change) => {
      // Each of these was invisible to the catalog's own digest: two
      // declarations differing only here keyed identically, so a refreshed
      // registry could move one without the entry digest noticing.
      const base = descriptor({ name: "greet" })
      expect(RegistryCatalog.declarationDigest(new Descriptor.FlowDescriptor({ ...base, ...change })))
        .not.toBe(RegistryCatalog.declarationDigest(base))
    }
  )

  it("treats capabilities as a set", () => {
    const base = descriptor({ name: "greet" })
    const reordered = new Descriptor.FlowDescriptor({ ...base, capabilities: ["fs:read", "fs:write"] })
    const declared = new Descriptor.FlowDescriptor({ ...base, capabilities: ["fs:write", "fs:read"] })
    expect(RegistryCatalog.declarationDigest(reordered)).toBe(RegistryCatalog.declarationDigest(declared))
  })

  it("renders a markdown flow then hands it to the prompt runner", async () => {
    const ran: Array<{ rendered: string; name: string }> = []
    const prompt: RegistryCatalog.PromptRunner = (rendered, flowDescriptor) =>
      Effect.sync(() => {
        ran.push({ name: flowDescriptor.name, rendered })
        return `executed: ${rendered}`
      })
    const catalog = await catalogFrom(
      [descriptor({ markdown: true, name: "summarize" })],
      { prompt },
      { runPrompt: (name, input) => Effect.succeed(`TEMPLATE(${name}, ${input.args})`) }
    )
    const entry = catalog.lookup("summarize") as Catalog.Entry
    const fromObject = await Effect.runPromise(entry.handler({ args: "the diff" }) as Effect.Effect<never>)
    const fromString = await Effect.runPromise(entry.handler("raw text") as Effect.Effect<never>)
    expect(fromObject).toBe("executed: TEMPLATE(summarize, the diff)")
    expect(fromString).toBe("executed: TEMPLATE(summarize, raw text)")
    expect(ran).toHaveLength(2)
  })

  it("refuses a markdown payload that is not { args: string }", async () => {
    const catalog = await catalogFrom(
      [descriptor({ markdown: true, name: "summarize" })],
      { prompt: (rendered) => Effect.succeed(rendered) }
    )
    const entry = catalog.lookup("summarize") as Catalog.Entry
    for (const payload of [{ args: 42 }, { other: 1 }, 42, null]) {
      const error = await Effect.runPromise(
        Effect.flip(entry.handler(payload)) as Effect.Effect<Catalog.CallError>
      )
      expect(error.message).toContain("{ args: string }")
    }
  })

  it("refuses a call when the registry was redeclared after projection", async () => {
    const original = descriptor({ markdown: true, name: "summarize" })
    const redeclared = descriptor({ description: "new declaration", markdown: true, name: "summarize" })
    const catalog = await catalogFrom(
      [original],
      { prompt: (rendered) => Effect.succeed(rendered) },
      { getOption: () => Effect.succeed(Option.some(redeclared)) }
    )
    const entry = catalog.lookup("summarize") as Catalog.Entry
    const error = await Effect.runPromise(
      Effect.flip(entry.handler({ args: "x" })) as Effect.Effect<Catalog.CallError>
    )
    expect(error.message).toContain("redeclared since this catalog was built")
  })

  it("surfaces a failing runPrompt as a typed call error", async () => {
    const catalog = await catalogFrom(
      [descriptor({ markdown: true, name: "summarize" })],
      { prompt: (rendered) => Effect.succeed(rendered) },
      { runPrompt: () => Effect.fail({ message: "prompt engine down" } as never) }
    )
    const entry = catalog.lookup("summarize") as Catalog.Entry
    const error = await Effect.runPromise(
      Effect.flip(entry.handler({ args: "x" })) as Effect.Effect<Catalog.CallError>
    )
    expect(error.message).toContain("prompt engine down")
  })

  it("composes host extras between the projection and the system entries", async () => {
    const extra: Catalog.Entry = {
      description: "host extra",
      handler: () => Effect.succeed("extra"),
      name: "host/extra"
    }
    const catalog = await catalogFrom([], { entries: [extra] })
    expect(catalog.entries.map((entry) => entry.name)).toEqual(["host/extra", "sys/now", "sys/random"])
  })

  it("feeds a chain whose script calls a registry-backed entry, pinning the declaration digest", async () => {
    const implementations = new Map<string, RegistryCatalog.Implementation>([
      ["repo/greet", () => Effect.succeed("hello from the registry")]
    ])
    const script = flow(
      `const greeting = await ctx.call("repo/greet", {})`,
      `return done(greeting)`
    )
    const { events, outcome } = await runChain({
      author: Author.layerMock([script]),
      catalog: RegistryCatalog.layer({ implementations }).pipe(
        Layer.provide(registryOf([descriptor({ name: "repo/greet" })]))
      )
    })
    expect(outcome).toEqual({ _tag: "Done", value: "hello from the registry" })
    const call = events.find((event) =>
      event._tag === "CallSettled" && event.name === "repo/greet"
    ) as Event.CallSettled
    expect(call.key.entryDigest).toBe(
      RegistryCatalog.declarationDigest(descriptor({ name: "repo/greet" }))
    )
  })
})
