import { payloadFor } from "./SlashPayload"

/** Recorded lifecycle actions retain explicit run, reason and repository targets. */
export const historicalRunLifecycle: Readonly<Record<string, "stop" | "retry" | "stop-all">> = {
  "flow.run.stop": "stop", "flow.run.retry": "retry", "flow.run.stop-all": "stop-all"
}
export const savedRunLifecycleArgs = (name: string, args?: string): string => {
  let payload: Readonly<Record<string, unknown>> | undefined
  try { const value: unknown = JSON.parse(args ?? ""); if (value && typeof value === "object" && !Array.isArray(value)) payload = value as Record<string, unknown> } catch { /* Recorded slash data. */ }
  const parsed = payload === undefined ? payloadFor(name, args) : { payload }
  return JSON.stringify({ ...("payload" in parsed ? parsed.payload : {}), operation: historicalRunLifecycle[name] })
}
