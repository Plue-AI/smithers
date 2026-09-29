import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Queue, type Scope, Sink, Stream } from "effect"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as Edit from "../src/Edit.ts"
import * as Diagnostics from "../src/internal/Diagnostics.ts"
import * as LanguageServer from "../src/LanguageServer.ts"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"
import * as StdError from "../src/StdError.ts"
import * as Write from "../src/Write.ts"
import { layer } from "./TestLayers.ts"

type Message = Readonly<Record<string, any>>

const decodeFrame = (frame: Uint8Array): Message => {
  const text = new TextDecoder().decode(frame)
  return JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4)) as Message
}

const encodeFrame = (value: unknown): Uint8Array => {
  const body = new TextEncoder().encode(JSON.stringify(value))
  const header = new TextEncoder().encode(`Content-Length: ${body.byteLength}\r\n\r\n`)
  const frame = new Uint8Array(header.length + body.length)
  frame.set(header)
  frame.set(body, header.length)
  return frame
}

type Responder = (message: Message, reply: (value: unknown) => Effect.Effect<void>) => Effect.Effect<void>

/** A spawner whose processes are scripted per command, recording every frame each receives. */
const fakeServers = (servers: Readonly<Record<string, Responder>>) => {
  const received: Array<{ readonly command: string; readonly message: Message }> = []
  const spawner = ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.gen(function*() {
        const standard = command as ChildProcess.StandardCommand
        const responder = servers[standard.command]!
        const stdin = (standard.options.stdin as ChildProcess.StdinConfig).stream as Stream.Stream<Uint8Array>
        const output = yield* Queue.unbounded<Uint8Array, Cause.Done>()
        const reply = (value: unknown) => Queue.offer(output, encodeFrame(value)).pipe(Effect.asVoid)
        yield* stdin.pipe(
          Stream.runForEach((bytes) => {
            const message = decodeFrame(bytes)
            received.push({ command: standard.command, message })
            return message.method === "initialize"
              ? reply({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } })
              : responder(message, reply)
          }),
          Effect.forkScoped({ startImmediately: true })
        )
        return makeHandle({
          pid: ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.fromQueue(output),
          stderr: Stream.empty,
          all: Stream.fromQueue(output),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
  })
  return { spawner, received }
}

/** One error per line of `text` that contains `ERROR`. */
const errorsIn = (text: string) =>
  text.split("\n").flatMap((line, index) =>
    line.includes("ERROR")
      ? [{
        range: { start: { line: index, character: line.indexOf("ERROR") }, end: { line: index, character: 0 } },
        severity: 1,
        message: `bad ${index}`
      }]
      : []
  )

const methodNotFound = (message: Message) => ({
  jsonrpc: "2.0",
  id: message.id,
  error: { code: -32601, message: "Unhandled method" }
})

/**
 * A push-only server: pull diagnostics are MethodNotFound, and every
 * didOpen/didChange is answered by a versioned publishDiagnostics.
 */
const pushOnly =
  (options?: { readonly versioned?: boolean; readonly silent?: boolean }): Responder => (message, reply) => {
    if (message.method === "textDocument/diagnostic") return reply(methodNotFound(message))
    if (options?.silent === true) return Effect.void
    const document = message.params?.textDocument
    const text = message.method === "textDocument/didOpen"
      ? document.text as string
      : message.method === "textDocument/didChange"
      ? message.params.contentChanges[0].text as string
      : undefined
    if (text === undefined) {
      return typeof message.id === "number"
        ? reply({ jsonrpc: "2.0", id: message.id, result: null })
        : Effect.void
    }
    return reply({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: document.uri,
        ...(options?.versioned === false ? {} : { version: document.version }),
        diagnostics: errorsIn(text)
      }
    })
  }

const run = <A, E>(
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))))

