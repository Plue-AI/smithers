import { Effect, Layer, PlatformError } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as LanguageServer from "../src/LanguageServer.ts"
import * as Lsp from "../src/Lsp.ts"
import * as StdError from "../src/StdError.ts"
import { fileInfo } from "./TestLayers.ts"

/** A guarded filesystem that authorizes `/workspace` and denies every other path. */
const workspaceFiles = FileSystem.layerNoop({
  stat: (path) =>
    path.startsWith("/workspace/")
      ? Effect.succeed(fileInfo())
      : Effect.fail(PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "stat",
        pathOrDescriptor: path
      }))
})

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
  diagnostics: (path) => Effect.succeed([path]),
  sync: () => Effect.void,
  close: () => Effect.void,
  refresh: Effect.void
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
  diagnostics: (path) => Effect.succeed([{ operation: "diagnostics", path }]),
  sync: () => Effect.void,
  close: () => Effect.void,
  refresh: Effect.void
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
      Lsp.run({ operation, path: "/workspace/a.ts", line: 1, character: 1 }).pipe(
        Effect.provide(dispatchLayer),
        Effect.provide(workspaceFiles)
      )
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
      ]).pipe(Effect.provide(dispatchLayer), Effect.provide(workspaceFiles))
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
      }).pipe(Effect.provide(Layer.succeed(LanguageServer.LanguageServer, failing)), Effect.provide(workspaceFiles))
    ))
    expect(failure).toBe(unavailable)
  })

  it.each([
    { operation: "hover" as const, path: "/workspace/a.ts", line: 2 },
    { operation: "references" as const, path: "/workspace/a.ts", character: 2 },
    { operation: "callHierarchyIncoming" as const, path: "/workspace/a.ts" }
  ])("refuses %s when a position field is missing", async (input) => {
    const failure = await Effect.runPromise(
      Effect.flip(Lsp.run(input).pipe(Effect.provide(layer), Effect.provide(workspaceFiles)))
    )
    expect(failure).toMatchObject({ code: "invalid_input", message: "1-based line and character are required" })
  })

  it.each(["documentSymbols", "diagnostics", "hover"] as const)(
    "refuses %s without a path",
    async (operation) => {
      const failure = await Effect.runPromise(
        Effect.flip(Lsp.run({ operation }).pipe(Effect.provide(layer), Effect.provide(workspaceFiles)))
      )
      expect(failure).toMatchObject({ code: "invalid_input", message: "A normalized absolute path is required" })
    }
  )

  it("normalizes one-based positions before provider dispatch", async () => {
    const output = await Effect.runPromise(
      Lsp.run({ operation: "hover", path: "/workspace/a.ts", line: 2, character: 3 }).pipe(
        Effect.provide(Layer.succeed(LanguageServer.LanguageServer, server)),
        Effect.provide(workspaceFiles)
      )
    )
    expect(output.result).toEqual({ path: "/workspace/a.ts", line: 1, character: 2 })
  })

  it("exposes the unsupported noop path", async () => {
    const exit = await Effect.runPromiseExit(
      Lsp.run({ operation: "diagnostics", path: "/workspace/a.ts" }).pipe(
        Effect.provide(LanguageServer.layerNoop),
        Effect.provide(workspaceFiles)
      )
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
      }).pipe(Effect.provide(Layer.succeed(LanguageServer.LanguageServer, server)), Effect.provide(workspaceFiles))
    )
    expect(output.result).toEqual({ path: "/workspace/a.ts", line: 3, character: 4 })
  })

  it("rejects relative paths before provider dispatch", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Lsp.run({ operation: "diagnostics", path: "src/a.ts" }).pipe(
          Effect.provide(Layer.succeed(LanguageServer.LanguageServer, server)),
          Effect.provide(workspaceFiles)
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

  it.each(["documentSymbols", "diagnostics", "hover"] as const)(
    "refuses %s on a path the guarded filesystem denies, before the server reads it",
    async (operation) => {
      const asked: Array<string> = []
      const recording = LanguageServer.make({
        ...dispatchServer,
        documentSymbols: (path) => Effect.sync(() => asked.push(path)),
        diagnostics: (path) => Effect.sync(() => asked.push(path)),
        hover: (position) => Effect.sync(() => asked.push(position.path))
      })
      const failure = await Effect.runPromise(Effect.flip(
        Lsp.run({ operation, path: "/home/user/.aws/credentials", line: 1, character: 1 }).pipe(
          Effect.provide(Layer.succeed(LanguageServer.LanguageServer, recording)),
          Effect.provide(workspaceFiles)
        )
      ))
      expect(failure).toMatchObject({ code: "permission_denied", path: "/home/user/.aws/credentials" })
      expect(asked).toEqual([])
    }
  )
})
