// @ts-check
/** Relocatable installers built from the exact npm candidate, signed only at its release tag. */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { candidateIntegrity, verifyLocalCandidate } from "./publish-release.mjs"
import { captureProcess } from "./release-process.mjs"
import { releaseRegistry } from "./release-registry.mjs"
import { isMain } from "./workspace-packages.mjs"

const issuer = "https://token.actions.githubusercontent.com"
const workflow = "smithersai/smithers/.github/workflows/release.yml"
const platforms = [["darwin", "arm64"], ["darwin", "x64"], ["linux", "arm64"], ["linux", "x64"]]
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const versionOf = (tag) => {
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(tag)) throw new Error("Invalid installer release tag")
  return tag.slice(1)
}

export const archiveName = (tag, platform, arch) => {
  versionOf(tag)
  if (!platforms.some(([os, cpu]) => os === platform && cpu === arch)) throw new Error("Unsupported installer platform")
  return `smithers-${tag}-${platform}-${arch === "x64" ? "amd64" : arch}.tar.gz`
}

const launcher = `#!/bin/sh
set -eu
# Resolve the installer's atomic symlink without depending on a system Node.
script=$0
while [ -L "$script" ]; do
  directory=$(CDPATH= cd -P -- "$(dirname -- "$script")" && pwd)
  target=$(readlink "$script")
  case "$target" in /*) script=$target ;; *) script=$directory/$target ;; esac
done
directory=$(CDPATH= cd -P -- "$(dirname -- "$script")" && pwd)
exec "$directory/runtime/node" "$directory/node_modules/@smthrs/cli/bin/smithers.mjs" "$@"
`

/** Build and execute on the target OS/CPU; cross-compilation cannot earn a consumer receipt. */
export const packInstaller = async ({ packDirectory, outputDirectory, tag }) => {
  packDirectory = resolve(packDirectory)
  outputDirectory = resolve(outputDirectory)
  const version = versionOf(tag)
  const archive = archiveName(tag, process.platform, process.arch)
  const candidate = JSON.parse(await readFile(join(packDirectory, "release-manifest.json"), "utf8"))
  await verifyLocalCandidate(packDirectory, candidate)
  const evidence = JSON.parse(await readFile(join(packDirectory, "smoke-evidence.json"), "utf8"))
  if (candidate.source.tag !== tag || candidate.source.dirty !== false || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidate.source.sha)
    || candidate.packages.some((entry) => entry.version !== version)
    || evidence.schemaVersion !== 1 || evidence.status !== "passed" || evidence.candidateIntegrity !== candidateIntegrity(candidate)) {
    throw new Error("Installer requires the clean tagged candidate and matching successful smoke evidence")
  }
  if (!candidate.packages.some((entry) => entry.name === "@smthrs/cli")) throw new Error("Candidate has no npm CLI")
  const temporary = await mkdtemp(join(tmpdir(), "smithers-installer-"))
  const registry = await releaseRegistry(packDirectory, candidate.packages)
  try {
    const tree = join(temporary, "tree")
    await mkdir(join(tree, "runtime"), { recursive: true })
    await writeFile(join(tree, "package.json"), JSON.stringify({ private: true, dependencies: { "@smthrs/cli": version } }))
    await writeFile(join(tree, ".npmrc"), `@smthrs:registry=${registry.url}\n`)
    // No dependency lifecycle code executes on a release runner. The public
    // packages ship their native helpers; the extracted consumer tests them.
    const installed = await captureProcess("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--strict-peer-deps"], tree, { timeoutMs: 600_000 })
    if (!installed.ok) throw new Error(`Installer npm install failed: ${installed.output}`)
    await copyFile(process.execPath, join(tree, "runtime/node"))
    await chmod(join(tree, "runtime/node"), 0o755)
    await writeFile(join(tree, "smithers"), launcher, { mode: 0o755 })
    await mkdir(outputDirectory, { recursive: true })
    const archivePath = join(temporary, archive)
    const ownership = process.platform === "darwin" ? ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"] : ["--owner=0", "--group=0", "--numeric-owner"]
    execFileSync("tar", [...ownership, "-cf", archivePath.slice(0, -3), "-C", tree, "smithers", "runtime", "node_modules"], { env: { ...process.env, COPYFILE_DISABLE: "1" } })
    execFileSync("gzip", ["-1", archivePath.slice(0, -3)])
    // Relocate before probing so a launcher accidentally tied to its build
    // directory cannot pass. Probes execute the bundled runtime and npm bin.
    const consumer = join(temporary, "installed consumer")
    await mkdir(consumer)
    execFileSync("tar", ["-xzf", archivePath, "-C", consumer])
    await rm(tree, { recursive: true, force: true })
    for (const argument of ["--version", "--help"]) {
      const result = await captureProcess(join(consumer, "smithers"), [argument], consumer)
      if (!result.ok || !result.output.trim() || (argument === "--version" && !result.output.includes(version))) {
        throw new Error(`Extracted installer ${argument} failed: ${result.output}`)
      }
    }
    for (const args of [["init", "release-smoke", "--json"], ["targets", "--json"], ["flow", "list", "--json"]]) {
      const result = await captureProcess(join(consumer, "smithers"), args, consumer)
      if (!result.ok) throw new Error(`Extracted installer ${args.join(" ")} failed: ${result.output}`)
    }
    await verifyLocalCandidate(packDirectory, candidate)
    await copyFile(archivePath, join(outputDirectory, archive))
    await writeFile(join(outputDirectory, `${archive}.json`), JSON.stringify({
      schemaVersion: 1, status: "passed", archive, sha256: sha256(await readFile(archivePath)),
      candidateIntegrity: candidateIntegrity(candidate), source: candidate.source,
      platform: process.platform, arch: process.arch, version,
      node: process.version, probes: ["--version", "--help", "init release-smoke --json", "targets --json", "flow list --json"], completedAt: new Date().toISOString()
    }, null, 2) + "\n")
    return archive
  } finally {
    await registry.close()
    await rm(temporary, { recursive: true, force: true })
  }
}

