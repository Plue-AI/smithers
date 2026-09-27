/**
 * Issue #113: the production `settle` inlined every declared write's entire
 * content as base64 into `BoundaryEvidence.declaredOutputs`, persisted
 * verbatim into the attempt row meta and the shared cache entry and
 * round-tripped on every replay — a 50MB artifact multiplied ~67MB of
 * base64 into every row with no bound anywhere. Temporal enforces hard blob
 * size limits for exactly this reason.
 *
 * Outputs are now recorded by content digest: small outputs stay inline
 * under an explicit byte bound, larger ones are written to a
 * content-addressed object directory on the host and the row carries only
 * `{path, digest, sizeBytes}`. A replay that cannot resolve a referenced
 * blob refuses with `UnsupportedBoundary`, which the issue-#107 call sites
 * turn into a real execution instead of a failure.
 */
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as StepBoundary from "../src/StepBoundary.ts"
import { memoryFileSystem } from "./fixtures/MemoryFileSystem.ts"
import { hostPath } from "./HostPath.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * An in-memory host filesystem with directory-aware writes. It cannot address
 * the host at all, so it is attested isolated: replay confines its writes to
 * an attested or descriptor-relative host and refuses any other.
 */
const memoryFs = (seed?: Record<string, string>) => {
  const host = memoryFileSystem(seed)
  KernelFileSystem.withIsolatedFileSystem(host.fs)
  return host
}

/**
 * The blob mechanics moved to `@smthrs/artifacts`; the inline-versus-spill
 * budgets stayed here, so a boundary is now a policy over a store.
 */
type BoundaryOptions = StepBoundary.FileSystemOptions & { readonly objectsDirectory?: string }

const boundaryLayer = (fs: FileSystem.FileSystem, options?: BoundaryOptions) =>
  Layer.succeed(
    StepBoundary.StepBoundary,
    StepBoundary.makeFileSystem(
      fs,
      hostPath,
      ArtifactStore.makeFileSystem(fs, hostPath, {
        directory: options?.objectsDirectory,
        durability: "best-effort",
        coordination: "process"
      }),
      options
    )
  )

/** The two-hex fanout address `@smthrs/artifacts` publishes at. */
const blobPath = (directory: string, digest: string) => `${directory}/${digest.slice(0, 2)}/${digest}`

const descriptor: FileBoundary = {
  readSet: [{ path: "input.txt", digest: sha256("original") }],
  writeSet: ["artifact.bin"],
  boundaryMode: "hard"
}

const settleWithArtifact = (host: ReturnType<typeof memoryFs>, artifact: string, maxInlineBytes: number) =>
  Effect.gen(function*() {
    const boundary = yield* StepBoundary.StepBoundary
    const prepared = yield* boundary.prepare(descriptor)
    host.files.set("artifact.bin", encoder.encode(artifact))
    return yield* boundary.settle(prepared)
  }).pipe(
    Effect.provide(boundaryLayer(host.fs, { maxInlineBytes, objectsDirectory: ".objects" }))
  )

const outputsOf = (evidence: StepBoundary.BoundaryEvidence) =>
  (evidence.declaredOutputs as {
    readonly outputs: ReadonlyArray<{
      readonly path: string
      readonly digest: string | null
      readonly sizeBytes?: number
      readonly content?: string
    }>
  }).outputs