const failureOf = <A>(exit: Exit.Exit<A, StdError.StdError>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined

const uri = (path: string) => pathToFileURL(path).href

describe("NodeLanguageServer document sync", () => {
  it("sends didOpen then didChange and returns diagnostics a push-only server publishes", async () => {
    const { spawner, received } = fakeServers({ ts: pushOnly() })
    const result = await run(
      Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace" })
        yield* server.sync("/workspace/a.ts", "const a = 1\n")
        const first = yield* server.diagnostics("/workspace/a.ts")
        yield* server.sync("/workspace/a.ts", "const a = 1\nERROR\n")
        const second = yield* server.diagnostics("/workspace/a.ts")
        return { first, second }
      }),
      spawner
    )
    expect(received.map(({ message }) => message.method)).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/diagnostic",
      "textDocument/didChange"
    ])
    expect(received[0]!.message.params.capabilities.textDocument.publishDiagnostics).toEqual({ versionSupport: true })
    expect(received[2]!.message.params).toEqual({
      textDocument: { uri: uri("/workspace/a.ts"), languageId: "typescript", version: 1, text: "const a = 1\n" }
    })
    expect(received[4]!.message.params).toEqual({
      textDocument: { uri: uri("/workspace/a.ts"), version: 2 },
      contentChanges: [{ text: "const a = 1\nERROR\n" }]
    })
    expect(result.first).toEqual({ kind: "full", items: [] })
    expect(result.second).toEqual({ kind: "full", items: errorsIn("const a = 1\nERROR\n") })
  })

  it("keeps pulling from a server that answers textDocument/diagnostic", async () => {
    const { spawner, received } = fakeServers({
      ts: (message, reply) =>
        message.method === "textDocument/diagnostic"
          ? reply({ jsonrpc: "2.0", id: message.id, result: { kind: "full", items: ["pulled"] } })
          : Effect.void
    })
    const result = await run(
      Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace" })
        yield* server.sync("a.ts", "x")
        return [yield* server.diagnostics("a.ts"), yield* server.diagnostics("a.ts")]
      }),
      spawner
    )
    expect(result).toEqual([{ kind: "full", items: ["pulled"] }, { kind: "full", items: ["pulled"] }])
    expect(received.filter(({ message }) => message.method === "textDocument/diagnostic")).toHaveLength(2)
    // A relative path is the server's cwd.
    expect(received[2]!.message.params.textDocument.uri).toBe(uri("/workspace/a.ts"))
  })

  it("does not report a publish for an older version as current", async () => {
    const { spawner } = fakeServers({
      ts: (message, reply) =>
        message.method === "textDocument/diagnostic"
          ? reply(methodNotFound(message))
          : message.method === "textDocument/didChange"
          ? reply({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: { uri: message.params.textDocument.uri, version: 1, diagnostics: ["stale"] }
          })
          : Effect.void
    })
    const exit = await run(
      Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace", settleMs: 50 })
        yield* server.sync("/workspace/a.ts", "one")
        yield* server.sync("/workspace/a.ts", "two")
        return yield* Effect.exit(server.diagnostics("/workspace/a.ts"))
      }),
      spawner
    )
    expect(failureOf(exit)).toMatchObject({ code: "timeout", method: "textDocument/publishDiagnostics" })
  })

  it("accepts an unversioned publish that arrives after the sync", async () => {
    const { spawner } = fakeServers({ ts: pushOnly({ versioned: false }) })
    const result = await run(
      Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace" })
        yield* server.sync("/workspace/a.ts", "ERROR")
        return yield* server.diagnostics("/workspace/a.ts")
      }),
      spawner
    )
    expect(result).toEqual({ kind: "full", items: errorsIn("ERROR") })
  })

  it("waits for a publish that arrives after diagnostics is asked", async () => {
    let publish: Effect.Effect<void> = Effect.void
    const { spawner } = fakeServers({
      ts: (message, reply) => {
        if (message.method === "textDocument/diagnostic") {
          return reply(methodNotFound(message)).pipe(
            Effect.andThen(Effect.forkDetach(Effect.sleep(20).pipe(Effect.andThen(publish)))),
            Effect.asVoid
          )
        }
        if (message.method === "textDocument/didOpen") {
          publish = reply({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: { uri: message.params.textDocument.uri, version: 1, diagnostics: ["late"] }
          })
        }
        return Effect.void
      }
    })
    const result = await run(
      Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace" })
        yield* server.sync("/workspace/a.ts", "x")
        return yield* server.diagnostics("/workspace/a.ts")
      }),
      spawner
    )
    expect(result).toEqual({ kind: "full", items: ["late"] })
  })

  it("opens a file from disk when a push-only server is asked about an unsynced one", async () => {
    const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "lsp-sync-"))
    NodeFs.writeFileSync(NodePath.join(directory, "b.py"), "ERROR\n")
    const { spawner, received } = fakeServers({ py: pushOnly() })
    try {
      const result = await run(
        Effect.gen(function*() {
          const server = yield* NodeLanguageServer.make({ command: "py", cwd: directory })
          const report = yield* server.diagnostics(NodePath.join(directory, "b.py"))
          const missing = yield* Effect.exit(server.diagnostics(NodePath.join(directory, "missing.py")))
          return { report, missing }
        }),
        spawner
      )
      expect(result.report).toEqual({ kind: "full", items: errorsIn("ERROR\n") })
      expect(failureOf(result.missing)).toMatchObject({ code: "not_found" })
      const opened = received.find(({ message }) => message.method === "textDocument/didOpen")!.message
      expect(opened.params.textDocument).toMatchObject({ languageId: "python", version: 1, text: "ERROR\n" })
      // The second diagnostics call skips the pull the server already refused.
      expect(received.filter(({ message }) => message.method === "textDocument/diagnostic")).toHaveLength(1)
    } finally {
      NodeFs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("ignores malformed publishDiagnostics notifications", async () => {
    const { spawner } = fakeServers({
      ts: (message, reply) =>
        message.method === "textDocument/diagnostic"
          ? reply(methodNotFound(message))
          : message.method === "textDocument/didOpen"
          ? reply({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: 7, diagnostics: [] } })
            .pipe(
              Effect.andThen(reply({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: null })),
              Effect.andThen(
                reply({
                  jsonrpc: "2.0",
                  method: "textDocument/publishDiagnostics",
                  params: { uri: message.params.textDocument.uri }
                })
              )
            )
          : Effect.void
    })
    const exit = await run(
      Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace", settleMs: 50 })
        yield* server.sync("/workspace/a.ts", "x")
        return yield* Effect.exit(server.diagnostics("/workspace/a.ts"))
      }),
      spawner
    )
    expect(failureOf(exit)?.code).toBe("timeout")
  })

  it("passes a pull failure other than MethodNotFound through", async () => {
    const { spawner } = fakeServers({
      ts: (message, reply) =>
        message.method === "textDocument/diagnostic"
          ? reply({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "boom" } })
          : Effect.void
    })
    const exit = await run(
      Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace" })
        return yield* Effect.exit(server.diagnostics("/workspace/a.ts"))
      }),
      spawner
    )
    expect(failureOf(exit)).toMatchObject({ code: "request_failed", rpcError: { code: -32603 } })
  })

  it.each([
    [".mts", "typescript"],
    [".tsx", "typescriptreact"],
    [".rs", "rust"],
    [".zig", "zig"],
    ["", "plaintext"]
  ])("opens %s files as %s", async (extension, languageId) => {
    const { spawner, received } = fakeServers({ any: pushOnly() })
    await run(
      Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make({ command: "any", cwd: "/workspace" })
        yield* server.sync(`/workspace/file${extension}`, "")
        // A request answered after the sync proves the server read it.
        yield* server.hover({ path: "/workspace/a.ts", line: 0, character: 0 })
      }),
      spawner
    )
    expect(received[2]!.message.params.textDocument.languageId).toBe(languageId)
  })
})

