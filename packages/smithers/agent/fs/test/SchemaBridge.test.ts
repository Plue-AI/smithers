/**
 * Pins command schema publication and authoritative input decoding.
 *
 * @since 0.1.0
 */

import * as Descriptor from "@smthrs/registry/Descriptor"
import { Cause, Context, Effect, Option, SchemaTransformation } from "effect"
import * as Schema from "effect/Schema"
import { z } from "incur"
import { describe, expect, it, vi } from "vitest"
import * as FlowInvoker from "../src/FlowInvoker.ts"
import * as Incur from "../src/Incur.ts"
import * as SchemaBridge from "../src/internal/SchemaBridge.ts"
import * as Route from "../src/Route.ts"
import { makeRoute } from "./helpers.ts"

vi.mock("effect/Schema", async (importOriginal) => ({ ...await importOriginal<typeof import("effect/Schema")>() }))

const moduleRef = new Descriptor.SchemaRefModule({ path: "/absolute/flow.ts", field: "input" })

const failure = async (effect: Effect.Effect<unknown, unknown>): Promise<any> => {
  const exit = await Effect.runPromise(Effect.exit(effect))
  expect(exit._tag).toBe("Failure")
  if (exit._tag !== "Failure") throw new Error("expected failure")
  return Option.getOrThrow(Cause.findErrorOption(exit.cause))
}

