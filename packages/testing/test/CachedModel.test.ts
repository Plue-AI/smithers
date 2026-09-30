import { describe, expect, it } from "@effect/vitest"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Effect, Option, Ref, Stream } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CachedModel from "../src/CachedModel.ts"
import { decode, type Fixture, type RecordedCall, recordedRequest } from "../src/Fixture.ts"
import * as FixtureStore from "../src/FixtureStore.ts"
import type { ModelErrorLike } from "../src/ModelLike.ts"

type Complete<T> = { readonly [K in keyof T]-?: Exclude<T[K], undefined> }

const request = (text: string, modelId = "openai:gpt-5-mini"): ModelRequest.ModelRequest =>
  ModelRequest.ModelRequest.make({
    modelId,
    system: [ModelRequest.SystemPart.make({ text: "You are a concise reviewer." })],
    messages: [ModelRequest.Message.user(text)],
    tools: [],
    params: ModelRequest.GenerationParams.make()
  })

const events: ReadonlyArray<ModelEvent.ModelEvent> = [
  { type: "text-start", id: "text_1" },
  { type: "text-delta", id: "text_1", text: "Small replay change." },
  { type: "text-end", id: "text_1" },
  { type: "settle", stopReason: "stop", responseId: "resp_1" }
]

/** A live model that counts its calls, so a cache hit is observable. */
const countingLive = Effect.gen(function*() {
  const calls = yield* Ref.make(0)
  const live = Model.make({
    stream: () => Stream.unwrap(Ref.update(calls, (n) => n + 1).pipe(Effect.as(Stream.fromIterable(events))))
  })
  return { live, count: () => Ref.get(calls) }
})

const failingLive = Model.make({
  stream: () => Stream.fail(new ModelError({ code: "no_route", message: "the cache must not reach the network" }))
})

const withTempDir = <A, E>(use: (directory: string) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "flows-cached-model-"))),
    use,
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
  )

/**
 * A store that publishes a new fixture per append, as the built-in stores do,
 * over frozen copies of the calls it is given, and counts how often each of
 * those copies is canonically encoded.
 *
 * `recordedRequest` reads `modelId` exactly once per encoding, so an accessor
 * there counts the digests a recording run pays for.
 */
const countingStore = () => {
  const counters: Array<() => number> = []
  let fixture: Fixture | undefined
  const owned = (call: RecordedCall): RecordedCall => {
    const projected = recordedRequest(call.request)
    let encodings = 0
    counters.push(() => encodings)
    return {
      ...call,
      request: Object.freeze({
        ...projected,
        get modelId() {
          encodings += 1
          return projected.modelId
        }
      })
    }
  }
  return {
    store: FixtureStore.make({
      load: () => Effect.sync(() => Option.fromUndefinedOr(fixture)),
      append: (call) =>
        Effect.sync(() => {
          fixture = Object.freeze({ calls: Object.freeze([...(fixture?.calls ?? []), owned(call)]) })
        })
    }),
    encodings: () => counters.map((count) => count())
  }
}

