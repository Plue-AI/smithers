import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { resolveRuntimeBridgeIdentity } from "../coding/runtime-bridge.ts"

test("coding host starts without a runtime bridge binding, as Plue launches it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "coding-runtime-bridge-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const artifact = join(dir, "host.mjs")
  await writeFile(artifact, "packaged host bytes")
  assert.equal(await resolveRuntimeBridgeIdentity(artifact, {}), undefined)
})

test("a complete runtime bridge binding verifies the packaged host and rejects partial or stale identity", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "coding-runtime-bridge-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const artifact = join(dir, "host.mjs")
  const bytes = "packaged host bytes"
  await writeFile(artifact, bytes)
  const digest = createHash("sha256").update(bytes).digest("hex")
  const binding = {
    SMITHERS_FLOW_ARTIFACT_SHA256: digest,
    SMITHERS_SOURCE_REVISION: "a".repeat(40),
    SMITHERS_OWNER_GENERATION: "7"
  }
  assert.deepEqual(await resolveRuntimeBridgeIdentity(artifact, binding), {
    runtimeArtifactDigest: digest,
    runtimeSourceRevision: binding.SMITHERS_SOURCE_REVISION,
    ownerGeneration: 7
  })
  await assert.rejects(
    resolveRuntimeBridgeIdentity(artifact, { SMITHERS_FLOW_ARTIFACT_SHA256: digest }),
    /SMITHERS_SOURCE_REVISION/
  )
  await assert.rejects(
    resolveRuntimeBridgeIdentity(artifact, { SMITHERS_FLOW_ARTIFACT_SHA256: "" }),
    /SMITHERS_FLOW_ARTIFACT_SHA256/
  )
  await assert.rejects(
    resolveRuntimeBridgeIdentity(artifact, { ...binding, SMITHERS_FLOW_ARTIFACT_SHA256: "0".repeat(64) }),
    /SMITHERS_FLOW_ARTIFACT_SHA256/
  )
  await assert.rejects(
    resolveRuntimeBridgeIdentity(artifact, { ...binding, SMITHERS_OWNER_GENERATION: "0" }),
    /SMITHERS_OWNER_GENERATION/
  )
})
