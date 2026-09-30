import * as Capability from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
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

/**
 * A spawner whose processes are scripted per command, recording every frame
 * each receives. The client's `$/` barrier requests are answered with
 * MethodNotFound, as the specification requires, and counted apart, unless
 * `barrier` is `"ignore"`.
 */
const fakeServers = (
  servers: Readonly<Record<string, Responder>>,
  options?: { readonly barrier?: "answer" | "ignore" }
) => {
  const received: Array<{ readonly command: string; readonly message: Message }> = []
  const barriers: Array<string> = []
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
            if (message.method === "$/smithers/barrier") {
              barriers.push(standard.command)
              return options?.barrier === "ignore" ? Effect.void : reply(methodNotFound(message))
            }
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
  return { spawner, received, barriers }
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
  let refreshed = 0
  const server = LanguageServer.make({
    ...LanguageServer.makeNoop(),
    sync: (path, text) =>
      options?.syncFails === true
        ? Effect.fail(new StdError.StdError({ code: "request_failed", message: "gone" }))
        : Effect.sync(() => void synced.push([path, text])),
    close: (path) => Effect.sync(() => void closed.push(path)),
    refresh: Effect.sync(() => void refreshed++),
    diagnostics: (path) => Effect.suspend(() => (asked++, diagnostics(path)))
  })
  return {
    synced,
    closed,
    asked: () => asked,
    refreshed: () => refreshed,
    layer: Layer.succeed(LanguageServer.LanguageServer, server)
  }
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

/** Publishes `diagnostics` for `message`'s document, unversioned, the way typescript-language-server does. */
const publishFor = (
  message: Message,
  reply: (value: unknown) => Effect.Effect<void>,
  diagnostics: ReadonlyArray<unknown>
) =>
  reply({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri: message.params.textDocument.uri, diagnostics }
  })

const textOf = (message: Message): string | undefined =>
  message.method === "textDocument/didOpen"
    ? message.params.textDocument.text as string
    : message.method === "textDocument/didChange"
    ? message.params.contentChanges[0].text as string
    : undefined

