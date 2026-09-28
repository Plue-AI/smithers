/**
 * The chunked upload protocol against a real HTTP server.
 *
 * `RemoteArtifacts.test.ts` asserts the wire shape against a stub client, which
 * is where header-by-header claims belong. This suite asserts the two claims a
 * stub cannot make: that an interrupted transfer resumes over a real socket
 * from the prefix a real server kept, and that a real server refusing ranged
 * bodies is answered with one whole-blob `PUT` that actually lands.
 *
 * The store refuses any endpoint that is not HTTPS, because its options carry
 * credentials, and that guard is not weakened for a test. The client instead
 * runs on the real fetch transport with `FetchHttpClient.Fetch` rewriting the
 * declared `https://cas.test` authority onto the loopback server's port: real
 * requests, real bodies, real status codes, over a real connection, with TLS
 * termination the only thing standing in.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { createServer, type Server } from "node:http"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import * as RemoteArtifacts from "../src/RemoteArtifacts.ts"
import { bytes, sha256, text, withCrypto } from "./Crypto.ts"

const artifact = "0123456789"
const payload = bytes(artifact)
const digest = sha256(payload)

/** How the server answers a ranged `PUT`. */
type RangeMode =
  /** Accepts ranges, then interrupts uploads after `failAfterChunks` until resumed. */
  | { readonly _tag: "Accept"; readonly failAfterChunks?: number }
  /** Refuses ranged bodies with this status, accepting the whole blob instead. */
  | { readonly _tag: "Refuse"; readonly status: 400 | 411 | 416 }
  /**
   * Never reads `Content-Range`: every `PUT` replaces the stored blob with the
   * body it carried and answers `201`. This is plain WebDAV `PUT`, the dumb
   * HTTP cache Bazel documents as supported.
   */
  | { readonly _tag: "Ignore" }
  /**
   * Speaks the probe but answers `201` to every chunk, so the first chunk of
   * several reports a completion the tier has not reached.
   */
  | { readonly _tag: "EagerOk" }
  /**
   * Speaks the whole protocol and then keeps only the completing chunk, so its
   * `201` is honest about the request and wrong about the blob.
   */
  | { readonly _tag: "LosesPrefix" }

interface Tier {
  readonly port: number
  /** Every request the server answered, as `METHOD content-range`. */
  readonly requests: ReadonlyArray<string>
  /** The bytes the server currently holds for `digest`. */
  readonly stored: () => Uint8Array | undefined
  /** Ends an injected outage without discarding the committed prefix. */
  readonly resumeUploads: () => void
  readonly close: () => Promise<void>
}

/**
 * A real CAS server speaking the resumable half of the dumb-HTTP protocol:
 * a `bytes * /{total}` probe answers `308` plus the prefix it holds, each
 * `bytes a-b/{total}` chunk appends when it starts exactly at the held length,
 * and the chunk completing the blob answers `201`.
 */
const startTier = (mode: RangeMode): Promise<Tier> => {
  const requests: Array<string> = []
  let prefix = new Uint8Array(0)
  let complete: Uint8Array | undefined
  let chunks = 0
  let resumed = false
  const server: Server = createServer((request, response) => {
    const range = request.headers["content-range"]
    requests.push(`${request.method} ${range ?? "-"}`)
    if (request.method === "GET") {
      if (complete === undefined) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.from(complete))
      return
    }
    if (request.method === "HEAD") {
      if (complete === undefined) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { "content-length": String(complete.byteLength) }).end()
      return
    }
    if (request.method !== "PUT") {
      response.writeHead(405).end()
      return
    }
    const body: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => body.push(chunk))
    request.on("end", () => {
      const received = new Uint8Array(Buffer.concat(body))
      if (range === undefined) {
        // The whole-blob fallback, which every mode accepts.
        complete = received
        prefix = received
        response.writeHead(201).end()
        return
      }
      if (mode._tag === "Refuse") {
        response.writeHead(mode.status).end()
        return
      }
      if (mode._tag === "Ignore") {
        // The header is not read at all, so the empty probe body becomes the
        // stored blob and the answer says the write succeeded.
        complete = received
        prefix = received
        response.writeHead(201).end()
        return
      }
      const parsed = /^bytes (?:\*|(\d+)-(\d+))\/(\d+)$/.exec(range)
      if (parsed === null) {
        response.writeHead(400).end()
        return
      }
      const total = Number(parsed[3])
      if (parsed[1] === undefined) {
        // The probe. Nothing held yet is still a 308: the client starts at 0.
        if (prefix.byteLength === total) {
          response.writeHead(200).end()
          return
        }
        response.writeHead(308, prefix.byteLength === 0 ? {} : { range: `bytes=0-${prefix.byteLength - 1}` }).end()
        return
      }
      const start = Number(parsed[1])
      if (start !== prefix.byteLength) {
        response.writeHead(416).end()
        return
      }
      chunks++
      const failAfter = mode._tag === "Accept" ? mode.failAfterChunks : undefined
      if (failAfter !== undefined && chunks > failAfter && !resumed) {
        // The transfer dies mid-flight: the prefix the server already committed
        // survives. Keep the outage active across transport-level retries.
        request.socket.destroy()
        return
      }
      const grown = new Uint8Array(prefix.byteLength + received.byteLength)
      grown.set(prefix)
      grown.set(received, prefix.byteLength)
      prefix = grown
      if (prefix.byteLength === total) {
        // `LosesPrefix` keeps only the body of the request that completed the
        // blob, which is the mis-storing tier a `201` alone cannot rule out.
        complete = mode._tag === "LosesPrefix" ? received : prefix
        response.writeHead(201).end()
        return
      }
      if (mode._tag === "EagerOk") {
        response.writeHead(201).end()
        return
      }
      response.writeHead(308, { range: `bytes=0-${prefix.byteLength - 1}` }).end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve({
        port: typeof address === "object" && address !== null ? address.port : 0,
        requests,
        stored: () => complete,
        resumeUploads: () => {
          resumed = true
        },
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections()
            server.close(() => closed())
          })
      })
    })
  })
}

