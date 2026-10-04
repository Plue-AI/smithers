import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { LiveDocId, parseLiveDocTopic } from "@smthrs/rpc/LiveDoc"
import * as Y from "yjs"
import { copyText, type CopyResult } from "@smthrs/ui/copy"
import * as sync from "y-protocols/sync"
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness"
import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"

/** Decoded by the authenticated channel owner, never from awareness or card payloads. */
export type DocumentEvent =
  | { kind: "assigned"; epoch: string; clientId: number }
  | { kind: "sync"; payload: Uint8Array }
  | { kind: "awareness"; payload: Uint8Array }
  | { kind: "saved"; vector: Uint8Array }
  | { kind: "restart" }
  | { kind: "refused" }

/** Existing-channel port. T-COL-08b owns the wire decoder; no implementation opens a socket here. */
export interface DocumentChannel {
  subscribeDocument(topic: string, receive: (event: DocumentEvent) => void): { send(kind: 1 | 2, payload: Uint8Array): void; release(): void }
}
export interface DocumentPrerequisites {
  contract: boolean; actor: boolean; file: boolean; recovery: boolean; catalog: boolean; machine: boolean
}
let nextDocument = 0
interface DocumentStatus { id: string; revision: number; editable: boolean; signature: string; saved: "saving" | "saved"; unsaved?: { count: number; text: string } | undefined }
interface Pending { bytes: Uint8Array; vector: Map<number, number> }
const covered = (required: Map<number, number>, actual: Map<number, number>) =>
  [...required].every(([id, clock]) => (actual.get(id) ?? 0) >= clock)