describe("CachedModel", () => {
  it.effect("keeps the live model's declared OpenTelemetry provider name", () =>
    Effect.gen(function*() {
      const fixture = yield* FixtureStore.makeMemory()
      const declared = Model.make({ providerName: "openai", stream: () => Stream.fromIterable(events) })
      expect(CachedModel.make({ live: declared, fixture }).providerName).toBe("openai")
      expect("providerName" in CachedModel.make({ live: failingLive, fixture })).toBe(false)
    }))

  it.effect("runs the live model on a miss and records the call", () =>
    Effect.gen(function*() {
      const fixture = yield* FixtureStore.makeMemory()
      const live = yield* countingLive
      const model = CachedModel.make({ live: live.live, fixture })
      const seen = yield* Stream.runCollect(model.stream(request("Summarize PR 4821.")))
      expect([...seen]).toEqual(events)
      expect(yield* live.count()).toBe(1)
      const recorded = yield* fixture.load()
      expect(Option.isSome(recorded)).toBe(true)
      expect(Option.getOrThrow(recorded).calls).toHaveLength(1)
    }))

  it.effect("replays the recorded call on a second identical request", () =>
    Effect.gen(function*() {
      const fixture = yield* FixtureStore.makeMemory()
      const live = yield* countingLive
      const model = CachedModel.make({ live: live.live, fixture })
      yield* Stream.runDrain(model.stream(request("Summarize PR 4821.")))
      const seen = yield* Stream.runCollect(model.stream(request("Summarize PR 4821.")))
      expect([...seen]).toEqual(events)
      expect(yield* live.count()).toBe(1)
      expect(Option.getOrThrow(yield* fixture.load()).calls).toHaveLength(1)
    }))

  it.effect("treats a different request as a miss and records it beside the first", () =>
    Effect.gen(function*() {
      const fixture = yield* FixtureStore.makeMemory()
      const live = yield* countingLive
      const model = CachedModel.make({ live: live.live, fixture })
      yield* Stream.runDrain(model.stream(request("Summarize PR 4821.")))
      yield* Stream.runDrain(model.stream(request("Classify PR 4821.")))
      expect(yield* live.count()).toBe(2)
      expect(Option.getOrThrow(yield* fixture.load()).calls).toHaveLength(2)
    }))

  it.effect("keys on the whole request, so a model switch is a miss", () =>
    Effect.gen(function*() {
      const fixture = yield* FixtureStore.makeMemory()
      const live = yield* countingLive
      const model = CachedModel.make({ live: live.live, fixture })
      yield* Stream.runDrain(model.stream(request("Summarize PR 4821.")))
      yield* Stream.runDrain(model.stream(request("Summarize PR 4821.", "anthropic:claude-sonnet-4")))
      expect(yield* live.count()).toBe(2)
    }))

  it.effect("keys on toolChoice, so two requests that differ only there do not share a recording", () =>
    Effect.gen(function*() {
      const fixture = yield* FixtureStore.makeMemory()
      const live = yield* countingLive
      const model = CachedModel.make({ live: live.live, fixture })
      const base = request("Summarize PR 4821.")
      yield* Stream.runDrain(model.stream(base))
      yield* Stream.runDrain(model.stream(ModelRequest.ModelRequest.make({ ...base, toolChoice: "none" })))
      expect(yield* live.count()).toBe(2)
    }))

  it.effect("replays a recorded provider failure as a ModelError, after the events that preceded it", () =>
    Effect.gen(function*() {
      const fields: Complete<Omit<ModelErrorLike, "_tag">> = {
        code: "quota_exceeded",
        message: "account quota exhausted",
        path: "$.model",
        retryAfterMillis: 1_000,
        resetAtEpochMillis: 1_757_000_000_000,
        resetSource: "retry-after",
        quotaScope: "account",
        providerCode: "quota_exceeded",
        requestId: "req_1",
        httpStatus: 429
      }
      const failure = new ModelError(fields)
      const live = Model.make({
        stream: () => Stream.concat(Stream.fail(failure))(Stream.fromIterable(events.slice(0, 2)))
      })
      const fixture = yield* FixtureStore.makeMemory()
      yield* Stream.runDrain(CachedModel.make({ live, fixture }).stream(request("Summarize PR 4821."))).pipe(
        Effect.flip
      )

      const seen: Array<ModelEvent.ModelEvent> = []
      const replayed = yield* CachedModel.make({ live: failingLive, fixture })
        .stream(request("Summarize PR 4821."))
        .pipe(
          Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
          Effect.flip
        )
      expect(seen).toEqual(events.slice(0, 2))
      expect(replayed).toBeInstanceOf(ModelError)
      expect(replayed).toMatchObject(fields)
    }))

  it.effect("provides the cached model as the Model seam", () =>
    Effect.gen(function*() {
      const fixture = yield* FixtureStore.makeMemory()
      const live = yield* countingLive
      yield* Effect.gen(function*() {
        const model = yield* Model.Model
        yield* Stream.runDrain(model.stream(request("Summarize PR 4821.")))
      }).pipe(Effect.provide(CachedModel.layer({ live: live.live, fixture })))
      expect(yield* live.count()).toBe(1)
    }))

  it.effect("records to a JSON file that a second store replays without the live model", () =>
    withTempDir((directory) =>
      Effect.gen(function*() {
        const path = join(directory, "nested", "balance.json")
        const live = yield* countingLive
        const recording = yield* FixtureStore.makeFile(path)
        yield* Stream.runDrain(CachedModel.make({ live: live.live, fixture: recording }).stream(request("Balance?")))
        expect(yield* live.count()).toBe(1)

        yield* recording.flush()
        const written = yield* decode(JSON.parse(readFileSync(path, "utf8")))
        expect(written.calls).toHaveLength(1)
        expect(written.calls[0]!.events).toEqual(events)

        const replaying = yield* FixtureStore.makeFile(path)
        const model = CachedModel.make({ live: failingLive, fixture: replaying })
        const seen = yield* Stream.runCollect(model.stream(request("Balance?")))
        expect([...seen]).toEqual(events)
      })
    ))
})