/** The real fetch transport, with the declared HTTPS authority mapped to `port`. */
const transport = (port: number) =>
  Layer.provide(
    FetchHttpClient.layer,
    Layer.succeed(
      FetchHttpClient.Fetch,
      ((input, init) => {
        const href = input instanceof URL ? input.href : typeof input === "string" ? input : (input as Request).url
        const url = new URL(href)
        url.protocol = "http:"
        url.host = `127.0.0.1:${port}`
        return globalThis.fetch(url, init)
      }) as typeof globalThis.fetch
    )
  )

const storeOn = (port: number, options?: { readonly chunkBytes?: number }) =>
  Effect.provide(
    RemoteArtifacts.make({ endpoint: "https://cas.test", ...options }),
    transport(port)
  )

const onTier = <A>(
  mode: RangeMode,
  use: (tier: Tier) => Promise<A>
): Promise<A> =>
  startTier(mode).then(async (tier) => {
    try {
      return await use(tier)
    } finally {
      await tier.close()
    }
  })

/** Answers every request with a redirect to `location`. */
const startRedirector = (location: string): Promise<Tier> =>
  new Promise((resolve) => {
    const requests: Array<string> = []
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`)
      response.writeHead(302, { location }).end()
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve({
        port: typeof address === "object" && address !== null ? address.port : 0,
        requests,
        stored: () => undefined,
        resumeUploads: () => {},
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections()
            server.close(() => closed())
          })
      })
    })
  })

/** Records every request and the credential header it carried. */
const startCollector = (): Promise<
  { readonly port: number; readonly seen: Array<string>; close: () => Promise<void> }
> =>
  new Promise((resolve) => {
    const seen: Array<string> = []
    const server = createServer((request, response) => {
      seen.push(`${request.method} ${String(request.headers["x-cache-token"])}`)
      response.writeHead(200).end()
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve({
        port: typeof address === "object" && address !== null ? address.port : 0,
        seen,
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections()
            server.close(() => closed())
          })
      })
    })
  })

describe("redirects", () => {
  it("never follows a 3xx to another origin, so credential headers stay with the tier", async () => {
    const collector = await startCollector()
    const tier = await startRedirector(`http://127.0.0.1:${collector.port}/steal`)
    try {
      const store = Effect.provide(
        RemoteArtifacts.make({ endpoint: "https://cas.test", headers: { "x-cache-token": "secret" } }),
        transport(tier.port)
      )
      for (
        const operation of [
          Effect.flatMap(store, (tiered) => Effect.asVoid(tiered.get(digest))),
          Effect.flatMap(store, (tiered) => Effect.asVoid(tiered.has(digest))),
          Effect.flatMap(store, (tiered) => Effect.asVoid(tiered.put(payload)))
        ]
      ) {
        const exit = await Effect.runPromise(Effect.exit(withCrypto(operation)))
        expect(exit._tag).toBe("Failure")
      }
      expect(tier.requests.length).toBeGreaterThan(0)
      expect(collector.seen).toEqual([])
    } finally {
      await tier.close()
      await collector.close()
    }
  })
})

