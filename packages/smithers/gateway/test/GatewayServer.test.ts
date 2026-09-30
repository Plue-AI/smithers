/**
 * The assembled HTTP surface, bound to a real loopback socket over a real
 * SQLite control plane.
 *
 * Five of the eight requirements the old `packages/server` suite pinned live
 * here, re-expressed on the rc.0 boundary:
 *
 * - `light-gateway`: `GET /health` answers the workspace identity; an unknown
 *   route is a 404; the bind policy refuses what it must.
 * - `server-resume-lifecycle`: submitting an approval resumes the run it
 *   unblocked, in one call, with no second manual resume.
 * - `index-run-lifecycle-coverage`: a run launched through the served control
 *   plane reaches a terminal status and stays readable there.
 * - `xcombo-child-visibility-gateway`: a child run of a listed parent is
 *   itself listed, and carries the parent it came from.
 * - `serve.startup-recovery`: a gateway whose read path is unavailable still
 *   comes up and still answers `/health`.
 *
 * The keepalive suite pins the release policy item 4 on the socket rather than in
 * the service: a `Watch` a client follows over `/rpc/ws` carries a frame while
 * the run it watches is silent.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { describe, expect, it } from "@effect/vitest"
import * as ApprovalAuthority from "@smthrs/control/ApprovalAuthority"
import { Control } from "@smthrs/control/Control"
import type { Service as ControlService } from "@smthrs/control/Control"
import * as ControlClient from "@smthrs/control/ControlClient"
import { Unavailable } from "@smthrs/control/ControlError"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import { type ApprovalPayload, type PlanCard, RunStatus } from "@smthrs/control/ControlSchema"
import * as ScopedToken from "@smthrs/control/ScopedToken"
import { SyncAuth as SyncAuthTag } from "@smthrs/sync/SyncRpcs"
import * as SyncServer from "@smthrs/sync/SyncServer"
import { Deferred, Effect, Fiber, Layer, Logger, Schema, type Scope, Stream } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { connect } from "node:net"
import { compileFunction } from "node:vm"
import { GatewayError, GatewayErrorCode, type GatewayErrorCode as GatewayErrorCodeValue } from "../src/GatewayError.ts"
import { GatewayRpcs } from "../src/GatewayRpcs.ts"
import * as GatewayServer from "../src/GatewayServer.ts"
import * as NodeGateway from "../src/node/NodeGateway.ts"
import { make as makeProjections, maxProjectionBytes, Projections } from "../src/Projections.ts"
import { defaultCadenceStack, emit, stack } from "./GatewayStack.ts"

const health: GatewayServer.Health = {
  workspaceHash: "workspace-hash",
  gatewayId: "gateway-1",
  protocolVersion: "1",
  version: "1.0.0-rc.0"
}

/** The gateway on an ephemeral loopback port over a real control plane. */
const served = (
  options: NodeGateway.ServerOptions = { host: "127.0.0.1", port: 0 },
  approvalAuthority?: ApprovalAuthority.Service
) => NodeGateway.layer(health, options).pipe(Layer.provideMerge(stack({ approvalAuthority })))

const delegatedBearer = Effect.runSync(ApprovalAuthority.make([
  { principal: { id: "local", kind: "operator" }, scopes: ["once", "run", "remembered"], targets: ["Plan", "Node"] },
  { principal: { id: "gateway", kind: "bearer" }, scopes: ["once", "run", "remembered"], targets: ["Plan", "Node"] }
]))

const baseUrl = Effect.map(HttpServer.HttpServer, (server) => {
  if (server.address._tag !== "InetAddressV4") throw new Error("expected a TCP gateway")
  return `http://127.0.0.1:${server.address.port}`
})

const approvalOf = (card: PlanCard): ApprovalPayload => ({
  target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
  scope: card.approval.scope,
  idempotencyKey: `approve:${card.planId}`
})

const test = <E>(title: string, body: () => Effect.Effect<void, E, Scope.Scope>) =>
  it(title, () => Effect.runPromise(Effect.scoped(body())))

/** One framed RPC message, and the byte limit that admits it and nothing more. */
const exactBody = `${JSON.stringify({ _tag: "Request", id: 1, tag: "NoSuchProcedure", payload: {}, headers: [] })}\n`
const exactBodyBytes = new TextEncoder().encode(exactBody).byteLength

/**
 * One HTTP/1.1 exchange written straight onto a socket.
 *
 * `fetch` owns framing headers: it refuses to set `connection` and `upgrade`,
 * and it rewrites `content-length`. A WebSocket upgrade and an exact body
 * length are exactly what has to be proved here, so the request is written by
 * hand.
 */
const raw = (
  target: string,
  head: ReadonlyArray<string>,
  body = "",
  host?: string
): Promise<{ readonly status: number; readonly body: string }> => {
  const url = new URL(target)
  return new Promise((resolve, reject) => {
    let received = ""
    const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
      const requestHead = head.some((line) => /^host:/i.test(line)) ? head : [...head, `Host: ${host ?? url.host}`]
      socket.write(`${[...requestHead, "", ""].join("\r\n")}${body}`)
    })
    const answer = () => {
      const separator = received.indexOf("\r\n\r\n")
      if (separator < 0) return
      const headers = received.slice(0, separator)
      const payload = received.slice(separator + 4)
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(headers)?.[1] ?? 0)
      const declared = /content-length: (\d+)/i.exec(headers)?.[1]
      // 101 carries no body, and anything else is complete once the bytes it
      // declared have arrived.
      if (status !== 101 && (declared === undefined || payload.length < Number(declared))) return
      socket.destroy()
      resolve({ status, body: payload })
    }
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      received += chunk
      answer()
    })
    socket.on("end", () => resolve({ status: 0, body: received }))
    socket.on("error", reject)
  })
}

/**
 * One authenticated WebSocket exchange, framed by hand.
 *
 * No `ws` package resolves from this package, and Node's global `WebSocket`
 * cannot attach an `Authorization` header to the upgrade request.
 */
const socketExchange = (
  target: string,
  credential: string | undefined,
  payload: string
): Promise<ReadonlyArray<string>> => {
  const url = new URL(target)
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0)
    let upgraded = false
    let finished = false
    const texts: Array<string> = []
    const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
      socket.write([
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ...(credential === undefined ? [] : [`Authorization: Bearer ${credential}`]),
        "",
        ""
      ].join("\r\n"))
    })
    const fail = (error: Error) => {
      if (finished) return
      finished = true
      socket.destroy()
      reject(error)
    }
    const done = () => {
      if (finished) return
      finished = true
      socket.destroy()
      resolve(texts)
    }
    const clientFrame = () => {
      const data = Buffer.from(payload, "utf8")
      const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
      let head: Buffer
      if (data.length < 126) {
        head = Buffer.from([0x81, 0x80 | data.length])
      } else if (data.length <= 0xffff) {
        head = Buffer.alloc(4)
        head[0] = 0x81
        head[1] = 0x80 | 126
        head.writeUInt16BE(data.length, 2)
      } else {
        head = Buffer.alloc(10)
        head[0] = 0x81
        head[1] = 0x80 | 127
        head.writeBigUInt64BE(BigInt(data.length), 2)
      }
      const masked = Buffer.alloc(data.length)
      for (let index = 0; index < data.length; index++) {
        masked[index] = data[index]! ^ mask[index % mask.length]!
      }
      return Buffer.concat([head, mask, masked])
    }
    const read = () => {
      if (!upgraded) {
        const separator = received.indexOf("\r\n\r\n")
        if (separator < 0) return
        const headers = received.subarray(0, separator).toString("utf8")
        const status = Number(/^HTTP\/1\.1 (\d+)/.exec(headers)?.[1] ?? 0)
        if (status !== 101) {
          fail(new Error(`WebSocket upgrade answered ${status}`))
          return
        }
        upgraded = true
        received = received.subarray(separator + 4)
        socket.write(clientFrame())
      }

      while (received.length >= 2) {
        const opcode = received[0]! & 0x0f
        if ((received[1]! & 0x80) !== 0) {
          fail(new Error("WebSocket server sent a masked frame"))
          return
        }
        let length = received[1]! & 0x7f
        let offset = 2
        if (length === 126) {
          if (received.length < 4) return
          length = received.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (received.length < 10) return
          const wideLength = received.readBigUInt64BE(2)
          if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            fail(new Error("WebSocket frame is too large to decode"))
            return
          }
          length = Number(wideLength)
          offset = 10
        }
        if (received.length < offset + length) return
        const data = received.subarray(offset, offset + length)
        received = received.subarray(offset + length)
        if (opcode === 0x8) {
          if (texts.length > 0) done()
          else fail(new Error("WebSocket closed before answering"))
          return
        }
        if (opcode === 0x1 || opcode === 0x2) {
          const text = data.toString("utf8")
          texts.push(text)
          if (text.includes("\"Exit\"")) {
            done()
            return
          }
        }
        // Ping and pong control frames carry no RPC data.
      }
    }
    socket.setTimeout(5_000, () => fail(new Error("WebSocket exchange timed out")))
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      read()
    })
    socket.on("end", () => fail(new Error("WebSocket ended before answering")))
    socket.on("error", fail)
  })
}

/** A control client speaking to the served gateway over real HTTP and WebSocket. */
const client = (url: string, credential?: string | undefined) =>
  ControlClient.layer(credential === undefined ? { url: `${url}/rpc` } : { url: `${url}/rpc`, credential }).pipe(
    Layer.provide([
      NodeHttpClient.layerUndici,
      NodeSocket.layerWebSocket(`${url.replace("http://", "ws://")}/rpc/ws`),
      RpcSerialization.layerNdjson
    ])
  )

/** A projections client speaking to the served `/projections/ws` mount. */
const projectionsClient = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide([
      NodeSocket.layerWebSocket(`${url.replace("http://", "ws://")}/projections/ws`),
      RpcSerialization.layerNdjson
    ])
  )

/** A run that will never move again unless a test emits for it. */
const launched = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "system/test", input: {} })
  yield* control.approve(approvalOf(card))
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: `run:${card.planId}`
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
  return receipt.runId
})

describe("loopback approval credential", () => {
  for (const mount of ["rpc", "projections"] as const) {
    for (const protocol of ["http", "ws"] as const) {
      for (const decision of ["approve", "deny"] as const) {
        test(`${mount}/${protocol} ${decision} requires the session token`, () =>
          Effect.gen(function*() {
            const url = yield* baseUrl
            const control = yield* Control
            const runtime = yield* ControlRuntime
            const card = yield* control.plan({ flowId: "system/test", input: {} })
            const payload = {
              ...card.approval,
              ...(mount === "projections" ? { decision } : {}),
              principal: { id: "local", kind: "operator", stampedAt: 0 }
            }
            const request = JSON.stringify({
              _tag: "Request",
              id: 1,
              tag: mount === "projections" ? "Approval.Submit" : decision === "approve" ? "Approve" : "Deny",
              payload,
              headers: []
            }) + "\n"
            const exchange = (credential?: string) =>
              Effect.promise(async () => {
                const frames = protocol === "ws"
                  ? await socketExchange(`${url}/${mount}/ws`, credential, request)
                  : [
                    await (await fetch(`${url}/${mount}`, {
                      method: "POST",
                      headers: {
                        ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
                        "content-type": "application/json"
                      },
                      body: request
                    })).text()
                  ]
                return frames.join("\n")
              })
            // An uncredentialed read stays available, even if a decision is pending.
            const listed = yield* control.list({ _tag: "flows" }).pipe(Effect.provide(client(url)))
            expect(listed).toBeDefined()
            for (const credential of [undefined, "wrong"]) {
              const reply = yield* exchange(credential)
              expect(reply).toContain("/control/Unauthorized")
              expect((yield* runtime.getPlan(card.planId)).decision).toBe("pending")
            }
            const reply = yield* exchange("session-secret")
            expect(reply).toContain("\"Success\"")
            expect((yield* runtime.getPlan(card.planId)).decision).toBe(
              decision === "approve" ? "approved" : "denied"
            )
          }).pipe(Effect.provide(served(
            { host: "127.0.0.1", port: 0, operatorToken: "session-secret" }
          ))))
      }
    }
  }
})

