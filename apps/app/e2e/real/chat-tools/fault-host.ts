import { spawn } from "node:child_process"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { startLocalServer } from "../../../src/bun/server"

const appDir = resolve(import.meta.dir, "../../..")
const proxyScript = resolve(import.meta.dir, "upstream-proxy.ts")
const root = await mkdtemp(join(tmpdir(), "smithers-real-chat-fault-"))
const home = join(root, "home")
await mkdir(home)

const availablePort = (): Promise<number> => new Promise((resolvePort, reject) => {
  const reservation = createServer()
  reservation.once("error", reject)
  reservation.listen(0, "127.0.0.1", () => {
    const address = reservation.address()
    if (address === null || typeof address === "string") {
      reservation.close()
      reject(new Error("Could not reserve a passthrough port."))
      return
    }
    reservation.close((error) => error === undefined ? resolvePort(address.port) : reject(error))
  })
})

const waitForExit = async (child: ReturnType<typeof spawn>): Promise<number | null> => {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode
  return new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject)
    child.once("exit", resolveExit)
  })
}

const proxyPort = await availablePort()
let proxy: ReturnType<typeof spawn> | undefined
const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolvePause) => setTimeout(resolvePause, milliseconds))

const startProxy = async (): Promise<void> => {
  if (proxy !== undefined && proxy.exitCode === null && proxy.signalCode === null) throw new Error("The chat passthrough process is already running.")
  proxy = spawn("bun", [proxyScript], {
    cwd: appDir,
    env: { ...process.env, SMITHERS_REAL_CHAT_PROXY_PORT: String(proxyPort) },
    stdio: ["ignore", "inherit", "inherit"]
  })
  const deadline = Date.now() + 10_000
  for (;;) {
    if (proxy.exitCode !== null) throw new Error(`The chat passthrough exited ${proxy.exitCode} during startup.`)
    try {
      const ready = await fetch(`http://127.0.0.1:${proxyPort}/__harness_ready`)
      if (ready.status === 204) return
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error("The chat passthrough did not become reachable.", { cause: error })
      }
    }
    if (Date.now() >= deadline) throw new Error("The chat passthrough did not become ready.")
    await pause(25)
  }
}

const stopProxy = async (): Promise<void> => {
  if (proxy === undefined || proxy.exitCode !== null) return
  const child = proxy
  child.kill("SIGTERM")
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000)
  try {
    const code = await waitForExit(child)
    if (code !== 0 && code !== null) throw new Error(`The chat passthrough exited ${code} while faulting it.`)
  } finally {
    clearTimeout(timeout)
    proxy = undefined
  }
}

let product: Awaited<ReturnType<typeof startLocalServer>> | undefined
let stopping: Promise<void> | undefined
const cleanup = (): Promise<void> => stopping ??= (async () => {
  const results = await Promise.allSettled([product?.stop(), stopProxy()])
  await rm(root, { recursive: true, force: true })
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "Fault harness cleanup failed")
})()

process.once("SIGTERM", () => {
  void cleanup().then(() => process.exit(0), (error) => {
    console.error(error)
    process.exit(1)
  })
})

try {
await startProxy()
product = await startLocalServer({
  port: 0,
  distDir: join(appDir, "dist"),
  home,
  stateDir: join(root, "state"),
  cloudMode: "hybrid",
  cloudApi: `http://127.0.0.1:${proxyPort}`,
  log: (line) => console.error(`[fault-product] ${line}`)
})

console.log(JSON.stringify({ event: "ready", origin: product.origin }))
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (line === "fault") {
    await stopProxy()
    console.log(JSON.stringify({ event: "faulted" }))
    continue
  }
  if (line === "restore") {
    await startProxy()
    console.log(JSON.stringify({ event: "restored" }))
    continue
  }
  if (line === "quit") {
    await cleanup()
    console.log(JSON.stringify({ event: "stopped" }))
    process.exit(0)
  }
  throw new Error(`Unknown fault harness command: ${line}`)
}

await cleanup()
} finally {
  await cleanup()
}
