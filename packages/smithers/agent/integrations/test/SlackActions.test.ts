/**
 * The durable Slack actions and the connection resolver they reach Slack
 * through, run on the real flow runtime against the real fixture server.
 *
 * A post is irreversible and Slack takes no idempotency key, so the cases
 * that matter are the ones where the answer is lost: the post is sent once,
 * the failure says `outcomeUnknown`, and `Reconcile` finds the key the post
 * stamped into its metadata.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Credential from "@smthrs/control/Credential"
import * as SqlCredentialStore from "@smthrs/control/SqlCredentialStore"
import * as WebCryptoCipher from "@smthrs/control/WebCryptoCipher"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Redacted, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { IntegrationFailure } from "../src/core/ActionFailure.ts"
import { type Connection, personalPolicy } from "../src/core/Connection.ts"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import * as Actions from "../src/slack/Actions.ts"
import * as Connections from "../src/slack/Connections.ts"
import * as IssueSync from "../src/slack/IssueSync.ts"
import { type ApiCall, type ApiHandler, ok, refuse, type SlackFixture, startSlackFixture } from "./SlackFixture.ts"

const BOT = "xoxb-fixture-bot-token"

let fixture: SlackFixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const start = async (api: ApiHandler): Promise<SlackFixture> => {
  fixture = await startSlackFixture(api)
  return fixture
}

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  id: "workspace",
  provider: "slack",
  label: "Workspace",
  credential: { id: "slack-bot", name: "Slack bot token" },
  scopes: ["chat:write"],
  personal: false,
  containers: ["C0001"],
  apiBaseUrl: (fixture as SlackFixture).apiBaseUrl,
  ...overrides
})

const bot = () => ({ bot: { token: Effect.succeed(Redacted.make(BOT)), invalidate: Effect.void } })

const connections = (overrides: Partial<Connection> = {}) => {
  const target = connection(overrides)
  return Connections.layer([{ connection: target, client: Connections.clientFor(target, bot(), { maxRetries: 0 }) }])
}

/** Every action tag {@link Actions.layer} implements. */
type SlackTag = Layer.Success<typeof Actions.layer> extends Action.Requirement<infer Tag> ? Tag : never

/** A schema whose codec needs no services, which every Slack action schema is. */
type PureSchema = { readonly DecodingServices: never; readonly EncodingServices: never }

/** Runs `flow` against the Slack actions, with `resolver` answering which connection is which. */
const runFlow = <
  FlowTag extends string,
  Payload extends Flow.AnyStructSchema & PureSchema,
  Success extends Schema.Top & PureSchema,
  Error extends Schema.Top & PureSchema,
  Tag extends SlackTag
>(
  flow: Flow.Flow<FlowTag, Payload, Success, Error, Action.Requirement<Tag>>,
  payload: Payload["~type.make.in"],
  resolver: Layer.Layer<Connections.SlackConnections, IntegrationError> = connections()
): Promise<Success["Type"]> => {
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
  return Effect.runPromise(
    flow.execute(payload, { executionId: `run-${flow._tag}` }).pipe(Effect.provide(layer), Effect.scoped)
  )
}

/** Runs one action as the whole body of a durable flow. */
const runAction = <
  Tag extends SlackTag,
  Payload extends Flow.AnyStructSchema & PureSchema,
  Success extends Schema.Top & PureSchema,
  Error extends Schema.Top & PureSchema
>(
  declaration: Action.Declared<Tag, Payload, Success, Error>,
  payload: Payload["~type.make.in"],
  resolver: Layer.Layer<Connections.SlackConnections, IntegrationError> = connections()
): Promise<Success["Type"]> =>
  runFlow(
    Flow.make(`${declaration.name}/test-flow`, {
      payload: declaration.payloadSchema,
      success: declaration.successSchema,
      error: declaration.errorSchema,
      // The cast is on the payload value only (decoded Type vs planned make-in); R is untouched.
      body: (input) => declaration.call(input as never)
    }),
    payload,
    resolver
  )

/** An action nothing in {@link runFlow}'s layer implements. */
const Unprovided = Action.make("test/integrations/SlackActions/Unprovided", { payload: {} })

