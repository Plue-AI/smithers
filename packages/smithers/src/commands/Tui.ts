/**
 * `smthrs tui`: hands the terminal to the Smithers TUI.
 *
 * The TUI renders with `@opentui/core`, whose native library loads through
 * Bun's FFI or through Node's `node:ffi`, which needs Node >= 26.4 started
 * with `--experimental-ffi`. This CLI cannot enable FFI in its own running
 * process, so it always starts the TUI as a child with the terminal inherited
 * and exits with the child's status. The first match wins:
 *
 * 1. `SMITHERS_TUI_BIN`: that executable.
 * 2. An installation's compiled binary, `@smthrs/tui-<os>-<arch>[-baseline][-musl]`
 *    (an optional dependency built by `scripts/build-tui-binaries.mjs`), so
 *    `npx smthrs tui` needs neither Bun nor a particular Node.
 * 3. Bun, when `SMITHERS_BUN` names it or this CLI already runs on Bun.
 * 4. This Node, when it is >= 26.4, with `--experimental-ffi`.
 * 5. Otherwise an `UnsupportedError` naming Node >= 26.4 and Bun.
 *
 * The entry Bun or Node runs is the bundle `scripts/build-tui.mjs` writes to
 * `dist/tui/main.js`. A source checkout skips the compiled binaries, which
 * would be stale; there Bun runs `apps/tui/src/main.tsx` directly, and Node
 * runs the bundle after rebuilding it (esbuild takes well under a second and
 * rewrites only changed files), because the workspace's TypeScript sources do
 * not run on plain Node.
 *
 * @since 1.0.0
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { constants } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as CliError from "../CliError.ts"
import * as Environment from "../ExecutionEnvironment.ts"

/**
 * The TUI's own flags, forwarded unchanged.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** Execute the app where this environment keeps its agents and sessions. */
  readonly environment?: string | undefined
  readonly directory?: string | undefined
  readonly model?: string | undefined
  readonly continue?: boolean | undefined
  readonly resume?: boolean | undefined
  readonly print?: string | undefined
  readonly approve?: "all" | "ask" | "deny" | undefined
  /** Validated by the TUI. */
  readonly budgetTokens?: string | undefined
}

/**
 * The argument vector `apps/tui/src/main.tsx` parses.
 *
 * @category constructors
 * @since 1.0.0
 */
export const argv = (options: Options): Array<string> => [
  ...(options.model === undefined ? [] : ["--model", options.model]),
  ...(options.continue === true ? ["--continue"] : []),
  ...(options.resume === true ? ["--resume"] : []),
  ...(options.print === undefined ? [] : ["--print", options.print]),
  ...(options.approve === undefined ? [] : ["--approve", options.approve]),
  ...(options.budgetTokens === undefined ? [] : ["--budget-tokens", options.budgetTokens]),
  ...(options.directory === undefined ? [] : [options.directory])
]

/**
 * What the launch decision reads from the machine, so tests can fake it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Host {
  readonly platform: string
  readonly arch: string
  readonly execPath: string
  readonly versions: { readonly node: string; readonly bun?: string | undefined }
  readonly exists: (path: string) => boolean
  /** The directory of a package as `packageRoot`'s package resolves it, or `undefined`. */
  readonly packageDirectory: (name: string, packageRoot: URL) => string | undefined
  readonly musl: () => boolean
  readonly avx2: () => boolean
}

/**
 * The process this CLI runs in. Package lookups resolve from `@smthrs/cli`,
 * which is meant to declare the platform packages as optional dependencies.
 *
 * @category constructors
 * @since 1.0.0
 */
