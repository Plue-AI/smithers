/**
 * Process lifetime, cancellation, and cache-secret isolation for the unified CLI.
 * @since 1.0.0
 */

import * as Audience from "@smthrs/build-cli/Audience"
import type { Host as BuildHost } from "@smthrs/build-cli/Entry"
import * as Environment from "@smthrs/build-cli/Environment"
import * as Redaction from "@smthrs/journal/Redaction"
import { makeCli } from "../Cli.ts"
import * as Failure from "../internal/Failure.ts"
import { normalizeArguments } from "./Arguments.ts"
import * as Argv from "./Argv.ts"

/**
 * Process hosts keep MCP alive until stdin closes or the operator interrupts.
 * @category models
 * @since 1.0.0
 */
export interface Host extends BuildHost {
  readonly waitForDisconnect?: ((signal: AbortSignal) => Promise<void>) | undefined
}

/**
 * Runs one invocation; help and validation do not construct a durable runtime.
 * Relative `PATH` entries are fixed to the launch directory first.
 * @category constructors
 * @since 1.0.0
 */
export const main = async (host: Host): Promise<void> => {
  Environment.anchorSearchPath(host.env, host.cwd ?? process.cwd())
  const cacheUrl = host.env["SMITHERS_CACHE_URL"]
  const cacheToken = host.env["SMITHERS_CACHE_TOKEN"]
  delete host.env["SMITHERS_CACHE_URL"]
  delete host.env["SMITHERS_CACHE_TOKEN"]
  const controller = new AbortController()
  let interrupted: number | undefined
  let status = 0
  const exit = (code: number) => {
    if (code !== 0) status = code
    host.setExitCode(interrupted ?? status)
  }
  const interrupt = (signal: "SIGINT" | "SIGTERM", listener: () => void) => {
    interrupted = signal === "SIGINT" ? 130 : 143
    host.setExitCode(interrupted)
    controller.abort(new Error(`smthrs interrupted by ${signal}`))
    queueMicrotask(() => host.removeListener(signal, listener))
  }
  const onSigint = () => {
    // Interactive TUI handles Ctrl+C itself; print mode remains cancellable.
    const parsed = Argv.parse(normalizeArguments(host.argv))
    let offset = 0
    while (parsed.rest[offset]?.startsWith("-") && parsed.rest[offset] !== "--") {
      const flag = parsed.rest[offset]!
      const value = parsed.options.get(flag.split("=")[0]!)
      offset += !flag.includes("=") && typeof value === "string" ? 2 : 1
    }
    const args = parsed.rest.slice(offset)
    if (
      args[0] === "tui" &&
      !args.some((arg) => arg === "-p" || arg === "--print" || arg.startsWith("--print=") || /^-p.+/.test(arg))
    ) return
    interrupt("SIGINT", onSigint)
  }
  const onSigterm = () => interrupt("SIGTERM", onSigterm)
  host.on("SIGINT", onSigint)
  host.on("SIGTERM", onSigterm)
  try {
    let mcp = false
    const presentation = Audience.fromArguments(host.argv, {
      env: host.env,
      stdout: host.stdout.isTTY,
      stderr: host.stderr.isTTY,
      mcp
    })
    const cli = makeCli({
      cacheUrl,
      cacheToken,
      signal: controller.signal,
      environment: host.env,
      stdout: host.stdout,
      stderr: host.stderr,
      presentation,
      exit: (code) => {
        if (!mcp) exit(code)
      }
    })
    const parsed = Argv.parse(normalizeArguments(host.argv), cli)
    mcp = parsed.mcp
    Object.assign(
      presentation,
      Audience.resolve({
        env: host.env,
        stdout: host.stdout.isTTY,
        stderr: host.stderr.isTTY,
        audience: parsed.audience === "auto" || parsed.audience === "human" || parsed.audience === "agent"
          ? parsed.audience
          : undefined,
        silent: parsed.silent || parsed.quiet,
        verbose: parsed.verbose,
        formatExplicit: parsed.json || parsed.format !== undefined,
        mcp
      })
    )
    await cli.serve(Audience.incurArguments(parsed.incurArgv, presentation), {
      env: host.env,
      exit,
      stdout: (text) => host.stdout.write(text)
    })
    if (mcp) await host.waitForDisconnect?.(controller.signal)
  } catch (cause) {
    if (interrupted === undefined) {
      const text = Failure.operatorReport(cause, Argv.parse(host.argv).verbose)
      host.stderr.write(`${String(Redaction.redactDiagnostic(text))}\n`)
      exit(1)
    }
  } finally {
    host.removeListener("SIGINT", onSigint)
    host.removeListener("SIGTERM", onSigterm)
    host.setExitCode(interrupted ?? status)
  }
}