describe("NodeLanguageServer close", () => {
  it("closes a synced file once and reopens it on the next sync", async () => {
    const { spawner, received } = fakeServers({ ts: pushOnly() })
    await run(
      Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace" })
        yield* server.close("/workspace/never.ts")
        yield* server.sync("/workspace/a.ts", "one")
        yield* server.close("/workspace/a.ts")
        yield* server.close("/workspace/a.ts")
        yield* server.sync("/workspace/a.ts", "two")
        yield* server.hover({ path: "/workspace/a.ts", line: 0, character: 0 })
      }),
      spawner
    )
    const lifecycle = received.slice(2, -1).map(({ message }) => [message.method, message.params.textDocument])
    expect(lifecycle).toEqual([
      ["textDocument/didOpen", { uri: uri("/workspace/a.ts"), languageId: "typescript", version: 1, text: "one" }],
      ["textDocument/didClose", { uri: uri("/workspace/a.ts") }],
      ["textDocument/didOpen", { uri: uri("/workspace/a.ts"), languageId: "typescript", version: 2, text: "two" }]
    ])
  })

  it("keeps a newer publish over a late one for an older version", async () => {
    const { spawner } = fakeServers({
      ts: (message, reply) => {
        if (message.method === "textDocument/diagnostic") return reply(methodNotFound(message))
        if (message.method !== "textDocument/didChange") return Effect.void
        const at = (version: number) =>
          reply({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: { uri: message.params.textDocument.uri, version, diagnostics: [`v${version}`] }
          })
        return at(2).pipe(Effect.andThen(at(1)))
      }
    })
    const report = await run(
      Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace", settleMs: 1_000 })
        yield* server.sync("/workspace/a.ts", "one")
        yield* server.sync("/workspace/a.ts", "two")
        return yield* server.diagnostics("/workspace/a.ts")
      }),
      spawner
    )
    expect(report).toEqual({ kind: "full", items: ["v2"] })
  })
})