/** One Yjs protocol adapter for code and wiki. No production caller supplies the unlanded channel port. */
export class LiveDocProvider {
  readonly collection = createCollection(localOnlyCollectionOptions({ id: `live-document-${++nextDocument}`, getKey: (row: DocumentStatus) => row.id }))
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
  private localClocks = new Map<number, number>()
  private savedClocks = new Map<number, number>()
  private recovery?: { count: number; text: string }
  private recoveryEpoch?: string
  private reapplying = false
  private readonly remote = {}
  constructor(topic: string, channel?: DocumentChannel, prerequisites?: DocumentPrerequisites) {
    let contract: ReturnType<typeof parseLiveDocTopic> | undefined
    try { contract = parseLiveDocTopic(topic) } catch { /* Invalid topics stay dark. */ }
    this.textName = contract?.kind === "wiki" ? "markdown" : "content"
    this.doc.getText(this.textName)
    this.publish()
    this.doc.on("update", this.updated)
    if (!channel || !prerequisites || ![prerequisites.contract, prerequisites.actor, prerequisites.file, prerequisites.recovery, prerequisites.catalog, prerequisites.machine].every(value => value === true)) return
    if (!contract) return
    this.subscription = channel.subscribeDocument(topic, event => this.receive(event))
    if (this.assigned) this.restart()
  }
  get editable() { return this.assigned && this.synced && !this.disposed && !this.recovery }
  get saved(): "saving" | "saved" { return !this.acknowledged || this.pending.length || this.recovery || !covered(this.localClocks, this.savedClocks) ? "saving" : "saved" }
  get unsaved() { return this.recovery && { ...this.recovery } }
  private publish() {
    const previous = this.collection.get("document")
    const signature = JSON.stringify([this.epoch, this.doc.clientID, [...this.doc.getMap("authors")], [...this.awareness.getStates()]])
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
    if (origin === this.remote) { this.publish(); return }
    if (!this.assigned) {
      this.recovery = { count: (this.recovery?.count ?? 0) + 1, text: this.doc.getText(this.textName).toString() }
      this.publish(); return
    }
    this.localClocks.set(this.doc.clientID, Y.decodeStateVector(Y.encodeStateVector(this.doc)).get(this.doc.clientID) ?? 0)
    this.pending.push({ bytes: bytes.slice(), vector: new Map([[this.doc.clientID, Y.decodeStateVector(Y.encodeStateVector(this.doc)).get(this.doc.clientID) ?? 0]]) })
    if (this.assigned) this.sendUpdate(bytes)
    this.publish()
  }
  private sendUpdate(bytes: Uint8Array) {
    const encoder = encoding.createEncoder(); sync.writeUpdate(encoder, bytes)
    this.subscription?.send(1, encoding.toUint8Array(encoder))
  }
  private restart() {
    if (!this.assigned) return
    const encoder = encoding.createEncoder(); sync.writeSyncStep1(encoder, this.doc)
    this.subscription?.send(1, encoding.toUint8Array(encoder))
    for (const update of this.pending) this.sendUpdate(update.bytes)
  }
  private receive(event: DocumentEvent) {
    try { this.handle(event) } finally { if (!this.disposed) this.publish() }
  }
  private handle(event: DocumentEvent) {
    if (this.disposed) return
    if (event.kind === "refused") { this.assigned = false; this.retain(); return }
    if (event.kind === "assigned") {
      if (!/^[a-f0-9]{32}$/i.test(event.epoch) || !LiveDocId.safeParse(event.clientId).success) return
      if ((this.epoch !== undefined && this.epoch !== event.epoch) || (this.epoch === undefined && this.recovery)) {
        this.retain(); this.pending = []; this.localClocks.clear(); this.savedClocks.clear(); this.acknowledged = false
        this.doc.off("update", this.updated); this.awareness.destroy(); this.doc.destroy(); this.doc = new Y.Doc(); this.awareness = new Awareness(this.doc); this.doc.on("update", this.updated)
      } else if (this.pending.some(update => update.vector.has(event.clientId)) && this.doc.clientID !== event.clientId) {
        // Assignment cannot reuse a client id already present in this replica.
        this.assigned = false; this.retain(); return
      }
      this.epoch = event.epoch; this.doc.clientID = event.clientId
      if (this.awareness.clientID !== event.clientId) { this.awareness.destroy(); this.awareness = new Awareness(this.doc) }
      this.assigned = true; this.synced = false; this.restart(); return
    }
    if (!this.assigned) return
    if (event.kind === "restart") { this.restart(); return }
    if (event.kind === "saved") {
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
        this.pending = this.pending.filter(update => !covered(update.vector, vector))
        if (!this.pending.length && (this.reapplying || this.recoveryEpoch === this.epoch)) { this.recovery = undefined; this.recoveryEpoch = undefined; this.reapplying = false }
      } catch { /* Malformed acknowledgment never saves edits. */ }
      return
    }
    if (event.kind === "awareness") {
      try { applyAwarenessUpdate(this.awareness, event.payload, this.remote) } catch { /* Invalid awareness is inert. */ }
      return
    }
    if (event.kind === "sync") {
      try {
        const encoder = encoding.createEncoder()
        const kind = sync.readSyncMessage(decoding.createDecoder(event.payload), encoder, this.doc, this.remote)
        if (kind === sync.messageYjsSyncStep2) this.synced = true
        if (encoding.length(encoder) > 0) this.subscription?.send(1, encoding.toUint8Array(encoder))
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
    this.reapplying = true
    this.doc.transact(() => { text.delete(0, text.length); text.insert(0, retained) })
    return true
  }
  async copy(write: (text: string) => Promise<CopyResult> = copyText) {
    const retained = this.recovery
    if (!retained) return false
    const copiedPending = this.reapplying ? [] : [...this.pending]
    const copied = await write(retained.text)
    if (!copied.ok) return false
    if (this.recovery === retained) { this.recovery = undefined; this.recoveryEpoch = undefined; this.reapplying = false; this.pending = this.pending.filter(update => !copiedPending.includes(update)) }
    this.publish()
    return true
  }
  setLine(line: number, colour: string) {
    if (!this.editable || !Number.isSafeInteger(line) || line < 1 || colour.length > 64) return false
    const actor = this.doc.getMap("authors").get(String(this.doc.clientID))
    if (!actor) return false
    this.awareness.setLocalState({ actor, colour, line })
    this.subscription?.send(2, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]))
    return true
  }
  dispose() {
    if (this.disposed) return
    this.retain(); this.assigned = false; this.disposed = true; this.subscription?.release()
    this.doc.off("update", this.updated); this.awareness.destroy(); this.publish()
    // Keep the document/recovery text for its owner; disposal never discards unacknowledged edits.
  }
}
