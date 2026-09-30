/**
 * The target-cache CLI client against the Worker's handler, end to end.
 *
 * Every other suite here drives the handler with hand-made bodies, which is
 * how the CLI shipped an envelope the Worker answers `422`: the CLI's first
 * publication disabled the remote for the rest of the run and nothing was
 * ever published. This suite runs the real `openCache` client, so a change on
 * either side of the wire that breaks the other fails here.
 */
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type CachedResult, openCache, publishNamespaceFromEnvironment } from "@smthrs/build-cli/Cache"
import { createHandler, maxConcurrentActionCachePublications } from "../protocol.ts"
import { MemoryActionCache, MemoryContentStore } from "./MemoryStores.ts"

const readCredential = "read-credential-with-sufficient-entropy-for-tests"
const writeCredential = "write-credential-with-sufficient-entropy-for-tests"
const hashOf = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")
const endpoint = "https://build.cache.test"

const resultFor = (key: string): CachedResult => ({
  key,
  target: "Test",
  label: "//:test",
  exitOk: true,
  output: { ok: true },
  storedAt: "2026-09-23T00:00:00.000Z"
})

let root: string

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-cli-contract-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

/** A CLI cache whose remote is the Worker handler, with no network between them. */
const openAgainst = (
  handler: (request: Request) => Promise<Response>,
  warnings: Array<string>,
  workspaceRoot = root
) =>
  openCache({
    workspaceRoot,
    endpoint,
    readToken: () => readCredential,
    writeToken: () => writeCredential,
    fetch: (input, init) => handler(new Request(input, init)),
    warn: (line) => warnings.push(line)
  })

describe("the CLI remote cache against the Worker", () => {
  it("publishes a result and reads it back from a fresh workspace", async () => {
    const actionCache = new MemoryActionCache()
    const handler = createHandler({
      actionCache,
      contentStore: new MemoryContentStore(),
      readTokenHash: hashOf(readCredential),
      writeTokenHash: hashOf(writeCredential)
    })
    const warnings: Array<string> = []
    const result = resultFor("a".repeat(64))

    const publisher = await openAgainst(handler, warnings)
    await publisher.put(result.key, result)
    await publisher.close()
    expect(warnings).toEqual([])
    expect(actionCache.entries.has(result.key)).toBe(true)

    const other = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-cli-contract-"))
    try {
      const reader = await openAgainst(handler, warnings, other)
      expect(await reader.get(result.key)).toEqual(result)
      await reader.close()
    } finally {
      await Fs.rm(other, { recursive: true, force: true })
    }
    expect(warnings).toEqual([])
  })

  it("serves the post-merge publisher's entry to every CI reader's key derivation (#2254)", async () => {
    const actionCache = new MemoryActionCache()
    const handler = createHandler({
      actionCache,
      contentStore: new MemoryContentStore(),
      readTokenHash: hashOf(readCredential),
      writeTokenHash: hashOf(writeCredential)
    })
    const warnings: Array<string> = []
    const result = resultFor("c".repeat(64))

    // The cache-publish job: both credentials, SMITHERS_CACHE_NAMESPACE unset.
    const publisher = await openCache({
      workspaceRoot: root,
      endpoint,
      readToken: () => readCredential,
      writeToken: () => writeCredential,
      publishNamespace: publishNamespaceFromEnvironment(undefined),
      fetch: (input, init) => handler(new Request(input, init)),
      warn: (line) => warnings.push(line)
    })
    await publisher.put(result.key, result)
    await publisher.close()
    expect(warnings).toEqual([])
    expect([...actionCache.entries.keys()]).toEqual([result.key])

    // A push to main renders the namespace empty; a pull request names its own.
    // Each holds only the read credential and reads the bare content key.
    for (const namespace of ["", "pr-2254"]) {
      const consumerRoot = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-cli-contract-"))
      try {
        const consumer = await openCache({
          workspaceRoot: consumerRoot,
          endpoint,
          readToken: () => readCredential,
          publishNamespace: publishNamespaceFromEnvironment(namespace),
          fetch: (input, init) => handler(new Request(input, init)),
          warn: (line) => warnings.push(line)
        })
        expect(await consumer.get(result.key)).toEqual(result)
        await consumer.close()
      } finally {
        await Fs.rm(consumerRoot, { recursive: true, force: true })
      }
    }
    expect(warnings).toEqual([])
  })

  it("keeps the remote enabled when publications exceed the isolate's admission ceiling", async () => {
    const release: Array<() => void> = []
    const actionCache = new MemoryActionCache()
    // Publications park inside the store, so every admission slot is held
    // when the next one arrives, exactly as a burst of finishing targets does.
    const parked = Object.assign(Object.create(actionCache) as MemoryActionCache, {
      put: async (key: string, publication: Parameters<MemoryActionCache["put"]>[1]) => {
        await new Promise<void>((resolve) => release.push(resolve))
        return actionCache.put(key, publication)
      }
    })
    const handler = createHandler({
      actionCache: parked,
      contentStore: new MemoryContentStore(),
      readTokenHash: hashOf(readCredential),
      writeTokenHash: hashOf(writeCredential)
    })
    const warnings: Array<string> = []
    const cache = await openAgainst(handler, warnings)
    const keys = Array.from({ length: maxConcurrentActionCachePublications + 1 }, (_, index) =>
      index.toString(16).padStart(64, "0"))

    const puts = keys.map((key) => cache.put(key, resultFor(key)))
    await expect.poll(() => release.length).toBe(maxConcurrentActionCachePublications)
    // The refused publication settles on its own while the others are parked.
    await expect.poll(() => warnings).toEqual(["smthrs: remote cache busy (HTTP 429); skipped one request"])
    for (const resume of release) resume()
    await Promise.all(puts)

    expect(actionCache.entries.size).toBe(maxConcurrentActionCachePublications)
    // A later read still reaches the remote.
    const published = keys.find((key) => actionCache.entries.has(key))!
    const reader = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-cli-contract-"))
    try {
      const fresh = await openAgainst(handler, warnings, reader)
      expect(await fresh.get(published)).toEqual(resultFor(published))
      await fresh.close()
    } finally {
      await Fs.rm(reader, { recursive: true, force: true })
    }
    await cache.close()
  })
})
