import type { ApplicationTarget, ApplicationTargetDocument } from "@smthrs/rpc/ApplicationTarget"
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

/** A running client may read rotations only for the backend it was created for. */
export const selectedBackendToken = (expected?: ApplicationTarget, pageOrigin?: string): string | undefined => {
  if (expected !== undefined) {
    const selected = selectedBackendTarget(pageOrigin ?? location.origin)
    if (selected === undefined) return undefined
    const current = resolveApplicationTarget(selected, pageOrigin ?? location.origin)
    if (current.baseUrl !== expected.baseUrl || current.auth.kind !== expected.auth.kind) return undefined
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? undefined
}

/** A switch lasts only for this tab/window and never reuses the old backend's credential. */
export const switchBackendTarget = (origin: string, token: string, pageOrigin: string): void => {
  const credential = token.trim()
  const requestedOrigin = origin.trim()
  const sameOrigin = requestedOrigin === "" || (
    URL.canParse(requestedOrigin) && URL.canParse(pageOrigin) &&
    new URL(requestedOrigin).origin === new URL(pageOrigin).origin
  )
  const target = resolveApplicationTarget({
    apiVersion: 1,
    mode: credential ? "web-plue" : "web-selfhost",
    apiOrigin: requestedOrigin,
    auth: { kind: credential ? "bearer" : "session" },
    cors: credential && !sameOrigin ? "credentialed" : "same-origin",
    developerExternal: credential !== ""
  }, pageOrigin)
  const { apiVersion, mode, apiOrigin, auth, cors, developerExternal } = target
  // Retire the old credential before changing hosts; any storage failure must fail closed.
  sessionStorage.removeItem(TOKEN_KEY)
  sessionStorage.setItem(TARGET_KEY, JSON.stringify({ apiVersion, mode, apiOrigin, auth, cors, developerExternal }))
  if (credential) sessionStorage.setItem(TOKEN_KEY, credential)
}
