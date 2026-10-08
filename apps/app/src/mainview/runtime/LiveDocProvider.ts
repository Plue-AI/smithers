import { z } from "zod"
import { actorColour } from "../cards/views/ActorChip"
import { ActorSchema, type Actor } from "@smthrs/rpc/CardPrimitives"
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { LiveDocId, LiveDocAwareness, parseLiveDocTopic } from "@smthrs/rpc/LiveDoc"
import * as Y from "yjs"
import { copyText, type CopyResult } from "@smthrs/ui/copy"
import * as sync from "y-protocols/sync"
import { Awareness, applyAwarenessUpdate } from "y-protocols/awareness"
import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"

/** Decoded by the authenticated channel owner, never from awareness or card payloads. */
export type DocumentEvent =
  | { kind: "authors"; actors: Record<string, Actor> }
  | { kind: "assigned"; epoch: string; clientId: number }
  | { kind: "sync"; payload: Uint8Array }
  | { kind: "awareness"; payload: Uint8Array }
  | { kind: "saved"; vector: Uint8Array; seq: number }
  | { kind: "offline" }
  | { kind: "refused" }

/** Existing-channel port. T-COL-08b owns the wire decoder; no implementation opens a socket here. */
export interface DocumentChannel {
  subscribeDocument(topic: string, receive: (event: DocumentEvent) => void, clientId?: number): { send(kind: 1 | 2, payload: Uint8Array): void; release(): void }
}
export interface DocumentPrerequisites {
  contract: boolean; actor: boolean; file: boolean; recovery: boolean; catalog: boolean; machine: boolean
}
const RecoveryRecord = z.object({ count: z.number().int().positive(), text: z.string(), base: z.string(), epoch: z.string().regex(/^[a-f0-9]{32}$/i).optional() }).strict()
export interface DocumentRecoveryStore {
  read(): unknown
  write(value: z.infer<typeof RecoveryRecord> | undefined): void
}
let nextDocument = 0
interface DocumentStatus { id: string; revision: number; editable: boolean; signature: string; saved: "saving" | "saved"; unsaved?: { count: number; text: string } | undefined }
interface Pending { bytes: Uint8Array; vector: Map<number, number>; seq?: number }
export interface DurableDocument { state: Uint8Array; clientId: number; epoch?: string; pending: Uint8Array[] }
export interface DocumentPersistence { initial?: DurableDocument; save(value: DurableDocument): Promise<void> }
const covered = (required: Map<number, number>, actual: Map<number, number>) =>
  [...required].every(([id, clock]) => (actual.get(id) ?? 0) >= clock)

