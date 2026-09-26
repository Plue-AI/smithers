import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import { GenerationParams, Message, ModelRequest } from "@smthrs/model/ModelRequest"
import { Effect, Schema, Stream } from "effect"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as RequestExecutor from "../../packages/smithers/agent/model/src/RequestExecutor.ts"
import { seatResolver } from "../../packages/smithers/src/internal/NativeEquipment.ts"
import { SeatUnresolved } from "./runtime.ts"
import {
  configured,
  defaultModel,
  fromEnvironment,
  loopback,
  roleResolver,
  roles,
  transcriptKey,
  transcriptModel
} from "./seats.ts"

const request = ModelRequest.make({
  modelId: "test",
  system: [],
  messages: [Message.user("Explain this revision")],
  tools: [],
  params: GenerationParams.make({ temperature: 0, maxTokens: 512 })
})
const events = [
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", text: "answer" },
  { type: "text-end", id: "answer" },
  { type: "usage", totalTokens: 12 },
  { type: "settle", stopReason: "stop" }
] as const
const collect = (model: Model.Model, input = request) => Effect.runPromise(Stream.runCollect(model.stream(input)))

test("supplied seats resolve each role through the configured provider:model", async () => {
  const calls: string[] = []
  const base = SeatResolver.make({
    resolve: (id) => {
      calls.push(id)
      return Effect.succeed({
        id,
        modelId: "test",
        model: Model.makeNoop(),
        contextWindowTokens: 10000,
        route: { prepare: () => Effect.die("unused") }
      })
    }
  })
  const resolver = roleResolver(base, "openai:test")
  for (const role of roles) assert.equal((await Effect.runPromise(resolver.resolve(role))).id, role)
  await Effect.runPromise(resolver.resolve("unrelated"))
  assert.deepEqual(calls, ["openai:test", "openai:test", "unrelated"])
})

test("environment model/default, native credential resolution, and missing/invalid models", async () => {
  assert.equal(fromEnvironment({}).model, defaultModel)
  const options = fromEnvironment({ SMITHERS_LIBRARIAN_MODEL: "anthropic:test" })
  assert.equal(configured(options), "anthropic:test")
  const executor = RequestExecutor.RequestExecutor.of({ execute: () => Effect.die("must not dispatch provider") })
  const env = roleResolver(seatResolver({ ANTHROPIC_API_KEY: "unit-test-unused" }, executor), options.model)
  assert.equal((await Effect.runPromise(env.resolve(roles[0]))).modelId, "test")
  for (const base of [SeatResolver.makeNoop(), seatResolver({}, executor)]) {
    const failure = await Effect.runPromise(roleResolver(base).resolve(roles[0]).pipe(Effect.flip))
    assert(Schema.is(SeatUnresolved)(failure))
    assert.equal(failure.seat, roles[0])
  }
  for (const model of ["", "no-provider", "openai:", "OPENAI:test", "openai:has space", "openai:a:b"]) {
    assert.throws(() => configured({ model }), (error) => Schema.is(SeatUnresolved)(error))
  }
})

test("transcripts refuse non-loopback at configuration, including record mode", () => {
  for (
    const apiUrl of [
      "",
      "https://example.com",
      "http://localhost.example",
      "http://127.0.0.1@example.com",
      "file:///tmp/test",
      "http://[::]"
    ]
  ) {
    assert.equal(loopback(apiUrl), false)
    for (const record of [true, false]) {
      assert.throws(() => configured({ transcripts: "/tmp/fixtures", apiUrl, record }), /loopback/)
    }
  }
  for (const apiUrl of ["http://localhost:8080", "https://127.0.0.1", "http://127.2.3.4", "http://[::1]:8000"]) {
    assert.equal(loopback(apiUrl), true)
    assert.equal(configured({ transcripts: "/tmp/fixtures", apiUrl }), defaultModel)
  }
})

test("canonical fixtures record once, replay without resolving credentials, and refuse misses/corruption", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "librarian-transcripts-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let calls = 0
  const live = Model.make({
    stream: () => {
      calls++
      return Stream.fromIterable(events)
    }
  })
  const recording = transcriptModel(directory, live)
  assert.deepEqual(await collect(recording), events)
  assert.deepEqual(await collect(recording), events)
  assert.equal(calls, 1)
  const shuffled = Schema.decodeUnknownSync(ModelRequest)({ ...request, params: { maxTokens: 512, temperature: 0 } })
  assert.equal(transcriptKey(request), transcriptKey(shuffled))
  const files = await readdir(directory)
  assert.deepEqual(files, [`${transcriptKey(request)}.json`])
  const resolver = roleResolver(
    SeatResolver.make({ resolve: () => Effect.die("must not resolve provider") }),
    "anthropic:test",
    { transcripts: directory, apiUrl: "http://127.0.0.1" }
  )
  const replay = await Effect.runPromise(resolver.resolve(roles[1]))
  assert.deepEqual(await collect(replay.model, shuffled), events)
  assert.equal((await Effect.runPromise(replay.route.prepare(request))).routeId, "librarian/transcript")
  const changed = ModelRequest.make({ ...request, params: GenerationParams.make({ temperature: 1 }) })
  await assert.rejects(collect(replay.model, changed), /Missing Librarian transcript/)
  const path = join(directory, files[0]!), saved = JSON.parse(await readFile(path, "utf8"))
  await writeFile(path, JSON.stringify({ ...saved, request: "different" }))
  await assert.rejects(collect(replay.model), /request mismatch/)
  await writeFile(path, "invalid json")
  await assert.rejects(collect(replay.model), /Invalid Librarian transcript/)
})

test("record opt-in uses supplied live seats and never persists failed provider streams", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "librarian-record-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const options = fromEnvironment({
    SMITHERS_LIBRARIAN_MODEL: "anthropic:test",
    SMITHERS_LIBRARIAN_TRANSCRIPTS: directory,
    SMITHERS_LIBRARIAN_RECORD: "1",
    SMITHERS_PRODUCT_API_URL: "http://localhost:8080"
  })
  let calls = 0
  const base = SeatResolver.make({
    resolve: (id) =>
      Effect.succeed({
        id,
        modelId: "test",
        contextWindowTokens: 10000,
        route: { prepare: () => Effect.die("unused") },
        model: Model.make({
          stream: () => {
            calls++
            return Stream.fromIterable(events)
          }
        })
      })
  })
  const seat = await Effect.runPromise(roleResolver(base, options.model, options).resolve(roles[1]))
  assert.deepEqual(await collect(seat.model), events)
  assert.equal(calls, 1)
  const failed = transcriptModel(
    directory,
    Model.make({ stream: () => Stream.fail(new ModelError({ code: "transport", message: "offline" })) })
  )
  const changed = ModelRequest.make({ ...request, modelId: "another" })
  await assert.rejects(collect(failed, changed), /offline/)
  assert.deepEqual(await readdir(directory), [`${transcriptKey(request)}.json`])
})
