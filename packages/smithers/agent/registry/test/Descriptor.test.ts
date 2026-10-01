import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as Disclosure from "../src/Disclosure.ts"

describe("inputDocument", () => {
  it("returns the inline document without interpreting or replacing it", () => {
    const document = { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
    expect(Descriptor.inputDocument(new Descriptor.SchemaRefInline({ document }))).toBe(document)
  })

  it("round-trips optional module metadata while preserving the authoritative decoder locator", () => {
    const document = Schema.decodeUnknownSync(Schema.Json)(
      Schema.toJsonSchemaDocument(Schema.Struct({ value: Schema.String }))
    )
    const ref = new Descriptor.SchemaRefModule({ path: "/flow.ts", field: "input", document })
    const restored = Schema.decodeUnknownSync(Descriptor.SchemaRef)(Schema.encodeSync(Descriptor.SchemaRef)(ref))
    expect(restored).toEqual(ref)
    expect(Descriptor.inputDocument(restored)).toEqual(document)
    expect(Schema.decodeUnknownSync(Descriptor.SchemaRef)({ _tag: "Module", path: "/legacy.ts", field: "input" }))
      .toEqual(new Descriptor.SchemaRefModule({ path: "/legacy.ts", field: "input" }))
  })

  it("describes markdown input as one required string argument", () => {
    expect(Descriptor.inputDocument(new Descriptor.SchemaRefMarkdownArgs({}))).toMatchObject({
      schema: {
        type: "object",
        properties: { args: { type: "string" } },
        required: ["args"],
        // Effect's input projection permits excess properties, just as decoding does.
        additionalProperties: true
      }
    })
  })

  it.each([
    undefined,
    new Descriptor.SchemaRefNone({}),
    new Descriptor.SchemaRefMarkdownOutput({}),
    new Descriptor.SchemaRefModule({ path: "/not-evaluated.ts", field: "input" })
  ])("leaves unavailable input metadata undefined (%s)", (ref) => {
    // A locator is not a JSON Schema, and reading input metadata never loads it.
    expect(Descriptor.inputDocument(ref)).toBeUndefined()
  })
})

describe("FlowDescriptor", () => {
  it("round-trips every descriptor field", () => {
    const descriptor = new Descriptor.FlowDescriptor({
      name: "review/read-pr",
      description: "Review a pull request",
      body: new Descriptor.BodyRefMarkdown({
        path: "/project/flows/review/read-pr/flow.mdx",
        baseDirectory: "/project/flows/review/read-pr"
      }),
      input: new Descriptor.SchemaRefMarkdownArgs({}),
      output: new Descriptor.SchemaRefModule({ path: "/project/flows/review/read-pr/flow.ts", field: "output" }),
      model: Option.some("smart"),
      flows: ["read-pr"],
      capabilities: ["git:read", "net:get"],
      effects: {
        reads: ["src/**"],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      placement: Option.some("sandbox"),
      modelInvocable: true,
      path: "/project/flows/review/read-pr/flow.mdx",
      frontmatter: { description: "Review a pull request", retained: { raw: true } },
      provenance: new Descriptor.Provenance({ source: "project", root: "/project/flows" })
    })

    const encoded = Schema.encodeSync(Descriptor.FlowDescriptor)(descriptor)
    const decoded = Schema.decodeUnknownSync(Descriptor.FlowDescriptor)(encoded)

    expect(encoded).toMatchObject({
      name: "review/read-pr",
      description: "Review a pull request",
      body: {
        _tag: "Markdown",
        path: "/project/flows/review/read-pr/flow.mdx",
        baseDirectory: "/project/flows/review/read-pr"
      },
      input: { _tag: "MarkdownArgs" },
      output: { _tag: "Module", path: "/project/flows/review/read-pr/flow.ts", field: "output" },
      capabilities: ["git:read", "net:get"],
      model: { _tag: "Some", value: "smart" },
      flows: ["read-pr"],
      effects: {
        reads: ["src/**"],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      modelInvocable: true,
      path: "/project/flows/review/read-pr/flow.mdx",
      frontmatter: { description: "Review a pull request", retained: { raw: true } },
      provenance: { source: "project", root: "/project/flows" }
    })
    expect(Option.getOrThrow(decoded.placement)).toBe("sandbox")
    expect(decoded).toEqual(descriptor)
    expect(() => JSON.stringify(encoded)).not.toThrow()
    expect(Descriptor.executionDigest(descriptor)).toBeUndefined()
    const measured = new Descriptor.FlowDescriptor({
      ...descriptor,
      body: new Descriptor.BodyRefMarkdown({
        path: descriptor.body.path,
        baseDirectory: "/project/flows/review/read-pr",
        contentDigest: "a".repeat(64)
      })
    })
    const identity = Descriptor.executionDigest(measured)
    expect(identity).toMatch(/^[0-9a-f]{64}$/)
    expect(Descriptor.executionDigest(
      Schema.decodeUnknownSync(Descriptor.FlowDescriptor)(
        Schema.encodeSync(Descriptor.FlowDescriptor)(measured)
      )
    )).toBe(identity)
    expect(Descriptor.executionDigest(new Descriptor.FlowDescriptor({ ...measured, model: Option.some("other") })))
      .not.toBe(identity)
    expect(
      Descriptor.executionDigest(new Descriptor.FlowDescriptor({ ...measured, frontmatter: { temperature: 0.2 } }))
    )
      .not.toBe(identity)
  })

  it("encodes one descriptor once, however many hosts ask for its execution identity", () => {
    // A host maps `executionDigest` over every descriptor it lists, on every
    // plan and every listing, so the second ask must not walk the descriptor
    // again. The counter is the walk: encoding reads every field.
    const measured = new Descriptor.FlowDescriptor({
      name: "review/read-pr",
      description: "Review a pull request",
      body: new Descriptor.BodyRefMarkdown({
        path: "/project/flows/review/read-pr/flow.mdx",
        baseDirectory: "/project/flows/review/read-pr",
        contentDigest: "b".repeat(64)
      }),
      input: new Descriptor.SchemaRefMarkdownArgs({}),
      output: new Descriptor.SchemaRefNone(),
      model: Option.none(),
      flows: [],
      capabilities: [],
      effects: {
        reads: [],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      placement: Option.none(),
      modelInvocable: true,
      path: "/project/flows/review/read-pr/flow.mdx",
      frontmatter: {},
      provenance: new Descriptor.Provenance({ source: "project", root: "/project/flows" })
    })
    let reads = 0
    Object.defineProperty(measured, "description", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads++
        return "Review a pull request"
      }
    })

    const first = Descriptor.executionDigest(measured)
    const encoded = reads
    const second = Descriptor.executionDigest(measured)

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(encoded).toBeGreaterThan(0)
    expect(second).toBe(first)
    expect(reads).toBe(encoded)
  })

  it("retains tagged body and schema reference variants", () => {
    expect(Schema.decodeUnknownSync(Descriptor.BodyRef)({ _tag: "Module", path: "/project/flow.ts" })).toEqual(
      new Descriptor.BodyRefModule({ path: "/project/flow.ts" })
    )
    expect(
      Schema.decodeUnknownSync(Descriptor.FlowBody)({
        _tag: "Prompt",
        text: "Use the available tools.",
        baseDirectory: "/project/flows/review"
      })
    ).toEqual(
      new Descriptor.FlowBodyPrompt({
        text: "Use the available tools.",
        baseDirectory: "/project/flows/review"
      })
    )
    expect(Schema.decodeUnknownSync(Descriptor.SchemaRef)({ _tag: "MarkdownOutput" })).toEqual(
      new Descriptor.SchemaRefMarkdownOutput({})
    )
    expect(Schema.decodeUnknownSync(Descriptor.SchemaRef)({ _tag: "None" })).toEqual(new Descriptor.SchemaRefNone({}))
  })

  it("round-trips an inline input schema", () => {
    const document = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        command: { type: "string" },
        reads: { type: "array", items: { type: "string" } }
      },
      required: ["command"],
      additionalProperties: false
    }
    const input = new Descriptor.SchemaRefInline({ document })
    const encodedInput = Schema.encodeSync(Descriptor.SchemaRef)(input)

    expect(input.document).toEqual(document)
    expect(encodedInput).toEqual({ _tag: "Inline", document })
    expect(Schema.decodeUnknownSync(Descriptor.SchemaRef)(encodedInput)).toEqual(input)

    const descriptor = new Descriptor.FlowDescriptor({
      name: "shell",
      description: "Runs a shell command",
      body: new Descriptor.BodyRefModule({ path: "/project/flows/shell/flow.ts" }),
      input,
      output: new Descriptor.SchemaRefNone({}),
      model: Option.none(),
      flows: [],
      capabilities: [],
      effects: {
        reads: [],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      placement: Option.none(),
      modelInvocable: true,
      path: "/project/flows/shell/flow.ts",
      frontmatter: {},
      provenance: new Descriptor.Provenance({ source: "project", root: "/project/flows" })
    })
    const encodedDescriptor = Schema.encodeSync(Descriptor.FlowDescriptor)(descriptor)

    expect(Schema.decodeUnknownSync(Descriptor.FlowDescriptor)(encodedDescriptor)).toEqual(descriptor)
  })

  it("round-trips a declared budget and answers an absent one as unbounded", () => {
    const base = {
      name: "review",
      description: "Review a pull request",
      body: new Descriptor.BodyRefMarkdown({
        path: "/project/flows/review/SKILL.md",
        baseDirectory: "/project/flows/review"
      }),
      input: new Descriptor.SchemaRefMarkdownArgs({}),
      output: new Descriptor.SchemaRefMarkdownOutput({}),
      model: Option.none<string>(),
      flows: [],
      capabilities: [],
      effects: {
        reads: [],
        writes: [],
        mode: "hermetic" as const,
        onConflict: "serialize" as const,
        tier: "sealed" as const
      },
      placement: Option.none<Descriptor.Placement>(),
      modelInvocable: true,
      path: "/project/flows/review/SKILL.md",
      frontmatter: {},
      provenance: new Descriptor.Provenance({ source: "project", root: "/project/flows" })
    }
    const declared = new Descriptor.FlowDescriptor({ ...base, budget: { tokens: 120000, milliseconds: 900000 } })
    const undeclared = new Descriptor.FlowDescriptor(base)

    // A descriptor crosses into a control-plane envelope as JSON, so the two
    // ceilings have to survive the encode a plan is stored under.
    const encoded = Schema.encodeSync(Descriptor.FlowDescriptor)(declared)
    expect(encoded).toMatchObject({ budget: { tokens: 120000, milliseconds: 900000 } })
    expect(Schema.decodeUnknownSync(Descriptor.FlowDescriptor)(encoded)).toEqual(declared)
    expect(Descriptor.budgetOf(declared)).toEqual({ tokens: 120000, milliseconds: 900000 })

    // Absent is unbounded, and it is the named value rather than a fresh empty
    // object, so a host cannot mistake one host's silence for another's.
    expect(undeclared.budget).toBeUndefined()
    expect(Descriptor.budgetOf(undeclared)).toBe(Descriptor.budgetUnbounded)
    expect(Descriptor.budgetUnbounded).toEqual({})
  })

  it.each([
    ["MarkdownArgs", new Descriptor.SchemaRefMarkdownArgs({}), Descriptor.SchemaRefMarkdownArgs],
    ["MarkdownOutput", new Descriptor.SchemaRefMarkdownOutput({}), Descriptor.SchemaRefMarkdownOutput],
    [
      "Module",
      new Descriptor.SchemaRefModule({ path: "/project/flows/review/flow.ts", field: "input" }),
      Descriptor.SchemaRefModule
    ],
    ["None", new Descriptor.SchemaRefNone({}), Descriptor.SchemaRefNone],
    ["Inline", new Descriptor.SchemaRefInline({ document: { type: "string" } }), Descriptor.SchemaRefInline]
  ])("decodes the %s schema reference from its encoded form", (_tag, reference, Variant) => {
    const encoded = Schema.encodeSync(Descriptor.SchemaRef)(reference)
    const decoded = Schema.decodeUnknownSync(Descriptor.SchemaRef)(encoded)

    expect(decoded).toBeInstanceOf(Variant)
    expect(decoded).toEqual(reference)
  })

  it("keeps warning codes stable", () => {
    const warning = Schema.decodeUnknownSync(Descriptor.DiscoveryWarning)({
      code: "unsupported_input_schema",
      path: "/project/flows/review/flow.mdx",
      message: "Markdown flows use the fixed args schema"
    })

    expect(warning.code).toBe("unsupported_input_schema")
    expect(
      Schema.decodeUnknownOption(Descriptor.DiscoveryWarning)({
        code: "unsupported-schema",
        path: "/project/flows/review/flow.mdx",
        message: "invalid"
      })
    ).toEqual(Option.none())
  })
})

describe("declarationDigest", () => {
  const base = new Descriptor.FlowDescriptor({
    name: "inspect",
    description: "Inspect one value.",
    body: new Descriptor.BodyRefModule({ path: "flows/inspect.ts", contentDigest: "1".repeat(64) }),
    input: new Descriptor.SchemaRefInline({ document: { type: "object" } }),
    output: new Descriptor.SchemaRefInline({ document: { type: "string" } }),
    model: Option.some("anthropic/claude"),
    flows: ["inspect/child"],
    capabilities: ["fs:write", "fs:read"],
    effects: { reads: ["src/**"], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.some("sandbox"),
    modelInvocable: true,
    budget: { tokens: 4_096, milliseconds: 30_000 },
    path: "flows/inspect.ts",
    frontmatter: { retries: 2, title: "Inspect" },
    provenance: new Descriptor.Provenance({
      source: "project",
      root: "/repo",
      pack: { name: "tools", version: "1.0.0", origin: "local" }
    })
  })

  /** Every material descriptor field, and a declaration differing only there. */
  const material: ReadonlyArray<readonly [string, Partial<Descriptor.FlowDescriptor>]> = [
    ["name", { name: "inspect2" }],
    ["description", { description: "Inspect two values." }],
    ["body", {
      body: new Descriptor.BodyRefModule({ path: "flows/inspect2.ts", contentDigest: "1".repeat(64) })
    }],
    ["body contents", {
      body: new Descriptor.BodyRefModule({ path: "flows/inspect.ts", contentDigest: "2".repeat(64) })
    }],
    ["input", { input: new Descriptor.SchemaRefInline({ document: { type: "number" } }) }],
    ["output", { output: new Descriptor.SchemaRefInline({ document: { type: "number" } }) }],
    ["model", { model: Option.some("openai/gpt") }],
    ["flows", { flows: ["inspect/other-child"] }],
    ["capabilities", { capabilities: ["fs:write", "fs:read", "net:read"] }],
    ["effects", {
      effects: { reads: ["src/**"], writes: ["src/**"], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
    }],
    ["placement", { placement: Option.some("remote") }],
    ["modelInvocable", { modelInvocable: false }],
    ["budget", { budget: undefined }],
    ["path", { path: "elsewhere/inspect.ts" }],
    ["frontmatter", { frontmatter: { retries: 3, title: "Inspect" } }],
    ["provenance.source", {
      provenance: new Descriptor.Provenance({ source: "installed", root: "/repo", pack: base.provenance.pack })
    }],
    ["provenance.root", {
      provenance: new Descriptor.Provenance({ source: "project", root: "/elsewhere", pack: base.provenance.pack })
    }]
  ]

  it.each(material)("changes when %s changes", (_field, change) => {
    // Every consumer keys on this number: `@smthrs/chain` keys catalog entries
    // with it and `@smthrs/harness` raises `declaration_changed` from it. A
    // field it does not cover is a field a refreshed registry can move without
    // any of them noticing, and the call is then dispatched to a declaration
    // nobody approved.
    expect(Descriptor.declarationDigest(new Descriptor.FlowDescriptor({ ...base, ...change })))
      .not.toBe(Descriptor.declarationDigest(base))
  })

  it("deliberately excludes pack provenance", () => {
    expect(Descriptor.declarationDigest(
      new Descriptor.FlowDescriptor({
        ...base,
        provenance: new Descriptor.Provenance({
          source: base.provenance.source,
          root: base.provenance.root,
          pack: { name: "tools", version: "2.0.0", origin: "installed" }
        })
      })
    )).toBe(Descriptor.declarationDigest(base))
  })

  it("does not depend on key order or on capability order", () => {
    const reordered = new Descriptor.FlowDescriptor({
      provenance: base.provenance,
      frontmatter: { title: "Inspect", retries: 2 },
      path: base.path,
      budget: base.budget,
      modelInvocable: base.modelInvocable,
      placement: base.placement,
      effects: base.effects,
      capabilities: ["fs:read", "fs:write"],
      flows: base.flows,
      model: base.model,
      output: base.output,
      input: base.input,
      body: base.body,
      description: base.description,
      name: base.name
    })

    expect(Descriptor.declarationDigest(reordered)).toBe(Descriptor.declarationDigest(base))
  })

  it("binds host import disclosure into both identities", () => {
    const native = new Descriptor.FlowDescriptor({
      ...base,
      body: new Descriptor.BodyRefModule({
        path: base.body.path,
        contentDigest: base.body.contentDigest,
        hostImports: ["microsandbox", "node:fs"]
      })
    })
    const changed = new Descriptor.FlowDescriptor({
      ...base,
      body: new Descriptor.BodyRefModule({
        path: base.body.path,
        contentDigest: base.body.contentDigest,
        hostImports: ["node:child_process"]
      })
    })
    expect(Descriptor.executionDigest(native)).not.toBe(Descriptor.executionDigest(base))
    expect(Descriptor.executionDigest(native)).not.toBe(Descriptor.executionDigest(changed))
    expect(Descriptor.declarationDigest(native)).not.toBe(Descriptor.declarationDigest(base))
    const restored = Schema.decodeUnknownSync(Descriptor.FlowDescriptor)(
      Schema.encodeSync(Descriptor.FlowDescriptor)(native)
    )
    expect(restored.body).toEqual(native.body)
    expect(Descriptor.executionDigest(restored)).toBe(Descriptor.executionDigest(native))
  })

  it("is defined for a descriptor with no measured source bytes", () => {
    // The difference from `executionDigest`: what was declared is knowable
    // before the bytes are measured, so an unmeasured descriptor still keys.
    const unmeasured = new Descriptor.FlowDescriptor({
      ...base,
      body: new Descriptor.BodyRefModule({ path: "flows/inspect.ts" })
    })

    expect(Descriptor.executionDigest(unmeasured)).toBeUndefined()
    expect(Descriptor.declarationDigest(unmeasured)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("pins one fully populated declaration", () => {
    // A golden vector, so a change to the algorithm is a change to a number
    // somebody had to write down rather than a silent re-keying of every call
    // in every package that imports this identity.
    expect(Descriptor.declarationDigest(base)).toBe(
      "cc7a8bd540a0be9e239d8dcc70c113b841b44079df80ce9ff118f7c9bf6a5bae"
    )
  })

  it.each(["reads", "writes", "checks", "tests", "other"] as const)(
    "round-trips %s presentation without changing execution, declaration or prompt identity",
    (activity) => {
      const presentation = {
        verb: { pending: "checking", success: "checked", failure: "failed to check" },
        subject: "selection" as const,
        result: "tests" as const
      }
      const encoded = { ...Schema.encodeSync(Descriptor.FlowDescriptor)(base), activity, presentation }
      const decoded = Schema.decodeUnknownSync(Descriptor.FlowDescriptor)(encoded)
      expect(decoded).toMatchObject({ activity, presentation })
      expect(Schema.encodeSync(Descriptor.FlowDescriptor)(decoded)).toEqual(encoded)
      expect(Descriptor.declarationDigest(decoded)).toBe(Descriptor.declarationDigest(base))
      expect(Descriptor.executionDigest(decoded)).toBe(Descriptor.executionDigest(base))
      expect(Disclosure.toXml([decoded])).toBe(Disclosure.toXml([base]))
      expect(Disclosure.toEntries([decoded])).toEqual(Disclosure.toEntries([base]))
    }
  )

  it.each([
    { activity: "researching" },
    { presentation: { verb: "wrote", subject: "path", result: "write" } },
    { presentation: { verb: { pending: "a", success: "b", failure: "c" }, subject: "invented", result: "write" } },
    { presentation: { verb: { pending: "a", success: "b", failure: "c" }, subject: "path", result: "diff" } }
  ])("rejects unsupported presentation metadata %j", (metadata) => {
    expect(
      Schema.decodeUnknownOption(Descriptor.FlowDescriptor)({
        ...Schema.encodeSync(Descriptor.FlowDescriptor)(base),
        ...metadata
      })
    ).toEqual(Option.none())
  })
})
