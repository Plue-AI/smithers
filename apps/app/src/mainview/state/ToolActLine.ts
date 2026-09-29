import { FLOW_AUTHORING_ENTRY } from "@smthrs/rpc/FlowAuthoring"
import { canonicalCommandName } from "@smthrs/ui/command-line"
import type { PendingToolCall } from "./controller/context"
import { runLaunchCommandOf, toolResultLaunchedRun } from "./RunClaims"

export const toolActLine = (call: PendingToolCall, result: string): string => {
  let inner = call.name
  let action: string | undefined
  let args: string | undefined
  try {
    const parsed: unknown = JSON.parse(call.args)
    if (typeof parsed === "object" && parsed !== null) {
      // Match the agent boundary so padded and slashed names render
      // the same receipt as the command that executed.
      if ("name" in parsed && typeof parsed.name === "string") inner = canonicalCommandName(parsed.name)
      if ("action" in parsed && typeof parsed.action === "string") action = parsed.action
      if ("args" in parsed && typeof parsed.args === "string") args = parsed.args
    }
  } catch {
    // The raw tool name is the honest label when the arguments don't parse.
  }
  if (call.name === "commands" && action === "list") return "Smithers checked what it can do here"
  if (result.startsWith("asked the user to confirm ")) return `Smithers asked for confirmation of /${inner}`
  if (result.startsWith("rendered a form for ")) return `Smithers opened the /${inner} form`
  if (
    call.name === "commands" && (inner === "browser" || inner === "browser.open") && !result.startsWith("failed:") && !result.startsWith("unknown-")
  ) {
    let host = args ?? ""
    try {
      host = new URL(args ?? "").host
    } catch {
      // Keep the raw args as the host label.
    }
    return `Smithers read ${host}`
  }
  /*
   * Wave 12 §1: the act line for a launch is deterministic too — it names
   * the run the client actually started, from the machine acknowledgment,
   * never from the model's wording.
   */
  const launched = runLaunchCommandOf(call.name, call.args)
  if (launched !== undefined && toolResultLaunchedRun(result)) {
    /* The authoring door's acknowledgment names no workflow: `flow.create` is always the one flow. */
    const workflow = /\bworkflow=(\S+)/.exec(result)?.[1] ?? (launched === "flow.create" ? FLOW_AUTHORING_ENTRY : inner)
    const repo = /\brepo=(\S+)/.exec(result)?.[1]
    const verb = /-requested\b/.test(result) ? "requested" : "started"
    return `Smithers ${verb} a ${workflow} run${repo === undefined ? "" : ` on ${repo}`}`
  }
  const label = call.name === "commands" ? `/${inner}` : call.name
  if (result.startsWith("executed /") || (!result.startsWith("failed:") && !result.startsWith("unknown-"))) {
    return `Smithers ran ${label}`
  }
  // The honest failure, one line, payload-free: an error string that
  // still looks like raw JSON never reaches the transcript.
  const clean = result.trim().startsWith("{") || result.trim().startsWith("[") ? "that didn't work" : result
  return `Smithers tried ${label} — ${clean.replace(/\s+/g, " ").slice(0, 160)}`
}
