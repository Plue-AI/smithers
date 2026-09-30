/** Restore one immutable tested release archive; this script never publishes. */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, closeSync, openSync, writeSync } from "node:fs"
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { preflight, registryIntegrity } from "./publish-release.mjs"
import { superviseProcess } from "./release-process.mjs"
import { dependencyOrder, publishedPackages, readWorkspaceManifests, workspaceDependencies } from "./pack-release.mjs"
import { isMain } from "./workspace-packages.mjs"

export const restoreSelection = (runId = "", artifactId = "") => {
  if (runId === "" && artifactId === "") return undefined
  if (!/^[1-9]\d*$/.test(runId) || !Number.isSafeInteger(Number(runId)) || !/^[1-9]\d*$/.test(artifactId) || !Number.isSafeInteger(Number(artifactId))) throw new Error("candidateRunId and candidateArtifactId must both be positive safe integer IDs")
  return { runId: Number(runId), artifactId: Number(artifactId) }
}

const maximumArchiveBytes = 512 * 1024 * 1024

export const verifyArchiveIdentity = (selection, repository, run, artifact) => {
  if (!Number.isSafeInteger(run.repository?.id) || run.repository.id <= 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(run.head_sha ?? "") || run.id !== selection.runId || run.path !== ".github/workflows/release.yml" || run.repository?.full_name !== repository || run.head_repository?.id !== run.repository?.id || !["push", "workflow_dispatch"].includes(run.event) || run.status !== "completed") throw new Error("Archived candidate must come from a completed Release workflow in this repository")
  if (artifact.id !== selection.artifactId || artifact.name !== `release-candidate-${selection.runId}` || artifact.expired !== false || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== run.head_sha || artifact.workflow_run?.repository_id !== run.repository.id || artifact.workflow_run?.head_repository_id !== run.repository.id) throw new Error("Archived candidate artifact does not belong to the selected Release run")
  if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > maximumArchiveBytes) throw new Error("Archived candidate has an invalid or oversized archive size")
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "")) throw new Error("Archived candidate is missing a verifiable immutable archive digest")
}

const githubHeaders = ["-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10"]

const archiveDigest = async (path) => {
  const hash = createHash("sha256")
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length
    if (bytes > maximumArchiveBytes) throw new Error("Release archive exceeds 512 MiB")
    hash.update(chunk)
  }
  return `sha256:${hash.digest("hex")}`
}

// GitHub's archive is flat. Check every member before writing any, including
// link attributes; never let extraction escape the fresh staging directory.
const extractProgram = String.raw`
import os, re, shutil, stat, sys, zipfile
allowed = {"manifest.json", "release-manifest.json", "smoke-evidence.json", "publish-receipt.json", "restore-evidence.json"}
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    maximum_packages = int(sys.argv[3])
    if len(entries) > maximum_packages + len(allowed) or sum(entry.filename.endswith(".tgz") for entry in entries) > maximum_packages:
        raise ValueError("Release archive exceeds the expected roster member count")
    names = set()
    total = 0
    for entry in entries:
        name = entry.filename
        mode = stat.S_IFMT(entry.external_attr >> 16)
        if name in names or mode not in (0, stat.S_IFREG) or not (name in allowed or re.fullmatch(r"[A-Za-z0-9._-]+\.tgz", name)):
            raise ValueError("Invalid release archive member: " + repr(name))
        names.add(name)
        total += entry.file_size
        if total > 1024 * 1024 * 1024:
            raise ValueError("Expanded release archive exceeds 1 GiB")
    for entry in entries:
        with archive.open(entry) as source, open(os.path.join(sys.argv[2], entry.filename), "xb") as target:
            shutil.copyfileobj(source, target)
`

/**
 * Expands a release archive under a member-count budget.
 *
 * Callers inside this module pass the roster they are about to verify, so the
 * budget is the caller's expectation. The default is the declared release
 * roster's length — a constant — rather than the packed workspace order, which
 * would read and validate the whole workspace tree just to size a zip.
 */
export const extractArchive = (archive, destination, maximumPackages = publishedPackages.length) => {
  execFileSync("python3", ["-c", extractProgram, archive, destination, String(maximumPackages)], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 })
}

/**
 * Stream subprocess output to an archive file with a byte cap enforced before
 * each write. An abort or deadline settles at once and kills the whole owned
 * process group, even when a descendant still holds the output pipes.
 */
