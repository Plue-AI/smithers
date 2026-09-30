/**
 * Slack Socket Mode against the real fixture: `apps.connections.open` over
 * HTTP, then an RFC 6455 connection that Node's own `WebSocket` client speaks
 * to. The server plays Slack: it says `hello`, pushes envelopes, and watches
 * which ones the source acknowledges and when.
 *
 * The property that matters most is the commit point. An envelope is
 * acknowledged only after the handler finished with its event, so a handler
 * that is still running, or that failed, leaves the envelope for Slack to
 * deliver again.
 */
import { Deferred, Effect, Exit, Fiber } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { ExternalEvent } from "../src/core/ExternalEvent.ts"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import type * as Payload from "../src/slack/Payload.ts"
import * as SocketSource from "../src/slack/SocketSource.ts"
import { type ApiHandler, ok, type Peer, refuse, type SlackFixture, startSlackFixture } from "./SlackFixture.ts"

const APP = "xapp-fixture-app-token"
const policy: Payload.Policy = { allowedTeamIds: ["T1"], allowedChannelIds: ["C1"], selfUserIds: ["UBOT"] }

let fixture: SlackFixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const opens = () => (fixture as SlackFixture).calls.filter((call) => call.method === "apps.connections.open")

/** A fixture whose `apps.connections.open` answers a URL on itself, one path per connection. */
const start = async (answer?: ApiHandler): Promise<SlackFixture> => {
  let count = 0
  fixture = await startSlackFixture(
    answer ?? ((call, response) => {
      if (call.method !== "apps.connections.open") return refuse(response, "unknown_method")
      count += 1
      return ok(response, { url: (fixture as SlackFixture).socketUrl(`/link/${count}`) })
    })
  )
  return fixture
}

const source = (options: Partial<SocketSource.Options> = {}) =>
  SocketSource.make({
    appToken: APP,
    apiBaseUrl: (fixture as SlackFixture).apiBaseUrl,
    allowPlaintextSocket: true,
    retryBaseDelay: 0,
    policy,
    reconnect: { initialDelay: 5, maxDelay: 20, maxAttempts: 3 },
    helloTimeout: 2_000,
    ...options
  }, {})

const message = (fields: Record<string, unknown> = {}) => ({
  type: "message",
  channel: "C1",
  channel_type: "channel",
  user: "U1",
  text: "hello",
  ts: "1700000000.000100",
  ...fields
})

const callback = (eventId: string, event: Record<string, unknown> = message()) => ({
  token: "legacy-verification-token",
  team_id: "T1",
  api_app_id: "A1",
  type: "event_callback",
  event_id: eventId,
  authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }],
  event
})

const envelope = (id: string, payload: unknown, type = "events_api") => ({
  envelope_id: id,
  type,
  payload,
  accepts_response_payload: false,
  retry_attempt: 0
})

const acked = (frame: string): string => (JSON.parse(frame) as { envelope_id: string }).envelope_id

/** Runs the source in the background, collecting every delivered batch. */
const running = <E>(
  subject: SocketSource.Source,
  handle: (events: ReadonlyArray<ExternalEvent>) => Effect.Effect<void, E> = () => Effect.void
) => {
  const delivered: Array<ExternalEvent> = []
  const fiber = Effect.runFork(
    subject.run((events) => Effect.andThen(Effect.sync(() => delivered.push(...events)), handle(events)))
  )
  return {
    delivered,
    fiber,
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
    result: () => Effect.runPromise(Effect.exit(Fiber.join(fiber)))
  }
}

const connected = async (): Promise<Peer> => {
  const peer = await (fixture as SlackFixture).nextPeer()
  peer.send({ type: "hello", num_connections: 1 })
  return peer
}

const failureOf = (exit: Exit.Exit<void, unknown>): unknown => {
  const error = Exit.findErrorOption(exit)
  if (error._tag === "None") throw new Error(`expected a typed failure, got ${String(exit)}`)
  return error.value
}

