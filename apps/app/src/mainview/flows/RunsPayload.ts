import type { CardCommandInput } from "@smthrs/rpc/CardAction"
import { payloadFor } from "./SlashPayload"
export type RunsOperation = NonNullable<NonNullable<CardCommandInput["runs"]>["operation"]>
export const runsInput = (operation: RunsOperation, input: Readonly<Record<string, unknown>> = {}): NonNullable<CardCommandInput["runs"]> => ({ ...input, operation })
export const runsArgs = (operation: RunsOperation, args = ""): string => {
  let input: Record<string, unknown> = {}
  if (args.trim().startsWith("{")) {
    try { const value: unknown = JSON.parse(args); if (value && typeof value === "object" && !Array.isArray(value)) input = value as Record<string, unknown> } catch { return "{}" }
  } else {
    const parsed = payloadFor(operation === "approval-open" ? "approvals.open" : operation === "approval-list" ? "approvals.list" : "runs.attention", args)
    if ("payload" in parsed) input = parsed.payload
  }
  return JSON.stringify(runsInput(operation, input))
}
