/**
 * Slack Socket Mode: Events API deliveries and Block Kit interactions over an
 * outbound WebSocket, for a host with no public URL.
 *
 * The source asks `apps.connections.open` (with the app-level token) for a
 * WebSocket URL, connects with the platform `WebSocket` client, and waits for
 * Slack's `hello`. Each frame after that is an envelope Slack wants
 * acknowledged by its `envelope_id`. The acknowledgement is the commit: it is
 * sent only after `onBatch` has handled the envelope's event, so a process
 * that dies mid-handler leaves the envelope unacknowledged and Slack delivers
 * it again. A handler failure fails `run` and closes the socket without
 * acknowledging.
 *
 * A redelivery carries the same event identity, so the source drops an event
 * it has already handled, by the same `slack:<team>:<event id>` key the Events
 * API door uses. That memory is bounded and lives with the process; a host
 * that routes events through `Control.signal` passes {@link idempotencyKey} as
 * the signal's idempotency key, which is the durable deduplication.
 *
 * There is no signature on this path: the socket itself is authenticated by
 * the app token. Admission is the same fail-closed policy as the webhook
 * (`Payload.classify`): a non-empty `allowedTeamIds` and a non-empty
 * `allowedChannelIds` or `allowedUserIds` are required, and a bot's or this
 * app's own message is an echo. A refused envelope is acknowledged and
 * dropped, so Slack does not redeliver it.
 *
 * Slack closes a connection on its own schedule: a `disconnect` frame asks
 * for a fresh connection, which the source opens at once. A connection that
 * drops without one is reopened after `reconnect.initialDelay`. Connections
 * that fail before `hello` back off exponentially, and after
 * `reconnect.maxAttempts` consecutive failures `run` fails `poll-failed`. A
 * `link_disabled` disconnect means Socket Mode was turned off for the app, and
 * fails `run` at once.
 *
 * @since 1.0.0
 */

import { Duration, Effect, Option, Queue, Schema } from "effect"
import type { ExternalEvent } from "../core/ExternalEvent.ts"
import { IntegrationError } from "../core/IntegrationError.ts"
import * as Environment from "../Environment.ts"
import type { SlackConfig } from "./Config.ts"
import * as Payload from "./Payload.ts"
import { make as makeClient, type SlackClient } from "./SlackClient.ts"

/**
 * How the source reconnects.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReconnectOptions {
  /** The first backoff delay, and the pause after a connection drops. Defaults to 1 second. */
  readonly initialDelay?: Duration.Input | undefined
  /** The longest backoff delay. Defaults to 30 seconds. */
  readonly maxDelay?: Duration.Input | undefined
  /** Consecutive failed connections before `run` fails. Defaults to 10; 1 to 100. */
  readonly maxAttempts?: number | undefined
}

/**
 * What the source needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options extends SlackConfig {
  /** The source id: every event's `source`. Defaults to `slack`. */
  readonly sourceId?: string | undefined
  /** Required: non-empty `allowedTeamIds`, and non-empty `allowedChannelIds` or `allowedUserIds`. */
  readonly policy: Payload.Policy
  /** An already-built client holding the app token. Built from the config and `env` otherwise. */
  readonly client?: SlackClient | undefined
  readonly reconnect?: ReconnectOptions | undefined
  /** How long a new connection may take to say `hello`. Defaults to 10 seconds. */
  readonly helloTimeout?: Duration.Input | undefined
  /** Handled event keys remembered for deduplication. Defaults to 10,000. */
  readonly dedupeCapacity?: number | undefined
  /** The largest envelope handled; a larger one is acknowledged and dropped. Defaults to 1 MiB. */
  readonly maxEnvelopeBytes?: number | undefined
  /**
   * Accept a `ws:` URL from `apps.connections.open`. Off by default, so a
   * compromised or misconfigured API origin cannot downgrade the socket to
   * plaintext; a local fixture server turns it on.
   */
  readonly allowPlaintextSocket?: boolean | undefined
}

/**
 * A Socket Mode source bound to one app.
 *
 * @category services
 * @since 1.0.0
 */