describe("NodeLanguageServer push settle", () => {
  it("answers with the semantic publish that follows a syntax-only one", async () => {
    // typescript-language-server's first open: syntax errors (none) first, the
    // type errors in a later publish.
    const server = (message: Message, reply: (value: unknown) => Effect.Effect<void>) => {
      if (message.method === "textDocument/diagnostic") return reply(methodNotFound(message))
      const text = textOf(message)
      if (text === undefined) return Effect.void
      return publishFor(message, reply, []).pipe(
        Effect.andThen(
          Effect.forkDetach(Effect.sleep(100).pipe(Effect.andThen(publishFor(message, reply, errorsIn(text)))))
        )
      )
    }
    const answer = (quietMs: number | undefined) => {
      const { spawner } = fakeServers({ ts: server })
      return run(
        Effect.gen(function*() {
          const client = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace", quietMs })
          yield* client.sync("/workspace/a.ts", "ERROR")
          return yield* client.diagnostics("/workspace/a.ts")
        }),
        spawner
      )
    }
    expect(await answer(undefined)).toEqual({ kind: "full", items: errorsIn("ERROR") })
    // A quiet window shorter than the gap answers with the syntax-only report.
    expect(await answer(20)).toEqual({ kind: "full", items: [] })
  })

  it("times out on a change the server publishes nothing for", async () => {
    // typescript-language-server skips the publish when a file with no
    // problems still has none; the client does not guess that it stayed clean.
    let last: ReadonlyArray<unknown> | undefined
    const { spawner } = fakeServers({
      ts: (message, reply) => {
        if (message.method === "textDocument/diagnostic") return reply(methodNotFound(message))
        const text = textOf(message)
        if (text === undefined) return Effect.void
        const diagnostics = errorsIn(text)
        const skip = last !== undefined && last.length === 0 && diagnostics.length === 0
        last = diagnostics
        return skip ? Effect.void : publishFor(message, reply, diagnostics)
      }
    })
    const results = await run(
      Effect.gen(function*() {
        const client = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace", settleMs: 50, quietMs: 10 })
        const answer = (text: string) =>
          client.sync("/workspace/a.ts", text).pipe(
            Effect.andThen(Effect.exit(client.diagnostics("/workspace/a.ts")))
          )
        return [yield* answer("clean"), yield* answer("still clean"), yield* answer("ERROR")]
      }),
      spawner
    )
    expect(results[0]).toEqual(Exit.succeed({ kind: "full", items: [] }))
    expect(failureOf(results[1]!)).toMatchObject({ code: "timeout" })
    expect(results[2]).toEqual(Exit.succeed({ kind: "full", items: errorsIn("ERROR") }))
  })

  it("never reads the report a server publishes on close as the reopened file's", async () => {
    // typescript-language-server publishes an empty report for a file as it
    // closes, which reaches the client after the reopen was sent.
    const { spawner, barriers } = fakeServers({
      ts: (message, reply) => {
        if (message.method === "textDocument/diagnostic") return reply(methodNotFound(message))
        if (message.method === "textDocument/didClose") {
          return Effect.sleep(30).pipe(Effect.andThen(publishFor(message, reply, [])))
        }
        const text = textOf(message)
        if (text === undefined) return Effect.void
        return Effect.forkDetach(Effect.sleep(50).pipe(Effect.andThen(publishFor(message, reply, errorsIn(text)))))
          .pipe(
            Effect.asVoid
          )
      }
    })
    const report = await run(
      Effect.gen(function*() {
        const client = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace", quietMs: 20 })
        yield* client.sync("/workspace/a.ts", "ERROR")
        yield* client.diagnostics("/workspace/a.ts")
        yield* client.close("/workspace/a.ts")
        yield* client.sync("/workspace/a.ts", "ERROR\nERROR")
        return yield* client.diagnostics("/workspace/a.ts")
      }),
      spawner
    )
    expect(report).toEqual({ kind: "full", items: errorsIn("ERROR\nERROR") })
    expect(barriers).toEqual(["ts", "ts"])
  })

  it("stops asking a server that does not answer the barrier", async () => {
    const { spawner, barriers } = fakeServers({ ts: pushOnly({ versioned: false }) }, { barrier: "ignore" })
    const timings = await run(
      Effect.gen(function*() {
        const client = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace" })
        const timed = (text: string) =>
          Effect.gen(function*() {
            const started = performance.now()
            yield* client.sync("/workspace/a.ts", text)
            const report = yield* client.diagnostics("/workspace/a.ts")
            return { ms: performance.now() - started, report }
          })
        return [yield* timed("ERROR"), yield* timed("clean")]
      }),
      spawner
    )
    expect(timings[0]!.ms).toBeGreaterThanOrEqual(990)
    expect(timings[1]!.ms).toBeLessThan(900)
    expect(timings.map(({ report }) => report)).toEqual([
      { kind: "full", items: errorsIn("ERROR") },
      { kind: "full", items: [] }
    ])
    expect(barriers).toEqual(["ts"])
  })

  it("needs no barrier once a server versions its publishes or answers a pull", async () => {
    const versioned = fakeServers({ ts: pushOnly() })
    const pulled = fakeServers({
      ts: (message, reply) =>
        message.method === "textDocument/diagnostic"
          ? reply({ jsonrpc: "2.0", id: message.id, result: { kind: "full", items: [] } })
          : Effect.void
    })
    for (const { spawner } of [versioned, pulled]) {
      await run(
        Effect.gen(function*() {
          const client = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace" })
          for (const text of ["one", "two", "three"]) {
            yield* client.sync("/workspace/a.ts", text)
            yield* client.diagnostics("/workspace/a.ts")
          }
        }),
        spawner
      )
    }
    expect(versioned.barriers).toEqual(["ts"])
    expect(pulled.barriers).toEqual(["ts"])
  })

  it("answers within settleMs from a server that keeps publishing", async () => {
    const { spawner } = fakeServers({
      ts: (message, reply) => {
        if (message.method === "textDocument/diagnostic") return reply(methodNotFound(message))
        if (message.method !== "textDocument/didOpen") return Effect.void
        let count = 0
        return Effect.forkDetach(
          Effect.forever(
            Effect.suspend(() => publishFor(message, reply, [++count])).pipe(Effect.andThen(Effect.sleep(10)))
          )
        ).pipe(Effect.asVoid)
      }
    })
    const started = performance.now()
    const report = await run(
      Effect.gen(function*() {
        const client = yield* NodeLanguageServer.make({ command: "ts", cwd: "/workspace", settleMs: 150, quietMs: 50 })
        yield* client.sync("/workspace/a.ts", "x")
        return yield* client.diagnostics("/workspace/a.ts")
      }),
      spawner
    ) as { readonly items: ReadonlyArray<number> }
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(140)
    expect(elapsed).toBeLessThan(1_000)
    expect(report.items[0]).toBeGreaterThan(5)
  })
})