describe("FixtureStore", () => {
  it.effect("reports no fixture until the first call is recorded", () =>
    Effect.gen(function*() {
      const store = yield* FixtureStore.makeMemory()
      expect(Option.isNone(yield* store.load())).toBe(true)
      yield* store.append({ request: request("Balance?"), model: "openai:gpt-5-mini", events: [] })
      expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(1)
    }))

  it.effect("starts from a fixture it was given", () =>
    Effect.gen(function*() {
      const seeded = { calls: [{ request: request("Balance?"), model: "openai:gpt-5-mini", events }] }
      const store = yield* FixtureStore.makeMemory(seeded)
      expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(1)
    }))

  it.effect("encodes each recorded call once across the appends of one recording run", () =>
    Effect.gen(function*() {
      const counting = countingStore()
      const live = yield* countingLive
      const model = CachedModel.make({ live: live.live, fixture: counting.store })
      const prompts = ["Prompt 1", "Prompt 2", "Prompt 3", "Prompt 4", "Prompt 5"]
      yield* Effect.forEach(prompts, (prompt) => Stream.runDrain(model.stream(request(prompt))))
      // Every append publishes a new fixture, so a lookup that re-encoded the
      // calls already recorded charged the whole transcript to every turn. The
      // last call is first indexed by the replay this cache exists for.
      const replayed = yield* Stream.runCollect(model.stream(request(prompts[0]!)))
      expect([...replayed]).toEqual(events)
      expect(yield* live.count()).toBe(prompts.length)
      expect(counting.encodings()).toEqual(prompts.map(() => 1))
    }))

  it.effect("reports no fixture for a file that does not exist", () =>
    withTempDir((directory) =>
      Effect.gen(function*() {
        const store = yield* FixtureStore.makeFile(join(directory, "missing.json"))
        expect(Option.isNone(yield* store.load())).toBe(true)
      })
    ))

  it.effect("keeps every appended call when calls are recorded concurrently", () =>
    withTempDir((directory) =>
      Effect.gen(function*() {
        const path = join(directory, "concurrent.json")
        const store = yield* FixtureStore.makeFile(path)
        yield* Effect.forEach(
          [1, 2, 3, 4, 5],
          (index) => store.append({ request: request(`Prompt ${index}`), model: "openai:gpt-5-mini", events: [] }),
          { concurrency: "unbounded" }
        )
        expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(5)
        yield* store.flush()
        expect((yield* decode(JSON.parse(readFileSync(path, "utf8")))).calls).toHaveLength(5)
      })
    ))

  it.effect("dies on a fixture file that does not decode", () =>
    withTempDir((directory) =>
      Effect.gen(function*() {
        const path = join(directory, "broken.json")
        yield* Effect.sync(() => writeFileSync(path, JSON.stringify({ calls: [{ model: 7 }] })))
        const exit = yield* FixtureStore.makeFile(path).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      })
    ))

  it.effect("provides the memory and file stores as layers", () =>
    withTempDir((directory) =>
      Effect.gen(function*() {
        const read = Effect.gen(function*() {
          const store = yield* FixtureStore.FixtureStore
          return yield* store.load()
        })
        expect(Option.isNone(yield* read.pipe(Effect.provide(FixtureStore.layerMemory())))).toBe(true)
        expect(
          Option.isNone(yield* read.pipe(Effect.provide(FixtureStore.layerFile(join(directory, "absent.json")))))
        ).toBe(true)
      })
    ))
})
