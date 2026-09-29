/**
 * The owner's loop a local host runs over one Slack app, end to end against
 * the fixture: a direct message arrives over Socket Mode, the host replies in
 * its thread as a role persona with approval buttons, a stranger's press is
 * dropped at the door, and the owner's press decides the approval and the
 * prompt is updated.
 *
 * Everything is configured the way a host is: tokens, workspace and owner
 * from `SMITHERS_SLACK_*` variables through `Config.policy` and
 * `Connections.layerFromEnvironment`. The owner's `D…` conversation is listed
 * nowhere; `allowedUserIds` is what admits it. Replies run as durable actions
 * on the flow runtime. Nothing is mocked.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Deferred, Effect, Fiber, Layer, type Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { ExternalEvent } from "../src/core/ExternalEvent.ts"
import * as Actions from "../src/slack/Actions.ts"
import * as Approval from "../src/slack/Approval.ts"
import * as Config from "../src/slack/Config.ts"
import * as Connections from "../src/slack/Connections.ts"
import * as SocketSource from "../src/slack/SocketSource.ts"
import { ok, refuse, type SlackFixture, startSlackFixture } from "./SlackFixture.ts"

const DM = "D0OWNER1"
const DM_TS = "1700000000.000100"
const REPLY_TS = "1700000001.000200"

let fixture: SlackFixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

/** Every action tag {@link Actions.layer} implements. */
type SlackTag = Layer.Success<typeof Actions.layer> extends Action.Requirement<infer Tag> ? Tag : never

/** A schema whose codec needs no services, which every Slack action schema is. */
type PureSchema = { readonly DecodingServices: never; readonly EncodingServices: never }

/**
 * Runs one durable Slack action through a flow on the memory engine.
 *
 * The declared return type has no requirements, so tsc checks that the layer
 * below provides everything the flow needs.
 */
const perform = <
  Tag extends SlackTag,
  Payload extends Flow.AnyStructSchema & PureSchema,
  Success extends Schema.Top & PureSchema,
  Error extends Schema.Top & PureSchema,
  ResolverError
>(
  declaration: Action.Declared<Tag, Payload, Success, Error>,
  payload: Payload["~type.make.in"],
  resolver: Layer.Layer<Connections.SlackConnections, ResolverError>
): Effect.Effect<Success["Type"], unknown> => {
  const flow = Flow.make(`${declaration.name}/round-trip`, {
    payload: declaration.payloadSchema,
    success: declaration.successSchema,
    error: declaration.errorSchema,
    // The cast is on the payload value only (decoded Type vs planned make-in); R is untouched.
    body: (input) => declaration.call(input as never)
  })
  // Narrows only the provided side to this tag, which `Tag extends SlackTag`
  // guarantees `Actions.layer` implements; its requirements (RIn) are kept.
  const implementation = Actions.layer as Layer.Layer<
    Action.Requirement<Tag>,
    never,
    Layer.Services<typeof Actions.layer>
  >
  const layer = Layer.mergeAll(implementation, Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, resolver, NodeCrypto.layer))
  )
  return flow.execute(payload, { executionId: `round-trip-${declaration.name}` }).pipe(
    Effect.provide(layer),
    Effect.scoped
  )
}

/** An action nothing in {@link perform}'s layer implements. */
const Unprovided = Action.make("test/integrations/SlackRoundTrip/Unprovided", { payload: {} })

/** Never called; tsc checks it (#2704). */
const unprovidedServiceProbe = () => {
  const resolver = Connections.layer([])
  // @ts-expect-error Actions.layer does not implement the Unprovided action
  perform(Unprovided, {}, resolver)
  perform(Actions.DeleteMessage, { connectionId: "workspace", channel: "C0001", ts: "1.2" }, resolver)
}

describe("regression: provide-then-cast test helpers erase layer requirements (#2704)", () => {
  it("rejects an action the Slack layer does not implement", () => {
    // The assertion is the `@ts-expect-error` directive above.
    expect(unprovidedServiceProbe).toBeTypeOf("function")
  })
})