const releaseChecksums = async (directory, tag) => {
  versionOf(tag)
  const names = platforms.map(([os, arch]) => archiveName(tag, os, arch)).sort()
  const actual = (await readdir(directory)).filter((name) => name.endsWith(".tar.gz")).sort()
  if (JSON.stringify(actual) !== JSON.stringify(names)) throw new Error("Installer release requires exactly four platform archives")
  let candidate
  let source
  const lines = []
  for (const name of names) {
    if (!(await lstat(join(directory, name))).isFile()) throw new Error("Installer archive must be a regular file")
    const digest = sha256(await readFile(join(directory, name)))
    const receipt = JSON.parse(await readFile(join(directory, `${name}.json`), "utf8"))
    if (receipt.schemaVersion !== 1 || receipt.status !== "passed" || receipt.archive !== name || receipt.sha256 !== digest
      || receipt.version !== versionOf(tag) || receipt.source?.tag !== tag || receipt.source?.dirty !== false
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(receipt.source?.sha) || typeof receipt.candidateIntegrity !== "string" || !receipt.candidateIntegrity
      || archiveName(tag, receipt.platform, receipt.arch) !== name) throw new Error(`Invalid installer consumer receipt: ${name}`)
    candidate ??= receipt.candidateIntegrity
    source ??= receipt.source.sha
    if (candidate !== receipt.candidateIntegrity || source !== receipt.source.sha) throw new Error("Installer archives came from different candidates")
    lines.push(`${digest}  ${name}\n`)
  }
  return { sums: lines.join(""), source, candidate }
}

export const verifyInstallerRelease = async ({ directory, tag, run = execFileSync }) => {
  const { sums } = await releaseChecksums(directory, tag)
  if (await readFile(join(directory, "SHA256SUMS"), "utf8") !== sums) throw new Error("Installer checksum mismatch")
  run("cosign", ["verify-blob", "--bundle", "SHA256SUMS.sigstore.json", "--certificate-oidc-issuer", issuer,
    "--certificate-identity", `https://github.com/${workflow}@refs/tags/${tag}`, "SHA256SUMS"], { cwd: directory, stdio: "inherit" })
}

