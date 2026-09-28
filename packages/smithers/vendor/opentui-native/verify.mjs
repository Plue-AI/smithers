import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import manifest from "./manifest.json" with { type: "json" }

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
export const verifyNativeArtifacts = () => {
  if (digest(readFileSync(new URL("./native.patch", import.meta.url))) !== manifest.patchSha256) {
    throw new Error("OpenTUI native source patch does not match its manifest")
  }
  for (const [target, artifact] of Object.entries(manifest.targets)) {
    const path = new URL(`./${target}/${artifact.file}`, import.meta.url)
    if (digest(readFileSync(path)) !== artifact.sha256) {
      throw new Error(`Corrected OpenTUI native artifact does not match its manifest: ${target}`)
    }
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) verifyNativeArtifacts()
