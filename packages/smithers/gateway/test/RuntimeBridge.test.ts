import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { describe, expect, it } from "@effect/vitest"
import * as Control from "@smthrs/control/Control"
import * as ControlError from "@smthrs/control/ControlError"
import type { PlanCard, Principal, RunSummary } from "@smthrs/control/ControlSchema"
import { Effect, Layer, Logger, Schema, Stream } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import * as NodeGateway from "../src/node/NodeGateway.ts"
import * as RuntimeBridge from "../src/RuntimeBridge.ts"
import { stack } from "./GatewayStack.ts"

const digest = "a".repeat(64)
const revision = "b".repeat(40)
const privateMessage = "fixture-private-path /private/runtime.db SELECT fixture_secret"
const principal: Principal = { id: "gateway", kind: "bearer", stampedAt: 1 }
const accepted = { _tag: "Accepted", receiptId: "receipt-1", runId: "run-1" } as const
const envelope = { capabilities: [], flows: [], budget: {} }
const plan = {
  planId: "plan-1",
  flowId: "fixture/small",
  digest: "plan-digest",
  executionDigest: "c".repeat(64),
  inputSummary: "fixture",
  envelope,
  deployClass: false,
  nodes: [],
  graph: { edges: [], sourceRevision: revision },
  approval: {
    target: { _tag: "Plan", planId: "plan-1", digest: "plan-digest", envelope },
    scope: "run",
    idempotencyKey: "card-approval"
  }
} as unknown as PlanCard

const summary = {
  runId: "run-1",
  flowId: "fixture/small",
  status: "completed",
  createdAt: 1,
  updatedAt: 2
} as RunSummary

const service = (overrides: Partial<Control.Service> = {}): Control.Service =>
  Control.make({
    plan: () => Effect.succeed(plan),
    run: () => Effect.succeed(accepted),
    approve: () => Effect.succeed(accepted),
    deny: () => Effect.succeed(accepted),
    signal: () => Effect.succeed(accepted),
    steer: () => Effect.succeed(accepted),
    cancel: () => Effect.succeed(accepted),
    resume: () => Effect.succeed(accepted),
    list: () => Effect.succeed({ _tag: "runs", items: [summary] }),
    watch: () =>
      Stream.make({
        sequence: 4,
        cursor: { sequence: 4 },
        kind: "control.run.completed",
        runId: "run-1",
        occurredAt: 1,
        payload: null
      }),
    ...overrides
  })

const config: RuntimeBridge.Config = {
  runtimeArtifactDigest: digest,
  sourceRevision: revision,
  ownerGeneration: 7,
  authenticate: () => Effect.succeed(principal)
}

const launch: RuntimeBridge.Command = {
  protocol: RuntimeBridge.protocol,
  operation: "launch",
  applicationRequestId: "request-1",
  ownerGeneration: 7,
  attempt: 2,
  runtimeArtifactDigest: digest,
  sourceRevision: revision,
  flowId: "fixture/small",
  payload: { value: 1 }
}

const directBridge = (control: Control.Service, bridgeConfig: RuntimeBridge.Config = config) =>
  HttpRouter.serve(RuntimeBridge.layer(bridgeConfig), {
    disableListenLog: true,
    disableLogger: true
  }).pipe(
    Layer.provide(Layer.succeed(Control.Control, control)),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    Layer.orDie
  )

