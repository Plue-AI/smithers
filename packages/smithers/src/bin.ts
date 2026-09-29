#!/usr/bin/env node
/**
 * Public process entry; bootstrap shared declaration identities before loading commands.
 * @since 1.0.0
 */

import * as Audience from "@smthrs/build-cli/Audience"
import { installEffectResolution } from "@smthrs/build-cli/effect-resolution"
import * as Redaction from "@smthrs/journal/Redaction"
import * as Argv from "./cli/Argv.ts"
import { agentArguments, formattedLogArguments, legacyArguments } from "./cli/Compatibility.ts"
import * as Failure from "./internal/Failure.ts"

const start = async (): Promise<void> => {
  const original = process.argv.slice(2)
  const parsed = Argv.parse(original)
  let agentAlias = formattedLogArguments(parsed)
  try {
    agentAlias ??= Audience.fromArguments(original).audience === "agent" ? agentArguments(parsed) : undefined
  } catch { /* The selected entrypoint renders invalid presentation configuration. */ }
  const legacy = agentAlias === undefined ? legacyArguments(parsed) : undefined
  if (legacy !== undefined) {
    process.argv.splice(2, process.argv.length - 2, ...legacy)
    await import("./cli/LegacyBin.ts")
  } else {
    installEffectResolution()
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
  process.stderr.write(`${String(Redaction.redactDiagnostic(Failure.operatorSentence(cause)))}\n`)
  process.exitCode = 1
})
