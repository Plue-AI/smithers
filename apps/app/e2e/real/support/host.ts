import type { RealHost } from "../coverage/types"

/** Classify the observed bootstrap, independently of the requested test host. */
export const realHost = (bootstrap: { readonly host?: unknown; readonly authFlow?: unknown; readonly capabilities?: unknown }): RealHost | undefined => {
  if (bootstrap.host === "cloud") return Array.isArray(bootstrap.capabilities) && bootstrap.capabilities.includes("install") ? "local" : "production"
  if (bootstrap.host === "local") return bootstrap.host
  return undefined
}
