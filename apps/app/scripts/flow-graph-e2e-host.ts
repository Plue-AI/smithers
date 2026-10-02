/*
 * The one command: a credential-free real stack on localhost.
 *
 *   bun scripts/flow-graph-e2e-host.ts
 *
 * It prints the origin URL and holds it open until you stop it. Nothing it
 * starts needs a GitHub session, a Smithers Cloud workspace or a provider key.
 *
 * What it starts:
 *
 *   1. `flow-graph-e2e-gateway.mts` under tsx/Node, which holds the real
 *      control plane, the real engine over two SQLite files, the bridge, and
 *      the product Worker's relay in front of them. It prints its relay URL.
 *      `@smthrs/database` `NodeDatabase` refuses Bun, which is why it is a
 *      second process and not a layer in this one.
 *   2. the SPA build, unless SMITHERS_SKIP_SPA_BUILD=1.
 *   3. `startLocalServer` in hybrid mode with both upstreams pointed at that
 *      relay, so `/api/workflow/*` and `/api/auth/*` reach it and nothing
 *      leaves the machine. The cloud upstream is what puts `cloud` in the
 *      origin's bootstrap capabilities, and `flow.list`, `flow.run` and
 *      `flow.plan` each declare it, so an origin without one lists no flows.
 *
 * The gateway child dies with this process.
 */
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { Readable } from "node:stream"
import { WritableStream } from "node:stream/web"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { createLocalCommandChat } from "../e2e/graph/LocalCommandChat"
import { startLocalServer } from "../src/bun/server"
import { GRAPH_FLOW_SOURCE } from "../e2e/graph/workspace"
import { relayFetch } from "../e2e/graph/RelayFetch"
import { recoverTrackedFile } from "./flow-graph-fixture-source"

const APP_DIR = fileURLToPath(new URL("../", import.meta.url))
const PORT = Number(process.env.SMITHERS_FLOW_GRAPH_PORT ?? "47331")
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  throw new Error(`Invalid SMITHERS_FLOW_GRAPH_PORT: ${process.env.SMITHERS_FLOW_GRAPH_PORT}`)
}

/** What the gateway half prints on its first line of stdout. */
interface GatewayAddress {
  readonly relayUrl: string
  readonly repo: string
}

// Own process groups, including build wrappers, from the moment they launch.
// Signals can arrive during startup as well as after the origin is listening.
const children = new Set<{ stop: () => Promise<void> }>()
let root: string | undefined
let server: Awaited<ReturnType<typeof startLocalServer>> | undefined
let stopping: Promise<void> | undefined
const stop = (): Promise<void> => stopping ??= (async () => {
  try {
    await Promise.all([...children].map((child) => child.stop()))
  } finally {
    try { await server?.stop() }
    finally { if (root !== undefined) await rm(root, { recursive: true, force: true }) }
  }
})()
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void stop().then(() => process.exit(0), () => process.exit(1)) })
}

const startChild = (command: string[], pipe = false) => {
  if (stopping !== undefined) throw new Error("Host is stopping")
  const child = spawn(command[0]!, command.slice(1), {
    cwd: APP_DIR, detached: true, stdio: ["ignore", pipe ? "pipe" : "inherit", "inherit"],
    env: { ...process.env }
  })
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    // `close` follows exit AND drained stdio; NodeRuntime has finished its
    // Effect scope (including both SQLite finalizers) before this resolves.
    child.once("close", (code) => resolve(code ?? 0))
  })
  let stopped: Promise<void> | undefined
  const owned = { stop: (): Promise<void> => stopped ??= (async () => {
    try { process.kill(-child.pid!, "SIGTERM") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    await exited
  })() }
  children.add(owned)
  void exited.then(() => children.delete(owned), () => children.delete(owned))
  return { child, exited, stop: owned.stop }
}

/**
 * Starts the gateway half and waits for the line it prints.
 *
 * A gateway that dies before printing takes this command down with its own
 * output, rather than leaving the host waiting on an address that is never
 * coming.
 */
const startGateway = async (): Promise<{
  address: GatewayAddress
  exited: Promise<number>
  stop: () => Promise<void>
}> => {
  // No pnpm/tsx wrapper between us and the process owning the Effect scope.
  const { child, exited, stop } = startChild([
    "node", "--import", import.meta.resolve("tsx"), "scripts/flow-graph-e2e-gateway.mts"
  ], true)
  const stdout = Readable.toWeb(child.stdout!)
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) {
      await stop()
      throw new Error(`[flow-graph] the gateway exited before it printed an address (code ${await exited})`)
    }
    buffered += decoder.decode(chunk.value, { stream: true })
    const newline = buffered.indexOf("\n")
    if (newline < 0) continue
    reader.releaseLock()
    // The rest of the child's output is its own; let it go to this terminal.
    void stdout.pipeTo(
      new WritableStream({ write: (bytes) => { process.stdout.write(bytes) } })
    ).catch(() => {})
    return { address: JSON.parse(buffered.slice(0, newline)) as GatewayAddress, exited, stop }
  }
}

const buildSpa = async (): Promise<void> => {
  if (process.env.SMITHERS_SKIP_SPA_BUILD === "1") return
  for (const command of [["pnpm", "exec", "vite", "build", "--configLoader", "runner"]]) {
    const code = await startChild(command).exited
    if (code !== 0) throw new Error(`[flow-graph] ${command.join(" ")} exited ${code}`)
  }
}

let gateway: Awaited<ReturnType<typeof startGateway>>
try {
  // The gateway loads the fixture from disk: undo a killed run's edit first,
  // and refuse to load one another live run is making.
  const fixture = join(APP_DIR, "../..", GRAPH_FLOW_SOURCE)
  if (recoverTrackedFile(fixture) === "held") {
    throw new Error(`[flow-graph] ${fixture} is being edited by another flow-graph run`)
  }
  gateway = await startGateway()
  // Every request still reaches the real relay and engine, on an owned connection.
  globalThis.fetch = relayFetch(gateway.address.relayUrl, globalThis.fetch)
  await buildSpa()
  root = await mkdtemp(join(tmpdir(), "smithers-flow-graph-host-"))
  server = await startLocalServer({
    port: PORT,
    distDir: join(APP_DIR, "dist"),
    agent: createLocalCommandChat,
    cloudMode: "hybrid",
    identityUpstream: gateway.address.relayUrl,
    cloudApi: gateway.address.relayUrl,
    home: root,
    stateDir: join(root, "state")
  })
} catch (error) {
  await stop()
  throw error
}

// A gateway that dies after printing its address leaves this origin serving a
// relay that answers nothing. `stopping` is assigned before its first await, so
// a stop this process started never reaches this arm.
void gateway.exited.then((code) => {
  if (stopping !== undefined) return
  console.error(`[flow-graph] the gateway exited (code ${code}); stopping`)
  void stop().then(() => process.exit(1), () => process.exit(1))
})

console.log(`[flow-graph] relay    ${gateway.address.relayUrl}`)
console.log(`[flow-graph] workspace ${gateway.address.repo}`)
console.log(`[flow-graph] open     http://127.0.0.1:${PORT}`)
await new Promise<never>(() => {})
