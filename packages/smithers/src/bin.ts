#!/usr/bin/env node
/**
 * Public process entry; bootstrap shared declaration identities before loading commands.
 * @since 1.0.0
 */

import * as Audience from "@smthrs/build-cli/Audience"
import { installEffectResolution } from "@smthrs/build-cli/effect-resolution"
import { isolateProcess } from "@smthrs/build-cli/Entry"
import * as Redaction from "@smthrs/journal/Redaction"
import { normalizeArguments, targetCommands } from "./cli/Arguments.ts"
import * as Argv from "./cli/Argv.ts"
import { agentArguments, formattedLogArguments, legacyArguments } from "./cli/Compatibility.ts"
import * as Failure from "./internal/Failure.ts"

const start = async (): Promise<void> => {
  installEffectResolution({ "@smthrs/agent": import.meta.url })
  const original = process.argv.slice(2)
  const parsed = Argv.parse(original)
  const normalized = normalizeArguments(original)
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.CLOUDFLARE_API_TOKEN) {
    // Use the command's option roles: a --mcp value is ordinary input.
    const { makeCli } = await import("./Cli.ts")
    const roles = Argv.parse(normalized, makeCli())
    if (
      (roles.mcp || targetCommands.has(normalized[0] ?? "") ||
        normalized[0] === "generate" && ["ci", "package"].includes(normalized[1] ?? "")) &&
      await isolateProcess(undefined, roles.mcp)
    ) return
  }
  let agentAlias = formattedLogArguments(parsed)
  try {
    agentAlias ??= Audience.fromArguments(original).audience === "agent" ? agentArguments(parsed) : undefined
  } catch { /* The selected entrypoint renders invalid presentation configuration. */ }
  const legacy = agentAlias === undefined ? legacyArguments(parsed) : undefined
  if (legacy !== undefined) {
    process.argv.splice(2, process.argv.length - 2, ...legacy)
    await import("./cli/LegacyBin.ts")
  } else {
    const { main } = await import("./cli/Entry.ts")
    await main({
      argv: agentAlias ?? original,
      env: process.env,
      stdout: process.stdout,
      stderr: process.stderr,
      on: (signal, listener) => {
        process.on(signal, listener)
      },
      removeListener: (signal, listener) => {
        process.removeListener(signal, listener)
      },
      setExitCode: (code) => {
        process.exitCode = code
      },
      waitForDisconnect: (signal) =>
        new Promise<void>((resolve) => {
          const finish = () => {
            process.stdin.removeListener("end", finish)
            process.stdin.removeListener("close", finish)
            signal.removeEventListener("abort", abort)
            resolve()
          }
          const abort = () => {
            process.stdin.destroy()
            finish()
          }
          if (signal.aborted) abort()
          else if (process.stdin.readableEnded || process.stdin.destroyed) finish()
          else {
            process.stdin.once("end", finish)
            process.stdin.once("close", finish)
            signal.addEventListener("abort", abort, { once: true })
          }
        })
    })
  }
}

void start().catch((cause: unknown) => {
  const text = Failure.operatorReport(cause, Argv.parse(process.argv.slice(2)).verbose)
  process.stderr.write(`${String(Redaction.redactDiagnostic(text))}\n`)
  process.exitCode = 1
})
