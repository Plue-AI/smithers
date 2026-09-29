import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const digest = `sha256:${"a".repeat(64)}`
const tag = "ghcr.io/smithersai/smithers:1.2.3"
const digestRef = `ghcr.io/smithersai/smithers@${digest}`

const commandStub = String.raw`#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const command = path.basename(process.argv[1])
const args = process.argv.slice(2)
const record = { command, args, dockerConfig: process.env.DOCKER_CONFIG || "" }
if (command === "docker") {
  if (args[0] === "login") {
    record.passwordFromStdin = fs.readFileSync(0, "utf8").trim() === process.env.GH_TOKEN
    record.configWasClean = !fs.existsSync(path.join(record.dockerConfig, "config.json"))
    fs.mkdirSync(record.dockerConfig, { recursive: true })
    fs.writeFileSync(path.join(record.dockerConfig, "config.json"), "authenticated")
  }
  if (args[0] === "logout") {
    fs.rmSync(path.join(record.dockerConfig, "config.json"), { force: true })
  }
  if (args[0] === "pull") {
    record.configWasClean = !!record.dockerConfig &&
      !fs.existsSync(path.join(record.dockerConfig, "config.json"))
  }
  if (args.includes("--metadata-file")) {
    const metadata = args[args.indexOf("--metadata-file") + 1]
    fs.mkdirSync(path.dirname(metadata), { recursive: true })
    fs.writeFileSync(metadata, JSON.stringify({
      "containerimage.digest": process.env.STUB_DIGEST || "sha256:" + "a".repeat(64)
    }))
  }
}
if (command === "gh" && args[0] === "release" && (args[1] === "edit" || args[1] === "create")) {
  const notesFile = args[args.indexOf("--notes-file") + 1]
  record.notes = notesFile ? fs.readFileSync(notesFile, "utf8") : null
}
fs.appendFileSync(process.env.STUB_RECORD, JSON.stringify(record) + "\n")
if (command === "docker" && args[0] === "buildx" && args[1] === "build" &&
    process.env.STUB_FAIL_BUILD === "1") {
  process.stderr.write("stub build failed\n")
  process.exit(1)
}
if (command === "docker" && args[0] === "pull" &&
    process.env.STUB_FAIL_PULL && args.join(" ").includes(process.env.STUB_FAIL_PULL)) {
  process.stderr.write("stub anonymous pull failed\n")
  process.exit(1)
}
if (command === "gh" && args[0] === "release" && args[1] === "view") {
  if (process.env.STUB_NO_RELEASE === "1") process.exit(1)
  process.stdout.write(process.env.STUB_EXISTING_NOTES || "")
}
if (command === "gh" && args[0] === "release" && args[1] === "list" &&
    process.env.STUB_FAIL_RELEASE_LIST === "1") {
  process.stderr.write("stub release lookup failed\n")
  process.exit(1)
}
`

function runPublish(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "smithers-publish-image-"))
  const bin = join(root, "bin")
  const recordFile = join(root, "commands.jsonl")
  const authenticatedConfig = join(root, "authenticated-docker")
  mkdirSync(bin)
  mkdirSync(authenticatedConfig)
  for (const command of ["docker", "gh"]) {
    writeFileSync(join(bin, command), commandStub, { mode: 0o755 })
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GH_TOKEN: "test-token",
    GITHUB_ACTOR: "publisher",
    GITHUB_REPOSITORY: "smithersai/smithers",
    DOCKER_CONFIG: authenticatedConfig,
    RUNNER_TEMP: root,
    STUB_RECORD: recordFile,
    ...options.env,
  }
  if (options.withoutCredentials) {
    delete env.GH_TOKEN
    delete env.GITHUB_ACTOR
  }
  const args = ["distribution/publish-image.sh", options.version ?? "1.2.3", options.buildSha ?? "b".repeat(40)]
  if (options.dryRun) args.push("--dry-run")
  const result = spawnSync("bash", args, {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
  })
  const commands = readFileSync(recordFile, { encoding: "utf8", flag: "a+" })
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
  rmSync(root, { recursive: true, force: true })
  return { result, commands }
}

function successful(result) {
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
}

function failedByScript(result) {
  assert.notEqual(result.status, 0)
  assert.notEqual(result.status, 127, `${result.stderr}\n${result.stdout}`)
}

function buildCommand(commands) {
  return commands.find(({ command, args }) => command === "docker" && args.includes("--push"))
}

function releaseWrites(commands) {
  return commands.filter(({ command, args }) => command === "gh" && args[0] === "release" && ["edit", "create"].includes(args[1]))
}

