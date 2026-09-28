/**
 * The served control plane, out of process, and the clients that talk to it.
 *
 * `startServe` runs the product's own `smthrs serve` — the executable
 * `@smthrs/cli` declares as its bin, resolved through Node, not a fixture that
 * re-composes the same layers. That distinction is the whole point of the
 * gateway family: a suite that builds the server itself proves that a
 * composition works, while an operator's complaint is always about the command
 * they typed. Everything the verb decides on the way up — which bind it will
 * accept, which authentication layer it installs, which database file it
 * opens, whether it stays alive — is therefore under test here rather than
 * assumed.
 *
 * `controlClient` builds the shipped `ControlClient` over Node's HTTP and
 * WebSocket transports, the same pair `@smthrs/cli` uses for a `--remote`
 * invocation. The WebSocket constructor is the tracked one from
 * {@link ./dropWebSocket.ts}, so a suite can cut the live socket.
 *
 * @since 1.0.0
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Control as ControlService, ControlClient } from "@smthrs/control"
import { killProcess } from "@smthrs/testing/Faults"
import * as Layer from "effect/Layer"
import { RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { type ChildProcess, execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { type TrackedWebSockets, trackingWebSocketConstructor } from "./dropWebSocket.ts"

/**
 * The `smithers` executable, read out of `@smthrs/cli`'s own manifest.
 *
 * Hard-coding `packages/smithers/bin/smithers.mjs` would keep passing after the
 * package stopped shipping it. Reading `bin` is the same discipline the
 * swebench wrapper uses: run what the package says it installs.
 *
 * @since 1.0.0
 * @category constants
 */
export const smithersBin: string = (() => {
  const manifest = createRequire(import.meta.url).resolve("@smthrs/cli/package.json")
  const bin = (JSON.parse(readFileSync(manifest, "utf8")) as { readonly bin: Record<string, string> }).bin.smithers
  if (bin === undefined) throw new Error("@smthrs/cli declares no `smithers` bin")
  return resolve(dirname(manifest), bin)
})()

const judge = new URL("../../fixtures/scripted-native-host.ts", import.meta.url).href

/** Runs a real local operator command against the server's workspace. */
export const localDecision = (root: string, decision: "approve" | "deny", approval: unknown): Promise<{
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}> =>
  new Promise((resolveDecision, reject) => {
    execFile(
      process.execPath,
      ["--import", judge, smithersBin, "approvals", decision, JSON.stringify(approval), "--root", root, "--json"],
      {
        cwd: root,
        env: { ...process.env, SMITHERS_REMOTE: undefined, SMITHERS_TOKEN: undefined },
        timeout: 120_000,
        encoding: "utf8"
      },
      (error, stdout, stderr) => {
        if (error === null) resolveDecision({ status: 0, stdout, stderr })
        else if (typeof error.code === "number") resolveDecision({ status: error.code, stdout, stderr })
        else reject(error)
      }
    )
  })

/** Where `smthrs serve` keeps the control database for a project root. */
const controlDatabase = (root: string): string => join(root, ".flows", "control.db")

/** An unused loopback port, held only long enough to learn its number. */
const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = probe.address()
      if (address === null || typeof address === "string") {
        probe.close()
        reject(new Error("could not learn an ephemeral port"))
        return
      }
      const { port } = address
      probe.close(() => resolvePort(port))
    })
  })

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * Whether the control RPC route is mounted and answering on `port`.
 *
 * A TCP connection is not the readiness signal: the HTTP server accepts before
 * the RPC router is attached, so a suite that raced on `connect` would send its
 * first plan into a 404. The probe therefore asks the route itself, and treats
 * any answer other than "no such route" as served.
 */
const serving = async (port: number): Promise<boolean> => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/ndjson" },
      body: "\n"
    })
    await response.text()
    return response.status !== 404
  } catch {
    return false
  }
}

/**
 * A running `smthrs serve`.
 *
 * @since 1.0.0
 * @category models
 */