describe("NodeLanguageServer.makeLazy", () => {
  const initialized = (received: ReadonlyArray<{ readonly command: string; readonly message: Message }>) =>
    received.filter(({ message }) => message.method === "initialize").map(({ command }) => command)

  it("starts each server once, on the first request for one of its files", async () => {
    const { spawner, received } = fakeServers({ ts: pushOnly(), py: pushOnly() })
    const steps: Array<ReadonlyArray<string>> = []
    const results = await run(
      Effect.gen(function*() {
        const client = yield* NodeLanguageServer.makeLazy([
          { command: "ts", cwd: "/workspace", extensions: [".ts"] },
          { command: "py", cwd: "/workspace", extensions: [".py"] }
        ])
        const unclaimed = yield* Effect.exit(client.sync("/workspace/notes.md", "x"))
        yield* client.refresh
        yield* client.close("/workspace/a.ts")
        steps.push(initialized(received))
        yield* client.sync("/workspace/a.ts", "ERROR")
        yield* client.sync("/workspace/a.ts", "ERROR again")
        const report = yield* client.diagnostics("/workspace/a.ts")
        yield* client.refresh
        steps.push(initialized(received))
        return { unclaimed, report }
      }),
      spawner
    )
    expect(failureOf(results.unclaimed)).toMatchObject({ code: "unsupported", path: "/workspace/notes.md" })
    expect(steps).toEqual([[], ["ts"]])
    expect(results.report).toEqual({ kind: "full", items: errorsIn("ERROR again") })
  })

  it("starts a server with the builder's authority, not the first request's", async () => {
    const { spawner } = fakeServers({ ts: pushOnly() })
    const seen: Array<boolean> = []
    const recording = ChildProcessSpawner.makeNoop({
      spawn: (command) =>
        CapabilitySet.current.pipe(
          Effect.tap((ceiling) =>
            Effect.sync(() => seen.push(CapabilitySet.allows(ceiling, Capability.make("proc:spawn", "ts"))))
          ),
          Effect.andThen(spawner.spawn(command))
        )
    })
    await run(
      Effect.gen(function*() {
        const client = yield* NodeLanguageServer.makeLazy({ command: "ts", cwd: "/workspace", extensions: [".ts"] })
        yield* CapabilitySet.attenuate([])(client.sync("/workspace/a.ts", "x"))
      }),
      recording
    )
    expect(seen).toEqual([true])
  })

  it("fails every request for a server that could not start, without retrying it", async () => {
    let spawns = 0
    const spawner = ChildProcessSpawner.makeNoop({
      spawn: () => Effect.suspend(() => (spawns++, Effect.fail(new Error("no such binary") as never)))
    })
    const exits = await run(
      Effect.gen(function*() {
        const client = yield* NodeLanguageServer.makeLazy({ command: "ts", cwd: "/workspace", extensions: [".ts"] })
        return [
          yield* Effect.exit(client.sync("/workspace/a.ts", "x")),
          yield* Effect.exit(client.workspaceSymbols("x"))
        ]
      }),
      spawner
    )
    for (const exit of exits) expect(failureOf(exit)).toMatchObject({ code: "provider_unavailable" })
    expect(spawns).toBe(1)
  })

  it("refuses an empty server list", async () => {
    const { spawner } = fakeServers({})
    const exit = await run(Effect.exit(NodeLanguageServer.makeLazy([])), spawner)
    expect(failureOf(exit)).toMatchObject({ code: "invalid_input" })
  })
})

describe("NodeLanguageServer refresh", () => {
  it("resends files changed on disk, closes deleted ones, and leaves unchanged ones alone", async () => {
    const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "lsp-refresh-"))
    const at = (name: string) => NodePath.join(directory, name)
    for (const name of ["changed.ts", "deleted.ts", "same.ts", "other.py"]) NodeFs.writeFileSync(at(name), name)
    const { spawner, received } = fakeServers({ ts: pushOnly(), py: pushOnly() })
    await run(
      Effect.gen(function*() {
        const client = yield* NodeLanguageServer.make([
          { command: "ts", cwd: directory, extensions: [".ts"] },
          { command: "py", cwd: directory, extensions: [".py"] }
        ])
        for (const name of ["changed.ts", "deleted.ts", "same.ts", "other.py"]) yield* client.sync(at(name), name)
        NodeFs.writeFileSync(at("changed.ts"), "rewritten")
        NodeFs.rmSync(at("deleted.ts"))
        NodeFs.writeFileSync(at("other.py"), "rewritten py")
        // Frames reach the fake server asynchronously; let the syncs land first.
        yield* Effect.sleep(50)
        received.length = 0
        yield* client.refresh
        // Nothing changed since: a second refresh sends nothing.
        yield* client.refresh
        yield* Effect.sleep(50)
      }),
      spawner
    )
    expect(received.map(({ command, message }) => [command, message.method, message.params.textDocument.uri])).toEqual([
      ["ts", "textDocument/didChange", uri(at("changed.ts"))],
      ["ts", "textDocument/didClose", uri(at("deleted.ts"))],
      ["py", "textDocument/didChange", uri(at("other.py"))]
    ])
    expect(received[0]!.message.params).toMatchObject({
      textDocument: { version: 2 },
      contentChanges: [{ text: "rewritten" }]
    })
    NodeFs.rmSync(directory, { recursive: true, force: true })
  })

  it("answers diagnostics for the refreshed text", async () => {
    const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "lsp-refresh-"))
    const file = NodePath.join(directory, "a.ts")
    NodeFs.writeFileSync(file, "clean")
    const { spawner } = fakeServers({ ts: pushOnly() })
    const report = await run(
      Effect.gen(function*() {
        const client = yield* NodeLanguageServer.make({ command: "ts", cwd: directory })
        yield* client.sync(file, "clean")
        NodeFs.writeFileSync(file, "ERROR")
        yield* client.refresh
        return yield* client.diagnostics(file)
      }),
      spawner
    )
    expect(report).toEqual({ kind: "full", items: errorsIn("ERROR") })
    NodeFs.rmSync(directory, { recursive: true, force: true })
  })

  it("is unsupported without a server", async () => {
    const exit = await Effect.runPromise(Effect.exit(LanguageServer.makeNoop().refresh))
    expect(failureOf(exit)).toMatchObject({ code: "unsupported" })
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
