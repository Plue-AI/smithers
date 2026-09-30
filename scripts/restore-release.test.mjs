import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { integrity, recordSmokeSuccess } from "./publish-release.mjs"
import { captureArchive, extractArchive, restoreCandidate, restoreSelection, verifyArchiveIdentity } from "./restore-release.mjs"
import { readWorkspaceManifests } from "./pack-release.mjs"

const fixture = async (body) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-restore-"))
  const packed = join(root, "packed")
  const destination = join(root, "restored")
  await mkdir(packed)
  try {
    const packages = ["a", "b"].map((name) => ({ name, version: "1.0.0-rc.0", filename: `${name}.tgz`, integrity: integrity(Buffer.from(name)) }))
    const candidate = { schemaVersion: 1, source: { sha: "candidate-sha", tag: "v1.0.0-rc.0", dirty: false }, toolchain: { lockfileSha256: "tested-lock" }, packages }
    for (const entry of packages) await writeFile(join(packed, entry.filename), entry.name)
    await writeFile(join(packed, "release-manifest.json"), JSON.stringify(candidate))
    await writeFile(join(packed, "manifest.json"), JSON.stringify(packages))
    await recordSmokeSuccess(packed, candidate)
    const run = { id: 10, path: ".github/workflows/release.yml", repository: { id: 1, full_name: "smithersai/smithers" }, head_repository: { id: 1 }, event: "workflow_dispatch", status: "completed", conclusion: "failure", head_sha: "a".repeat(40) }
    const artifact = { id: 20, name: "release-candidate-10", expired: false, workflow_run: { id: 10, head_sha: "a".repeat(40), repository_id: 1, head_repository_id: 1 } }
    const archive = join(root, "candidate.zip")
    const pack = async (extraMember = "") => {
      execFileSync("python3", ["-c", 'import pathlib,sys,zipfile\nwith zipfile.ZipFile(sys.argv[2], "w") as archive:\n for file in sorted(pathlib.Path(sys.argv[1]).iterdir()): archive.write(file, file.name)\n if sys.argv[3]: archive.writestr(sys.argv[3], "unsafe")', packed, archive, extraMember])
      artifact.size_in_bytes = (await readFile(archive)).length
      artifact.digest = `sha256:${createHash("sha256").update(await readFile(archive)).digest("hex")}`
    }
    await pack()
    const calls = []
    const options = {
      runId: "10", artifactId: "20", repository: "smithersai/smithers",
      sourceSha: "candidate-sha", tagSha: "candidate-sha", releaseTag: "v1.0.0-rc.0",
      expectedPackages: packages.map(({ name, version }) => ({ name, version })), lockfileSha256: "tested-lock",
      readMetadata: async (endpoint) => { calls.push(endpoint); return endpoint.includes("/runs/") ? run : artifact },
      download: async (endpoint, path) => { calls.push(endpoint); await cp(archive, path) },
      readRegistry: async () => undefined
    }
    await body({ root, packed, destination, candidate, run, artifact, archive, options, pack, calls })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test("archive selection is paired, numeric, safe and absent by default", () => {
  assert.equal(restoreSelection(), undefined)
  assert.deepEqual(restoreSelection("10", "20"), { runId: 10, artifactId: 20 })
  for (const pair of [["10", ""], ["", "20"], ["1; false", "20"], ["0", "20"], ["10", "9007199254740992"]]) assert.throws(() => restoreSelection(...pair), /both be positive/)
})

test("invocation through a symlink executes input validation instead of silently succeeding", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-restore-entry-"))
  try {
    const entry = join(root, "restore.mjs")
    await symlink(fileURLToPath(new URL("./restore-release.mjs", import.meta.url)), entry)
    const output = execFileSync(process.execPath, [entry, "--check-inputs"], {
      encoding: "utf8",
      env: { ...process.env, CANDIDATE_RUN_ID: "10", CANDIDATE_ARTIFACT_ID: "20" },
      timeout: 30_000
    })
    assert.equal(output, "Restoring release run 10, artifact 20\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("restores the exact selected artifact and verifies candidate source independently of workflow source", () => fixture(async ({ destination, candidate, options, calls }) => {
  const pending = await restoreCandidate(destination, { ...options, readRegistry: async (spec) => spec.startsWith("a@") ? candidate.packages[0].integrity : undefined })
  assert.deepEqual(pending.map((entry) => entry.name), ["b"])
  assert.deepEqual(calls, ["repos/smithersai/smithers/actions/runs/10", "repos/smithersai/smithers/actions/artifacts/20", "repos/smithersai/smithers/actions/artifacts/20/zip"])
  const receipt = JSON.parse(await readFile(join(destination, "restore-evidence.json"), "utf8"))
  assert.equal(receipt.workflowSourceSha, "a".repeat(40))
  assert.equal(receipt.candidateSource.sha, "candidate-sha")
  assert.deepEqual(receipt.pending, ["b"])
  assert.equal(await readFile(join(destination, "a.tgz"), "utf8"), "a")
}))

test("wrong run, workflow, repository, fork, unfinished run and artifact identity fail before download", () => fixture(async ({ root, run, artifact, options, destination, calls }) => {
  const mutations = [
    [{ id: 11 }, {}], [{ path: ".github/workflows/ci.yml" }, {}], [{ repository: { id: 1, full_name: "other/repo" } }, {}],
    [{ head_repository: { id: 9 } }, {}], [{ status: "in_progress" }, {}], [{ event: "pull_request" }, {}],
    [{ repository: { full_name: "smithersai/smithers" }, head_repository: {}, head_sha: undefined }, { workflow_run: { id: 10 } }],
    [{}, { size_in_bytes: undefined }], [{}, { size_in_bytes: 513 * 1024 * 1024 }], [{}, { id: 21 }], [{}, { name: "arbitrary" }], [{}, { expired: true }], [{}, { digest: undefined }],
    [{}, { workflow_run: { ...artifact.workflow_run, id: 11 } }], [{}, { workflow_run: { ...artifact.workflow_run, head_sha: "different" } }]
  ]
  for (const [runChange, artifactChange] of mutations) {
    assert.throws(() => verifyArchiveIdentity({ runId: 10, artifactId: 20 }, options.repository, { ...run, ...runChange }, { ...artifact, ...artifactChange }))
    await assert.rejects(restoreCandidate(destination, {
      ...options,
      readMetadata: async (endpoint) => endpoint.includes("/runs/") ? { ...run, ...runChange } : { ...artifact, ...artifactChange }
    }))
  }
  await assert.rejects(restoreCandidate(destination, { ...options, tagSha: "wrong-tag" }), /requested release tag/)
  assert.deepEqual(calls, [])
  assert.equal(existsSync(destination), false)
  assert.equal((await readdir(root)).some((name) => name.startsWith(".release-restore-")), false)
}))

test("altered archive bytes and traversal members are refused without exposing a candidate", () => fixture(async ({ root, destination, options, archive, pack }) => {
  await writeFile(archive, "corrupted zip")
  await assert.rejects(restoreCandidate(destination, options), /archive digest mismatch/)
  await pack("../escape")
  await assert.rejects(restoreCandidate(destination, options), /Invalid release archive member/)
  assert.equal(existsSync(destination), false)
  assert.equal(existsSync(join(root, "escape")), false)
  assert.equal((await readdir(root)).some((name) => name.startsWith(".release-restore-")), false)
}))

test("different roster, order or lockfile and registry mismatch refuse restored artifacts", () => fixture(async ({ destination, options }) => {
  await assert.rejects(restoreCandidate(destination, { ...options, expectedPackages: options.expectedPackages.toReversed() }), /roster\/order/)
  await assert.rejects(restoreCandidate(destination, { ...options, expectedPackages: options.expectedPackages.slice(0, 1) }), /expected roster member count/)
  await assert.rejects(restoreCandidate(destination, { ...options, lockfileSha256: "other-lock" }), /lockfile/)
  await assert.rejects(restoreCandidate(destination, { ...options, readRegistry: async () => "different-bytes" }), /Registry integrity mismatch/)
  assert.equal(existsSync(destination), false)
}))

test("a restored candidate needs its original successful smoke proof and matching tag/source", () => fixture(async ({ packed, destination, candidate, options, pack }) => {
  for (const source of [{ ...candidate.source, sha: "other" }, { ...candidate.source, tag: "v2.0.0" }, { ...candidate.source, dirty: true }]) {
    await writeFile(join(packed, "release-manifest.json"), JSON.stringify({ ...candidate, source }))
    await pack()
    await assert.rejects(restoreCandidate(destination, options), /source\/tag/)
  }
  await writeFile(join(packed, "release-manifest.json"), JSON.stringify(candidate))
  await rm(join(packed, "smoke-evidence.json"))
  await pack()
  await assert.rejects(restoreCandidate(destination, options), /smoke-evidence/)
  assert.equal(existsSync(destination), false)
}))

test("an existing destination is preserved and failed metadata transport does not download", () => fixture(async ({ destination, options, calls }) => {
  await writeFile(destination, "operator data")
  await assert.rejects(restoreCandidate(destination, options), /destination already exists/)
  assert.equal(await readFile(destination, "utf8"), "operator data")
  assert.equal(calls.some((call) => call.endsWith("/zip")), false)
  await assert.rejects(restoreCandidate(destination, { ...options, readMetadata: async () => { throw new Error("metadata unavailable") } }), /metadata unavailable/)
}))

test("an extra tarball outside the tested roster is refused", () => fixture(async ({ packed, destination, options, pack }) => {
  await writeFile(join(packed, "extra.tgz"), "untested")
  await pack()
  await assert.rejects(restoreCandidate(destination, options), /expected roster member count/)
  assert.equal(existsSync(destination), false)
}))

test("changed package bytes and a failed smoke receipt cannot be restored even from a valid archive", () => fixture(async ({ packed, destination, options, pack }) => {
  await writeFile(join(packed, "a.tgz"), "different package")
  await pack()
  await assert.rejects(restoreCandidate(destination, options), /Local tarball integrity mismatch/)
  await writeFile(join(packed, "a.tgz"), "a")
  await writeFile(join(packed, "smoke-evidence.json"), JSON.stringify({ schemaVersion: 1, status: "failed" }))
  await pack()
  await assert.rejects(restoreCandidate(destination, options), /matching successful smoke evidence/)
  assert.equal(existsSync(destination), false)
}))

test("ZIP links and duplicate names are rejected before any member is extracted", () => fixture(async ({ root }) => {
  const archive = join(root, "unsafe.zip")
  const destination = join(root, "unpacked")
  await mkdir(destination)
  for (const kind of ["link", "duplicate"]) {
    execFileSync("python3", ["-c", 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as archive:\n archive.writestr("manifest.json", "first")\n if sys.argv[2] == "link":\n  entry=zipfile.ZipInfo("a.tgz"); entry.external_attr=0o120777 << 16; archive.writestr(entry, "outside")\n else: archive.writestr("manifest.json", "second")', archive, kind], { stdio: "pipe" })
    assert.throws(() => extractArchive(archive, destination), /Invalid release archive member/)
    assert.deepEqual(await readdir(destination), [])
  }
}))

test("ZIP roster member count is bounded before any file is extracted", () => fixture(async ({ root }) => {
  const archive = join(root, "excess.zip")
  const destination = join(root, "unpacked")
  await mkdir(destination)
  execFileSync("python3", ["-c", 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as archive:\n for index in range(10001): archive.writestr(str(index)+".tgz", "")', archive])
  assert.throws(() => extractArchive(archive, destination, 2), /expected roster member count/)
  assert.deepEqual(await readdir(destination), [])
}))

test("archive streaming accepts N-1 and N bytes and cancels N+1 before exceeding its disk limit", () => fixture(async ({ root }) => {
  const limit = 1024
  for (const bytes of [limit - 1, limit, limit + 1]) {
    const path = join(root, `download-${bytes}.zip`)
    const capture = captureArchive(process.execPath, ["-e", `process.stdout.write(Buffer.alloc(${bytes}, 97));`], path, limit)
    if (bytes > limit) {
      await assert.rejects(capture, /exceeds its byte limit/)
      assert.ok((await readFile(path)).length <= limit)
    } else {
      await capture
      assert.deepEqual(await readFile(path), Buffer.alloc(bytes, 97))
    }
  }
}))

test("archive streaming propagates transport exit and spawn errors", () => fixture(async ({ root }) => {
  await assert.rejects(captureArchive(process.execPath, ["-e", "process.exit(7)"], join(root, "failed.zip")), /exited with 7/)
  await assert.rejects(captureArchive(join(root, "missing-command"), [], join(root, "absent.zip")), /ENOENT/)
  await assert.rejects(captureArchive(process.execPath, "invalid arguments", join(root, "invalid.zip")), /args/)
}))

const descendantAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    throw error
  }
}

const descendantExits = async (pid) => {
  for (const started = Date.now(); Date.now() - started < 2000;) {
    if (!descendantAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

/** Parent starts an owned descendant on inherited pipes and exits 0; the descendant runs `body` and keeps running. */
const exitedParent = (pidFile, body) => [
  "-e",
  `const { spawn } = require("node:child_process")
   const child = spawn(process.execPath, ["-e", ${JSON.stringify(`${body}; setInterval(() => {}, 1000)`)}], { stdio: ["ignore", "inherit", "inherit"] })
   require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
   process.exit(0)`
]

test("archive aborts settle and kill a descendant still holding the pipes after its parent exited", () => fixture(async ({ root }) => {
  const cases = [
    { name: "limit", body: "setTimeout(() => process.stdout.write(Buffer.alloc(20, 97)), 100)", timeoutMs: 60_000, failure: /exceeds its byte limit/ },
    { name: "deadline", body: "", timeoutMs: 300, failure: /download timed out/ }
  ]
  for (const { name, body, timeoutMs, failure } of cases) {
    const pidFile = join(root, `${name}.pid`)
    let pid
    try {
      const started = Date.now()
      await assert.rejects(captureArchive(process.execPath, exitedParent(pidFile, body), join(root, `${name}.zip`), 8, timeoutMs), failure)
      assert.ok(Date.now() - started < 5000)
      pid = Number(await readFile(pidFile, "utf8"))
      assert.equal(await descendantExits(pid), true)
      assert.equal((await readFile(join(root, `${name}.zip`))).length, 0)
    } finally {
      if (pid !== undefined && descendantAlive(pid)) process.kill(pid, "SIGKILL")
    }
  }
}))

test("the shared source roster reader refuses missing or unknown workspace groups", () => fixture(async ({ root }) => {
  const repository = join(root, "source")
  const member = join(repository, "packages/member")
  await mkdir(member, { recursive: true })
  await writeFile(join(repository, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n')
  for (const smthrs of [undefined, { group: "unknown" }]) {
    await writeFile(join(member, "package.json"), JSON.stringify({ name: "@smthrs/member", private: true, smthrs }))
    assert.throws(() => readWorkspaceManifests(repository), /smthrs.group must be one of/)
  }
}))
