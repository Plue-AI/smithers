/**
 * The replay fold behind `smthrs runs inspect` and `smthrs runs replay`.
 * @since 1.0.0
 */

import type { Entry } from "@smthrs/journal/JournalEvent"
import type { Projection } from "@smthrs/time-travel/TimeTravel"

/**
 * What one history read reports about the replayed prefix.
 * @since 1.0.0
 * @category models
 */
export interface Summary {
  readonly entryCount: number
  readonly eventTypes: Readonly<Record<string, number>>
  readonly state?: unknown
  readonly events: ReadonlyArray<Entry>
  readonly sealed: ReadonlyArray<{ seq: number; result: unknown }>
}

/** Newest-first list: an append shares the older prefix instead of copying it. */
interface Chain<A> {
  readonly head: A
  readonly tail: Chain<A> | undefined
}

/**
 * Fold state. Every intermediate state stays valid, because an append never
 * mutates the prefix another state may still hold.
 */
interface State {
  readonly entryCount: number
  readonly eventTypes: Readonly<Record<string, number>>
  readonly state?: unknown
  readonly events: Chain<Entry> | undefined
  readonly sealed: Chain<{ seq: number; result: unknown }> | undefined
}

const toArray = <A>(chain: Chain<A> | undefined): Array<A> => {
  const values: Array<A> = []
  for (let link = chain; link !== undefined; link = link.tail) values.push(link.head)
  return values.reverse()
}

/**
 * Builds the fold for one read; `finish` materializes its arrays once.
 * @since 1.0.0
 * @category constructors
 */
export const make = (includeEvents: boolean): Projection<State> & { readonly finish: (state: State) => Summary } => ({
  initial: { entryCount: 0, eventTypes: {}, events: undefined, sealed: undefined },
  reduce: (state, entry, sealed) => {
    const payload = entry.payload as { readonly state?: unknown } | null
    return {
      entryCount: state.entryCount + 1,
      eventTypes: { ...state.eventTypes, [entry.eventType]: (state.eventTypes[entry.eventType] ?? 0) + 1 },
      state: entry.eventType === "flows.engine.run-decision" && payload?.state !== undefined
        ? payload.state
        : state.state,
      events: includeEvents ? { head: entry, tail: state.events } : undefined,
      sealed: sealed === undefined ? state.sealed : { head: { seq: entry.seq, result: sealed }, tail: state.sealed }
    }
  },
  finish: (state) => ({
    entryCount: state.entryCount,
    eventTypes: state.eventTypes,
    state: state.state,
    events: toArray(state.events),
    sealed: toArray(state.sealed)
  })
})