describe("approval authority across every served mutation mount", () => {
  const delegatedOnce = Effect.runSync(ApprovalAuthority.make([
    { principal: { id: "gateway", kind: "bearer" }, scopes: ["once"], targets: ["Plan"] }
  ]))
  for (const delegated of [false, true]) {
    for (const mount of ["rpc", "projections"]) {
      for (const protocol of ["http", "ws"]) {
        for (const decision of ["approve", "deny"] as const) {
          for (const scope of ["once", "run", "remembered"] as const) {
            test(`${mount}/${protocol}: ${delegated ? "delegated" : "nondelegated"} bearer ${decision}/${scope}`, () =>
              Effect.gen(function*() {
                const url = yield* baseUrl
                const control = yield* Control
                const runtime = yield* ControlRuntime
                const card = yield* control.plan({ flowId: "system/test", input: {} })
                const before = yield* runtime.lookupApproval(card.approval.target)
                const payload = {
                  ...card.approval,
                  scope,
                  ...(mount === "projections" ? { decision } : {}),
                  principal: { id: "local", kind: "operator", stampedAt: 0 }
                }
                const request = JSON.stringify({
                  _tag: "Request",
                  id: 1,
                  tag: mount === "projections" ? "Approval.Submit" : decision === "approve" ? "Approve" : "Deny",
                  payload,
                  headers: []
                }) + "\n"
                const frames = protocol === "ws"
                  ? yield* Effect.promise(() => socketExchange(`${url}/${mount}/ws`, "edge-secret", request))
                  : [
                    yield* Effect.promise(async () => {
                      const response = await fetch(`${url}/${mount}`, {
                        method: "POST",
                        body: request,
                        headers: { authorization: "Bearer edge-secret", "content-type": "application/json" }
                      })
                      expect(response.status).toBe(200)
                      return response.text()
                    })
                  ]
                const line = frames.flatMap((frame) => frame.split("\n")).find((line) => line.includes("\"Exit\""))
                const reply = JSON.parse(line ?? "{}") as { exit?: { _tag: string; value?: unknown } }
                const allowed = delegated && (decision === "deny" || scope === "once")
                expect(reply.exit?._tag, JSON.stringify(reply)).toBe(allowed ? "Success" : "Failure")
                if (!allowed) {
                  expect(JSON.stringify(reply)).toContain("/control/Unauthorized")
                  expect(yield* runtime.lookupApproval(card.approval.target)).toEqual(before)
                  expect(yield* runtime.grants).toEqual([])
                  expect((yield* runtime.getPlan(card.planId)).decision).toBe("pending")
                } else {
                  expect((yield* runtime.getPlan(card.planId)).decision).toBe(
                    decision === "approve" ? "approved" : "denied"
                  )
                  expect((yield* runtime.grants).map((grant) => grant.scope)).toEqual(
                    decision === "approve" ? ["once"] : []
                  )
                  const events = yield* Stream.runCollect(
                    control.watch({ runId: `plan:${card.planId}`, follow: false })
                  )
                  expect(events.find((event) => event.kind.startsWith("control.approval."))?.payload)
                    .toMatchObject({ principal: { id: "gateway", kind: "bearer" } })
                }
              }).pipe(Effect.provide(served(
                { host: "127.0.0.1", port: 0, credential: "edge-secret" },
                delegated ? delegatedOnce : ApprovalAuthority.local
              ))))
          }
        }
      }
    }
  }
})

describe("submitting an answer rather than a grant", () => {
  /**
   * A `HumanTask` gate asks for a value, and the decision alone answers
   * nothing. The mount routes an answer to `Control.signal`, addressed to the
   * run the person opened and naming the wait point the approval row carries,
   * because a nested human wait has no registered approval token for
   * `Control.approve` to look up (run-3, `coding-clarification`).
   *
   * The proof is where the answer landed. This composition drives nothing, so
   * the signal is recorded durably for a later executor start to replay — and
   * the record carries the wait point's name and the words the person typed,
   * which a grant has nowhere to put.
   */
  /**
   * The durable wait token the approvals projection publishes as the target's
   * digest: base64 of `[flowName, executionId, deferredName]`. It is what tells
   * a decision that this gate asks a question rather than for a grant, so the
   * fixture carries a real one.
   */
  const waitToken = Buffer.from(
    JSON.stringify(["coding/PreparePlan", "execution-1", "WaitFor/coding-clarification#1"])
  ).toString("base64")

  const answerRequest = (runId: string, answer?: string, decision: "approve" | "deny" = "approve") =>
    JSON.stringify({
      _tag: "Request",
      id: 1,
      tag: "Approval.Submit",
      payload: {
        target: {
          _tag: "Node",
          runId,
          requestId: "coding-clarification#1",
          digest: waitToken,
          envelope: { capabilities: [], flows: [], budget: {} }
        },
        scope: "once",
        idempotencyKey: `answer:${runId}:coding-clarification#1`,
        decision,
        ...(answer === undefined ? {} : { answer })
      },
      headers: []
    }) + "\n"

  test("routes it to the signal command, not to the grant", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const runId = yield* launched
      const request = answerRequest(runId, "the scheduler owns it")
      const body = yield* Effect.promise(async () => {
        const response = await fetch(`${url}/projections`, {
          method: "POST",
          body: request,
          headers: { authorization: "Bearer edge-secret", "content-type": "application/json" }
        })
        expect(response.status).toBe(200)
        return response.text()
      })

      expect(body).toContain("\"Success\"")
      const runtime = yield* ControlRuntime
      expect(yield* runtime.deliveredSignals(runId)).toEqual([
        { name: "coding-clarification#1", payload: "the scheduler owns it" }
      ])
      // No grant was taken for the answer: the only one is the plan grant that
      // launched the run, so an answer decided nothing about capabilities.
      expect((yield* runtime.grants).map((grant) => grant.tokenId)).toEqual(["plan-1"])
    }).pipe(Effect.provide(served(
      { host: "127.0.0.1", port: 0, credential: "edge-secret" },
      delegatedBearer
    ))))

  /**
   * A question submitted with no answer is refused for the reason it is
   * refused.
   *
   * It used to fall through to `Control.approve`, which looked for a registered
   * approval token, found none — a `HumanTask` parks itself on a durable wait
   * and never registers one — and reported `/control/RunNotFound` for a run
   * that was listed, rendered and waiting. That is the error the app showed an
   * operator as "Approval submission failed" (workspace 4bb93306, run-1).
   */
  test("refuses an answerless question without claiming the run is gone", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const runId = yield* launched
      const body = yield* Effect.promise(async () => {
        const response = await fetch(`${url}/projections`, {
          method: "POST",
          body: answerRequest(runId),
          headers: { authorization: "Bearer edge-secret", "content-type": "application/json" }
        })
        expect(response.status).toBe(200)
        return response.text()
      })

      expect(body).toContain("/control/InvalidInput")
      expect(body).toContain("coding-clarification#1")
      expect(body).not.toContain("RunNotFound")
      // Nothing was recorded: a refused submission decides and delivers nothing.
      expect(yield* (yield* ControlRuntime).deliveredSignals(runId)).toEqual([])

      // A denial is refused the same way. Nothing it could mean reaches the
      // run: it is parked on a value, and withholding one leaves it parked
      // until its own attempt budget or deadline ends it.
      const denied = yield* Effect.promise(async () => {
        const response = await fetch(`${url}/projections`, {
          method: "POST",
          body: answerRequest(runId, undefined, "deny"),
          headers: { authorization: "Bearer edge-secret", "content-type": "application/json" }
        })
        return response.text()
      })
      expect(denied).toContain("/control/InvalidInput")
      expect(denied).not.toContain("RunNotFound")
    }).pipe(Effect.provide(served(
      { host: "127.0.0.1", port: 0, credential: "edge-secret" },
      delegatedBearer
    ))))
})

describe("the RPC body a mount will act on", () => {
  it("accepts a framed request message and refuses a body that carries none", () => {
    const ndjson = RpcSerialization.ndjson
    const request = `${JSON.stringify({ _tag: "Request", id: 1, tag: "List", payload: {}, headers: [] })}\n`

    expect(GatewayServer.carriesRpcRequest(ndjson, request)).toBe(true)
    expect(GatewayServer.carriesRpcRequest(ndjson, "{}")).toBe(false)
    expect(GatewayServer.carriesRpcRequest(ndjson, "")).toBe(false)
    // A complete line that is not JSON is what makes the parser throw; an
    // unterminated one is buffered and simply yields no message.
    expect(GatewayServer.carriesRpcRequest(ndjson, "not json\n")).toBe(false)
  })

  it("leaves a binary framing to the mount, since its body is not text", () => {
    const binary = Effect.runSync(RpcSerialization.RpcSerialization.pipe(
      Effect.provide(RpcSerialization.layerSchemaBinary())
    ))
    expect(GatewayServer.carriesRpcRequest(binary, "{}")).toBe(true)
  })
})

describe("telling a size overflow from every other body-read failure", () => {
  /** The exact shape `@effect/platform-node` raises for each. */
  const httpServerError = (cause: unknown) => ({
    _tag: "HttpServerError",
    reason: { _tag: "RequestParseError", cause }
  })

  it.each([
    ["the upstream size overflow", httpServerError(new Error("maxBytes exceeded")), true],
    ["a transport failure carrying another Error", httpServerError(new Error("socket hang up")), false],
    ["a parse failure carrying no cause", httpServerError(undefined), false],
    ["a reason that is not an object", { reason: "RequestParseError" }, false],
    ["a null reason", { reason: null }, false],
    ["an error with no reason at all", new Error("boom"), false],
    ["null", null, false],
    ["undefined", undefined, false],
    ["a string", "maxBytes exceeded", false]
  ])("reads %s as %s", (_name, error, expected) => {
    // A body that could not be read is not a body that was too big. Answering
    // 413 for every read failure told a client to shrink a request that was
    // never the problem.
    expect(GatewayServer.exceededBodyLimit(error)).toBe(expected)
  })

  it("answers 413 for the overflow and 400 for every other read failure", () => {
    // A truncated body cannot be provoked over a socket the client can still
    // read the answer on: Node aborts the request and writes nothing. The
    // refusal is therefore chosen by a function of its own, so both arms are
    // exercised rather than only the one a real client can reach.
    const tooLarge = GatewayServer.bodyRefusal("/rpc", 64, httpServerError(new Error("maxBytes exceeded")))
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.error.code).toBe("request_too_large")
    expect(tooLarge.error.message).toBe("POST /rpc exceeds the 64-byte request limit")

    const unreadable = GatewayServer.bodyRefusal("/projections", 64, httpServerError(new Error("aborted")))
    expect(unreadable.status).toBe(400)
    expect(unreadable.error.code).toBe("malformed_request")
    expect(unreadable.error.message).toBe("POST /projections carries a body the server could not read")
  })
})

describe("classifying a request target the way the router will", () => {
  // Measured against `HttpRouter` on this tree with a single `/rpc` route:
  // every spelling on the left of the first list answered 200 and every
  // spelling in the second answered 404. The guard has to agree, because it
  // decides authentication and the body limit before the router runs.
  it.each([
    ["/rpc", "/rpc"],
    ["/%72pc", "/rpc"],
    ["/%72%70%63", "/rpc"],
    ["/rpc;transport-parameter", "/rpc"],
    ["/rpc;p/", "/rpc"],
    ["/rpc/;p", "/rpc"],
    ["/rpc/", "/rpc"],
    ["//rpc", "/rpc"],
    ["///rpc", "/rpc"],
    ["/rpc//", "/rpc"],
    ["/RPC", "/rpc"],
    ["/./rpc", "/rpc"],
    ["/foo/../rpc", "/rpc"],
    ["/rpc?x=1", "/rpc"],
    ["/rpc#fragment", "/rpc"],
    ["http://gateway.invalid/rpc", "/rpc"],
    // The client the product ships posts here, and a literal comparison
    // recognised none of it.
    ["/rpc/ws", "/rpc/ws"],
    ["//rpc/ws", "/rpc/ws"],
    ["/RPC/WS", "/rpc/ws"]
  ])("resolves %s to the mount %s", (target, expected) => {
    expect(GatewayServer.routedPath(target)).toBe(expected)
  })

  it.each([
    // A reserved character left encoded is not a separator, to the router or
    // here, so none of these names a mount.
    "/rpc%2f",
    "/rpc%3Bp",
    "/%2frpc",
    "/rpc%20",
    "/ rpc"
  ])("keeps %s off the mounts, as the router does", (target) => {
    // Both lists, because the guard reads both: `protectedPaths` decides the
    // credential check and `rpcPaths` decides the body limit, and a spelling
    // that named either would be treated as a mount.
    const resolved = GatewayServer.routedPath(target)
    expect(GatewayServer.protectedPaths).not.toContain(resolved)
    expect(GatewayServer.rpcPaths).not.toContain(resolved)
  })

  it("leaves an invalid escape as written rather than refusing to classify", () => {
    // `decodeURI` throws on `%ZZ`. The segment is kept as it stands: it names
    // no mount either way, and the router answers it as an unknown route.
    expect(GatewayServer.routedPath("/%ZZ")).toBe("/%zz")
  })

  it("compares an unparseable absolute target as written", () => {
    // A target that is not a URL at all names no mount. `URL.parse` answers
    // null rather than throwing, so the guard returns the target unchanged
    // and the router answers the unknown route.
    expect(GatewayServer.routedPath("http://[")).toBe("http://[")
  })
})