export const host: Host = {
  platform: process.platform,
  arch: process.arch,
  execPath: process.execPath,
  versions: process.versions,
  exists: existsSync,
  packageDirectory: (name, packageRoot) => {
    try {
      return dirname(createRequire(new URL("package.json", packageRoot)).resolve(`${name}/package.json`))
    } catch {
      return undefined
    }
  },
  musl: () => {
    if (process.platform !== "linux") return false
    if (existsSync("/etc/alpine-release")) return true
    const ldd = spawnSync("ldd", ["--version"], { encoding: "utf8" })
    return `${ldd.stdout ?? ""}${ldd.stderr ?? ""}`.toLowerCase().includes("musl")
  },
  avx2: () => {
    if (process.arch !== "x64") return false
    try {
      if (process.platform === "linux") return /(^|\s)avx2(\s|$)/i.test(readFileSync("/proc/cpuinfo", "utf8"))
      if (process.platform === "darwin") {
        const sysctl = spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], { encoding: "utf8", timeout: 1500 })
        return sysctl.status === 0 && sysctl.stdout.trim() === "1"
      }
    } catch {
      return false
    }
    return false
  }
}

/**
 * The compiled TUI packages that can run here, best first: the exact build,
 * then the other libc or CPU-baseline builds this machine can still run.
 *
 * @category constructors
 * @since 1.0.0
 */
