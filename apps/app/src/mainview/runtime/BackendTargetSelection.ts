import type { ApplicationTargetDocument } from "@smthrs/rpc/ApplicationTarget"
import { ApplicationTargetDocumentSchema, resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"

const TARGET_KEY = "smithers.backend-target"
const TOKEN_KEY = "smithers.backend-token"

export const selectedBackendTarget = (pageOrigin: string): ApplicationTargetDocument | undefined => {
  try {
    const raw = sessionStorage.getItem(TARGET_KEY)
    if (raw === null) return undefined
    const target = ApplicationTargetDocumentSchema.parse(JSON.parse(raw) as unknown)
    const parsed = resolveApplicationTarget(target, pageOrigin)
    return parsed.shell === "web" ? target : undefined
  } catch {
    try {
      sessionStorage.removeItem(TARGET_KEY)
      sessionStorage.removeItem(TOKEN_KEY)
    } catch { /* Storage is unavailable; use the deployment target. */ }
    return undefined
  }
}

export const selectedBackendToken = (): string | undefined => sessionStorage.getItem(TOKEN_KEY) ?? undefined

/** A switch lasts only for this tab/window and never reuses the old backend's credential. */
export const switchBackendTarget = (origin: string, token: string, pageOrigin: string): void => {
  const credential = token.trim()
  const target = resolveApplicationTarget({
    apiVersion: 1,
    mode: credential ? "web-plue" : "web-selfhost",
    apiOrigin: origin.trim(),
    auth: { kind: credential ? "bearer" : "session" },
    cors: credential ? "credentialed" : "same-origin",
    developerExternal: credential !== ""
  }, pageOrigin)
  const { apiVersion, mode, apiOrigin, auth, cors, developerExternal } = target
  // Retire the old credential before changing hosts; any storage failure must fail closed.
  sessionStorage.removeItem(TOKEN_KEY)
  sessionStorage.setItem(TARGET_KEY, JSON.stringify({ apiVersion, mode, apiOrigin, auth, cors, developerExternal }))
  if (credential) sessionStorage.setItem(TOKEN_KEY, credential)
}
