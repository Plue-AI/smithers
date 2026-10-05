/**
 * The smithers-build process entry, as a function.
 *
 * `main.js` boots the TypeScript loader and `main.ts` calls {@link main}
 * with the real process. Everything the process does beyond that, capturing
 * and clearing the cache credentials, wiring SIGINT and SIGTERM to one
 * `AbortController`, recording the exit code, lives here so a test can drive
 * it with a fake process and a fake terminal.
 *
 * @since 0.1.0
 */

import { NodeStream } from "@effect/platform-node"
import * as Secret from "@smthrs/targets/Secret"
import * as SecretProxy from "@smthrs/targets/SecretProxy"
import * as NodePath from "node:path"
import * as AffectedBase from "./AffectedBase.ts"
import * as Audience from "./Audience.ts"
import { makeCli, normalizeArgv } from "./Cli.ts"
import * as Environment from "./Environment.ts"
import * as ApprovalBridge from "./internal/ApprovalBridge.ts"
import * as ContainedProcess from "./internal/ContainedProcess.ts"
import * as PackageDiscovery from "./PackageDiscovery.ts"
import type * as Reporter from "./Reporter.ts"

/**
 * The slice of `process` the entry point touches.
 *
 * @category models
 * @since 0.1.0
 */
export interface Host {
  readonly argv: ReadonlyArray<string>
  readonly env: Record<string, string | undefined>
  /** The launch directory relative `PATH` entries resolve against; defaults to `process.cwd()`. */
  readonly cwd?: string | undefined
  readonly stdin?: { readonly isTTY?: boolean | undefined } | undefined
  readonly stdout: Reporter.Terminal
  readonly stderr: Reporter.Terminal
  /**
   * Registers a persistent signal listener, never a one-shot one.
   *
   * `ServiceSupervisor`'s orphan backstop asks `listenerCount(signal)` whether
   * anything else owns the signal, and hard-kills the process when the answer
   * is that it stands alone. Node's one-shot wrapper removes its listener
   * BEFORE invoking it, so a `once` registration here surrendered ownership at
   * exactly the moment the backstop looked: it re-raised with no handler
   * installed and the process died instantly, before the abort this entry had
   * just issued could unwind. Every write-set revert, scratch cleanup, and
   * graceful service stop was skipped.
   */
  readonly on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void
  readonly removeListener: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void
  readonly setExitCode: (code: number) => void
}

/**
 * Runs one invocation against a host. The cache URL and token are read once
 * and removed from the host environment before any declaration evaluates, so no
 * workspace module can read them. Relative `PATH` entries are fixed to the
 * launch directory first. A signal aborts every running target and the
 * process exits 1 whatever the command was about to report.
 *
 * @category execution
 * @since 0.1.0
 */
export const main = async (host: Host): Promise<void> => {
  Environment.anchorSearchPath(host.env, host.cwd ?? process.cwd())
  const presentation = Audience.fromArguments(host.argv, {
    env: host.env,
    stdin: host.stdin?.isTTY === true,
    stdout: host.stdout.isTTY,
    stderr: host.stderr.isTTY
  })
  const cacheUrl = host.env["SMITHERS_CACHE_URL"]
  const cacheToken = host.env["SMITHERS_CACHE_TOKEN"]
  delete host.env["SMITHERS_CACHE_URL"]
  delete host.env["SMITHERS_CACHE_TOKEN"]
  // A parent CLI (watch, a repository target) serves its approval store here.
  const approvals = ApprovalBridge.client(host.env[ApprovalBridge.environmentName])
  delete host.env[ApprovalBridge.environmentName]

  const controller = new AbortController()
  let interrupted = false
  const interrupt = (signal: "SIGINT" | "SIGTERM", listener: () => void): void => {
    interrupted = true
    host.setExitCode(1)
    controller.abort(new Error(`smithers build interrupted by ${signal}`))
    // Surrender the signal only once this delivery is over. Every listener of
    // one emit runs from a snapshot taken before the first of them, but
    // `listenerCount` reads the live set, so removing synchronously here would
    // show the supervisor's backstop an unowned signal within this very
    // delivery, which is the bug a persistent registration exists to avoid.
    // Deferring to a microtask leaves the next signal to the default
    // behavior, so a second interrupt still stops the process at once.
    queueMicrotask(() => host.removeListener(signal, listener))
  }
  const onSigint = (): void => interrupt("SIGINT", onSigint)
  const onSigterm = (): void => interrupt("SIGTERM", onSigterm)
  const exit = (code: number): void => host.setExitCode(code)

  host.on("SIGINT", onSigint)
  host.on("SIGTERM", onSigterm)
  try {
    await makeCli({
      verifiedGreenBase: host.env.SMITHERS_VERIFIED_GREEN_BASE,
      cacheUrl,
      cacheToken,
      signal: controller.signal,
      environment: { ...host.env },
      stdout: host.stdout,
      stderr: host.stderr,
      presentation,
      exit,
      approvals
    }).serve(Audience.incurArguments(normalizeArgv(host.argv), presentation), {
      exit,
      stdout: (text) => host.stdout.write(text)
    })
  } finally {
    host.removeListener("SIGINT", onSigint)
    host.removeListener("SIGTERM", onSigterm)
    if (interrupted) host.setExitCode(1)
  }
}

