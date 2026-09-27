/**
 * The read/write credential split, asserted by effect rather than by shape.
 *
 * The cache had one bearer token. Every job that could read the cache could
 * also publish to it, so any job holding the token could publish a green
 * result that a later trunk build consumed. The split only means something if
 * the server refuses: a credential that reads must not be able to mutate, and
 * the refusal must land before the request body is read, so a rejected
 * publication costs the service nothing.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { createHandler } from "../protocol.ts"
import { MemoryActionCache, MemoryContentStore } from "./MemoryStores.ts"

const readCredential = "read-credential-with-sufficient-entropy-for-tests"
const writeCredential = "write-credential-with-sufficient-entropy-for-tests"
const hashOf = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")
const keyDigest = "a".repeat(64)

interface Deployment {
  readonly handler: (request: Request) => Promise<Response>
  readonly actionCache: MemoryActionCache
  readonly contentStore: MemoryContentStore
}

const deploy = (options: { readonly read?: string; readonly write?: string } = {}): Deployment => {
  const actionCache = new MemoryActionCache()
  const contentStore = new MemoryContentStore()
  return {
    actionCache,
    contentStore,
    handler: createHandler({
      actionCache,
      contentStore,
      readTokenHash: hashOf(options.read ?? readCredential),
      writeTokenHash: hashOf(options.write ?? writeCredential)
    })
  }
}

const as = (credential: string, path: string, init: RequestInit = {}): Request => {
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${credential}`)
  return new Request(`https://cache.test${path}`, { ...init, headers })
}

const publication = (key: string): RequestInit => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    keyDigest: key,
    result: { key, target: "Test", label: "//:test", exitOk: true, output: {}, storedAt: "2026-08-31T00:00:00.000Z" }
  })
})

const artifact = (): { readonly digest: string; readonly init: RequestInit } => {
  const bytes = "artifact bytes"
  return {
    digest: createHash("sha256").update(bytes, "utf8").digest("hex"),
    init: { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes }
  }
}

describe("the read credential cannot mutate the cache", () => {
  it("refuses malformed read namespace scopes at construction", () => {
    const dependencies = {
      actionCache: new MemoryActionCache(),
      contentStore: new MemoryContentStore(),
      readTokenHash: hashOf(readCredential),
      writeTokenHash: hashOf(writeCredential)
    }
    expect(() => createHandler({ ...dependencies, readNamespacePrefix: 42 as never })).toThrow("readNamespacePrefix")
    expect(() => createHandler({ ...dependencies, readNamespacePrefix: "pr-1" })).toThrow("readNamespacePrefix")
  })

  it("confines a scoped read token to its action-cache namespace", async () => {
    const actionCache = new MemoryActionCache()
    const handler = createHandler({
      actionCache,
      contentStore: new MemoryContentStore(),
      readTokenHash: hashOf(readCredential),
      readNamespacePrefix: "pr-1/",
      writeTokenHash: hashOf(writeCredential)
    })
    for (const namespace of ["pr-1/", "main/", "pr-2/", "pr-10/"]) {
      const key = namespace + keyDigest
      expect((await handler(as(writeCredential, `/ac/${encodeURIComponent(key)}`, publication(key)))).status).toBe(201)
    }
    for (const [key, status] of [
      ["pr-1/" + keyDigest, 200],
      ["main/" + keyDigest, 403],
      ["pr-2/" + keyDigest, 403],
      ["pr-10/" + keyDigest, 403],
      [keyDigest, 403]
    ] as const) {
      expect((await handler(as(readCredential, `/ac/${encodeURIComponent(key)}`))).status).toBe(status)
    }
    expect((await handler(as(readCredential, `/cas/${keyDigest}`))).status).toBe(403)
    expect((await handler(as(readCredential, "/cas/findMissing", { method: "POST", body: JSON.stringify({ digests: [] }) }))).status).toBe(403)
  })

  it("refuses an action-cache publication with 403 and stores nothing", async () => {
    const { actionCache, handler } = deploy()

    const refused = await handler(as(readCredential, `/ac/${keyDigest}`, publication(keyDigest)))

    expect(refused.status).toBe(403)
    expect(actionCache.entries.size).toBe(0)
  })

  it("refuses an artifact publication with 403 and stores nothing", async () => {
    const { contentStore, handler } = deploy()
    const { digest, init } = artifact()

    const refused = await handler(as(readCredential, `/cas/${digest}`, init))

    expect(refused.status).toBe(403)
    expect(contentStore.objects.size).toBe(0)
  })

  it("refuses a deletion with 403 and keeps the entry", async () => {
    const { actionCache, handler } = deploy()
    await handler(as(writeCredential, `/ac/${keyDigest}`, publication(keyDigest)))

    const refused = await handler(as(readCredential, `/ac/${keyDigest}`, { method: "DELETE" }))

    expect(refused.status).toBe(403)
    expect(actionCache.entries.size).toBe(1)
  })

  /**
   * A refusal that reads the body first still pays for the upload it refuses.
   * The instrumented body records every interaction: cancellation is the only
   * one a refused publication may cause.
   */
  it("refuses before the request body is read", async () => {
    const { handler } = deploy()
    const log: Array<string> = []
    const body = {
      async cancel(): Promise<void> {
        log.push("cancel")
      },
      getReader() {
        log.push("read")
        return {
          async read(): Promise<{ readonly done: boolean; readonly value: unknown }> {
            return { done: true, value: undefined }
          },
          async cancel(): Promise<void> {
            log.push("cancel")
          },
          releaseLock(): void {}
        }
      }
    }
    const request = {
      url: `https://cache.test/ac/${keyDigest}`,
      method: "PUT",
      headers: new Headers({
        authorization: `Bearer ${readCredential}`,
        "content-type": "application/json"
      }),
      body
    } as unknown as Request

    const refused = await handler(request)

    expect(refused.status).toBe(403)
    expect(log).not.toContain("read")
  })
})

