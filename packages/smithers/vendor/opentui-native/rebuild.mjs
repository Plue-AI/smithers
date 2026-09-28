/** Explicit maintainer build; installation never invokes this program. */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import manifest from "./manifest.json" with { type: "json" }

const { values } = parseArgs({ options: {
  out: { type: "string" },
  target: { type: "string", default: "all" },
  zig: { type: "string", default: "zig" },
  sdk: { type: "string" },
  "source-archive": { type: "string" }
} })
if (!values.out) throw new Error("Pass --out to a dedicated artifact directory")
const root = dirname(fileURLToPath(import.meta.url))
const out = resolve(values.out)
const selected = values.target === "all" ? Object.keys(manifest.targets) : [values.target]
for (const name of selected) if (!manifest.targets[name]) throw new Error(`Unsupported target: ${name}`)
const run = (command, args, cwd, capture = false) => {
  const result = spawnSync(command, args, { cwd, stdio: capture ? "pipe" : "inherit", encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}): ${result.stderr ?? ""}`)
  return result.stdout?.trim()
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const zig = values.zig.includes("/") || values.zig.includes("\\") ? resolve(values.zig) :
  (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, values.zig)).find(existsSync)
if (!zig) throw new Error("Pinned Zig executable not found")
if (`${process.platform}-${process.arch}` === manifest.zig.host && hash(readFileSync(zig)) !== manifest.zig.binarySha256) {
  throw new Error("Zig executable does not match the recorded toolchain digest")
}
if (run(zig, ["version"], root, true) !== manifest.zig.version) {
  throw new Error(`The native build requires Zig ${manifest.zig.version}`)
}
if (selected.some((name) => name.startsWith("darwin-"))) {
  if (!values.sdk) throw new Error("Pass --sdk pointing to the pinned macOS SDK")
  if (hash(readFileSync(join(resolve(values.sdk), "SDKSettings.json"))) !== manifest.macosSdk.settingsSha256) {
    throw new Error(`The native build requires the recorded macOS ${manifest.macosSdk.version} SDK`)
  }
}
const patch = readFileSync(join(root, "native.patch"))
if (hash(patch) !== manifest.patchSha256) throw new Error("Source patch digest mismatch")
const bytes = values["source-archive"]
  ? readFileSync(resolve(values["source-archive"]))
  : Buffer.from(await (async () => {
    const response = await fetch(manifest.upstream.url)
    if (!response.ok) throw new Error(`OpenTUI download failed: ${response.status}`)
    return response.arrayBuffer()
  })())
if (hash(bytes) !== manifest.upstream.sha256) throw new Error("Upstream source archive digest mismatch")
const work = mkdtempSync(join(tmpdir(), "smithers-opentui-build-"))
const archive = join(work, "source.tar.gz")
const source = join(work, "source")
mkdirSync(source)
writeFileSync(archive, bytes)
run("tar", ["-xzf", archive, "--strip-components=1", "-C", source], work)
run("git", ["apply", "--check", join(root, "native.patch")], source)
run("git", ["apply", join(root, "native.patch")], source)
const native = join(source, "packages/native")
if (hash(readFileSync(join(native, "src/vendor/zig-deps.tar.gz"))) !== manifest.vendorSha256) {
  throw new Error("Vendored Zig dependency archive digest mismatch")
}
run("sh", ["scripts/prepare-zig-deps.sh"], native)
const built = {}
// Serialize platform builds and bound compiler jobs on shared development hosts.
for (const name of selected) {
  const target = manifest.targets[name]
  run(zig, ["build", "-Doptimize=ReleaseFast", "-Dstrip-native=true", "-j2",
    `-Dlibrary-target=${target.zigTarget}`, ...(values.sdk ? [`-Dmacos-sdk=${resolve(values.sdk)}`] : [])], native)
  const destination = join(out, name, target.file)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(join(native, "lib", target.output, target.file), destination)
  const sha256 = hash(readFileSync(destination))
  if (target.sha256 && sha256 !== target.sha256) throw new Error(`Rebuilt artifact digest differs: ${name}`)
  built[name] = { ...target, sha256 }
  console.log(JSON.stringify({ target: name, ...built[name] }))
}
writeFileSync(join(out, "build-receipt.json"), JSON.stringify({
  source: manifest.upstream, patchSha256: manifest.patchSha256,
  vendorSha256: manifest.vendorSha256, zig: manifest.zig.version,
  optimization: manifest.optimization, stripNative: true,
  sourceDirectory: source, sdk: values.sdk ?? null, artifacts: built
}, null, 2) + "\n")
console.log(`Retained source and build outputs under ${work}`)