export interface Source {
  readonly sourceId: string
  /**
   * Connects, delivers each admitted event to `onBatch` as a one-event batch,
   * and acknowledges it only after `onBatch` succeeds. Runs until
   * interrupted, until `onBatch` fails, or until connecting keeps failing.
   */
  readonly run: <E, R>(
    onBatch: (events: ReadonlyArray<ExternalEvent>) => Effect.Effect<void, E, R>
  ) => Effect.Effect<void, IntegrationError | E, R>
}

/**
 * The idempotency key for one delivered event: its dedupe key,
 * `slack:<team>:<event id>`.
 *
 * @category getters
 * @since 1.0.0
 */
export const idempotencyKey = (event: ExternalEvent): string => event.dedupeKey

type Inbound = { readonly _tag: "Frame"; readonly data: unknown } | { readonly _tag: "Closed" }

interface Ended {
  /** Whether Slack said hello, so the connection counts as a success. */
  readonly greeted: boolean
  /** Whether Slack asked for the reconnection, so it may happen at once. */
  readonly immediate: boolean
}

const CLOSED: Inbound = { _tag: "Closed" }
const parseEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Payload.SocketEnvelope))
const DELIVERABLE: ReadonlySet<string> = new Set(["events_api", "interactive"])

const invalid = (message: string, details: Record<string, unknown>): IntegrationError =>
  new IntegrationError("invalid-config", message, { ...details, source: Payload.SERVICE, retryable: false })

const positive = (name: string, value: number | undefined, fallback: number, max: number): number => {
  const chosen = value ?? fallback
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > max) {
    throw invalid(`Slack Socket Mode ${name} must be an integer from 1 to ${max}.`, { [name]: chosen })
  }
  return chosen
}

const millis = (name: string, value: Duration.Input | undefined, fallback: number): number => {
  const chosen = value === undefined ? fallback : Option.match(Duration.fromInput(value), {
    onNone: () => Number.NaN,
    onSome: (duration) => Duration.isFinite(duration) ? Duration.toMillis(duration) : Number.NaN
  })
  if (!(chosen >= 0)) throw invalid(`Slack Socket Mode ${name} must be a finite duration.`, { [name]: String(value) })
  return chosen
}

