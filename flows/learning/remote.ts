/** Host-owned run credential reader; learning has no host-local fallback. */
import { FlowRuntime } from "@smthrs/flow"
import { Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import type { Options } from "../coding/landing.ts"
import { Binding, LearningFailed, Snapshot } from "./flow.ts"

const fail = (code: "unavailable" | "invalid_input", message: string) => new LearningFailed({ code, message })
const maximumBytes = 2 * 1024 * 1024
const readJson = (response: HttpClientResponse.HttpClientResponse) => Effect.gen(function*() {
  const length = response.headers["content-length"]
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximumBytes))
    return yield* fail("invalid_input", "Learning response exceeds its bounded size")
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const captured = yield* Stream.runFoldEffect(response.stream, () => ({ bytes: 0, text: "" }), (state, chunk) =>
    Effect.try({
      try: () => {
        if (state.bytes + chunk.length > maximumBytes) throw new Error("bound")
        return { bytes: state.bytes + chunk.length, text: state.text + decoder.decode(chunk, { stream: true }) }
      },
      catch: () => fail("invalid_input", "Learning response is invalid or exceeds its bounded size")
    }))
  return yield* Effect.try({
    try: () => JSON.parse(captured.text + decoder.decode()) as unknown,
    catch: () => fail("invalid_input", "Learning response is not valid JSON")
  })
})

export const makeRemote = (options: Options) => Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient
  const api = yield* Effect.try({ try: () => new URL(options.apiBaseUrl), catch: () => fail("invalid_input", "Invalid learning API binding") })
  const loopback = api.hostname === "localhost" || api.hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(api.hostname)
  if (!(api.protocol === "https:" || (api.protocol === "http:" && loopback)) || api.username || api.password || api.search || api.hash ||
    !api.pathname.endsWith("/api") || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repositorySlug) ||
    options.repositorySlug.split("/").some(part => part === "." || part === ".."))
    return yield* fail("invalid_input", "Learning requires the provisioned repository API binding")
  const base = `${api.href}/repos/${options.repositorySlug.split("/").map(encodeURIComponent).join("/")}/mythical/learning`
  return Binding.of({ read: todo => Effect.gen(function*() {
    if (!Number.isSafeInteger(todo) || todo <= 0) return yield* fail("invalid_input", "Invalid learning TODO")
    const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
    if (Option.isNone(instance) || typeof instance.value.executionId !== "string" || instance.value.executionId.length === 0 || instance.value.executionId.length > 512)
      return yield* fail("invalid_input", "Learning requires the current flow execution")
    const run = instance.value.executionId
    const response = yield* HttpClient.withScope(client).execute(HttpClientRequest.get(`${base}/${todo}?run=${encodeURIComponent(run)}`).pipe(
      HttpClientRequest.bearerToken(options.token), HttpClientRequest.acceptJson
    ))
    if (response.status < 200 || response.status >= 300)
      return yield* fail(response.status === 400 || response.status === 409 ? "invalid_input" : "unavailable", `Learning snapshot returned HTTP ${response.status}`)
    const snapshot = yield* readJson(response).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
      Effect.mapError(() => fail("invalid_input", "Learning snapshot is invalid")))
    if (snapshot.repository !== options.repositorySlug || snapshot.todo !== todo || snapshot.run !== run)
      return yield* fail("invalid_input", "Learning snapshot does not match this repository, TODO and run")
    return snapshot
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }), Effect.scoped,
    Effect.retry({ times: 10, schedule: Schedule.spaced("200 millis"), while: error => error instanceof LearningFailed && error.message === "Learning snapshot returned HTTP 503" }),
    Effect.timeoutOrElse({ duration: "45 seconds", orElse: () => Effect.fail(fail("unavailable", "Learning snapshot timed out")) }),
    Effect.mapError(error => error instanceof LearningFailed ? error : fail("unavailable", "Learning snapshot could not be read"))
  ) })
})
export const remoteLayer = (options: Options) => Layer.effect(Binding, makeRemote(options))