export const captureArchive = async (command, args, path, maximumBytes = maximumArchiveBytes, timeoutMs = 180_000) => {
  const file = openSync(path, "wx")
  let bytes = 0
  let { failure, code, signal } = await superviseProcess(command, args, {
    timeoutMs,
    timeoutMessage: "Release archive download timed out",
    onOutput: (chunk, source, stop) => {
      if (source !== "stdout") return
      bytes += chunk.length
      if (bytes > maximumBytes) return stop(new Error("Release archive download exceeds its byte limit"))
      try {
        for (let offset = 0; offset < chunk.length;) offset += writeSync(file, chunk, offset)
      } catch (error) { stop(error) }
    }
  })
  try { closeSync(file) } catch (error) { failure ??= error }
  if (failure) throw failure
  if (code !== 0) throw new Error(`Release archive download exited with ${code ?? signal}`)
}

export const restoreCandidate = async (directory, options) => {
  const selection = restoreSelection(options.runId, options.artifactId)
  if (selection === undefined) throw new Error("An archived candidate selection is required")
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) throw new Error("Invalid candidate repository")
  if (options.sourceSha !== options.tagSha) throw new Error("The checked-out source is not the requested release tag")
  const [run, artifact] = await Promise.all([
    options.readMetadata(`repos/${options.repository}/actions/runs/${selection.runId}`),
    options.readMetadata(`repos/${options.repository}/actions/artifacts/${selection.artifactId}`)
  ])
  verifyArchiveIdentity(selection, options.repository, run, artifact)
  try {
    await access(directory)
    throw new Error("Release restore destination already exists")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  await mkdir(dirname(directory), { recursive: true })
  const staging = await mkdtemp(join(dirname(directory), ".release-restore-"))
  try {
    const archive = join(staging, "candidate.zip")
    const unpacked = join(staging, "candidate")
    await mkdir(unpacked)
    await options.download(`repos/${options.repository}/actions/artifacts/${selection.artifactId}/zip`, archive)
    if (await archiveDigest(archive) !== artifact.digest) throw new Error("Downloaded release archive digest mismatch")
    await extractArchive(archive, unpacked, options.expectedPackages.length)
    const candidate = JSON.parse(await readFile(join(unpacked, "release-manifest.json"), "utf8"))
    if (JSON.stringify(candidate.packages?.map(({ name, version }) => ({ name, version }))) !== JSON.stringify(options.expectedPackages)) throw new Error("Archived candidate package roster/order does not match the checked-out release source")
    if (candidate.toolchain?.lockfileSha256 !== options.lockfileSha256) throw new Error("Archived candidate lockfile does not match the checked-out release source")
    const pending = await preflight(unpacked, candidate, options)
    await writeFile(join(unpacked, "restore-evidence.json"), JSON.stringify({
      schemaVersion: 1, repository: options.repository, ...selection,
      archiveDigest: artifact.digest, workflowSourceSha: run.head_sha,
      candidateSource: candidate.source, pending: pending.map((entry) => entry.name)
    }, null, 2) + "\n")
    await rename(unpacked, directory)
    return pending
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (isMain(import.meta)) {
  const selection = restoreSelection(process.env.CANDIDATE_RUN_ID, process.env.CANDIDATE_ARTIFACT_ID)
  if (process.argv[2] === "--check-inputs") {
    console.log(selection === undefined ? "Building a new release candidate" : `Restoring release run ${selection.runId}, artifact ${selection.artifactId}`)
  } else {
    if (selection === undefined || !process.env.RELEASE_TAG) throw new Error("Archived candidate IDs and RELEASE_TAG are required")
    const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim()
    const manifests = readWorkspaceManifests()
    await restoreCandidate(resolve(process.argv[2] ?? "dist/release-packs"), {
      runId: String(selection.runId), artifactId: String(selection.artifactId),
      repository: process.env.GITHUB_REPOSITORY ?? "",
      sourceSha: git("rev-parse", "HEAD"),
      tagSha: git("rev-parse", "--verify", `refs/tags/${process.env.RELEASE_TAG}^{commit}`),
      releaseTag: process.env.RELEASE_TAG,
      expectedPackages: dependencyOrder(workspaceDependencies(manifests)).map((directory) => ({ name: manifests.get(directory).name, version: manifests.get(directory).version })),
      lockfileSha256: createHash("sha256").update(await readFile("pnpm-lock.yaml")).digest("hex"),
      readRegistry: registryIntegrity,
      readMetadata: async (endpoint) => JSON.parse(execFileSync("gh", ["api", endpoint, ...githubHeaders], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 })),
      download: (endpoint, path) => captureArchive("gh", ["api", endpoint, ...githubHeaders], path)
    })
  }
}
