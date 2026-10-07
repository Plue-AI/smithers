import { payloadFor } from "./SlashPayload"
import type { CardCommandInput } from "@smthrs/rpc/CardAction"
export type GitHubOperation = NonNullable<NonNullable<CardCommandInput["github"]>["operation"]>
export const githubInput = (operation: GitHubOperation, input: Readonly<Record<string, unknown>> = {}): NonNullable<CardCommandInput["github"]> => ({ ...input, operation })
export const githubArgs = (operation: GitHubOperation, args = ""): string => {
  let input: Record<string, unknown> = {}
  if (args.trim().startsWith("{")) {
    try { const value: unknown = JSON.parse(args); if (value && typeof value === "object" && !Array.isArray(value)) input = value as Record<string, unknown> } catch { return "{}" }
  } else {
    const old = operation === "app-open" ? "github.app.open" : operation === "app-choose" ? "github.app.choose" : operation === "reconcile" ? "github.reconcile" : "github.app"
    if (operation !== "retry") { const parsed = payloadFor(old, args); if ("payload" in parsed) input = parsed.payload }
  }
  return JSON.stringify(githubInput(operation, input))
}