describe("materialized outputs are digest-referenced and bounded (issue #113)", () => {
  it.effect("an output over the inline bound is stored as a content-addressed blob, not inlined", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "input.txt": "original" })
      const artifact = "x".repeat(64)
      const evidence = yield* withCrypto(settleWithArtifact(host, artifact, 16))
      const [output] = outputsOf(evidence)
      expect(output!.digest).toBe(sha256(artifact))
      expect(output!.sizeBytes).toBe(64)
      // The row carries a reference, never the 64-byte payload.
      expect(output!.content).toBeUndefined()
      expect(JSON.stringify(evidence)).not.toContain("xxxxxxxx")
      // The payload lives in the host's content-addressed object directory.
      expect(decoder.decode(host.files.get(blobPath(".objects", sha256(artifact))))).toBe(artifact)
    }))

  it.effect("a small output stays inline under the bound and replays without the object store", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "input.txt": "original" })
      const evidence = yield* withCrypto(settleWithArtifact(host, "small", 16))
      const [output] = outputsOf(evidence)
      expect(output!.content).toBeDefined()
      // Inline evidence is self-contained: a fresh workspace with no object
      // directory still materializes it.
      const fresh = memoryFs({})
      yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          yield* boundary.replayOutputs(evidence)
        }).pipe(Effect.provide(boundaryLayer(fresh.fs, { maxInlineBytes: 16, objectsDirectory: ".objects" })))
      )
      expect(decoder.decode(fresh.files.get("artifact.bin"))).toBe("small")
    }))

  it.effect("replays a blob-referenced output from the object store on the same host", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "input.txt": "original" })
      const artifact = "y".repeat(64)
      const evidence = yield* withCrypto(settleWithArtifact(host, artifact, 16))
      // Wipe the workspace output; the object store survives.
      host.files.delete("artifact.bin")
      yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          yield* boundary.replayOutputs(evidence)
        }).pipe(Effect.provide(boundaryLayer(host.fs, { maxInlineBytes: 16, objectsDirectory: ".objects" })))
      )
      expect(decoder.decode(host.files.get("artifact.bin"))).toBe(artifact)
    }))

  it.effect("refuses the replay when a referenced blob is missing, instead of writing garbage", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "input.txt": "original" })
      const artifact = "z".repeat(64)
      const evidence = yield* withCrypto(settleWithArtifact(host, artifact, 16))
      // A different host that never ran the step has no object store: the
      // refusal routes the #107 call sites to a real execution.
      const fresh = memoryFs({})
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* Effect.flip(boundary.replayOutputs(evidence))
        }).pipe(Effect.provide(boundaryLayer(fresh.fs, { maxInlineBytes: 16, objectsDirectory: ".objects" })))
      )
      // A locally-missing artifact is its own typed refusal (issue #172): it is
      // the one replay failure a shared artifact tier can repair, so the
      // dispatch path fetches and retries before falling through to a real
      // execution. Every other host refusal stays `unsupported_boundary`.
      expect(failure).toMatchObject({ code: "missing_artifact" })
      expect(fresh.files.has("artifact.bin")).toBe(false)
    }))

  it.effect("undecodable inline content refuses rather than materializing garbage", () =>
    Effect.gen(function*() {
      const host = memoryFs({})
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* Effect.flip(boundary.replayOutputs({
            declaredOutputs: {
              outputs: [{ path: "artifact.bin", digest: sha256("real"), sizeBytes: 4, content: "%%%not-base64%%%" }]
            },
            diffIdentity: "corrupt"
          }))
        }).pipe(Effect.provide(boundaryLayer(host.fs)))
      )
      // Undecodable cache-origin bytes are corruption, not a host refusal
      // (issue #159): the caller routes this to the Inconsistency receiver.
      expect(failure).toMatchObject({ code: "boundary_corruption" })
    }))

  it.effect("a malformed digest reference refuses wholesale instead of degrading to a legacy row", () =>
    Effect.gen(function*() {
      const host = memoryFs({})
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          // The base64 is valid on purpose: a digest-carrying row whose address
          // fails the strict schema is foreign or tampered evidence, and it must
          // refuse rather than materialize inline bytes under a derived digest.
          return yield* Effect.flip(boundary.replayOutputs({
            declaredOutputs: {
              outputs: [{
                path: "artifact.bin",
                digest: "d",
                sizeBytes: 5,
                content: Encoding.encodeBase64(encoder.encode("small"))
              }]
            },
            diffIdentity: "malformed-address"
          }))
        }).pipe(Effect.provide(boundaryLayer(host.fs)))
      )
      expect(failure).toMatchObject({ code: "unsupported_boundary" })
      expect(host.files.has("artifact.bin")).toBe(false)
    }))
})

describe("an artifact store that refuses outright stays a retryable host refusal", () => {
  it.effect("classifies a store failure as unsupported_boundary, never as a missing artifact", () =>
    Effect.gen(function*() {
      // A store that refuses says nothing about the artifact — unlike a miss,
      // which a shared tier can repair, or a corruption, which routes to the
      // Inconsistency receiver. It stays the ordinary retryable refusal the
      // issue-#107 call sites already handle.
      const host = memoryFs({ "input.txt": "original" })
      const artifact = "r".repeat(64)
      const evidence = yield* withCrypto(settleWithArtifact(host, artifact, 16))
      // Force materialization: a verified destination now skips the store
      // entirely, while this cell exercises a store refusal that is consulted.
      host.files.delete("artifact.bin")
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* Effect.flip(boundary.replayOutputs(evidence))
        }).pipe(
          Effect.provide(
            Layer.succeed(
              StepBoundary.StepBoundary,
              StepBoundary.makeFileSystem(host.fs, hostPath, ArtifactStore.makeNoop(), { maxInlineBytes: 16 })
            )
          )
        )
      )
      expect(failure).toMatchObject({ code: "unsupported_boundary" })
      expect((failure as StepBoundary.UnsupportedBoundary).message).toContain("artifact store")
    }))
})

