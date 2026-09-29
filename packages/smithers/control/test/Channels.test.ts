import * as Sha256 from "@smthrs/crypto/Sha256"
import { Deferred, Effect, Fiber, Layer, Redacted, Schema, Stream } from "effect"
import * as Crypto from "effect/Crypto"
import { describe, expect, it, vi } from "vitest"
import * as Channels from "../src/Channels.ts"
import * as Control from "../src/Control.ts"
import { InvalidInput, PersistenceError, Unauthorized } from "../src/ControlError.ts"
import * as ControlRuntime from "../src/ControlRuntime.ts"
import { RunSummary } from "../src/ControlSchema.ts"
import type { RunStatus } from "../src/ControlSchema.ts"
import * as WebhookChannel from "../src/WebhookChannel.ts"

const accepted = { _tag: "Accepted" as const, receiptId: "receipt" }

const runtime = ControlRuntime.layerMemory().pipe(
  Layer.provide(Layer.succeed(Crypto.Crypto, Sha256.syncCrypto))
)

const channelsLayer = (control: Layer.Layer<Control.Control>) => Channels.layer.pipe(Layer.provide([control, runtime]))

const run = <A, E>(effect: Effect.Effect<A, E, Channels.Channels>, calls: Array<string> = []) =>
  Effect.runPromise(effect.pipe(Effect.provide(channelsLayer(recordingControl(calls)))))

const recordingControl = (calls: Array<string>) => {
  return Layer.succeed(
    Control.Control,
    Control.make({
      plan: () => {
        calls.push("plan")
        return Effect.succeed({
          planId: "plan",
          flowId: "flow",
          digest: "digest",
          inputSummary: "input",
          envelope: { capabilities: [], flows: [], budget: {} },
          deployClass: false,
          nodes: [],
          approval: {
            target: {
              _tag: "Plan",
              planId: "plan",
              digest: "digest",
              envelope: { capabilities: [], flows: [], budget: {} }
            },
            scope: "run",
            idempotencyKey: "approve:plan"
          }
        })
      },
      run: () => {
        calls.push("run")
        return Effect.succeed(accepted)
      },
      approve: () => Effect.die("unused"),
      deny: () => Effect.die("unused"),
      steer: () => Effect.die("unused"),
      signal: () => {
        calls.push("signal")
        return Effect.succeed(accepted)
      },
      cancel: () => Effect.die("unused"),
      resume: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      watch: () => Stream.empty
    })
  )
}

const raw = (idempotencyKey = "key"): Channels.RawInbound => ({
  body: new TextEncoder().encode("{\"kind\":\"start\"}"),
  headers: {},
  idempotencyKey
})

