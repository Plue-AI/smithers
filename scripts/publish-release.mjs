/** Publish only the exact tarballs validated by the release manifest. */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

import { isMain } from "./workspace-packages.mjs"

export const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`

export const candidateIntegrity = (candidate) => integrity(Buffer.from(JSON.stringify(candidate)))

/** Seconds between registry attempts, shared by transient failures and post-publish reads. */
const retryDelays = [10, 30, 60]

/** Record the relative release date without treating a clock or a build as shipment.
 * The Mac lifecycle and authenticated artifact receipt providers are not mounted
 * in this publisher yet (T-INS-07 / T-MNT-05). Keep stage M dark until they are.
 * Reuse this publisher rather than creating a second maintainer release path.
 */
export const maintainerReleasePlan = (candidate) => {
  const release = candidate.maintainerRelease
  if (!release || typeof release !== "object") throw new Error("Maintainer release record is required")
  const utc = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)) throw new Error("Release dates must be recorded in UTC")
    const time = Date.parse(value)
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error("Invalid release date")
    return time
  }
  const launch = utc(release.launchUtc)
  const targetReleaseUtc = new Date(launch + 604800000).toISOString()
  if (release.targetReleaseUtc !== targetReleaseUtc) throw new Error("Maintainer target must be launch UTC plus seven calendar days")
  if (typeof release.launchVersion !== "string" || !release.launchVersion.trim() || release.launchVersion === candidate.source?.tag?.replace(/^v/, "")) throw new Error("Distinct launch and maintainer versions are required")
  // Availability is an observation, never inferred from the requested date.
  if (release.availableUtc !== null && release.availableUtc !== undefined) {
    const available = utc(release.availableUtc)
    if (available < launch + 604800000 || available >= launch + 691200000) throw new Error("Artifact availability must be on UTC day seven")
  }
  return { launchUtc: release.launchUtc, targetReleaseUtc, availableUtc: release.availableUtc ?? null,
    launchVersion: release.launchVersion, releaseVersion: candidate.source?.tag?.replace(/^v/, ""),
    requiredChecks: ["C-MNT-01", "C-MNT-02", "C-MNT-03", "C-MNT-04", "C-MNT-05", "C-MNT-06", "C-REL-03", "C-SEC-02", "C-SEC-03", "C-COL-04", "C-MCH-06"],
    state: "blocked" }
}

const requireReleaseProviders = (candidate) => {
  if (candidate.releaseStage !== undefined && !["launch", "M"].includes(candidate.releaseStage)) throw new Error("Unknown release stage")
  if (candidate.releaseStage === "M" || Object.hasOwn(candidate, "maintainerRelease")) {
    if (candidate.releaseStage !== "M") throw new Error("Maintainer release must declare stage M")
    maintainerReleasePlan(candidate)
    // Caller-written check links or passed markers cannot authorize publication.
    // No alternate publisher, root step, timer unlock or receipt bypass is added.
    throw new Error("Maintainer publication disabled: authenticated Mac upgrade, dependency, security, docs and artifact journey receipts are unavailable (T-MNT-05)")
  }
}

/** The manifest, legacy pack roster and every local artifact must describe the same train. */
export const verifyLocalCandidate = async (directory, candidate) => {
  if (candidate?.schemaVersion !== 1 || !Array.isArray(candidate.packages) || candidate.packages.length === 0 || !candidate.source) throw new Error("Invalid release manifest")
  const roster = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))
  if (JSON.stringify(roster) !== JSON.stringify(candidate.packages)) throw new Error("Release manifest does not match the smoke-test package roster")
  const names = new Set()
  const filenames = new Set()
  for (const entry of candidate.packages) {
    if (typeof entry.name !== "string" || entry.name.length === 0 || names.has(entry.name) || typeof entry.filename !== "string" || !entry.filename.endsWith(".tgz") || entry.filename.includes("\\") || basename(entry.filename) !== entry.filename || filenames.has(entry.filename)) throw new Error(`Invalid release entry: ${entry.name}`)
    names.add(entry.name)
    filenames.add(entry.filename)
    if (integrity(await readFile(join(directory, entry.filename))) !== entry.integrity) throw new Error(`Local tarball integrity mismatch: ${entry.name}`)
  }
  const tarballs = (await readdir(directory)).filter((name) => name.endsWith(".tgz")).sort()
  if (JSON.stringify(tarballs) !== JSON.stringify([...filenames].sort())) throw new Error("Release archive contains tarballs outside the tested roster")
}

/** Called only after every installed-consumer probe succeeds; changes during testing invalidate it. */
export const recordSmokeSuccess = async (directory, candidate) => {
  const current = JSON.parse(await readFile(join(directory, "release-manifest.json"), "utf8"))
  if (candidateIntegrity(current) !== candidateIntegrity(candidate)) throw new Error("Release manifest changed during smoke testing")
  await verifyLocalCandidate(directory, candidate)
  await writeFile(join(directory, "smoke-evidence.json"), JSON.stringify({
    schemaVersion: 1,
    status: "passed",
    candidateIntegrity: candidateIntegrity(candidate),
    command: "node scripts/smoke-release.mjs <pack-directory>",
    toolchain: { node: process.version, platform: process.platform, arch: process.arch },
    completedAt: new Date().toISOString()
  }, null, 2) + "\n")
}

/** Preflight the whole train before any publish: an existing mismatch refuses all missing packages. */
export const preflight = async (directory, candidate, { sourceSha, releaseTag, readRegistry }) => {
  requireReleaseProviders(candidate)
  await verifyLocalCandidate(directory, candidate)
  if (candidate.source.sha !== sourceSha || candidate.source.tag !== releaseTag || candidate.source.dirty !== false) throw new Error("Release source/tag does not match the clean tested candidate")
  const evidence = JSON.parse(await readFile(join(directory, "smoke-evidence.json"), "utf8"))
  if (evidence.schemaVersion !== 1 || evidence.status !== "passed" || evidence.candidateIntegrity !== candidateIntegrity(candidate)) throw new Error("Release candidate has no matching successful smoke evidence")
  const pending = []
  for (const entry of candidate.packages) {
    if (entry.version !== releaseTag.replace(/^v/, "")) throw new Error(`Invalid release entry: ${entry.name}`)
    const existing = await readRegistry(`${entry.name}@${entry.version}`)
    if (existing === undefined) pending.push(entry)
    else if (existing !== entry.integrity) throw new Error(`Registry integrity mismatch or unavailable: ${entry.name}`)
  }
  return pending
}

export const publishCandidate = async (directory, candidate, options) => {
  const pending = await preflight(directory, candidate, options)
  const published = []
  for (const entry of pending) {
    // A predecessor's publication may take minutes. Recheck the next local bytes
    // instead of relying on the earlier train preflight across that interval.
    if (integrity(await readFile(join(directory, entry.filename))) !== entry.integrity) throw new Error(`Local tarball integrity mismatch: ${entry.name}`)
    await options.publish(join(directory, entry.filename), entry)
    // The registry can accept a tarball before it serves the version. Only an
    // absent version waits; different bytes fail at once.
    let observed = await options.readRegistry(`${entry.name}@${entry.version}`)
    for (const delay of retryDelays) {
      if (observed !== undefined) break
      await options.pause?.(delay)
      observed = await options.readRegistry(`${entry.name}@${entry.version}`)
    }
    if (observed !== entry.integrity) throw new Error(`Published integrity could not be verified: ${entry.name}`)
    published.push(entry.name)
    await writeFile(join(directory, "publish-receipt.json"), JSON.stringify({ schemaVersion: 1, source: candidate.source, published }, null, 2) + "\n")
    if (published.length < pending.length) await options.pause?.(2)
  }
  return published
}

/** Keep registry throttling and detached-tag publication behind the verified candidate boundary. */
export const registryPublisher = ({ run = execFileSync, pause = (seconds) => execFileSync("sleep", [String(seconds)]) } = {}) => {
  const invoke = (args, allowMissing, recovered) => {
    for (let attempt = 0;; attempt++) {
      try {
        return run("pnpm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 })
      } catch (error) {
        const diagnostic = `${error.code ?? ""}\n${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? ""}`
        if (allowMissing && /\bE?404\b/.test(diagnostic)) return undefined
        const transient = /\b(?:ERR_PNPM_FETCH_|E)?(?:429|5[0-9][0-9])\b/.test(diagnostic) ||
          /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH)\b|socket hang up/i.test(diagnostic)
        if (!transient) throw error
        // A disconnected publish may already have reached the registry. Only
        // an exact integrity match turns its lost acknowledgement into success.
        if (recovered?.()) return undefined
        if (attempt >= retryDelays.length) throw error
        pause(retryDelays[attempt])
      }
    }
  }
  const readRegistry = (spec) => {
    const output = invoke(["view", spec, "dist.integrity", "--json"], true)
    if (output === undefined) return undefined
    const value = JSON.parse(output)
    if (typeof value !== "string" || !value.startsWith("sha512-")) throw new Error(`Registry returned no verifiable integrity for ${spec}`)
    return value
  }
  return { pause, readRegistry, publish: (tarball, entry) =>
    invoke(["publish", tarball, "--provenance", "--access", "public", "--tag", entry.version.includes("-") ? "next" : "latest", "--no-git-checks"], false, () => {
      const existing = readRegistry(`${entry.name}@${entry.version}`)
      if (existing === undefined) return false
      if (existing !== entry.integrity) throw new Error(`Registry integrity mismatch or unavailable: ${entry.name}`)
      return true
    }) }
}

export const registryIntegrity = (spec) => registryPublisher().readRegistry(spec)

if (isMain(import.meta)) {
  const directory = resolve(process.argv[2] ?? "dist/release-packs")
  const candidate = JSON.parse(await readFile(join(directory, "release-manifest.json"), "utf8"))
  const releaseTag = process.env.RELEASE_TAG
  if (!releaseTag) throw new Error("RELEASE_TAG is required")
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const tagSha = execFileSync("git", ["rev-parse", "--verify", `refs/tags/${releaseTag}^{commit}`], { encoding: "utf8" }).trim()
  if (sourceSha !== tagSha) throw new Error("The checked-out source is not the requested release tag")
  await publishCandidate(directory, candidate, {
    sourceSha, releaseTag, ...registryPublisher()
  })
}