it.effect("leaves an invalid percent escape as an unknown route", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        Layer.mergeAll(
          HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
          GatewayServer.layerIngress()
        ).pipe(Layer.provide(RpcSerialization.layerNdjson)),
        { disableLogger: true }
      )
    ),
    ({ handler }) =>
      Effect.gen(function*() {
        const response = yield* Effect.promise(() =>
          handler(new Request("http://localhost/%ZZ", { headers: { host: "localhost" } }))
        )
        expect(response.status).toBe(404)
      }),
    ({ dispose }) => Effect.promise(dispose)
  ))

describe("a binary serialization through ingress on the Node adapter", () => {
  const serialization = Effect.runSync(
    RpcSerialization.RpcSerialization.pipe(Effect.provide(RpcSerialization.layerSchemaBinary()))
  )
  /** One framed binary request. Its bytes are not valid UTF-8. */
  const framed = serialization.makeUnsafe().encode({
    _tag: "Request",
    id: "1",
    tag: "List",
    payload: Schema.encodeSync(serialization.codecFor(Schema.Struct({ _tag: Schema.Literal("runs") })))({
      _tag: "runs"
    }),
    headers: []
  }) as Uint8Array
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")

  /**
   * A mount that reads the body the way `RpcServer` does under a binary
   * serialization, `request.arrayBuffer`, after ingress has already read the
   * request, and echoes the bytes it got. The Node adapter caches whichever
   * reader ran first, so this is the only way to see what the mount sees.
   */
  const echo = Effect.map(
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => Effect.orDie(request.arrayBuffer)),
    (body) => HttpServerResponse.text(hex(new Uint8Array(body)))
  )
  const bound = (maxRequestBodyBytes: number) =>
    HttpRouter.serve(
      Layer.mergeAll(HttpRouter.add("POST", "/rpc", echo), GatewayServer.layerIngress({ maxRequestBodyBytes })).pipe(
        Layer.provide(RpcSerialization.layerSchemaBinary())
      ),
      { disableListenLog: true, disableLogger: true }
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })))

  const post = (url: string, body: Uint8Array) =>
    Effect.promise(() =>
      fetch(`${url}/rpc`, {
        method: "POST",
        headers: { "content-type": serialization.contentType },
        body: new Blob([body as Uint8Array<ArrayBuffer>])
      })
    )

  test("hands the mount the bytes the client sent", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      // A UTF-8 decode of these bytes is lossy, so a text read at ingress
      // that rebinds the binary reader would hand the mount different bytes.
      expect(new TextEncoder().encode(new TextDecoder().decode(framed))).not.toEqual(framed)
      const response = yield* post(url, framed)
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toBe(hex(framed))
    }).pipe(Effect.provide(bound(4096))))

  test("still measures a binary body against the limit", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* post(url, framed)
      expect(response.status).toBe(413)
      expect(yield* Effect.promise(() => response.json() as Promise<unknown>)).toEqual({
        _tag: "@smthrs/gateway/GatewayError",
        code: "request_too_large",
        message: `POST /rpc exceeds the ${framed.byteLength - 1}-byte request limit`
      })
    }).pipe(Effect.provide(bound(framed.byteLength - 1))))
})