describe("Channels", () => {
  it("verifies before decoding or calling Control", async () => {
    const calls: Array<string> = []
    const channel: Channels.Channel = {
      name: "signed",
      schema: Schema.Unknown,
      verify: () =>
        Effect.gen(function*() {
          calls.push("verify")
          return yield* Effect.fail(new Unauthorized({ message: "bad" }))
        }),
      decode: () =>
        Effect.sync(() => {
          calls.push("decode")
          return null
        }),
      map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
      project: () => ({ cursor: "1", operation: "post", message: {} })
    }
    const exit = await run(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        yield* channels.register(channel)
        return yield* Effect.exit(channels.ingest({ channel: "signed", raw: raw() }))
      }),
      calls
    )
    expect(exit._tag).toBe("Failure")
    expect(calls).toEqual(["verify"])
  })

  it("turns invalid webhook schema data into InvalidInput", async () => {
    const webhook = WebhookChannel.make({
      name: "schema",
      schema: Schema.Struct({ count: Schema.Number }),
      credential: Redacted.make({ id: "connection", name: "connection" }),
      verify: () => Effect.void,
      map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
      project: () => ({ cursor: "1", operation: "post", message: {} })
    })
    const channel: Channels.Channel = {
      ...webhook,
      schema: Schema.Unknown,
      map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} })
    }
    const exit = await run(Effect.gen(function*() {
      const channels = yield* Channels.Channels
      yield* channels.register(channel)
      return yield* Effect.exit(channels.ingest({
        channel: "schema",
        raw: { ...raw(), body: new TextEncoder().encode("{\"count\":\"wrong\"}") }
      }))
    }))
    expect(exit._tag).toBe("Failure")
  })

  it("maps starts and signals through Control and deduplicates inbound keys", async () => {
    const calls: Array<string> = []
    const control = Layer.succeed(
      Control.Control,
      Control.make({
        plan: () =>
          Effect.sync(() => {
            calls.push("plan")
            return {
              planId: "plan",
              flowId: "flow",
              digest: "digest",
              inputSummary: "input",
              envelope: { capabilities: [], flows: [], budget: {} },
              deployClass: false,
              nodes: [],
              approval: {
                target: {
                  _tag: "Plan",
                  planId: "plan",
                  digest: "digest",
                  envelope: { capabilities: [], flows: [], budget: {} }
                },
                scope: "run",
                idempotencyKey: "approve:plan"
              }
            }
          }),
        run: () =>
          Effect.sync(() => {
            calls.push("run")
            return accepted
          }),
        approve: () => Effect.die("unused"),
        deny: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        signal: () =>
          Effect.sync(() => {
            calls.push("signal")
            return accepted
          }),
        cancel: () => Effect.die("unused"),
        resume: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        watch: () => Stream.empty
      })
    )
    const channel: Channels.Channel = {
      name: "events",
      schema: Schema.Unknown,
      verify: () => Effect.void,
      decode: (request) => Effect.succeed(JSON.parse(new TextDecoder().decode(request.body)) as unknown),
      map: (payload) =>
        Effect.succeed(
          typeof payload === "object" &&
            payload !== null &&
            "kind" in payload &&
            payload.kind === "signal"
            ? { _tag: "Signal", runId: "run", signal: { name: "approved", payload: true } }
            : { _tag: "Start", flowId: "flow", input: {} }
        ),
      project: () => ({ cursor: "1", operation: "post", message: {} })
    }
    await Effect.runPromise(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        yield* channels.register(channel)
        yield* channels.ingest({ channel: "events", raw: raw("start") })
        yield* channels.ingest({ channel: "events", raw: raw("start") })
        yield* channels.ingest({
          channel: "events",
          raw: { ...raw("signal"), body: new TextEncoder().encode("{\"kind\":\"signal\"}") }
        })
      }).pipe(Effect.provide(channelsLayer(control)))
    )
    expect(calls).toEqual(["plan", "run", "signal"])
  })

  it("scopes identical external keys by channel", async () => {
    const calls: Array<string> = []
    const channel = (name: string): Channels.Channel => ({
      name,
      schema: Schema.Unknown,
      verify: () => Effect.void,
      decode: () => Effect.succeed(null),
      map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
      project: () => ({ cursor: "1", operation: "post", message: {} })
    })
    await run(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        yield* channels.register(channel("alpha"))
        yield* channels.register(channel("beta"))
        yield* channels.ingest({ channel: "alpha", raw: raw("shared") })
        yield* channels.ingest({ channel: "beta", raw: raw("shared") })
      }),
      calls
    )
    expect(calls).toEqual(["plan", "run", "plan", "run"])
  })

  it("retains inbound receipts across coordinator reconstruction", async () => {
    const calls: Array<string> = []
    let decoded = 0
    const channel: Channels.Channel = {
      name: "durable",
      schema: Schema.Unknown,
      verify: () => Effect.void,
      decode: () => Effect.sync(() => ++decoded),
      map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
      project: () => ({ cursor: "1", operation: "post", message: {} })
    }
    const receipts = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* Channels.make
        yield* first.register(channel)
        const accepted = yield* first.ingest({ channel: "durable", raw: raw("restart-key") })

        // A new coordinator has an empty registry/delivery map but shares the
        // durable ControlRuntime receipt store.
        const second = yield* Channels.make
        yield* second.register(channel)
        const replay = yield* second.ingest({ channel: "durable", raw: raw("restart-key") })
        return { accepted, replay }
      }).pipe(Effect.provide([recordingControl(calls), runtime]))
    )
    expect(receipts.accepted).toMatchObject({ _tag: "Accepted", receiptId: "restart-key" })
    expect(receipts.replay).toMatchObject({ _tag: "AlreadyApplied", receiptId: "restart-key" })
    expect(calls).toEqual(["plan", "run"])
    expect(decoded).toBe(1)
  })

  it("returns a durable conflict when one channel key is reused for another body", async () => {
    const calls: Array<string> = []
    let decoded = 0
    const channel: Channels.Channel = {
      name: "conflict",
      schema: Schema.Unknown,
      verify: () => Effect.void,
      decode: () => Effect.sync(() => ++decoded),
      map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
      project: () => ({ cursor: "1", operation: "post", message: {} })
    }
    const receipt = await run(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        yield* channels.register(channel)
        yield* channels.ingest({ channel: "conflict", raw: raw("same") })
        return yield* channels.ingest({
          channel: "conflict",
          raw: { ...raw("same"), body: new TextEncoder().encode("different") }
        })
      }),
      calls
    )
    expect(receipt._tag).toBe("Conflict")
    expect(calls).toEqual(["plan", "run"])
    expect(decoded).toBe(1)
  })

  it("binds declared semantic headers into the durable inbound identity", async () => {
    const calls: Array<string> = []
    let decoded = 0
    const channel: Channels.Channel = {
      name: "semantic-headers",
      schema: Schema.Unknown,
      fingerprintHeaders: ["x-event-kind"],
      verify: () => Effect.void,
      decode: () => Effect.sync(() => ++decoded),
      map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
      project: () => ({ cursor: "1", operation: "post", message: {} })
    }
    const receipt = await run(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        yield* channels.register(channel)
        yield* channels.ingest({
          channel: channel.name,
          raw: { ...raw("same"), headers: { "x-event-kind": "created" } }
        })
        return yield* channels.ingest({
          channel: channel.name,
          raw: { ...raw("same"), headers: { "X-Event-Kind": "deleted" } }
        })
      }),
      calls
    )

    expect(receipt._tag).toBe("Conflict")
    expect(calls).toEqual(["plan", "run"])
    expect(decoded).toBe(1)
  })

  it("normalizes semantic header names and excludes credential headers", async () => {
    const calls: Array<string> = []
    let decoded = 0
    const channel: Channels.Channel = {
      name: "normalized-headers",
      schema: Schema.Unknown,
      fingerprintHeaders: ["X-Event-Kind"],
      verify: () => Effect.void,
      decode: () => Effect.sync(() => ++decoded),
      map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
      project: () => ({ cursor: "1", operation: "post", message: {} })
    }
    const receipt = await run(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        yield* channels.register(channel)
        yield* channels.ingest({
          channel: channel.name,
          raw: {
            ...raw("same-normalized"),
            headers: { Authorization: "Bearer first", "X-Event-Kind": "created" }
          }
        })
        return yield* channels.ingest({
          channel: channel.name,
          raw: {
            ...raw("same-normalized"),
            headers: { "x-event-kind": "created", authorization: "Bearer rotated" }
          }
        })
      }),
      calls
    )

    expect(receipt._tag).toBe("AlreadyApplied")
    expect(calls).toEqual(["plan", "run"])
    expect(decoded).toBe(1)
  })

  it("snapshots bytes and headers before suspended verification", async () => {
    const calls: Array<string> = []
    const observed: Array<{ readonly body: string; readonly event: string | undefined }> = []
    const receipt = await run(
      Effect.gen(function*() {
        const verifying = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const channel: Channels.Channel = {
          name: "snapshot",
          schema: Schema.Unknown,
          fingerprintHeaders: ["x-event-kind"],
          verify: (request) =>
            Effect.gen(function*() {
              observed.push({
                body: new TextDecoder().decode(request.body),
                event: request.headers["x-event-kind"]
              })
              request.body.fill(1)
              yield* Deferred.succeed(verifying, undefined)
              yield* Deferred.await(release)
            }),
          decode: (request) =>
            Effect.sync(() => {
              observed.push({
                body: new TextDecoder().decode(request.body),
                event: request.headers["x-event-kind"]
              })
              return null
            }),
          map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
          project: () => ({ cursor: "1", operation: "post", message: {} })
        }
        const channels = yield* Channels.Channels
        yield* channels.register(channel)
        const body = new TextEncoder().encode("original")
        const headers: Record<string, string | undefined> = { "x-event-kind": "created" }
        const fiber = yield* channels.ingest({
          channel: channel.name,
          raw: { body, headers, idempotencyKey: "snapshot-key" }
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(verifying)
        body.fill(0)
        headers["x-event-kind"] = "mutated"
        yield* Deferred.succeed(release, undefined)
        return yield* Fiber.join(fiber)
      }),
      calls
    )

    expect(receipt._tag).toBe("Accepted")
    expect(observed).toEqual([
      { body: "original", event: "created" },
      { body: "original", event: "created" }
    ])
    expect(calls).toEqual(["plan", "run"])
  })

  it("refuses accessor-backed headers before verification", async () => {
    let reads = 0
    let verifies = 0
    const channel: Channels.Channel = {
      name: "accessor-headers",
      schema: Schema.Unknown,
      fingerprintHeaders: ["x-event-kind"],
      verify: () => Effect.sync(() => void verifies++),
      decode: () => Effect.succeed(null),
      map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
      project: () => ({ cursor: "1", operation: "post", message: {} })
    }
    const headers = Object.defineProperty({}, "x-event-kind", {
      enumerable: true,
      get: () => {
        reads += 1
        return "created"
      }
    })
    const error = await run(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        yield* channels.register(channel)
        return yield* Effect.flip(channels.ingest({
          channel: channel.name,
          raw: { ...raw(), headers }
        }))
      })
    )

    expect(error).toBeInstanceOf(InvalidInput)
    expect((error as InvalidInput).issue).toBe("raw.headers.x-event-kind: must be an enumerable data property")
    expect(reads).toBe(0)
    expect(verifies).toBe(0)
  })

  it("does not poison an inbound key when Control fails", async () => {
    let attempts = 0
    const retryingControl = Layer.succeed(
      Control.Control,
      Control.make({
        plan: () => Effect.die("unused"),
        run: () => Effect.die("unused"),
        approve: () => Effect.die("unused"),
        deny: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        signal: () =>
          Effect.suspend(() => {
            attempts += 1
            return attempts === 1
              ? Effect.fail(new PersistenceError({ operation: "signal", message: "transient" }))
              : Effect.succeed(accepted)
          }),
        cancel: () => Effect.die("unused"),
        resume: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        watch: () => Stream.empty
      })
    )
    const channel: Channels.Channel = {
      name: "retry",
      schema: Schema.Unknown,
      verify: () => Effect.void,
      decode: () => Effect.succeed(null),
      map: () => Effect.succeed({ _tag: "Signal", runId: "run", signal: { name: "retry", payload: null } }),
      project: () => ({ cursor: "1", operation: "post", message: {} })
    }
    await Effect.runPromise(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        yield* channels.register(channel)
        yield* Effect.exit(channels.ingest({ channel: "retry", raw: raw("retry-key") }))
        const receipt = yield* channels.ingest({ channel: "retry", raw: raw("retry-key") })
        expect(receipt._tag).toBe("Accepted")
      }).pipe(Effect.provide(channelsLayer(retryingControl)))
    )
    expect(attempts).toBe(2)
  })

  it("registers a typed webhook and maps only its decoded payload", async () => {
    const mapped: Array<string> = []
    const webhook = WebhookChannel.make({
      name: "typed",
      schema: Schema.Struct({ ref: Schema.String }),
      credential: Redacted.make({ id: "connection", name: "connection" }),
      verify: () => Effect.void,
      map: (payload) => {
        mapped.push(payload.ref)
        return Effect.succeed({ _tag: "Start", flowId: "flow", input: payload.ref })
      },
      project: () => ({ cursor: "1", operation: "noop", message: null })
    })
    await run(Effect.gen(function*() {
      const channels = yield* Channels.Channels
      yield* channels.register(webhook)
      expect((yield* channels.lookup("typed")).schema).toBe(webhook.schema)
      yield* channels.ingest({
        channel: "typed",
        raw: { ...raw(), body: new TextEncoder().encode("{\"ref\":\"main\"}") }
      })
      const invalid = yield* Effect.flip(channels.ingest({
        channel: "typed",
        raw: { ...raw("invalid"), body: new TextEncoder().encode("{\"ref\":1}") }
      }))
      expect(invalid).toBeInstanceOf(InvalidInput)
    }))
    expect(mapped).toEqual(["main"])
  })

  it("bounds terminal delivery history without evicting live message identities", async () => {
    await run(Effect.gen(function*() {
      const channels = yield* Channels.Channels
      const observed = new Map<string, Channels.Delivery | undefined>()
      yield* channels.register({
        name: "retention",
        schema: Schema.Unknown,
        verify: () => Effect.void,
        decode: () => Effect.succeed(null),
        map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
        project: (summary, previous) => {
          observed.set(summary.runId, previous)
          return { cursor: summary.status, messageId: summary.runId, operation: "post", message: {} }
        }
      })
      const project = (runId: string, status: RunStatus) =>
        channels.project({
          channel: "retention",
          run: { runId, flowId: "flow", status, createdAt: 0, updatedAt: 0 }
        })
      for (const status of ["accepted", "running", "parked", "waiting-approval"] as const) {
        yield* project(status, status)
      }
      yield* project("revived", "failed")
      yield* project("revived", "running")
      for (let i = 0; i < 1025; i++) {
        yield* project(`terminal-${i}`, i % 3 === 0 ? "completed" : i % 3 === 1 ? "failed" : "cancelled")
      }
      yield* project("terminal-1024", "completed")
      expect(observed.get("terminal-1024")?.messageId).toBe("terminal-1024")
      yield* project("terminal-1", "failed")
      expect(observed.get("terminal-1")?.messageId).toBe("terminal-1")
      for (const status of ["accepted", "running", "parked", "waiting-approval"] as const) {
        yield* project(status, status)
        expect(observed.get(status)?.messageId).toBe(status)
      }
      yield* project("revived", "running")
      expect(observed.get("revived")?.messageId).toBe("revived")
      yield* project("terminal-0", "completed")
      expect(observed.get("terminal-0")).toBeUndefined()
    }))
  })

  it("retires existing identities on terminal noops and retains message identity edits", async () => {
    await run(Effect.gen(function*() {
      const channels = yield* Channels.Channels
      const observed: Array<Channels.Delivery | undefined> = []
      yield* channels.register({
        name: "terminal-noop",
        schema: Schema.Unknown,
        verify: () => Effect.void,
        decode: () => Effect.succeed(null),
        map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
        project: (summary, previous) => {
          observed.push(previous)
          return {
            cursor: "same",
            messageId: String(summary.updatedAt),
            operation: summary.status === "completed" ? "noop" : "edit",
            message: {}
          }
        }
      })
      const summary = { runId: "run", flowId: "flow", status: "running" as const, createdAt: 0, updatedAt: 0 }
      const project = (runId: string, status: RunStatus, updatedAt = 0) =>
        channels.project({ channel: "terminal-noop", run: { ...summary, runId, status, updatedAt } })
      yield* project("run", "running")
      yield* project("run", "running", 1)
      yield* project("run", "completed", 2)
      expect(observed.at(-1)).toEqual({ cursor: "same", messageId: "1" })
      yield* project("run", "completed", 3)
      expect(observed.at(-1)).toEqual({ cursor: "same", messageId: "1" })
      for (let i = 0; i < 1024; i++) {
        yield* project(`terminal-${i}`, "failed")
      }
      yield* project("run", "completed")
      expect(observed.at(-1)).toBeUndefined()
    }))
  })

  it("does not copy delivery history or replace records for unchanged projections", async () => {
    await run(Effect.gen(function*() {
      const channels = yield* Channels.Channels
      const observed: Array<Channels.Delivery | undefined> = []
      let operation: Channels.DeliveryProjection["operation"] = "post"
      yield* channels.register({
        name: "constant-time",
        schema: Schema.Unknown,
        verify: () => Effect.void,
        decode: () => Effect.succeed(null),
        map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
        project: (_summary, previous) => {
          observed.push(previous)
          return { cursor: "1", messageId: "message", operation, message: {} }
        }
      })
      const summary = { runId: "live", flowId: "flow", status: "running" as const, createdAt: 0, updatedAt: 0 }
      yield* channels.project({ channel: "constant-time", run: summary })
      const iterator = Map.prototype[Symbol.iterator]
      let copied = 0
      const spy = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function(this: Map<unknown, unknown>) {
        if (this.has("13:constant-time:live")) copied += this.size
        return iterator.call(this)
      })
      try {
        yield* channels.project({ channel: "constant-time", run: summary })
        operation = "noop"
        yield* channels.project({ channel: "constant-time", run: summary })
        yield* channels.project({ channel: "constant-time", run: summary })
        expect(copied).toBe(0)
        expect(observed[2]).toBe(observed[1])
        expect(observed[3]).toBe(observed[1])
        yield* channels.project({ channel: "constant-time", run: { ...summary, runId: "silent" } })
        yield* channels.project({ channel: "constant-time", run: { ...summary, runId: "silent" } })
        expect(observed.at(-1)).toBeUndefined()
      } finally {
        spy.mockRestore()
      }
    }))
  })

  it("retains delivery cursors for edit projections and redacts credentials", async () => {
    const deliveries: Array<Channels.Delivery | undefined> = []
    const channel: Channels.Channel = {
      name: "outbound",
      schema: Schema.Unknown,
      verify: () => Effect.void,
      decode: () => Effect.succeed(null),
      map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
      project: (_run, previous) => {
        deliveries.push(previous)
        return previous === undefined
          ? { cursor: "1", messageId: "message", operation: "post", message: {} }
          : { cursor: "2", messageId: previous.messageId, operation: "edit", message: {} }
      }
    }
    await run(Effect.gen(function*() {
      const channels = yield* Channels.Channels
      yield* channels.register(channel)
      const run = { runId: "run", flowId: "flow", status: "running" as const, createdAt: 0, updatedAt: 0 }
      yield* channels.project({ channel: "outbound", run })
      yield* channels.project({ channel: "outbound", run })
    }))
    expect(deliveries).toEqual([undefined, { cursor: "1", messageId: "message" }])
    expect(JSON.stringify({ secret: Redacted.make("do-not-persist") })).not.toContain("do-not-persist")
  })

  it("keeps delimiter-bearing channel and run identities separate", async () => {
    await run(Effect.gen(function*() {
      const channels = yield* Channels.Channels
      for (const name of ["a", "a:b"]) {
        yield* channels.register({
          name,
          schema: Schema.Unknown,
          verify: () => Effect.void,
          decode: () => Effect.succeed(null),
          map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
          project: (summary, previous) => ({
            cursor: "1",
            messageId: previous?.messageId ?? `${name}/${summary.runId}/message`,
            operation: previous === undefined ? "post" : "edit",
            message: {}
          })
        })
      }
      const project = (channel: string, runId: string) =>
        channels.project({
          channel,
          run: Schema.decodeUnknownSync(RunSummary)({
            runId,
            flowId: "flow",
            status: "running",
            createdAt: 0,
            updatedAt: 0
          })
        })
      expect(yield* project("a", "b:c")).toMatchObject({ operation: "post", messageId: "a/b:c/message" })
      expect(yield* project("a:b", "c")).toMatchObject({ operation: "post", messageId: "a:b/c/message" })
      expect(yield* project("a:b", "c")).toMatchObject({ operation: "edit", messageId: "a:b/c/message" })
      expect(yield* project("a", "b:c")).toMatchObject({ operation: "edit", messageId: "a/b:c/message" })
    }))
  })
})