test("publishes a multi-platform image, verifies anonymous pulls, and preserves release notes", () => {
  const { result, commands } = runPublish({ env: { STUB_EXISTING_NOTES: "Existing release notes\n" } })
  successful(result)

  const loginIndex = commands.findIndex(({ command, args }) => command === "docker" && args[0] === "login")
  const build = buildCommand(commands)
  const buildIndex = commands.indexOf(build)
  const logoutIndex = commands.findIndex(({ command, args }) => command === "docker" && args[0] === "logout")
  assert.ok(loginIndex >= 0 && loginIndex < buildIndex && buildIndex < logoutIndex)
  assert.deepEqual(commands[loginIndex].args, ["login", "ghcr.io", "--username", "publisher", "--password-stdin"])
  assert.equal(commands[loginIndex].passwordFromStdin, true)
  assert.equal(commands[loginIndex].configWasClean, true)
  assert.deepEqual(build.args.slice(0, 2), ["buildx", "build"])
  for (const expected of [
    ["--platform", "linux/amd64,linux/arm64"],
    ["--build-arg", `BUILD_SHA=${"b".repeat(40)}`],
    ["--build-arg", "SMITHERS_DISTRIBUTION_VERSION=1.2.3"],
    ["-f", "distribution/Dockerfile"],
    ["--tag", tag],
  ]) {
    assert.ok(build.args.some((arg, index) => arg === expected[0] && build.args[index + 1] === expected[1]), expected.join(" "))
  }
  assert.equal(build.args.at(-1), ".")
  assert.ok(build.args.includes("--metadata-file"))

  const pulls = commands.filter(({ command, args }) => command === "docker" && args[0] === "pull")
  assert.deepEqual(pulls.map(({ args }) => [args[args.indexOf("--platform") + 1], args.at(-1)]), [
    ["linux/amd64", tag],
    ["linux/amd64", digestRef],
    ["linux/arm64", tag],
    ["linux/arm64", digestRef],
  ])
  assert.ok(pulls.every(({ configWasClean, dockerConfig }) => configWasClean && dockerConfig !== commands[loginIndex].dockerConfig))
  assert.ok(commands.indexOf(pulls[0]) > logoutIndex)

  const views = commands.filter(({ command, args }) => command === "gh" && args[0] === "release" && args[1] === "view")
  assert.deepEqual(views.map(({ args }) => args), [["release", "view", "v1.2.3", "--repo", "smithersai/smithers", "--json", "body", "--jq", ".body"]])
  const writes = releaseWrites(commands)
  assert.equal(writes.length, 1, JSON.stringify({ result, commands }))
  assert.deepEqual(writes[0].args.slice(0, 3), ["release", "edit", "v1.2.3"])
  assert.ok(writes[0].args.some((arg, index) => arg === "--repo" && writes[0].args[index + 1] === "smithersai/smithers"))
  assert.ok(writes[0].args.includes("--notes-file"))
  assert.match(writes[0].notes, /Existing release notes/)
  assert.ok(writes[0].notes.includes(digestRef))
  assert.ok(commands.indexOf(writes[0]) > commands.indexOf(pulls.at(-1)))
})

test("rerunning publication replaces the image section and keeps unrelated notes", () => {
  const oldDigestRef = `ghcr.io/smithersai/smithers@sha256:${"f".repeat(64)}`
  const existingNotes = [
    "Release intro",
    "<!-- smithers-image:start -->",
    "## Self-host image",
    "",
    `\`${oldDigestRef}\``,
    "<!-- smithers-image:end -->",
    "Unrelated tail",
    "",
  ].join("\n")
  const { result, commands } = runPublish({ env: { STUB_EXISTING_NOTES: existingNotes } })
  successful(result)
  const writes = releaseWrites(commands)
  assert.equal(writes.length, 1)
  const notes = writes[0].notes
  assert.equal(notes.split("<!-- smithers-image:start -->").length - 1, 1)
  assert.equal(notes.split("<!-- smithers-image:end -->").length - 1, 1)
  assert.equal(notes.split("## Self-host image").length - 1, 1)
  assert.ok(notes.includes(digestRef))
  assert.ok(!notes.includes(oldDigestRef))
  assert.ok(notes.includes("Release intro"))
  assert.ok(notes.includes("Unrelated tail"))
})

test("dry run builds the same platforms and source revision without credentials or release writes", () => {
  const { result, commands } = runPublish({ dryRun: true, withoutCredentials: true })
  successful(result)
  const builds = commands.filter(({ command, args }) => command === "docker" && args.slice(0, 2).join(" ") === "buildx build")
  assert.equal(builds.length, 1, JSON.stringify({ result, commands }))
  const args = builds[0].args
  assert.ok(args.some((arg, index) => arg === "--platform" && args[index + 1] === "linux/amd64,linux/arm64"))
  assert.ok(args.some((arg, index) => arg === "--build-arg" && args[index + 1] === `BUILD_SHA=${"b".repeat(40)}`))
  assert.ok(args.some((arg, index) => arg === "--build-arg" && args[index + 1] === "SMITHERS_DISTRIBUTION_VERSION=1.2.3"))
  assert.ok(args.some((arg, index) => arg === "-f" && args[index + 1] === "distribution/Dockerfile"))
  assert.ok(args.some((arg, index) => arg === "--output" && /^type=oci,dest=.+\/image\.tar$/.test(args[index + 1])))
  assert.equal(args.at(-1), ".")
  assert.ok(!args.includes("--push"))
  assert.ok(commands.every(({ command, args }) => command === "docker" && args[0] === "buildx"))
})

