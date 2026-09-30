/**
 * `notes/calendar-events` as a file flow: upcoming events from iCalendar feeds
 * merged into a workspace note. The exported {@link layer} binds the workspace
 * root, the network and the clock; the payload names the note and the feeds.
 */
import { Action, Flow } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import type { Host } from "../note.ts"
import { Payload, Receipt, refresh } from "./events.ts"

export const Refresh = Action.make("notes/calendar-events/refresh", {
  implementationVersion: "notes/calendar-events/v1",
  payload: Payload,
  success: Receipt,
  error: Schema.Union([Receipt, Schema.String]),
  nondeterministic: true
})

export default Flow.make("notes/calendar-events", {
  description: "Add upcoming events from iCalendar feeds to a note's Upcoming events section.",
  capabilities: ["fs:read:**", "fs:write:**", "net:get:*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Payload,
  success: Receipt,
  error: Schema.Union([Receipt, Schema.String]),
  body: (input) => Refresh.call(input)
})

/** The implementation of {@link Refresh} over `host`. */
export const make = (host: Host) =>
  Refresh.toLayer(
    (payload) =>
      Effect.tryPromise({ try: () => refresh(host, payload), catch: () => "Note unavailable" }).pipe(
        Effect.flatMap((result) => result.ok ? Effect.succeed(result.receipt) : Effect.fail(result.error))
      ),
    { implementationVersion: "notes/calendar-events/v1" }
  )

export const layer = make({ root: process.cwd(), fetch: globalThis.fetch, now: () => new Date() })
