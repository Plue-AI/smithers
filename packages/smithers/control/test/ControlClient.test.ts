import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Journal } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Cause, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { readFileSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import * as ControlClient from "../src/ControlClient.ts"
import { type ControlError, PersistenceError, RunNotFound, TransportError, Unauthorized } from "../src/ControlError.ts"
import * as ControlRpcs from "../src/ControlRpcs.ts"
import * as ControlServer from "../src/ControlServer.ts"
import { delegateApproval } from "./ApprovalFixtures.ts"
import * as TestStack from "./TestStack.ts"

const token = "control-client-secret"

const auth = ControlRpcs.layerBearerAuth({
  token,
  principal: { id: "remote-operator", kind: "bearer" },
  now: () => 1
})

const served = (
  authentication: Layer.Layer<ControlRpcs.ControlAuth> = auth,
  notifications?: Layer.Layer<NotificationQueue.NotificationQueue>
) =>
  HttpRouter.serve(
    ControlServer.layerHttp.pipe(
      Layer.provide(authentication),
      Layer.provide(RpcSerialization.layerNdjson)
    ),
    { disableListenLog: true, disableLogger: true }
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(
      TestStack.live({
        ...(notifications === undefined ? {} : { notifications }),
        runtime: TestStack.memoryRuntime({
          approvalAuthority: delegateApproval({ id: "remote-operator", kind: "bearer" })
        })
      })
    )
  )

const baseUrl = Effect.map(HttpServer.HttpServer, (server) => {
  if (server.address._tag !== "InetAddressV4") throw new Error("expected a TCP control server")
  return `http://127.0.0.1:${server.address.port}`
})

const client = (url: string, credential?: string | undefined) =>
  ControlClient.layer(credential === undefined ? { url: `${url}/rpc` } : { url: `${url}/rpc`, credential }).pipe(
    Layer.provide([
      NodeHttpClient.layerUndici,
      NodeSocket.layerWebSocket(`${url.replace("http://", "ws://")}/rpc/ws`),
      RpcSerialization.layerNdjson
    ])
  )

const withClient = <A, E>(
  url: string,
  credential: string | undefined,
  use: (control: Control["Service"]) => Effect.Effect<A, E>
) =>
  Effect.gen(function*() {
    const control = yield* Control
    return yield* use(control)
  }).pipe(Effect.provide(client(url, credential)))

const run = <A, E>(effect: Effect.Effect<A, E, HttpServer.HttpServer>) =>
  Effect.runPromise(effect.pipe(Effect.provide(served()), Effect.scoped))

const transport = (error: unknown): TransportError => {
  expect(error).toBeInstanceOf(TransportError)
  return error as TransportError
}

const closedPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("expected an ephemeral TCP port"))
        return
      }
      server.close((cause) => cause === undefined ? resolve(address.port) : reject(cause))
    })
  })

const rawServer = (status: number, body: string): Promise<{
  readonly url: string
  readonly close: () => Promise<void>
}> =>
  new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.statusCode = status
      response.setHeader("content-type", "application/x-ndjson")
      response.end(body)
    })
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("expected an ephemeral TCP port"))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((closed, failed) => server.close((cause) => cause === undefined ? closed() : failed(cause)))
      })
    })
  })

const calls = (control: Control["Service"]): Record<keyof Control["Service"], Effect.Effect<unknown, ControlError>> => {
  const approval = {
    target: {
      _tag: "Plan" as const,
      planId: "missing-plan",
      digest: "digest",
      envelope: { capabilities: [], flows: [], budget: {} }
    },
    scope: "once" as const,
    idempotencyKey: "approval-missing"
  }
  const mutation = { runId: "missing-run", idempotencyKey: "mutation-missing" }
  return {
    plan: control.plan({ flowId: "system/test", input: {} }),
    run: control.run({ _tag: "Resume", ...mutation }),
    approve: control.approve(approval),
    deny: control.deny(approval),
    steer: control.steer({
      ...mutation,
      message: {
        messageId: "message-missing",
        runId: mutation.runId,
        principal: { id: "client", kind: "test", stampedAt: 0 },
        createdAt: 0,
        body: "continue"
      }
    }),
    signal: control.signal({ ...mutation, signal: { name: "continue", payload: null } }),
    cancel: control.cancel(mutation),
    resume: control.resume(mutation),
    list: control.list({ _tag: "flows" }),
    watch: Stream.runCollect(control.watch({ follow: false }))
  }
}