describe("SchemaBridge", () => {
  it("represents a schema-free command with actual undefined", async () => {
    const command = await Effect.runPromise(
      SchemaBridge.toCommandSchema(new Descriptor.SchemaRefNone({}), Schema.Void)
    )
    expect(await Effect.runPromise(command.decode(command.assemble([], {})))).toBeUndefined()
    expect((await failure(command.decode(command.assemble(["unexpected"], {})))).code).toBe("decode_failed")
    expect((await failure(command.decode(command.assemble([], { unexpected: true })))).code).toBe("decode_failed")
  })

  it("joins markdown arguments but refuses output locators as input", async () => {
    const command = await Effect.runPromise(
      SchemaBridge.toCommandSchema(
        new Descriptor.SchemaRefMarkdownArgs({}),
        Schema.Struct({ args: Schema.String })
      )
    )
    expect(await Effect.runPromise(command.decode(command.assemble(["hello", "world"], {})))).toEqual({
      args: "hello world"
    })
    // Incur delivers positionals as `{ args: [...] }`, and they join with a
    // single space exactly as the array form does.
    expect(await Effect.runPromise(command.decode(command.assemble({ args: ["hello", "world"] }, {})))).toEqual({
      args: "hello world"
    })
    expect(await Effect.runPromise(command.decode(command.assemble({ args: "already text" }, {})))).toEqual({
      args: "already text"
    })
    expect(await Effect.runPromise(command.decode(command.assemble({}, {})))).toEqual({ args: "" })
    // An option of the same name wins, as it does in every other strategy.
    expect(await Effect.runPromise(command.decode(command.assemble(["p1", "p2"], { args: "override" })))).toEqual({
      args: "override"
    })
    // A non-string positional is refused rather than stringified through a
    // caller-supplied `toString`.
    expect((await failure(command.decode(command.assemble({ args: [1, 2] } as never, {})))).code).toBe("decode_failed")

    const unsupported = await failure(
      SchemaBridge.toCommandSchema(new Descriptor.SchemaRefMarkdownOutput({}), Schema.String)
    )
    expect(unsupported.code).toBe("unsupported_schema")
  })

  it("projects object fields without bypassing the authoritative schema", async () => {
    const Input = Schema.Struct({
      title: Schema.String,
      finite: Schema.Finite,
      integer: Schema.Int,
      enabled: Schema.Boolean,
      tags: Schema.Array(Schema.String),
      nested: Schema.Struct({ value: Schema.String }),
      anything: Schema.Unknown,
      optional: Schema.optionalKey(Schema.String)
    })
    const command = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Input))
    const decoded = await Effect.runPromise(command.decode(command.assemble([], {
      title: "review",
      finite: "1.5",
      integer: "2",
      enabled: "true",
      tags: ["a", "b"],
      nested: "{\"value\":\"inside\"}",
      anything: "{\"free\":true}"
    })))

    expect(decoded).toEqual({
      title: "review",
      finite: 1.5,
      integer: 2,
      enabled: true,
      tags: ["a", "b"],
      nested: { value: "inside" },
      anything: { free: true }
    })
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(
      (await failure(command.decode(command.assemble([], {
        title: "review",
        finite: "not-finite",
        integer: "2",
        enabled: true,
        tags: [],
        nested: {},
        anything: null
      })))).code
    ).toBe("decode_failed")
  })

  it("advertises every option with the type its flow schema declares", async () => {
    const Input = Schema.Struct({
      count: Schema.Number,
      mode: Schema.Literals(["fast", "slow"]),
      note: Schema.NullOr(Schema.String)
    })
    const command = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Input))
    const advertised = z.toJSONSchema(command.options!, { unrepresentable: "any" }) as {
      readonly properties: Readonly<Record<string, unknown>>
      readonly required: ReadonlyArray<string>
    }
    const declared = Schema.toJsonSchemaDocument(Input).schema as typeof advertised

    // Zod may normalize a nullable union from `anyOf` to a `type` array. Both
    // JSON Schema forms must retain the declared values and requirements.
    expect(Object.keys(advertised.properties)).toEqual(Object.keys(declared.properties))
    expect(advertised.properties.count).toEqual(declared.properties.count)
    expect(advertised.properties.mode).toEqual(declared.properties.mode)
    const published = z.fromJSONSchema(z.toJSONSchema(command.options!, { unrepresentable: "any" }))
    for (const note of ["release note", null]) {
      expect(published.safeParse({ count: 42, mode: "fast", note }).success).toBe(true)
    }
    for (const note of [42, true, {}, []]) {
      expect(published.safeParse({ count: 42, mode: "fast", note }).success).toBe(false)
    }
    expect(advertised.required).toEqual(declared.required)

    expect(
      await Effect.runPromise(command.decode(command.assemble([], { count: "42", mode: "fast", note: null })))
    ).toEqual({ count: 42, mode: "fast", note: null })
    // An empty flag value is refused rather than coerced to zero.
    expect((await failure(command.decode(command.assemble([], { count: "", mode: "fast", note: null })))).code).toBe(
      "decode_failed"
    )
    // The published schema is Effect's own, which renders a number as
    // `number | "Infinity" | "-Infinity" | "NaN"`. The authoritative decoder
    // takes the number side only, and the invocation boundary refuses
    // non-finite values, so a token is refused rather than invoked.
    expect(
      (await failure(command.decode(command.assemble([], { count: "Infinity", mode: "fast", note: null })))).code
    ).toBe("decode_failed")
    expect(
      (await failure(command.decode(command.assemble([], { count: 1, mode: "sideways", note: null })))).code
    ).toBe("decode_failed")
  })

  it.each([
    { name: "nullable string", field: Schema.NullOr(Schema.String), value: "note", optional: false },
    {
      name: "optional nullable string",
      field: Schema.optional(Schema.NullOr(Schema.String)),
      value: "note",
      optional: true
    },
    {
      name: "nullable enum",
      field: Schema.NullOr(Schema.Literals(["fast", "slow"])),
      value: "fast",
      optional: false
    },
    {
      name: "optional nullable enum",
      field: Schema.optional(Schema.NullOr(Schema.Literals(["fast", "slow"]))),
      value: "slow",
      optional: true
    }
  ])("preserves the declared $name values and requiredness", async ({ field, optional, value }) => {
    const Input = Schema.Struct({ choice: field })
    const command = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Input))
    const advertised = z.toJSONSchema(command.options!, { unrepresentable: "any" })
    const declared = Schema.toJsonSchemaDocument(Input).schema

    expect(Object.keys(advertised.properties!)).toEqual(Object.keys(declared.properties!))
    expect(advertised.required).toEqual(declared.required)
    const published = z.fromJSONSchema(advertised)
    for (const choice of [value, null]) {
      expect(published.safeParse({ choice }).success).toBe(true)
      expect(await Effect.runPromise(command.decode(command.assemble([], { choice })))).toEqual({ choice })
    }
    for (const choice of [42, true, {}, [], ...(value === "note" ? [] : ["outside-enum"])]) {
      expect(published.safeParse({ choice }).success).toBe(false)
      expect((await failure(command.decode(command.assemble([], { choice })))).code).toBe("decode_failed")
    }
    expect(published.safeParse({}).success).toBe(optional)
    if (optional) {
      expect(await Effect.runPromise(command.decode(command.assemble([], {})))).toEqual({})
    } else {
      expect((await failure(command.decode(command.assemble([], {})))).code).toBe("decode_failed")
    }
  })

  it("supports an explicit args property and schema definitions", async () => {
    const WithArgs = Schema.Struct({ args: Schema.Array(Schema.String) })
    const argsCommand = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, WithArgs))
    expect(await Effect.runPromise(argsCommand.decode(argsCommand.assemble(["a", "b"], {})))).toEqual({
      args: ["a", "b"]
    })

    const Identified = Schema.Struct({ value: Schema.Finite }).annotate({ identifier: "FsIdentified" })
    const identified = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Identified))
    expect(await Effect.runPromise(identified.decode(identified.assemble([], { value: "3" })))).toEqual({ value: 3 })

    const optional = await Effect.runPromise(
      SchemaBridge.toCommandSchema(moduleRef, Schema.Struct({ value: Schema.optionalKey(Schema.String) }))
    )
    expect(await Effect.runPromise(optional.decode(optional.assemble([], {})))).toEqual({})
  })

  it("projects scalar schemas from a positional or named input", async () => {
    const finite = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Schema.Finite))
    expect(await Effect.runPromise(finite.decode(finite.assemble(["4.5"], {})))).toBe(4.5)
    expect(await Effect.runPromise(finite.decode(finite.assemble([], { input: "5.5" })))).toBe(5.5)
    expect(await Effect.runPromise(finite.decode(finite.assemble({ input: "6.5" }, {})))).toBe(6.5)
    expect((await failure(finite.decode(finite.assemble([], {})))).code).toBe("decode_failed")

    const array = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Schema.Array(Schema.String)))
    expect(await Effect.runPromise(array.decode(array.assemble([], { input: ["a", "b"] })))).toEqual(["a", "b"])

    const dictionary = await Effect.runPromise(
      SchemaBridge.toCommandSchema(moduleRef, Schema.Record(Schema.String, Schema.String))
    )
    expect(await Effect.runPromise(dictionary.decode(dictionary.assemble([], { input: "{\"a\":\"b\"}" })))).toEqual({
      a: "b"
    })
  })

  it("refuses scalar tokens the command object would otherwise drop", async () => {
    const finite = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Schema.Finite))
    for (
      const [args, options] of [
        [["1", "2"], {}],
        [["1"], { typo: "x" }],
        [[], { input: "1", typo: "x" }],
        [["1"], { input: "2" }],
        [{ input: "1", extra: "x" }, {}],
        [{ input: "1" }, { input: "2" }]
      ] as const
    ) {
      expect((await failure(finite.decode(finite.assemble(args, options)))).code).toBe("decode_failed")
    }
  })

  it("keeps an explicit null scalar input for the flow schema to judge", async () => {
    const nullable = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Schema.NullOr(Schema.String)))
    expect(await Effect.runPromise(nullable.decode(nullable.assemble([], { input: null })))).toBeNull()
    expect(await Effect.runPromise(nullable.decode(nullable.assemble({ input: null }, {})))).toBeNull()
    expect(await Effect.runPromise(nullable.decode(nullable.assemble(["a"], { input: undefined })))).toBe("a")
    expect(await Effect.runPromise(nullable.decode(nullable.assemble({ input: undefined }, { input: "b" })))).toBe("b")
    expect((await failure(nullable.decode(nullable.assemble(["a"], { input: null })))).code).toBe("decode_failed")
    const finite = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Schema.Finite))
    expect((await failure(finite.decode(finite.assemble([], { input: null })))).code).toBe("decode_failed")
  })

  it.each([
    { name: "empty tuple", schema: Schema.Tuple([]), value: [] },
    {
      name: "tuple with rest",
      schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Boolean]),
      value: ["a", true, false]
    },
    {
      name: "tuple with unknown rest",
      schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Unknown]),
      value: ["a", 1, false]
    },
    { name: "tuple", schema: Schema.Tuple([Schema.String, Schema.Finite]), value: ["a", 1] },
    { name: "unknown array", schema: Schema.Array(Schema.Unknown), value: ["a", { value: true }] },
    { name: "JSON array", schema: Schema.Array(Schema.Json), value: [null, [1]] },
    { name: "any array", schema: Schema.Array(Schema.Any), value: [1, false] }
  ])("projects $name without a synchronous defect", async ({ schema, value }) => {
    const command = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, schema))
    expect(await Effect.runPromise(command.decode(command.assemble([], { input: value })))).toEqual(value)
    const advertised = z.toJSONSchema(command.options!, { unrepresentable: "any" })
    expect(advertised.properties?.input).toMatchObject({ type: "array" })
  })

  it("advertises tuple positions and refuses missing, extra, or mistyped elements", async () => {
    const command = await Effect.runPromise(
      SchemaBridge.toCommandSchema(moduleRef, Schema.Tuple([Schema.String, Schema.Finite]))
    )
    expect(z.toJSONSchema(command.options!, { unrepresentable: "any" }).properties?.input).toEqual({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: false,
      minItems: 2,
      maxItems: 2
    })
    for (const input of [["a"], ["a", 1, true], [1, "a"]]) {
      expect((await failure(command.decode(command.assemble([], { input })))).code).toBe("decode_failed")
    }
  })

  it("retains nested properties, required keys, literals, and record values", async () => {
    const nested = Schema.Struct({
      mode: Schema.Literals(["fast", "slow"]),
      count: Schema.Finite,
      label: Schema.optionalKey(Schema.String)
    }).annotate({ identifier: "Nested" })
    const command = await Effect.runPromise(SchemaBridge.toCommandSchema(
      moduleRef,
      Schema.Struct({
        nested,
        rows: Schema.Array(nested),
        values: Schema.Record(Schema.String, Schema.Boolean)
      })
    ))
    const advertised = z.toJSONSchema(command.options!, { unrepresentable: "any" })
    const expected = {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fast", "slow"] },
        count: { type: "number" },
        label: { type: "string" }
      },
      required: ["mode", "count"],
      additionalProperties: false
    }
    expect(advertised.properties?.nested).toEqual(expected)
    expect(advertised.properties?.rows).toMatchObject({ type: "array", items: expected })
    expect(advertised.properties?.values).toMatchObject({ type: "object", additionalProperties: { type: "boolean" } })
    expect(
      (await failure(command.decode(command.assemble([], {
        nested: { mode: "fast" },
        rows: [],
        values: {}
      })))).code
    ).toBe("decode_failed")
  })

  it("advertises structs closed and refuses an unknown flag or nested key instead of dropping it", async () => {
    // Effect's default JSON Schema leaves structs open, and the authoritative
    // decoder ignores excess keys, so an open projection would let a mistyped
    // flag through and invoke the flow without it.
    const command = await Effect.runPromise(SchemaBridge.toCommandSchema(
      moduleRef,
      Schema.Struct({ nested: Schema.Struct({ mode: Schema.String }) })
    ))
    const advertised = z.toJSONSchema(command.options!, { unrepresentable: "any" })
    expect(advertised.additionalProperties).toBe(false)
    expect(advertised.properties?.nested).toMatchObject({ additionalProperties: false })
    expect(await Effect.runPromise(command.decode(command.assemble([], { nested: { mode: "fast" } })))).toEqual({
      nested: { mode: "fast" }
    })
    for (
      const options of [
        { nested: { mode: "fast" }, mdoe: "slow" },
        { nested: { mode: "fast", extra: true } }
      ]
    ) {
      expect((await failure(command.decode(command.assemble([], options)))).code).toBe("decode_failed")
    }
  })

  it("turns document-generation errors into sanitized typed unsupported_schema failures", async () => {
    const error = await failure(SchemaBridge.toCommandSchema(
      moduleRef,
      Schema.suspend((): typeof Schema.String => {
        throw new Error("private schema cause")
      })
    ))
    expect(error).toMatchObject({ code: "unsupported_schema", method: "SchemaBridge.toCommandSchema" })
    expect(JSON.stringify(error)).not.toContain("private schema cause")
  })

  it.each([
    { name: "non-string reference", schema: { $ref: 1 }, definitions: {} },
    { name: "missing reference", schema: { $ref: "#/$defs/Missing" }, definitions: {} },
    { name: "external reference", schema: { $ref: "https://example.com/schema" }, definitions: {} },
    { name: "cyclic reference", schema: { $ref: "#/$defs/Loop" }, definitions: { Loop: { $ref: "#/$defs/Loop" } } }
  ])("refuses a $name through the typed boundary", async ({ schema, definitions }) => {
    const document = vi.spyOn(Schema, "toJsonSchemaDocument").mockReturnValue({
      dialect: "draft-2020-12",
      schema,
      definitions
    })
    try {
      expect((await failure(SchemaBridge.toCommandSchema(moduleRef, Schema.Unknown))).code).toBe("unsupported_schema")
    } finally {
      document.mockRestore()
    }
  })

  it.each([
    { name: "oneOf", node: { oneOf: [{ type: "string" }, { type: "boolean" }] }, value: false },
    { name: "numeric enum", node: { enum: [1, 2] }, value: 2 },
    { name: "mixed enum", node: { enum: ["true", false, 1] }, value: "true" },
    { name: "string constant", node: { const: "true" }, value: "true" },
    { name: "numeric constant", node: { const: 2 }, value: 2 },
    { name: "type union", node: { type: ["string", "null"] }, value: null },
    { name: "open object", node: { type: "object" }, value: { extra: 1 } },
    { name: "optional tuple", node: { type: "array", prefixItems: [{ type: "string" }], maxItems: 1 }, value: [] },
    {
      name: "closed tuple",
      node: { type: "array", prefixItems: [{ type: "string" }], minItems: 1, items: false },
      value: ["a"]
    }
  ])("projects a $name document without changing its values", async ({ node, value }) => {
    const document = vi.spyOn(Schema, "toJsonSchemaDocument").mockReturnValue({
      dialect: "draft-2020-12",
      schema: { type: "object", properties: { value: node }, required: ["value"] },
      definitions: {}
    })
    try {
      const command = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Schema.Unknown))
      expect(await Effect.runPromise(command.decode(command.assemble([], { value })))).toEqual({ value })
      expect(z.toJSONSchema(command.options!, { unrepresentable: "any" }).properties?.value).not.toEqual({})
    } finally {
      document.mockRestore()
    }
  })

  it.each([
    { type: "unsupported" },
    { allOf: [{ type: "string" }] },
    { not: { type: "string" } },
    { type: "object", properties: { child: { $ref: "#/$defs/Recursive" } } }
  ])("refuses unsupported structural documents with a typed error", async (schema) => {
    const document = vi.spyOn(Schema, "toJsonSchemaDocument").mockReturnValue({
      dialect: "draft-2020-12",
      schema,
      definitions: { Recursive: schema }
    })
    try {
      expect((await failure(SchemaBridge.toCommandSchema(moduleRef, Schema.Unknown))).code).toBe("unsupported_schema")
    } finally {
      document.mockRestore()
    }
  })

  it("follows chained local references and escaped definition names", async () => {
    const document = vi.spyOn(Schema, "toJsonSchemaDocument").mockReturnValue({
      dialect: "draft-2020-12",
      schema: { $ref: "#/$defs/First" },
      definitions: { First: { $ref: "#/$defs/a~1b~0c" }, "a/b~c": { type: "string" } }
    })
    try {
      const command = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Schema.String))
      expect(await Effect.runPromise(command.decode(command.assemble(["value"], {})))).toBe("value")
    } finally {
      document.mockRestore()
    }
  })

  it("keeps help, OpenAPI, and MCP usable beside an unsupported schema", async () => {
    const inputs: Record<string, Schema.Top> = {
      bad: Schema.suspend((): typeof Schema.String => {
        throw new Error("private schema cause")
      }),
      tuple: Schema.Tuple([Schema.String, Schema.Finite]),
      healthy: Schema.Struct({
        nested: Schema.Struct({ mode: Schema.Literals(["fast", "slow"]), count: Schema.Finite })
      })
    }
    const load = vi.spyOn(Route, "load").mockImplementation((route) =>
      Effect.succeed(
        {
          capabilities: [],
          effects: undefined,
          name: route.name,
          input: inputs[route.name]!,
          output: Schema.Void
        } as const
      )
    )
    try {
      const cli = await Effect.runPromise(
        Incur.createCli("flows", Object.keys(inputs).map((name) => makeRoute(name))).pipe(
          Effect.provide(FlowInvoker.layerNoop())
        )
      )
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await cli.fetch(new Request("http://localhost/openapi.json"))
        expect(response.status).toBe(200)
        const spec = await response.json()
        expect(Object.keys(spec.paths).sort()).toEqual(["/bad", "/healthy", "/tuple", "/tuple/{input}"])
        expect(spec.paths["/healthy"].post.requestBody.content["application/json"].schema.properties.nested)
          .toMatchObject({
            properties: { mode: { enum: ["fast", "slow"] }, count: { type: "number" } },
            required: ["mode", "count"]
          })
      }
      const writes: Array<string> = []
      await cli.serve(["--help"], { stdout: (text) => writes.push(text), exit: () => {} })
      expect(writes.join("")).toContain("healthy")
      expect(writes.join("")).toContain("bad")
      const rpc = async (method: string, params: unknown) => {
        const response = await cli.fetch(
          new Request("http://localhost/mcp", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
          })
        )
        expect(response.status).toBe(200)
        return response.json()
      }
      const listing = await rpc("tools/list", {})
      expect(listing.result.tools.length).toBeGreaterThan(0)
      const details = await rpc("tools/call", { name: "get_tool_details", arguments: { name: "healthy" } })
      expect(JSON.parse(details.result.content[0].text).inputSchema.properties.nested).toMatchObject({
        properties: { mode: { enum: ["fast", "slow"] }, count: { type: "number" } },
        required: ["mode", "count"]
      })
      const badDetails = await rpc("tools/call", { name: "get_tool_details", arguments: { name: "bad" } })
      expect(JSON.parse(badDetails.result.content[0].text).name).toBe("bad")
      const failed = await cli.fetch(new Request("http://localhost/bad"))
      expect(failed.status).toBeGreaterThanOrEqual(400)
      expect((await failed.json()).error.code).toBe("unsupported_schema")
    } finally {
      load.mockRestore()
    }
  })

  it("snapshots decoded inputs and encoded outputs as inert JSON", async () => {
    const source = { nested: { value: 1 } }
    const decoded = await Effect.runPromise(SchemaBridge.decodeInput(Schema.Json, source)) as typeof source
    source.nested.value = 2
    expect(decoded).toEqual({ nested: { value: 1 } })
    expect(Object.isFrozen(decoded.nested)).toBe(true)

    expect(await Effect.runPromise(SchemaBridge.encodeOutput(Schema.Void, undefined))).toBeUndefined()
    expect(await Effect.runPromise(SchemaBridge.decodeInput(Schema.Void, undefined))).toBeUndefined()
    expect(await Effect.runPromise(SchemaBridge.encodeOutput(Schema.DateFromString, new Date("2026-01-01")))).toBe(
      "2026-01-01T00:00:00.000Z"
    )
    expect((await failure(SchemaBridge.decodeInput(Schema.DateFromString, "2026-01-01"))).code).toBe("decode_failed")
    expect((await failure(SchemaBridge.encodeOutput(Schema.instanceOf(Date), new Date()))).code).toBe("encode_failed")
  })

  it("converts missing schema services into typed refusals", async () => {
    class Prefix extends Context.Service<Prefix, string>()("test/fs/SchemaBridge/Prefix") {}
    const ServiceSchema = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformEffect({
          decode: (value) => Effect.map(Prefix, (prefix) => `${prefix}${value}`),
          encode: (value) => Effect.map(Prefix, (prefix) => value.slice(prefix.length))
        })
      )
    )

    expect((await failure(SchemaBridge.decodeInput(ServiceSchema, "value"))).code).toBe("decode_failed")
    expect((await failure(SchemaBridge.encodeOutput(ServiceSchema, "prefix:value"))).code).toBe("encode_failed")
    expect(
      await Effect.runPromise(
        SchemaBridge.decodeInput(ServiceSchema, "value").pipe(Effect.provideService(Prefix, "prefix:"))
      )
    ).toBe("prefix:value")
    expect(
      await Effect.runPromise(
        SchemaBridge.encodeOutput(ServiceSchema, "prefix:value").pipe(Effect.provideService(Prefix, "prefix:"))
      )
    ).toBe("value")
  })

  it("snapshots programmatic input before asynchronous loading", async () => {
    const source = { value: [1] }
    const snapshot = await Effect.runPromise(SchemaBridge.snapshotInput(source)) as {
      readonly value: ReadonlyArray<number>
    }
    source.value[0] = 2
    expect(snapshot).toEqual({ value: [1] })
    expect(Object.isFrozen(snapshot.value)).toBe(true)
    expect(await Effect.runPromise(SchemaBridge.snapshotInput(undefined))).toBeUndefined()
    expect((await failure(SchemaBridge.snapshotInput({ value: undefined }))).code).toBe("decode_failed")
  })
})