test("dry run stops when the OCI build fails", () => {
  const { result, commands } = runPublish({
    dryRun: true,
    withoutCredentials: true,
    env: { STUB_FAIL_BUILD: "1" },
  })
  failedByScript(result)
  assert.equal(commands.length, 1)
  assert.deepEqual(commands[0].args.slice(0, 2), ["buildx", "build"])
  assert.ok(commands[0].args.includes("--output"))
  assert.ok(!commands[0].args.includes("--push"))
})

test("creates a release with a verified tag and immutable digest when absent", () => {
  const { result, commands } = runPublish({ env: { STUB_NO_RELEASE: "1" } })
  successful(result)
  const viewIndex = commands.findIndex(({ command, args }) => command === "gh" && args[0] === "release" && args[1] === "view")
  const listIndex = commands.findIndex(({ command, args }) => command === "gh" && args[0] === "release" && args[1] === "list")
  assert.ok(viewIndex >= 0 && viewIndex < listIndex)
  assert.ok(commands[listIndex].args.some((arg, index) => arg === "--repo" && commands[listIndex].args[index + 1] === "smithersai/smithers"))
  const writes = releaseWrites(commands)
  assert.equal(writes.length, 1, JSON.stringify({ result, commands }))
  assert.ok(commands.indexOf(writes[0]) > listIndex)
  assert.deepEqual(writes[0].args.slice(0, 3), ["release", "create", "v1.2.3"])
  assert.ok(writes[0].args.some((arg, index) => arg === "--repo" && writes[0].args[index + 1] === "smithersai/smithers"))
  assert.ok(writes[0].args.includes("--verify-tag"))
  assert.ok(writes[0].args.includes("--notes-file"))
  assert.ok(writes[0].notes.includes(digestRef))
})

test("marks a new prerelease and records its immutable digest", () => {
  const { result, commands } = runPublish({
    version: "1.2.3-rc.1",
    env: { STUB_NO_RELEASE: "1" },
  })
  successful(result)
  const writes = releaseWrites(commands)
  assert.equal(writes.length, 1, JSON.stringify({ result, commands }))
  assert.deepEqual(writes[0].args.slice(0, 3), ["release", "create", "v1.2.3-rc.1"])
  assert.ok(writes[0].args.includes("--verify-tag"))
  assert.ok(writes[0].args.includes("--prerelease"))
  assert.ok(writes[0].notes.includes(digestRef))
})

test("a failed release lookup cannot create a release", () => {
  const { result, commands } = runPublish({
    env: { STUB_NO_RELEASE: "1", STUB_FAIL_RELEASE_LIST: "1" },
  })
  failedByScript(result)
  assert.ok(commands.some(({ command, args }) => command === "gh" && args[0] === "release" && args[1] === "list"))
  assert.equal(releaseWrites(commands).length, 0)
})

test("a failed push cannot update release notes", () => {
  const { result, commands } = runPublish({ env: { STUB_FAIL_BUILD: "1" } })
  failedByScript(result)
  assert.ok(buildCommand(commands))
  assert.equal(releaseWrites(commands).length, 0)
  assert.equal(commands.filter(({ command, args }) => command === "docker" && args[0] === "pull").length, 0)
})

test("a failed anonymous pull cannot update release notes", () => {
  const { result, commands } = runPublish({ env: { STUB_FAIL_PULL: digestRef } })
  failedByScript(result)
  assert.ok(commands.some(({ command, args }) => command === "docker" && args[0] === "pull" && args.at(-1) === digestRef))
  assert.equal(releaseWrites(commands).length, 0)
})

test("rejects a bad version before registry login", () => {
  const { result, commands } = runPublish({ version: "../bad" })
  failedByScript(result)
  assert.equal(commands.filter(({ command }) => command === "docker").length, 0)
  assert.equal(releaseWrites(commands).length, 0)
})

test("rejects a non-revision build SHA before registry login", () => {
  const { result, commands } = runPublish({ buildSha: "not-a-source-revision" })
  failedByScript(result)
  assert.equal(commands.length, 0)
})

test("refuses publication from a fork before registry login", () => {
  const { result, commands } = runPublish({ env: { GITHUB_REPOSITORY: "someone/smithers" } })
  failedByScript(result)
  assert.equal(commands.length, 0)
})

test("rejects invalid build metadata digest before release notes", () => {
  const { result, commands } = runPublish({ env: { STUB_DIGEST: "sha256:broken" } })
  failedByScript(result)
  assert.ok(buildCommand(commands))
  assert.equal(commands.filter(({ command, args }) => command === "docker" && args[0] === "pull").length, 0)
  assert.equal(releaseWrites(commands).length, 0)
})