/**
 * Builds a Socket Mode source.
 *
 * Throws `IntegrationError` with reason `invalid-config` for an empty
 * allowlist, an empty source id, or a bound outside its range.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  options: Options,
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): Source => {
  const sourceId = options.sourceId ?? Payload.SERVICE
  if (typeof sourceId !== "string" || sourceId.trim().length === 0 || sourceId.trim() !== sourceId) {
    throw invalid("Slack Socket Mode source id must be a non-empty string with no surrounding whitespace.", {
      sourceId
    })
  }
  const policy = Payload.requirePolicy(options.policy, "Slack.SocketSource")
  const initialDelayMs = millis("initialDelay", options.reconnect?.initialDelay, 1_000)
  const maxDelayMs = millis("maxDelay", options.reconnect?.maxDelay, 30_000)
  const maxAttempts = positive("maxAttempts", options.reconnect?.maxAttempts, 10, 100)
  const helloTimeoutMs = millis("helloTimeout", options.helloTimeout, 10_000)
  const dedupeCapacity = positive("dedupeCapacity", options.dedupeCapacity, 10_000, 1_000_000)
  const maxEnvelopeBytes = positive("maxEnvelopeBytes", options.maxEnvelopeBytes, 1_048_576, 67_108_864)
  const client = options.client ?? makeClient(options, env)
  const handled = new Set<string>()

  const remember = (key: string): void => {
    handled.add(key)
    if (handled.size > dedupeCapacity) handled.delete(handled.values().next().value as string)
  }

  // A URL Slack answers with is still checked: it must be a WebSocket URL, and
  // plaintext only when the host opted in.
  const openUrl: Effect.Effect<string | undefined, IntegrationError> = client.call(
    "apps.connections.open",
    {},
    { auth: "app" }
  ).pipe(
    Effect.flatMap((answer) => {
      const url = answer["url"]
      const protocol = typeof url === "string" && URL.canParse(url) ? new URL(url).protocol : ""
      return protocol === "wss:" || (protocol === "ws:" && options.allowPlaintextSocket === true)
        ? Effect.succeed(url as string)
        : Effect.fail(invalid("Slack apps.connections.open answered with a URL this source will not connect to.", {
          protocol
        }))
    }),
    // A refusal (a revoked token, Socket Mode off) is permanent; anything the
    // client already retried and still could not reach is one failed attempt.
    Effect.catch((error) =>
      (error.details as Readonly<Record<string, unknown>>)["retryable"] === true
        ? Effect.logWarning("Slack apps.connections.open failed; reconnecting", error).pipe(Effect.as(undefined))
        : Effect.fail(error)
    )
  )

  const session = <E, R>(
    url: string,
    onBatch: (events: ReadonlyArray<ExternalEvent>) => Effect.Effect<void, E, R>
  ): Effect.Effect<Ended, IntegrationError | E, R> =>
    Effect.scoped(Effect.gen(function*() {
      const inbox = yield* Queue.unbounded<Inbound>()
      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const ws = new WebSocket(url)
          ws.addEventListener("message", (event) => Queue.offerUnsafe(inbox, { _tag: "Frame", data: event.data }))
          ws.addEventListener("close", () => Queue.offerUnsafe(inbox, CLOSED))
          ws.addEventListener("error", () => Queue.offerUnsafe(inbox, CLOSED))
          return ws
        }),
        (ws) => Effect.sync(() => ws.close())
      )
      const acknowledge = (envelopeId: string) =>
        Effect.sync(() => socket.send(JSON.stringify({ envelope_id: envelopeId })))
      let greeted = false
      while (true) {
        const inbound = greeted ? yield* Queue.take(inbox) : yield* Queue.take(inbox).pipe(
          Effect.timeoutOrElse({ duration: Duration.millis(helloTimeoutMs), orElse: () => Effect.succeed(CLOSED) })
        )
        if (inbound._tag === "Closed") return { greeted, immediate: false }
        const data = inbound.data
        const frame = typeof data === "string" ? parseEnvelope(data) : Option.none()
        if (frame._tag === "None") {
          yield* Effect.logWarning("Slack Socket Mode frame is not an envelope; ignored")
          continue
        }
        const envelope = frame.value
        if (envelope.type === "hello") {
          greeted = true
          continue
        }
        if (envelope.type === "disconnect") {
          if (envelope.reason === "link_disabled") {
            return yield* Effect.fail(
              new IntegrationError("permission-denied", "Slack disabled Socket Mode for this app (link_disabled).", {
                source: sourceId,
                retryable: false
              })
            )
          }
          return { greeted, immediate: true }
        }
        const envelopeId = envelope.envelope_id
        if (envelopeId === undefined) continue
        const verdict: Payload.Classification = Buffer.byteLength(data as string) > maxEnvelopeBytes ||
            !DELIVERABLE.has(envelope.type)
          ? { _tag: "Refused", reason: "unsupported" }
          : Payload.classify(envelope.payload, policy)
        if (verdict._tag === "Refused") {
          yield* Effect.logDebug("Slack Socket Mode envelope refused", { reason: verdict.reason, type: envelope.type })
        } else if (!handled.has(verdict.key)) {
          const event = Payload.toExternalEvent(envelope.payload, { source: sourceId, policy })
          yield* onBatch([event])
          remember(verdict.key)
        }
        yield* acknowledge(envelopeId)
      }
    }))

  const run: Source["run"] = (onBatch) =>
    Effect.gen(function*() {
      let failures = 0
      while (true) {
        const url = yield* openUrl
        const ended = url === undefined ? { greeted: false, immediate: false } : yield* session(url, onBatch)
        if (ended.greeted) {
          failures = 0
          if (!ended.immediate) yield* Effect.sleep(Duration.millis(initialDelayMs))
          continue
        }
        failures += 1
        if (failures >= maxAttempts) {
          return yield* Effect.fail(
            new IntegrationError(
              "poll-failed",
              `Slack Socket Mode could not connect after ${failures} consecutive attempts.`,
              { source: sourceId, attempts: failures, retryable: true }
            )
          )
        }
        yield* Effect.sleep(Duration.millis(Math.min(initialDelayMs * 2 ** (failures - 1), maxDelayMs)))
      }
    })

  return { sourceId, run }
}