/** Never called; tsc checks it (#2704). */
const unprovidedServiceProbe = () => {
  // @ts-expect-error Actions.layer does not implement the Unprovided action
  runAction(Unprovided, {})
  runAction(Actions.DeleteMessage, { connectionId: "workspace", channel: "C0001", ts: "1.2" })
}

describe("regression: provide-then-cast test helpers erase layer requirements (#2704)", () => {
  it("rejects an action the Slack layer does not implement", () => {
    // The assertion is the `@ts-expect-error` directive above.
    expect(unprovidedServiceProbe).toBeTypeOf("function")
  })
})

/** The decoded `IntegrationFailure` a failed action carries. */
const failed = (promise: Promise<unknown>): Promise<any> =>
  promise.then(
    () => {
      throw new Error("expected the action to fail")
    },
    (error: any) => error?.cause?.error ?? error?.error ?? error
  )

const calls = (method: string): ReadonlyArray<ApiCall> =>
  (fixture as SlackFixture).calls.filter((call) => call.method === method)

const stamped = (ts: string, key: string) => ({ ts, metadata: Actions.metadata(key) })

describe("Connections", () => {
  it("resolves a granted channel, and refuses an unknown connection or an unlisted channel", async () => {
    await start((_call, response) => ok(response))
    const target = connection()
    const resolver = Connections.make([{ connection: target, client: Connections.clientFor(target, bot()) }])
    expect(Exit.isSuccess(await Effect.runPromise(Effect.exit(resolver.resolve("workspace", "C0001"))))).toBe(true)
    const unknown = await Effect.runPromise(Effect.flip(resolver.resolve("other", "C0001")))
    expect(unknown).toMatchObject({ reason: "permission-denied", details: { connectionId: "other" } })
    const unlisted = await Effect.runPromise(Effect.flip(resolver.resolve("workspace", "C0002")))
    expect(unlisted).toMatchObject({ reason: "permission-denied", details: { channel: "C0002" } })
  })

  it("admits every channel under the \"*\" wildcard, and nothing under an empty list", async () => {
    await start((_call, response) => ok(response))
    const any = connection({ containers: ["*"] })
    const none = connection({ id: "none", containers: [] })
    const resolver = Connections.make([
      { connection: any, client: Connections.clientFor(any, bot()) },
      { connection: none, client: Connections.clientFor(none, bot()) }
    ])
    for (const channel of ["C0001", "C0009", "D0OWNER"]) {
      expect(Exit.isSuccess(await Effect.runPromise(Effect.exit(resolver.resolve("workspace", channel))))).toBe(true)
    }
    expect(Exit.isFailure(await Effect.runPromise(Effect.exit(resolver.resolve("none", "C0001"))))).toBe(true)
  })

  it("refuses a connection of another provider or a duplicated id, as a typed layer failure", async () => {
    await start((_call, response) => ok(response))
    const target = connection()
    const client = Connections.clientFor(target, bot())
    expect(() => Connections.make([{ connection: connection({ provider: "github" }), client }])).toThrow(/distinct/)
    const duplicated = Connections.layer([{ connection: target, client }, { connection: target, client }])
    const error = await Effect.runPromise(Effect.flip(Layer.build(duplicated).pipe(Effect.scoped)))
    expect(error).toMatchObject({ reason: "invalid-config", details: { connectionId: "workspace" } })
  })

  it("builds the environment connection from the bot and app tokens, holding them redacted", async () => {
    await start((call, response) => ok(response, { method: call.method }))
    const env = {
      SMITHERS_SLACK_BOT_TOKEN: BOT,
      SMITHERS_SLACK_APP_TOKEN: "xapp-env",
      SMITHERS_SLACK_API_BASE_URL: (fixture as SlackFixture).apiBaseUrl
    }
    const resolved = Connections.fromEnvironment({ containers: ["*"], scopes: ["chat:write"] }, env)
    expect(resolved.connection).toMatchObject({
      id: "slack",
      provider: "slack",
      credential: { id: "environment", name: "SMITHERS_SLACK_BOT_TOKEN" },
      scopes: ["chat:write"],
      containers: ["*"],
      personal: false
    })
    expect(JSON.stringify(resolved)).not.toContain(BOT)
    await Effect.runPromise(resolved.client.call("auth.test"))
    await Effect.runPromise(resolved.client.call("apps.connections.open", {}, { auth: "app" }))
    expect((fixture as SlackFixture).calls.map((call) => call.authorization)).toEqual([
      `Bearer ${BOT}`,
      "Bearer xapp-env"
    ])
    // Without an app token the client still posts; only Socket Mode needs one.
    const botOnly = Connections.fromEnvironment({ connectionId: "main", containers: ["C0001"] }, {
      SMITHERS_SLACK_BOT_TOKEN: BOT
    })
    expect(botOnly.connection).toMatchObject({ id: "main", apiBaseUrl: "https://slack.com/api" })
    const noApp = await Effect.runPromise(
      Effect.flip(botOnly.client.call("apps.connections.open", {}, { auth: "app" }))
    )
    expect(noApp.reason).toBe("credentials-missing")
  })

  it("refuses an environment with no bot token, typed at layer build", async () => {
    expect(() => Connections.fromEnvironment({ containers: ["*"] }, {})).toThrow(/SMITHERS_SLACK_BOT_TOKEN/)
    const error = await Effect.runPromise(
      Effect.flip(Layer.build(Connections.layerFromEnvironment({ containers: ["*"] }, {})).pipe(Effect.scoped))
    )
    expect(error).toMatchObject({ reason: "credentials-missing" })
    const built = await Effect.runPromise(
      Effect.gen(function*() {
        const resolver = yield* Connections.SlackConnections
        return yield* Effect.exit(resolver.resolve("slack", "C0001"))
      }).pipe(
        Effect.provide(Connections.layerFromEnvironment({ containers: ["C0001"] }, { SMITHERS_SLACK_BOT_TOKEN: BOT }))
      )
    )
    expect(Exit.isSuccess(built)).toBe(true)
    // A programming error is a defect, not a typed configuration failure.
    const defect = await Effect.runPromise(
      Effect.exit(Layer.build(Connections.layerFromEnvironment(null as never, {})).pipe(Effect.scoped))
    )
    expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true)
  })

  it("resolves each token through the credential broker, after the host policy, at call time", async () => {
    await start((_call, response) => ok(response))
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* SqlCredentialStore.make
        const cipher = yield* WebCryptoCipher.make({ key: Redacted.make(btoa("0123456789abcdef0123456789abcdef")) })
        const credentials = Credential.make({ store, cipher })
        const appCredential = { id: "slack-app", name: "Slack app token" }
        const target = connection({ containers: ["*"] })
        const build = (principal: string, personal = false) =>
          Connections.fromConnection({
            connection: { ...target, personal },
            credentials,
            access: { principal, authorize: personalPolicy({ personalPrincipals: ["assistant"] }) },
            appCredential,
            limits: { maxRetries: 0 }
          })
        // Built before the secrets exist: nothing is read until a call.
        const assistant = build("assistant")
        yield* credentials.create({ ...target.credential, secret: Redacted.make(BOT) })
        yield* credentials.create({ ...appCredential, secret: Redacted.make("xapp-stored") })
        yield* assistant.client.call("auth.test")
        yield* assistant.client.call("apps.connections.open", {}, { auth: "app" })
        const refused = yield* Effect.flip(build("builder", true).client.call("auth.test"))
        const botOnly = Connections.fromConnection({
          connection: target,
          credentials,
          access: { principal: "builder", authorize: () => Effect.succeed(true) }
        })
        const noApp = yield* Effect.flip(botOnly.client.call("apps.connections.open", {}, { auth: "app" }))
        return { refused, noApp }
      }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped, Effect.orDie)
    )
    expect((fixture as SlackFixture).calls.map((call) => call.authorization)).toEqual([
      `Bearer ${BOT}`,
      "Bearer xapp-stored"
    ])
    expect(outcome.refused.reason).toBe("permission-denied")
    expect(outcome.noApp.reason).toBe("credentials-missing")
    expect(() =>
      Connections.fromConnection({
        connection: connection({ provider: "github" }),
        credentials: Credential.makeNoop(),
        access: { principal: "assistant", authorize: () => Effect.succeed(true) }
      })
    ).toThrow(/not a Slack connection/)
  })
})

