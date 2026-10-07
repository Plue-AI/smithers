import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formula, requireQualification } from "./homebrew-release.mjs"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
const digest = "a".repeat(64)
test("bottle command publishes Homebrew's download filename and rejects corrupt bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brew-bottle-"))
  const local = "smithers--1.2.3.arm64_sequoia.bottle.tar.gz"
  const filename = "smithers-1.2.3.arm64_sequoia.bottle.tar.gz"
  const bytes = Buffer.from("bottle fixture")
  const metadata = { smithers: { bottle: { tags: { arm64_sequoia: { local_filename: local, filename, sha256: createHash("sha256").update(bytes).digest("hex") } } } } }
  const run = () => spawnSync(process.execPath, [resolve("scripts/homebrew-release.mjs"), "normalize-bottle", dir], { encoding: "utf8" })
  try {
    await writeFile(join(dir, "smithers.bottle.json"), JSON.stringify(metadata))
    await writeFile(join(dir, local), "changed")
    assert.notEqual(run().status, 0)
    await assert.rejects(readFile(join(dir, filename)), { code: "ENOENT" })
    await writeFile(join(dir, local), bytes)
    const result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(await readFile(join(dir, filename)), bytes)
    await assert.rejects(readFile(join(dir, local)), { code: "ENOENT" })
    metadata.smithers.bottle.tags.arm64_sequoia.local_filename = "../escape.bottle.tar.gz"
    await writeFile(join(dir, "smithers.bottle.json"), JSON.stringify(metadata))
    assert.notEqual(run().status, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test("candidate emits the complete runtime and default keg with actual checksums", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brew-candidate-"))
  try {
    await writeFile(join(dir, "smithers-v1.2.3-darwin-arm64.tar.gz"), "cli")
    await writeFile(join(dir, "smithers-server.tar.gz"), "server")
    const result = spawnSync(process.execPath, [resolve("scripts/homebrew-release.mjs"), "prepare", dir, "v1.2.3"], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    const ruby = await readFile(join(dir, "Formula/smithers.rb"), "utf8")
    assert.match(ruby, /github.com\/smithersai\/smithers\/releases\/download\/v1.2.3/)
    assert.match(ruby, /prefix\/"cli\/smithers" => "smthrs"/)
    assert.ok(ruby.indexOf('"verify-blob"') < ruby.indexOf('resource("server").stage'))
    assert.doesNotMatch(ruby, /sudo|smithers\.sh/)
    assert.match(ruby, /unless build.bottle\?/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test("formula refuses injection and missing checksums", () => {
  for (const tag of ["../main", 'v1.2.3"', "frontrun"]) assert.throws(() => formula({ tag, cliHash: digest, bundleHash: digest, sumsHash: digest }))
  assert.throws(() => formula({ tag: "v1.2.3", cliHash: "", bundleHash: digest, sumsHash: digest }))
})
test("publication requires all checks from the authenticated reference-host app", async () => {
  const sha = "b".repeat(40)
  const checks = ["C-REL-02", "C-J1-01", "C-J1-04"].map(name => ({ name, head_sha: sha, app: { id: 42 }, status: "completed", conclusion: "success" }))
  const args = { sha, tag: "v1.2.3", appID: "42", token: "fixture" }
  const request = async () => Response.json({ check_runs: checks })
  await requireQualification({ ...args, request })
  await assert.rejects(requireQualification({ ...args, appID: "43", request }), /Missing authenticated/)
  checks.push({ ...checks[0], id: 2, conclusion: "failure" })
  await assert.rejects(requireQualification({ ...args, request }), /C-REL-02/)
  checks.pop()
  checks[0].conclusion = "failure"
  await assert.rejects(requireQualification({ ...args, request }), /C-REL-02/)
  await assert.rejects(requireQualification({ ...args, token: "", request }), /not configured/)
  await assert.rejects(requireQualification({ ...args, request: async () => new Response("", { status: 403 }) }), /403/)
})
