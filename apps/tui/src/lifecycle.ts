/**
 * The background-work lifecycle that worker tabs (`workspace.ts`) and flow
 * runs (`flows.ts`) share: one state machine, a seat pool with a FIFO queue,
 * and persist-first records.
 *
 * A store names what happened (`Event`); `step` decides the next status, and
 * the `Pool` writes it: persist first, then remember, then notify, then start
 * queued work when the write freed a seat. Each store keeps what is its own
 * (worker files and park budgets, flow attempts and the control plane).
 */
import * as Log from "./log.ts"

export type Status =
  | "queued"
  | "requested"
  | "input"
  | "running"
  | "waiting"
  | "parked"
  | "done"
  | "failed"
  | "cancelled"

export const statuses: ReadonlyArray<Status> = [
  "queued",
  "requested",
  "input",
  "running",
  "waiting",
  "parked",
  "done",
  "failed",
  "cancelled"
]

export type Event =
  /** A queued request got a seat. */
  | "admit"
  /** Work began. A worker that parked while it launched stays parked. */
  | "launch"
  /** The work needs input from the user (flow runs). */
  | "input"
  /** The user supplied the input. */
  | "fill"
  /** It waits on something else: an approval, or its own children. */
  | "block"
  | "unblock"
  /** A provider refused for capacity; the work waits for a reset. */
  | "park"
  /** The reset came: it continues, or waits FIFO for a seat when all are taken. */
  | "wake"
  /** A failed worker waits for its known reset by the user's choice. */
  | "sleep"
  /** A failed or stopped run starts again, or waits for a seat. */
  | "retry"
  /** A failed or stopped run follows its existing remote run again. */
  | "reattach"
  /** Outcomes. They always win: the work reported how it ended. */
  | "done"
  | "fail"
  | "cancel"

export const events: ReadonlyArray<Event> = [
  "admit",
  "launch",
  "input",
  "fill",
  "block",
  "unblock",
  "park",
  "wake",
  "sleep",
  "retry",
  "reattach",
  "done",
  "fail",
  "cancel"
]

/** The event a reported outcome is. */
export const ending = { done: "done", failed: "fail", cancelled: "cancel" } as const satisfies Record<string, Event>

/** Settled work: nothing runs or waits. */
export const settled = (status: Status): boolean => status === "done" || status === "failed" || status === "cancelled"

/**
 * The next status after `event`, or undefined when the event does not apply
 * in `status`. `full` is whether every seat is taken.
 */
export const step = (status: Status, event: Event, full: boolean): Status | undefined => {
  switch (event) {
    case "admit":
      return status === "queued" ? "requested" : undefined
    case "launch":
      return status === "requested" ? "running" : status === "parked" ? "parked" : undefined
    case "input":
      return status === "requested" ? "input" : undefined
    case "fill":
      return status === "input" ? "requested" : undefined
    case "block":
      return status === "running" || status === "waiting" ? "waiting" : undefined
    case "unblock":
      return status === "running" || status === "waiting" ? "running" : undefined
    case "park":
      return status === "queued" || status === "requested" || status === "running" || status === "waiting" ||
          status === "parked"
        ? "parked"
        : undefined
    case "wake":
      return status === "parked" ? (full ? "queued" : "running") : status === "queued" ? "running" : undefined
    case "sleep":
      return status === "failed" ? "parked" : undefined
    case "retry":
      return status === "failed" || status === "cancelled" ? (full ? "queued" : "requested") : undefined
    case "reattach":
      return status === "failed" || status === "cancelled" ? "running" : undefined
    case "done":
      return "done"
    case "fail":
      return "failed"
    case "cancel":
      return "cancelled"
  }
}

/** The status a new request gets. */
export const admission = (full: boolean): Status => (full ? "queued" : "requested")

interface Item {
  readonly id: string
  readonly status: Status
}

/**
 * Records by id, a fixed number of seats, and a FIFO queue of work waiting
 * for one. `E` is what a queued entry carries back to the store when it is
 * admitted.
 */
export class Pool<T extends Item, E = undefined> {
  private records = new Map<string, T>()
  /** Insertion order is the queue order; enqueueing an id again moves it to the back. */
  private queue = new Map<string, E>()
  private listeners = new Set<() => void>()
  private closed = false
  constructor(
    private options: {
      readonly seats: number
      /** Which statuses hold a seat. */
      readonly holdsSeat: (record: T) => boolean
      /** Writes the record durably; runs before the record is remembered. */
      readonly persist: (record: T) => void
      /** Starts a queued record that got a seat. */
      readonly admit: (record: T, entry: E) => void
      /** Where an illegal transition is reported. */
      readonly name: string
    }
  ) {}

  get = (id: string): T | undefined => this.records.get(id)
  has = (id: string): boolean => this.records.has(id)
  values = (): ReadonlyArray<T> => [...this.records.values()]
  /** Every seat is taken. */
  full = (): boolean => this.values().filter(this.options.holdsSeat).length >= this.options.seats

  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  changed = (): void => {
    for (const listener of this.listeners) listener()
  }

  /** Remembers a restored record without writing it. */
  adopt = (record: T): void => {
    this.records.set(record.id, record)
  }
  /** Drops a record without writing; a retry re-creates it. */
  forget = (id: string): void => {
    this.records.delete(id)
  }

  /** Persists a new request as `queued` or `requested` by seat. */
  create = (record: Omit<T, "status">): T => {
    const created = { ...record, status: admission(this.full()) } as T
    this.save(created)
    return created
  }
  /** Writes `record` with the status `event` leads to; undefined when the event does not apply. */
  move = (record: T, event: Event): T | undefined => {
    const status = step(record.status, event, this.full())
    if (status === undefined) {
      Log.write(
        `${this.options.name}.transition`,
        new Error(`${event} does not apply to ${record.id} in ${record.status}`)
      )
      return undefined
    }
    const next = { ...record, status } as T
    this.save(next)
    return next
  }
  /** Writes a change that keeps the status. */
  put = (record: T): T => {
    this.save(record)
    return record
  }

  /** Queues `id` to start when a seat frees. */
  enqueue = (id: string, entry: E): void => {
    this.queue.delete(id)
    this.queue.set(id, entry)
  }
  /** Removes `id` from the queue and returns what it carried. */
  dequeue = (id: string): E | undefined => {
    if (!this.queue.has(id)) return undefined
    const entry = this.queue.get(id) as E
    this.queue.delete(id)
    return entry
  }
  /** Stops admitting work and returns everything still queued. */
  close = (): ReadonlyArray<E> => {
    this.closed = true
    const entries = [...this.queue.values()]
    this.queue.clear()
    return entries
  }
  /** Starts queued records, oldest first, while a seat is free. */
  drain = (): void => {
    for (const [id, entry] of this.queue) {
      if (this.closed || this.full()) return
      this.queue.delete(id)
      const record = this.records.get(id)
      if (record?.status !== "queued") continue
      this.options.admit(record, entry)
    }
  }

  private save(record: T) {
    this.options.persist(record)
    this.records.set(record.id, record)
    this.changed()
    if (!this.options.holdsSeat(record) && record.status !== "queued") this.drain()
  }
}