describe("NodeLanguageServer routing", () => {
  const configs: ReadonlyArray<NodeLanguageServer.Config> = [
    { command: "ts", cwd: "/workspace", extensions: [".ts", "TSX"] },
    { command: "py", cwd: "/workspace", extensions: ["py"] }
  ]

  it("sends .ts and .py files to different servers", async () => {
    const answer: Responder = (message, reply) =>
      typeof message.id === "number" ? reply({ jsonrpc: "2.0", id: message.id, result: [message.method] }) : Effect.void
    const { spawner, received } = fakeServers({ ts: answer, py: answer })
    const result = await run(
      Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make(configs)
        yield* server.sync("/workspace/a.ts", "a")
        yield* server.sync("/workspace/b.py", "b")
        yield* server.sync("/workspace/c.TSX", "c")
        yield* server.close("/workspace/b.py")
        const position = { line: 0, character: 0 }
        yield* server.hover({ path: "/workspace/a.ts", ...position })
        yield* server.definition({ path: "/workspace/b.py", ...position })
        yield* server.references({ path: "/workspace/a.ts", ...position })
        yield* server.implementation({ path: "/workspace/b.py", ...position })
        yield* server.prepareCallHierarchy({ path: "/workspace/a.ts", ...position })
        yield* server.callHierarchyIncoming({ path: "/workspace/b.py", ...position })
        yield* server.callHierarchyOutgoing({ path: "/workspace/a.ts", ...position })
        yield* server.documentSymbols("/workspace/b.py")
        yield* server.diagnostics("/workspace/a.ts")
        const unrouted = yield* Effect.exit(server.hover({ path: "/workspace/c.go", ...position }))
        const symbols = yield* server.workspaceSymbols("x")
        return { unrouted, symbols }
      }),
      spawner
    )
    const by = (command: string) =>
      received.filter((entry) =>
        entry.command === command && entry.message.method !== "initialize" && entry.message.method !== "initialized"
      )
        .map(({ message }) => message.method as string)
    expect(by("ts")).toEqual([
      "textDocument/didOpen",
      "textDocument/didOpen",
      "textDocument/hover",
      "textDocument/references",
      "textDocument/prepareCallHierarchy",
      "textDocument/prepareCallHierarchy",
      "callHierarchy/outgoingCalls",
      "textDocument/diagnostic",
      "workspace/symbol"
    ])
    expect(by("py")).toEqual([
      "textDocument/didOpen",
      "textDocument/didClose",
      "textDocument/definition",
      "textDocument/implementation",
      "textDocument/prepareCallHierarchy",
      "callHierarchy/incomingCalls",
      "textDocument/documentSymbol",
      "workspace/symbol"
    ])
    expect(failureOf(result.unrouted)).toMatchObject({
      code: "unsupported",
      message: "No language server is configured for .go files"
    })
    expect(result.symbols).toEqual(["workspace/symbol", "workspace/symbol"])
  })

  it("sends unclaimed files to the server that declares no extensions", async () => {
    const { spawner, received } = fakeServers({
      ts: (message, reply) =>
        message.method === "workspace/symbol" ? reply({ jsonrpc: "2.0", id: message.id, result: null }) : Effect.void,
      rest: (message, reply) =>
        message.method === "workspace/symbol"
          ? reply({ jsonrpc: "2.0", id: message.id, result: { name: "x" } })
          : Effect.void
    })
    const symbols = await run(
      Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make([
          { command: "ts", cwd: "/workspace", extensions: [".ts"] },
          { command: "rest", cwd: "/workspace" }
        ])
        yield* server.sync("/workspace/Makefile", "all:")
        return yield* server.workspaceSymbols("x")
      }),
      spawner
    )
    expect(received.find(({ message }) => message.method === "textDocument/didOpen")?.command).toBe("rest")
    expect(symbols).toEqual([{ name: "x" }])
  })

  it("reports an extensionless file no server claims", async () => {
    const { spawner } = fakeServers({ ts: () => Effect.void })
    const exit = await run(
      Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace", extensions: [".ts"] })
        return yield* Effect.exit(server.sync("/workspace/Makefile", "all:"))
      }),
      spawner
    )
    expect(failureOf(exit)?.message).toBe("No language server is configured for extensionless files")
  })

  it("refuses an empty server list", async () => {
    const { spawner } = fakeServers({})
    const exit = await run(Effect.exit(NodeLanguageServer.make([])), spawner)
    expect(failureOf(exit)).toMatchObject({ code: "invalid_input" })
  })
})

