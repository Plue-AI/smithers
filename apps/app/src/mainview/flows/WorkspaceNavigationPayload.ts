import { payloadFor, unknownFlag } from "./SlashPayload"

/** Original workspace, recovery and repository identities are recorded data, never command aliases. */
export const historicalWorkspaceNavigation: Readonly<Record<string, "workspace" | "workspace-open" | "workspace-view">> = {
  "box.list": "workspace", "box.open": "workspace-open", "box.view": "workspace-view"
}
export const savedWorkspaceNavigationArgs = (name: string, args?: string): string => {
  if (name === "box.open" && unknownFlag(args, "[bookmark] [owner/repo] [--kind container|vm] [--snapshot id] [--recoveryOf id]")) return JSON.stringify({ operation: "recorded-invalid" })
  let payload: Readonly<Record<string, unknown>> | undefined
  try { const value: unknown = JSON.parse(args ?? ""); if (value && typeof value === "object" && !Array.isArray(value)) payload = value as Record<string, unknown>; else return JSON.stringify({ operation: "recorded-invalid" }) } catch { if (/^[{["]/.test(args?.trim() ?? "")) return JSON.stringify({ operation: "recorded-invalid" }); /* Original slash grammar remains a data decoder. */ }
  const parsed = payload === undefined ? payloadFor(name, args) : { payload }
  if ("error" in parsed) return JSON.stringify({ operation: "recorded-invalid" })
  return JSON.stringify({ ...parsed.payload, operation: historicalWorkspaceNavigation[name] })
}
