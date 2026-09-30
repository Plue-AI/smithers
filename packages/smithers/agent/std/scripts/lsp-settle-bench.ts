/**
 * Measures how long a push-only language server takes to publish diagnostics
 * after a sync, and checks what `NodeLanguageServer` answers with a given
 * `settleMs` and `quietMs`.
 *
 * node scripts/lsp-settle-bench.ts <server> <tsserver.js|-> <workspace> <iterations> <settleMs> <quietMs> <file>...
 *
 * A server whose name contains `gopls` is driven as Go (no arguments, Go
 * probe text, no initializationOptions; pass `-` for the tsserver path);
 * anything else is typescript-language-server over `--stdio`.
 *
 * Phase `raw` speaks LSP directly and records every publishDiagnostics for the
 * file, in milliseconds after the didOpen or didChange that caused it. Phase
 * `client` asks `NodeLanguageServer.diagnostics` after each sync and records
 * its wall time and whether the answer holds the expected errors. The file is
 * first opened holding a type error (`open`, on a cold server). Each cycle
 * then removes it (`fix`), appends a comment to the fixed text (`clean`, whose
 * report stays empty), restores the text (`restore`), appends the type error
 * (`break`), and closes and reopens the file holding it (`reopen`). Prints one
 * JSON object.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { cpus, loadavg } from "node:os"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import * as Diagnostics from "../src/internal/Diagnostics.ts"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"

const [server, tsserver, workspaceArgument, iterationsArgument, settleArgument, quietArgument, ...fileArguments] =
  process.argv.slice(2)
if (server === undefined || tsserver === undefined || workspaceArgument === undefined || fileArguments.length === 0) {
  console.error(
    "usage: lsp-settle-bench.ts <server> <tsserver.js> <workspace> <iterations> <settleMs> <quietMs> <file>..."
  )
  process.exit(2)
}
const workspace = resolve(workspaceArgument)
const iterations = Number(iterationsArgument ?? 5)
const settleMs = Number(settleArgument ?? 5_000)
const quietMs = Number(quietArgument ?? 300)
const files = fileArguments.map((file) => resolve(workspace, file))
const go = /gopls/.test(server)
const languageId = go ? "go" : "typescript"
const serverArguments = go ? [] : ["--stdio"]
const initializationOptions = go
  ? undefined
  : { tsserver: { path: tsserver }, disableAutomaticTypingAcquisition: true }
const PROBE = go ? "\nvar __settleProbe string = 1\n" : "\nconst __settleProbe: string = 1\n"
const COMMENT = "\n// settle probe\n"
/** How long the raw phase listens after each sync; well past any publish seen. */
const LISTEN_MS = 4_000

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

interface Publish {
  readonly ms: number
  readonly count: number
  readonly errors: number
}

const raw = async (file: string) => {
  const child = spawn(server, serverArguments, { cwd: workspace, stdio: ["pipe", "pipe", "ignore"] })
  const uri = pathToFileURL(file).href
  let buffer = Buffer.alloc(0)
  let id = 0
  let sentAt = 0
  let publishes: Array<Publish> = []
  const waiting = new Map<number, (value: unknown) => void>()
  const send = (message: unknown) => {
    const body = JSON.stringify(message)
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n")
      if (end < 0) return
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())![1])
      if (buffer.length < end + 4 + length) return
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())
      buffer = buffer.subarray(end + 4 + length)
      if (message.id !== undefined && message.method === undefined) waiting.get(message.id)?.(message)
      else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: null })
      else if (message.method === "textDocument/publishDiagnostics" && message.params.uri === uri) {
        const diagnostics = message.params.diagnostics as ReadonlyArray<{ readonly severity?: number }>
        publishes.push({
          ms: Math.round(performance.now() - sentAt),
          count: diagnostics.length,
          errors: diagnostics.filter((item) => item.severity === 1).length
        })
      }
    }
  })
  const request = (method: string, params: unknown) =>
    new Promise((done) => {
      waiting.set(++id, done)
      send({ jsonrpc: "2.0", id, method, params })
    })
  await request("initialize", {
    processId: null,
    rootUri: pathToFileURL(workspace).href,
    capabilities: { textDocument: { synchronization: {}, publishDiagnostics: { versionSupport: true } } },
    ...(initializationOptions === undefined ? {} : { initializationOptions })
  })
  send({ jsonrpc: "2.0", method: "initialized", params: {} })
  const base = readFileSync(file, "utf8")
  const steps: Array<{ readonly step: string; readonly publishes: ReadonlyArray<Publish> }> = []
  let version = 0
  let open = false
  const sync = async (step: string, text: string, reopen = false) => {
    if (reopen) {
      send({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } })
      open = false
    }
    publishes = []
    sentAt = performance.now()
    version++
    const opening = !open
    open = true
    send(
      opening
        ? {
          jsonrpc: "2.0",
          method: "textDocument/didOpen",
          params: { textDocument: { uri, languageId, version, text } }
        }
        : {
          jsonrpc: "2.0",
          method: "textDocument/didChange",
          params: { textDocument: { uri, version }, contentChanges: [{ text }] }
        }
    )
    await sleep(LISTEN_MS)
    steps.push({ step, publishes })
  }
  await sync("open", base + PROBE)
  for (let index = 0; index < iterations; index++) {
    await sync("fix", base)
    await sync("clean", base + COMMENT)
    await sync("restore", base)
    await sync("break", base + PROBE)
    await sync("reopen", base + PROBE, true)
  }
  child.kill()
  return steps
}