describe("the assembled gateway over a real loopback bind", () => {
  for (const guide of ["host-the-gateway", "testing"] as const) {
    test(`executes the ${guide} port-0 address snippet against a served gateway`, () =>
      Effect.gen(function*() {
        const source = readFileSync(new URL(`../docs/guides/${guide}.md`, import.meta.url), "utf8")
        const snippet = source.match(
          /const baseUrl = Effect\.map\(HttpServer\.HttpServer, \(server\) => \{[\s\S]*?\n\}\)/
        )?.[0]
        if (!snippet) throw new Error(`${guide} has no address snippet`)
        const documentedBaseUrl = compileFunction(`${snippet}\nreturn baseUrl`, ["Effect", "HttpServer"])(
          Effect,
          HttpServer
        ) as typeof baseUrl
        const url = yield* documentedBaseUrl
        const response = yield* Effect.promise(() => fetch(`${url}/health`))
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json() as Promise<unknown>)).toEqual(health)
      }).pipe(Effect.provide(served())))
  }
  test("blocks browser HTTP and WebSocket attacks before any RPC dispatch", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      for (const path of ["/rpc", "/projections", "/sync", "/%72pc/"]) {
        for (const origin of ["https://attacker.example", "null", "http://localhost:1", `${url}/path`]) {
          const response = yield* Effect.promise(() =>
            fetch(`${url}${path}`, {
              method: "POST",
              headers: { origin, "content-type": "text/plain" },
              body: exactBody
            })
          )
          expect(response.status).toBe(403)
        }
      }
      for (const path of ["/rpc/ws", "/projections/ws", "/sync/ws"]) {
        const upgrade = [
          `GET ${path} HTTP/1.1`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
        ]
        for (const origin of ["https://attacker.example", "null"]) {
          expect((yield* Effect.promise(() => raw(url, [...upgrade, `Origin: ${origin}`]))).status).toBe(403)
        }
        expect(
          (yield* Effect.promise(() => raw(url, [...upgrade, "Origin: http://rebind.example"], "", "rebind.example")))
            .status
        ).toBe(421)
        expect((yield* Effect.promise(() => raw(url, [...upgrade, `Origin: ${url}`]))).status).toBe(101)
        expect((yield* Effect.promise(() => raw(url, upgrade))).status).toBe(101)
      }
      // DNS rebinding and forwarded-header spoofing must fail even on reads.
      for (
        const host of [
          "rebind.example",
          "localhost.attacker.example",
          "localhost@attacker.example",
          "localhost:99999",
          "[1234]"
        ]
      ) {
        expect(
          (yield* Effect.promise(() => raw(url, ["GET /health HTTP/1.1", "X-Forwarded-Host: localhost"], "", host)))
            .status
        ).toBe(421)
      }
      expect((yield* Effect.promise(() => fetch(`${url}/health`, { headers: { origin: url } }))).status).toBe(200)
    }).pipe(Effect.provide(served())))

  test("accepts explicitly configured network hosts but still rejects cross-origin requests", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      expect((yield* Effect.promise(() => raw(url, ["GET /health HTTP/1.1"], "", "gateway.example"))).status).toBe(200)
      expect(
        (yield* Effect.promise(() =>
          raw(url, ["GET /health HTTP/1.1", "Origin: https://attacker.example"], "", "gateway.example")
        )).status
      ).toBe(403)
    }).pipe(Effect.provide(served({
      host: "127.0.0.1",
      port: 0,
      allowedHosts: ["gateway.example"],
      credential: "explicit-network-host-test"
    }))))

  test("keeps an explicitly allowed network Host closed without a credential", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* Effect.promise(() => raw(url, ["GET /health HTTP/1.1"], "", "gateway.example"))
      expect(response.status).toBe(421)
      expect(JSON.parse(response.body)).toMatchObject({ code: "invalid_host" })
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, allowedHosts: ["gateway.example"] }))))

  test("answers GET /health with the workspace identity and the package version", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* Effect.promise(() => fetch(`${url}/health`))
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json() as Promise<unknown>)).toEqual(health)
    }).pipe(Effect.provide(served())))

  test("answers an unknown route with 404 and serves nothing else", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* Effect.promise(() => fetch(`${url}/nope`))
      expect(response.status).toBe(404)
    }).pipe(Effect.provide(served())))

  test("confines a credential-less gateway to loopback Host and browser Origin values", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const postRpc = (headers: ReadonlyArray<string>) =>
        raw(`${url}/rpc`, [
          "POST /rpc HTTP/1.1",
          "Content-Type: application/json",
          `Content-Length: ${exactBodyBytes}`,
          ...headers
        ], exactBody)
      const upgradeRpc = (headers: ReadonlyArray<string>) =>
        raw(`${url}/rpc/ws`, [
          "GET /rpc/ws HTTP/1.1",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          ...headers
        ])

      const hostileHttp = yield* Effect.promise(() => postRpc(["Origin: https://evil.example"]))
      expect(hostileHttp.status).toBe(403)
      expect(JSON.parse(hostileHttp.body)).toEqual({
        _tag: "@smthrs/gateway/GatewayError",
        code: "invalid_origin",
        message: "The browser Origin must match an allowed gateway Host"
      })

      const hostileUpgrade = yield* Effect.promise(() => upgradeRpc(["Origin: https://evil.example"]))
      expect(hostileUpgrade.status).toBe(403)
      expect(JSON.parse(hostileUpgrade.body)).toMatchObject({ code: "invalid_origin" })

      for (
        const origin of [
          "null",
          "file://localhost",
          "http://localhost.evil.example",
          "http://localhost@evil.example",
          "http://evil.example@localhost",
          "http://127.0.0.1.evil.example",
          "http://localhost/",
          "http://localhost:65536",
          "http://localhost, https://evil.example"
        ]
      ) {
        for (const send of [postRpc, upgradeRpc]) {
          const response = yield* Effect.promise(() => send([`Origin: ${origin}`]))
          expect([origin, response.status, JSON.parse(response.body).code]).toEqual([origin, 403, "invalid_origin"])
        }
      }

      const foreignHost = yield* Effect.promise(() => postRpc(["Host: gateway.example"]))
      expect(foreignHost.status).toBe(421)
      expect(JSON.parse(foreignHost.body)).toEqual({
        _tag: "@smthrs/gateway/GatewayError",
        code: "invalid_host",
        message: "This gateway does not allow the supplied Host value"
      })

      for (const host of ["gateway.example", "localhost.evil.example", "localhost@evil.example", "localhost:65536"]) {
        for (const send of [postRpc, upgradeRpc]) {
          const response = yield* Effect.promise(() => send([`Host: ${host}`]))
          expect([host, response.status, JSON.parse(response.body).code]).toEqual([host, 421, "invalid_host"])
        }
      }

      for (const host of ["localhost", "LOCALHOST:3000", "127.0.0.1", "[::1]", "[::1]:3000"]) {
        expect([host, (yield* Effect.promise(() => postRpc([`Host: ${host}`]))).status]).toEqual([host, 200])
        expect([host, (yield* Effect.promise(() => upgradeRpc([`Host: ${host}`]))).status]).toEqual([host, 101])
      }

      for (
        const origin of [
          "http://localhost",
          "https://localhost:8443",
          "http://127.0.0.1:3000",
          "https://[::1]"
        ]
      ) {
        const headers = [`Host: ${new URL(origin).host}`, `Origin: ${origin}`]
        expect([origin, (yield* Effect.promise(() => postRpc(headers))).status]).toEqual([origin, 200])
        expect([origin, (yield* Effect.promise(() => upgradeRpc(headers))).status]).toEqual([origin, 101])
      }
      expect((yield* Effect.promise(() => postRpc([]))).status).toBe(200)
      expect((yield* Effect.promise(() => upgradeRpc([]))).status).toBe(101)
    }).pipe(Effect.provide(served())))

  /**
   * A malformed request is the caller's mistake, and the status code is how a
   * caller learns that. In the release validation `POST /rpc` with body `{}`
   * answered 500 with an empty body, which tells an operator the gateway
   * broke and tells a client to retry a request that can never succeed.
   */
  for (
    const [name, body] of [
      ["an empty JSON object", "{}"],
      ["an array", "[]"],
      ["text that is not JSON at all", "not json"],
      ["nothing at all", ""]
    ] as const
  ) {
    test(`answers POST /rpc carrying ${name} with 400 and a typed error body`, () =>
      Effect.gen(function*() {
        const url = yield* baseUrl
        const response = yield* Effect.promise(() =>
          fetch(`${url}/rpc`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body
          })
        )

        expect(response.status).toBe(400)
        expect(yield* Effect.promise(() => response.json() as Promise<unknown>)).toEqual({
          _tag: "@smthrs/gateway/GatewayError",
          code: "malformed_request",
          message: "POST /rpc carries no RPC request message"
        })
      }).pipe(Effect.provide(served())))
  }

  test("refuses a malformed body on every RPC mount, not only /rpc", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      for (const path of GatewayServer.rpcPaths) {
        const response = yield* Effect.promise(() =>
          fetch(`${url}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}"
          })
        )
        expect([path, response.status]).toEqual([path, 400])
      }
    }).pipe(Effect.provide(served())))

  test("returns 413 for declared overflow and safely closes streaming overflow", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const fixed = yield* Effect.promise(() =>
        fetch(`${url}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(256)
        })
      )
      const bytes = new TextEncoder().encode("x".repeat(256))
      const chunkedBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 128))
          controller.enqueue(bytes.subarray(128))
          controller.close()
        }
      })
      const chunked = yield* Effect.promise(async () => {
        try {
          return {
            _tag: "Response" as const,
            response: await fetch(
              `${url}/rpc`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: chunkedBody,
                duplex: "half"
              } as RequestInit & { readonly duplex: "half" }
            )
          }
        } catch (error) {
          return { _tag: "Closed" as const, error }
        }
      })

      expect(fixed.status).toBe(413)
      expect(yield* Effect.promise(() => fixed.json() as Promise<unknown>)).toMatchObject({
        code: "request_too_large"
      })
      if (chunked._tag === "Response") {
        expect(chunked.response.status).toBe(413)
        expect(yield* Effect.promise(() => chunked.response.json() as Promise<unknown>)).toMatchObject({
          code: "request_too_large"
        })
      } else {
        // Effect's Node stream adapter destroys an over-limit source rather
        // than draining attacker-controlled bytes. Node fetch can surface the
        // socket close itself or the OS reset, depending on when it observes it.
        const code = (chunked.error as { readonly cause?: { readonly code?: unknown } }).cause?.code
        expect(["UND_ERR_SOCKET", "ECONNRESET"]).toContain(code)
      }
      const next = yield* Effect.promise(() => fetch(`${url}/health`))
      expect(next.status).toBe(200)
      expect(yield* Effect.promise(() => next.json() as Promise<unknown>)).toEqual(health)
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, maxRequestBodyBytes: 64 }))))

  test("admits a body at exactly the limit and never trusts a declared length", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const post = (headers: ReadonlyArray<string>, body: string) =>
        raw(`${url}/rpc`, ["POST /rpc HTTP/1.1", "Content-Type: application/json", ...headers], body)

      // The limit is a maximum, not a threshold: a body of exactly that many
      // bytes is served rather than refused.
      const atLimit = yield* Effect.promise(() => post([`Content-Length: ${exactBodyBytes}`], exactBody))
      expect(atLimit.status).toBe(200)

      // A body one byte over is refused, which is what makes the line above a
      // boundary rather than a coincidence.
      const overLimit = yield* Effect.promise(() => post([`Content-Length: ${exactBodyBytes + 1}`], `${exactBody} `))
      expect(overLimit.status).toBe(413)
      expect(JSON.parse(overLimit.body)).toMatchObject({ code: "request_too_large" })

      // A declared length that understates the body smuggles nothing past the
      // limit, and needs no test of its own: HTTP/1.1 framing means the server
      // reads exactly the length it was given, so the extra bytes are never
      // part of this request at all. The case the guard has to answer for is a
      // body that declares no length, which the chunked case above covers.
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, maxRequestBodyBytes: exactBodyBytes }))))

  test("authenticates before inspecting an oversized body", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      // `/projections`, not `/rpc`: the control mount answers its own typed
      // `Unauthorized` in band (see `protectedPaths`), so the edge-first
      // ordering this pins is only observable on a mount the edge still
      // authenticates.
      const response = yield* Effect.promise(() =>
        fetch(`${url}/projections`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(256)
        })
      )
      expect(response.status).toBe(401)
      expect(yield* Effect.promise(() => response.json() as Promise<unknown>)).toMatchObject({ code: "unauthorized" })
    }).pipe(Effect.provide(served({
      host: "127.0.0.1",
      port: 0,
      credential: "edge-secret",
      maxRequestBodyBytes: 64
    }))))

  test("applies the body limit to every router-equivalent spelling of /rpc", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const body = "x".repeat(256)
      // `/rpc` is authenticated in band, so the guard's classification of it
      // is what the body limit rides on. Every spelling here reaches the
      // `/rpc` handler, and one the guard failed to recognise would carry an
      // unbounded body to the mount.
      for (
        const target of [
          "/rpc",
          "/%72pc",
          "/rpc;transport-parameter",
          "/rpc/",
          "//rpc",
          "///rpc",
          "/rpc//",
          "/RPC",
          "/rpc;p/"
        ]
      ) {
        const response = yield* Effect.promise(() =>
          raw(`${url}${target}`, [
            `POST ${target} HTTP/1.1`,
            "Authorization: Bearer edge-secret",
            "Content-Type: application/json",
            `Content-Length: ${body.length}`
          ], body)
        )
        expect([target, response.status]).toEqual([target, 413])
      }
    }).pipe(Effect.provide(served({
      host: "127.0.0.1",
      port: 0,
      credential: "edge-secret",
      maxRequestBodyBytes: 64
    }))))

  test("authenticates router-equivalent aliases before reading or upgrading", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const body = "{}"
      // Every spelling here reaches the `/projections` handler: the router
      // decodes percent escapes, drops a `;` parameter, ignores empty
      // segments, and matches without regard to case. The guard has to
      // classify a request the way the router will, or an alias walks past the
      // credential check and is answered by the mount itself.
      for (
        const target of [
          "/%70rojections",
          "/projections;transport-parameter",
          "/projections/",
          "//projections",
          "///projections",
          "/projections//",
          "/PROJECTIONS",
          "/projections;p/"
        ]
      ) {
        const response = yield* Effect.promise(() =>
          raw(`${url}${target}`, [
            `POST ${target} HTTP/1.1`,
            "Content-Type: application/json",
            `Content-Length: ${body.length}`
          ], body)
        )
        expect([target, response.status]).toEqual([target, 401])
      }

      for (const target of ["/%72pc/ws", "/rpc/ws;transport-parameter", "//rpc/ws", "/rpc/ws/", "/RPC/WS"]) {
        const response = yield* Effect.promise(() =>
          raw(`${url}${target}`, [
            `GET ${target} HTTP/1.1`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
          ])
        )
        expect([target, response.status]).toEqual([target, 401])
      }
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, credential: "edge-secret" }))))

  test("lets an authenticated request reach the body guard", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* Effect.promise(() =>
        fetch(`${url}/rpc`, {
          method: "POST",
          headers: {
            authorization: "Bearer edge-secret",
            "content-type": "application/json"
          },
          body: "{}"
        })
      )

      expect(response.status).toBe(400)
      expect(yield* Effect.promise(() => response.json() as Promise<unknown>)).toMatchObject({
        code: "malformed_request"
      })
    }).pipe(Effect.provide(served({
      host: "127.0.0.1",
      port: 0,
      credential: "edge-secret"
    }))))

  test("passes a well-formed request message through to the server it names", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* Effect.promise(() =>
        fetch(`${url}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `${JSON.stringify({ _tag: "Request", id: 1, tag: "NoSuchProcedure", payload: {}, headers: [] })}\n`
        })
      )

      // The procedure does not exist, so the server answers an RPC-level
      // defect. What matters here is that the guard did not answer for it.
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toContain("NoSuchProcedure")
    }).pipe(Effect.provide(served())))

  test("plans, approves, runs, and reads a run back through the served control plane", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const remote = yield* Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: { suite: "served" } })
        yield* control.approve(approvalOf(card))
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: `run:${card.planId}`
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
          return yield* Effect.die("expected an accepted run")
        }
        const listed = yield* control.list({ _tag: "runs", filters: { runId: receipt.runId } })
        yield* control.cancel({
          runId: receipt.runId,
          idempotencyKey: `cancel:${receipt.runId}`,
          reason: "the suite is done"
        })
        const after = yield* control.list({ _tag: "runs", filters: { runId: receipt.runId } })
        const flows = yield* control.list({ _tag: "flows" })
        return { listed, after, flows, runId: receipt.runId }
      }).pipe(Effect.provide(client(url, "session-secret")))

      expect(remote.listed._tag).toBe("runs")
      expect(remote.after._tag).toBe("runs")
      expect(remote.flows._tag).toBe("flows")
      if (remote.listed._tag !== "runs" || remote.after._tag !== "runs") return
      // Read back by run id, in the schema status vocabulary, over the wire.
      expect(remote.listed.items).toMatchObject([{ runId: remote.runId, flowId: "system/test" }])
      expect(RunStatus.literals).toContain(remote.listed.items[0]?.status ?? "")
      // The cancel is durable: the next read of the same run says so.
      expect(remote.after.items).toMatchObject([{ runId: remote.runId, status: "cancelled" }])
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, operatorToken: "session-secret" }))))

  /**
   * Attribution over a credentialed bind, which is the only composition where
   * the authenticated identity and the runtime's default differ. A loopback
   * gateway authenticates `local`/`operator` and the SQL runtime defaults to
   * the same pair, so every earlier suite agreed with a handler that dropped
   * the principal and one that forwarded it.
   */
  test("journals a bearer operator's cancel as the bearer, not as the local default", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const remote = yield* Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: { suite: "bearer" } })
        yield* control.approve(approvalOf(card))
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: `run:${card.planId}`
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
          return yield* Effect.die("expected an accepted run")
        }
        yield* control.cancel({
          runId: receipt.runId,
          idempotencyKey: `cancel:${receipt.runId}`,
          reason: "a remote operator asked"
        })
        return receipt.runId
        // Only the unary mounts carry the credential: `ControlClient` attaches
        // the bearer to HTTP and the socket protocol has no header to put it
        // on, so the record is read back in process below.
      }).pipe(Effect.provide(client(url, "edge-secret")))

      const control = yield* Control
      const events = yield* Stream.runCollect(control.watch({ runId: remote, follow: false }))
      const listed = yield* control.list({ _tag: "runs", filters: { runId: remote } })

      const requested = events.find((event) => event.kind === "control.run.cancel-requested")
      expect((requested?.payload as { readonly principal?: unknown } | null)?.principal)
        .toMatchObject({ id: "gateway", kind: "bearer" })
      if (listed._tag !== "runs") return
      expect(listed.items[0]?.cancellation?.principal).toMatchObject({ id: "gateway", kind: "bearer" })
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, credential: "edge-secret" }, delegatedBearer))))

  test("serves a projection snapshot over POST /projections, framed on the wire", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const projections = yield* Projections
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      yield* control.approve(approvalOf(card))
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: `run:${card.planId}`
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
      const selector = { _tag: "run-summary" as const, runId: receipt.runId }

      // The relay reaches the projections over the request/response path, so
      // the mount is exercised the way that path uses it rather than only in
      // process.
      const response = yield* Effect.promise(() =>
        fetch(`${url}/projections`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `${
            JSON.stringify({
              _tag: "Request",
              id: 1,
              tag: "Projection.Snapshot",
              payload: { selector },
              headers: []
            })
          }\n`
        })
      )
      const framed = yield* Effect.promise(() => response.text())
      const exit = JSON.parse(framed.split("\n")[0] ?? "{}") as {
        readonly _tag: string
        readonly exit: { readonly _tag: string; readonly value: unknown }
      }

      expect(response.status).toBe(200)
      expect(exit._tag).toBe("Exit")
      expect(exit.exit._tag).toBe("Success")
      // What the wire answers is what the service answers.
      expect(exit.exit.value).toEqual(yield* projections.snapshot(selector))
      const eventSelector = { _tag: "run-events" as const, runId: receipt.runId }
      const journal = yield* projections.snapshot(eventSelector)
      expect(journal.rows.length).toBeGreaterThan(0)
      const incrementalResponse = yield* Effect.promise(() =>
        fetch(`${url}/projections`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            _tag: "Request",
            id: 2,
            tag: "Projection.Snapshot",
            payload: { selector: eventSelector, after: journal.cursor },
            headers: []
          }) + "\n"
        })
      )
      const incrementalText = yield* Effect.promise(() => incrementalResponse.text())
      const incremental = JSON.parse(incrementalText.split("\n")[0] ?? "{}")
      expect(incremental.exit._tag).toBe("Success")
      expect(incremental.exit.value.rows).toEqual([])
      expect(incremental.exit.value.cursor).toEqual(journal.cursor)
    }).pipe(Effect.provide(served())))

  test("answers an unreadable selector as a defect, not as a refusal", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      // What a box older than a selector does with it. `flow-durationz` takes
      // the decode path `flow-durations` takes on a box that predates it, and
      // the answer is not a `GatewayError`: the request decoder dies before a
      // procedure runs, so the frame carries a `Die` and no code at all. A
      // client that branches on `error.code` to learn whether the box knows a
      // selector reads nothing here, and has to read the defect instead.
      const response = yield* Effect.promise(() =>
        fetch(`${url}/projections`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `${
            JSON.stringify({
              _tag: "Request",
              id: 1,
              tag: "Projection.Snapshot",
              payload: { selector: { _tag: "flow-durationz", flowId: "deploy" } },
              headers: []
            })
          }\n`
        })
      )
      const text = yield* Effect.promise(() => response.text())
      const frame = JSON.parse(text.split("\n")[0] ?? "{}") as {
        readonly exit: { readonly _tag: string; readonly cause: ReadonlyArray<Record<string, unknown>> }
      }

      expect(response.status).toBe(200)
      expect(frame.exit._tag).toBe("Failure")
      expect(frame.exit.cause.map((reason) => reason._tag)).toEqual(["Die"])
      expect(frame.exit.cause[0]?.defect).toContain("[\"selector\"]")
      expect(frame.exit.cause[0]?.code).toBeUndefined()
    }).pipe(Effect.provide(served())))

  test("serves a sync read over POST /sync", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* Effect.promise(() =>
        fetch(`${url}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `${
            JSON.stringify({
              _tag: "Request",
              id: 1,
              tag: "Read",
              payload: { scope: { _tag: "workspace" }, limit: 10 },
              headers: []
            })
          }\n`
        })
      )
      // The sync mount is reachable and framed. What it answers for a given
      // cursor is `@smthrs/sync`'s contract, proved in that package.
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toContain("\"Exit\"")
    }).pipe(Effect.provide(served())))

  test("freezes the wire form of the health body and a refusal frame", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const probe = yield* Effect.promise(() => fetch(`${url}/health`))
      // A golden body: a renamed or dropped field fails here rather than in a
      // deployment that reads the identity to decide whether to replace this
      // process.
      expect(yield* Effect.promise(() => probe.json() as Promise<unknown>)).toEqual({
        workspaceHash: "workspace-hash",
        gatewayId: "gateway-1",
        protocolVersion: "1",
        version: "1.0.0-rc.0"
      })

      const refused = yield* Effect.promise(() =>
        fetch(`${url}/projections`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        })
      )
      expect(yield* Effect.promise(() => refused.json() as Promise<unknown>)).toEqual({
        _tag: "@smthrs/gateway/GatewayError",
        code: "malformed_request",
        message: "POST /projections carries no RPC request message"
      })
    }).pipe(Effect.provide(served())))

  test("refuses an uncredentialed WebSocket upgrade on every protected socket", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      // The relay opens the sockets, so the guard has to run on the upgrade
      // request and not only on the unary mounts. `layerIngress` is a global
      // router middleware and every socket path is in `protectedPaths`.
      for (const path of ["/rpc/ws", "/projections/ws", "/sync/ws"]) {
        const response = yield* Effect.promise(() =>
          raw(`${url}${path}`, [
            `GET ${path} HTTP/1.1`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
          ])
        )
        expect([path, response.status]).toEqual([path, 401])
        expect([path, JSON.parse(response.body) as unknown]).toEqual([path, {
          _tag: "@smthrs/gateway/GatewayError",
          code: "unauthorized",
          message: "A valid bearer credential is required"
        }])
      }
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, credential: "edge-secret" }))))

  test("admits a credentialed WebSocket upgrade on every protected socket", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      // This is the positive half of the edge-authentication contract: the
      // same guard that refuses a missing bearer must admit the configured one
      // on every protected socket mount.
      for (const path of ["/rpc/ws", "/projections/ws", "/sync/ws"]) {
        const response = yield* Effect.promise(() =>
          raw(`${url}${path}`, [
            `GET ${path} HTTP/1.1`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Authorization: Bearer edge-secret"
          ])
        )
        expect([path, response.status]).toEqual([path, 101])
      }
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, credential: "edge-secret" }))))

  test("serves a projection over an authenticated /projections/ws socket", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const projections = yield* Projections
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      yield* control.approve(approvalOf(card))
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: `run:${card.planId}`
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
      const selector = { _tag: "run-summary" as const, runId: receipt.runId }
      const request = `${
        JSON.stringify({
          _tag: "Request",
          id: 1,
          tag: "Projection.Snapshot",
          payload: { selector },
          headers: []
        })
      }\n`

      // A 101 alone does not prove the protected mount serves. This sends the
      // relay's projection RPC through the authenticated upgrade and compares
      // its answer with the same in-process read path.
      const frames = yield* Effect.promise(() => socketExchange(`${url}/projections/ws`, "edge-secret", request))
      expect(frames.length).toBeGreaterThan(0)
      const exitLine = frames.flatMap((frame) => frame.split("\n"))
        .find((line) => line.includes("\"Exit\""))
      const exit = JSON.parse(exitLine ?? "{}") as {
        readonly _tag: string
        readonly exit: { readonly _tag: string; readonly value: unknown }
      }

      expect(exit._tag).toBe("Exit")
      expect(exit.exit._tag).toBe("Success")
      expect(exit.exit.value).toEqual(yield* projections.snapshot(selector))
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, credential: "edge-secret" }))))

  test("streams a projection over /projections/ws: snapshot, keepalive, then a delta above the snapshot cursor", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const runId = yield* launched
      const selector = { _tag: "run-summary" as const, runId }
      const idle = yield* Deferred.make<void>()

      // The relay and the quickstart's follower speak to this mount, so the
      // proof has to cross the served WebSocket composition: the protocol
      // layer, the NDJSON framing and the fresh RPC server, not the service.
      const observed = yield* Effect.gen(function*() {
        const rpc = yield* RpcClient.make(GatewayRpcs)
        const following = yield* Effect.forkChild(
          Stream.runCollect(
            rpc["Projection.Subscribe"]({ selector }).pipe(
              Stream.tap((frame) => frame._tag === "heartbeat" ? Deferred.succeed(idle, undefined) : Effect.void),
              Stream.takeUntil((frame) => frame._tag === "delta")
            )
          )
        )
        // Nothing has changed since the snapshot, so the first frame after
        // snapshot-end is the keepalive that stops a relay cutting an idle
        // tunnel. Only then does the run move.
        yield* Deferred.await(idle)
        yield* emit(runId, "control.run.completed", { runId })
        return yield* Fiber.join(following)
      }).pipe(Effect.provide(projectionsClient(url)))

      const tags = observed.map((frame) => frame._tag)
      expect(tags.slice(0, 3)).toEqual(["snapshot-start", "row", "snapshot-end"])
      expect(tags.slice(3, -1).every((tag) => tag === "heartbeat")).toBe(true)
      expect(tags.slice(3, -1).length).toBeGreaterThan(0)
      expect(tags.at(-1)).toBe("delta")
      const snapshotEnd = observed[2]
      const delta = observed.at(-1)
      if (snapshotEnd?._tag !== "snapshot-end" || delta?._tag !== "delta") return yield* Effect.die("expected frames")
      expect(delta.cursor.value).toBeGreaterThan(snapshotEnd.cursor.value)
    }).pipe(Effect.provide(served())))

  test("the bind's heartbeatMillis governs the /projections/ws keepalive as well as Watch", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const runId = yield* launched
      // The read path here is the shipped `Projections.layer` at its 30 s
      // cadence. A host that shortens the cadence at the bind, as the guide
      // says to, expects the projection socket to beat at that cadence too.
      const frames = yield* Effect.gen(function*() {
        const rpc = yield* RpcClient.make(GatewayRpcs)
        return yield* Stream.runCollect(
          Stream.take(rpc["Projection.Subscribe"]({ selector: { _tag: "run-summary", runId } }), 4)
        )
      }).pipe(Effect.provide(projectionsClient(url)), Effect.timeoutOption("5 seconds"))
      expect(frames._tag).toBe("Some")
      if (frames._tag !== "Some") return
      expect(frames.value.map((frame) => frame._tag)).toEqual(["snapshot-start", "row", "snapshot-end", "heartbeat"])
    }).pipe(Effect.provide(
      NodeGateway.layer(health, { host: "127.0.0.1", port: 0, heartbeatMillis: 25 }).pipe(
        Layer.provideMerge(defaultCadenceStack)
      )
    )))

  test("refuses a body one byte over the documented default limit", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      // The documented default, pinned exactly: a host sizing its relay's
      // request limit to this number must not find the gateway elsewhere.
      expect(GatewayServer.defaultMaxRequestBodyBytes).toBe(1024 * 1024)
      const post = (size: number) =>
        Effect.promise(() =>
          fetch(`${url}/rpc`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: `${exactBody}${" ".repeat(size - exactBody.length)}`
          })
        )
      const atLimit = yield* post(GatewayServer.defaultMaxRequestBodyBytes)
      const overLimit = yield* post(GatewayServer.defaultMaxRequestBodyBytes + 1)
      expect(atLimit.status).not.toBe(413)
      expect(overLimit.status).toBe(413)
      expect(yield* Effect.promise(() => overLimit.json() as Promise<unknown>)).toMatchObject({
        code: "request_too_large"
      })
    }).pipe(Effect.provide(served())))

  test("lists a child run beside the parent it came from", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      yield* control.approve(approvalOf(card))
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: `run:${card.planId}`
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")

      const rows = (yield* projections.snapshot({ _tag: "workspace-runs" })).rows
      // The ordinary listing is what every run surface renders. A parent that
      // spawns children must not be the only run it shows.
      expect(rows.map((row) => row.runId)).toContain(receipt.runId)
    }).pipe(Effect.provide(served())))

  test("keeps an idle followed Watch alive on /rpc/ws", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      yield* control.approve(approvalOf(card))
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: `run:${card.planId}`
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
      const runId = receipt.runId

      const observed = yield* Effect.gen(function*() {
        const remote = yield* Control
        const history = yield* Stream.runCollect(remote.watch({ runId, follow: false }))
        const last = history.at(-1)?.sequence ?? 0
        // Nothing will happen to this run again, so every frame from here is
        // the server's own keepalive. Without it the socket is silent until
        // the run moves, and a relay cuts the tunnel first.
        const frames = yield* Stream.runCollect(
          Stream.take(remote.watch({ runId, afterSequence: last, follow: true }), 2)
        )
        return { last, frames }
      }).pipe(Effect.provide(client(url)))

      expect(observed.frames.map((frame) => frame.kind)).toEqual([
        GatewayServer.watchHeartbeatKind,
        GatewayServer.watchHeartbeatKind
      ])
      // It repeats the last sequence delivered, so a client resuming from the
      // last sequence it saw does not rewind on a keepalive, and it names the
      // run so a client routing by run keeps routing.
      expect(observed.frames.map((frame) => frame.sequence)).toEqual([observed.last, observed.last])
      expect(observed.frames[0]?.runId).toBe(runId)
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, heartbeatMillis: 25 }))))
})

