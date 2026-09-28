import { Cause, Effect, Layer, Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Endpoint from "../src/Endpoint.ts"
import * as NodeOtel from "../src/NodeOtel.ts"
import * as Otlp from "../src/Otlp.ts"

const resource = { serviceName: "flows-test", serviceVersion: "1" } as const

const failureOf = async <A, E>(layer: Layer.Layer<A, E>) => {
  const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(layer)))
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Success") throw new Error("expected an endpoint refusal")
  const failure = Result.getOrUndefined(Cause.findError(exit.cause))
  expect(failure).toBeInstanceOf(Endpoint.InvalidExporterEndpoint)
  return failure as Endpoint.InvalidExporterEndpoint
}

const base = "http://collector.invalid:4318"

/** Two C0 controls the URL parser strips, written without a source escape. */
const verticalTab = String.fromCharCode(11)
const nul = String.fromCharCode(0)

describe("Endpoint", () => {
  /**
   * The exporter absorbs delivery failure by design, so a builder that accepts
   * a bad endpoint produces a layer indistinguishable from a working one. Both
   * public builders refuse the same set during acquisition instead.
   */
  it("refuses every endpoint that could never deliver, on both public builders", async () => {
    const rejected = [
      "",
      "  ",
      "collector.invalid:4318",
      "/v1/traces",
      "ftp://collector.invalid:4318",
      "file:///var/run/collector",
      "http://user:secret@collector.invalid:4318",
      "http://:secret@collector.invalid:4318",
      "http://collector.invalid:4318?tenant=example",
      "http://collector.invalid:4318/base/?token=secret",
      "http://collector.invalid:4318/base#fragment",
      "http://collector.invalid:4318?",
      "http://collector.invalid:4318#",
      "http:collector.invalid",
      "http://[malformed",
      "http:///collector.invalid",
      "https:/collector.invalid",
      "http://collector.invalid\\hidden",
      `http://collector.invalid/${"p".repeat(Endpoint.maximumEndpointLength)}`
    ]

    for (const endpoint of rejected) {
      const fromOtlp = await failureOf(Otlp.layerFetch({ baseUrl: endpoint }))
      expect(fromOtlp.code).toBe("invalid_exporter_endpoint")
      expect(fromOtlp.path).toBe("baseUrl")
      if (endpoint.trim() !== "") expect(fromOtlp.message).not.toContain(endpoint)

      const fromNode = await failureOf(NodeOtel.layerOtel({ endpoint, resource }))
      expect(fromNode.code).toBe("invalid_exporter_endpoint")
      expect(fromNode.path).toBe("endpoint")
    }
  })

  /**
   * The WHATWG URL parser strips leading and trailing C0 controls and spaces
   * and removes tab, newline, and carriage return from anywhere in its input,
   * so `new URL` reports every value below as a well-formed endpoint while the
   * unrepaired original is what a builder would hand its exporter. A trailing
   * newline off a config file or a leading space off a paste is the most
   * common shape of the mistake, and it produces exactly the silent
   * no-delivery this refusal exists to prevent.
   */
  it("refuses an endpoint the URL parser would silently repair", async () => {
    const padded = [
      `${base} `,
      ` ${base}`,
      `\t${base}`,
      `${base}\n`,
      `${base}\r\n`,
      `${base}\t`,
      `${base}/ `,
      `${base}${verticalTab}`,
      `${base}${nul}`,
      "http://collector\t.invalid:4318",
      "http://collector.invalid:4318/ba\nse"
    ]

    for (const endpoint of padded) {
      // The parser repairing it is the precondition that makes this a hole.
      expect(() => new URL(endpoint), JSON.stringify(endpoint)).not.toThrow()

      const fromOtlp = await failureOf(Otlp.layerFetch({ baseUrl: endpoint }))
      expect(fromOtlp.path, JSON.stringify(endpoint)).toBe("baseUrl")
      const fromNode = await failureOf(NodeOtel.layerOtel({ endpoint, resource }))
      expect(fromNode.path, JSON.stringify(endpoint)).toBe("endpoint")
    }
  })

  it("rejects a non-string endpoint without inspecting it as a URL", async () => {
    const failure = await failureOf(Otlp.layerFetch({ baseUrl: null as never }))
    expect(failure.path).toBe("baseUrl")
  })

  it("accepts an absolute collector URL and normalizes repeated trailing separators", () => {
    expect(Endpoint.normalize("http://collector.invalid:4318")).toBe("http://collector.invalid:4318")
    expect(Endpoint.normalize("http://collector.invalid:4318/")).toBe("http://collector.invalid:4318")
    expect(Endpoint.normalize("http://collector.invalid:4318//")).toBe("http://collector.invalid:4318")
    expect(Endpoint.normalize("https://collector.invalid/base/")).toBe("https://collector.invalid/base")
  })

  it("posts each signal below the decoded endpoint", () => {
    expect(
      (["traces", "metrics", "logs"] as const).map((signal) =>
        Endpoint.signalUrl("http://collector.invalid:4318//", signal)
      )
    ).toEqual([
      "http://collector.invalid:4318/v1/traces",
      "http://collector.invalid:4318/v1/metrics",
      "http://collector.invalid:4318/v1/logs"
    ])
    expect(Endpoint.signalUrl("https://collector.invalid/base", "traces")).toBe(
      "https://collector.invalid/base/v1/traces"
    )
  })

  it("decodes an acceptable endpoint into its normalized form", async () => {
    expect(await Effect.runPromise(Endpoint.decode("https://collector.invalid:4318//", "baseUrl"))).toBe(
      "https://collector.invalid:4318"
    )
  })

  /**
   * Every accepted endpoint has to survive the one operation the exporters
   * perform on it, so no value this schema admits can produce a signal URL the
   * host's own URL parser then rejects or rewrites.
   */
  it("keeps every accepted endpoint parseable once a signal path is appended", async () => {
    const accepted = [
      "http://localhost:4318",
      "http://127.0.0.1:4318/",
      "https://collector.invalid",
      "https://collector.invalid/base//",
      "https://collector.invalid:4318/tenant/9",
      `https://collector.invalid/${"p".repeat(Endpoint.maximumEndpointLength - 30)}`
    ]

    for (const endpoint of accepted) {
      const decoded = await Effect.runPromise(Endpoint.decode(endpoint, "baseUrl"))
      for (const signal of ["traces", "metrics", "logs"] as const) {
        const url = Endpoint.signalUrl(decoded, signal)
        expect(new URL(url).href, url).toBe(url)
        expect(url.endsWith(`/v1/${signal}`), url).toBe(true)
      }
    }
  })

  /**
   * A bearer token on a plaintext request crosses every network hop in the
   * clear. The builder refuses the pairing instead of exporting it.
   */
  it("refuses credential headers on a non-loopback http:// collector", async () => {
    const credentialHeaders = [
      { authorization: "Bearer synthetic-test-token" },
      { Authorization: "Bearer synthetic-test-token" },
      { "x-api-key": "synthetic-test-key" },
      { "X-Honeycomb-Team": "synthetic-test-key" },
      [["Proxy-Authorization", "Basic c3ludGhldGlj"]] as const
    ]
    for (const baseUrl of ["http://collector.invalid:4318", "HTTP://10.0.0.7:4318", "http://127.evil.invalid"]) {
      for (const headers of credentialHeaders) {
        const failure = await failureOf(Otlp.layerFetch({ baseUrl, headers }))
        expect(failure.code).toBe("invalid_exporter_endpoint")
        expect(failure.path).toBe("baseUrl")
        expect(failure.message).toContain("https://")
        expect(failure.message).not.toContain("synthetic")
      }
    }
  })

  it("admits credential headers over https:// or loopback, and plain headers anywhere", async () => {
    const admitted: ReadonlyArray<Otlp.Options> = [
      { baseUrl: "https://collector.invalid:4318", headers: { authorization: "Bearer t" } },
      { baseUrl: "http://localhost:4318", headers: { authorization: "Bearer t" } },
      { baseUrl: "http://127.0.0.1:4318", headers: { authorization: "Bearer t" } },
      { baseUrl: "http://[::1]:4318", headers: { authorization: "Bearer t" } },
      { baseUrl: "http://collector.invalid:4318", headers: { "x-scope-orgid": "tenant-9" } },
      { baseUrl: "http://collector.invalid:4318" }
    ]
    for (const options of admitted) {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Layer.build(Otlp.layerFetch({ ...options, exportInterval: "1 hour", shutdownTimeout: "1 millis" }))
        )
      )
      expect(exit._tag, options.baseUrl).toBe("Success")
    }
  })
})
