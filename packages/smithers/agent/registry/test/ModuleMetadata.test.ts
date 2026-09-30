import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as ModuleMetadata from "../src/internal/ModuleMetadata.ts"
import discoveredFlow from "./fixtures/project/flows/review/read-pr/flow.ts"

describe("ModuleMetadata", () => {
  it.each([
    ["import { Schema } from \"effect\"", "Schema"],
    ["import { Option, Schema as S } from \"effect\"", "S"],
    ["import * as S from \"effect/Schema\"", "S"]
  ])("projects a trusted literal payload without importing source (%s)", (declaration, namespace) => {
    const payload =
      `{ value: ${namespace}.String, count: ${namespace}.Number, enabled: ${namespace}.Boolean, empty: ${namespace}.Null }`
    const metadata = ModuleMetadata.parse(
      `${declaration}; throw new Error("must never execute"); export default Flow.make("echo", { payload: ${payload} })`
    )
    expect(metadata.inputDocument).toEqual(
      Schema.decodeUnknownSync(Schema.Json)(Schema.toJsonSchemaDocument(Schema.Struct({
        value: Schema.String,
        count: Schema.Number,
        enabled: Schema.Boolean,
        empty: Schema.Null
      })))
    )
    expect(metadata.hasInput).toBe(true)
    expect(metadata.warnings).toEqual([])
  })

  it("projects an empty literal payload and ignores misleading strings and comments", () => {
    const metadata = ModuleMetadata.parse(
      "/* Schema = fake; */ const text = \"Schema = fake\"; export default Flow.make(\"echo\", { payload: {} })"
    )
    expect(metadata.inputDocument).toEqual(
      Schema.decodeUnknownSync(Schema.Json)(Schema.toJsonSchemaDocument(Schema.Struct({})))
    )
    expect(
      ModuleMetadata.parse(
        "import { Schema } from \"effect\"; /* Schema = fake; */ const text = \"Schema = fake\"; export default Flow.make(\"echo\", { payload: { value: Schema.String } })"
      ).inputDocument
    )
      .toMatchObject({ schema: { properties: { value: { type: "string" } } } })
  })

  it.each([
    ["import { Schema } from \"other\";", "{ value: Schema.String }"],
    ["// import { Schema } from \"effect\"\n", "{ value: Schema.String }"],
    ["const text = 'import { Schema } from \"effect\"';", "{ value: Schema.String }"],
    ["import type { Schema } from \"effect\";", "{ value: Schema.String }"],
    ["import { Schema } from \"effect\"; function helper(Schema) { return Schema.String }", "{ value: Schema.String }"],
    ["import { Schema } from \"effect\"; const Schema = fake;", "{ value: Schema.String }"],
    ["import { Schema } from \"effect\"; Schema.String = fake;", "{ value: Schema.String }"],
    ["import { Schema as S } from \"effect\"; delete S.String;", "{ value: S.String }"],
    ["import { Schema as S } from \"effect\"; delete (S.String);", "{ value: S.String }"],
    ["import { Schema as S } from \"effect\"; (S.String) = fake;", "{ value: S.String }"],
    ["import { Schema as S } from \"effect\"; ++S.String;", "{ value: S.String }"],
    ["import { Schema as S } from \"effect\"; --S.String;", "{ value: S.String }"],
    ["import { Schema } from \"effect\"; mutate(Schema);", "{ value: Schema.String }"],
    ["import { Schema } from \"effect\"; const Text = Schema.String;", "{ value: Text }"],
    ["import { Schema } from \"effect\";", "{ value: Schema.String.pipe(refine) }"],
    ["import { Schema } from \"effect\";", "{ ...fields, value: Schema.String }"],
    ["import { Schema } from \"effect\";", "{ [key]: Schema.String }"],
    ["import { Schema } from \"effect\";", "{ get value() { return Schema.String } }"],
    ["import { Schema } from \"effect\";", "{ value }"],
    ["import { Schema } from \"effect\";", "{ value: \"Schema.String\" }"],
    ["import { Schema } from \"effect\";", "make({ value: Schema.String })"],
    ["import { Schema } from \"effect\";", "fields"],
    ["import { Schema } from \"effect\";", "{ value: Schema.Unknown }"],
    ["import { Schema as S extra } from \"effect\";", "{ value: S.String }"],
    ["import { Schema } from \"effect\";", "{ value: Schema.String } || { value: Schema.String }"],
    ["import { Schema } from \"effect\";", "{ __proto__: Schema.String }"],
    ["import { Schema } from \"effect\";", "{ 'v\\u0061lue': Schema.String }"],
    ["import { Schema } from \"effect\"; import { Schema } from \"effect\";", "{ value: Schema.String }"]
  ])("keeps unsupported or unprovable payload metadata unavailable (%s/%s)", (declaration, payload) => {
    const metadata = ModuleMetadata.parse(`${declaration} export default Flow.make("echo", { payload: ${payload} })`)
    expect(metadata.hasInput).toBe(true)
    expect(metadata.inputDocument).toBeUndefined()
    expect(metadata.warnings).toContainEqual({
      message: "Payload schema cannot be projected statically; retaining its module locator"
    })
  })

  it("refuses an otherwise supported schema when outer spread can replace the payload", () => {
    const metadata = ModuleMetadata.parse(
      "import { Schema } from \"effect\"; export default Flow.make(\"echo\", { payload: { value: Schema.String }, ...options })"
    )
    expect(metadata.inputDocument).toBeUndefined()
    expect(metadata.warnings).toContainEqual({
      message:
        "Object spread or computed properties make schemas and authority unprojectable; using conservative projections"
    })
  })
  it("refuses an incomplete namespace use at the end of the source", () => {
    const metadata = ModuleMetadata.parse(
      "import { Schema } from \"effect\"; export default Flow.make(\"echo\", { payload: { value: Schema.String } }); Schema.String"
    )
    expect(metadata.inputDocument).toBeUndefined()
    expect(metadata.warnings).toContainEqual({
      message: "Payload schema cannot be projected statically; retaining its module locator"
    })
  })

  it("recognizes an ESM import declared after a harmless initial namespace read", () => {
    const metadata = ModuleMetadata.parse(
      "S.String; import { Schema as S } from \"effect\"; export default Flow.make(\"echo\", { payload: { value: S.String } })"
    )
    expect(metadata.inputDocument).toMatchObject({ schema: { properties: { value: { type: "string" } } } })
    expect(metadata.warnings).toEqual([])
  })

  it("preserves an ordered model list in module metadata", () => {
    const metadata = ModuleMetadata.parse("export default Flow.make(\"review\", { model: [\"opus\", \"sol\"] })")
    expect(Option.getOrThrow(metadata.model)).toEqual(["opus", "sol"])
  })
  it("reads metadata from the default Flow.make value without named schema exports", () => {
    const metadata = ModuleMetadata.parse([
      "\"use sandbox\"",
      "export default Flow.make({",
      "  description: \"Reviews a pull request.\",",
      "  input: Schema.Struct({ number: Schema.Number }),",
      "  output: Schema.Struct({ summary: Schema.String }),",
      "  capabilities: [\"fs:read:.\", \"net:get:api.github.com\"],",
      "  effects: Effects.make({",
      "    reads: [\".\"],",
      "    writes: [],",
      "    mode: \"hermetic\",",
      "    onConflict: \"serialize\",",
      "    tier: \"irreversible\"",
      "  }),",
      "  disableModelInvocation: true",
      "})"
    ].join("\n"))

    expect(metadata).toMatchObject({
      description: "Reviews a pull request.",
      hasInput: true,
      hasOutput: true,
      capabilities: ["fs:read:.", "net:get:api.github.com"],
      effects: {
        reads: ["."],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "irreversible"
      },
      modelInvocable: false,
      declaresName: false,
      warnings: []
    })
    expect(Option.getOrThrow(metadata.placement)).toBe("sandbox")
  })

  it("matches the real /core Flow.make effects contract", () => {
    expect(discoveredFlow.effects?.tier).toBe("irreversible")
    expect(
      ModuleMetadata.parse([
        "export default Flow.make({",
        "  description: \"Posts a result.\",",
        "  effects: {",
        "    reads: [],",
        "    writes: [],",
        "    mode: \"hermetic\",",
        "    onConflict: \"serialize\",",
        "    tier: \"irreversible\"",
        "  }",
        "})"
      ].join("\n")).effects.tier
    ).toBe("irreversible")
  })

  it("stops once the complete declaration is present", () => {
    expect(ModuleMetadata.isComplete("export default Flow.make({ description: \"Review\"")).toBe(false)
    expect(ModuleMetadata.isComplete("export default Flow.make({ description: \"Review\" })")).toBe(true)
  })

  it("ignores helper declarations and comments before the default export", () => {
    const source = [
      "// export default Flow.make({ description: \"Comment\", capabilities: [] })",
      "const helper = Flow.make({ description: \"Helper\", capabilities: [] })",
      "export default Flow.make({",
      "  description: \"Default\",",
      "  capabilities: [\"net:get\"]",
      "})"
    ].join("\n")

    expect(ModuleMetadata.isComplete(source.slice(0, source.indexOf("export default")))).toBe(false)
    expect(ModuleMetadata.parse(source)).toMatchObject({
      description: "Default",
      capabilities: ["net:get"],
      effects: { tier: "sealed" }
    })
  })

  it("does not treat braces in regular expressions as object syntax", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Validates a closing brace.\",",
      "  input: Schema.String.pipe(Schema.pattern(/}/)),",
      "  output: Schema.String,",
      "  capabilities: [\"net:post\"]",
      "})"
    ].join("\n"))

    expect(metadata).toMatchObject({
      description: "Validates a closing brace.",
      hasInput: true,
      hasOutput: true,
      capabilities: ["net:post"],
      effects: { tier: "irreversible" },
      warnings: []
    })
  })

  it("projects a flow list of identifiers conservatively", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Reviews a change.\",",
      "  flows: [readFile, writeFile]",
      "})"
    ].join("\n"))

    expect(metadata.capabilities).toEqual(["*"])
    expect(metadata.effects.tier).toBe("irreversible")
    expect(metadata.warnings).toContainEqual({
      message: "Flow authority cannot be projected statically; using the conservative wildcard"
    })
  })

  // `Flow.make` is the one constructor discovery reads. A module reaching for
  // any other name, including the `Flow.agent` the 0.x core exported, is read
  // as a module with no default declaration at all, which is what refuses it.
  it.each([
    ["Flow.agent", "export default Flow.agent({ description: \"Reviews a change.\" })"],
    ["Widget.make", "export default Widget.make({ description: \"Reviews a change.\" })"]
  ])("reads no declaration from a default export built by %s", (_label, source) => {
    const metadata = ModuleMetadata.parse(source)

    expect(ModuleMetadata.isComplete(source)).toBe(false)
    expect(metadata.description).toBeUndefined()
    expect(metadata.warnings).toEqual([
      { message: "Could not statically read the default Flow.make declaration" }
    ])
  })

  it.each([
    ["an object spread", "...authority"],
    ["a computed property", "[authorityKey]: [\"net:post\"]"]
  ])("projects %s as conservative authority", (_label, member) => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Posts a message\",",
      `  ${member}`,
      "})"
    ].join("\n"))

    expect(metadata.capabilities).toEqual(["*"])
    expect(metadata.effects.tier).toBe("irreversible")
    expect(metadata.hasInput).toBe(true)
    expect(metadata.hasOutput).toBe(true)
    expect(metadata.warnings).toContainEqual({
      message:
        "Object spread or computed properties make schemas and authority unprojectable; using conservative projections"
    })
  })

  it("reads placement directives after leading comments", () => {
    const metadata = ModuleMetadata.parse([
      "/* generated header */",
      "// placement follows",
      "\"use remote\"",
      "export default Flow.make({ description: \"Runs remotely.\" })"
    ].join("\n"))

    expect(Option.getOrThrow(metadata.placement)).toBe("remote")
  })

  it("reads the @smthrs/flow call shape, whose schemas are payload and success", () => {
    const metadata = ModuleMetadata.parse([
      "\"use local\"",
      "import { Schema } from \"effect\"",
      "export default Flow.make(\"test/standalone\", {",
      "  description: \"Shouts a name through its own graph.\",",
      "  payload: { name: Schema.String },",
      "  success: Schema.String,",
      "  body: (payload) => Shout.call({ name: payload.name })",
      "})"
    ].join("\n"))

    // The tag is the first argument, so the object discovery reads is the
    // second one. `payload` and `success` are the same two schemas `input` and
    // `output` name in the `@smthrs/core` shape.
    expect(metadata).toMatchObject({
      description: "Shouts a name through its own graph.",
      hasInput: true,
      hasOutput: true,
      flows: [],
      placement: Option.some("local"),
      warnings: []
    })
  })

  it("reports a @smthrs/flow declaration that states neither schema as taking neither", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make(\"test/bare\", {",
      "  description: \"Takes nothing and returns nothing.\",",
      "  payload: {},",
      "  body: () => Node.succeed(undefined)",
      "})"
    ].join("\n"))

    expect(metadata.hasInput).toBe(true)
    expect(metadata.hasOutput).toBe(false)
  })

  it("returns conservative metadata when no default flow declaration is present", () => {
    const metadata = ModuleMetadata.parse(
      "const helper = 1\nexport const named = Flow.make({ description: \"Named\" })"
    )

    expect(ModuleMetadata.isComplete("")).toBe(false)
    expect(metadata).toEqual({
      description: undefined,
      hasInput: false,
      hasOutput: false,
      model: Option.none(),
      flows: [],
      capabilities: ["*"],
      effects: {
        reads: ["**"],
        writes: ["**"],
        mode: "expected",
        onConflict: "serialize",
        tier: "irreversible"
      },
      placement: Option.none(),
      modelInvocable: true,
      declaresName: false,
      declaredName: Option.none(),
      warnings: [{ message: "Could not statically read the default Flow.make declaration" }]
    })
  })

  it.each([
    ["a line comment that never ends in a newline", "// unterminated"],
    ["a block comment that is never closed", "/* unterminated"],
    ["a string literal that is never closed", "export default Flow.make({ description: \"unterminated"],
    ["a regular expression that is never closed", "const pattern = /unterminated"]
  ])("reads no declaration from %s", (_label, source) => {
    expect(ModuleMetadata.isComplete(source)).toBe(false)
    expect(ModuleMetadata.parse(source).description).toBeUndefined()
  })

  it.each([
    ["a nested effects object", "{ reads: [\".\"], writes: [], mode: \"hermetic\", tier: \"sealed\"", "}})"],
    [
      "an effects constructor",
      "Effects.make({ reads: [\".\"], writes: [], mode: \"hermetic\", tier: \"sealed\"",
      "})})"
    ],
    [
      "a brace in a quoted value",
      "{ detail: \"}\", reads: [\".\"], writes: [], mode: \"hermetic\", tier: \"sealed\"",
      "}})"
    ],
    [
      "a brace in a regular expression",
      "{ validate: /}/, reads: [\".\"], writes: [], mode: \"hermetic\", tier: \"sealed\"",
      "}})"
    ]
  ])("refuses partial authority from an unclosed declaration containing %s", (_label, effects, closing) => {
    const source = [
      "\"use sandbox\"",
      "export default Flow.make(\"review\", {",
      "  description: \"Untrusted until complete.\",",
      "  capabilities: [\"fs:read:.\"],",
      `  effects: ${effects}`
    ].join("\n")
    const complete = ModuleMetadata.parse(source + closing)
    expect(ModuleMetadata.isComplete(source + closing)).toBe(true)
    expect(complete.description).toBe("Untrusted until complete.")
    expect(complete.capabilities).toEqual(["fs:read:."])
    expect(complete.effects).toEqual({
      reads: ["."],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    })

    expect(ModuleMetadata.isComplete(source)).toBe(false)
    expect(ModuleMetadata.parse(source)).toEqual({
      description: undefined,
      hasInput: false,
      hasOutput: false,
      model: Option.none(),
      flows: [],
      capabilities: ["*"],
      effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
      placement: Option.some("sandbox"),
      modelInvocable: true,
      declaresName: false,
      declaredName: Option.none(),
      warnings: [{ message: "Could not statically read the default Flow.make declaration" }]
    })
  })

  it.each([
    ["\\n", "\n"],
    ["\\r", "\r"],
    ["\\t", "\t"],
    ["\\b", "\b"],
    ["\\f", "\f"],
    ["\\v", "\v"],
    ["\\0", "\0"],
    ["\\\\", "\\"],
    ["\\\"", "\""],
    ["\\'", "'"],
    ["\\`", "`"],
    ["\\u0041", "A"],
    ["\\x42", "B"]
  ])("decodes the %j escape inside a description literal", (escape, decoded) => {
    const metadata = ModuleMetadata.parse(
      `export default Flow.make({ description: "before${escape}after", capabilities: [] })`
    )

    expect(metadata.description).toBe(`before${decoded}after`)
  })

  it("reads a backticked description and rejects an interpolated one", () => {
    expect(
      ModuleMetadata.parse("export default Flow.make({ description: `Reviews a change.` })").description
    ).toBe("Reviews a change.")
    expect(
      ModuleMetadata.parse("export default Flow.make({ description: `Reviews ${subject}.` })").description
    ).toBeUndefined()
  })

  it("lexes regular expressions, division, and numbers around the declaration", () => {
    const metadata = ModuleMetadata.parse([
      "/^leading$/.test(name)",
      "const escaped = /\\/[\\]}]/",
      "const flagged = typeof /trailing/gi",
      "const half = 1 / 2",
      "const ratio = width / height",
      "export default Flow.make({",
      "  description: \"Survives every lexical form.\",",
      "  retries: 30,",
      "  capabilities: []",
      "})",
      "void /at-end/"
    ].join("\n"))

    expect(metadata).toMatchObject({
      description: "Survives every lexical form.",
      capabilities: [],
      effects: { tier: "sealed" },
      warnings: []
    })
  })

  it.each([
    ["a bare identifier argument", "export default Flow.make(configuration)"],
    ["an object nested inside a call argument", "export default Flow.make(withDefaults({ description: \"Inner\" }))"]
  ])("reads no declaration from %s", (_label, source) => {
    expect(ModuleMetadata.parse(source).description).toBeUndefined()
  })

  it("reads the declaration object that follows an earlier call argument", () => {
    const metadata = ModuleMetadata.parse(
      "export default Flow.make(withDefaults(), { description: \"Reads the second argument.\", capabilities: [] })"
    )

    expect(metadata.description).toBe("Reads the second argument.")
    expect(metadata.capabilities).toEqual([])
  })

  it.each([
    ["use client", "client"],
    ["use server", "local"],
    ["use local", "local"],
    ["use sandbox", "sandbox"],
    ["use remote", "remote"]
  ])("reads the %s placement directive", (directive, placement) => {
    const metadata = ModuleMetadata.parse(
      `"${directive}"\nexport default Flow.make({ description: "Placed." })`
    )

    expect(Option.getOrThrow(metadata.placement)).toBe(placement)
  })

  it("reads no placement from an unrecognised leading directive or an empty module", () => {
    expect(Option.isNone(ModuleMetadata.parse("\"use magic\"\nexport default Flow.make({})").placement)).toBe(true)
    expect(Option.isNone(ModuleMetadata.parse("").placement)).toBe(true)
  })

  it("accepts a quoted property key and a trailing comma", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  \"description\": \"Quoted and trailing.\",",
      "  capabilities: [],",
      "})"
    ].join("\n"))

    expect(metadata).toMatchObject({
      description: "Quoted and trailing.",
      capabilities: [],
      warnings: []
    })
  })

  it("projects a method member as conservative authority", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Declares a method.\",",
      "  capabilities: [],",
      "  run(count: number) { return count + 1 }",
      "})"
    ].join("\n"))

    expect(metadata.capabilities).toEqual(["*"])
    expect(metadata.hasInput).toBe(true)
    expect(metadata.hasOutput).toBe(true)
    expect(metadata.warnings).toContainEqual({
      message:
        "Object spread or computed properties make schemas and authority unprojectable; using conservative projections"
    })
  })

  it.each([
    ["an empty literal list and a model seat", "  flows: [],\n  model: \"smart\",", "smart"],
    ["omitted entirely with no model seat", "", undefined]
  ])("keeps declared capabilities when the flow list is %s", (_label, members, model) => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Reads files.\",",
      members,
      "  capabilities: [\"fs:read:.\"]",
      "})"
    ].join("\n"))

    expect(metadata.capabilities).toEqual(["fs:read:."])
    expect(metadata.flows).toEqual([])
    expect(metadata.effects).toEqual({
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    })
    expect(Option.getOrUndefined(metadata.model)).toBe(model)
    expect(metadata.warnings).toEqual([])
  })

  it("narrows a non-empty literal flow list to the declared capabilities", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Calls another flow.\",",
      "  capabilities: [\"fs:read:**\"],",
      "  flows: [\"read-pr\"]",
      "})"
    ].join("\n"))

    expect(metadata.capabilities).toEqual(["fs:read:**"])
    expect(metadata.flows).toEqual(["read-pr"])
    expect(metadata.effects).toEqual({
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    })
    expect(metadata.warnings).toEqual([])
  })

  it("keeps the wildcard for a delegating module that declares no capabilities", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Calls another flow.\",",
      "  flows: [\"read-pr\"]",
      "})"
    ].join("\n"))

    expect(metadata.capabilities).toEqual(["*"])
    expect(metadata.effects.tier).toBe("irreversible")
    expect(metadata.warnings).toContainEqual({
      message: "Flow authority cannot be projected statically; using the conservative wildcard"
    })
  })

  it.each([
    ["a code-point escape", "\\u{1F600}"],
    ["a surrogate pair", "\\uD83D\\uDE00"]
  ])("decodes %s in a description", (_label, escape) => {
    const metadata = ModuleMetadata.parse(
      `export default Flow.make({ description: "hi ${escape}", capabilities: [] })`
    )

    expect(metadata.description).toBe("hi 😀")
  })

  it("preserves an out-of-range code-point escape without throwing", () => {
    const source = "export default Flow.make({ description: \"hi \\u{FFFFFF}\", capabilities: [] })"

    expect(() => ModuleMetadata.parse(source)).not.toThrow()
    expect(ModuleMetadata.parse(source).description).toBe("hi \\u{FFFFFF}")
  })

  it.each([
    ["modelInvocable: false", false],
    ["modelInvocable: true", true],
    ["disableModelInvocation: false", true],
    ["disableModelInvocation: true", false]
  ])("reads %s as a literal visibility declaration", (member, modelInvocable) => {
    const metadata = ModuleMetadata.parse(
      `export default Flow.make({ description: "Visible or not.", ${member} })`
    )

    expect(metadata.modelInvocable).toBe(modelInvocable)
    expect(metadata.warnings).toEqual([])
  })

  it.each([
    ["modelInvocable", "modelInvocable: visibility"],
    ["disableModelInvocation", "disableModelInvocation: visibility"]
  ])("warns when %s is not a boolean literal", (_label, member) => {
    const metadata = ModuleMetadata.parse(
      `export default Flow.make({ description: "Visible or not.", ${member} })`
    )

    expect(metadata.modelInvocable).toBe(true)
    expect(metadata.warnings).toContainEqual({
      message: "Model invocation visibility must be declared as a boolean literal for discovery"
    })
  })

  it("reads a fully declared effect envelope, including nested members", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Writes source files.\",",
      "  capabilities: [\"fs:write:src\"],",
      "  effects: {",
      "    reads: [\"src\"],",
      "    writes: [\"src\"],",
      "    mode: \"expected\",",
      "    onConflict: \"lane\",",
      "    tier: \"compensable\",",
      "    budget: { retries: 1 }",
      "  }",
      "})"
    ].join("\n"))

    expect(metadata.effects).toEqual({
      reads: ["src"],
      writes: ["src"],
      mode: "expected",
      onConflict: "lane",
      tier: "compensable"
    })
    expect(metadata.warnings).toEqual([])
  })

  it("raises an under-classifying declared tier to the inferred tier", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Writes anywhere.\",",
      "  capabilities: [\"fs:write\"],",
      "  effects: { reads: [], writes: [], tier: \"sealed\" }",
      "})"
    ].join("\n"))

    expect(metadata.effects.tier).toBe("irreversible")
    expect(metadata.warnings).toContainEqual({
      message: "Effect tier sealed under-classifies declared authority; using irreversible"
    })
  })

  it.each([
    [
      "the effects value is not an object literal",
      "effects: baseEffects",
      "Effects must be a statically projectable object literal; using conservative effects"
    ],
    [
      "the effects object spreads another value",
      "effects: { ...baseEffects, reads: [], writes: [] }",
      "Effects contain an object spread or computed member; using conservative effects"
    ],
    [
      "the effects mode is not a known literal",
      "effects: { reads: [], writes: [], mode: loose }",
      "Effects mode and conflict policy must be string literals; using conservative effects"
    ],
    [
      "the effects conflict policy is not a known literal",
      "effects: { reads: [], writes: [], onConflict: \"whenever\" }",
      "Effects mode and conflict policy must be string literals; using conservative effects"
    ],
    [
      "both policies are invalid and produce only one warning",
      "effects: { reads: [], writes: [], mode: loose, onConflict: unknownPolicy }",
      "Effects mode and conflict policy must be string literals; using conservative effects"
    ]
  ])("falls back to conservative effects when %s", (_label, member, message) => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Declares effects badly.\",",
      "  capabilities: [\"fs:read:.\"],",
      `  ${member}`,
      "})"
    ].join("\n"))

    expect(metadata.effects).toEqual({
      reads: ["**"],
      writes: ["**"],
      mode: "expected",
      onConflict: "serialize",
      tier: "irreversible"
    })
    expect(metadata.warnings).toContainEqual({ message })
  })

  it("warns when authority metadata cannot be statically projected", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Review\",",
      "  capabilities,",
      "  effects: {",
      "    reads: [],",
      "    writes: [],",
      "    mode: \"hermetic\",",
      "    onConflict: \"serialize\",",
      "    tier",
      "  }",
      "})"
    ].join("\n"))

    expect(metadata.capabilities).toEqual(["*"])
    expect(metadata.effects.tier).toBe("irreversible")
    expect(metadata.warnings.map((warning) => warning.message)).toEqual([
      "Capabilities must be a string-literal array for discovery; using the conservative wildcard",
      "Effects tier must be a sealed, compensable, or irreversible string literal; using irreversible"
    ])
  })
  it("projects declared wildcard capabilities as the conservative envelope", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Claims everything.\",",
      "  capabilities: [\"*\"],",
      "  effects: { reads: [], writes: [], mode: \"hermetic\", onConflict: \"serialize\", tier: \"sealed\" }",
      "})"
    ].join("\n"))

    expect(metadata.effects).toEqual({
      reads: ["**"],
      writes: ["**"],
      mode: "expected",
      onConflict: "serialize",
      tier: "irreversible"
    })
    expect(metadata.warnings).toContainEqual({
      message: "Effect tier sealed under-classifies declared authority; using irreversible"
    })
  })

  it("widens an unreadable reads member to the wildcard and names it", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Reads an imported list.\",",
      "  capabilities: [\"fs:read:.\"],",
      "  effects: { reads: sharedReads, writes: [] }",
      "})"
    ].join("\n"))

    expect(metadata.effects).toEqual({
      reads: ["**"],
      writes: ["**"],
      mode: "expected",
      onConflict: "serialize",
      tier: "irreversible"
    })
    expect(metadata.warnings).toContainEqual({
      message: "Effects reads must be a string-literal array; using the conservative wildcard"
    })
  })

  it("reads members an effects object leaves out as empty sets", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Declares only a tier.\",",
      "  capabilities: [\"fs:read\"],",
      "  effects: { tier: \"sealed\" }",
      "})"
    ].join("\n"))

    expect(metadata.effects).toEqual({
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    })
    expect(metadata.warnings).toEqual([])
  })
})

