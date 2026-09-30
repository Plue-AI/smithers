import { NodeServices } from "@effect/platform-node"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as Edit from "@smthrs/std/Edit"
import * as LanguageServer from "@smthrs/std/LanguageServer"
import { Context, Effect, Layer } from "effect"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as HostLanguageServers from "../src/internal/HostLanguageServers.ts"
import * as NodeControl from "../src/NodeControl.ts"

/**
 * A stand-in typescript-language-server: push-only, one error per line that
 * holds `ERROR`, and it writes the initializationOptions it was sent beside
 * itself so a test can read what the host pinned.
 */
const server = `#!/usr/bin/env node
import { writeFileSync } from "node:fs"
let buffer = Buffer.alloc(0)
const send = (message) => {
  const body = JSON.stringify(message)
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body)
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf("\\r\\n\\r\\n")
    if (end < 0) return
    const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, end).toString())[1])
    if (buffer.length < end + 4 + length) return
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())
    buffer = buffer.subarray(end + 4 + length)
    if (message.method === "initialize") {
      writeFileSync(new URL("./initialized.json", import.meta.url), JSON.stringify(message.params.initializationOptions))
      send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } })
    } else if (message.method === "textDocument/diagnostic") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unhandled method" } })
    } else if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
      const text = message.method === "textDocument/didOpen"
        ? message.params.textDocument.text
        : message.params.contentChanges[0].text
      const diagnostics = text.split("\\n").flatMap((line, index) =>
        line.includes("ERROR")
          ? [{ range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } }, severity: 1, message: "bad" }]
          : []
      )
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: message.params.textDocument.uri, diagnostics } })
    }
  }
})
`

let root: string
let workspace: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-host-lsp-")))
  workspace = join(root, "workspace")
  mkdirSync(workspace)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Installs the stand-in and a TypeScript beside it under `prefix`, the way `npm i -g` lays them out. */
const install = (prefix: string, options?: { readonly typescript?: boolean }) => {
  const modules = join(prefix, "node_modules")
  const cli = join(modules, "typescript-language-server", "lib", "cli.mjs")
  mkdirSync(join(modules, "typescript-language-server", "lib"), { recursive: true })
  writeFileSync(join(modules, "typescript-language-server", "package.json"), JSON.stringify({ type: "module" }))
  writeFileSync(cli, server)
  chmodSync(cli, 0o755)
  if (options?.typescript !== false) {
    mkdirSync(join(modules, "typescript", "lib"), { recursive: true })
    writeFileSync(join(modules, "typescript", "package.json"), JSON.stringify({ name: "typescript" }))
    writeFileSync(join(modules, "typescript", "lib", "tsserver.js"), "")
  }
  mkdirSync(join(modules, ".bin"), { recursive: true })
  symlinkSync(cli, join(modules, ".bin", "typescript-language-server"))
  return { bin: join(modules, ".bin"), cli, tsserver: join(modules, "typescript", "lib", "tsserver.js") }
}

describe("HostLanguageServers.typescript", () => {
  it("binds the host server pinned to the TypeScript beside it", () => {
    const host = install(join(root, "host"))
    expect(HostLanguageServers.typescript(workspace, { PATH: ["relative/bin", "", host.bin].join(":") })).toEqual({
      command: host.cli,
      args: ["--stdio"],
      cwd: workspace,
      extensions: HostLanguageServers.TYPESCRIPT_EXTENSIONS,
      initializationOptions: { tsserver: { path: host.tsserver }, disableAutomaticTypingAcquisition: true },
      settleMs: HostLanguageServers.TYPESCRIPT_SETTLE_MS,
      quietMs: HostLanguageServers.TYPESCRIPT_QUIET_MS
    })
  })

  it("judges a workspace that does not exist yet by its path", () => {
    const host = install(join(root, "host"))
    const missing = join(root, "not-yet")
    expect(HostLanguageServers.typescript(missing, { PATH: host.bin })?.cwd).toBe(missing)
    expect(HostLanguageServers.typescript(join(root, "host"), { PATH: host.bin })).toBeUndefined()
  })

  it("binds nothing without a host server or a TypeScript beside it", () => {
    expect(HostLanguageServers.typescript(workspace, {})).toBeUndefined()
    expect(HostLanguageServers.typescript(workspace, { PATH: join(root, "missing") })).toBeUndefined()
    const bare = install(join(root, "bare"), { typescript: false })
    // A TypeScript the workspace holds is not one the host may run.
    install(workspace)
    expect(HostLanguageServers.typescript(workspace, { PATH: bare.bin })).toBeUndefined()
  })

  it("binds nothing the workspace supplies, directly or through a symlink", () => {
    const planted = install(workspace)
    expect(HostLanguageServers.typescript(workspace, { PATH: planted.bin })).toBeUndefined()
    const linked = join(root, "linked-bin")
    mkdirSync(linked)
    symlinkSync(planted.cli, join(linked, "typescript-language-server"))
    expect(HostLanguageServers.typescript(workspace, { PATH: linked })).toBeUndefined()
    // A host server whose TypeScript resolves into the workspace is refused too.
    const host = install(join(root, "host"), { typescript: false })
    symlinkSync(join(workspace, "node_modules", "typescript"), join(root, "host", "node_modules", "typescript"))
    expect(HostLanguageServers.typescript(workspace, { PATH: host.bin })).toBeUndefined()
  })
})

