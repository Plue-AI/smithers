import { payloadFor } from "./SlashPayload"

/** Saved targets remain data, never extra executable doors. */
export const historicalPullNavigation: readonly string[] = ["prs", "prs.list", "prs.view"]
export const savedPullNavigationArgs = (name: string, args?: string): string => {
  const parsed = payloadFor(name === "prs" ? "prs.list" : name, args)
  if ("error" in parsed) return JSON.stringify({ operation: "recorded-invalid" })
  return JSON.stringify({ ...parsed.payload, ...(name === "prs.view" ? {} : { operation: "list" }) })
}
