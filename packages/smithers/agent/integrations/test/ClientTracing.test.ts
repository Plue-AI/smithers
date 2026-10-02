import { Effect, Tracer } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as GitHubClient from "../src/github/GitHubClient.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

const traced = async <A, E>(effect: Effect.Effect<A, E>) => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  await Effect.runPromise(Effect.exit(effect.pipe(Effect.provideService(Tracer.Tracer, tracer))))
  return spans
}

describe("client tracing", () => {
  it("records a GitHub request span with its attempts and failure class, never the token", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ message: "boom" }, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ message: "boom" }, { status: 502 }))
    vi.stubGlobal("fetch", request)
    const client = GitHubClient.make({ token: "secret-token", maxRetries: 1 }, {})
    const spans = await traced(client.request("GET", "/repos/o/r"))
    const span = spans.find((candidate) => candidate.name === "GitHubClient.request")
    expect(span?.attributes.get("http.request.method")).toBe("GET")
    expect(span?.attributes.get("url.path")).toBe("/repos/o/r")
    expect(span?.attributes.get("http.attempts")).toBe(2)
    expect(span?.attributes.get("http.response.status_code")).toBe(502)
    expect(span?.attributes.get("integration.retryable")).toBe(true)
    expect(JSON.stringify([...(span?.attributes.entries() ?? [])])).not.toContain("secret-token")
  })
})