describe("the Watch keepalive", () => {
  const kept = GatewayServer.layerKeepAlive(25).pipe(Layer.provideMerge(stack()))

  test("preserves a partial cursor on a keepalive before and after source delivery", () =>
    Effect.gen(function*() {
      const original = yield* Control
      for (const deliver of [false, true, "legacy"]) {
        const cursor = { sequence: 7, offset: 0 }
        const control = {
          ...original,
          watch: () =>
            deliver
              ? Stream.concat(
                Stream.make({
                  sequence: 7,
                  ...(deliver === "legacy" ? {} : { cursor }),
                  kind: "source",
                  occurredAt: 1,
                  payload: null
                }),
                Stream.never
              )
              : Stream.never
        }
        const frames = yield* Effect.gen(function*() {
          const kept = yield* Control
          return yield* Stream.runCollect(Stream.takeUntil(
            kept.watch({ runId: "run-1", afterCursor: { sequence: 6, offset: 1 }, follow: true }),
            (event) => event.kind === GatewayServer.watchHeartbeatKind
          ))
        }).pipe(Effect.provide(
          GatewayServer.layerKeepAlive(10).pipe(
            Layer.provide(Layer.succeed(Control, control))
          )
        ))
        expect(frames.at(-1)).toMatchObject({
          sequence: deliver ? 7 : 6,
          cursor: deliver === "legacy" ? { sequence: 7 } : deliver ? cursor : { sequence: 6, offset: 1 }
        })
      }
    }).pipe(Effect.provide(stack())))

  test("leaves a snapshot read alone and names no run on a workspace watch", () =>
    Effect.gen(function*() {
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      yield* control.approve(approvalOf(card))

      // A snapshot read has to end, so nothing is merged into it.
      const snapshot = yield* Stream.runCollect(control.watch({ follow: false }))
      expect(snapshot.length).toBeGreaterThan(0)
      expect(snapshot.filter((event) => event.kind === GatewayServer.watchHeartbeatKind)).toEqual([])

      // A workspace-wide watch is not about one run, so its keepalive names
      // none: a client routing by run must not route a keepalive anywhere.
      const beats = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(control.watch({ follow: true }), (event) => event.kind === GatewayServer.watchHeartbeatKind),
          1
        )
      )
      expect(beats[0]?.runId).toBeUndefined()
      expect(beats[0]?.payload).toBeNull()
    }).pipe(Effect.provide(kept)))

  test("repeats the sequence of the last event it delivered, not the resume seed", () =>
    Effect.gen(function*() {
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      yield* control.approve(approvalOf(card))
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: `run:${card.planId}`
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
      const runId = receipt.runId

      // Resume from before the run's history, so the follow delivers every
      // recorded event and then goes idle. The keepalive that follows must
      // carry the last delivered sequence, which the seed of 0 is not.
      const frames = yield* Stream.runCollect(
        Stream.takeUntil(
          control.watch({ runId, afterSequence: 0, follow: true }),
          (event) => event.kind === GatewayServer.watchHeartbeatKind
        )
      )
      const delivered = frames.filter((event) => event.kind !== GatewayServer.watchHeartbeatKind)
      const beat = frames.at(-1)
      expect(delivered.length).toBeGreaterThan(0)
      expect(beat?.kind).toBe(GatewayServer.watchHeartbeatKind)
      expect(beat?.sequence).toBe(delivered.at(-1)?.sequence)
      expect(beat?.sequence).not.toBe(0)
    }).pipe(Effect.provide(kept)))

  test("passes source events through a followed watch", () =>
    Effect.gen(function*() {
      const control = yield* Control
      const watching = yield* Stream.runCollect(Stream.take(control.watch({ follow: true }), 1)).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* control.plan({ flowId: "system/test", input: {} })
      const events = yield* Fiber.join(watching)
      expect(events.length).toBe(1)
      expect(events[0]?.kind).not.toBe(GatewayServer.watchHeartbeatKind)
    }).pipe(Effect.provide(GatewayServer.layerKeepAlive(60_000).pipe(Layer.provideMerge(stack())))))
})