const client = (file: string) =>
  Effect.scoped(Effect.gen(function*() {
    const languageServer = yield* NodeLanguageServer.make({
      command: server,
      args: serverArguments,
      cwd: workspace,
      ...(initializationOptions === undefined ? {} : { initializationOptions }),
      settleMs,
      quietMs
    })
    const base = readFileSync(file, "utf8")
    const probeLine = (base + PROBE).split("\n").findIndex((line) => line.includes("__settleProbe")) + 1
    const results: Array<
      { readonly step: string; readonly ms: number; readonly correct: boolean; readonly errors?: number }
    > = []
    const step = (name: string, text: string, expectErrors: boolean, reopen = false) =>
      Effect.gen(function*() {
        if (reopen) yield* languageServer.close(file)
        const started = performance.now()
        yield* languageServer.sync(file, text)
        const found = yield* Diagnostics.errorsOf(languageServer, file)
        const ms = Math.round(performance.now() - started)
        // Only the probe line is judged: a file may hold other errors of its own.
        const probed = found?.some((problem) => problem.line === probeLine) ?? false
        const correct = found !== undefined && probed === expectErrors
        results.push({ step: name, ms, correct, ...(found === undefined ? {} : { errors: found.length }) })
      })
    yield* step("open", base + PROBE, true)
    for (let index = 0; index < iterations; index++) {
      yield* step("fix", base, false)
      yield* step("clean", base + COMMENT, false)
      yield* step("restore", base, false)
      yield* step("break", base + PROBE, true)
      yield* step("reopen", base + PROBE, true, true)
    }
    return results
  })).pipe(Effect.provide(NodeServices.layer))

const summary = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return { n: 0 }
  const sorted = [...values].sort((left, right) => left - right)
  const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]!
  return { n: sorted.length, min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] }
}

const report: Record<string, unknown> = {
  server,
  tsserver,
  workspace,
  iterations,
  settleMs,
  quietMs,
  cpus: cpus().length,
  loadAverageAtStart: loadavg(),
  files: {}
}
for (const file of files) {
  const rawSteps = await raw(file)
  const clientSteps = await Effect.runPromise(client(file))
  const byStep = (name: string) => rawSteps.filter(({ step }) => step === name)
  ;(report.files as Record<string, unknown>)[file] = {
    lines: readFileSync(file, "utf8").split("\n").length,
    raw: Object.fromEntries(
      ["open", "fix", "clean", "restore", "break", "reopen"].map((name) => [name, {
        firstPublishMs: summary(byStep(name).flatMap(({ publishes }) => publishes.slice(0, 1).map(({ ms }) => ms))),
        lastPublishMs: summary(byStep(name).flatMap(({ publishes }) => publishes.slice(-1).map(({ ms }) => ms))),
        publishes: byStep(name).map(({ publishes }) => publishes.length),
        gapsMs: byStep(name).flatMap(({ publishes }) =>
          publishes.slice(1).map((entry, index) => entry.ms - publishes[index]!.ms)
        )
      }])
    ),
    client: Object.fromEntries(
      ["open", "fix", "clean", "restore", "break", "reopen"].map((name) => {
        const steps = clientSteps.filter(({ step }) => step === name)
        return [name, {
          ms: summary(steps.map(({ ms }) => ms)),
          correct: steps.filter(({ correct }) => correct).length,
          of: steps.length
        }]
      })
    )
  }
}
report.loadAverageAtEnd = loadavg()
console.log(JSON.stringify(report, null, 2))
