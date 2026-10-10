import type { Runtime } from "../../cli/ControlBridge.ts"
import { Session } from "./Session.ts"

// Explicit local scope wins over both a destination flag and saved install settings.
export const targetsInstall = (
  context: { args: Record<string, unknown>; options: Record<string, unknown> },
  runtime: Runtime
): boolean => {
  const { args, options } = context
  if (["root", "data", "flow"].some((key) => options[key] !== undefined) || args.path !== undefined) return false
  if (options.repo !== undefined || options.cloud === true) return true
  const env = runtime.environment ?? process.env
  return !!(new Session(env).config().api_origin || env.SMITHERS_TOKEN || env.SMITHERS_TOKEN_FILE)
}