describe("gateway bind policy", () => {
  it.effect.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuses the invalid body limit %s through the layer error channel",
    (maxRequestBodyBytes) =>
      Effect.gen(function*() {
        const refusal = yield* Effect.flip(
          Layer.build(
            GatewayServer.layerIngress({ maxRequestBodyBytes }) as Layer.Layer<never, GatewayError>
          ).pipe(Effect.scoped)
        )
        expect(refusal.code).toBe("bind_failed")
        expect(refusal.message).toContain("request body limit")
        expect(NodeGateway.bindRefusal({ port: 0, maxRequestBodyBytes })?.code).toBe("bind_failed")
      })
  )

  it.effect.each([0, -1, 1.5])(
    "refuses the invalid keepalive cadence %s through typed effects",
    (heartbeatMillis) =>
      Effect.gen(function*() {
        // A cadence of zero makes `Stream.tick` a tight loop that floods every
        // subscriber, so every construction boundary refuses it before bind.
        const assembled = yield* Effect.flip(
          Layer.build(
            GatewayServer.layer(health, { heartbeatMillis }) as Layer.Layer<never, GatewayError>
          ).pipe(Effect.scoped)
        )
        expect(assembled.code).toBe("bind_failed")
        expect(assembled.message).toContain("keepalive cadence")
        expect(
          (yield* Effect.flip(makeProjections({} as unknown as ControlService, { heartbeatMillis }))).code
        ).toBe("bind_failed")
        expect(NodeGateway.bindRefusal({ port: 0, heartbeatMillis })?.code).toBe("bind_failed")
      })
  )

  it("accepts a positive cadence and body limit", () => {
    expect(NodeGateway.bindRefusal({ port: 0, heartbeatMillis: 25, maxRequestBodyBytes: 64 })).toBeUndefined()
  })

  for (const host of [undefined, "::1", "0.0.0.0", "::"] as const) {
    test(`serves health through the ingress authority for bind ${host ?? "default"}`, () =>
      Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        if (server.address._tag !== "InetAddressV4" && server.address._tag !== "InetAddressV6") {
          return yield* Effect.die("expected TCP")
        }
        const hostname = host === "::1" || host === "::" ? "[::1]" : "127.0.0.1"
        const port = server.address.port
        const response = yield* Effect.promise(() => fetch(`http://${hostname}:${port}/health`))
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toEqual(health)
      }).pipe(
        Effect.provide(
          served({ port: 0, ...(host === undefined ? {} : { host }), listen: true, credential: "test-credential" })
        )
      ))
  }

  it.effect("rejects an unparseable configured bind as a typed bind failure", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        Layer.build(served({ host: "invalid:host", port: 0, listen: true, credential: "test-credential" }))
      )
      expect(error).toMatchObject({ code: "bind_failed" })
    }).pipe(Effect.scoped))

  it.effect("defaults a bind with no host to loopback", () =>
    Effect.gen(function*() {
      expect(yield* NodeGateway.listenOptions({ port: 0 })).toEqual({ port: 0, host: "127.0.0.1" })
      expect(NodeGateway.bindRefusal({ port: 0 })).toBeUndefined()
    }))

  it.effect("accepts every loopback spelling with no opt-in and no credential", () =>
    Effect.gen(function*() {
      for (const host of ["127.0.0.1", "::1", "localhost"]) {
        expect(NodeGateway.isLoopbackHost(host)).toBe(true)
        expect(yield* NodeGateway.listenOptions({ host, port: 0 })).toEqual({ host, port: 0 })
      }
    }))

  it("spells the loopback names once, in bind form and in Host-header form", () => {
    expect(GatewayServer.loopbackHostNames).toEqual(["127.0.0.1", "localhost", "::1"])
    expect(GatewayServer.loopbackHostHeaderNames).toEqual(["127.0.0.1", "localhost", "[::1]"])
    for (const host of GatewayServer.loopbackHostNames) expect(NodeGateway.isLoopbackHost(host)).toBe(true)
    expect(NodeGateway.ingressOptions({}).allowedHosts).toEqual(GatewayServer.loopbackHostHeaderNames)
  })

  it("classifies every other host as reachable from elsewhere", () => {
    // `127.0.0.2` is loopback to the kernel and is not one of the three names
    // this policy accepts: the policy is a list of spellings a person types,
    // not a subnet test, and widening it silently is how a gateway ends up
    // reachable without the opt-in.
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com", "", "127.0.0.2"]) {
      expect(NodeGateway.isLoopbackHost(host)).toBe(false)
    }
  })

  it.effect("refuses a non-loopback bind without an explicit --listen", () =>
    Effect.gen(function*() {
      expect((yield* Effect.flip(NodeGateway.listenOptions({ host: "0.0.0.0", port: 0 }))).message).toMatch(
        /--listen/
      )
      expect(
        (yield* Effect.flip(NodeGateway.listenOptions({ host: "0.0.0.0", port: 0, listen: false }))).message
      ).toMatch(/--listen/)
    }))

  it.effect("refuses a non-loopback bind without a bearer credential", () =>
    Effect.gen(function*() {
      expect(
        (yield* Effect.flip(NodeGateway.listenOptions({ host: "0.0.0.0", port: 0, listen: true }))).message
      ).toMatch(/bearer credential/)
      expect(
        (yield* Effect.flip(
          NodeGateway.listenOptions({ host: "0.0.0.0", port: 0, listen: true, credential: "" })
        )).message
      ).toMatch(/bearer credential/)
    }))

  it.effect("accepts a credentialed non-loopback bind that opted in", () =>
    Effect.gen(function*() {
      expect(
        yield* NodeGateway.listenOptions({
          host: "0.0.0.0",
          port: 0,
          listen: true,
          credential: "secret",
          maxRequestBodyBytes: 128
        })
      ).toEqual({
        host: "0.0.0.0",
        port: 0
      })
    }))

  it.effect("maps an operating-system listen failure to a sanitized gateway refusal and logs the cause", () =>
    Effect.scoped(Effect.gen(function*() {
      const logged: Array<unknown> = []
      const occupied = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            new Promise<{ readonly port: number; readonly server: ReturnType<typeof createServer> }>(
              (resolve, reject) => {
                const server = createServer()
                server.once("error", reject)
                server.listen(0, "127.0.0.1", () => {
                  const address = server.address()
                  if (address === null || typeof address === "string") {
                    reject(new Error("expected a TCP address"))
                  } else {
                    resolve({ port: address.port, server })
                  }
                })
              }
            ),
          catch: (cause) => cause
        }),
        ({ server }) =>
          Effect.promise(() =>
            new Promise<void>((resolve) => {
              server.close(() => resolve())
            })
          )
      )
      const failure = yield* Effect.flip(
        Layer.build(served({ host: "127.0.0.1", port: occupied.port }))
      ).pipe(Effect.provide(Logger.layer([Logger.make(({ logLevel, message }) => {
        logged.push({ logLevel, message })
      })])))

      expect(failure).toBeInstanceOf(GatewayError)
      if (!(failure instanceof GatewayError)) throw failure
      expect(failure.code).toBe("bind_failed")
      expect(failure.cause).toEqual({ _tag: "ServeError" })
      expect(JSON.stringify(failure)).not.toContain("127.0.0.1")
      // The wire error is sanitized for every bearer holder; the operator's
      // copy, with the requested authority and the errno, is the server log.
      expect(logged).toHaveLength(1)
      const [entry] = logged as ReadonlyArray<{
        readonly logLevel: string
        readonly message: ReadonlyArray<{
          readonly message: string
          readonly host: string
          readonly port: number
          readonly cause: { readonly _tag: string; readonly cause: { readonly code: string } }
        }>
      }>
      expect(entry?.logLevel).toBe("Error")
      expect(entry?.message).toHaveLength(1)
      const line = entry?.message[0]
      expect(line).toMatchObject({
        message: "The gateway socket could not be bound",
        host: "127.0.0.1",
        port: occupied.port
      })
      expect(line?.cause._tag).toBe("ServeError")
      expect(line?.cause.cause.code).toBe("EADDRINUSE")
    })))

  it("admits the concrete bind host and nothing else beyond the loopback names", () => {
    const admitted = (host: string) =>
      NodeGateway.ingressOptions({ host, port: 7331, listen: true, credential: "secret" }).allowedHosts
    expect(admitted("10.0.0.5")).toEqual([...GatewayServer.loopbackHostHeaderNames, "10.0.0.5"])
    expect(admitted("fe80::1")).toEqual([...GatewayServer.loopbackHostHeaderNames, "[fe80::1]"])
    // A wildcard bind is every interface, and every interface is not a Host
    // name: the operator names the reachable ones through `allowedHosts`.
    expect(admitted("0.0.0.0")).toEqual(GatewayServer.loopbackHostHeaderNames)
    expect(admitted("::")).toEqual(GatewayServer.loopbackHostHeaderNames)
    expect(
      NodeGateway.ingressOptions({ host: "0.0.0.0", listen: true, credential: "s", allowedHosts: ["lan.example"] })
        .allowedHosts
    ).toEqual([...GatewayServer.loopbackHostHeaderNames, "lan.example"])
    expect(NodeGateway.ingressOptions({ port: 7331 }).allowedHosts).toEqual(GatewayServer.loopbackHostHeaderNames)
  })

  it.effect("serves the concrete bind host through the ingress Host policy", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          Layer.mergeAll(
            HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
            GatewayServer.layerIngress(
              NodeGateway.ingressOptions({ host: "10.0.0.5", port: 7331, listen: true, credential: "secret" })
            )
          ).pipe(Layer.provide(RpcSerialization.layerNdjson)),
          { disableLogger: true }
        )
      ),
      ({ handler }) =>
        Effect.gen(function*() {
          const status = (host: string) =>
            Effect.promise(async () =>
              (await handler(new Request("http://gateway/health", { headers: { host } }))).status
            )
          expect(yield* status("10.0.0.5:7331")).toBe(200)
          expect(yield* status("10.0.0.5")).toBe(200)
          expect(yield* status("127.0.0.1:7331")).toBe(200)
          expect(yield* status("10.0.0.6:7331")).toBe(421)
        }),
      ({ dispose }) => Effect.promise(() => dispose())
    ))

  it("defaults to a loopback bind on the gateway port", () => {
    expect(NodeGateway.defaultServerOptions).toEqual({ host: "127.0.0.1", port: 7331 })
  })
})

