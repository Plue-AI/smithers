/**
 * `notes/traction` as a file flow: one daily adoption row per npm package and
 * GitHub repository in a workspace note. The exported {@link layer} binds the
 * workspace root, the public npm and GitHub APIs, and the clock; the payload
 * names only the note and what to count.
 */
import { Action, Flow } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import { Payload, Receipt, snapshot, type TractionHost } from "./traction.ts"

export const Snapshot = Action.make("notes/traction/snapshot", {
  implementationVersion: "notes/traction/v1",
  payload: Payload,
  success: Receipt,
  error: Schema.Union([Receipt, Schema.String]),
  nondeterministic: true
})

export default Flow.make("notes/traction", {
  description: "Record one daily row of npm downloads and GitHub stars and forks in a note.",
  capabilities: ["fs:read:**", "fs:write:**", "net:get:*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Payload,
  success: Receipt,
  error: Schema.Union([Receipt, Schema.String]),
  body: (input) => Snapshot.call(input)
})

/** The implementation of {@link Snapshot} over `host`. */
export const make = (host: TractionHost) =>
  Snapshot.toLayer(
    (payload) =>
      Effect.tryPromise({ try: () => snapshot(host, payload), catch: () => "Note unavailable" }).pipe(
        Effect.flatMap((result) => result.ok ? Effect.succeed(result.receipt) : Effect.fail(result.error))
      ),
    { implementationVersion: "notes/traction/v1" }
  )

export const layer = make({
  root: process.cwd(),
  fetch: globalThis.fetch,
  now: () => new Date(),
  npm: "https://api.npmjs.org",
  github: "https://api.github.com"
})