describe("both credentials read, and only the write credential publishes", () => {
  it("serves a hit to either credential", async () => {
    const { handler } = deploy()
    expect((await handler(as(writeCredential, `/ac/${keyDigest}`, publication(keyDigest)))).status).toBe(201)

    const byWriter = await handler(as(writeCredential, `/ac/${keyDigest}`))
    const byReader = await handler(as(readCredential, `/ac/${keyDigest}`))

    expect(byWriter.status).toBe(200)
    expect(byReader.status).toBe(200)
    expect(await byReader.text()).toBe(await byWriter.text())
  })

  it("publishes an action-cache entry and an artifact for the write credential", async () => {
    const { handler } = deploy()
    const { digest, init } = artifact()

    expect((await handler(as(writeCredential, `/ac/${keyDigest}`, publication(keyDigest)))).status).toBe(201)
    expect((await handler(as(writeCredential, `/cas/${digest}`, init))).status).toBe(201)
    expect((await handler(as(readCredential, `/cas/${digest}`, { method: "HEAD" }))).status).toBe(200)
  })

  /** `findMissing` mutates nothing, so a reader may probe with it. */
  it("admits the read credential to findMissing", async () => {
    const { handler } = deploy()

    const probed = await handler(
      as(readCredential, "/cas/findMissing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digests: ["b".repeat(64)] })
      })
    )

    expect(probed.status).toBe(200)
    await expect(probed.json()).resolves.toEqual({ missing: ["b".repeat(64)] })
  })

  it("still answers 401 for an unknown credential and keeps readiness public", async () => {
    const { handler } = deploy()

    expect((await handler(as("neither-credential", `/ac/${keyDigest}`))).status).toBe(401)
    expect((await handler(as("neither-credential", `/ac/${keyDigest}`, publication(keyDigest)))).status).toBe(401)
    expect((await handler(new Request("https://cache.test/healthz"))).status).toBe(200)
  })

  /**
   * An operator rolling out the split gives the current token to the write
   * digest and mints a distinct read token, so rollout never needs one secret
   * to hold both roles.
   */
  it("refuses a deployment that configures one secret for both directions", () => {
    const credentialHash = hashOf(writeCredential)
    expect(() =>
      createHandler({
        actionCache: new MemoryActionCache(),
        contentStore: new MemoryContentStore(),
        readTokenHash: credentialHash,
        writeTokenHash: credentialHash
      })
    ).toThrow("must differ")
  })

  it("refuses a deployment configured with anything but two digests", () => {
    const dependencies = {
      actionCache: new MemoryActionCache(),
      contentStore: new MemoryContentStore(),
      readTokenHash: hashOf(readCredential),
      writeTokenHash: hashOf(writeCredential)
    }
    expect(() => createHandler({ ...dependencies, readTokenHash: "not-a-digest" })).toThrow("readTokenHash")
    expect(() => createHandler({ ...dependencies, writeTokenHash: "not-a-digest" })).toThrow("writeTokenHash")
    expect(() => createHandler({ ...dependencies, readTokenHash: undefined as never })).toThrow("readTokenHash")
    expect(() => createHandler({ ...dependencies, writeTokenHash: undefined as never })).toThrow("writeTokenHash")
  })
})
