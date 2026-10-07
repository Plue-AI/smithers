import { payloadFor } from "./SlashPayload"
/** Old navigation payloads remain data; only the canonical file doors execute. */
export const savedFileNavigationArgs = (name: string, args?: string): string => {
  let payload: Record<string, unknown> = {}
  if (args?.trim().startsWith("{")) {
    try { const value: unknown = JSON.parse(args); if (value && typeof value === "object" && !Array.isArray(value)) payload = value as Record<string, unknown> } catch { /* Invalid saved inputs need a fresh form. */ }
  } else {
    const parsed = payloadFor(name, args)
    if ("payload" in parsed) payload = parsed.payload
  }
  const operation = name === "repo.tree" ? "tree" : name.startsWith("box.") ? "workspace" : "repository"
  return JSON.stringify({ ...payload, operation })
}