export const binaryPackages = (machine: Host): Array<string> => {
  if (machine.platform !== "darwin" && machine.platform !== "linux") return []
  const base = `@smthrs/tui-${machine.platform}-${machine.arch}`
  const baseline = machine.arch === "x64" && !machine.avx2()
  if (machine.platform === "linux") {
    if (machine.musl()) {
      if (machine.arch !== "x64") return [`${base}-musl`, base]
      return baseline
        ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
        : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
    }
    if (machine.arch !== "x64") return [base, `${base}-musl`]
    return baseline
      ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
      : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
  }
  if (machine.arch !== "x64") return [base]
  return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`]
}

/**
 * Whether `packageRoot` is `packages/smithers` inside a Smithers checkout.
 *
 * @category predicates
 * @since 1.0.0
 */
export const checkout = (packageRoot: URL, machine: Host = host): boolean =>
  machine.exists(fileURLToPath(new URL("../../pnpm-workspace.yaml", packageRoot)))

/**
 * The TUI entry Bun (`bun: true`) or Node runs for the package rooted at
 * `packageRoot`: the checkout source for Bun inside the workspace, else the
 * bundle.
 *
 * @category constructors
 * @since 1.0.0
 */
export const entry = (packageRoot: URL, bun: boolean, machine: Host = host): string =>
  fileURLToPath(
    bun && checkout(packageRoot, machine)
      ? new URL("../../apps/tui/src/main.tsx", packageRoot)
      : new URL("dist/tui/main.js", packageRoot)
  )

/**
 * A process to start: the executable and its arguments before the TUI's own.
 *
 * @category models
 * @since 1.0.0
 */
export interface Launch {
  readonly command: string
  readonly args: ReadonlyArray<string>
  /** The runtime the choice fell to, for messages and tests. */
  readonly runtime: "binary" | "bun" | "node"
}

/** Node >= 26.4 ships `node:ffi` behind `--experimental-ffi`. */
const ffi = (version: string): boolean => {
  const [major = 0, minor = 0] = version.split(".").map(Number)
  return major > 26 || (major === 26 && minor >= 4)
}

/**
 * The process that runs the TUI here, or an `UnsupportedError` when nothing
 * can. It does not build or check the Bun/Node entry; `run` does.
 *
 * @category constructors
 * @since 1.0.0
 */
export const launch = (
  environment: Record<string, string | undefined>,
  packageRoot: URL,
  machine: Host = host
): Launch | CliError.UnsupportedError => {
  const binary = environment["SMITHERS_TUI_BIN"]
  if (binary !== undefined && binary !== "") return { command: binary, args: [], runtime: "binary" }
  if (!checkout(packageRoot, machine)) {
    for (const name of binaryPackages(machine)) {
      const directory = machine.packageDirectory(name, packageRoot)
      const path = directory === undefined ? undefined : join(directory, "bin", "smithers-tui")
      if (path !== undefined && machine.exists(path)) return { command: path, args: [], runtime: "binary" }
    }
  }
  const bun = environment["SMITHERS_BUN"] ?? (machine.versions.bun === undefined ? undefined : machine.execPath)
  if (bun !== undefined && bun !== "") {
    return { command: bun, args: [entry(packageRoot, true, machine)], runtime: "bun" }
  }
  if (ffi(machine.versions.node)) {
    return {
      command: machine.execPath,
      args: ["--experimental-ffi", "--disable-warning=ExperimentalWarning", entry(packageRoot, false, machine)],
      runtime: "node"
    }
  }
  const packages = checkout(packageRoot, machine) ? [] : binaryPackages(machine)
  return new CliError.UnsupportedError({
    message: `smthrs tui needs Node >= 26.4 or Bun; this is Node ${machine.versions.node}. ` +
      "Upgrade Node, or set SMITHERS_BUN to a Bun executable" +
      (packages.length === 0 ? "." : `, or install ${packages.map((name) => JSON.stringify(name)).join(" or ")}.`)
  })
}

const cliRoot = (): URL => new URL(".", import.meta.resolve("@smthrs/cli/package.json"))

/** Rebuilds the checkout bundle so Node never runs stale workspace code. */
const rebuild = async (packageRoot: URL): Promise<void> => {
  const script = new URL("scripts/build-tui.mjs", packageRoot).href
  const { buildTui } = (await import(script)) as { readonly buildTui: () => Promise<void> }
  await buildTui()
}

/** Forwarded to the TUI; SIGINT reaches it from the terminal directly. */
const forwarded = ["SIGTERM", "SIGHUP"] as const

/**
 * Runs the TUI to completion and resolves with its exit status.
 *
 * @category constructors
 * @since 1.0.0
 */
export const run = async (
  options: Options,
  environment: Record<string, string | undefined>,
  packageRoot: URL = cliRoot(),
  machine: Host = host,
  signal?: AbortSignal
): Promise<number> => {
  if (options.environment !== undefined) {
    const profile = await Environment.get(options.environment, environment)
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()
    const ignore = () => {}
    process.on("SIGINT", ignore)
    for (const event of forwarded) process.on(event, cancel)
    try {
      return await Environment.run(profile, ["smthrs", "tui", ...argv(options)], environment, {
        terminal: options.print === undefined,
        signal: controller.signal
      })
    } finally {
      signal?.removeEventListener("abort", cancel)
      process.removeListener("SIGINT", ignore)
      for (const event of forwarded) process.removeListener(event, cancel)
    }
  }
  const chosen = launch(environment, packageRoot, machine)
  if (chosen instanceof CliError.UnsupportedError) throw chosen
  if (chosen.runtime === "node" && checkout(packageRoot, machine)) await rebuild(packageRoot)
  const target = chosen.runtime === "binary" ? chosen.command : chosen.args.at(-1)!
  if (!machine.exists(target)) {
    throw new CliError.UnsupportedError({ message: `The TUI is missing from this installation: ${target}` })
  }
  return new Promise((resolve, reject) => {
    const child = spawn(chosen.command, [...chosen.args, ...argv(options)], { stdio: "inherit", env: environment })
    // The TUI owns Ctrl+C; the parent must outlive it to report its status.
    const ignore = () => {}
    const forward = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal)
      } catch {
        // The child has already exited.
      }
    }
    process.on("SIGINT", ignore)
    for (const signal of forwarded) process.on(signal, forward)
    const settle = () => {
      process.removeListener("SIGINT", ignore)
      for (const signal of forwarded) process.removeListener(signal, forward)
    }
    child.once("error", (cause: NodeJS.ErrnoException) => {
      settle()
      reject(
        cause.code === "ENOENT"
          ? new CliError.UnsupportedError({
            message: chosen.runtime === "bun"
              ? `smthrs tui could not start Bun: ${chosen.command} was not found. Install it from https://bun.sh, ` +
                "or unset SMITHERS_BUN to use Node >= 26.4."
              : `smthrs tui could not start ${chosen.command}: it was not found.`
          })
          : cause
      )
    })
    child.once("exit", (code, signal) => {
      settle()
      resolve(code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0)))
    })
  })
}