describe("RuntimeBridge", () => {
  it("decodes the shared Go/TypeScript wire fixture", () => {
    const fixture = JSON.parse(readFileSync(new URL("../testdata/runtime-bridge-v1.json", import.meta.url), "utf8"))
    expect(() => Schema.decodeUnknownSync(RuntimeBridge.LaunchCommand)(fixture.launch)).not.toThrow()
    expect(() => Schema.decodeUnknownSync(RuntimeBridge.CommandResponse)(fixture.commandResponse)).not.toThrow()
    expect(() => Schema.decodeUnknownSync(RuntimeBridge.ObserveResponse)(fixture.observeResponse)).not.toThrow()
  })
  it.effect("launches through Control with stable plan and attempt identities", () =>
    Effect.gen(function*() {
      const calls: Array<unknown> = []
      const control = service({
        plan: (input) =>
          Effect.sync(() => {
            calls.push(input)
            return plan
          }),
        run: (input) =>
          Effect.sync(() => {
            calls.push(input)
            return accepted
          })
      })
      const result = yield* RuntimeBridge.execute(config, control, principal, launch)
      expect(result.operation).toBe("launch")
      expect(result.receipt).toEqual(accepted)
      expect(result).toMatchObject({
        planDigest: "plan-digest",
        executionDigest: "c".repeat(64),
        envelope
      })
      expect(calls).toEqual([
        { flowId: "fixture/small", input: { value: 1 }, idempotencyKey: "bridge:v1:request-1:plan" },
        {
          _tag: "Plan",
          planId: "plan-1",
          digest: "plan-digest",
          envelope,
          idempotencyKey: "bridge:v1:request-1:run:2",
          principal
        }
      ])
    }))

  it.effect("omits an execution digest when the plan does not provide one", () =>
    Effect.gen(function*() {
      const { executionDigest: _executionDigest, ...withoutDigest } = plan
      const control = service({ plan: () => Effect.succeed(withoutDigest as PlanCard) })
      const result = yield* RuntimeBridge.execute(config, control, principal, launch)
      expect(result).not.toHaveProperty("executionDigest")
    }))

  it.effect("keeps admitted command identity stable across owner replacement", () =>
    Effect.gen(function*() {
      const keys: Array<string> = []
      const control = service({
        plan: (input) => {
          expect(input.idempotencyKey).toBeDefined()
          keys.push(input.idempotencyKey!)
          return Effect.succeed(plan)
        },
        run: (input) => {
          keys.push(input.idempotencyKey)
          return Effect.succeed(accepted)
        }
      })
      yield* RuntimeBridge.execute(config, control, principal, launch)
      yield* RuntimeBridge.execute(
        { ...config, ownerGeneration: 8 },
        control,
        principal,
        { ...launch, ownerGeneration: 8 }
      )
      expect(keys).toEqual([
        "bridge:v1:request-1:plan",
        "bridge:v1:request-1:run:2",
        "bridge:v1:request-1:plan",
        "bridge:v1:request-1:run:2"
      ])
    }))

  it.effect("refuses stale owners, artifacts, and source revisions before execution", () =>
    Effect.gen(function*() {
      const stale = yield* Effect.flip(
        RuntimeBridge.execute(config, service(), principal, { ...launch, ownerGeneration: 6 })
      )
      expect(stale).toMatchObject({ code: "stale_owner", retryable: true })
      const artifact = yield* Effect.flip(
        RuntimeBridge.execute(config, service(), principal, { ...launch, runtimeArtifactDigest: "c".repeat(64) })
      )
      expect(artifact).toMatchObject({ code: "artifact_mismatch", retryable: false })
      const hostSource = yield* Effect.flip(
        RuntimeBridge.execute({ ...config, sourceRevision: "c".repeat(40) }, service(), principal, launch)
      )
      expect(hostSource).toMatchObject({ code: "source_mismatch", retryable: false })
      const source = yield* Effect.flip(RuntimeBridge.execute(
        config,
        service({
          plan: () => Effect.succeed({ ...plan, graph: { edges: [], sourceRevision: "c".repeat(40) } })
        }),
        principal,
        launch
      ))
      expect(source).toMatchObject({ code: "source_mismatch", retryable: false })
      for (const graph of [undefined, { edges: [] }]) {
        let runs = 0
        const missing = yield* Effect.flip(RuntimeBridge.execute(
          config,
          service({
            plan: () => Effect.succeed({ ...plan, graph }),
            run: () => {
              runs++
              return Effect.succeed(accepted)
            }
          }),
          principal,
          launch
        ))
        expect(missing).toMatchObject({ code: "source_mismatch", retryable: false })
        expect(runs).toBe(0)
      }
    }))

  it.effect("runs a pinned launch only when its plan is the pinned code", () =>
    Effect.gen(function*() {
      let runs = 0
      const control = (planned: PlanCard) =>
        service({
          plan: () => Effect.succeed(planned),
          run: () => {
            runs++
            return Effect.succeed(accepted)
          }
        })
      const pin = { flow: "fixture/small", sourceCommit: "d".repeat(40), executionDigest: "c".repeat(64) }
      const pinned = { ...launch, pin }
      expect(() => Schema.decodeUnknownSync(RuntimeBridge.LaunchCommand)(pinned)).not.toThrow()
      expect(() => Schema.decodeUnknownSync(RuntimeBridge.LaunchCommand)({ ...pinned, pin: { ...pin, executionDigest: "C".repeat(64) } }))
        .toThrow()
      const result = yield* RuntimeBridge.execute(config, control(plan), principal, pinned)
      expect(result).toMatchObject({ operation: "launch", receipt: accepted, executionDigest: "c".repeat(64) })
      expect(runs).toBe(1)
      const other = yield* Effect.flip(
        RuntimeBridge.execute(config, control({ ...plan, executionDigest: "e".repeat(64) } as PlanCard), principal, pinned)
      )
      expect(other).toMatchObject({ code: "source_mismatch", retryable: false })
      const { executionDigest: _executionDigest, ...withoutDigest } = plan
      const unnamed = yield* Effect.flip(
        RuntimeBridge.execute(config, control(withoutDigest as PlanCard), principal, pinned)
      )
      expect(unnamed).toMatchObject({ code: "source_mismatch", retryable: false })
      // An engine launch of the pinned attempt runs its own flow, which must
      // still name an execution identity.
      const engine = { ...pinned, pin: { ...pin, flow: "todo" } }
      yield* RuntimeBridge.execute(config, control({ ...plan, executionDigest: "e".repeat(64) } as PlanCard), principal, engine)
      expect(runs).toBe(2)
      const engineUnnamed = yield* Effect.flip(
        RuntimeBridge.execute(config, control(withoutDigest as PlanCard), principal, engine)
      )
      expect(engineUnnamed).toMatchObject({ code: "source_mismatch" })
      expect(runs).toBe(2)
    }))

  it.effect("uses verified catalog provenance when an admitted flow has no static graph", () =>
    Effect.gen(function*() {
      let runs = 0
      const control = service({
        plan: () => Effect.succeed({ ...plan, graph: undefined }),
        run: () => {
          runs++
          return Effect.succeed(accepted)
        }
      })
      const result = yield* RuntimeBridge.execute(
        { ...config, verifiedCatalogSourceRevision: revision },
        control,
        principal,
        launch
      )
      expect(result).toMatchObject({ operation: "launch", receipt: accepted })
      expect(runs).toBe(1)
      const missing = yield* Effect.flip(RuntimeBridge.execute(config, control, principal, launch))
      expect(missing).toMatchObject({ code: "source_mismatch" })
      const changed = yield* Effect.flip(
        RuntimeBridge.execute({ ...config, verifiedCatalogSourceRevision: "c".repeat(40) }, control, principal, launch)
      )
      expect(changed).toMatchObject({ code: "source_mismatch" })
      const contradicted = yield* Effect.flip(
        RuntimeBridge.execute(
          { ...config, verifiedCatalogSourceRevision: revision },
          service({
            plan: () => Effect.succeed({ ...plan, graph: { edges: [], sourceRevision: "c".repeat(40) } })
          }),
          principal,
          launch
        )
      )
      expect(contradicted).toMatchObject({ code: "source_mismatch" })
      expect(runs).toBe(1)
    }))

  it.effect("adapts every mutation without owning its semantics", () =>
    Effect.gen(function*() {
      const calls: Array<{ readonly operation: string; readonly input: unknown }> = []
      const record = (operation: string) => (input: unknown) =>
        Effect.sync(() => {
          calls.push({ operation, input })
          return accepted
        })
      const control = service({
        approve: record("approve") as Control.Service["approve"],
        deny: record("deny") as Control.Service["deny"],
        signal: record("signal") as Control.Service["signal"],
        steer: record("steer") as Control.Service["steer"],
        cancel: record("cancel") as Control.Service["cancel"],
        resume: record("resume") as Control.Service["resume"]
      })
      const common = {
        protocol: RuntimeBridge.protocol,
        applicationRequestId: "mutation-1",
        ownerGeneration: 7
      } as const
      yield* RuntimeBridge.execute(config, control, principal, {
        ...common,
        operation: "approve",
        approval: plan.approval
      })
      yield* RuntimeBridge.execute(config, control, principal, {
        ...common,
        operation: "deny",
        approval: plan.approval
      })
      yield* RuntimeBridge.execute(config, control, principal, {
        ...common,
        operation: "signal",
        runId: "run-1",
        signal: { name: "answer", payload: true }
      })
      yield* RuntimeBridge.execute(config, control, principal, {
        ...common,
        operation: "steer",
        runId: "run-1",
        messageId: "message-1",
        createdAt: 2,
        steer: { kind: "Message", body: "continue" }
      })
      yield* RuntimeBridge.execute(config, control, principal, {
        ...common,
        operation: "cancel",
        runId: "run-1",
        reason: "operator"
      })
      yield* RuntimeBridge.execute(config, control, principal, { ...common, operation: "resume", runId: "run-1" })
      expect(calls.map((call) => call.operation)).toEqual(["approve", "deny", "signal", "steer", "cancel", "resume"])
      expect(calls[0]!.input).toMatchObject({ idempotencyKey: "bridge:v1:mutation-1:approve", principal })
      expect(calls[3]!.input).toMatchObject({ runId: "run-1", message: { messageId: "message-1", principal } })
      expect(calls[4]!.input).toMatchObject({ reason: "operator" })
      expect(calls[5]!.input).not.toHaveProperty("reason")
    }))

  it.effect("returns bounded reconnect pages and terminal truth from Control", () =>
    Effect.gen(function*() {
      const watched: unknown[] = []
      const control = service({
        watch: (filter) => {
          watched.push(filter)
          return Stream.fromIterable([
            { sequence: 5, cursor: { sequence: 5 }, kind: "one", occurredAt: 1, payload: null },
            { sequence: 6, kind: "two", occurredAt: 2, payload: null }
          ])
        }
      })
      const result = yield* RuntimeBridge.observe(control, {
        protocol: RuntimeBridge.protocol,
        runId: "run-1",
        afterCursor: "4",
        limit: 1
      })
      expect(watched[0]).toEqual({ runId: "run-1", afterSequence: 4, follow: false })
      expect(watched.length).toBeGreaterThan(1)
      expect(result).toMatchObject({ nextCursor: "5", hasMore: true, terminal: true })
      expect(result.events).toHaveLength(1)
    }))

  it.effect("retains the committed root result after the observation cursor has passed it", () =>
    Effect.gen(function*() {
      const output = JSON.stringify({ requestId: "setup-1", receipt: { phase: "completed" } })
      const control = service({
        watch: (filter) =>
          filter.afterSequence === undefined && filter.afterCursor === undefined
            ? Stream.make({
              sequence: 1,
              kind: "control.agent.resolved",
              runId: "run-1",
              occurredAt: 1,
              payload: { text: output }
            })
            : Stream.empty
      })
      const result = yield* RuntimeBridge.observe(control, {
        protocol: RuntimeBridge.protocol,
        runId: "run-1",
        afterCursor: "9"
      })
      expect(result.events).toEqual([])
      expect(result.run.finalOutput).toBe(output)
      expect(
        Schema.decodeUnknownSync(RuntimeBridge.ObserveResponse)({
          protocol: RuntimeBridge.protocol,
          ok: true,
          value: result
        }).value.run.finalOutput
      ).toBe(output)
    }))

  for (
    const changed of [
      { flowId: "fixture/other" },
      { status: "failed" as const },
      { planId: "other-plan" },
      { planDigest: "other-digest" }
    ]
  ) {
    it.effect(`refuses a terminal result when its ${Object.keys(changed)[0]} changes during observation`, () =>
      Effect.gen(function*() {
        let reads = 0
        const control = service({
          list: () =>
            Effect.sync(() => ({
              _tag: "runs" as const,
              items: [++reads === 1 ? summary : { ...summary, ...changed }]
            }))
        })
        const error = yield* Effect.flip(RuntimeBridge.observe(control, {
          protocol: RuntimeBridge.protocol,
          runId: "run-1"
        }))
        expect(error).toMatchObject({
          code: "internal",
          message: "Terminal result observation changed",
          retryable: true
        })
        expect(reads).toBeGreaterThan(1)
      }))
  }

  it.effect("carries a failed run's stamped fault to the worker, and none on a run that did not fail", () =>
    Effect.gen(function*() {
      const failed = { ...summary, status: "failed" } as RunSummary
      const control = service({
        list: () => Effect.succeed({ _tag: "runs" as const, items: [failed] }),
        watch: () =>
          Stream.make({
            sequence: 4,
            kind: "control.run.failed",
            runId: "run-1",
            occurredAt: 1,
            payload: {
              cause: "quota_exceeded: limit",
              fault: { class: "wait", tag: "flows/model/ModelError/quota_exceeded" }
            }
          })
      })
      const result = yield* RuntimeBridge.observe(control, { protocol: RuntimeBridge.protocol, runId: "run-1" })
      expect(result.run).toMatchObject({ failureFault: "wait", failureTag: "flows/model/ModelError/quota_exceeded" })
      expect(
        Schema.decodeUnknownSync(RuntimeBridge.ObserveResponse)({
          protocol: RuntimeBridge.protocol,
          ok: true,
          value: result
        })
          .value.run.failureFault
      ).toBe("wait")
      const completed = yield* RuntimeBridge.observe(service(), { protocol: RuntimeBridge.protocol, runId: "run-1" })
      expect(completed.run).not.toHaveProperty("failureFault")
      expect(completed.run).not.toHaveProperty("failureTag")
    }))

  it.effect("does not invent a result for a terminal run without committed output", () =>
    Effect.gen(function*() {
      const result = yield* RuntimeBridge.observe(service(), { protocol: RuntimeBridge.protocol, runId: "run-1" })
      expect(result.terminal).toBe(true)
      expect(result.run).not.toHaveProperty("finalOutput")
    }))

  it.effect("uses defaults, caps pages, and advances every supported cursor shape", () =>
    Effect.gen(function*() {
      const empty = service({
        list: () => Effect.succeed({ _tag: "runs", items: [{ ...summary, status: "running" }] }),
        watch: () => Stream.empty
      })
      const initial = yield* RuntimeBridge.observe(empty, { protocol: RuntimeBridge.protocol, runId: "run-1" })
      expect(initial).toMatchObject({ nextCursor: "", hasMore: false, terminal: false })
      const after = yield* RuntimeBridge.observe(empty, {
        protocol: RuntimeBridge.protocol,
        runId: "run-1",
        afterCursor: "8"
      })
      expect(after.nextCursor).toBe("8")
      const sequence = yield* RuntimeBridge.observe(
        service({
          watch: () => Stream.make({ sequence: 9, kind: "event", occurredAt: 1, payload: null })
        }),
        { protocol: RuntimeBridge.protocol, runId: "run-1", limit: 2_000 }
      )
      expect(sequence.nextCursor).toBe("9")
      const wrongPage = yield* Effect.flip(RuntimeBridge.observe(
        service({
          list: () => Effect.succeed({ _tag: "flows", items: [] })
        }),
        { protocol: RuntimeBridge.protocol, runId: "run-1" }
      ))
      expect(wrongPage).toMatchObject({ code: "run_not_found" })
    }))

  it.effect("reports missing runs and out-of-range cursors honestly", () =>
    Effect.gen(function*() {
      const missing = yield* Effect.flip(RuntimeBridge.observe(
        service({
          list: () => Effect.succeed({ _tag: "runs", items: [] })
        }),
        { protocol: RuntimeBridge.protocol, runId: "missing" }
      ))
      expect(missing).toMatchObject({ code: "run_not_found", retryable: true })
      const invalid = yield* Effect.flip(RuntimeBridge.observe(service(), {
        protocol: RuntimeBridge.protocol,
        runId: "run-1",
        afterCursor: String(Number.MAX_SAFE_INTEGER + 1)
      }))
      expect(invalid).toMatchObject({ code: "invalid_request" })
    }))

  it.effect("serves the bridge on a real authenticated gateway socket", () =>
    Effect.gen(function*() {
      const server = yield* HttpServer.HttpServer
      if (server.address._tag !== "InetAddressV4") return yield* Effect.die("expected IPv4")
      const base = `http://127.0.0.1:${server.address.port}`
      const post = (body: string, credential?: string) =>
        Effect.tryPromise(() =>
          fetch(`${base}/runtime/v1/command`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` })
            },
            body
          })
        )
      const unauthorized = yield* post(JSON.stringify(launch))
      expect(unauthorized.status).toBe(401)
      const malformed = yield* post("{", "secret")
      expect(malformed.status).toBe(400)
      expect(yield* Effect.promise(() => malformed.json())).toMatchObject({
        protocol: RuntimeBridge.protocol,
        ok: false,
        error: { code: "invalid_request" }
      })
      const missing = yield* post(JSON.stringify(launch), "secret")
      expect(missing.status).toBe(404)
      expect(yield* Effect.promise(() => missing.json())).toMatchObject({
        protocol: RuntimeBridge.protocol,
        ok: false,
        error: { code: "flow_not_found" }
      })
    }).pipe(
      Effect.provide(
        NodeGateway.layer({ workspaceHash: "fixture", gatewayId: "gateway", protocolVersion: "1", version: "test" }, {
          host: "127.0.0.1",
          port: 0,
          credential: "secret",
          runtimeBridge: { runtimeArtifactDigest: digest, sourceRevision: revision, ownerGeneration: 7 }
        }).pipe(Layer.provideMerge(stack()))
      ),
      Effect.scoped
    ))

  it.effect("serves successful command and observation JSON without a second runtime", () =>
    Effect.gen(function*() {
      const server = yield* HttpServer.HttpServer
      if (server.address._tag !== "InetAddressV4") return yield* Effect.die("expected IPv4")
      const base = `http://127.0.0.1:${server.address.port}/runtime/v1`
      const response = yield* Effect.promise(() =>
        fetch(`${base}/command`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocol: RuntimeBridge.protocol,
            operation: "cancel",
            applicationRequestId: "cancel-1",
            ownerGeneration: 7,
            runId: "run-1"
          })
        })
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        ok: true,
        value: { operation: "cancel", receipt: accepted }
      })
      const observed = yield* Effect.promise(() =>
        fetch(`${base}/observe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ protocol: RuntimeBridge.protocol, runId: "run-1" })
        })
      )
      expect(observed.status).toBe(200)
      expect(yield* Effect.promise(() => observed.json())).toMatchObject({
        ok: true,
        value: { run: { runId: "run-1" }, terminal: true }
      })
      const invalidObservation = yield* Effect.promise(() =>
        fetch(`${base}/observe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ protocol: RuntimeBridge.protocol })
        })
      )
      expect(invalidObservation.status).toBe(400)
      expect(yield* Effect.promise(() => invalidObservation.json())).toMatchObject({
        error: { code: "invalid_request" }
      })
    }).pipe(Effect.provide(directBridge(service())), Effect.scoped))

  it.effect("maps authenticated bridge failures to stable HTTP classes", () =>
    Effect.gen(function*() {
      const server = yield* HttpServer.HttpServer
      if (server.address._tag !== "InetAddressV4") return yield* Effect.die("expected IPv4")
      const endpoint = `http://127.0.0.1:${server.address.port}/runtime/v1/command`
      const send = (body: unknown) =>
        Effect.promise(async () => {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          })
          return { status: response.status, body: await response.json() as any }
        })
      const stale = yield* send({ ...launch, ownerGeneration: 6 })
      expect(stale).toMatchObject({ status: 409, body: { error: { code: "stale_owner", retryable: true } } })
      const invalid = yield* send({ ...launch, operation: "not-an-operation" })
      expect(invalid).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } })
    }).pipe(Effect.provide(directBridge(service())), Effect.scoped))

  it.effect("maps authentication, availability, and defects without leaking causes", () =>
    Effect.gen(function*() {
      const request = (layer: ReturnType<typeof directBridge>) =>
        Effect.gen(function*() {
          const server = yield* HttpServer.HttpServer
          if (server.address._tag !== "InetAddressV4") return yield* Effect.die("expected IPv4")
          const port = server.address.port
          return yield* Effect.promise(async () => {
            const response = await fetch(`http://127.0.0.1:${port}/runtime/v1/command`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(launch)
            })
            return { status: response.status, body: await response.json() as any }
          })
        }).pipe(Effect.provide(layer), Effect.scoped)
      const unauthorized = yield* request(directBridge(service(), {
        ...config,
        authenticate: () => Effect.fail(new ControlError.Unauthorized({ message: "no" }))
      }))
      expect(unauthorized).toMatchObject({ status: 401, body: { error: { code: "unauthorized" } } })
      const unavailable = yield* request(directBridge(service({
        plan: () => Effect.fail(new ControlError.Unavailable({ feature: "runtime", ticket: "issue" }))
      })))
      expect(unavailable).toMatchObject({ status: 503, body: { error: { code: "unavailable", retryable: true } } })
      const defect = yield* request(directBridge(service({ plan: () => Effect.fail("opaque" as any) })))
      expect(defect).toMatchObject({
        status: 500,
        body: { error: { code: "internal", message: "Runtime bridge failed" } }
      })
    }))

  for (
    const [label, failure, status, code, retryable] of [
      [
        "persistence",
        new ControlError.PersistenceError({ operation: "read", message: privateMessage }),
        503,
        "persistence_failed",
        true
      ],
      [
        "non-retryable transport",
        new ControlError.TransportError({ message: privateMessage, retryable: false }),
        400,
        "transport_error",
        false
      ],
      [
        "retryable transport",
        new ControlError.TransportError({ message: privateMessage, retryable: true }),
        503,
        "transport_error",
        true
      ],
      ["unknown Error", new Error(privateMessage), 500, "internal", false],
      ["unknown code", { code: privateMessage, message: privateMessage }, 500, "internal", false]
    ] as const
  ) {
    it.effect(`sanitizes ${label} errors and preserves retryability`, () =>
      Effect.gen(function*() {
        const result = yield* Effect.gen(function*() {
          const server = yield* HttpServer.HttpServer
          if (server.address._tag !== "InetAddressV4") return yield* Effect.die("expected IPv4")
          const port = server.address.port
          return yield* Effect.promise(async () => {
            const response = await fetch(`http://127.0.0.1:${port}/runtime/v1/command`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(launch)
            })
            return { status: response.status, body: await response.json() }
          })
        }).pipe(
          Effect.provide(directBridge(service({ plan: () => Effect.fail(failure as ControlError.PersistenceError) }))),
          Effect.scoped
        )
        expect(result).toMatchObject({ status, body: { ok: false, error: { code, retryable } } })
        expect(JSON.stringify(result)).not.toContain(privateMessage)
      }))
  }

  it.effect("logs the full cause of a failed launch on the host while the wire stays sanitized", () =>
    Effect.gen(function*() {
      const logged: Array<unknown> = []
      const failure = new ControlError.PersistenceError({ operation: "read", message: privateMessage })
      const result = yield* Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        if (server.address._tag !== "InetAddressV4") return yield* Effect.die("expected IPv4")
        const port = server.address.port
        return yield* Effect.promise(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/runtime/v1/command`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(launch)
          })
          return { status: response.status, body: await response.json() }
        })
      }).pipe(
        Effect.provide(
          directBridge(service({ plan: () => Effect.fail(failure) })).pipe(
            Layer.provide(Logger.layer([Logger.make(({ message }) => {
              logged.push(message)
            })]))
          )
        ),
        Effect.scoped
      )
      expect(JSON.stringify(result)).not.toContain(privateMessage)
      expect(logged).toHaveLength(1)
      expect(logged[0]).toMatchObject([{
        operation: "runtime-bridge.command",
        code: "persistence_failed",
        cause: failure
      }])
    }))

  it.effect("refuses to bind a runtime bridge without a credential, including on loopback", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(
        Effect.scoped(Layer.build(
          NodeGateway.layer({ workspaceHash: "fixture", gatewayId: "gateway", protocolVersion: "1", version: "test" }, {
            host: "127.0.0.1",
            port: 0,
            runtimeBridge: { runtimeArtifactDigest: digest, sourceRevision: revision, ownerGeneration: 7 }
          }).pipe(Layer.provideMerge(stack()))
        ))
      )
      // A bridge with no credential would answer 401 to every request, so the
      // host fails at start instead of advertising a bridge nobody can call.
      expect(failure).toMatchObject({ code: "bind_failed", message: expect.stringContaining("runtime bridge") })
    }))
})
