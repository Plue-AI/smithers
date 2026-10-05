import { decodeLiveDocBinary, encodeLiveDocBinary, LiveDocReply, parseLiveDocTopic } from "@smthrs/rpc/LiveDoc"
import type { DocumentEvent } from "./LiveDocProvider"
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"

export interface TopicSnapshot<T = unknown> {
  readonly topic: string
  readonly data?: T
  readonly cursor?: number
  readonly error?: string
}
export interface LiveSocket {
  binaryType?: string
  readyState: number
  onopen: (() => void) | null
  onclose: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  send(data: string | Uint8Array): void
  close(): void
}
export interface LiveChannelOptions {
  /** Carry `doc:` topics and their binary frames. The browser channel enables it; off, documents refuse locally as unsupported. */
  documentFrames?: boolean
  socket?: () => LiveSocket
  random?: () => number
  schedule?: (callback: () => void, ms: number) => unknown
  cancel?: (timer: unknown) => void
  /** Topic owners supply their delta reducer; an unknown delta never guesses state. */
  project?: (topic: string, previous: unknown, delta: unknown) => unknown
}


/** One transport, reference-counted topics, and committed projection rows. */
export class LiveChannel {
  readonly collection = createCollection(localOnlyCollectionOptions({
    id: "live-topics", getKey: (row: TopicSnapshot) => row.topic
  }))
  private readonly topics = new Map<string, { id: number; listeners: Set<() => void>; snapshot: TopicSnapshot; awaitingSnapshot: boolean }>()
  private readonly projectors = new Map<string, (previous: unknown, delta: unknown) => unknown>()
  /** Register the publishing topic's decoder before its consumers subscribe. */
  registerProjection(topic: string, project: (previous: unknown, delta: unknown) => unknown): void {
    const existing = this.projectors.get(topic)
    if (existing && existing !== project) throw new Error(`Projection already registered: ${topic}`)
    this.projectors.set(topic, project)
  }
  private socket?: LiveSocket
  private timer?: unknown
  private nextId = 1
  private attempt = 0
  private disposed = false
  constructor(private readonly options: LiveChannelOptions = {}) {}
  private readonly documents = new Map<string, Set<(event: DocumentEvent) => void>>()
  private isDarkTopic(topic: string) { return topic.startsWith("doc:") && !this.options.documentFrames }
  subscribeDocument(topic: string, receive: (event: DocumentEvent) => void) {
    if (this.disposed) { receive({ kind: "refused" }); return { send() {}, release() {} } }
    try { parseLiveDocTopic(topic) } catch {
      receive({ kind: "refused" }); return { send() {}, release() {} }
    }
    const listeners = this.documents.get(topic) ?? new Set<(event: DocumentEvent) => void>()
    this.documents.set(topic, listeners); listeners.add(receive)
    const notify = () => {
      const snapshot = this.getSnapshot(topic)
      if (snapshot?.error) receive({ kind: "refused" })
      else if (snapshot?.data) {
        const result = LiveDocReply.safeParse({ t: "snap", id: this.topics.get(topic)?.id, cursor: snapshot.cursor, data: snapshot.data })
        if (result.success && result.data.t === "snap") receive({ kind: "assigned", epoch: result.data.data.epoch, clientId: result.data.data.client_id })
      }
    }
    const unsubscribe = this.subscribe(topic, notify)
    if (this.getSnapshot(topic)?.data) notify()
    let released = false
    return {
      send: (kind: 1 | 2, payload: Uint8Array) => {
        const entry = this.topics.get(topic)
        if (this.disposed || released || this.isDarkTopic(topic) || !entry || entry.awaitingSnapshot || entry.snapshot.error || this.socket?.readyState !== 1) return
        try { this.socket.send(encodeLiveDocBinary({ kind, id: entry.id, payload })) } catch { /* Refused/malformed sends have no effect. */ }
      },
      release: () => {
        if (released) return
        released = true; listeners.delete(receive)
        if (!listeners.size) this.documents.delete(topic)
        unsubscribe()
      }
    }
  }
  private documentEvent(topic: string, event: DocumentEvent) {
    for (const receive of this.documents.get(topic) ?? []) receive(event)
  }
  getSnapshot = (topic: string): TopicSnapshot | undefined => this.topics.get(topic)?.snapshot
  subscribe = (topic: string, listener: () => void): (() => void) => {
    if (this.disposed) throw new Error("Live channel disposed")
    let entry = this.topics.get(topic)
    if (!entry) {
      entry = { id: this.nextId++, listeners: new Set(), snapshot: { topic }, awaitingSnapshot: true }
      this.topics.set(topic, entry)
      if (this.socket?.readyState === 1) this.sub(topic, entry)
    }
    // Each subscription owns a distinct token, even when callbacks are identical.
    const notify = () => listener()
    entry.listeners.add(notify)
    // T-COL-08: no code-document transport until the real providers and checks
    // are connected. This replaces speculative subscription with a refusal.
    if (this.isDarkTopic(topic)) {
      if (entry.snapshot.error !== "unsupported") this.publish(topic, entry, { topic, error: "unsupported" })
    } else this.connect()
    let released = false
    return () => {
      if (released) return
      released = true
      entry.listeners.delete(notify)
      if (entry.listeners.size) return
      if (!this.isDarkTopic(topic) && this.socket?.readyState === 1) this.send({ t: "unsub", id: entry.id })
      this.topics.delete(topic)
      if (this.collection.has(topic)) this.collection.delete(topic)
      if (!this.hasTransportTopics()) this.disconnect()
    }
  }
  private send(frame: unknown) { this.socket?.send(JSON.stringify(frame)) }
  private sub(topic: string, entry: { id: number; snapshot: TopicSnapshot; awaitingSnapshot: boolean }) {
    if (this.isDarkTopic(topic)) return
    this.send({ t: "sub", id: entry.id, topic, ...(entry.awaitingSnapshot || entry.snapshot.cursor === undefined ? {} : { cursor: entry.snapshot.cursor }) })
  }
  private hasTransportTopics() { return [...this.topics.keys()].some(topic => !this.isDarkTopic(topic)) }
  private connect() {
    if (this.socket || this.timer !== undefined || !this.hasTransportTopics() || this.disposed) return
    try {
      const socket = this.options.socket?.() ?? new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/live`, "smithers.live.v1") as unknown as LiveSocket
      this.socket = socket
      socket.binaryType = "arraybuffer"
      socket.onopen = () => {
        if (this.socket !== socket) return
        this.attempt = 0
        for (const [topic, entry] of this.topics) this.sub(topic, entry)
      }
      socket.onmessage = event => { if (this.socket === socket) this.receive(event.data) }
      socket.onclose = () => {
        if (this.socket !== socket) return
        this.socket = undefined
        for (const [topic, entry] of this.topics) if (topic.startsWith("doc:")) entry.awaitingSnapshot = true
        this.retry()
      }
    } catch { this.retry() }
  }
  private retry() {
    if (!this.hasTransportTopics() || this.disposed) return
    const cap = Math.min(5000, 250 * 2 ** Math.min(this.attempt++, 5))
    const delay = Math.max(250, Math.min(5000, cap * (0.5 + (this.options.random ?? Math.random)() / 2)))
    this.timer = (this.options.schedule ?? setTimeout)(() => { this.timer = undefined; this.connect() }, delay)
  }
  private receive(raw: unknown) {
    if (typeof raw !== "string") {
      try {
        const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw instanceof Uint8Array ? raw : undefined
        if (!bytes) return
        const frame = decodeLiveDocBinary(bytes)
        const pair = [...this.topics].find(([, entry]) => entry.id === frame.id)
        if (!pair || !pair[0].startsWith("doc:") || this.isDarkTopic(pair[0]) || pair[1].awaitingSnapshot || pair[1].snapshot.error) return
        this.documentEvent(pair[0], { kind: frame.kind === 1 ? "sync" : "awareness", payload: frame.payload })
      } catch { /* Invalid binary frames are inert. */ }
      return
    }
    let frame: Record<string, unknown>
    try { frame = JSON.parse(raw) } catch { return }
    if (!frame || typeof frame !== "object") return
    const pair = [...this.topics].find(([, entry]) => entry.id === frame.id)
    if (!pair) return
    const [topic, entry] = pair
    if (this.isDarkTopic(topic)) return
    if (topic.startsWith("doc:")) {
      const result = LiveDocReply.safeParse(frame)
      if (!result.success) return
      const reply = result.data
      if (reply.t === "saved") {
        if (entry.awaitingSnapshot || entry.snapshot.error) return
        try { this.documentEvent(topic, { kind: "saved", vector: Uint8Array.from(atob(reply.sv), char => char.charCodeAt(0)) }) } catch { /* Malformed vectors never save. */ }
        return
      }
      if (reply.t === "gap") {
        if (!entry.awaitingSnapshot && !entry.snapshot.error) this.documentEvent(topic, { kind: "restart" })
        return
      }
    }
    if (frame.t === "gap") {
      entry.awaitingSnapshot = true
      this.send({ t: "sub", id: entry.id, topic })
      return
    }
    if (frame.t === "err" && typeof frame.code === "string") {
      entry.awaitingSnapshot = true
      this.publish(topic, entry, { topic, error: frame.code })
      return
    }
    if (frame.t !== "snap" && frame.t !== "delta") return
    if (!("data" in frame)) return
    if (!Number.isSafeInteger(frame.cursor) || (frame.cursor as number) < 0) return
    const cursor = frame.cursor as number
    if (entry.snapshot.cursor !== undefined && cursor <= entry.snapshot.cursor && !(frame.t === "snap" && entry.awaitingSnapshot && cursor === entry.snapshot.cursor)) return
    if (frame.t === "delta" && entry.awaitingSnapshot) return
    const project = this.projectors.get(topic) ?? (this.options.project ? (previous: unknown, delta: unknown) => this.options.project!(topic, previous, delta) : undefined)
    if (frame.t === "delta" && !project) {
      entry.awaitingSnapshot = true
      this.send({ t: "sub", id: entry.id, topic })
      return
    }
    let data: unknown
    try { data = frame.t === "snap" ? frame.data : project!(entry.snapshot.data, frame.data) }
    catch { entry.awaitingSnapshot = true; this.send({ t: "sub", id: entry.id, topic }); return }
    entry.awaitingSnapshot = false
    this.publish(topic, entry, { topic, cursor, data })
  }
  private publish(topic: string, entry: { snapshot: TopicSnapshot; listeners: Set<() => void> }, snapshot: TopicSnapshot) {
    entry.snapshot = snapshot
    if (this.collection.has(topic)) this.collection.update(topic, row => { Object.assign(row, snapshot); if (!("data" in snapshot)) row.data = undefined; if (snapshot.cursor === undefined) row.cursor = undefined; if (!snapshot.error) row.error = undefined })
    else this.collection.insert(snapshot)
    for (const listener of entry.listeners) listener()
  }
  private disconnect() {
    if (this.timer !== undefined) (this.options.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>)))(this.timer)
    this.timer = undefined
    const socket = this.socket
    this.socket = undefined
    if (socket) { socket.onopen = null; socket.onclose = null; socket.onmessage = null; socket.close() }
    this.attempt = 0
  }
  dispose() { this.disposed = true; for (const topic of this.documents.keys()) this.documentEvent(topic, { kind: "refused" }); this.disconnect(); this.topics.clear(); this.documents.clear(); this.collection.cleanup() }
}

/** The browser tab's channel carries code documents; the backend refuses any it cannot serve (err unsupported). */
export const browserChannelOptions: LiveChannelOptions = { documentFrames: true }
/** Lazy module singleton: exactly one channel for the browser tab. */
let browserChannel: LiveChannel | undefined
export const liveChannel = (): LiveChannel => browserChannel ??= new LiveChannel(browserChannelOptions)