describe("gateway credential policy", () => {
  /** The path `ControlClient`'s HTTP protocol actually posts a call to. */
  const clientRpcPath = "/rpc/"

  test("refuses an unauthenticated control call in band and accepts the configured credential", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      // A payload the `List` procedure can actually decode: an edge 401 used
      // to answer before anything looked at it, so `payload: {}` passed here
      // while dying inside the mount on `ListRequest`.
      const body = `${
        JSON.stringify({ _tag: "Request", id: 1, tag: "List", payload: { _tag: "runs" }, headers: [] })
      }\n`
      const call = (credential: string | undefined) =>
        Effect.promise(async () => {
          const response = await fetch(`${url}${clientRpcPath}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` })
            },
            body
          })
          return { status: response.status, body: await response.text() }
        })

      // Fail closed, on the path the client really uses, and fail closed in
      // the control plane's own vocabulary. `ControlRpcs.ControlAuth` declares
      // `Unauthorized` as its error, and the trust-posture guide promises that
      // a missing and a wrong credential both return that typed control error;
      // an edge 401 here reached `ControlClient` as a `TransportError`
      // instead, which is the class reserved for a request that never got a
      // declared control response at all.
      const none = yield* call(undefined)
      const wrong = yield* call("alpha-secre")
      for (const [name, response] of [["none", none], ["wrong", wrong]] as const) {
        expect([name, response.status]).toEqual([name, 200])
        expect([name, response.body.includes("/control/Unauthorized")]).toEqual([name, true])
      }

      // The configured credential still travels the same path and is served.
      const accepted = yield* Effect.flatMap(Control, (control) => control.plan({ flowId: "system/test", input: {} }))
        .pipe(Effect.provide(client(url, "alpha-secret")))
      expect(accepted.flowId).toBe("system/test")
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, credential: "alpha-secret" }))))

  test("refuses a wrong credential the same way it refuses none", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const refusal = (credential: string | undefined) =>
        Effect.flip(
          Effect.flatMap(Control, (control) => control.plan({ flowId: "system/test", input: {} })).pipe(
            Effect.provide(client(url, credential))
          )
        )
      // The refusal a caller reads is the mount's own typed `Unauthorized`,
      // not a transport failure standing in for it, and a wrong credential
      // reads exactly like none.
      const wrong = yield* refusal("alpha-secre")
      const none = yield* refusal(undefined)
      expect(wrong._tag).toBe("/control/Unauthorized")
      expect(none._tag).toBe("/control/Unauthorized")
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, credential: "alpha-secret" }))))
})

describe("gateway error vocabulary", () => {
  test("reaches callers through every behavioral gateway error code", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const projections = yield* Projections
      const postCode = (body: string, credential?: string | undefined, path = "/rpc") =>
        Effect.promise(async () => {
          const response = await fetch(`${url}${path}`, {
            method: "POST",
            headers: {
              ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
              "content-type": "application/json"
            },
            body
          })
          return (await response.json() as { readonly code: string }).code
        })
      const localIngressCode = (headers: Readonly<Record<string, string>>) =>
        Effect.acquireUseRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              Layer.mergeAll(
                HttpRouter.add("POST", "/rpc", HttpServerResponse.text("served")),
                GatewayServer.layerIngress({ loopbackOnly: true })
              ).pipe(Layer.provide(RpcSerialization.layerNdjson)),
              { disableLogger: true }
            )
          ),
          ({ handler }) =>
            Effect.promise(async () => {
              const response = await handler(
                new Request("http://127.0.0.1/rpc", {
                  method: "POST",
                  headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
                  body: exactBody
                })
              )
              return ((await response.json()) as { readonly code: string }).code
            }),
          ({ dispose }) => Effect.promise(dispose)
        )
      const unavailable = Effect.runSync(makeProjections({
        list: () => Effect.fail(new Unavailable({ code: "unavailable", feature: "list", ticket: "T-errors" })),
        watch: () => Stream.empty
      } as unknown as ControlService))
      // Event histories are now windowed and paged rather than refused, so the
      // remaining `resource_limit` path is a projected row set too large to put
      // on the wire.
      const oversized = Effect.runSync(makeProjections({
        list: () =>
          Effect.succeed({
            _tag: "runs",
            items: [{
              runId: "oversized-run",
              flowId: "x".repeat(maxProjectionBytes),
              status: "running",
              createdAt: 0,
              updatedAt: 0
            }]
          }),
        watch: () => Stream.empty
      } as unknown as ControlService))
      const table = [
        [
          "bind_failed",
          Effect.sync(() => NodeGateway.bindRefusal({ host: "0.0.0.0", port: 0 })?.code)
        ],
        ["invalid_host", localIngressCode({ host: "gateway.example" })],
        ["invalid_origin", localIngressCode({ origin: "https://evil.example" })],
        // `/projections`, because `/rpc` is authenticated in band and answers
        // `@smthrs/control`'s typed `Unauthorized` rather than this code.
        ["unauthorized", postCode("{}", undefined, "/projections")],
        ["malformed_request", postCode("{}", "edge-secret")],
        ["request_too_large", postCode("x".repeat(256), "edge-secret")],
        [
          "resource_limit",
          Effect.map(
            Effect.flip(oversized.snapshot({ _tag: "workspace-runs" })),
            (failure) => failure.code
          )
        ],
        [
          "run_unavailable",
          Effect.map(Effect.flip(unavailable.snapshot({ _tag: "workspace-runs" })), (failure) => failure.code)
        ],
        [
          "run_not_found",
          Effect.map(
            Effect.flip(projections.snapshot({ _tag: "run-summary", runId: "missing-run" })),
            (failure) => failure.code
          )
        ]
      ] as const satisfies ReadonlyArray<readonly [GatewayErrorCodeValue, Effect.Effect<string | undefined, unknown>]>

      for (const [expected, operation] of table) {
        expect(yield* operation).toBe(expected)
      }
      // The declared vocabulary is exactly the vocabulary the table just
      // produced, so a code cannot outlive the path that constructs it.
      expect([...GatewayErrorCode.literals].sort()).toEqual(table.map(([code]) => code as string).sort())
    }).pipe(Effect.provide(served({
      host: "127.0.0.1",
      port: 0,
      credential: "edge-secret",
      maxRequestBodyBytes: 64
    }))))
})

describe("gateway startup", () => {
  test("comes up and answers /health with a read path that cannot read", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* Effect.promise(() => fetch(`${url}/health`))
      // Startup must never be blocked by a subsystem that failed to recover:
      // a supervisor still has to be able to ask which workspace this is.
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json() as Promise<unknown>)).toEqual(health)
    }).pipe(
      Effect.provide(
        NodeGateway.layer(health, { host: "127.0.0.1", port: 0 }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(Projections, {
                snapshot: () => Effect.fail(new GatewayError({ code: "run_unavailable", message: "recovery boom" })),
                subscribe: () => Stream.fail(new GatewayError({ code: "run_unavailable", message: "recovery boom" }))
              }),
              SyncServer.layerNoop,
              Layer.succeed(SyncAuthTag, () => Effect.die("sync is unavailable"))
            ).pipe(Layer.provideMerge(stack()))
          )
        )
      )
    ))
})

