import type { RealHost } from "../coverage/types"

/** Classify the observed bootstrap, independently of the requested test host. */
export const realHost = (bootstrap: { readonly host?: unknown; readonly authFlow?: unknown }): RealHost | undefined => {
  // Cloud is also the self-hosted API surface. Only the explicit owner
  // credentials door identifies that deployment; hosted sign-in can use a
  // redirect, native handoff, or both. Older cloud responses remain hosted.
  if (bootstrap.host === "cloud") return bootstrap.authFlow === "credentials" ? "local" : "production"
  if (bootstrap.host === "local") return bootstrap.host
  return undefined
}