describe("PostMessage", () => {
  it("replies in a thread, stamps the reconcile key, and reads the permalink", async () => {
    await start((call, response) =>
      call.method === "chat.postMessage"
        ? ok(response, { channel: "C0001", ts: "1700000001.000200" })
        : ok(response, { permalink: "https://example.slack.com/archives/C0001/p1700000001000200" })
    )
    const posted = await runAction(Actions.PostMessage, {
      connectionId: "workspace",
      channel: "C0001",
      text: "On it.",
      threadTs: "1700000000.000100",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "On it." } }],
      key: "run-1/ack"
    })
    expect(posted).toEqual({
      connectionId: "workspace",
      channel: "C0001",
      ts: "1700000001.000200",
      key: "run-1/ack",
      permalink: "https://example.slack.com/archives/C0001/p1700000001000200"
    })
    const [post] = calls("chat.postMessage")
    expect(post?.authorization).toBe(`Bearer ${BOT}`)
    expect(post?.params).toMatchObject({ channel: "C0001", text: "On it.", thread_ts: "1700000000.000100" })
    expect(JSON.parse(post?.params["metadata"] ?? "null")).toEqual({
      event_type: "smithers_message",
      event_payload: { smithers_key: "run-1/ack" }
    })
    expect(JSON.parse(post?.params["blocks"] ?? "null")).toHaveLength(1)
    expect(post?.params).not.toHaveProperty("username")
  })

  it("posts as a role persona with a display name and an icon", async () => {
    await start((call, response) =>
      call.method === "chat.postMessage" ? ok(response, { ts: "1700000001.000200" }) : ok(response, {})
    )
    await runAction(Actions.PostMessage, {
      connectionId: "workspace",
      channel: "C0001",
      text: "Review passed.",
      key: "run-1/review",
      persona: { username: "Checker", iconEmoji: ":white_check_mark:" }
    })
    await runAction(Actions.PostMessage, {
      connectionId: "workspace",
      channel: "C0001",
      text: "Built.",
      key: "run-1/build",
      persona: { username: "Builder", iconUrl: "https://example.test/builder.png" }
    })
    const [first, second] = calls("chat.postMessage")
    expect(first?.params).toMatchObject({ username: "Checker", icon_emoji: ":white_check_mark:" })
    expect(first?.params).not.toHaveProperty("icon_url")
    expect(second?.params).toMatchObject({ username: "Builder", icon_url: "https://example.test/builder.png" })
    expect(second?.params).not.toHaveProperty("icon_emoji")
  })

  it("refuses a persona with two icons, or none of the shapes Slack accepts", () => {
    const decode = Schema.decodeUnknownExit(Actions.Persona)
    expect(Exit.isSuccess(decode({ username: "Lead" }))).toBe(true)
    expect(Exit.isFailure(decode({ username: "Lead", iconEmoji: ":a:", iconUrl: "https://example.test/a.png" })))
      .toBe(true)
    expect(Exit.isFailure(decode({ username: "", iconEmoji: ":a:" }))).toBe(true)
    expect(Exit.isFailure(decode({ username: "Lead", iconEmoji: "a" }))).toBe(true)
    expect(Exit.isFailure(decode({ username: "Lead", iconUrl: "http://example.test/a.png" }))).toBe(true)
    expect(Actions.personaParams(undefined)).toEqual({})
  })

  it("keeps a delivered post a success when the permalink cannot be read", async () => {
    await start((call, response) =>
      call.method === "chat.postMessage" ? ok(response, { ts: "1700000001.000200" }) : refuse(response, "not_found")
    )
    const posted = await runAction(Actions.PostMessage, {
      connectionId: "workspace",
      channel: "C0001",
      text: "hi",
      key: "k"
    })
    expect(posted).toEqual({ connectionId: "workspace", channel: "C0001", ts: "1700000001.000200", key: "k" })
    await start((call, response) =>
      call.method === "chat.postMessage" ? ok(response, { ts: "1700000001.000200" }) : ok(response, { permalink: 7 })
    )
    expect(
      await runAction(Actions.PostMessage, {
        connectionId: "workspace",
        channel: "C0001",
        text: "hi",
        key: "k"
      })
    ).not.toHaveProperty("permalink")
  })

  it("sends a post whose answer was lost exactly once, and says the outcome is unknown", async () => {
    await start((_call, response) => refuse(response, "internal_error", 503))
    const failure = await failed(
      runAction(Actions.PostMessage, { connectionId: "workspace", channel: "C0001", text: "hi", key: "k" })
    )
    expect(failure).toBeInstanceOf(IntegrationFailure)
    expect(failure).toMatchObject({ outcomeUnknown: true, retryable: false })
    expect(calls("chat.postMessage")).toHaveLength(1)
  })

  it("says the outcome is unknown when Slack accepted the post without naming it", async () => {
    await start((_call, response) => ok(response, {}))
    const failure = await failed(
      runAction(Actions.PostMessage, { connectionId: "workspace", channel: "C0001", text: "hi", key: "k" })
    )
    expect(failure).toMatchObject({ reason: "decode-failed", outcomeUnknown: true })
  })

  it("reports a refusal as a known outcome, and an ungranted channel before any request", async () => {
    await start((_call, response) => refuse(response, "missing_scope"))
    const refused = await failed(
      runAction(Actions.PostMessage, { connectionId: "workspace", channel: "C0001", text: "hi", key: "k" })
    )
    expect(refused.reason).toBe("permission-denied")
    expect(refused.outcomeUnknown).not.toBe(true)
    const ungranted = await failed(
      runAction(Actions.PostMessage, { connectionId: "workspace", channel: "C0002", text: "hi", key: "k" })
    )
    expect(ungranted).toMatchObject({ reason: "permission-denied" })
    expect(calls("chat.postMessage")).toHaveLength(1)
  })
})