describe("single-use WebSocket tickets for browser clients", () => {
  const upgrade = (url: string, target: string) =>
    Effect.promise(() =>
      raw(`${url}${target}`, [
        `GET ${target} HTTP/1.1`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
      ])
    )
  const issue = (url: string, credential?: string) =>
    Effect.promise(() =>
      fetch(`${url}/auth/ticket`, {
        method: "POST",
        headers: credential === undefined ? {} : { authorization: `Bearer ${credential}` }
      })
    )
  const ticketOf = (url: string) =>
    Effect.gen(function*() {
      const response = yield* issue(url, "edge-secret")
      expect(response.status).toBe(200)
      const body = (yield* Effect.promise(() => response.json())) as { ticket: string; expiresInMs: number }
      expect(body.ticket).toMatch(/^[0-9a-f]{64}$/)
      return body
    })
  const list = `${JSON.stringify({ _tag: "Request", id: 1, tag: "List", payload: { _tag: "runs" }, headers: [] })}\n`
  const credentialed = served({ host: "127.0.0.1", port: 0, credential: "edge-secret" })

  test("exchanges a bearer for a short-lived ticket and refuses anyone else", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const { expiresInMs } = yield* ticketOf(url)
      expect(expiresInMs).toBe(GatewayServer.defaultTicketMillis)
      expect((yield* issue(url, "edge-secret")).headers.get("cache-control")).toBe("no-store")
      for (const credential of [undefined, "wrong-secret"]) {
        const refused = yield* issue(url, credential)
        expect(refused.status).toBe(401)
        expect(yield* Effect.promise(() => refused.json() as Promise<unknown>)).toMatchObject({
          code: "unauthorized"
        })
      }
      // A browser page from another origin cannot mint one either.
      const crossOrigin = yield* Effect.promise(() =>
        fetch(`${url}/auth/ticket`, {
          method: "POST",
          headers: { authorization: "Bearer edge-secret", origin: "https://attacker.example" }
        })
      )
      expect(crossOrigin.status).toBe(403)
    }).pipe(Effect.provide(credentialed)))

  test("opens a protected socket once without a header, then refuses the replay", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const ws = url.replace("http://", "ws://")
      for (const path of ["/rpc/ws", "/projections/ws", "/sync/ws"]) {
        const { ticket } = yield* ticketOf(url)
        expect([path, (yield* upgrade(url, `${path}?ticket=${ticket}`)).status]).toEqual([path, 101])
        expect([path, (yield* upgrade(url, `${path}?ticket=${ticket}`)).status]).toEqual([path, 401])
      }
      // The redeemed socket carries the bearer's identity on every frame, so a
      // control call answers Success rather than `/control/Unauthorized`.
      const { ticket } = yield* ticketOf(url)
      const frames = yield* Effect.promise(() => socketExchange(`${ws}/rpc/ws?ticket=${ticket}`, undefined, list))
      const exit = frames.flatMap((frame) => frame.split("\n")).find((line) => line.includes("\"Exit\""))
      expect(exit).toContain("\"Success\"")
      expect(exit).not.toContain("Unauthorized")
    }).pipe(Effect.provide(credentialed)))

  test("refuses an unknown ticket and never unlocks a request/response mount", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      expect((yield* upgrade(url, `/rpc/ws?ticket=${"0".repeat(64)}`)).status).toBe(401)
      expect((yield* upgrade(url, "/rpc/ws?ticket=")).status).toBe(401)
      const { ticket } = yield* ticketOf(url)
      const post = yield* Effect.promise(() =>
        fetch(`${url}/projections?ticket=${ticket}`, { method: "POST", body: list })
      )
      expect(post.status).toBe(401)
      // A router-equivalent spelling of a socket mount redeems like the mount.
      const alias = yield* ticketOf(url)
      expect((yield* upgrade(url, `/RPC/WS/?ticket=${alias.ticket}`)).status).toBe(101)
    }).pipe(Effect.provide(credentialed)))

  test("admits exactly one of two concurrent upgrades presenting one ticket", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const { ticket } = yield* ticketOf(url)
      const statuses = yield* Effect.all(
        [upgrade(url, `/rpc/ws?ticket=${ticket}`), upgrade(url, `/rpc/ws?ticket=${ticket}`)],
        { concurrency: "unbounded" }
      )
      expect(statuses.map((response) => response.status).sort()).toEqual([101, 401])
    }).pipe(Effect.provide(credentialed)))

  test("is not offered by a gateway with no bearer credential", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      expect((yield* issue(url)).status).toBe(404)
    }).pipe(Effect.provide(served())))

  describe("at the ingress seam", () => {
    /** A socket mount that answers the Authorization header it was handed. */
    const echo = Effect.map(
      HttpServerRequest.HttpServerRequest,
      (request) => HttpServerResponse.text(request.headers.authorization ?? "none")
    )
    const bound = (ticketMillis: number) =>
      HttpRouter.serve(
        Layer.mergeAll(
          HttpRouter.add("GET", "/rpc/ws", echo),
          GatewayServer.layerIngress({
            ticketMillis,
            authorize: (headers) => Effect.succeed(headers.authorization === "Bearer edge-secret")
          })
        ).pipe(Layer.provide(RpcSerialization.layerNdjson)),
        { disableListenLog: true, disableLogger: true }
      ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })))

    test("hands the socket mount the bearer the ticket was issued under", () =>
      Effect.gen(function*() {
        const url = yield* baseUrl
        const { ticket } = yield* ticketOf(url)
        const response = yield* Effect.promise(() => fetch(`${url}/rpc/ws?ticket=${ticket}`))
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.text())).toBe("Bearer edge-secret")
      }).pipe(Effect.provide(bound(30_000))))

    test("refuses a ticket presented after its lifetime", () =>
      Effect.gen(function*() {
        const url = yield* baseUrl
        const { expiresInMs, ticket } = yield* ticketOf(url)
        expect(expiresInMs).toBe(20)
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 60)))
        const response = yield* Effect.promise(() => fetch(`${url}/rpc/ws?ticket=${ticket}`))
        expect(response.status).toBe(401)
      }).pipe(Effect.provide(bound(20))))

    it("refuses a ticket lifetime that is not a positive safe integer", () =>
      Effect.runPromise(
        Effect.flip(Layer.build(bound(0)).pipe(Effect.scoped)).pipe(
          Effect.map((error) => expect(error).toMatchObject({ code: "bind_failed" }))
        )
      ))
  })
})

describe("scoped tokens over the served gateway", () => {
  const key = "edge-secret"
  const frame = (tag: string, payload: unknown) =>
    `${JSON.stringify({ _tag: "Request", id: 1, tag, payload, headers: [] })}\n`
  const listRuns = frame("List", { _tag: "runs" })
  const workspaceRuns = frame("Projection.Snapshot", { selector: { _tag: "workspace-runs" } })
  const post = (url: string, mount: string, credential: string | undefined, body: string) =>
    Effect.promise(async () => {
      const response = await fetch(`${url}/${mount}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` })
        },
        body
      })
      return { status: response.status, body: await response.text() }
    })
  const upgrade = (url: string, mount: string, credential: string) =>
    Effect.promise(() =>
      raw(`${url}/${mount}/ws`, [
        `GET /${mount}/ws HTTP/1.1`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        `Authorization: Bearer ${credential}`
      ])
    )

  test("a read:runs token reads on every mount, cannot mutate, and expires everywhere", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const control = yield* Control
      const { token } = yield* ScopedToken.mint({ key, scopes: ["read:runs"], ttlMillis: 60_000 })
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      const approve = frame("Approve", { ...card.approval, idempotencyKey: "approve" })
      const submit = frame("Approval.Submit", { ...card.approval, decision: "approve", idempotencyKey: "submit" })

      // Reads, over HTTP and over the socket, on both RPC mounts.
      const read = yield* post(url, "rpc", token, listRuns)
      expect([read.status, read.body.includes("\"Success\"")]).toEqual([200, true])
      const snapshot = yield* post(url, "projections", token, workspaceRuns)
      expect([snapshot.status, snapshot.body.includes("\"Success\"")]).toEqual([200, true])
      const socketRead = yield* Effect.promise(() => socketExchange(`${url}/rpc/ws`, token, listRuns))
      expect(socketRead.join("\n")).toContain("\"Success\"")
      const socketSnapshot = yield* Effect.promise(() => socketExchange(`${url}/projections/ws`, token, workspaceRuns))
      expect(socketSnapshot.join("\n")).toContain("\"Success\"")

      // A mutation is refused in band, on both mounts and both transports, and
      // the plan is untouched.
      const refusedApprove = yield* post(url, "rpc", token, approve)
      expect([refusedApprove.status, refusedApprove.body.includes("/control/Unauthorized")]).toEqual([200, true])
      expect(refusedApprove.body).toContain("does not authorize Approve")
      const refusedSubmit = yield* post(url, "projections", token, submit)
      expect(refusedSubmit.body).toContain("does not authorize Approval.Submit")
      const refusedPlan = yield* post(url, "rpc", token, frame("Plan", { flowId: "system/test", input: {} }))
      expect(refusedPlan.body).toContain("does not authorize Plan")
      const socketApprove = yield* Effect.promise(() => socketExchange(`${url}/rpc/ws`, token, approve))
      expect(socketApprove.join("\n")).toContain("does not authorize Approve")
      const runtime = yield* ControlRuntime
      expect((yield* runtime.getPlan(card.planId)).decision).toBe("pending")

      // Expired: the edge refuses a socket and the projections mount, and the
      // control mount refuses in band with the control plane's own error.
      const { token: expired } = yield* ScopedToken.mint({
        key,
        scopes: ["read:runs"],
        ttlMillis: 1_000,
        now: () => Date.now() - 5_000
      })
      const expiredRead = yield* post(url, "rpc", expired, listRuns)
      expect([expiredRead.status, expiredRead.body.includes("The scoped token has expired")]).toEqual([200, true])
      const expiredSnapshot = yield* post(url, "projections", expired, workspaceRuns)
      expect([expiredSnapshot.status, JSON.parse(expiredSnapshot.body).code]).toEqual([401, "unauthorized"])
      for (const mount of ["rpc", "projections", "sync"]) {
        expect([mount, (yield* upgrade(url, mount, expired)).status]).toEqual([mount, 401])
      }

      // Forged under another key: refused exactly like a wrong bearer.
      const { token: forged } = yield* ScopedToken.mint({ key: "not-the-key", scopes: ["read:runs"], ttlMillis: 60_000 })
      expect((yield* post(url, "projections", forged, workspaceRuns)).status).toBe(401)
      expect((yield* post(url, "rpc", forged, listRuns)).body).toContain("/control/Unauthorized")
      expect((yield* upgrade(url, "rpc", forged)).status).toBe(401)
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, credential: key }))))

  test("a run-confined token acts on that run and on nothing else", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const runId = yield* launched
      const { token } = yield* ScopedToken.mint({ key, scopes: ["read:runs", "write:runs"], ttlMillis: 60_000, runId })

      const summary = yield* post(url, "projections", token, frame("Projection.Snapshot", {
        selector: { _tag: "run-summary", runId }
      }))
      expect(summary.body).toContain("\"Success\"")
      const filtered = yield* post(url, "rpc", token, frame("List", { _tag: "runs", filters: { runId } }))
      expect(filtered.body).toContain("\"Success\"")
      // Naming another run, or no run, is refused rather than widened.
      const other = yield* post(url, "projections", token, frame("Projection.Snapshot", {
        selector: { _tag: "run-summary", runId: "some-other-run" }
      }))
      expect(other.body).toContain("does not authorize Projection.Snapshot")
      expect((yield* post(url, "projections", token, workspaceRuns)).body).toContain("does not authorize")
      expect((yield* post(url, "rpc", token, listRuns)).body).toContain("does not authorize List")
      const cancelOther = yield* post(url, "rpc", token, frame("Cancel", {
        runId: "some-other-run",
        idempotencyKey: "cancel-other"
      }))
      expect(cancelOther.body).toContain("does not authorize Cancel")
      const cancelled = yield* post(url, "rpc", token, frame("Cancel", { runId, idempotencyKey: "cancel-this" }))
      expect(cancelled.body).toContain("\"Success\"")
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, credential: key }))))

  for (const delegated of [false, true]) {
    test(`an approve:runs token stamps gateway/scoped, which is ${delegated ? "" : "not "}delegated here`, () =>
      Effect.gen(function*() {
        const url = yield* baseUrl
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const card = yield* control.plan({ flowId: "system/test", input: {} })
        const { token } = yield* ScopedToken.mint({ key, scopes: ["approve:runs"], ttlMillis: 60_000 })
        const approved = yield* post(url, "rpc", token, frame("Approve", { ...card.approval, idempotencyKey: "a" }))
        expect(approved.status).toBe(200)
        expect(approved.body.includes("\"Success\""), approved.body).toBe(delegated)
        if (!delegated) expect(approved.body).toContain("/control/Unauthorized")
        expect((yield* runtime.getPlan(card.planId)).decision).toBe(delegated ? "approved" : "pending")
      }).pipe(Effect.provide(served(
        { host: "127.0.0.1", port: 0, credential: key },
        delegated
          ? Effect.runSync(ApprovalAuthority.make([
            { principal: NodeGateway.scopedPrincipal, scopes: ["once", "run", "remembered"], targets: ["Plan"] }
          ]))
          // Delegating to the bearer does not delegate to every token minted from it.
          : delegatedBearer
      ))))
  }

  test("the runtime bridge accepts the bearer alone", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const { token } = yield* ScopedToken.mint({ key, scopes: ["read:runs", "write:runs"], ttlMillis: 60_000 })
      const observe = (credential: string) =>
        Effect.promise(() =>
          fetch(`${url}/runtime/v1/observe`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
            body: JSON.stringify({ protocol: 1, runId: "run-1" })
          })
        )
      expect((yield* observe(token)).status).toBe(401)
      expect((yield* observe(key)).status).not.toBe(401)
    }).pipe(Effect.provide(served({
      host: "127.0.0.1",
      port: 0,
      credential: key,
      runtimeBridge: { runtimeArtifactDigest: "digest", sourceRevision: "revision", ownerGeneration: 1 }
    }))))

  test("a scoped token reaches no journal sync mount, directly or through a ticket", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const { token } = yield* ScopedToken.mint({ key, scopes: ["read:runs", "write:runs", "approve:runs"], ttlMillis: 60_000 })
      const sync = (credential: string) =>
        Effect.promise(() =>
          fetch(`${url}/sync`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
            body: "{}"
          })
        )
      expect((yield* sync(token)).status).toBe(401)
      expect((yield* sync(key)).status).not.toBe(401)
      // The token still mints a ticket, and the ticket opens its control socket
      // but not the sync socket: the redeemed credential is judged per mount.
      const ticketFor = Effect.promise(async () => {
        const response = await fetch(`${url}/auth/ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } })
        expect(response.status).toBe(200)
        return ((await response.json()) as { readonly ticket: string }).ticket
      })
      const opened = (target: string) =>
        Effect.promise(() =>
          raw(`${url}${target}`, [
            `GET ${target} HTTP/1.1`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
          ])
        )
      expect((yield* opened(`/sync/ws?ticket=${yield* ticketFor}`)).status).toBe(401)
      expect((yield* opened(`/rpc/ws?ticket=${yield* ticketFor}`)).status).toBe(101)
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, credential: key }))))
})
