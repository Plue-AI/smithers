import { createContext } from "react"
import * as Y from "yjs"
import { yCollab, yUndoManagerKeymap, ySyncAnnotation } from "y-codemirror.next"
import { keymap, ViewPlugin } from "@codemirror/view"
import { EditorState, Facet, StateEffect, StateField } from "@codemirror/state"
import type { EditorBinding } from "@smthrs/ui/adapters/code-editor"
import { LiveFileMaxBytes } from "@smthrs/rpc/FileCard"
import type { Actor } from "@smthrs/rpc/CardPrimitives"
import { toActor, type ActorContext } from "../state/ProductActor"

export interface AuthorRange { readonly from: number; readonly to: number; readonly actor: Actor }
/** Presentation consumes this facet; attribution is never used as write authority. */
export const authorRanges = Facet.define<readonly AuthorRange[], readonly AuthorRange[]>({ combine: values => values.flat() })

/** The pinned Yjs item traversal is isolated here; deleted and formatting items contribute no characters. */
export function documentAuthors(doc: Y.Doc, context: ActorContext = {}): AuthorRange[] {
  const text = doc.getText("content"), authors = doc.getMap("authors")
  const ranges: AuthorRange[] = []
  let from = 0
  for (let item = text._start; item; item = item.right) {
    if (item.deleted || !item.countable) continue
    const to = from + item.length, wire = authors.get(String(item.id.client))
    if (wire !== undefined) {
      try {
        const actor = toActor(wire as Parameters<typeof toActor>[0], context.roster, context.runs, context.sessions)
        ranges.push({ from, to, actor })
      } catch { /* Unknown attribution is omitted, never granted authority. */ }
    }
    from = to
  }
  return ranges
}

/** Compose sync and own-edit undo without awareness's remote-selection plugin or CM history. */
export function liveBinding(doc: Y.Doc, context: ActorContext = {}, canEdit: () => boolean = () => true): EditorBinding & { readonly undo: Y.UndoManager; dispose(): void } {
  const text = doc.getText("content")
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set() })
  const changed = StateEffect.define<readonly AuthorRange[]>()
  const ranges = StateField.define<readonly AuthorRange[]>({
    create: () => documentAuthors(doc, context),
    update: (value, transaction) => transaction.effects.find(effect => effect.is(changed))?.value ?? value,
    provide: field => authorRanges.from(field)
  })
  const attribution = ViewPlugin.define(view => {
    let disposed = false, queued = false
    const refresh = () => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (!disposed) view.dispatch({ effects: changed.of(documentAuthors(doc, context)) })
      })
    }
    doc.on("afterTransaction", refresh)
    return { destroy: () => { disposed = true; doc.off("afterTransaction", refresh) } }
  })
  return { get text() { return text.toString() }, undo,
    extensions: [EditorState.transactionFilter.of(transaction => !canEdit() && transaction.docChanged && !transaction.annotation(ySyncAnnotation) ? [] : transaction), ranges, attribution, yCollab(text, null, { undoManager: undo }), keymap.of(yUndoManagerKeymap)],
    dispose: () => undo.destroy() }
}

/** Untrusted awareness only projects remote line flags, never identity assignment. */
export function documentEditors(states: ReadonlyMap<number, unknown>, local: number, context: ActorContext = {}) {
  return [...states].flatMap(([id, value]) => {
    if (id === local || !value || typeof value !== "object") return []
    const row = value as Record<string, unknown>
    if (!Number.isSafeInteger(row.line) || (row.line as number) < 1 || !row.actor) return []
    try { return [{ actor: toActor(row.actor as Parameters<typeof toActor>[0], context.roster, context.runs, context.sessions), line: row.line as number }] }
    catch { return [] }
  })
}

/** The card can select live data only after all provider prerequisites and authenticated assignment. */
export function liveFileModel(model: import("@smthrs/rpc/FileCard").FileCard,
  provider: import("../runtime/LiveDocProvider").LiveDocProvider,
  awareness: ReadonlyMap<number, unknown> = new Map(), context: ActorContext = {}) {
  if (!provider.editable || model.content.kind !== "text" || model.gone) {
    return { ...model, mode: "read_only" as const, ...(provider.unsaved ? { unsaved: provider.unsaved } : {}) }
  }
  const text = provider.doc.getText("content").toString(), bytes = new TextEncoder().encode(text).length
  if (bytes > LiveFileMaxBytes) return { ...model, mode: "read_only" as const, content: { kind: "too_large" as const, bytes, text } }
  const ranges = documentAuthors(provider.doc, context)
  return { ...model, mode: "live" as const, content: { kind: "text" as const, text },
    authors: [...new Map(ranges.map(range => [JSON.stringify(range.actor), range.actor])).values()],
    editors: documentEditors(awareness, provider.doc.clientID, context), saved: provider.saved }
}

/** Host-owned resource port, beside the seeded read model. No default subscribes or enables edits. */
export interface FileDocumentBinding { readonly provider: import("../runtime/LiveDocProvider").LiveDocProvider; readonly binding: EditorBinding }
export const LiveFileContext = createContext<{ resolve(branch: string, path: string): FileDocumentBinding | undefined } | null>(null)

/** Own one binding per document identity, including the replacement after an epoch reset. */
export function fileDocument(provider: import("../runtime/LiveDocProvider").LiveDocProvider, context: ActorContext = {}): FileDocumentBinding & { dispose(): void } {
  let current: { doc: Y.Doc; binding: ReturnType<typeof liveBinding> } | undefined
  return { provider,
    get binding() {
      if (current?.doc !== provider.doc) {
        current?.binding.dispose()
        current = { doc: provider.doc, binding: liveBinding(provider.doc, context, () => provider.editable) }
      }
      return current.binding
    },
    dispose() { current?.binding.dispose(); provider.dispose() }
  }
}
