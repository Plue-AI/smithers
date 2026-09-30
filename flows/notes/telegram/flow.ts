/**
 * `notes/telegram` as a file flow: the messages a Telegram bot has received,
 * merged into a workspace note. The exported {@link layer} binds the workspace
 * root, the Bot API, the bot token from `TELEGRAM_BOT_TOKEN` and the clock;
 * the payload names only the note and, optionally, the chats to keep.
 */
import { Action, Flow } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import { ingest, Payload, Receipt, type TelegramHost } from "./messages.ts"

export const Ingest = Action.make("notes/telegram/ingest", {
  implementationVersion: "notes/telegram/v1",
  payload: Payload,
  success: Receipt,
  error: Schema.Union([Receipt, Schema.String]),
  nondeterministic: true
})

export default Flow.make("notes/telegram", {
  description: "Add the messages a Telegram bot has received to a note's Telegram section.",
  capabilities: ["fs:read:**", "fs:write:**", "net:get:*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Payload,
  success: Receipt,
  error: Schema.Union([Receipt, Schema.String]),
  body: (input) => Ingest.call(input)
})

/** The implementation of {@link Ingest} over `host`. */
export const make = (host: TelegramHost) =>
  Ingest.toLayer(
    (payload) =>
      Effect.tryPromise({ try: () => ingest(host, payload), catch: () => "Note unavailable" }).pipe(
        Effect.flatMap((result) => result.ok ? Effect.succeed(result.receipt) : Effect.fail(result.error))
      ),
    { implementationVersion: "notes/telegram/v1" }
  )

export const layer = make({
  root: process.cwd(),
  fetch: globalThis.fetch,
  now: () => new Date(),
  api: "https://api.telegram.org",
  token: () => process.env["TELEGRAM_BOT_TOKEN"]
})
