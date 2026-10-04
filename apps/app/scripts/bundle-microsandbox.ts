import { createHash } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { foreignLibraries } from "./system-linkage"

const version = "0.6.16"
const integrity = "ZfiOPxBEPh+ihOFmK5hYWzCe+SmDdiiYMO760duRRVz/YhGiarGkQKbBZhofGIZdxw7549dTZyZ/IvE43Vzwzg=="
const image = "node@sha256:71fed097c6e5bae40e1aff698793dda483e2380cc2530d7367a72a9d037c798b"
const run = (argv: string[]): string => {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${new TextDecoder().decode(result.stderr)}`)
  return new TextDecoder().decode(result.stdout).trim()
}
export const validateMicrosandboxBinary = (binary: string): void => {
  if (run([binary, "--version"]) !== `msb ${version}`) throw new Error(`Microsandbox must be ${version}`)
  if (foreignLibraries(binary).length > 0) throw new Error("Microsandbox loads foreign libraries")
}
// No historical stage packages the microVM runtime or its offline image.
export const bundleMicrosandbox = async (root: string, bundle: string): Promise<void> => {
  if (!readFileSync(join(root, "packages/backend/microsandbox/cli.go"), "utf8").includes(`RequiredVersion = "${version}"`) ||
      !readFileSync(join(root, "packages/backend/microsandbox/runtime.go"), "utf8").includes(`DefaultImage = "${image}"`)) throw new Error("Microsandbox pins differ from backend")
  const work = mkdtempSync(join(tmpdir(), "smithers-msb-"))
  try {
    const response = await fetch(`https://registry.npmjs.org/@superradcompany/microsandbox-darwin-arm64/-/microsandbox-darwin-arm64-${version}.tgz`)
    if (!response.ok) throw new Error(`Microsandbox download: ${response.status}`)
    const archive = new Uint8Array(await response.arrayBuffer())
    if (createHash("sha512").update(archive).digest("base64") !== integrity) throw new Error("Microsandbox package integrity mismatch")
    writeFileSync(join(work, "msb.tgz"), archive)
    run(["tar", "xzf", join(work, "msb.tgz"), "-C", work])
    const binary = join(work, "package/bin/msb")
    validateMicrosandboxBinary(binary)
    mkdirSync(join(bundle, "lib"), { recursive: true })
    cpSync(binary, join(bundle, "bin/msb"))
    cpSync(join(work, "package/lib/libkrunfw.5.dylib"), join(bundle, "lib/libkrunfw.5.dylib"))
    const share = join(bundle, "share/microsandbox")
    mkdirSync(share, { recursive: true })
    cpSync(join(root, "packages/backend/microsandbox/guest/smithers-guest.py"), join(share, "smithers-guest.py"))
    run(["skopeo", "copy", "--override-os", "linux", "--override-arch", "arm64", "--preserve-digests", `docker://docker.io/library/${image}`, `oci-archive:${join(share, "base-image.oci.tar")}`])
    writeFileSync(join(share, "base-image.json"), JSON.stringify({ version: 1, image, platform: "linux-arm64", archive: "base-image.oci.tar" }, null, 2) + "\n")
  } finally { rmSync(work, { recursive: true, force: true }) }
}