describe("UpdateMessage", () => {
  it("replaces the text and blocks of a message", async () => {
    await start((_call, response) => ok(response, { ts: "1700000001.000200" }))
    const updated = await runAction(Actions.UpdateMessage, {
      connectionId: "workspace",
      channel: "C0001",
      ts: "1700000001.000200",
      text: "Approved.",
      blocks: []
    })
    expect(updated).toEqual({ connectionId: "workspace", channel: "C0001", ts: "1700000001.000200" })
    expect(calls("chat.update")[0]?.params).toMatchObject({ ts: "1700000001.000200", text: "Approved.", blocks: "[]" })
  })

  it("does not repeat an update whose answer was lost", async () => {
    await start((_call, _response, request) => {
      request.socket.destroy()
    })
    const failure = await failed(
      runAction(Actions.UpdateMessage, { connectionId: "workspace", channel: "C0001", ts: "1.2", text: "x" })
    )
    expect(failure).toMatchObject({ outcomeUnknown: true })
    expect(calls("chat.update")).toHaveLength(1)
  })
})

describe("Reconcile", () => {
  const page = (messages: ReadonlyArray<unknown>, next = "") => ({ messages, response_metadata: { next_cursor: next } })

  it("finds a post by its key across pages, asking for metadata", async () => {
    await start((call, response) =>
      call.params["cursor"] === undefined
        ? ok(response, page([{ ts: "1.1", text: "no metadata" }, stamped("1.2", "other")], "next"))
        : ok(response, page([stamped("1.3", "run-1/ack")]))
    )
    const found = await runAction(Actions.Reconcile, {
      connectionId: "workspace",
      channel: "C0001",
      key: "run-1/ack",
      oldest: "1.0"
    })
    expect(found).toEqual({
      connectionId: "workspace",
      channel: "C0001",
      key: "run-1/ack",
      status: "found",
      ts: "1.3",
      pagesSearched: 2
    })
    const history = calls("conversations.history")
    expect(history[0]?.params).toMatchObject({ include_all_metadata: "true", oldest: "1.0", limit: "200" })
    expect(history[1]?.params).toMatchObject({ cursor: "next" })
  })

  it("answers absent only after the whole window, and inconclusive when the budget ran out", async () => {
    await start((_call, response) => ok(response, page([stamped("1.2", "other")])))
    expect(
      await runAction(Actions.Reconcile, {
        connectionId: "workspace",
        channel: "C0001",
        key: "missing"
      })
    ).toMatchObject({ status: "absent", ts: null, pagesSearched: 1 })
    await start((_call, response) => ok(response, page([], "more")))
    expect(
      await runAction(Actions.Reconcile, {
        connectionId: "workspace",
        channel: "C0001",
        key: "missing",
        maxPages: 2
      })
    ).toMatchObject({ status: "inconclusive", pagesSearched: 2 })
  })

  it("searches a thread's replies when given the thread", async () => {
    await start((_call, response) => ok(response, page([stamped("1.5", "run-1/reply")])))
    const found = await runAction(Actions.Reconcile, {
      connectionId: "workspace",
      channel: "C0001",
      key: "run-1/reply",
      threadTs: "1.1"
    })
    expect(found.status).toBe("found")
    expect(calls("conversations.replies")[0]?.params).toMatchObject({ ts: "1.1" })
  })

  it("fails decode-failed on an answer without messages", async () => {
    await start((_call, response) => ok(response, {}))
    const failure = await failed(
      runAction(Actions.Reconcile, { connectionId: "workspace", channel: "C0001", key: "k" })
    )
    expect(failure.reason).toBe("decode-failed")
    expect(failure.outcomeUnknown).not.toBe(true)
  })
})

