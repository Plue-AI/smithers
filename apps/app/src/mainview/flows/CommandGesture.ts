import { Context } from "effect"

/** Local text is prepared synchronously; publication still waits for command admission. */
export interface PreparedWikiEdit {
  readonly complete: () => Promise<string | void>
  readonly release: () => void
}

/** Local input preparation or a browser reservation from the original human gesture. */
export interface CommandGesture {
  readonly name: string
  readonly openExternal?: (url: string) => Promise<boolean>
  readonly copyText?: (text: string) => Promise<void>
  readonly chatInputCurrent?: () => boolean
  /** Submission owns only the input captured before its command receipt wait. */
  readonly composerDraftCurrent?: () => boolean
  /** The local preference already changed; the binding awaits its save without replaying it. */
  readonly inputModeChanged?: Promise<void>
  readonly wikiEditPrepared?: PreparedWikiEdit["complete"]
  readonly hasWriteOnly?: (field: string) => boolean
  readonly takeWriteOnly?: (field: string) => string | undefined
  readonly release: () => void
}
export const FlowGesture = Context.Reference<CommandGesture | undefined>("ui/flows/FlowGesture", { defaultValue: () => undefined })

export const reserveBrowserCommandGesture = (name: string): CommandGesture | undefined => {
  if (name === "auth.sign-in" || name === "app.download") {
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
  if (name !== "chat.copy-message" || typeof navigator === "undefined" || typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return undefined
  let resolve!: (blob: Blob) => void
  let reject!: (cause: Error) => void
  let consumed = false
  const data = new Promise<Blob>((done, failed) => { resolve = done; reject = failed })
  void data.catch(() => {})
  // Capture activation now; no clipboard bytes exist until the gated handler supplies them.
  let writing: Promise<void>
  try { writing = navigator.clipboard.write([new ClipboardItem({ "text/plain": data })]) }
  catch (cause) { writing = Promise.reject(cause) }
  void writing.catch(() => {})
  return {
    name,
    copyText: text => { consumed = true; resolve(new Blob([text], { type: "text/plain" })); return writing },
    release: () => { if (!consumed) reject(new Error("The command was not accepted")) }
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