/** Keeps real API credentials in a trusted process, outside declaration execution.
 * The explicit audience option is for hermetic transport tests; executable entries
 * always use the fixed production audiences.
 * @category execution
 * @since 1.0.0
 */
export const isolateProcess = async (
  audiences: Readonly<Record<string, string>> = {
    GITHUB_TOKEN: "https://api.github.com",
    CLOUDFLARE_API_TOKEN: "https://api.cloudflare.com"
  },
  protocolInput = false
): Promise<boolean> => {
  const credentials = Object.fromEntries(
    Object.keys(audiences).flatMap((name) => {
      const value = process.env[name] ?? (name === "GITHUB_TOKEN" ? process.env.GH_TOKEN : undefined)
      return value === undefined || value.startsWith("smithers-build-secret-") ? [] : [[name, value]]
    })
  )
  if (Object.keys(credentials).length === 0) return false
  const environment = { ...process.env }
  delete environment.GH_TOKEN
  delete environment.SMITHERS_SECRET_ORIGINS
  delete environment.SMITHERS_VERIFIED_GREEN_BASE
  for (const name of Object.keys(credentials)) delete environment[name]
  const controller = new AbortController()
  let interrupted: number | undefined
  const stop = (code: number) => {
    interrupted = code
    controller.abort()
    if (protocolInput) process.stdin.destroy()
  }
  const onSigint = () => stop(130)
  const onSigterm = () => stop(143)
  const vault = SecretProxy.makeVault({ read: (name) => credentials[name] })
  const proxy = await SecretProxy.startProxy(vault, {})
  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigterm)
  try {
    const origins: Record<string, string> = {}
    for (const name of Object.keys(credentials)) {
      const origin = audiences[name]!
      environment[name] = vault.mint(Secret.HttpSecret(Secret.Secret(name), [origin]))
      origins[origin] = await proxy.originFor(origin)
    }
    environment.SMITHERS_SECRET_ORIGINS = JSON.stringify(origins)
    const args = process.argv.slice(2)
    if (args.includes("--base-green")) {
      const workspaceIndex = args.findIndex((arg) =>
        arg === "--workspace" || arg === "-w" || arg.startsWith("--workspace=") || arg.startsWith("-w=") ||
        arg === "--root" || arg.startsWith("--root=")
      )
      const flag = args[workspaceIndex]
      const workspace = flag === undefined ? process.cwd() : flag.includes("=")
        ? flag.slice(flag.indexOf("=") + 1) :
        args[workspaceIndex + 1] ?? process.cwd()
      const root = await PackageDiscovery.findWorkspaceRoot(NodePath.resolve(workspace))
      environment.SMITHERS_VERIFIED_GREEN_BASE = root === undefined ?
        "" :
        await AffectedBase.resolve(
          root,
          { ...environment, GITHUB_TOKEN: credentials.GITHUB_TOKEN },
          controller.signal
        ) ?? ""
    }
    const code = await ContainedProcess.run({
      command: process.execPath,
      args: [...process.execArgv, process.argv[1]!, ...args],
      cwd: process.cwd(),
      environment,
      signal: controller.signal,
      input: protocolInput ? NodeStream.fromReadable({ evaluate: () => process.stdin }) : undefined,
      maxOutputBytes: protocolInput ? undefined : 16 * 1024 * 1024,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text)
    })
    process.exitCode = interrupted ?? code
    return true
  } catch (cause) {
    if (
      interrupted === undefined ||
      cause instanceof ContainedProcess.ProcessError && cause.code === "cleanup_failed"
    ) throw cause
    process.exitCode = interrupted
    return true
  } finally {
    await proxy.close()
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
  }
}