const recording = (
  diagnostics: LanguageServer.LanguageServer["diagnostics"],
  options?: { readonly syncFails?: boolean }
) => {
  const synced: Array<readonly [string, string]> = []
  const closed: Array<string> = []
  let asked = 0
  const server = LanguageServer.make({
    ...LanguageServer.makeNoop(),
    sync: (path, text) =>
      options?.syncFails === true
        ? Effect.fail(new StdError.StdError({ code: "request_failed", message: "gone" }))
        : Effect.sync(() => void synced.push([path, text])),
    close: (path) => Effect.sync(() => void closed.push(path)),
    diagnostics: (path) => Effect.suspend(() => (asked++, diagnostics(path)))
  })
  return { synced, closed, asked: () => asked, layer: Layer.succeed(LanguageServer.LanguageServer, server) }
}

describe("mutation flows keep the language server in step", () => {
  it("attaches the errors a push-only server reports to Edit's output", async () => {
    const { spawner, received } = fakeServers({ ts: pushOnly() })
    const outputs = await run(
      Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make({ command: "ts", cwd: "/" })
        const edit = (oldString: string, newString: string) =>
          Edit.run({ path: "/a.ts", oldString, newString }).pipe(
            Effect.provideService(LanguageServer.LanguageServer, server),
            Effect.provide(layer({ files: { "/a.ts": "const a = 1\nconst b = 2\n" } }))
          )
        return [yield* edit("const b = 2", "ERROR b"), yield* edit("const b = 2", "const b = 3")]
      }),
      spawner
    )
    expect(outputs[0]!.errors).toEqual([{ line: 2, character: 1, message: "bad 1" }])
    expect(outputs[1]!.errors).toEqual([])
    expect(received.map(({ message }) => message.method)).toContain("textDocument/didChange")
  })

  it("leaves errors off Edit's output when no server is bound or it fails", async () => {
    const files = { "/a.ts": "x" }
    const unbound = await Effect.runPromise(
      Edit.run({ path: "/a.ts", oldString: "x", newString: "y" }).pipe(Effect.provide(layer({ files })))
    )
    const failing = recording(() => Effect.fail(new StdError.StdError({ code: "timeout", message: "slow" })))
    const failed = await Effect.runPromise(
      Edit.run({ path: "/a.ts", oldString: "x", newString: "y" }).pipe(
        Effect.provide(failing.layer),
        Effect.provide(layer({ files }))
      )
    )
    const noop = await Effect.runPromise(
      Edit.run({ path: "/a.ts", oldString: "x", newString: "y" }).pipe(
        Effect.provide(LanguageServer.layerNoop),
        Effect.provide(layer({ files }))
      )
    )
    expect("errors" in unbound).toBe(false)
    expect("errors" in failed).toBe(false)
    expect(failing.synced).toEqual([["/a.ts", "y"]])
    expect("errors" in noop).toBe(false)
    expect(failing.asked()).toBe(1)
  })

  it("deletes through ApplyPatch with no server bound", async () => {
    const output = await Effect.runPromise(
      ApplyPatch.run({ input: "*** Begin Patch\n*** Delete File: /gone.ts\n*** End Patch" }).pipe(
        Effect.provide(layer({ files: { "/gone.ts": "x" } }))
      )
    )
    expect(output.deleted).toEqual(["/gone.ts"])
  })

  it("does not ask for diagnostics when the sync failed", async () => {
    const recorder = recording(() => Effect.succeed({ kind: "full", items: [] }), { syncFails: true })
    const output = await Effect.runPromise(
      Edit.run({ path: "/a.ts", oldString: "x", newString: "y" }).pipe(
        Effect.provide(recorder.layer),
        Effect.provide(layer({ files: { "/a.ts": "x" } }))
      )
    )
    expect(output).toMatchObject({ path: "/a.ts", replacements: 1 })
    expect("errors" in output).toBe(false)
    expect(recorder.asked()).toBe(0)
  })

  it("syncs what Write and ApplyPatch write", async () => {
    const recorder = recording(() => Effect.succeed({ kind: "full", items: [] }))
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* Write.run({ path: "/w.ts", content: "written" })
        yield* ApplyPatch.run({
          input: [
            "*** Begin Patch",
            "*** Add File: /added.ts",
            "+new",
            "*** Update File: /old.ts",
            "*** Move to: /moved.ts",
            "@@",
            "-old",
            "+changed",
            "*** Delete File: /gone.ts",
            "*** End Patch"
          ].join("\n")
        })
      }).pipe(Effect.provide(recorder.layer), Effect.provide(layer({ files: { "/old.ts": "old\n", "/gone.ts": "x" } })))
    )
    expect(recorder.synced).toEqual([
      ["/w.ts", "written"],
      ["/added.ts", "new\n"],
      ["/moved.ts", "changed\n"]
    ])
    expect(recorder.closed).toEqual(["/old.ts", "/gone.ts"])
  })
})

