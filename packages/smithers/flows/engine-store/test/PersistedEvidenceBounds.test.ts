/**
 * Issue #125: an end-to-end guard on the issue-#113 bound — a dispatch
 * through `ActionPersistence.make` under the REAL filesystem-backed
 * `StepBoundary` with an over-bound output must persist the digest
 * reference, never the payload, into the attempt row meta. The filesystem
 * boundary cannot observe the whole tree, so its evidence must not enter the
 * shared cache even when the declared output capture succeeds.
 */
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { memoryFileSystem } from "./fixtures/MemoryFileSystem.ts"
import { hostPath } from "./HostPath.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "evidence-bounds-host", pid: 59, nonce: "evidence-bounds-process" }
const encoder = new TextEncoder()

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () =>
      Effect.succeed({ commitId: "evidence-bounds-snapshot" as never, changeId: "evidence-bounds-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

/** An in-memory host filesystem covering everything the real boundary uses. */
const memoryFs = memoryFileSystem

describe("persisted evidence stays bounded through the real boundary (issue #125)", () => {
  it.effect("records bounded digest references without admitting the unverified boundary to cache", () =>
    Effect.gen(function*() {
      const runId = "evidence-bounds-run"
      const key = "evidence-bounds/over-inline"
      const keyDigest = sha256(key)
      // 4 KiB output against a 16-byte inline bound: the payload must never
      // reach a persisted row.
      const artifact = "x".repeat(4096)
      const artifactDigest = sha256(artifact)
      const host = memoryFs({ "input.txt": "original" })
      const metadata: ActionPersistence.BoundaryMetadata = {
        readSet: [{ path: "input.txt", digest: sha256("original") }],
        writeSet: ["artifact.bin"],
        boundaryMode: "hard"
      }
      const boundaryLayer = Layer.succeed(
        StepBoundary.StepBoundary,
        StepBoundary.makeFileSystem(
          host.fs,
          hostPath,
          ArtifactStore.makeFileSystem(host.fs, hostPath, {
            directory: ".objects",
            durability: "best-effort",
            coordination: "process"
          }),
          { maxInlineBytes: 16 }
        )
      )
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const attempts = yield* AttemptStore.AttemptStore
          const cache = yield* CacheStore.CacheStore
          yield* activate(runId)
          const result = yield* ActionPersistence.make({
            runId,
            owner,
            sourceId: "evidence-bounds",
            execute: () =>
              Effect.sync(() => {
                host.files.set("artifact.bin", encoder.encode(artifact))
                return "done"
              })
          })({ action: {}, attempt: 1, key, tier: "sealed", metadata }).pipe(Effect.provide(boundaryLayer))
          const entry = yield* cache.get(keyDigest)
          const row = yield* attempts.get({ runId, stepKeyDigest: keyDigest, attempt: 1 })
          return { result, entry, row }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.result).toBe("done")
      expect(Option.isNone(outcome.entry)).toBe(true)
      expect(Option.isSome(outcome.row)).toBe(true)
      const outputsOf = (meta: unknown) =>
        (meta as {
          readonly boundary: {
            readonly declaredOutputs: {
              readonly outputs: ReadonlyArray<{
                readonly path: string
                readonly digest: string | null
                readonly content?: string
              }>
            }
          }
        }).boundary.declaredOutputs.outputs
      const meta = Option.getOrThrow(outcome.row).meta
      const [output] = outputsOf(meta)
      // The digest reference is persisted; the payload is not.
      expect(output!.digest).toBe(artifactDigest)
      expect(output!.content).toBeUndefined()
      expect(JSON.stringify(meta)).not.toContain("xxxxxxxx")
      // The stated bound: a persisted meta row stays under 2 KiB even though
      // the output was 4 KiB.
      expect(JSON.stringify(meta).length).toBeLessThan(2048)
      // The payload itself lives in the content-addressed object directory.
      expect(host.files.has(`.objects/${artifactDigest.slice(0, 2)}/${artifactDigest}`)).toBe(true)
    }))
})
