import { Effect, Layer } from "effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as LanguageServer from "../src/LanguageServer.ts"
import * as Lsp from "../src/Lsp.ts"
import * as StdError from "../src/StdError.ts"

const server = LanguageServer.make({
  hover: (position) => Effect.succeed(position),
  definition: (position) => Effect.succeed(position),
  references: (position) => Effect.succeed([position]),
  implementation: (position) => Effect.succeed(position),
  documentSymbols: (path) => Effect.succeed([path]),
  workspaceSymbols: (query) => Effect.succeed([query]),
  prepareCallHierarchy: (position) => Effect.succeed(position),
  callHierarchyIncoming: (position) => Effect.succeed(position),
  callHierarchyOutgoing: (position) => Effect.succeed(position),
  diagnostics: (path) => Effect.succeed([path])
})

const dispatchServer = LanguageServer.make({
  hover: (position) => Effect.succeed({ operation: "hover", position }),
  definition: (position) => Effect.succeed({ operation: "definition", position }),
  references: (position) => Effect.succeed([{ operation: "references", position }]),
  implementation: (position) => Effect.succeed({ operation: "implementation", position }),
  documentSymbols: (path) => Effect.succeed([{ operation: "documentSymbols", path }]),
  workspaceSymbols: (query) => Effect.succeed([{ operation: "workspaceSymbols", query }]),
  prepareCallHierarchy: (position) => Effect.succeed({ operation: "prepareCallHierarchy", position }),
  callHierarchyIncoming: (position) => Effect.succeed({ operation: "callHierarchyIncoming", position }),
  callHierarchyOutgoing: (position) => Effect.succeed({ operation: "callHierarchyOutgoing", position }),
  diagnostics: (path) => Effect.succeed([{ operation: "diagnostics", path }])
})

describe("Lsp", () => {
  const layer = Layer.succeed(LanguageServer.LanguageServer, server)
  const dispatchLayer = Layer.succeed(LanguageServer.LanguageServer, dispatchServer)

  it.each(
    [
      "hover",
      "definition",
      "implementation",
      "prepareCallHierarchy",
      "callHierarchyIncoming",
      "callHierarchyOutgoing"
    ] as const
  )("dispatches %s with a zero-based provider position", async (operation) => {
    const output = await Effect.runPromise(
      Lsp.run({ operation, path: "/workspace/a.ts", line: 1, character: 1 }).pipe(Effect.provide(dispatchLayer))
    )
    expect(output.result).toEqual({ operation, position: { path: "/workspace/a.ts", line: 0, character: 0 } })
  })

  it("passes references, document symbols, diagnostics, and workspace symbols through", async () => {
    const results = await Effect.runPromise(
      Effect.all([
        Lsp.run({ operation: "references", path: "/workspace/a.ts", line: 3, character: 2 }),
        Lsp.run({ operation: "documentSymbols", path: "/workspace/a.ts" }),
        Lsp.run({ operation: "diagnostics", path: "/workspace/a.ts" }),
        Lsp.run({ operation: "workspaceSymbols", query: "Builder" }),
        Lsp.run({ operation: "workspaceSymbols" })
      ]).pipe(Effect.provide(dispatchLayer))
    )
    expect(results.map(({ result }) => result)).toEqual([
      [{ operation: "references", position: { path: "/workspace/a.ts", line: 2, character: 1 } }],
      [{ operation: "documentSymbols", path: "/workspace/a.ts" }],
      [{ operation: "diagnostics", path: "/workspace/a.ts" }],
      [{ operation: "workspaceSymbols", query: "Builder" }],
      [{ operation: "workspaceSymbols", query: "" }]
    ])
  })

  it("preserves the provider's typed failure", async () => {
    const unavailable = new StdError.StdError({ code: "request_failed", message: "language server disconnected" })
    const failing = LanguageServer.make({
      ...dispatchServer,
      hover: () => Effect.fail(unavailable)
    })
    const failure = await Effect.runPromise(Effect.flip(
      Lsp.run({
        operation: "hover",
        path: "/workspace/a.ts",
        line: 1,
        character: 1
      }).pipe(Effect.provide(Layer.succeed(LanguageServer.LanguageServer, failing)))
    ))
    expect(failure).toBe(unavailable)
  })

  it.each([
    { operation: "hover" as const, path: "/workspace/a.ts", line: 2 },
    { operation: "references" as const, path: "/workspace/a.ts", character: 2 },
    { operation: "callHierarchyIncoming" as const, path: "/workspace/a.ts" }
  ])("refuses %s when a position field is missing", async (input) => {
    const failure = await Effect.runPromise(Effect.flip(Lsp.run(input).pipe(Effect.provide(layer))))
    expect(failure).toMatchObject({ code: "invalid_input", message: "1-based line and character are required" })
  })

  it.each(["documentSymbols", "diagnostics", "hover"] as const)(
    "refuses %s without a path",
    async (operation) => {
      const failure = await Effect.runPromise(Effect.flip(Lsp.run({ operation }).pipe(Effect.provide(layer))))
      expect(failure).toMatchObject({ code: "invalid_input", message: "A normalized absolute path is required" })
    }
  )

  it("normalizes one-based positions before provider dispatch", async () => {
    const output = await Effect.runPromise(
      Lsp.run({ operation: "hover", path: "/workspace/a.ts", line: 2, character: 3 }).pipe(
        Effect.provide(Layer.succeed(LanguageServer.LanguageServer, server))
      )
    )
    expect(output.result).toEqual({ path: "/workspace/a.ts", line: 1, character: 2 })
  })

  it("exposes the unsupported noop path", async () => {
    const exit = await Effect.runPromiseExit(
      Lsp.run({ operation: "diagnostics", path: "/workspace/a.ts" }).pipe(Effect.provide(LanguageServer.layerNoop))
    )
    expect(exit._tag).toBe("Failure")
  })

  it("dispatches prepareCallHierarchy with normalized positions", async () => {
    const output = await Effect.runPromise(
      Lsp.run({
        operation: "prepareCallHierarchy",
        path: "/workspace/a.ts",
        line: 4,
        character: 5
      }).pipe(Effect.provide(Layer.succeed(LanguageServer.LanguageServer, server)))
    )
    expect(output.result).toEqual({ path: "/workspace/a.ts", line: 3, character: 4 })
  })

  it("rejects relative paths before provider dispatch", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Lsp.run({ operation: "diagnostics", path: "src/a.ts" }).pipe(
          Effect.provide(Layer.succeed(LanguageServer.LanguageServer, server))
        )
      )
    )
    expect(failure).toMatchObject({
      code: "invalid_input"
    })
  })
  it("describes every model-facing input field", () => {
    // The annotations are what a model reads when it decides how to call the
    // flow, and this was the one flow schema that carried none. `Output.result`
    // is `Schema.Unknown`, which JSON Schema renders as `{}`: its description
    // lives in the source annotation and cannot appear here.
    const document = Schema.toJsonSchemaDocument(Lsp.Input).schema as {
      readonly properties: Readonly<Record<string, unknown>>
    }
    const fields = Object.values(document.properties)
    expect(fields).toHaveLength(5)
    expect(fields.every((field) => JSON.stringify(field).includes("\"description\""))).toBe(true)
  })
})