describe("SocketSource.make", () => {
  it("refuses an empty allowlist, a bad source id, and every bound outside its range", () => {
    const base = { appToken: APP, apiBaseUrl: "http://127.0.0.1:9/api", policy }
    expect(() => SocketSource.make({ ...base, policy: { allowedTeamIds: ["T1"] } }, {})).toThrow(/allowedTeamIds/)
    expect(() => SocketSource.make({ ...base, sourceId: "" }, {})).toThrow(/source id/)
    expect(() => SocketSource.make({ ...base, sourceId: " slack" }, {})).toThrow(/source id/)
    expect(() => SocketSource.make({ ...base, sourceId: 7 as never }, {})).toThrow(/source id/)
    expect(() => SocketSource.make({ ...base, reconnect: { maxAttempts: 0 } }, {})).toThrow(/maxAttempts/)
    expect(() => SocketSource.make({ ...base, reconnect: { maxAttempts: 1.5 } }, {})).toThrow(/maxAttempts/)
    expect(() => SocketSource.make({ ...base, dedupeCapacity: 1_000_001 }, {})).toThrow(/dedupeCapacity/)
    expect(() => SocketSource.make({ ...base, maxEnvelopeBytes: 0 }, {})).toThrow(/maxEnvelopeBytes/)
    expect(() => SocketSource.make({ ...base, reconnect: { initialDelay: -1 } }, {})).toThrow(/initialDelay/)
    expect(() => SocketSource.make({ ...base, reconnect: { maxDelay: "soon" as never } }, {})).toThrow(/maxDelay/)
    expect(() => SocketSource.make({ ...base, helloTimeout: Infinity }, {})).toThrow(/helloTimeout/)
    const made = SocketSource.make({ ...base, sourceId: "slack-main" }, {})
    expect(made.sourceId).toBe("slack-main")
    expect(SocketSource.make(base, {}).sourceId).toBe("slack")
  })

  it("names an event by its delivery identity", () => {
    expect(SocketSource.idempotencyKey({ dedupeKey: "slack:T1:Ev1" } as ExternalEvent)).toBe("slack:T1:Ev1")
  })
})