describe("HostLanguageServers.bind", () => {
  it("adds a bound server to the flows' services and leaves them alone without one", () => {
    const services = Context.make(Workspace.Workspace, { root: "/workspace" } as never)
    expect(HostLanguageServers.bind(services, undefined)).toBe(services)
    const server = LanguageServer.makeNoop()
    const bound = HostLanguageServers.bind(services, server)
    expect(
      Context.get(bound as unknown as Context.Context<LanguageServer.LanguageServer>, LanguageServer.LanguageServer)
    ).toBe(
      server
    )
    expect(Context.get(bound, Workspace.Workspace)).toBe(Context.get(services, Workspace.Workspace))
  })
})

describe("HostLanguageServers.make", () => {
  const bind = (environment: Readonly<Record<string, string | undefined>>) =>
    HostLanguageServers.make(workspace, environment)

  it("binds nothing when the host has no server", async () => {
    const bound = await Effect.runPromise(Effect.scoped(bind({})).pipe(Effect.provide(NodeServices.layer)))
    expect(bound).toBeUndefined()
  })

  it("starts through the kernel's permission-checked spawner the host composes", async () => {
    const host = install(join(root, "host"))
    writeFileSync(join(workspace, "a.ts"), "ERROR\n")
    const guarded = KernelChildProcessSpawner.layer.pipe(
      Layer.provide([NodeControl.layerGrantStore(workspace), Workspace.layer(workspace)]),
      Layer.provideMerge(NodeServices.layer)
    )
    const report = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const server = yield* bind({ PATH: host.bin })
        return yield* server!.diagnostics(join(workspace, "a.ts"))
      })).pipe(Effect.provide(guarded))
    )
    expect(report).toMatchObject({ kind: "full", items: [{ message: "bad", severity: 1 }] })
    // A store with no rules and nobody to ask refuses the spawn; the request says so.
    const ruleless = KernelChildProcessSpawner.layer.pipe(
      Layer.provide([
        Layer.orDie(GrantStore.layer({ attended: false, rules: [] })).pipe(Layer.provide(Workspace.layer(workspace))),
        Workspace.layer(workspace)
      ]),
      Layer.provideMerge(NodeServices.layer)
    )
    const refused = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const server = yield* bind({ PATH: host.bin })
        return yield* Effect.flip(server!.diagnostics(join(workspace, "a.ts")))
      })).pipe(Effect.provide(ruleless))
    )
    expect(refused).toMatchObject({ code: "provider_unavailable" })
  })

  it("starts the server on the first edit and returns the errors that edit leaves", async () => {
    const host = install(join(root, "host"))
    writeFileSync(join(workspace, "a.ts"), "const a = 1\n")
    writeFileSync(join(workspace, "notes.md"), "notes\n")
    const initialized = join(root, "host", "node_modules", "typescript-language-server", "lib", "initialized.json")
    const outputs = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const server = yield* bind({ PATH: host.bin })
        expect(server).toBeDefined()
        const edit = (path: string, oldString: string, newString: string) =>
          Edit.run({ path: join(workspace, path), oldString, newString }).pipe(
            Effect.provideService(LanguageServer.LanguageServer, server!)
          )
        // A file no server claims starts nothing.
        const notes = yield* edit("notes.md", "notes", "ERROR notes")
        const started = (() => {
          try {
            return readFileSync(initialized, "utf8")
          } catch {
            return undefined
          }
        })()
        return { notes, started, broken: yield* edit("a.ts", "const a = 1", "ERROR") }
      })).pipe(Effect.provide(NodeServices.layer))
    )
    expect("errors" in outputs.notes).toBe(false)
    expect(outputs.started).toBeUndefined()
    expect(outputs.broken.errors).toEqual([{ line: 1, character: 1, message: "bad" }])
    expect(JSON.parse(readFileSync(initialized, "utf8"))).toEqual({
      tsserver: { path: host.tsserver },
      disableAutomaticTypingAcquisition: true
    })
  })
})