describe("the aggregate inline payload is bounded (issue #122)", () => {
  it.effect("spills outputs past maxTotalInlineBytes to the object store and still replays them", () =>
    Effect.gen(function*() {
      // Ten-byte outputs each fit the 16-byte per-output bound, but the third
      // would push the evidence's aggregate inline payload past the 24-byte
      // total bound — so it is spilled to the object directory and recorded by
      // digest reference only.
      const host = memoryFs({ "input.txt": "original" })
      const contents = ["a".repeat(10), "b".repeat(10), "c".repeat(10)]
      const options: BoundaryOptions = {
        maxInlineBytes: 16,
        maxTotalInlineBytes: 24,
        objectsDirectory: ".objects"
      }
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare({
            ...descriptor,
            writeSet: ["a.bin", "b.bin", "c.bin"]
          })
          host.files.set("a.bin", encoder.encode(contents[0]!))
          host.files.set("b.bin", encoder.encode(contents[1]!))
          host.files.set("c.bin", encoder.encode(contents[2]!))
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(boundaryLayer(host.fs, options)))
      )
      const outputs = outputsOf(evidence)
      expect(outputs[0]!.content).toBeDefined()
      expect(outputs[1]!.content).toBeDefined()
      // The later output carries a digest reference only, even though it
      // individually fits the per-output bound.
      expect(outputs[2]!.content).toBeUndefined()
      expect(outputs[2]!.digest).toBe(sha256(contents[2]!))
      expect(JSON.stringify(evidence)).not.toContain(Encoding.encodeBase64(encoder.encode(contents[2]!)))
      expect(host.files.has(blobPath(".objects", sha256(contents[2]!)))).toBe(true)
      // Replay round-trips the mixed inline/reference evidence.
      host.files.delete("a.bin")
      host.files.delete("b.bin")
      host.files.delete("c.bin")
      yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          yield* boundary.replayOutputs(evidence)
        }).pipe(Effect.provide(boundaryLayer(host.fs, options)))
      )
      expect(decoder.decode(host.files.get("a.bin"))).toBe(contents[0])
      expect(decoder.decode(host.files.get("b.bin"))).toBe(contents[1])
      expect(decoder.decode(host.files.get("c.bin"))).toBe(contents[2])
    }))
})

describe("blob writes are atomic and materialization is digest-verified (issue #117)", () => {
  const replay = (host: ReturnType<typeof memoryFs>, evidence: StepBoundary.BoundaryEvidence) =>
    Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      return yield* Effect.flip(boundary.replayOutputs(evidence))
    }).pipe(Effect.provide(boundaryLayer(host.fs, { maxInlineBytes: 16, objectsDirectory: ".objects" })))

  it.effect("refuses a corrupted blob at the canonical address instead of writing garbage", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "input.txt": "original" })
      const artifact = "c".repeat(64)
      const evidence = yield* withCrypto(settleWithArtifact(host, artifact, 16))
      // The blob at the canonical content address was truncated after settle
      // — a torn write, disk corruption, or a clobbered partial file.
      host.files.set(blobPath(".objects", sha256(artifact)), encoder.encode("truncated"))
      host.files.delete("artifact.bin")
      const failure = yield* withCrypto(replay(host, evidence))
      // A digest mismatch is corruption, not a transient host refusal
      // (issue #150): the distinct code is what routes it to the
      // Inconsistency receiver instead of the retryable fallback.
      expect(failure).toMatchObject({
        code: "boundary_corruption",
        path: "artifact.bin",
        recordedDigest: sha256(artifact)
      })
      expect(host.files.has("artifact.bin")).toBe(false)
    }))

  it.effect("refuses inline content whose bytes do not match the recorded digest", () =>
    Effect.gen(function*() {
      const host = memoryFs({})
      const failure = yield* withCrypto(replay(host, {
        declaredOutputs: {
          outputs: [{
            path: "artifact.bin",
            digest: sha256("real"),
            sizeBytes: 4,
            content: Encoding.encodeBase64(encoder.encode("fake"))
          }]
        },
        diffIdentity: "tampered"
      }))
      // Tampered inline content is the same integrity violation as a corrupt
      // blob (issue #150).
      expect(failure).toMatchObject({
        code: "boundary_corruption",
        path: "artifact.bin",
        recordedDigest: sha256("real"),
        measuredDigest: sha256("fake")
      })
      expect(host.files.has("artifact.bin")).toBe(false)
    }))

  it.effect("writes blobs via temp+rename and never rewrites an existing valid blob", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "input.txt": "original" })
      const artifact = "t".repeat(64)
      const address = blobPath(".objects", sha256(artifact))
      yield* withCrypto(settleWithArtifact(host, artifact, 16))
      // The canonical address is never the direct write target: the payload
      // lands at a temp path and is renamed into place, so a crash mid-write
      // can never leave a partial file at the content address.
      expect(host.writes).not.toContain(address)
      expect(host.renames).toHaveLength(1)
      expect(host.renames[0]![0]).toMatch(new RegExp(`^${address}\\.tmp-`))
      expect(host.renames[0]![1]).toBe(address)
      // No temp file survives the settle.
      expect([...host.files.keys()].filter((path) => path.includes(".tmp-"))).toHaveLength(0)
      // Content-addressed: a second settle of the same payload skips the write.
      yield* withCrypto(settleWithArtifact(host, artifact, 16))
      expect(host.writes.filter((path) => path.startsWith(`${address}.tmp-`))).toHaveLength(1)
      expect(host.renames).toHaveLength(1)
    }))
})
