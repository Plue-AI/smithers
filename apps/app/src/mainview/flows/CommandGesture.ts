import { reserveCopyText } from "@smthrs/ui"
import { Context } from "effect"

/** Local text is prepared synchronously; publication still waits for command admission. */
export interface PreparedWikiEdit {
  readonly complete: () => Promise<string | void>
  readonly release: () => void
}

/** Local input preparation or a browser reservation from the original human gesture. */
export interface CommandGesture {
  readonly notificationPermission?: Promise<NotificationPermission>
  readonly name: string
  readonly openExternal?: (url: string) => Promise<boolean>
  readonly copyText?: (text: string) => Promise<void>
  readonly chatInputCurrent?: () => boolean
  /** An awaited form continuation may reveal its result only while its frame gesture is current. */
  readonly presentationCurrent?: () => boolean
  /** Submission owns only the input captured before its command receipt wait. */
  readonly composerDraftCurrent?: () => boolean
  /** The local preference already changed; the binding awaits its save without replaying it. */
  readonly inputModeChanged?: Promise<void>
  readonly wikiEditPrepared?: PreparedWikiEdit["complete"]
  readonly hasWriteOnly?: (field: string) => boolean
  readonly takeWriteOnly?: (field: string) => string | undefined
  /** The file the human's own dialog chose (wiki.attach); bytes never ride a serializable command. */
  readonly takeFile?: () => File | undefined
  readonly release: () => void
}
export const FlowGesture = Context.Reference<CommandGesture | undefined>("ui/flows/FlowGesture", { defaultValue: () => undefined })

export const reserveBrowserCommandGesture = (name: string): CommandGesture | undefined => {
  if (name === "sign-in") {
    if (typeof window === "undefined") return undefined
    let popup: Window | null
    try { popup = window.open("about:blank", "_blank") } catch { popup = null }
    if (popup) popup.opener = null
    let consumed = false
    return {
      name,
      openExternal: async url => {
        if (!popup || popup.closed) return false
        popup.location.href = url
        consumed = true
        return true
      },
      release: () => { if (!consumed) popup?.close() }
    }
  }
  if (name !== "chat.copy-message" && name !== "ssh") return undefined
  const reserved = reserveCopyText()
  return reserved ? { name, ...reserved } : undefined
}

/** A file the human chose lives only in this one-shot closure, never in a serializable command. */
export const fileGesture = (name: string, file: File): CommandGesture => {
  let held: File | undefined = file
  return {
    name,
    takeFile: () => { const value = held; held = undefined; return value },
    release: () => { held = undefined }
  }
}

/** Values live only in this one-shot closure, never in a serializable command. */
export const writeOnlyGesture = (name: string, input: Record<string, string>): CommandGesture => {
  const values = new Map(Object.entries(input))
  for (const key of Object.keys(input)) delete input[key]
  return {
    name,
    hasWriteOnly: field => (values.get(field)?.length ?? 0) > 0,
    takeWriteOnly: field => { const value = values.get(field); values.delete(field); return value },
    release: () => values.clear()
  }
}