describe("message parity", () => {
  it("deletes only once through the irreversible action", async () => {
    await start((_call, response) => ok(response))
    const result = await runAction(Actions.DeleteMessage, {
      connectionId: "workspace",
      channel: "C0001",
      ts: "100.000001"
    })
    expect(result).toMatchObject({ ts: "100.000001" })
    expect(calls("chat.delete")).toHaveLength(1)
  })
  it("records missing reactions scope as unsupported", async () => {
    await start((_call, response) => refuse(response, "missing_scope"))
    const result = await runAction(Actions.SetReaction, {
      connectionId: "workspace",
      channel: "C0001",
      ts: "100.000001",
      name: "eyes",
      active: true
    })
    expect(result).toEqual({ status: "unsupported" })
    expect(calls("reactions.add")).toHaveLength(1)
  })
})

it.each(
  [
    [true, undefined, "applied"],
    [false, undefined, "applied"],
    [true, "already_reacted", "applied"],
    [false, "no_reaction", "applied"],
    [false, "missing_scope", "unsupported"]
  ] as const
)("settles reaction active=%s error=%s", async (active, code, status) => {
  await start((_call, response) => code === undefined ? ok(response) : refuse(response, code))
  expect(
    await runAction(Actions.SetReaction, {
      connectionId: "workspace",
      channel: "C0001",
      ts: "100.000001",
      name: "eyes",
      active
    })
  ).toEqual({ status })
  expect(calls(active ? "reactions.add" : "reactions.remove")).toHaveLength(1)
})
it.each([true, false])("preserves reaction failures active=%s", async (active) => {
  await start((_call, response) => refuse(response, "channel_not_found"))
  expect(
    await failed(runAction(Actions.SetReaction, {
      connectionId: "workspace",
      channel: "C0001",
      ts: "100.000001",
      name: "eyes",
      active
    }))
  ).toMatchObject({ reason: "delivery-failed" })
})
it("accepts an already deleted message and retains real deletion failures", async () => {
  let code = "message_not_found"
  await start((_call, response) => refuse(response, code))
  const payload = { connectionId: "workspace", channel: "C0001", ts: "100.000001" }
  expect(await runAction(Actions.DeleteMessage, payload)).toMatchObject({ ts: payload.ts })
  code = "cant_delete_message"
  expect((await failed(runAction(Actions.DeleteMessage, payload))).outcomeUnknown).not.toBe(true)
  expect(calls("chat.delete")).toHaveLength(2)
})

it("executes all registered issue transport flows through the existing action runtime", async () => {
  await start((call, response) =>
    ok(
      response,
      call.method === "conversations.replies" ? { messages: [stamped("100.000001", "key")] } : { ts: "100.000001" }
    )
  )
  const common = {
    connectionId: "workspace",
    channel: "C0001",
    ts: "100.000001",
    text: "hi",
    key: "key",
    threadTs: "100.000001",
    name: "eyes",
    active: true
  }
  await runFlow(IssueSync.Post, common)
  await runFlow(IssueSync.Update, common)
  await runFlow(IssueSync.Delete, common)
  await runFlow(IssueSync.React, common)
  await runFlow(IssueSync.Reconcile, common)
  expect((fixture as SlackFixture).calls.map((c) => c.method)).toEqual([
    "chat.postMessage",
    "chat.getPermalink",
    "chat.update",
    "chat.delete",
    "reactions.add",
    "conversations.replies"
  ])
})
