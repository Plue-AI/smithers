import { payloadFor } from "./SlashPayload"

/** Decode recorded revision and frame targets; these names are never executable doors. */
export const historicalDiffOperations: Readonly<Record<string, "change" | "change-diff" | "pins" | "checks" | "file">> = {
  "change.view": "change", "change.diff": "change-diff", "change.pins": "pins", "change.checks": "checks", "files.open-diff": "file"
}
export const savedDiffArgs = (name: string, args?: string): string => {
  let payload: Readonly<Record<string, unknown>> | undefined
  try {
    const value: unknown = JSON.parse(args ?? "")
    if (value && typeof value === "object" && !Array.isArray(value)) payload = value as Record<string, unknown>
  } catch { /* Recorded slash arguments use their original data grammar. */ }
  const parsed = payload === undefined ? payloadFor(name, args) : { payload }
  return JSON.stringify({ ...("payload" in parsed ? parsed.payload : {}), operation: historicalDiffOperations[name] })
}