describe("ControlClient", () => {
  it("declares transport and authentication failures on every operation", () => {
    type Errors<T> = T extends Effect.Effect<infer _A, infer E, infer _R> ? E
      : T extends Stream.Stream<infer _A, infer E, infer _R> ? E
      : never
    const boundaryErrors: {
      [K in keyof Control["Service"]]: TransportError | Unauthorized extends Errors<ReturnType<Control["Service"][K]>>
        ? true
        : false
    } = {
      plan: true,
      run: true,
      approve: true,
      deny: true,
      steer: true,
      signal: true,
      cancel: true,
      resume: true,
      list: true,
      watch: true
    }
    expect(Object.values(boundaryErrors)).toEqual(Array(10).fill(true))
  })

  it("authenticates watch with the RPC guide's client composition", async () => {
    const guide = readFileSync(new URL("../docs/guides/serve-over-rpc.md", import.meta.url), "utf8")
    const example = guide.split("## Connect a client")[1]?.match(/```ts\n([\s\S]*?)```/)?.[1]
    if (example === undefined) throw new Error("missing RPC guide client example")
    const events = await run(Effect.gen(function*() {
      const url = yield* baseUrl
      const source = example.replace(/^import .*$/gm, "")
        .replaceAll("127.0.0.1:4000", new URL(url).host)
      const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
      const guideClient: ReturnType<typeof client> = new Function(
        "NodeHttpClient",
        "NodeSocket",
        "ControlClient",
        "Layer",
        "RpcSerialization",
        "Socket",
        "process",
        `${compiled}\nreturn client`
      )(NodeHttpClient, NodeSocket, ControlClient, Layer, RpcSerialization, Socket, {
        env: { SMITHERS_CONTROL_TOKEN: token }
      })
      return yield* Effect.gen(function*() {
        const control = yield* Control
        yield* control.plan({ flowId: "system/test", input: { source: "guide" } })
        return yield* Stream.runCollect(control.watch({ follow: false }))
      }).pipe(Effect.provide(guideClient))
    }))
    expect(events.length).toBeGreaterThan(0)
  })

  const methods = ["plan", "run", "approve", "deny", "steer", "signal", "cancel", "resume", "list", "watch"] as const

  it.each(methods)("surfaces a typed Unauthorized from %s", async (method) => {
    const error = await run(Effect.gen(function*() {
      const url = yield* baseUrl
      return yield* withClient(url, "wrong-token", (control) => Effect.flip(calls(control)[method]))
    }))
    expect(error).toBeInstanceOf(Unauthorized)
    expect(error.code).toBe("unauthorized")
  })

  it.each(methods)("surfaces a typed TransportError from %s", async (method) => {
    const port = await closedPort()
    const error = await Effect.runPromise(
      withClient(`http://127.0.0.1:${port}`, token, (control) => Effect.flip(calls(control)[method])).pipe(
        Effect.scoped
      )
    )
    expect(error).toBeInstanceOf(TransportError)
    if (!(error instanceof TransportError)) throw new Error("expected a transport failure")
    expect(error.retryable).toBe(true)
    expect(error.code).toBe("transport_error")
  })

  it("completes a unary round trip through the real HTTP server", async () => {
    const listed = await run(Effect.gen(function*() {
      const url = yield* baseUrl
      return yield* withClient(url, token, (control) => control.list({ _tag: "flows" }))
    }))

    expect(listed._tag).toBe("flows")
  })

  it("sends the bearer header and preserves an Unauthorized response", async () => {
    const result = await run(Effect.gen(function*() {
      const url = yield* baseUrl
      const refused = yield* withClient(
        url,
        "wrong-token",
        (control) => control.list({ _tag: "flows" }).pipe(Effect.flip)
      )
      const accepted = yield* withClient(url, token, (control) => control.list({ _tag: "flows" }))
      return { accepted, refused }
    }))

    expect(result.refused).toBeInstanceOf(Unauthorized)
    expect(result.accepted._tag).toBe("flows")
  })

  it("preserves a declared control failure", async () => {
    const error = await run(Effect.gen(function*() {
      const url = yield* baseUrl
      return yield* withClient(url, token, (control) =>
        control.run({
          _tag: "Resume",
          runId: "missing-run",
          idempotencyKey: "resume-missing"
        }).pipe(Effect.flip))
    }))

    expect(error).toBeInstanceOf(RunNotFound)
    expect((error as RunNotFound).runId).toBe("missing-run")
  })

  it.each(["notification_closed", "notification_full", "storage"] as const)(
    "preserves %s steering refusal through the authenticated HTTP RPC",
    async (code) => {
      const notifications = NotificationQueue.layerNoop({
        admit: (_runId, notification) =>
          Effect.fail(
            code === "storage"
              ? new Journal.JournalError({ code: "read_failed", message: "storage unavailable" })
              : new NotificationQueue.NotificationError({
                code,
                notificationId: notification.id,
                message: code === "notification_closed"
                  ? "Receiver finished; start a new request"
                  : "Queue full; retry after drain"
              })
          )
      })
      const error = await Effect.runPromise(
        Effect.gen(function*() {
          const url = yield* baseUrl
          return yield* withClient(url, token, (control) =>
            Effect.gen(function*() {
              const card = yield* control.plan({ flowId: "system/test", input: {} })
              yield* control.approve(card.approval)
              const launched = yield* control.run({
                _tag: "Plan",
                planId: card.planId,
                digest: card.digest,
                envelope: card.envelope,
                idempotencyKey: `launch-${code}`
              })
              if (launched._tag !== "Accepted" || launched.runId === undefined) {
                return yield* Effect.die("expected launched run")
              }
              return yield* control.steer({
                runId: launched.runId,
                idempotencyKey: `steer-${code}`,
                message: {
                  runId: launched.runId,
                  messageId: "safe-notification-id",
                  body: "private submitted feedback",
                  createdAt: 0,
                  principal: { kind: "test", id: "untrusted-client", stampedAt: 0 }
                }
              }).pipe(Effect.flip)
            }))
        }).pipe(Effect.provide(served(auth, notifications)), Effect.scoped)
      )
      expect(error).toBeInstanceOf(code === "storage" ? PersistenceError : NotificationQueue.NotificationError)
      expect(error.code).toBe(code === "storage" ? "persistence_failed" : code)
      expect(ControlClient.isControlError(error)).toBe(true)
      if (error instanceof NotificationQueue.NotificationError) {
        expect(error.notificationId).toBe("safe-notification-id")
      }
      expect(JSON.stringify(error)).not.toContain(token)
      expect(JSON.stringify(error)).not.toContain("private submitted feedback")
    }
  )

  it.each(["approve", "deny"] as const)(
    "does not elevate an agent %s through operator RPC credentials",
    async (decision) => {
      await run(Effect.gen(function*() {
        const url = yield* baseUrl
        yield* withClient(url, token, (control) =>
          Effect.gen(function*() {
            const malformed = yield* Effect.flip(control[decision](null as never))
            expect(malformed).toBeInstanceOf(TransportError)
            const card = yield* control.plan({ flowId: "system/test", input: {} })
            const error = yield* Effect.flip(control[decision]({
              ...card.approval,
              scope: "remembered",
              principal: { id: "mcp", kind: "agent", stampedAt: 0 }
            }))
            expect(error).toBeInstanceOf(Unauthorized)
            expect(error.code).toBe("unauthorized")
            const receipt = yield* control[decision]({
              ...card.approval,
              principal: { id: "operator", kind: "operator", stampedAt: 0 }
            })
            expect(receipt._tag).toBe("Accepted")
            expect((yield* control.list({ _tag: "flows" }))._tag).toBe("flows")
          }))
      }))
    }
  )

  it("projects every unary method through its request schema", async () => {
    const tags = await run(Effect.gen(function*() {
      const url = yield* baseUrl
      return yield* withClient(url, token, (control) =>
        Effect.gen(function*() {
          const envelope = { capabilities: [], flows: [], budget: {} }
          const approval = {
            target: { _tag: "Plan" as const, planId: "missing-plan", digest: "digest", envelope },
            scope: "once" as const,
            idempotencyKey: "approval-missing"
          }
          const principal = { id: "client", kind: "test", stampedAt: 0 }
          const errors = yield* Effect.all([
            control.approve(approval).pipe(Effect.flip),
            control.deny({ ...approval, idempotencyKey: "deny-missing" }).pipe(Effect.flip),
            control.steer({
              runId: "missing-run",
              message: {
                messageId: "message-missing",
                runId: "missing-run",
                principal,
                createdAt: 0,
                body: "continue"
              },
              idempotencyKey: "steer-missing"
            }).pipe(Effect.flip),
            control.signal({
              runId: "missing-run",
              signal: { name: "continue", payload: null },
              idempotencyKey: "signal-missing"
            }).pipe(Effect.flip),
            control.cancel({ runId: "missing-run", idempotencyKey: "cancel-missing", reason: "test" }).pipe(
              Effect.flip
            ),
            control.resume({ runId: "missing-run", idempotencyKey: "resume-missing", reason: "test" }).pipe(
              Effect.flip
            )
          ])
          return errors.map((error) => error._tag)
        }))
    }))

    expect(tags).toEqual([
      "/control/PlanNotFound",
      "/control/PlanNotFound",
      "/control/RunNotFound",
      "/control/RunNotFound",
      "/control/RunNotFound",
      "/control/RunNotFound"
    ])
  })

  it("marks a refused connection retryable without exposing the socket message", async () => {
    const port = await closedPort()
    const error = await Effect.runPromise(
      withClient(`http://127.0.0.1:${port}`, token, (control) => control.list({ _tag: "flows" }).pipe(Effect.flip))
        .pipe(Effect.scoped)
    )

    const failure = transport(error)
    expect(failure.retryable).toBe(true)
    expect(failure.message).toBe("The control server could not be reached.")
    expect(failure.cause).toBeDefined()
  })

  it("turns a client request encoding defect into a non-retryable failure", async () => {
    const exit = await run(Effect.gen(function*() {
      const url = yield* baseUrl
      return yield* withClient(
        url,
        token,
        (control) => Effect.exit(control.plan({ flowId: "system/test", input: new Date(0) }))
      )
    }))

    if (exit._tag === "Success") throw new Error("expected request encoding to fail")
    const failure = transport(Cause.squash(exit.cause))
    expect(failure.retryable).toBe(false)
    expect(failure.message).toBe("The control request could not be encoded.")
    expect(failure.cause).toBeDefined()
  })

  it("classifies HTTP 4xx as final and HTTP 5xx as retryable", async () => {
    const clientFailure = await rawServer(400, "bad request")
    const serverFailure = await rawServer(503, "unavailable")
    try {
      const rejected = transport(
        await Effect.runPromise(
          withClient(clientFailure.url, token, (control) => control.list({ _tag: "flows" }).pipe(Effect.flip)).pipe(
            Effect.scoped
          )
        )
      )
      const unavailable = transport(
        await Effect.runPromise(
          withClient(serverFailure.url, token, (control) => control.list({ _tag: "flows" }).pipe(Effect.flip)).pipe(
            Effect.scoped
          )
        )
      )

      expect(rejected.retryable).toBe(false)
      expect(rejected.message).toBe("The control server rejected the HTTP request.")
      expect(unavailable.retryable).toBe(true)
      expect(unavailable.message).toBe("The control server failed while handling the HTTP request.")
    } finally {
      await Promise.all([clientFailure.close(), serverFailure.close()])
    }
  })

  it("classifies an invalid RPC response as a non-retryable decode failure", async () => {
    const malformed = await rawServer(200, "not an RPC response\n")
    try {
      const failure = transport(
        await Effect.runPromise(
          withClient(malformed.url, token, (control) => control.list({ _tag: "flows" }).pipe(Effect.flip)).pipe(
            Effect.scoped
          )
        )
      )

      expect(failure.retryable).toBe(false)
      expect(failure.message).toBe("The control response could not be decoded.")
      expect(failure.cause).toBeDefined()
    } finally {
      await malformed.close()
    }
  })

  it("reports a URL no request can be built from as final", async () => {
    // A misconfigured `--control-url` fails before a byte leaves the process.
    // Retrying it forever would hide the one thing an operator has to fix.
    const failure = transport(
      await Effect.runPromise(
        withClient("not-a-url", token, (control) => control.list({ _tag: "flows" }).pipe(Effect.flip)).pipe(
          Effect.scoped
        )
      )
    )

    expect(failure.retryable).toBe(false)
    expect(failure.message).toBe("The control server URL is invalid.")
  })

  it("classifies an empty 200 body as a non-retryable decode failure", async () => {
    // A proxy that answers 200 with nothing is not a server that failed: the
    // request was delivered and the answer is unreadable, so repeating it
    // reaches the same proxy.
    const empty = await rawServer(200, "")
    try {
      const failure = transport(
        await Effect.runPromise(
          withClient(empty.url, token, (control) => control.list({ _tag: "flows" }).pipe(Effect.flip)).pipe(
            Effect.scoped
          )
        )
      )

      expect(failure.retryable).toBe(false)
      expect(failure.message).toBe("The control response could not be decoded.")
    } finally {
      await empty.close()
    }
  })

  it("refuses a watch filter it cannot encode, before opening a socket", async () => {
    // `watch` is a stream, and its request is encoded on the way in exactly as
    // a unary call's is. A filter the schema refuses has to fail as a final
    // client error rather than as a stream that opens and then dies.
    const exit = await run(Effect.gen(function*() {
      const url = yield* baseUrl
      return yield* withClient(
        url,
        token,
        (control) =>
          Effect.exit(
            Stream.runCollect(control.watch({ runId: 7 as unknown as string, follow: false }))
          )
      )
    }))

    if (exit._tag === "Success") throw new Error("expected the filter to be refused")
    const failure = transport(Cause.squash(exit.cause))
    expect(failure.retryable).toBe(false)
    expect(failure.message).toBe("The control request could not be encoded.")
  })

  it("marks a watch whose socket never opens retryable", async () => {
    // The stream's failures are classified by the same rules the unary calls
    // use, so an operator's retry policy does not have to know which transport
    // a verb travels on.
    const port = await closedPort()
    const failure = transport(
      await Effect.runPromise(
        withClient(
          `http://127.0.0.1:${port}`,
          token,
          (control) => Stream.runCollect(control.watch({ follow: true })).pipe(Effect.flip)
        ).pipe(Effect.scoped)
      )
    )

    expect(failure.retryable).toBe(true)
    expect(failure.message).toBe("The control server could not be reached.")
  })

  it("classifies a transport failure it cannot name, and never retries one", async () => {
    // Everything above is a failure the RPC client itself reported. This is the
    // other kind: whatever the host transport threw. It reaches the caller as a
    // control error rather than a defect, and it is final, because nothing here
    // says the request was safe to send twice.
    const dying = (failure: unknown) =>
      ControlClient.layer({ url: "http://127.0.0.1:1/rpc" }).pipe(
        Layer.provide([
          Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die(failure))),
          NodeSocket.layerWebSocket("ws://127.0.0.1:1/rpc/ws"),
          RpcSerialization.layerNdjson
        ])
      )
    const listedThrough = (failure: unknown) =>
      Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          return yield* Effect.exit(control.list({ _tag: "flows" }))
        }).pipe(Effect.provide(dying(failure) as Layer.Layer<Control>), Effect.scoped)
      )
    const schemaFailure = await Effect.runPromise(
      Effect.flip(Schema.decodeUnknownEffect(Schema.String)(7))
    )

    const unnamed = await listedThrough(new Error("the host transport gave up"))
    const undecodable = await listedThrough(schemaFailure)

    if (unnamed._tag === "Success" || undecodable._tag === "Success") throw new Error("expected both to fail")
    const unnamedFailure = transport(Cause.squash(unnamed.cause))
    const undecodableFailure = transport(Cause.squash(undecodable.cause))
    expect(unnamedFailure.retryable).toBe(false)
    expect(unnamedFailure.message).toBe("The control RPC client failed.")
    // A schema failure is a decode failure wherever it surfaced, and the raw
    // message is kept only in the cause slot.
    expect(undecodableFailure.retryable).toBe(false)
    expect(undecodableFailure.message).toBe("The control response could not be decoded.")
    expect(undecodableFailure.message).not.toContain("7")
  })

  it("leaves an interrupted call interrupted rather than reporting a transport failure", async () => {
    // An operator's Ctrl-C is not the server failing. A cause with no error and
    // no defect is passed through as it is, so the caller's own cancellation
    // stays cancellation all the way out.
    const exit = await run(Effect.gen(function*() {
      const url = yield* baseUrl
      const fiber = yield* withClient(
        url,
        token,
        (control) => control.list({ _tag: "flows" }).pipe(Effect.andThen(Effect.never))
      ).pipe(Effect.forkChild({ startImmediately: true }))
      return yield* Effect.exit(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)), Effect.flatten))
    }))

    if (exit._tag === "Success") throw new Error("expected the interrupted call to fail")
    expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  })

  it("streams watch snapshots over the real WebSocket mount", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function*() {
        const url = yield* baseUrl
        return yield* withClient(url, undefined, (control) =>
          Effect.gen(function*() {
            yield* control.plan({ flowId: "system/test", input: { source: "websocket" } })
            return yield* Stream.runCollect(control.watch({ follow: false }))
          }))
      }).pipe(
        Effect.provide(served(ControlRpcs.layerNoopAuth())),
        Effect.scoped
      )
    )

    expect(events.length).toBeGreaterThan(0)
  })

  /**
   * Cross-site WebSocket hijacking. A browser sends `Origin` on every upgrade
   * and a page on another site cannot forge it, so a proxy that attaches the
   * bearer for the victim must not turn a hostile page into a `Watch` reader.
   */
  it("refuses a WebSocket upgrade or POST whose browser Origin is another site", async () => {
    const status = (url: string, path: string, headers: Record<string, string>, method = "GET") =>
      Effect.callback<number>((resume) => {
        const { port } = new URL(url)
        const request = httpRequest({ host: "127.0.0.1", port, path, method, headers })
        request.on("upgrade", (response, socket) => {
          socket.destroy()
          resume(Effect.succeed(response.statusCode ?? 0))
        })
        request.on("response", (response) => {
          response.resume()
          resume(Effect.succeed(response.statusCode ?? 0))
        })
        request.on("error", (error) => resume(Effect.die(error)))
        request.end(method === "POST" ? "{}" : undefined)
      })
    const upgrade = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      authorization: `Bearer ${token}`
    }
    const result = await run(Effect.gen(function*() {
      const url = yield* baseUrl
      const host = new URL(url).host
      return {
        hostile: yield* status(url, "/rpc/ws", { ...upgrade, origin: "https://evil.example" }),
        spoofedPath: yield* status(url, "//rpc/ws", { ...upgrade, origin: "https://evil.example" }),
        hostilePost: yield* status(url, "/rpc", {
          authorization: `Bearer ${token}`,
          origin: "https://evil.example",
          "content-type": "text/plain"
        }, "POST"),
        sameOrigin: yield* status(url, "/rpc/ws", { ...upgrade, origin: `http://${host}` }),
        noOrigin: yield* status(url, "/rpc/ws", upgrade)
      }
    }))
    expect(result).toEqual({ hostile: 403, spoofedPath: 403, hostilePost: 403, sameOrigin: 101, noOrigin: 101 })
  })
})
