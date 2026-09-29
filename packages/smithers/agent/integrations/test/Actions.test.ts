/**
 * The durable actions, executed through the real flow runtime against the real
 * fixture server.
 *
 * A client call and an action are not the same thing. The action has to encode
 * its success into the journal and its failure into a schema, and a plan node
 * has to reach the implementation the layer provides. That round trip is what
 * these tests drive: every case builds a flow whose body is one `.call(...)`,
 * runs it on `FlowEngine.layerMemory`, and asserts on the decoded value, so a
 * result the journal could not carry fails here rather than in production.
 *
 * Nothing is mocked. The clients talk to a `node:http` server over a socket.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, type FlowRuntime, Interpreter } from "@smthrs/flow"
import { Context, Effect, Layer, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { fromIntegrationError, IntegrationFailure, toIntegrationError } from "../src/core/ActionFailure.ts"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import * as GitHubActions from "../src/github/Actions.ts"
import * as GitHubClient from "../src/github/GitHubClient.ts"
import * as LinearActions from "../src/linear/Actions.ts"
import * as LinearClient from "../src/linear/LinearClient.ts"
import * as TelegramActions from "../src/telegram/Actions.ts"
import * as TelegramClient from "../src/telegram/TelegramClient.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

/**
 * Runs one action as the whole body of a durable flow.
 *
 * The flow is what makes this a durable execution rather than a bare Effect:
 * `declaration.call(payload)` records a plan node that demands the action's
 * requirement, and only `declaration.toLayer(...)` answers it.
 */
const runAction = <
  Tag extends string,
  Payload extends Flow.AnyStructSchema & PureSchema,
  Success extends Schema.Top & PureSchema,
  Error extends Schema.Top & PureSchema,
  Clients,
  ClientError
>(
  declaration: Action.Declared<Tag, Payload, Success, Error>,
  // Every service the implementation needs must come from `clients` or the
  // engine, so an action layer that needs something else fails to compile.
  actionLayer: Layer.Layer<Action.Requirement<Tag>, never, NoInfer<Clients> | FlowRuntime.FlowRuntime>,
  payload: Payload["~type.make.in"],
  clients: Layer.Layer<Clients, ClientError>
): Promise<Success["Type"]> => {
  const flow = Flow.make(`${declaration.name}/test-flow`, {
    payload: declaration.payloadSchema,
    success: declaration.successSchema,
    error: declaration.errorSchema,
    // The cast is on the payload value only (decoded Type vs planned make-in); R is untouched.
    body: (input) => declaration.call(input as never)
  })
  const layer = Layer.mergeAll(actionLayer, Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, clients, NodeCrypto.layer))
  )
  // No `orDie`: a failing action must reject with its decoded failure, which
  // is exactly what the failure cases below assert on.
  return Effect.runPromise(
    flow.execute(payload, { executionId: `run-${declaration.name}` }).pipe(Effect.provide(layer), Effect.scoped)
  )
}

/** A schema whose codec needs no services, which every action schema here is. */
type PureSchema = { readonly DecodingServices: never; readonly EncodingServices: never }

class Unprovided extends Context.Service<Unprovided, { readonly value: string }>()(
  "test/integrations/Actions/Unprovided"
) {}

/** Never called; tsc checks it (#2704). */
const unprovidedServiceProbe = () => {
  const payload = { owner: "o", repo: "r", issueNumber: 7, body: "hello" }
  const clients = GitHubClient.layer({ token: "t", apiBaseUrl: "http://127.0.0.1" }, {})
  const needsUnprovided = GitHubActions.CommentOnIssue.toLayer(() =>
    Effect.map(Unprovided, (service) => ({ id: 1, url: service.value }))
  )
  // @ts-expect-error the action layer needs Unprovided, which neither the clients nor the engine provide
  runAction(GitHubActions.CommentOnIssue, needsUnprovided, payload, clients)
  // @ts-expect-error GitHubActions.layer needs GitHubClient, which an empty client layer does not provide
  runAction(GitHubActions.CommentOnIssue, GitHubActions.layer, payload, Layer.empty)
  runAction(GitHubActions.CommentOnIssue, GitHubActions.layer, payload, clients)
}

describe("regression: provide-then-cast test helpers erase layer requirements (#2704)", () => {
  it("rejects an action layer that needs a service the clients do not provide", () => {
    // The assertion is the `@ts-expect-error` directives above.
    expect(unprovidedServiceProbe).toBeTypeOf("function")
  })
})