describe("Slack owner round trip", () => {
  it("DM, thread reply with buttons, stranger ignored, owner approves, prompt updated", async () => {
    fixture = await startSlackFixture((call, response) => {
      switch (call.method) {
        case "apps.connections.open":
          return ok(response, { url: (fixture as SlackFixture).socketUrl() })
        case "chat.postMessage":
          return ok(response, { channel: call.params["channel"], ts: REPLY_TS })
        case "chat.getPermalink":
          return ok(response, { permalink: `https://example.slack.com/archives/${DM}/p1700000001000200` })
        case "chat.update":
          return ok(response, { ts: call.params["ts"] })
        default:
          return refuse(response, "unknown_method")
      }
    })
    const env = {
      SMITHERS_SLACK_BOT_TOKEN: "xoxb-round-trip",
      SMITHERS_SLACK_APP_TOKEN: "xapp-round-trip",
      SMITHERS_SLACK_API_BASE_URL: fixture.apiBaseUrl,
      SMITHERS_SLACK_TEAM_IDS: "T1",
      SMITHERS_SLACK_USER_IDS: "UOWNER"
    }
    const policy = Config.policy(env)
    const resolver = Connections.layerFromEnvironment({ containers: ["*"] }, env)
    const source = SocketSource.make({ policy, allowPlaintextSocket: true }, env)

    // The host's state: one pending approval per prompt token.
    const pending = new Map<string, { readonly channel: string; readonly ts: string; readonly runId: string }>()
    const decided = Effect.runSync(Deferred.make<Approval.Decision>())
    const handled: Array<string> = []

    const handle = (event: ExternalEvent) =>
      Effect.gen(function*() {
        handled.push(event.eventName)
        const payload = event.payload as Record<string, any>
        if (event.eventName === "integration:slack:message") {
          const message = payload["event"]
          const runId = "run-1"
          const token = Approval.token(`${runId}/merge`)
          const posted = yield* perform(Actions.PostMessage, {
            connectionId: "slack",
            channel: message.channel,
            threadTs: message.ts,
            text: "Plan ready. Merge?",
            blocks: Approval.blocks({ mode: "approve", token, allowedUserIds: policy.allowedUserIds }),
            key: `${runId}/merge-prompt`,
            persona: { username: "Lead", iconEmoji: ":compass:" }
          }, resolver)
          pending.set(token, { channel: posted.channel, ts: posted.ts, runId })
          return
        }
        const token = Approval.pressedToken(payload)
        const prompt = token === null ? undefined : pending.get(token)
        if (prompt === undefined) return
        const outcome = Approval.decision(payload, {
          mode: "approve",
          token: token as string,
          allowedUserIds: policy.allowedUserIds
        })
        if (outcome._tag !== "Decided") return
        pending.delete(token as string)
        yield* perform(Actions.UpdateMessage, {
          connectionId: "slack",
          channel: prompt.channel,
          ts: prompt.ts,
          text: `Approved by <@${outcome.decision.decidedBy}>.`,
          blocks: []
        }, resolver)
        yield* Deferred.succeed(decided, outcome.decision)
      })

    const fiber = Effect.runFork(source.run((events) => Effect.forEach(events, handle, { discard: true })))
    const peer = await fixture.nextPeer()
    peer.send({ type: "hello" })

    // 1. The owner's first DM, from a conversation no allowlist names.
    peer.send({
      envelope_id: "e-dm",
      type: "events_api",
      payload: {
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev-dm",
        authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }],
        event: { type: "message", channel: DM, channel_type: "im", user: "UOWNER", text: "ship it", ts: DM_TS }
      }
    })
    expect(JSON.parse(await peer.next())).toEqual({ envelope_id: "e-dm" })
    const post = fixture.calls.find((call) => call.method === "chat.postMessage")
    expect(post?.authorization).toBe("Bearer xoxb-round-trip")
    expect(post?.params).toMatchObject({
      channel: DM,
      thread_ts: DM_TS,
      username: "Lead",
      icon_emoji: ":compass:"
    })
    const token = Approval.token("run-1/merge")
    const buttons = JSON.parse(post?.params["blocks"] ?? "[]")[0].elements
    expect(buttons.map((button: { action_id: string }) => button.action_id)).toEqual([
      `sap:${token}:a`,
      `sap:${token}:d`
    ])

    // 2. Slack echoes the app's own reply; the echo filter drops it.
    peer.send({
      envelope_id: "e-echo",
      type: "events_api",
      payload: {
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev-echo",
        event: {
          type: "message",
          channel: DM,
          user: "UBOT",
          bot_id: "B1",
          text: "Plan ready. Merge?",
          ts: REPLY_TS,
          thread_ts: DM_TS
        }
      }
    })
    expect(JSON.parse(await peer.next())).toEqual({ envelope_id: "e-echo" })

    const pressBy = (user: string, trigger: string) => ({
      type: "block_actions",
      team: { id: "T1" },
      user: { id: user, team_id: "T1" },
      channel: { id: DM },
      container: { channel_id: DM, message_ts: REPLY_TS, thread_ts: DM_TS },
      trigger_id: trigger,
      actions: [{ action_id: `sap:${token}:a`, value: "approve" }]
    })

    // 3. A stranger's press never reaches the host.
    peer.send({ envelope_id: "e-stranger", type: "interactive", payload: pressBy("USTRANGER", "t-1") })
    expect(JSON.parse(await peer.next())).toEqual({ envelope_id: "e-stranger" })
    expect(pending.size).toBe(1)

    // 4. The owner's press decides, and the prompt is updated in place.
    peer.send({ envelope_id: "e-owner", type: "interactive", payload: pressBy("UOWNER", "t-2") })
    const decision = await Effect.runPromise(Deferred.await(decided))
    expect(decision).toMatchObject({ approved: true, decidedBy: "UOWNER" })
    expect(JSON.parse(await peer.next())).toEqual({ envelope_id: "e-owner" })
    const update = fixture.calls.find((call) => call.method === "chat.update")
    expect(update?.params).toMatchObject({ channel: DM, ts: REPLY_TS, text: "Approved by <@UOWNER>." })

    expect(handled).toEqual(["integration:slack:message", "integration:slack:block_actions"])
    expect(fixture.calls.map((call) => call.method)).toEqual([
      "apps.connections.open",
      "chat.postMessage",
      "chat.getPermalink",
      "chat.update"
    ])
    await Effect.runPromise(Fiber.interrupt(fiber))
  })
})
