/**
 * Deterministic in-memory socket transport for sync tests.
 *
 * @since 0.1.0
 */

import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Latch from "effect/Latch"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import * as Socket from "effect/unstable/socket/Socket"

/**
 * A predicate or byte transformation installed between the two socket ends.
 * Returning `false` drops the frame.
 *
 * @category models
 * @since 0.1.0
 */
export type FrameFilter = (bytes: Uint8Array) => boolean | Uint8Array

/**
 * Deterministic transport failures that can be injected into a test socket pair.
 *
 * `dropRange` recognizes the JSON representation of an `Entries` frame without
 * importing the sync protocol. Tests using another wire representation can use
 * `installFilter` directly.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestFaults {
  readonly installFilter: (filter: FrameFilter) => void
  readonly dropRange: (runId: string, from: number, to: number) => void
  readonly stall: () => void
  readonly resume: () => void
  readonly disconnect: () => Effect.Effect<void>
}

/**
 * The two endpoints and controls of an in-memory socket connection.
 *
 * @category models
 * @since 0.1.0
 */
export interface Pair {
  readonly client: Socket.Socket
  readonly server: Socket.Socket
  readonly faults: TestFaults
}

const queueCapacity = 16

const transportError = () =>
  new Socket.SocketError({
    reason: new Socket.SocketReadError({ cause: new Error("test socket disconnected") })
  })

const intersects = (leftFrom: number, leftTo: number, rightFrom: number, rightTo: number) =>
  leftFrom <= rightTo && rightFrom <= leftTo

const entriesRange = (
  bytes: Uint8Array
): { readonly runId: string; readonly from: number; readonly to: number } | undefined => {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return findEntriesRange(value)
  } catch {
    return undefined
  }
}

const findEntriesRange = (
  value: unknown
): { readonly runId: string; readonly from: number; readonly to: number } | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Readonly<Record<string, unknown>>
  if (
    record["_tag"] === "Entries" &&
    typeof record["runId"] === "string" &&
    typeof record["fromSeq"] === "number" &&
    typeof record["toSeq"] === "number"
  ) {
    return { runId: record["runId"], from: record["fromSeq"], to: record["toSeq"] }
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const element of child) {
        const result = findEntriesRange(element)
        if (result !== undefined) return result
      }
    } else {
      const result = findEntriesRange(child)
      if (result !== undefined) return result
    }
  }
  return undefined
}

/**
 * Creates a scoped, bounded, bidirectional in-memory socket connection.
 *
 * Socket runs wait on queue reads and are therefore interrupted with their
 * enclosing scope; no host abort signal or timer is involved.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makePair = (): Effect.Effect<Pair, never, Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const clientIncoming = yield* Queue.bounded<Uint8Array, Socket.SocketError>(queueCapacity)
    const serverIncoming = yield* Queue.bounded<Uint8Array, Socket.SocketError>(queueCapacity)
    yield* Scope.addFinalizer(
      scope,
      Effect.all([Queue.shutdown(clientIncoming), Queue.shutdown(serverIncoming)], { discard: true })
    )
    const delivery = Latch.makeUnsafe(true)
    const filters: Array<FrameFilter> = []

    const offer = (queue: Queue.Queue<Uint8Array, Socket.SocketError>, bytes: Uint8Array) =>
      Effect.suspend(() => {
        let current = bytes
        for (const filter of filters) {
          const result = filter(current)
          if (typeof result === "boolean") {
            if (result === false) return Effect.void
          } else {
            current = result
          }
        }
        return Queue.offer(queue, current).pipe(Effect.asVoid)
      })

    const socket = (
      incoming: Queue.Queue<Uint8Array, Socket.SocketError>,
      outgoing: Queue.Queue<Uint8Array, Socket.SocketError>
    ) => {
      const write: Socket.Writer["write"] = (chunk) => {
        if (Socket.isCloseEvent(chunk)) return Effect.void
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
        return offer(outgoing, bytes)
      }
      return Socket.make({
        reader: Effect.gen(function*() {
          const closed = yield* Deferred.make<never, Socket.SocketError>()
          yield* Effect.addFinalizer(() => Deferred.fail(closed, transportError()))
          return {
            pull: Effect.raceFirst(
              Effect.map(delivery.whenOpen(Queue.take(incoming)), (bytes) => [bytes] as const),
              Deferred.await(closed)
            ),
            upgrade: Socket.SocketUpgradeError.unsupported
          }
        }),
        writer: Effect.succeed({
          write,
          writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true })
        })
      })
    }

    const faults: TestFaults = {
      installFilter: (filter) => {
        filters.push(filter)
      },
      dropRange: (runId, from, to) => {
        filters.push((bytes) => {
          const range = entriesRange(bytes)
          return range === undefined || range.runId !== runId || !intersects(range.from, range.to, from, to)
        })
      },
      stall: () => {
        delivery.closeUnsafe()
      },
      resume: () => {
        delivery.openUnsafe()
      },
      disconnect: () =>
        Effect.andThen(
          Queue.fail(clientIncoming, transportError()),
          Queue.fail(serverIncoming, transportError())
        ).pipe(Effect.asVoid)
    }

    return {
      client: socket(clientIncoming, serverIncoming),
      server: socket(serverIncoming, clientIncoming),
      faults
    }
  })
