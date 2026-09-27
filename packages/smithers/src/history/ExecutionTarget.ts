/**
 * File-free extraction of unambiguous execution targets from transition aliases.
 * @since 1.0.0
 */

import { ControlSchema } from "@smthrs/control"
import { Schema } from "effect"
import * as Argv from "../cli/Argv.ts"

// The verb-specific flags the aliases below accept; the shared globals are
// `Argv`'s to know.
const valued = new Set(["--message", "--scope"])
const switches = new Set(["--resume"])

/**
 * Called only after the real parser selects a handler; never resolves files
 * or guesses a target from an unknown flag's value.
 * @since 1.0.0
 * @category getters
 */
export const executionRunId = (args: ReadonlyArray<string> | Argv.Globals): string | undefined => {
  const { rest } = Argv.parse(args)
  const words: Array<string> = []
  let resume = false
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]!
    if (argument === "--") {
      words.push(...rest.slice(index + 1))
      break
    }
    if (!argument.startsWith("-")) {
      words.push(argument)
      continue
    }
    const separator = argument.indexOf("=")
    const flag = separator === -1 ? argument : argument.slice(0, separator)
    if (valued.has(flag)) {
      if (separator === -1) {
        if (++index >= rest.length) return undefined
      }
      continue
    }
    if (!switches.has(flag)) return undefined
    const value = separator === -1 ? "true" : argument.slice(separator + 1)
    if (value !== "true" && value !== "false") return undefined
    if (flag === "--resume") resume = value === "true"
  }
  const [command, target] = words
  if (target === undefined || target.length === 0) return undefined
  if (["resume", "cancel", "signal", "steer"].includes(command ?? "")) return target
  if (command === "run" && resume) return target
  if (command !== "approve" && command !== "deny") return undefined
  try {
    const payload = Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(JSON.parse(target))
    return payload.target._tag === "Node" ? payload.target.runId : undefined
  } catch {
    // The command's existing approval decoder owns malformed-payload errors.
    return undefined
  }
}
