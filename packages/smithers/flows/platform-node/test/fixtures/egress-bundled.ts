/** Executed as emitted ESM by Node, never by the test runner's module loader. */
import { Destination } from "@smthrs/kernel/HttpClient"
import { Effect } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { strict as assert } from "node:assert"
import * as EgressHttpClient from "../../src/EgressHttpClient.ts"

const input = JSON.parse(process.argv[2]!) as {
  readonly environment: Record<string, string>
  readonly urls: ReadonlyArray<string>
  readonly destination?: { readonly origin: string; readonly addresses: ReadonlyArray<string> }
  readonly headers?: Record<string, string>
  readonly timeoutMs?: number
}

const program = Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient
  const results: Array<unknown> = []
  for (const url of input.urls) {
    const result = yield* Effect.result(
      client.execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(input.headers ?? {}))
      ).pipe(
        Effect.flatMap((response) => Effect.map(response.text, (text) => ({ status: response.status, text }))),
        Effect.timeout(input.timeoutMs ?? 5000)
      )
    )
    results.push(
      result._tag === "Success"
        ? { outcome: "success", ...result.success }
        : { outcome: "failure", tag: result.failure._tag }
    )
  }
  return { results, client }
})
const provided = input.destination === undefined ? program : program.pipe(
  Effect.provideService(Destination, input.destination)
)
const completed = await Effect.runPromise(provided.pipe(Effect.provide(EgressHttpClient.layer(input.environment))))
if (input.destination === undefined) {
  const retired = await Effect.runPromise(Effect.result(completed.client.get(input.urls[0]!)))
  assert.equal(retired._tag, "Failure", "scope exit must retire the shared dispatcher")
}
console.log(JSON.stringify(completed.results))
// Keep Node alive while the parent checks pool cleanup independently of exit.
await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()))
