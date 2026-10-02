import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { PROVIDER_PATHS, type ProviderJournalEntry } from "./model-provider-behaviors"

export interface ModelProvider {
  /** http://127.0.0.1:<port>; what the user types as Base URL. */
  readonly origin: string
  /** The whole evaluation URL, for a client that takes one. A record's Base URL is `origin`: resolveModelEndpoint appends the path. */
  readonly evaluationUrl: string
  readonly acceptedKeySha256: string
  readonly journal: () => Promise<ReadonlyArray<ProviderJournalEntry>>
  /** SIGTERM the owned process: a real unreachable network boundary. */
  readonly stop: () => Promise<void>
  /** Relaunch on the same port with an empty journal. Call in `finally` after stop(). */
  readonly start: () => Promise<void>
  readonly close: () => Promise<void>
}

export interface ModelProviderOptions {
  /** The credential VALUE the provider accepts. Specs pass runnerCredential("E2E_LOOPBACK"). */
  readonly key: string
  /** A port the caller chose, so the origin can be declared to a host before this process exists. Absent: any free port. */
  readonly port?: number
  readonly slowMs?: number
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))

const exited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

const terminate = async (child: ChildProcess): Promise<void> => {
  if (exited(child)) return
  child.kill("SIGTERM")
  const deadline = Date.now() + 5_000
  while (!exited(child) && Date.now() < deadline) await wait(25)
  if (exited(child)) return
  child.kill("SIGKILL")
  while (!exited(child)) await wait(25)
}

export const launchModelProvider = async (options: ModelProviderOptions): Promise<ModelProvider> => {
  const appDir = resolve(__dirname, "../../..")
  const mode = process.env.SMITHERS_REAL_E2E_MODE
  const dockerSelfhost = mode === "web-selfhost"
  const hostedPlue = mode === "web-plue" || mode === "local-plue"
  const publicOrigin = process.env.SMITHERS_REAL_MODEL_PROVIDER_PUBLIC_ORIGIN?.trim()
  const publicPort = Number(process.env.SMITHERS_REAL_MODEL_PROVIDER_PORT)
  if (hostedPlue && (!publicOrigin || !/^https:\/\/[^/]+$/.test(publicOrigin) || !Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65_535)) {
    throw new Error("Hosted Plue model evidence requires SMITHERS_REAL_MODEL_PROVIDER_PUBLIC_ORIGIN and SMITHERS_REAL_MODEL_PROVIDER_PORT.")
  }
  let child: ChildProcess | undefined
  let port = options.port ?? (hostedPlue ? publicPort : 0)
  const boot = async (): Promise<void> => {
    if (child !== undefined && !exited(child)) throw new Error("The model provider is already running.")
    const started = spawn("bun", [resolve(__dirname, "model-provider.ts")], {
      cwd: appDir,
      env: {
        ...process.env,
        SMITHERS_MODEL_PROVIDER_KEY: options.key,
        SMITHERS_MODEL_PROVIDER_PORT: String(port),
        ...(dockerSelfhost ? { SMITHERS_MODEL_PROVIDER_HOSTNAME: "0.0.0.0" } : {}),
        ...(options.slowMs === undefined ? {} : { SMITHERS_MODEL_PROVIDER_SLOW_MS: String(options.slowMs) })
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    child = started
    let stdout = ""
    let stderr = ""
    let spawnError: Error | undefined
    started.once("error", (error) => { spawnError = error })
    started.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    started.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    const deadline = Date.now() + 15_000
    try {
      for (;;) {
        const newline = stdout.indexOf("\n")
        if (newline >= 0) {
          const ready = JSON.parse(stdout.slice(0, newline)) as { readonly event: string; readonly port: number }
          if (ready.event !== "ready") throw new Error(`Model provider reported ${ready.event} before ready.`)
          port = ready.port
          return
        }
        if (spawnError !== undefined) throw spawnError
        if (exited(started)) throw new Error(`Model provider exited ${started.exitCode} before ready.\n${stderr}`)
        if (Date.now() >= deadline) throw new Error(`Model provider did not become ready.\n${stderr}`)
        await wait(25)
      }
    } catch (error) {
      await terminate(started)
      throw error
    }
  }
  const halt = async (): Promise<void> => {
    const running = child
    child = undefined
    if (running !== undefined) await terminate(running)
  }
  await boot()
  const origin = `http://127.0.0.1:${port}`
  const productOrigin = dockerSelfhost ? `http://host.docker.internal:${port}` : hostedPlue ? publicOrigin! : origin
  return {
    origin: productOrigin,
    evaluationUrl: `${productOrigin}${PROVIDER_PATHS.evaluation}`,
    acceptedKeySha256: createHash("sha256").update(options.key).digest("hex"),
    journal: async () => {
      const response = await fetch(`${origin}${PROVIDER_PATHS.journal}`)
      if (!response.ok) throw new Error(`Provider journal answered ${response.status}`)
      return await response.json() as ReadonlyArray<ProviderJournalEntry>
    },
    stop: halt,
    start: boot,
    close: halt
  }
}

/** The named credentials the runner minted. Throws when the spec was started outside scripts/run-real-e2e.ts. */
export const runnerCredential = (name: "E2E_LOOPBACK" | "E2E_REVOKED"): string => {
  const value = process.env[`SMITHERS_MODEL_KEY_${name}`]
  if (!value || value.length < 16) throw new Error(`SMITHERS_MODEL_KEY_${name} is unset. Run through scripts/run-real-e2e.ts, which mints it for the host under test.`)
  return value
}
