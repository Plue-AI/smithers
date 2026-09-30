import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import type { ApplicationTarget, ApplicationTargetDocument } from "@smthrs/rpc/ApplicationTarget"

export const APPLICATION_TARGET_META = "smithers-application-target"

export interface RuntimeTargetSource {
  readonly document?: Pick<Document, "querySelector">
  readonly pageOrigin?: string
  readonly native?: () => Promise<ApplicationTargetDocument | undefined>
}

const metaTarget = (document: Pick<Document, "querySelector"> | undefined): unknown => {
  const raw = document?.querySelector<HTMLMetaElement>(`meta[name="${APPLICATION_TARGET_META}"]`)?.content.trim()
  if (raw === undefined || raw === "") return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error("Application target metadata is not valid JSON.")
  }
}

/** Resolve host data before bootstrap; no mode starts a backend from the renderer. */
export const loadApplicationTarget = async (source: RuntimeTargetSource = {}): Promise<ApplicationTarget> => {
  const document = source.document ?? globalThis.document
  const pageOrigin = source.pageOrigin ?? globalThis.location?.origin
  const native = await source.native?.()
  const configured = native ?? metaTarget(document)
  return resolveApplicationTarget(configured === undefined ? {
    apiVersion: 1,
    mode: "web-selfhost",
    apiOrigin: "",
    auth: { kind: "session" },
    cors: "same-origin",
    developerExternal: false
  } : configured, pageOrigin)
}