describe("GitHub actions", () => {
  it("posts a comment and decodes what GitHub returned", async () => {
    fixture = await startFixture((_request, response) => {
      json(response, 201, { id: 42, url: "https://api.github.com/repos/o/r/issues/comments/42", extra: "ignored" })
    })
    const sent = await runAction(
      GitHubActions.CommentOnIssue,
      GitHubActions.layer,
      { owner: "o", repo: "r", issueNumber: 7, body: "hello" },
      GitHubClient.layer({ token: "t", apiBaseUrl: fixture.origin }, {})
    )
    expect(sent).toEqual({ id: 42, url: "https://api.github.com/repos/o/r/issues/comments/42" })
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]?.method).toBe("POST")
    expect(fixture.requests[0]?.url).toBe("/repos/o/r/issues/7/comments")
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}")).toEqual({ body: "hello" })
  })

  it("reports a refusal as an IntegrationFailure the error schema carries", async () => {
    fixture = await startFixture((_request, response) => {
      json(response, 404, { message: "Not Found" })
    })
    const failure = await runAction(
      GitHubActions.CommentOnIssue,
      GitHubActions.layer,
      { owner: "o", repo: "r", issueNumber: 7, body: "hello" },
      GitHubClient.layer({ token: "secret-token", apiBaseUrl: fixture.origin }, {})
    ).then(() => undefined, (error: any) => error)
    // The engine surfaces the failure through the flow's error channel, so the
    // value that comes back is the decoded schema instance, not the class.
    const carried: any = failure?.cause?.error ?? failure?.error ?? failure
    expect(carried).toBeInstanceOf(IntegrationFailure)
    expect(carried.reason).toBe("delivery-failed")
    expect(carried.retryable).toBe(false)
    expect(carried.message).not.toContain("secret-token")
  })

  it("encodes and decodes its failure without losing the reason", () => {
    const failure = new IntegrationFailure({ reason: "permission-denied", message: "no", retryable: false })
    const encoded = Effect.runSync(Schema.encodeEffect(Schema.toCodecJson(IntegrationFailure))(failure))
    const decoded = Effect.runSync(Schema.decodeUnknownEffect(Schema.toCodecJson(IntegrationFailure))(encoded))
    expect(decoded.reason).toBe("permission-denied")
    expect(decoded.retryable).toBe(false)
    expect(decoded._tag).toBe("/integrations/IntegrationFailure")
  })
})

describe("Linear actions", () => {
  it("resolves the team by key and files the issue", async () => {
    fixture = await startFixture((request, response) => {
      const body = JSON.parse(request.body) as { query: string }
      if (body.query.includes("teams")) {
        json(response, 200, { data: { teams: { nodes: [{ id: "team-1", key: "ENG", name: "Eng" }] } } })
        return
      }
      json(response, 200, {
        data: {
          issueCreate: {
            success: true,
            issue: { id: "i1", identifier: "ENG-1", title: "Ship it", url: "https://linear.app/i/ENG-1" }
          }
        }
      })
    })
    const issue = await runAction(
      LinearActions.CreateIssue,
      LinearActions.layer,
      { title: "Ship it", teamKey: "ENG" },
      LinearClient.layer({ apiKey: "k", apiBaseUrl: fixture.origin }, {})
    )
    expect(issue).toEqual({ id: "i1", identifier: "ENG-1", title: "Ship it", url: "https://linear.app/i/ENG-1" })
    expect(fixture.requests.length).toBeGreaterThanOrEqual(2)
  })

  it("reports a GraphQL refusal as an IntegrationFailure", async () => {
    fixture = await startFixture((_request, response) => {
      json(response, 200, { errors: [{ message: "Team not found" }] })
    })
    const failure = await runAction(
      LinearActions.CreateIssue,
      LinearActions.layer,
      { title: "Ship it", teamId: "team-1" },
      LinearClient.layer({ apiKey: "api-key-value", apiBaseUrl: fixture.origin }, {})
    ).then(() => undefined, (error: any) => error)
    const carried: any = failure?.cause?.error ?? failure?.error ?? failure
    expect(carried).toBeInstanceOf(IntegrationFailure)
    expect(carried.message).not.toContain("api-key-value")
  })
})

