import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

export type RuntimeBridgeIdentity = {
  readonly runtimeArtifactDigest: string
  readonly runtimeSourceRevision: string
  readonly ownerGeneration: number
}

export const resolveRuntimeBridgeIdentity = async (
  artifactPath: string,
  environment: Readonly<Record<string, string | undefined>>
): Promise<RuntimeBridgeIdentity | undefined> => {
  const expectedArtifactDigest = environment.SMITHERS_FLOW_ARTIFACT_SHA256 ?? ""
  const runtimeSourceRevision = environment.SMITHERS_SOURCE_REVISION ?? ""
  const ownerGenerationText = environment.SMITHERS_OWNER_GENERATION ?? ""
  // Plue's workspace gateway uses this host without the Go flow-runtime bridge.
  // An operator that starts to bind the bridge must provide its whole identity.
  if (
    ["SMITHERS_FLOW_ARTIFACT_SHA256", "SMITHERS_SOURCE_REVISION", "SMITHERS_OWNER_GENERATION"]
      .every((name) => environment[name] === undefined)
  ) return undefined
  if (!expectedArtifactDigest) throw new Error("SMITHERS_FLOW_ARTIFACT_SHA256 is required for the runtime bridge")
  const runtimeArtifactDigest = createHash("sha256").update(await readFile(artifactPath)).digest("hex")
  if (expectedArtifactDigest !== runtimeArtifactDigest) {
    throw new Error("SMITHERS_FLOW_ARTIFACT_SHA256 does not match the packaged host")
  }
  if (!/^[0-9a-f]{40}$/.test(runtimeSourceRevision)) {
    throw new Error("SMITHERS_SOURCE_REVISION must be an immutable 40-character revision")
  }
  const ownerGeneration = Number(ownerGenerationText)
  if (!Number.isSafeInteger(ownerGeneration) || ownerGeneration <= 0) {
    throw new Error("SMITHERS_OWNER_GENERATION must be a positive safe integer")
  }
  return { runtimeArtifactDigest, runtimeSourceRevision, ownerGeneration }
}
