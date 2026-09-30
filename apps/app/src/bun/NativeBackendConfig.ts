import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import type { ApplicationTargetDocument } from "@smthrs/rpc/ApplicationTarget"
import type { NativeBackend } from "./NativeBackendProcess"

export interface NativeBackendConfig {
  readonly rendererOrigin: string
  readonly target: ApplicationTargetDocument
  readonly token: string | null
  readonly bootstrapToken: string | null
}

const origin = (name: string, value: string | undefined): string => {
  const raw = value?.trim()
  if (raw === undefined || raw === "") throw new Error(`${name} is required.`)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin.`)
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" ||
    parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`${name} must be an absolute HTTP(S) origin without a path.`)
  }
  return parsed.origin
}

/**
 * Consume the package supervisor handshake. This function never launches a
 * database or backend; issue12 supplies the ready owned origin directly.
 */
export const nativeBackendConfig = (
  env: Readonly<Record<string, string | undefined>>,
  backend: NativeBackend,
  packagedRendererOrigin?: string
): NativeBackendConfig => {
  const backendOrigin = backend.mode === "own"
    ? origin("owned backend origin", backend.origin)
    : origin("SMITHERS_API_ORIGIN", env.SMITHERS_API_ORIGIN)
  const rendererOrigin = packagedRendererOrigin !== undefined
    ? origin("packaged renderer origin", packagedRendererOrigin)
    : origin("SMITHERS_RENDERER_ORIGIN", env.SMITHERS_RENDERER_ORIGIN?.trim() || backendOrigin)
  const apiOrigin = backend.mode === "own" && packagedRendererOrigin !== undefined ? rendererOrigin : backendOrigin
  const external = apiOrigin !== rendererOrigin
  // The bearer is a Plue credential; the owned backend authenticates its owner by session.
  const token = backend.mode === "plue" ? env.SMITHERS_API_TOKEN?.trim() || null : null
  const auth = token === null ? "session" : "bearer"
  const document: ApplicationTargetDocument = {
    apiVersion: 1,
    mode: backend.mode === "own" ? "native-own" : "native-plue",
    apiOrigin,
    auth: { kind: auth },
    cors: external ? "credentialed" : "same-origin",
    developerExternal: false
  }
  // Run the shared validator here too; a malformed package handshake never opens a window.
  resolveApplicationTarget(document, rendererOrigin)
  return {
    rendererOrigin,
    target: document,
    token,
    bootstrapToken: backend.mode === "own" ? backend.bootstrapToken ?? null : null
  }
}