describe("ModuleMetadata effect envelope parity", () => {
  const literal = [
    "  effects: {",
    "    reads: [\"src/**\"],",
    "    writes: [\"dist/**\"],",
    "    mode: \"hermetic\",",
    "    onConflict: \"lane\",",
    "    tier: \"compensable\"",
    "  },"
  ]

  // One literal, two declaration shapes: `@smthrs/core` takes an options object
  // alone, `@smthrs/flow` takes a tag first and spells the schemas `payload`
  // and `success`. Discovery reads source text, so the envelope it projects has
  // to be the same envelope either way, or a file flow's authority would depend
  // on which constructor its author reached for.
  const core = ModuleMetadata.parse([
    "export default Flow.make({",
    "  description: \"Builds the package.\",",
    "  input: Schema.Struct({ target: Schema.String }),",
    "  output: Schema.Struct({ built: Schema.Boolean }),",
    "  capabilities: [\"fs:read:.\", \"fs:write:dist\"],",
    ...literal,
    "  body: () => Node.succeed({ built: true })",
    "})"
  ].join("\n"))

  const flow = ModuleMetadata.parse([
    "import { Schema } from \"effect\"",
    "export default Flow.make(\"builder/build\", {",
    "  description: \"Builds the package.\",",
    "  payload: { target: Schema.String },",
    "  success: Schema.Struct({ built: Schema.Boolean }),",
    "  capabilities: [\"fs:read:.\", \"fs:write:dist\"],",
    ...literal,
    "  body: () => Node.succeed({ built: true })",
    "})"
  ].join("\n"))

  it("projects the same envelope from either constructor's literal", () => {
    expect(flow.effects).toEqual(core.effects)
    expect(flow.effects).toEqual({
      reads: ["src/**"],
      writes: ["dist/**"],
      mode: "hermetic",
      onConflict: "lane",
      tier: "compensable"
    })
  })

  it("reads the rest of the declaration from either constructor too", () => {
    expect(flow.capabilities).toEqual(core.capabilities)
    expect(flow.description).toEqual(core.description)
    expect([flow.hasInput, flow.hasOutput]).toEqual([core.hasInput, core.hasOutput])
    expect(flow.warnings).toEqual([])
    expect(core.warnings).toEqual([])
  })
})
