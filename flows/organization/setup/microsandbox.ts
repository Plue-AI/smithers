/**
 * The local Microsandbox install as the doctor sees it: the SDK module, the
 * `msb` CLI shipped inside it, the image cache, and one real boot probe.
 */
import { Effect, Stream } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as MicrosandboxSandbox from "../../../packages/smithers/flows/sandbox/src/MicrosandboxSandbox/index.ts"
import { checkoutRoot } from "./settings.ts"

/** A resolved SDK: its package directory and version. */
export interface Install {
  readonly packageDir: string
  readonly version: string
  /** The CLI bundled with the SDK, run with this Node. */
  readonly cli: ReadonlyArray<string>
}

/** The package directory above a resolved entry file. */
const packageDirOf = (entry: string): string => {
  let dir = dirname(entry)
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`no package.json above ${entry}`)
    dir = parent
  }
  return dir
}

/**
 * Finds the `microsandbox` SDK: from this module first (a host that declares
 * it), then from the organization package that pins it.
 */
export const locate = (): Install | undefined => {
  const candidates: Array<() => string> = [
    () => fileURLToPath(import.meta.resolve("microsandbox")),
    () => createRequire(join(checkoutRoot, "packages/smithers/agent/organization/package.json")).resolve("microsandbox")
  ]
  for (const candidate of candidates) {
    let entry: string
    try {
      entry = candidate()
    } catch {
      continue
    }
    const packageDir = packageDirOf(entry)
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      version: string
      bin?: Record<string, string>
    }
    const bin = manifest.bin?.msb ?? manifest.bin?.microsandbox
    if (bin === undefined) continue
    return { packageDir, version: manifest.version, cli: [process.execPath, join(packageDir, bin)] }
  }
  return undefined
}

/** Runs the bundled CLI and returns its status and output. */
export const msb = (install: Install, args: ReadonlyArray<string>, timeoutMs = 30_000) => {
  const result = spawnSync(install.cli[0]!, [...install.cli.slice(1), ...args], {
    encoding: "utf8",
    timeout: timeoutMs
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

/** Imports the SDK module the install names. */
export const sdkOf = async (install: Install): Promise<MicrosandboxSandbox.Sdk> => {
  const manifest = JSON.parse(readFileSync(join(install.packageDir, "package.json"), "utf8")) as { main?: string }
  const entry = join(install.packageDir, manifest.main ?? "dist/index.js")
  return await import(pathToFileURL(entry).href) as MicrosandboxSandbox.Sdk
}

/** What the boot probe saw. */
export interface Probe {
  readonly ok: boolean
  readonly detail: string
  readonly durationMs: number
}

/**
 * Boots one ephemeral microVM from `image`, runs `command` (default `true`) in it, and removes
 * it. The machine carries an owner no other run shares, and the sweep after
 * it removes exactly that owner's machines, so nothing else is touched.
 */
export const bootProbe = async (
  sdk: MicrosandboxSandbox.Sdk,
  image: string,
  options: {
    readonly timeoutMs?: number | undefined
    readonly command?: string | undefined
    /** Names this probe's machine; unique per call by default. */
    readonly run?: string | undefined
  } = {}
): Promise<Probe> => {
  const command = options.command ?? "true"
  const run = options.run ?? `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const owner = `smithers-doctor-${run}`
  sdk.setDefaultBackend("local")
  const provider = MicrosandboxSandbox.make({
    sdk,
    image,
    cpus: 1,
    memoryMib: 1024,
    persistence: "ephemeral",
    disableNetwork: true,
    owner,
    holder: `doctor-${run}`,
    labels: { "smithers.doctor": run },
    maxDurationSecs: 600,
    idleTimeoutSecs: 300,
    pullPolicy: "if-missing"
  })
  const started = Date.now()
  const boot = Effect.scoped(Effect.gen(function*() {
    const session = yield* provider.acquire(`doctor-${run}`)
    return yield* Effect.scoped(Effect.gen(function*() {
      const child = yield* session.spawn(command, {})
      yield* Effect.all([Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], { concurrency: "unbounded" })
      return yield* child.exitCode
    }))
  })).pipe(
    Effect.timeoutOption(options.timeoutMs ?? 300_000),
    Effect.map((exit) => exit._tag === "Some" ? { exitCode: exit.value } : { timedOut: true as const }),
    Effect.catch((error) => Effect.succeed({ error: error.message }))
  )
  const outcome = await Effect.runPromise(boot)
  // The provider stops an ephemeral machine on release; the sweep removes
  // anything a timeout or failure left under this run's owner.
  const swept = await Effect.runPromise(
    MicrosandboxSandbox.reap({ sdk, owner, isAlive: () => Effect.succeed(false) }).pipe(
      Effect.map((reaped) => reaped.length),
      Effect.catch((error) => Effect.succeed(error.message))
    )
  )
  const durationMs = Date.now() - started
  const leftover = typeof swept === "string" ? `; cleanup failed: ${swept}` : ""
  if ("exitCode" in outcome) {
    return outcome.exitCode === 0 && leftover === ""
      ? {
        ok: true,
        detail: `${image} booted, \`${command}\` exited 0 in ${(durationMs / 1000).toFixed(1)}s`,
        durationMs
      }
      : { ok: false, detail: `\`${command}\` exited ${outcome.exitCode}${leftover}`, durationMs }
  }
  if ("timedOut" in outcome) return { ok: false, detail: `no boot within the deadline${leftover}`, durationMs }
  return { ok: false, detail: `${outcome.error}${leftover}`, durationMs }
}