describe("Telegram actions", () => {
  it("sends a message and reports every chunk id", async () => {
    let messageId = 100
    fixture = await startFixture((request, response) => {
      if (request.url.endsWith("/sendChatAction")) {
        json(response, 200, { ok: true, result: true })
        return
      }
      json(response, 200, { ok: true, result: { message_id: ++messageId, chat: { id: 55 } } })
    })
    const sent = await runAction(
      TelegramActions.SendMessage,
      TelegramActions.layer,
      { chatId: "55", text: "hello" },
      TelegramClient.layer({ botToken: "1:abc", apiBaseUrl: fixture.origin })
    )
    expect(sent.chatId).toBe("55")
    expect(sent.messageIds).toEqual([101])
    expect(sent.chunkCount).toBe(1)
    expect(sent.usedPlainTextFallback).toBe(false)
  })

  it("forwards the optional send fields it was given", async () => {
    fixture = await startFixture((request, response) => {
      if (request.url.endsWith("/sendChatAction")) {
        json(response, 200, { ok: true, result: true })
        return
      }
      json(response, 200, { ok: true, result: { message_id: 7, chat: { id: 55 } } })
    })
    await runAction(
      TelegramActions.SendMessage,
      TelegramActions.layer,
      { chatId: "55", text: "hello", parseMode: "none", messageThreadId: 9, disableNotification: true },
      TelegramClient.layer({ botToken: "1:abc", apiBaseUrl: fixture.origin })
    )
    const send = fixture.requests.find((request) => request.url.endsWith("/sendMessage"))
    const body = JSON.parse(send?.body ?? "{}")
    expect(body.message_thread_id).toBe(9)
    expect(body.disable_notification).toBe(true)
    // `parseMode: "none"` means raw text, so no parse mode reaches Telegram.
    expect(body.parse_mode).toBeUndefined()
  })

  it("reports a Bot API refusal as an IntegrationFailure with the token gone", async () => {
    fixture = await startFixture((request, response) => {
      if (request.url.endsWith("/sendChatAction")) {
        json(response, 200, { ok: true, result: true })
        return
      }
      json(response, 400, { ok: false, error_code: 400, description: "Bad Request: chat not found" })
    })
    const failure = await runAction(
      TelegramActions.SendMessage,
      TelegramActions.layer,
      { chatId: "55", text: "hello" },
      TelegramClient.layer({ botToken: "1:supersecret", apiBaseUrl: fixture.origin })
    ).then(() => undefined, (error: any) => error)
    const carried: any = failure?.cause?.error ?? failure?.error ?? failure
    expect(carried).toBeInstanceOf(IntegrationFailure)
    expect(carried.message).not.toContain("supersecret")
  })
})

describe("IntegrationFailure conversions", () => {
  it("carries the reason and retryability across from the class", () => {
    const failure = fromIntegrationError(
      new IntegrationError("poll-failed", "long poll failed", { retryable: true })
    )
    expect(failure.reason).toBe("poll-failed")
    expect(failure.retryable).toBe(true)
    expect(failure.message).toBe("long poll failed")
  })

  it("reports a failure from outside the clients as a non-retryable delivery-failed", () => {
    expect(fromIntegrationError(new Error("socket hang up"))).toMatchObject({
      reason: "delivery-failed",
      message: "socket hang up",
      retryable: false
    })
    expect(fromIntegrationError("not an error")).toMatchObject({
      reason: "delivery-failed",
      message: "not an error"
    })
  })

  it("converts back to the class a caller can map to the control plane", () => {
    const error = toIntegrationError(
      new IntegrationFailure({ reason: "permission-denied", message: "no scope", retryable: false })
    )
    expect(error).toBeInstanceOf(IntegrationError)
    expect(error.reason).toBe("permission-denied")
    expect(error.summary).toBe("no scope")
    expect(error.details).toMatchObject({ reason: "permission-denied", retryable: false })
  })
})

describe("what an action journals", () => {
  // The package promises every failure carries a machine-readable reason.
  // `TelegramApiError` is not an `IntegrationError`, so before the adapter
  // every Telegram failure journaled as an unclassified, non-retryable
  // `delivery-failed`: an exhausted rate limit was indistinguishable from a
  // chat that does not exist.
  const telegramFailure = async (status: number, body: Record<string, unknown>) => {
    fixture = await startFixture((request, response) => {
      if (request.url.endsWith("/sendChatAction")) {
        json(response, 200, { ok: true, result: true })
        return
      }
      json(response, status, body)
    })
    const failure = await runAction(
      TelegramActions.SendMessage,
      TelegramActions.layer,
      { chatId: "55", text: "hello" },
      TelegramClient.layer({ botToken: "1:abc", apiBaseUrl: fixture.origin }, {})
    ).then(() => undefined, (error: any) => error)
    const carried: any = failure?.cause?.error ?? failure?.error ?? failure
    await fixture.close()
    fixture = undefined
    return carried
  }

  it("classifies an exhausted rate limit as retryable", async () => {
    const carried = await telegramFailure(429, {
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 0 }
    })
    expect(carried).toBeInstanceOf(IntegrationFailure)
    expect(carried.reason).toBe("delivery-failed")
    expect(carried.retryable).toBe(true)
  })

  it("distinguishes a chat that does not exist from a permission problem", async () => {
    const notFound = await telegramFailure(400, {
      ok: false,
      error_code: 400,
      description: "Bad Request: chat not found"
    })
    expect(notFound.reason).toBe("decode-failed")
    expect(notFound.retryable).toBe(false)

    const blocked = await telegramFailure(403, {
      ok: false,
      error_code: 403,
      description: "Forbidden: bot was blocked by the user"
    })
    expect(blocked.reason).toBe("permission-denied")
    expect(blocked.retryable).toBe(false)
  })

  // `owner`/`repo` become the request path, and `new URL` resolves `..`, so an
  // unvalidated payload used to walk the token-bearing POST to another GitHub
  // endpoint. The payload schema stops it before any request is made.
  it("refuses a GitHub comment payload that would leave the endpoint", async () => {
    fixture = await startFixture((_request, response) => json(response, 201, { id: 1, url: "https://x" }))
    await runAction(
      GitHubActions.CommentOnIssue,
      GitHubActions.layer,
      { owner: "..", repo: "..", issueNumber: 1, body: "hello" },
      GitHubClient.layer({ token: "t", apiBaseUrl: fixture.origin }, {})
    ).then(() => undefined, (error: unknown) => error)
    expect(fixture.requests).toHaveLength(0)
  })
})