describe("a real server", () => {
  it("resumes an interrupted chunked upload from the prefix the server kept", () =>
    onTier({ _tag: "Accept", failAfterChunks: 1 }, async (tier) => {
      const put = Effect.flatMap(storeOn(tier.port, { chunkBytes: 4 }), (store) => store.put(payload))

      // The first transfer dies after one chunk, so the blob is not complete.
      const first = await Effect.runPromise(Effect.exit(withCrypto(put)))
      expect(first._tag).toBe("Failure")
      expect(tier.stored()).toBeUndefined()
      const interruptedRequests = tier.requests.length
      tier.resumeUploads()

      // The second one asks what the tier holds, probes, is told `0-3`, and
      // sends the rest: chunk one never travels twice. The closing `HEAD` is
      // the completion check, which is what makes the `201` above a claim this
      // client verified rather than one it accepted.
      const resumed = await Effect.runPromise(withCrypto(put))
      expect(resumed).toBe(digest)
      expect(text(tier.stored())).toBe(artifact)
      expect(tier.requests.filter((request) => request === "PUT bytes 0-3/10")).toHaveLength(1)
      expect(tier.requests.slice(interruptedRequests)).toEqual([
        "HEAD -",
        "PUT bytes */10",
        "PUT bytes 4-7/10",
        "PUT bytes 8-9/10",
        "HEAD -"
      ])
    }))

  it("serves back exactly what a resumed upload assembled", () =>
    onTier({ _tag: "Accept" }, async (tier) => {
      const store = storeOn(tier.port, { chunkBytes: 4 })
      const round = Effect.gen(function*() {
        const tiered = yield* store
        yield* tiered.put(payload)
        return yield* tiered.get(digest)
      })
      expect(text(await Effect.runPromise(withCrypto(round)))).toBe(artifact)
    }))

  // `400` is what the repository's own cache services answer, per RFC 9110
  // section 14.5's rule for a resource that does not support partial PUT.
  it.each([400, 411, 416] as const)(
    "falls back to a whole-blob PUT when the server answers %s",
    (status) =>
      onTier({ _tag: "Refuse", status }, async (tier) => {
        const put = Effect.flatMap(storeOn(tier.port, { chunkBytes: 4 }), (store) => store.put(payload))
        expect(await Effect.runPromise(withCrypto(put))).toBe(digest)
        // The probe is refused for range, and the blob lands whole on the retry.
        expect(tier.requests).toEqual(["HEAD -", "PUT bytes */10", "PUT -"])
        expect(text(tier.stored())).toBe(artifact)
      })
  )

  it("sends the blob whole to a server that ignores Content-Range", () =>
    onTier({ _tag: "Ignore" }, async (tier) => {
      const put = Effect.flatMap(storeOn(tier.port, { chunkBytes: 4 }), (store) => store.put(payload))

      // A plain WebDAV store answers the empty probe `201` and stores its
      // zero-byte body. Reading that answer as a completed transfer would
      // publish a digest over an empty blob, so it is read as the only other
      // thing it can mean and the blob is sent whole.
      expect(await Effect.runPromise(withCrypto(put))).toBe(digest)
      expect(text(tier.stored())).toBe(artifact)
      expect(tier.requests).toEqual(["HEAD -", "PUT bytes */10", "PUT -"])
    }))

  it("sends the blob whole when a chunk the server still owes bytes after answers 201", () =>
    onTier({ _tag: "EagerOk" }, async (tier) => {
      const put = Effect.flatMap(storeOn(tier.port, { chunkBytes: 4 }), (store) => store.put(payload))

      expect(await Effect.runPromise(withCrypto(put))).toBe(digest)
      expect(text(tier.stored())).toBe(artifact)
      // Four of ten bytes had travelled when the tier reported success, so the
      // whole-blob `PUT` is what actually published the digest.
      expect(tier.requests).toEqual(["HEAD -", "PUT bytes */10", "PUT bytes 0-3/10", "PUT -"])
    }))

  it("sends the blob whole when the completing chunk lands on a shorter stored blob", () =>
    onTier({ _tag: "LosesPrefix" }, async (tier) => {
      const put = Effect.flatMap(storeOn(tier.port, { chunkBytes: 4 }), (store) => store.put(payload))

      // Every answer in the sequence is correct and the last one is `201`, but
      // the tier kept two bytes. The completion check reads the stored length
      // and refuses to call that published.
      expect(await Effect.runPromise(withCrypto(put))).toBe(digest)
      expect(text(tier.stored())).toBe(artifact)
      expect(tier.requests.slice(-2)).toEqual(["HEAD -", "PUT -"])
    }))

  it("reports a digest the server never received as missing", () =>
    onTier({ _tag: "Accept" }, async (tier) => {
      const probe = Effect.flatMap(storeOn(tier.port), (store) => store.get(digest))
      const exit = await Effect.runPromise(Effect.exit(withCrypto(probe)))
      expect(exit._tag).toBe("Failure")
      const reason = exit._tag === "Failure" ? exit.cause.reasons[0] : undefined
      expect((reason as { readonly error: ArtifactStore.ArtifactMissing }).error._tag).toBe(
        "@smthrs/artifacts/ArtifactMissing"
      )
    }))
})
