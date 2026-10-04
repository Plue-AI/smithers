import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { maintainerReleasePlan, integrity, preflight, publishCandidate, recordSmokeSuccess } from "./publish-release.mjs"

const fixture = async (body) => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-publish-"))
  try {
    const packages = [{ name: "a", version: "1.0.0-rc.0", filename: "a.tgz", integrity: integrity(Buffer.from("a")) }, { name: "b", version: "1.0.0-rc.0", filename: "b.tgz", integrity: integrity(Buffer.from("b")) }]
    for (const entry of packages) await writeFile(join(directory, entry.filename), entry.name)
    const candidate = { schemaVersion: 1, source: { sha: "tested-sha", tag: "v1.0.0-rc.0", dirty: false }, packages }
    await writeFile(join(directory, "manifest.json"), JSON.stringify(packages))
    await writeFile(join(directory, "release-manifest.json"), JSON.stringify(candidate))
    await recordSmokeSuccess(directory, candidate)
    const options = { sourceSha: "tested-sha", releaseTag: "v1.0.0-rc.0" }
    await body(directory, candidate, options)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test("publishes absent packages in manifest order and verifies every publication", () => fixture(async (directory, candidate, options) => {
  const registry = new Map()
  const calls = []
  const pauses = []
  const result = await publishCandidate(directory, candidate, { ...options,
    pause: async (seconds) => { pauses.push(seconds) },
    readRegistry: async (spec) => registry.get(spec), publish: async (path, entry) => { calls.push(path); registry.set(`${entry.name}@${entry.version}`, entry.integrity) }
  })
  assert.deepEqual(result, ["a", "b"])
  assert.deepEqual(pauses, [2])
  assert.deepEqual(calls, [join(directory, "a.tgz"), join(directory, "b.tgz")])
  assert.deepEqual(await publishCandidate(directory, candidate, { ...options, readRegistry: async (spec) => registry.get(spec), publish: () => assert.fail("identical retry must skip") }), [])
}))

test("a mismatched existing package refuses the entire partial retry", () => fixture(async (directory, candidate, options) => {
  let published = 0
  await assert.rejects(publishCandidate(directory, candidate, { ...options,
    readRegistry: async (spec) => spec.startsWith("b@") ? integrity(Buffer.from("different candidate")) : undefined,
    publish: () => { published++ }
  }), /Registry integrity mismatch/)
  assert.equal(published, 0)
}))

test("missing registry integrity and transport failures fail closed", () => fixture(async (directory, candidate, options) => {
  await assert.rejects(preflight(directory, candidate, { ...options, readRegistry: async () => null }), /Registry integrity mismatch/)
  await assert.rejects(preflight(directory, candidate, { ...options, readRegistry: async () => { throw new Error("offline") } }), /offline/)
}))

test("tag, source, dirty state and altered tested bytes are refused", () => fixture(async (directory, candidate, options) => {
  const readRegistry = async () => undefined
  await assert.rejects(preflight(directory, candidate, { ...options, sourceSha: "another", readRegistry }), /source\/tag/)
  await assert.rejects(preflight(directory, candidate, { ...options, releaseTag: "v2.0.0", readRegistry }), /source\/tag/)
  await assert.rejects(preflight(directory, { ...candidate, source: { ...candidate.source, dirty: true } }, { ...options, readRegistry }), /source\/tag/)
  await writeFile(join(directory, "a.tgz"), "changed after smoke")
  await assert.rejects(preflight(directory, candidate, { ...options, readRegistry }), /Local tarball integrity mismatch/)
}))

test("a publication with unverified resulting integrity stops the remainder", () => fixture(async (directory, candidate, options) => {
  const calls = []
  await assert.rejects(publishCandidate(directory, candidate, { ...options, readRegistry: async () => undefined, publish: async (_path, entry) => calls.push(entry.name) }), /Published integrity/)
  assert.deepEqual(calls, ["a"])
}))

test("a publication the registry has not served yet is re-read through the retry ladder", () => fixture(async (directory, candidate, options) => {
  const registry = new Map()
  const lag = new Map()
  const pauses = []
  const result = await publishCandidate(directory, candidate, { ...options,
    pause: async (seconds) => { pauses.push(seconds) },
    readRegistry: async (spec) => {
      const missing = lag.get(spec) ?? 0
      if (missing === 0) return registry.get(spec)
      lag.set(spec, missing - 1)
      return undefined
    },
    publish: async (_path, entry) => {
      registry.set(`${entry.name}@${entry.version}`, entry.integrity)
      lag.set(`${entry.name}@${entry.version}`, entry.name === "a" ? 1 : 3)
    }
  })
  assert.deepEqual(result, ["a", "b"])
  assert.deepEqual(pauses, [10, 2, 10, 30, 60])
}))

test("a publication still absent after the retry ladder stops the remainder", () => fixture(async (directory, candidate, options) => {
  const calls = []
  const pauses = []
  const reads = []
  await assert.rejects(publishCandidate(directory, candidate, { ...options,
    pause: async (seconds) => { pauses.push(seconds) },
    readRegistry: async (spec) => { reads.push(spec) },
    publish: async (_path, entry) => calls.push(entry.name)
  }), /Published integrity could not be verified: a/)
  assert.deepEqual(calls, ["a"])
  assert.deepEqual(pauses, [10, 30, 60])
  // Preflight reads both packages once; verification reads a once per rung.
  assert.deepEqual(reads, ["a@1.0.0-rc.0", "b@1.0.0-rc.0", ...Array(4).fill("a@1.0.0-rc.0")])
}))

test("a publication with different registry integrity fails closed without waiting", () => fixture(async (directory, candidate, options) => {
  const registry = new Map()
  const pauses = []
  await assert.rejects(publishCandidate(directory, candidate, { ...options,
    pause: async (seconds) => { pauses.push(seconds) },
    readRegistry: async (spec) => registry.get(spec),
    publish: async (_path, entry) => { registry.set(`${entry.name}@${entry.version}`, integrity(Buffer.from("different candidate"))) }
  }), /Published integrity could not be verified: a/)
  assert.deepEqual(pauses, [])
}))

test("a partial publication resumes only the missing packages from the tested train", () => fixture(async (directory, candidate, options) => {
  const registry = new Map()
  const calls = []
  const readRegistry = async (spec) => registry.get(spec)
  await assert.rejects(publishCandidate(directory, candidate, { ...options, readRegistry, publish: async (_path, entry) => {
    calls.push(entry.name)
    if (entry.name === "b") throw new Error("connection lost")
    registry.set(`${entry.name}@${entry.version}`, entry.integrity)
  } }), /connection lost/)
  assert.deepEqual(JSON.parse(await readFile(join(directory, "publish-receipt.json"), "utf8")).published, ["a"])
  assert.deepEqual(await publishCandidate(directory, candidate, { ...options, readRegistry, publish: async (_path, entry) => {
    calls.push(entry.name)
    registry.set(`${entry.name}@${entry.version}`, entry.integrity)
  } }), ["b"])
  assert.deepEqual(calls, ["a", "b", "b"])
}))

test("a successful smoke receipt is required and bound to the complete manifest", () => fixture(async (directory, candidate, options) => {
  const readRegistry = async () => assert.fail("untested candidates cannot query the registry")
  await rm(join(directory, "smoke-evidence.json"))
  await assert.rejects(preflight(directory, candidate, { ...options, readRegistry }), /smoke-evidence/)
  await recordSmokeSuccess(directory, candidate)
  await assert.rejects(preflight(directory, { ...candidate, toolchain: { node: "changed" } }, { ...options, readRegistry }), /matching successful smoke evidence/)
  await writeFile(join(directory, "smoke-evidence.json"), JSON.stringify({ schemaVersion: 1, status: "failed" }))
  await assert.rejects(preflight(directory, candidate, { ...options, readRegistry }), /matching successful smoke evidence/)
}))

test("smoke success cannot attest changed manifest, roster or tarball bytes", () => fixture(async (directory, candidate) => {
  await rm(join(directory, "smoke-evidence.json"))
  await writeFile(join(directory, "release-manifest.json"), JSON.stringify({ ...candidate, source: { ...candidate.source, sha: "new" } }))
  await assert.rejects(recordSmokeSuccess(directory, candidate), /changed during smoke/)
  await writeFile(join(directory, "release-manifest.json"), JSON.stringify(candidate))
  await writeFile(join(directory, "manifest.json"), JSON.stringify(candidate.packages.slice(1)))
  await assert.rejects(recordSmokeSuccess(directory, candidate), /smoke-test package roster/)
  await writeFile(join(directory, "manifest.json"), JSON.stringify(candidate.packages))
  await writeFile(join(directory, "b.tgz"), "changed")
  await assert.rejects(recordSmokeSuccess(directory, candidate), /Local tarball integrity mismatch/)
  await assert.rejects(readFile(join(directory, "smoke-evidence.json")), /ENOENT/)
}))

test("a tarball changed while its predecessor publishes is refused", () => fixture(async (directory, candidate, options) => {
  const registry = new Map()
  const calls = []
  await assert.rejects(publishCandidate(directory, candidate, { ...options,
    readRegistry: async (spec) => registry.get(spec),
    publish: async (_path, entry) => {
      calls.push(entry.name)
      registry.set(`${entry.name}@${entry.version}`, entry.integrity)
      await writeFile(join(directory, "b.tgz"), "changed after preflight")
    }
  }), /Local tarball integrity mismatch: b/)
  assert.deepEqual(calls, ["a"])
}))

test("duplicate package names and filenames and unsafe paths are refused before registry access", () => fixture(async (directory, candidate, options) => {
  for (const mutate of [
    (entry) => ({ ...entry, name: "a" }),
    (entry) => ({ ...entry, filename: "a.tgz" }),
    (entry) => ({ ...entry, filename: "../b.tgz" }),
    (entry) => ({ ...entry, filename: "..\\b.tgz" })
  ]) {
    const changed = { ...candidate, packages: [candidate.packages[0], mutate(candidate.packages[1])] }
    await writeFile(join(directory, "manifest.json"), JSON.stringify(changed.packages))
    await assert.rejects(preflight(directory, changed, { ...options, readRegistry: async () => assert.fail("invalid train queried registry") }), /Invalid release entry/)
  }
}))

// Literal T-MNT-05 dates and checks; no spec/catalog-derived expectations.
const maintainerCandidate = () => ({ releaseStage: "M", source: { tag: "v1.1.0" }, maintainerRelease: {
  launchUtc: "2026-12-28T23:30:00.000Z", targetReleaseUtc: "2027-01-04T23:30:00.000Z",
  launchVersion: "1.0.0", availableUtc: null
} })

test("maintainer release records year rollover and stays blocked without availability", () => {
  assert.deepEqual(maintainerReleasePlan(maintainerCandidate()), {
    launchUtc: "2026-12-28T23:30:00.000Z", targetReleaseUtc: "2027-01-04T23:30:00.000Z",
    availableUtc: null, launchVersion: "1.0.0", releaseVersion: "1.1.0", state: "blocked",
    requiredChecks: ["C-MNT-01", "C-MNT-02", "C-MNT-03", "C-MNT-04", "C-MNT-05", "C-MNT-06", "C-REL-03", "C-SEC-02", "C-SEC-03", "C-COL-04", "C-MCH-06"]
  })
})

test("maintainer dates reject normalization, local zones, early and missed publication", () => {
  for (const [field, value, message] of [
    ["launchUtc", "2026-02-30T23:30:00.000Z", /Invalid release date/],
    ["launchUtc", "2026-12-28T23:30:00-08:00", /UTC/],
    ["launchUtc", null, /UTC/],
    ["targetReleaseUtc", "2027-01-04T23:29:59.000Z", /seven calendar days/],
    ["availableUtc", "2027-01-04T23:29:59.000Z", /day seven/],
    ["availableUtc", "2027-01-05T23:30:00.000Z", /day seven/],
    ["availableUtc", "2027-01-04", /UTC/],
    ["launchVersion", "1.1.0", /Distinct/],
    ["launchVersion", "", /Distinct/]
  ]) {
    const candidate = maintainerCandidate()
    candidate.maintainerRelease[field] = value
    assert.throws(() => maintainerReleasePlan(candidate), message)
  }
  for (const value of ["2027-01-04T23:30:00.000Z", "2027-01-05T23:29:59.000Z"]) {
    const candidate = maintainerCandidate()
    candidate.maintainerRelease.availableUtc = value
    assert.equal(maintainerReleasePlan(candidate).state, "blocked")
  }
  assert.throws(() => maintainerReleasePlan({}), /record is required/)
})

test("M publication fails before registry reads or writes even with claimed passing receipts", () => fixture(async (directory, candidate, options) => {
  let reads = 0, writes = 0
  const doors = { ...options, readRegistry: async () => { reads++ }, publish: async () => { writes++ } }
  for (const availableUtc of [null, "2027-01-04T23:30:00.000Z"]) {
    const m = { ...candidate, releaseStage: "M", maintainerRelease: {
      ...maintainerCandidate().maintainerRelease, availableUtc, checks: { "C-MNT-05": "passed" }
    } }
    await assert.rejects(publishCandidate(directory, m, doors), /Maintainer publication disabled/)
  }
  await assert.rejects(preflight(directory, { ...candidate, releaseStage: "M" }, doors), /record is required/)
  await assert.rejects(preflight(directory, { ...candidate, maintainerRelease: {} }, doors), /declare stage M/)
  await assert.rejects(preflight(directory, { ...candidate, releaseStage: "cloud" }, doors), /Unknown release stage/)
  assert.equal(reads, 0)
  assert.equal(writes, 0)
}))