describe("Diagnostics.errors", () => {
  it("keeps error-severity items at 1-based positions and skips the rest", () => {
    const at = (line: number, character: number) => ({ start: { line, character } })
    expect(Diagnostics.errors(undefined)).toEqual([])
    expect(Diagnostics.errors([])).toEqual([])
    expect(Diagnostics.errors({ items: "no" })).toEqual([])
    expect(Diagnostics.errors({
      items: [
        { severity: 1, message: "kept", range: at(0, 4) },
        { severity: 2, message: "warning", range: at(1, 0) },
        { message: "no severity", range: at(1, 0) },
        { severity: 1, message: 3, range: at(1, 0) },
        { severity: 1, message: "no range" },
        { severity: 1, message: "bad start", range: { start: { line: "1", character: 0 } } },
        { severity: 1, message: "bad character", range: { start: { line: 1 } } },
        null
      ]
    })).toEqual([{ line: 1, character: 5, message: "kept" }])
  })

  it("caps the attached errors", () => {
    const items = Array.from({ length: 30 }, (_, line) => ({
      severity: 1,
      message: `e${line}`,
      range: { start: { line, character: 0 } }
    }))
    expect(Diagnostics.errors({ items })).toHaveLength(Diagnostics.MAX_ERRORS)
  })
})