/** One Yjs protocol adapter for code and wiki over the existing authenticated channel. */
export class LiveDocProvider {
  readonly collection = createCollection(localOnlyCollectionOptions({ id: `live-document-${++nextDocument}`, getKey: (row: DocumentStatus) => row.id }))
  authors: Readonly<Record<string, Actor>> = {}
  resolveActor(value: unknown): Actor | undefined {
    if (typeof value === "string" && this.authors[value]) return this.authors[value]
    if (value && typeof value === "object" && "id" in value && typeof value.id === "string" && this.authors[value.id]) return this.authors[value.id]
    try { const parsed = ActorSchema.safeParse(typeof value === "string" ? JSON.parse(value) : value); return parsed.success ? parsed.data : undefined } catch { return undefined }
  }
  doc = new Y.Doc()
  awareness = new Awareness(this.doc)
  readonly textName: "content" | "markdown"
  private epoch?: string
  private acknowledged = false
  private synced = false
  private assigned = false
  private disposed = false
  private subscription?: ReturnType<DocumentChannel["subscribeDocument"]>
  private pending: Pending[] = []
  private sentSeq = 0
  private awarenessTimer?: ReturnType<typeof setTimeout>
  private watchAwareness() { this.awareness.on("update", this.awarenessUpdated) }
  private awarenessUpdated = (_change: unknown, origin: unknown) => {
    if (origin === this.remote || !this.editable || this.awarenessTimer) return
    this.awarenessTimer = setTimeout(() => { this.awarenessTimer = undefined; this.sendAwareness() }, 50)
  }
  private sendAwareness() {
    if (!this.editable) return
    const state = this.awareness.getLocalState()
    if (!state?.actor || !state.colour || !state.line) return
    const cursor = state.cursor
    const reference = this.doc.getMap("authors").get(String(this.doc.clientID))
    const wire = { actor: typeof reference === "string" && /^[a-f0-9]{32}$/.test(reference) ? { kind: "person", id: reference, via: "app" } : state.actor, colour: state.colour, line: state.line, ...(cursor ? { anchor: Y.relativePositionToJSON(cursor.anchor), head: Y.relativePositionToJSON(cursor.head) } : {}) }
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 1); encoding.writeVarUint(encoder, this.doc.clientID)
    encoding.writeVarUint(encoder, this.awareness.meta.get(this.doc.clientID)?.clock ?? 0)
    encoding.writeVarString(encoder, JSON.stringify(wire))
    this.subscription?.send(2, encoding.toUint8Array(encoder))
  }
  private localClocks = new Map<number, number>()
  private savedClocks = new Map<number, number>()
  private recovery?: { count: number; text: string }
  private recoveryEpoch?: string
  private reapplying = false
  private recoveryBase = ""
  private beforeTransaction = (transaction: Y.Transaction) => {
    if (transaction.origin !== this.remote && !this.pending.length && !this.recovery) this.recoveryBase = this.doc.getText(this.textName).toString()
  }
  private readonly remote = {}
  private writing = false
  private nextWrite?: { value: DurableDocument; after: (() => void)[] }
  private readonly textListeners = new Set<() => void>()
  subscribeText(listener: () => void) { this.textListeners.add(listener); listener(); return () => { this.textListeners.delete(listener) } }
  private notifyText() { for (const listener of this.textListeners) { try { listener() } catch { /* A view cannot interrupt document processing. */ } } }
  private readonly persistence?: DocumentPersistence
  private readonly recoveryStore?: DocumentRecoveryStore
  constructor(topic: string, channel?: DocumentChannel, prerequisites?: DocumentPrerequisites, storage?: DocumentPersistence | DocumentRecoveryStore) {
    const persistence = storage && "save" in storage ? storage : undefined
    const recoveryStore = storage && "read" in storage ? storage : undefined
    this.persistence = persistence; this.recoveryStore = recoveryStore
    let contract: ReturnType<typeof parseLiveDocTopic> | undefined
    try { contract = parseLiveDocTopic(topic) } catch { /* Invalid topics stay dark. */ }
    this.textName = contract?.kind === "wiki" ? "markdown" : "content"
    this.doc.getText(this.textName)
    try {
      const stored = RecoveryRecord.safeParse(recoveryStore?.read())
      if (stored.success) { this.recovery = { count: stored.data.count, text: stored.data.text }; this.recoveryBase = stored.data.base }
    } catch { /* A failed local read never invents a saved receipt. */ }
    if (persistence?.initial) {
      const initial = persistence.initial
      Y.applyUpdate(this.doc, initial.state, this.remote)
      this.doc.clientID = initial.clientId; this.epoch = initial.epoch
      this.pending = initial.pending.map(bytes => ({ bytes, vector: new Map([[initial.clientId, Y.decodeStateVector(Y.encodeStateVector(this.doc)).get(initial.clientId) ?? 0]]) }))
    }
    this.publish()
    this.doc.on("beforeTransaction", this.beforeTransaction); this.doc.on("update", this.updated)
    this.watchAwareness()
    if (!channel || !prerequisites || ![prerequisites.contract, prerequisites.actor, prerequisites.file, prerequisites.recovery, prerequisites.catalog, prerequisites.machine].every(value => value === true)) return
    if (!contract) return
    this.subscription = channel.subscribeDocument(topic, event => this.receive(event), persistence?.initial?.clientId)
    if (this.assigned) this.restart()
  }
  comparison?: { version: string; text: string }
  revoke() { this.receive({ kind: "refused" }) }
  setComparison(value: { version: string; text: string }) { this.comparison = value; this.publish() }
  file?: import("@smthrs/rpc/FileCard").FileCard
  setFile(file: import("@smthrs/rpc/FileCard").FileCard | undefined) { this.file = file; if (this.comparison?.version !== "unsaved" && this.comparison?.version !== file?.outside?.version) this.comparison = undefined; this.publish() }
  get available() { return this.assigned && this.synced && !this.disposed }
  get editable() { return !this.file?.gone && this.available && !this.recovery }
  get saved(): "saving" | "saved" { return !this.acknowledged || this.pending.length || this.recovery || !covered(this.localClocks, this.savedClocks) ? "saving" : "saved" }
  get unsaved() { return this.recovery && { ...this.recovery } }
  private persistRecovery() {
    const retained = this.recovery ?? (this.pending.length ? { count: this.pending.length, text: this.doc.getText(this.textName).toString() } : undefined)
    try { this.recoveryStore?.write(retained ? { ...retained, base: this.recoveryBase, ...(this.epoch ? { epoch: this.epoch } : {}) } : undefined) }
    catch { /* Keep the in-memory buffer if its local recovery store is unavailable. */ }
  }
  private publish() {
    this.persistRecovery()
    const previous = this.collection.get("document")
    const signature = JSON.stringify([this.comparison, this.file, this.epoch, this.doc.clientID, [...this.doc.getMap("authors")], this.authors, [...this.awareness.getStates()]])
    const unsaved = this.unsaved
    if (previous?.editable === this.editable && previous.saved === this.saved && previous.signature === signature &&
      previous.unsaved?.count === unsaved?.count && previous.unsaved?.text === unsaved?.text) return
    const status: DocumentStatus = { id: "document", revision: (previous?.revision ?? 0) + 1,
      editable: this.editable, saved: this.saved, unsaved, signature }
    if (previous) this.collection.update(status.id, row => { Object.assign(row, status) })
    else this.collection.insert(status)
  }
  private updated = (bytes: Uint8Array, origin: unknown) => {
    if (this.disposed) return
    this.notifyText()
    if (origin === this.remote) { this.durable(); this.publish(); return }
    if (!this.assigned) {
      this.recovery = { count: (this.recovery?.count ?? 0) + 1, text: this.doc.getText(this.textName).toString() }
      this.publish(); return
    }
    this.localClocks.set(this.doc.clientID, Y.decodeStateVector(Y.encodeStateVector(this.doc)).get(this.doc.clientID) ?? 0)
    this.pending.push({ bytes: bytes.slice(), vector: new Map([[this.doc.clientID, Y.decodeStateVector(Y.encodeStateVector(this.doc)).get(this.doc.clientID) ?? 0]]) })
    const pending = this.pending.at(-1)!
    this.durable(() => { if (this.assigned) pending.seq = this.sendUpdate(bytes) })
    this.publish()
  }
  private durable(after?: () => void) {
    if (!this.persistence) { after?.(); return }
    const value: DurableDocument = { state: Y.encodeStateAsUpdate(this.doc), clientId: this.doc.clientID,
      ...(this.epoch === undefined ? {} : { epoch: this.epoch }), pending: this.pending.map(p => p.bytes.slice()) }
    // Remote snapshots can outrun storage. Persist the newest causal state
    // together, retaining every local send until a write containing it finishes.
    this.nextWrite = { value, after: [...(this.nextWrite?.after ?? []), ...(after ? [after] : [])] }
    if (this.writing) return
    this.writing = true
    void (async () => {
      try {
        while (this.nextWrite) {
          const write = this.nextWrite; this.nextWrite = undefined
          await this.persistence!.save(write.value)
          if (!this.disposed) for (const send of write.after) send()
        }
      } catch {
        this.nextWrite = undefined; this.assigned = false; this.retain(); this.publish()
      } finally { this.writing = false }
    })()
  }
  private sendUpdate(bytes: Uint8Array) {
    const encoder = encoding.createEncoder(); sync.writeUpdate(encoder, bytes)
    this.subscription?.send(1, encoding.toUint8Array(encoder))
    return ++this.sentSeq
  }
  private restart() {
    if (!this.assigned) return
    const encoder = encoding.createEncoder(); sync.writeSyncStep1(encoder, this.doc)
    this.subscription?.send(1, encoding.toUint8Array(encoder))
    for (const update of this.pending) this.durable(() => { if (this.assigned) update.seq = this.sendUpdate(update.bytes) })
  }
  private receive(event: DocumentEvent) {
    try { this.handle(event) } finally { if (!this.disposed) this.publish() }
  }
  private handle(event: DocumentEvent) {
    if (this.disposed) return
    if (event.kind === "offline") { this.durable(); return }
    if (event.kind === "refused") { this.assigned = false; this.retain(); this.durable(); return }
    if (event.kind === "assigned") {
      if (!/^[a-f0-9]{32}$/i.test(event.epoch) || !LiveDocId.safeParse(event.clientId).success) return
      if ((this.epoch !== undefined && this.epoch !== event.epoch) || (this.epoch === undefined && this.recovery) || (this.pending.length > 0 && this.doc.clientID !== event.clientId)) {
        this.retain(); this.pending = []; this.localClocks.clear(); this.savedClocks.clear(); this.acknowledged = false
        this.doc.off("beforeTransaction", this.beforeTransaction); this.doc.off("update", this.updated); this.awareness.destroy(); this.doc.destroy(); this.doc = new Y.Doc(); this.awareness = new Awareness(this.doc); this.doc.on("beforeTransaction", this.beforeTransaction); this.doc.on("update", this.updated)
      } else if (this.pending.some(update => update.vector.has(event.clientId)) && this.doc.clientID !== event.clientId) {
        // Assignment cannot reuse a client id already present in this replica.
        this.assigned = false; this.retain(); return
      }
      this.sentSeq = 0
      this.epoch = event.epoch; this.doc.clientID = event.clientId
      if (this.awareness.clientID !== event.clientId) { this.awareness.destroy(); this.awareness = new Awareness(this.doc) }
      this.awareness.off("update", this.awarenessUpdated)
      this.watchAwareness()
      this.assigned = true; this.synced = false; this.durable(); this.restart(); return
    }
    if (!this.assigned) return
    if (event.kind === "authors") { this.authors = event.actors; this.notifyText(); return }
    if (event.kind === "saved") {
      if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq > this.sentSeq) return
      try {
        const decoder = decoding.createDecoder(event.vector)
        const size = decoding.readVarUint(decoder), vector = new Map<number, number>()
        if (size > event.vector.length) return
        for (let i = 0; i < size; i++) {
          const client = decoding.readVarUint(decoder), clock = decoding.readVarUint(decoder)
          if (vector.has(client) || client > 0xffffffff) return
          vector.set(client, clock)
        }
        if (decoding.hasContent(decoder)) return
        for (const [id, clock] of vector) this.savedClocks.set(id, Math.max(this.savedClocks.get(id) ?? 0, clock))
        this.acknowledged = true
        this.pending = this.pending.filter(update => update.seq === undefined || update.seq > event.seq || !covered(update.vector, vector))
        if (!this.pending.length && (this.reapplying || this.recoveryEpoch === this.epoch)) { this.recovery = undefined; if (this.comparison?.version === "unsaved") this.comparison = undefined; this.recoveryEpoch = undefined; this.reapplying = false }
      this.durable()
      } catch { /* Malformed acknowledgment never saves edits. */ }
      return
    }
    if (event.kind === "awareness") {
      try {
        const decoder = decoding.createDecoder(event.payload), encoder = encoding.createEncoder()
        const count = decoding.readVarUint(decoder)
        if (count > 1000) return
        encoding.writeVarUint(encoder, count)
        for (let i = 0; i < count; i++) {
          const client = decoding.readVarUint(decoder), clock = decoding.readVarUint(decoder)
          const raw = JSON.parse(decoding.readVarString(decoder))
          if (raw !== null) { const actor = typeof raw.actor?.id === "string" ? this.authors[raw.actor.id] : undefined; if (actor) { raw.actor = actor; raw.colour = actorColour(actor) } }
          const parsed = raw === null ? undefined : LiveDocAwareness.extend({ actor: LiveDocAwareness.shape.actor.or(ActorSchema) }).safeParse(raw)
          if (raw !== null && !parsed?.success) return
          const state = parsed?.success ? parsed.data : null
          const projected = state?.anchor && state.head ? { ...state, cursor: { anchor: Y.createRelativePositionFromJSON(state.anchor), head: Y.createRelativePositionFromJSON(state.head) }, user: { name: "name" in state.actor ? state.actor.name : "login" in state.actor ? state.actor.login : "id" in state.actor ? state.actor.id : state.actor.kind, color: state.colour, colorLight: `color-mix(in srgb, ${state.colour} 20%, transparent)` } } : state
          encoding.writeVarUint(encoder, client); encoding.writeVarUint(encoder, clock); encoding.writeVarString(encoder, JSON.stringify(projected))
        }
        if (decoding.hasContent(decoder)) return
        applyAwarenessUpdate(this.awareness, encoding.toUint8Array(encoder), this.remote)
      } catch { /* Invalid awareness is inert. */ }
      return
    }
    if (event.kind === "sync") {
      try {
        const encoder = encoding.createEncoder()
        const kind = sync.readSyncMessage(decoding.createDecoder(event.payload), encoder, this.doc, this.remote)
        if (kind === sync.messageYjsSyncStep2) { this.synced = true; this.notifyText() }
        if (encoding.length(encoder) > 0) { this.subscription?.send(1, encoding.toUint8Array(encoder)) }
        this.durable()
      } catch { /* Untrusted frames cannot acknowledge or authorize edits. */ }
    }
  }
  private retain() {
    if (this.pending.length && !this.recovery) { this.recovery = { count: this.pending.length, text: this.doc.getText(this.textName).toString() }; this.recoveryEpoch = this.epoch }
  }
  /** Only a registered recovery handler may call this after authenticated assignment. */
  reapply() {
    if (!this.assigned || !this.synced || !this.recovery || this.reapplying) return false
    const text = this.doc.getText(this.textName), retained = this.recovery.text
    const base = this.recoveryBase, current = text.toString()
    let prefix = 0, suffix = 0
    while (prefix < base.length && prefix < retained.length && base[prefix] === retained[prefix]) prefix++
    while (suffix < base.length - prefix && suffix < retained.length - prefix && base[base.length - 1 - suffix] === retained[retained.length - 1 - suffix]) suffix++
    const removed = base.slice(prefix, base.length - suffix), inserted = retained.slice(prefix, retained.length - suffix)
    let offset = prefix, deleteLength = removed.length
    if (current === retained && current !== base) {
      // The recovered mirror already contains these characters. Reattribute only
      // the retained change so the new subscription obtains its own save receipt.
      deleteLength = inserted.length
      if (!inserted.length) { this.comparison = { version: "unsaved", text: retained }; this.publish(); return false }
    } else if (current !== base) {
      const before = base.slice(Math.max(0, prefix - 32), prefix), after = base.slice(base.length - suffix, base.length - suffix + 32)
      const anchor = before + removed + after
      const found = anchor ? current.indexOf(anchor) : current.length
      if (found < 0 || (anchor && current.indexOf(anchor, found + 1) >= 0)) {
        this.comparison = { version: "unsaved", text: retained }; this.publish(); return false
      }
      offset = found + before.length
    }
    this.reapplying = true
    this.comparison = undefined
    this.doc.transact(() => { text.delete(offset, deleteLength); text.insert(offset, inserted) })
    return true
  }
  async copy(write: (text: string) => Promise<CopyResult> = copyText) {
    const retained = this.recovery
    if (!retained) return false
    const copiedPending = this.reapplying ? [] : [...this.pending]
    const copied = await write(retained.text)
    if (!copied.ok) return false
    if (this.recovery === retained) { this.recovery = undefined; if (this.comparison?.version === "unsaved") this.comparison = undefined; this.recoveryEpoch = undefined; this.reapplying = false; this.pending = this.pending.filter(update => !copiedPending.includes(update)) }
    this.publish()
    return true
  }
  setLine(line: number, colour: string) {
    if (!this.editable || !Number.isSafeInteger(line) || line < 1 || colour.length > 64) return false
    const reference = this.doc.getMap("authors").get(String(this.doc.clientID))
    const actor = typeof reference === "string" ? this.resolveActor(reference) : reference
    if (!actor) return false
    const current = this.awareness.getLocalState()
    if (current?.line !== line || current.colour !== colour || JSON.stringify(current.actor) !== JSON.stringify(actor)) this.awareness.setLocalState({ ...current, actor, colour, line })
    return true
  }
  dispose() {
    if (this.disposed) return
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer)
    this.retain(); this.assigned = false; this.disposed = true; this.subscription?.release(); this.textListeners.clear()
    this.doc.off("beforeTransaction", this.beforeTransaction); this.doc.off("update", this.updated); this.awareness.destroy(); this.publish()
    // Keep the document/recovery text for its owner; disposal never discards unacknowledged edits.
  }
}