export interface ServeProcess {
  readonly pid: number
  readonly port: number
  /** The base URL; `/rpc` and `/rpc/ws` hang off it. */
  readonly url: string
  /** The bearer credential the server was started with. */
  readonly token: string
  /** The project root the verb was pointed at. */
  readonly root: string
  /** The control database `serve` opened under that root. */
  readonly databasePath: string
  /** The command line, for a failure message that can be re-run by hand. */
  readonly argv: ReadonlyArray<string>
  readonly process: ChildProcess
  readonly stderr: () => string
  /** Kills the server and waits for the operating system to reap it. */
  readonly stop: () => Promise<void>
}

/**
 * Options for {@link startServe}.
 *
 * @since 1.0.0
 * @category models
 */
export interface ServeOptions {
  /** Overrides the generated bearer credential. */
  readonly credential?: string | undefined
  /** How long the verb gets to bind and mount its routes. */
  readonly timeoutMs?: number | undefined
}

/**
 * Starts `smthrs serve` against `root` and waits until it answers RPC.
 *
 * @since 1.0.0
 * @category constructors
 */
export const startServe = async (root: string, options: ServeOptions = {}): Promise<ServeProcess> => {
  const token = options.credential ?? `e2e-${randomUUID()}`
  const timeoutMs = options.timeoutMs ?? 120_000
  const port = await freePort()
  const argv = ["--import", judge, smithersBin, "serve", "--root", root, "--port", String(port)]
  const process_ = spawn(process.execPath, argv, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: root,
    env: { ...process.env, SMITHERS_TOKEN: token }
  })
  const pid = process_.pid
  if (pid === undefined) throw new Error("smthrs serve has no pid")

  let stderr = ""
  let exited: number | null | undefined
  process_.stderr?.setEncoding("utf8")
  process_.stderr?.on("data", (chunk: string) => {
    stderr += chunk
  })
  process_.stdout?.setEncoding("utf8")
  process_.stdout?.on("data", (chunk: string) => {
    stderr += chunk
  })
  process_.once("exit", (code) => {
    exited = code
  })

  const command = `${process.execPath} ${argv.join(" ")}`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (exited !== undefined) {
      throw new Error(`smthrs serve exited with ${String(exited)} before it served\n${command}\n${stderr}`)
    }
    if (await serving(port)) break
    if (Date.now() >= deadline) {
      process_.kill("SIGKILL")
      throw new Error(`smthrs serve never answered on ${port} within ${timeoutMs}ms\n${command}\n${stderr}`)
    }
    await sleep(100)
  }

  let stopped = false
  return {
    pid,
    port,
    url: `http://127.0.0.1:${port}`,
    token,
    root,
    databasePath: controlDatabase(root),
    argv,
    process: process_,
    stderr: () => stderr,
    stop: async () => {
      if (stopped) return
      stopped = true
      await killProcess(process_)
    }
  }
}

/**
 * How a client authenticates and which socket it is given.
 *
 * @since 1.0.0
 * @category models
 */
export interface ClientOptions {
  readonly url: string
  /** Omit or misspell to exercise the server's refusal. */
  readonly credential?: string | undefined
  /** Reuse a tracker across two clients to count reconnects. */
  readonly sockets?: TrackedWebSockets | undefined
}

/**
 * Builds the shipped remote `Control` client, and hands back the socket tracker
 * so a suite can drop the live connection.
 *
 * @since 1.0.0
 * @category constructors
 */
export const controlClient = (
  options: ClientOptions
): { readonly layer: Layer.Layer<ControlService.Control>; readonly sockets: TrackedWebSockets } => {
  const sockets = options.sockets ?? trackingWebSocketConstructor(options.credential)
  const websocket = Socket.layerWebSocket(`${options.url.replace(/\/+$/, "")}/rpc/ws`).pipe(
    Layer.provide(Layer.succeed(Socket.WebSocketConstructor, sockets.construct))
  )
  const layer = ControlClient.layer({
    url: `${options.url.replace(/\/+$/, "")}/rpc`,
    ...(options.credential === undefined ? {} : { credential: options.credential })
  }).pipe(
    Layer.provide([NodeHttpClient.layerUndici, websocket, RpcSerialization.layerNdjson])
  )
  return { layer, sockets }
}
