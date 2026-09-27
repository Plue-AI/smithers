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

import * as Audience from "./Audience.ts"
import { makeCli, normalizeArgv } from "./Cli.ts"
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
 * workspace module can read them. A signal aborts every running target and
 * the process exits 1 whatever the command was about to report.
 *
 * @category execution
 * @since 0.1.0
 */
export const main = async (host: Host): Promise<void> => {
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
      cacheUrl,
      cacheToken,
      signal: controller.signal,
      environment: host.env,
      stdout: host.stdout,
      stderr: host.stderr,
      presentation,
      exit
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