describe("a partial or ambiguous outcome reaches the journal", () => {
  // The ids exist on the client error, but the journal is what an operator
  // reads after a restart. If they stop at the action boundary the typed
  // partial outcome does not exist where it is needed.
  it("names the chunks a failed multi-chunk send already delivered", async () => {
    let calls = 0
    fixture = await startFixture((request, response) => {
      if (request.url.endsWith("/sendChatAction")) {
        json(response, 200, { ok: true, result: true })
        return
      }
      calls += 1
      if (calls === 1) {
        json(response, 200, { ok: true, result: { message_id: 101 } })
        return
      }
      json(response, 400, { ok: false, error_code: 400, description: "Bad Request: chat not found" })
    })
    const failure = await runAction(
      TelegramActions.SendMessage,
      TelegramActions.layer,
      { chatId: "55", text: "a".repeat(4200) },
      TelegramClient.layer({ botToken: "1:abc", apiBaseUrl: fixture.origin }, {})
    ).then(() => undefined, (error: any) => error)
    const carried: any = failure?.cause?.error ?? failure?.error ?? failure
    expect(carried).toBeInstanceOf(IntegrationFailure)
    expect(carried.deliveredMessageIds).toEqual([101])
    // A 400 is a refusal, so the send's outcome is not in doubt: the field
    // stays absent rather than saying "false" on every ordinary failure.
    expect(carried.outcomeUnknown).toBeUndefined()
  })

  // "This did not happen" and "nobody knows" are different answers, and an
  // operator deciding whether to run the step again needs the difference.
  it("says when a write's outcome is unknown", async () => {
    fixture = await startFixture((_request, response) => json(response, 502, { message: "bad gateway" }))
    const failure = await runAction(
      GitHubActions.CommentOnIssue,
      GitHubActions.layer,
      { owner: "o", repo: "r", issueNumber: 7, body: "hello" },
      GitHubClient.layer({ token: "t", apiBaseUrl: fixture.origin }, {})
    ).then(() => undefined, (error: any) => error)
    const carried: any = failure?.cause?.error ?? failure?.error ?? failure
    expect(carried).toBeInstanceOf(IntegrationFailure)
    expect(carried.outcomeUnknown).toBe(true)
    // Exactly one attempt: the client did not repeat the write.
    expect(fixture.requests).toHaveLength(1)
  })

  it("leaves the field absent for a failure that definitely did not happen", async () => {
    fixture = await startFixture((_request, response) => json(response, 404, { message: "Not Found" }))
    const failure = await runAction(
      GitHubActions.CommentOnIssue,
      GitHubActions.layer,
      { owner: "o", repo: "r", issueNumber: 7, body: "hello" },
      GitHubClient.layer({ token: "t", apiBaseUrl: fixture.origin }, {})
    ).then(() => undefined, (error: any) => error)
    const carried: any = failure?.cause?.error ?? failure?.error ?? failure
    expect(carried.outcomeUnknown).toBeUndefined()
  })

  it("round-trips both fields through the journal codec", () => {
    const failure = new IntegrationFailure({
      reason: "delivery-failed",
      message: "partial",
      retryable: false,
      outcomeUnknown: true,
      deliveredMessageIds: [101, 102]
    })
    const encoded = Effect.runSync(Schema.encodeEffect(Schema.toCodecJson(IntegrationFailure))(failure))
    const decoded = Effect.runSync(Schema.decodeUnknownEffect(Schema.toCodecJson(IntegrationFailure))(encoded))
    expect(decoded.outcomeUnknown).toBe(true)
    expect(decoded.deliveredMessageIds).toEqual([101, 102])
    // And the class conversion keeps them.
    expect(toIntegrationError(decoded).details).toMatchObject({
      outcomeUnknown: true,
      deliveredMessageIds: [101, 102]
    })
  })
})