describe("SocketSource.run", () => {
  it("opens the socket with the app token and acknowledges an event only after the handler finished", async () => {
    await start()
    const release = Effect.runSync(Deferred.make<void>())
    const handling = Effect.runSync(Deferred.make<void>())
    const run = running(
      source(),
      () => Effect.andThen(Deferred.succeed(handling, undefined), Deferred.await(release))
    )
    const peer = await connected()
    expect(opens()[0]?.authorization).toBe(`Bearer ${APP}`)
    peer.send(envelope("env-1", callback("Ev1")))
    await Effect.runPromise(Deferred.await(handling))
    // The handler is still running: nothing may be acknowledged yet.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(peer.received).toEqual([])
    Effect.runSync(Deferred.succeed(release, undefined))
    expect(acked(await peer.next())).toBe("env-1")
    expect(run.delivered).toHaveLength(1)
    expect(run.delivered[0]).toMatchObject({
      source: "slack",
      eventName: "integration:slack:message",
      correlationId: "channel:C1",
      dedupeKey: "slack:T1:Ev1"
    })
    // The legacy verification token never reaches the handler.
    expect(run.delivered[0]?.payload).not.toHaveProperty("token")
    await run.stop()
  })

  it("acknowledges and drops what the allowlist refuses, fails closed, and filters echoes", async () => {
    await start()
    const run = running(source())
    const peer = await connected()
    peer.send(envelope("other-channel", callback("Ev1", message({ channel: "C9" }))))
    peer.send(envelope("other-team", { ...callback("Ev2"), team_id: "T9" }))
    peer.send(envelope("bot", callback("Ev3", message({ bot_id: "B1" }))))
    peer.send(envelope("self", callback("Ev4", message({ user: "UBOT" }))))
    peer.send(envelope("unnamed", callback("Ev5", { type: "team_join", user: { id: "U2" } })))
    peer.send(envelope("person", callback("Ev6")))
    const acks = []
    for (let index = 0; index < 6; index++) acks.push(acked(await peer.next()))
    expect(acks).toEqual(["other-channel", "other-team", "bot", "self", "unnamed", "person"])
    expect(run.delivered.map((event) => event.dedupeKey)).toEqual(["slack:T1:Ev6"])
    await run.stop()
  })

  it("delivers a redelivered event once, acknowledging every copy", async () => {
    await start()
    const run = running(source({ dedupeCapacity: 1 }))
    const peer = await connected()
    peer.send(envelope("first", callback("Ev1")))
    expect(acked(await peer.next())).toBe("first")
    peer.send({ ...envelope("retry", callback("Ev1")), retry_attempt: 1 })
    expect(acked(await peer.next())).toBe("retry")
    // A capacity of one forgets Ev1 once Ev2 is handled, so a later copy of
    // Ev1 is delivered again: the durable deduplication is the signal key.
    peer.send(envelope("second", callback("Ev2")))
    expect(acked(await peer.next())).toBe("second")
    peer.send(envelope("late", callback("Ev1")))
    expect(acked(await peer.next())).toBe("late")
    expect(run.delivered.map((event) => event.dedupeKey)).toEqual(["slack:T1:Ev1", "slack:T1:Ev2", "slack:T1:Ev1"])
    await run.stop()
  })

  it("delivers a button press from the interactive envelope", async () => {
    await start()
    const run = running(source())
    const peer = await connected()
    peer.send(envelope("press", {
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U1", team_id: "T1" },
      channel: { id: "C1" },
      container: { channel_id: "C1", message_ts: "1700000000.000100", thread_ts: "1700000000.000001" },
      trigger_id: "trigger-1",
      response_url: "https://hooks.example.test/capability",
      actions: [{ action_id: "sap:t:a", value: "approve" }]
    }, "interactive"))
    expect(acked(await peer.next())).toBe("press")
    expect(run.delivered[0]).toMatchObject({
      eventName: "integration:slack:block_actions",
      correlationId: "channel:C1:thread:1700000000.000001",
      dedupeKey: "slack:T1:action:trigger-1"
    })
    expect(run.delivered[0]?.payload).not.toHaveProperty("response_url")
    await run.stop()
  })

  it("ignores frames that are not envelopes, and acknowledges unsupported or oversized ones undelivered", async () => {
    await start()
    const run = running(source({ maxEnvelopeBytes: 2_048 }))
    const peer = await connected()
    peer.sendText("not json")
    peer.sendBinary(new Uint8Array([1, 2, 3]))
    peer.send({ type: "events_api", payload: callback("Ev0") })
    peer.send(envelope("slash", { command: "/deploy" }, "slash_commands"))
    peer.send(envelope("huge", callback("Ev1", message({ text: "x".repeat(4_096) }))))
    peer.send(envelope("fine", callback("Ev2")))
    expect([acked(await peer.next()), acked(await peer.next()), acked(await peer.next())])
      .toEqual(["slash", "huge", "fine"])
    expect(run.delivered.map((event) => event.dedupeKey)).toEqual(["slack:T1:Ev2"])
    await run.stop()
  })

  it("reconnects at once when Slack asks, and after a pause when the connection drops", async () => {
    await start()
    const run = running(source())
    const first = await connected()
    first.send({ type: "disconnect", reason: "refresh_requested" })
    const second = await connected()
    expect(second.path).toBe("/link/2")
    second.drop()
    const third = await connected()
    expect(third.path).toBe("/link/3")
    third.send(envelope("after", callback("Ev1")))
    expect(acked(await third.next())).toBe("after")
    expect(run.delivered).toHaveLength(1)
    expect(opens()).toHaveLength(3)
    await run.stop()
  })

  it("fails permission-denied when Slack disables Socket Mode for the app", async () => {
    await start()
    const run = running(source())
    const peer = await connected()
    peer.send({ type: "disconnect", reason: "link_disabled" })
    const error = failureOf(await run.result())
    expect(error).toBeInstanceOf(IntegrationError)
    expect(error).toMatchObject({ reason: "permission-denied" })
  })

  it("fails with the handler's error and leaves its envelope unacknowledged", async () => {
    await start()
    const run = running(source(), () => Effect.fail("handler exploded" as const))
    const peer = await connected()
    peer.send(envelope("doomed", callback("Ev1")))
    expect(failureOf(await run.result())).toBe("handler exploded")
    await peer.closed
    expect(peer.received).toEqual([])
  })

  it("backs off after connections that never say hello, then fails poll-failed", async () => {
    await start()
    const run = running(source({ helloTimeout: 20 }))
    for (let index = 0; index < 3; index++) await (fixture as SlackFixture).nextPeer()
    const error = failureOf(await run.result())
    expect(error).toMatchObject({ reason: "poll-failed", details: { attempts: 3 } })
    expect(opens()).toHaveLength(3)
  })

  it("keeps one hello deadline however many other frames arrive before it", async () => {
    await start()
    const chatter: Array<ReturnType<typeof setInterval>> = []
    const chatty = (peer: Peer) => {
      let sent = 0
      chatter.push(setInterval(() => {
        sent += 1
        if (sent % 2 === 0) peer.sendText("not json")
        else peer.send({ type: "events_api", payload: callback(`Ev${sent}`) })
      }, 10))
    }
    const startedAt = Date.now()
    const run = running(
      source({ helloTimeout: 100, reconnect: { initialDelay: 5, maxDelay: 20, maxAttempts: 2 } })
    )
    try {
      const peers = [await (fixture as SlackFixture).nextPeer()]
      chatty(peers[0] as Peer)
      peers.push(await (fixture as SlackFixture).nextPeer())
      chatty(peers[1] as Peer)
      const error = failureOf(await run.result())
      expect(error).toMatchObject({ reason: "poll-failed", details: { attempts: 2 } })
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      await Promise.all(peers.map((peer) => peer.closed))
      expect(opens()).toHaveLength(2)
      expect(run.delivered).toEqual([])
    } finally {
      chatter.forEach(clearInterval)
    }
  })

  it("stops counting the greeting once hello arrives inside the deadline, even after other frames", async () => {
    await start()
    const run = running(source({ helloTimeout: 150 }))
    const peer = await (fixture as SlackFixture).nextPeer()
    peer.sendText("not json")
    peer.send({ type: "events_api", payload: callback("Ev0") })
    await new Promise((resolve) => setTimeout(resolve, 60))
    peer.send({ type: "hello", num_connections: 1 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    peer.send(envelope("late", callback("Ev1")))
    expect(acked(await peer.next())).toBe("late")
    expect(run.delivered.map((event) => event.dedupeKey)).toEqual(["slack:T1:Ev1"])
    expect(opens()).toHaveLength(1)
    await run.stop()
  })

  it("closes the connection when the host interrupts it while it waits for hello", async () => {
    await start()
    const run = running(source({ helloTimeout: 5_000 }))
    const peer = await (fixture as SlackFixture).nextPeer()
    peer.sendText("not json")
    await run.stop()
    await peer.closed
    expect(opens()).toHaveLength(1)
    expect(peer.received).toEqual([])
  })

  it("counts a refused WebSocket upgrade as a failed attempt", async () => {
    let count = 0
    fixture = await startSlackFixture((_call, response) => {
      count += 1
      ok(response, { url: (fixture as SlackFixture).socketUrl(`/link/${count}`) })
    }, (path) => path === "/link/1" ? "refuse" : "accept")
    const run = running(source())
    const peer = await connected()
    expect(peer.path).toBe("/link/2")
    await run.stop()
  })

  it("treats a retryable apps.connections.open failure as one failed attempt", async () => {
    let count = 0
    await start((call, response) => {
      count += 1
      if (count === 1) return refuse(response, "internal_error", 503)
      return ok(response, { url: (fixture as SlackFixture).socketUrl() })
    })
    const run = running(source({ maxRetries: 0 }))
    await connected()
    expect(count).toBe(2)
    await run.stop()
  })

  it("fails at once when Slack refuses the app token", async () => {
    await start((_call, response) => refuse(response, "invalid_auth"))
    const error = failureOf(await running(source()).result())
    expect(error).toMatchObject({ reason: "permission-denied" })
    expect(JSON.stringify(error)).not.toContain(APP)
  })

  it("refuses a plaintext or non-WebSocket URL unless plaintext was allowed", async () => {
    await start((_call, response) => ok(response, { url: (fixture as SlackFixture).socketUrl() }))
    expect(failureOf(await running(source({ allowPlaintextSocket: false })).result()))
      .toMatchObject({ reason: "invalid-config", details: { protocol: "ws:" } })
    await fixture?.close()
    await start((_call, response) => ok(response, { url: "https://slack.example.test/link" }))
    expect(failureOf(await running(source()).result())).toMatchObject({ reason: "invalid-config" })
    await fixture?.close()
    await start((_call, response) => ok(response, {}))
    expect(failureOf(await running(source()).result())).toMatchObject({ details: { protocol: "" } })
  })

  it("uses an injected client instead of building one", async () => {
    await start()
    const { make } = await import("../src/slack/SlackClient.ts")
    const client = make({ appToken: "xapp-injected", apiBaseUrl: (fixture as SlackFixture).apiBaseUrl }, {})
    const run = running(SocketSource.make({ policy, client, allowPlaintextSocket: true }, {}))
    await connected()
    expect(opens()[0]?.authorization).toBe("Bearer xapp-injected")
    await run.stop()
  })
})