export const signInstallerRelease = async ({ directory, tag, env = process.env, run = execFileSync }) => {
  versionOf(tag)
  if (env.GITHUB_REPOSITORY !== "smithersai/smithers" || env.GITHUB_REF !== `refs/tags/${tag}`
    || env.GITHUB_WORKFLOW_REF !== `${workflow}@refs/tags/${tag}`) throw new Error("Installer signing requires the exact release workflow/tag identity")
  const { sums, source, candidate } = await releaseChecksums(directory, tag)
  if (env.INSTALLER_SOURCE_SHA !== source) throw new Error("Installer candidate source differs from release tag")
  if (env.INSTALLER_CANDIDATE_INTEGRITY !== candidate) throw new Error("Installer receipts differ from tested npm candidate")
  await writeFile(join(directory, "SHA256SUMS"), sums)
  run("cosign", ["sign-blob", "--yes", "--bundle", "SHA256SUMS.sigstore.json", "SHA256SUMS"], { cwd: directory, stdio: "inherit" })
  await verifyInstallerRelease({ directory, tag, run })
}

/** Publish only a verified set. Refuse overwriting an existing version; latest is the final write. */
export const publishInstallerRelease = async ({ directory, tag, env = process.env, run = execFileSync }) => {
  const bucket = env.INSTALLER_BUCKET
  const endpoint = env.INSTALLER_S3_ENDPOINT
  if (!bucket || !/^[a-z0-9][a-z0-9.-]+$/.test(bucket) || !endpoint || new URL(endpoint).protocol !== "https:") throw new Error("Installer bucket and HTTPS S3 endpoint are required")
  await verifyInstallerRelease({ directory, tag, run })
  const aws = (args, capture = false) => run("aws", ["--endpoint-url", endpoint, ...args], { cwd: directory, ...(capture ? { encoding: "utf8" } : { stdio: "inherit" }) })
  const existing = JSON.parse(String(aws(["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", `${tag}/`, "--max-keys", "1", "--output", "json"], true)))
  if ((existing.KeyCount ?? 0) !== 0) throw new Error("Installer release prefix already exists; never overwrite a signed version")
  const names = platforms.map(([os, arch]) => archiveName(tag, os, arch)).sort()
  for (const name of [...names, ...names.map((name) => `${name}.json`), "SHA256SUMS", "SHA256SUMS.sigstore.json"]) {
    aws(["s3", "cp", name, `s3://${bucket}/${tag}/${name}`, "--only-show-errors"])
  }
  if (tag.includes("-")) return
  // The workflow serializes this read/compare/write across all release tags.
  let latest
  try {
    latest = String(aws(["s3", "cp", `s3://${bucket}/latest.txt`, "-", "--only-show-errors"], true)).trim()
  } catch (error) {
    if (!/\(404\)|\(NoSuchKey\)/.test(String(error.stderr ?? ""))) throw error
  }
  if (latest !== undefined) {
    versionOf(latest)
    if (latest.includes("-")) throw new Error("Latest must identify a stable release")
    const previous = latest.slice(1).split(".").map(BigInt)
    const next = tag.slice(1).split(".").map(BigInt)
    const difference = next.findIndex((part, index) => part !== previous[index])
    if (difference === -1 || next[difference] < previous[difference]) return
  }
  await writeFile(join(directory, "latest.txt"), `${tag}\n`)
  aws(["s3", "cp", "latest.txt", `s3://${bucket}/latest.txt`, "--cache-control", "no-store", "--only-show-errors"])
}

if (isMain(import.meta)) {
  const [command, directory, tag, outputDirectory] = process.argv.slice(2)
  if (command === "pack") await packInstaller({ packDirectory: directory, outputDirectory, tag })
  else if (command === "sign") await signInstallerRelease({ directory, tag })
  else if (command === "verify") await verifyInstallerRelease({ directory, tag })
  else if (command === "publish") await publishInstallerRelease({ directory, tag })
  else throw new Error("Usage: installer-release.mjs pack <candidate> <tag> <output> | sign|verify|publish <directory> <tag>")
}
