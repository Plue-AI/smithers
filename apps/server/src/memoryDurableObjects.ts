import * as Effect from "effect/Effect"
import { runDurable } from "./Boundary"
import type { NativeNamespace, NativeStorage } from "./DurableStorage"
import { memoryStorage } from "./DurableStorage"
import { TurnCancelRegistry } from "./turns"

/*
 * Test fixture: the Worker's required Durable Object binding driven through
 * the REAL native class over fresh in-memory storage, so tests exercise the
 * deployed code path — registry state, serialization, per-name isolation —
 * instead of a test-only twin. Nothing in the Worker imports this.
 */

/** Every stub's `fetch` is the native Durable Object boundary. */
export const memoryDurableObjects = () => {
  const cancelData = new Map<string, Map<string, unknown>>()
  const cancelObjects = new Map<string, TurnCancelRegistry>()
  const cancelAlarms = new Map<string, number>()
  const retained = (maps: Map<string, Map<string, unknown>>, name: string): Map<string, unknown> => {
    let data = maps.get(name)
    if (data === undefined) {
      data = new Map()
      maps.set(name, data)
    }
    return data
  }
  // The fixture's map IS the object's storage: recreating the object (a
  // Worker restart) keeps the rows, like a Durable Object keeps its SQLite.
  const nativeStorageOver = (data: Map<string, unknown>): NativeStorage => memoryStorage(undefined, data)
  const TURN_CANCELS: NativeNamespace = {
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let object = cancelObjects.get(name)
      if (object === undefined) {
        object = new TurnCancelRegistry({ storage: { ...nativeStorageOver(retained(cancelData, name)),
          setAlarm: time => { cancelAlarms.set(name, time); return Promise.resolve() } } })
        cancelObjects.set(name, object)
      }
      const registry = object
      return { fetch: (request) => registry.fetch(request) }
    }
  }
  return {
    TURN_CANCELS,
    /** Deliver every turn-object alarm due by `now`, as the platform would. */
    runTurnAlarms: (now: number): Promise<void> => runDurable(Effect.forEach([...cancelAlarms].filter(([, time]) => time <= now), ([name]) => Effect.gen(function* () {
        cancelAlarms.delete(name)
        TURN_CANCELS.get(name)
        yield* Effect.promise(() => cancelObjects.get(name)!.alarm())
    }), { discard: true })),
    /** Each turn object's scheduled alarm time, by object name. */
    turnAlarms: (): ReadonlyMap<string, number> => new Map(cancelAlarms),
    /** The turn journal objects that hold any stored row. */
    storedJournalObjects: (): ReadonlyArray<string> =>
      [...cancelData].filter(([name, rows]) => name.startsWith("turn-journal/") && rows.size > 0).map(([name]) => name),
    /** Forgets every object AND its rows: the next test starts cold. */
    reset: (): void => {
      cancelData.clear()
      cancelObjects.clear()
      cancelAlarms.clear()
    },
    /** Forgets the objects but keeps their rows: a Worker restart. */
    restart: (): void => {
      cancelObjects.clear()
    }
  }
}

export type MemoryDurableObjects = ReturnType<typeof memoryDurableObjects>
