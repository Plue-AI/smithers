import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { assertEffectFamilyInstalled, installedEffectFamily, mcpInitialize } from "./release-mcp-handshake.mjs"

const run = promisify(execFile)

const scratch = async (t, prefix) => {
  const root = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const write = async (path, contents) => {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, contents)
}

/** A stdio MCP server that answers `initialize` the way `smthrs --mcp` does. */
const server = (body) => `#!/usr/bin/env node
const { createInterface } = require("node:readline")
const version = require("../package.json").version
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  ${body}
})
`
const answering = server(`process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "notifications/message" }) + "\\n")
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {}, serverInfo: { name: "fixture", version } } }) + "\\n")`)

test("answers initialize from a CLI installed out of its packed tarball into an empty project", async (t) => {
  const root = await scratch(t, "smthrs-mcp-handshake-")
  const source = join(root, "source")
  await write(join(source, "package.json"), JSON.stringify({ name: "fixture-cli", version: "9.8.7-rc.1", bin: { "fixture-cli": "./bin/cli.cjs" } }))
  await write(join(source, "bin/cli.cjs"), answering)
  const { stdout } = await run("npm", ["pack", "--silent", "--pack-destination", root], { cwd: source })
  const consumer = join(root, "consumer")
  await write(join(consumer, "package.json"), JSON.stringify({ private: true }))
  // An empty cache: nothing the workspace installed can satisfy the consumer.
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", "--cache", join(root, "empty-cache"),
    join(root, stdout.trim())], { cwd: consumer })
  const serverInfo = await mcpInitialize(join(consumer, "node_modules/.bin/fixture-cli"), ["--mcp"], { cwd: consumer, timeoutMs: 30_000 })
  assert.deepEqual(serverInfo, { name: "fixture", version: "9.8.7-rc.1" })
})

test("rejects every way a server can fail the handshake, with its stderr", async (t) => {
  const root = await scratch(t, "smthrs-mcp-failures-")
  await write(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }))
  const cases = [
    // What smithers-orchestrator@0.32.0 did under a drifted Effect install.
    ["exits", `console.error("error: Cannot find module 'effect/process/ChildProcess'"); process.exit(1)`,
      /exited with 1 before answering initialize[\s\S]*effect\/process\/ChildProcess/],
    ["error reply", `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "boom" } }) + "\\n")`,
      /MCP initialize failed: \{"code":-32603,"message":"boom"\}/],
    ["no serverInfo", `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n")`,
      /answered without serverInfo\.version/],
    ["non-JSON", `process.stdout.write("Listening on stdio\\n")`, /non-JSON line: Listening on stdio/],
    ["silent", `console.error("still starting")`, /timed out after 500 ms[\s\S]*still starting/]
  ]
  for (const [name, body, expected] of cases) {
    const script = join(root, "bin", `${name.replace(/\W/g, "-")}.cjs`)
    await write(script, server(body))
    await assert.rejects(mcpInitialize(process.execPath, [script], { cwd: root, timeoutMs: 500 }), expected, name)
  }
  await assert.rejects(mcpInitialize(join(root, "missing-binary"), [], { cwd: root }), /MCP server could not start/)
})

const effectPackage = async (directory, name, version) =>
  write(join(directory, "package.json"), JSON.stringify({ name, version }))

test("reads every Effect-family copy an npm-style nested tree resolved, once each", async (t) => {
  const root = await scratch(t, "smthrs-effect-npm-")
  const modules = join(root, "node_modules")
  await effectPackage(join(modules, "effect"), "effect", "4.0.0-rc.115")
  await effectPackage(join(modules, "@effect/platform-node"), "@effect/platform-node", "4.0.0-rc.115")
  // The #2398 shape: the adapter's caret edge nested a newer shared platform.
  await effectPackage(join(modules, "@effect/platform-node/node_modules/@effect/platform-node-shared"), "@effect/platform-node-shared", "4.0.0-rc.118")
  await effectPackage(join(modules, "@effect/platform-node/node_modules/@effect/platform-node-shared/node_modules/effect"), "effect", "4.0.0-rc.118")
  await effectPackage(join(modules, "unrelated"), "unrelated", "1.0.0")
  await mkdir(join(modules, ".bin"), { recursive: true })
  // A link to a copy already listed is the same copy.
  await mkdir(join(modules, "unrelated/node_modules"), { recursive: true })
  await symlink(join(modules, "effect"), join(modules, "unrelated/node_modules/effect"), "dir")
  assert.deepEqual(installedEffectFamily(root).map(({ name, version }) => `${name}@${version}`), [
    "@effect/platform-node@4.0.0-rc.115",
    "@effect/platform-node-shared@4.0.0-rc.118",
    "effect@4.0.0-rc.115",
    "effect@4.0.0-rc.118"
  ])
  assert.throws(() => assertEffectFamilyInstalled(root, "4.0.0-rc.115"), (error) => {
    assert.match(error.message, /Consumer resolved Effect-family packages off 4\.0\.0-rc\.115/)
    assert.match(error.message, /@effect\/platform-node-shared@4\.0\.0-rc\.118 at /)
    assert.match(error.message, /effect@4\.0\.0-rc\.118 at /)
    assert.doesNotMatch(error.message, /platform-node@/)
    return true
  })
})

test("reads a pnpm store and accepts a tree on the one family version", async (t) => {
  const root = await scratch(t, "smthrs-effect-pnpm-")
  const store = join(root, "node_modules/.pnpm")
  const effect = join(store, "effect@4.0.0-rc.115/node_modules/effect")
  const shared = join(store, "@effect+platform-node-shared@4.0.0-rc.115_effect@4.0.0-rc.115/node_modules/@effect/platform-node-shared")
  await effectPackage(effect, "effect", "4.0.0-rc.115")
  await effectPackage(shared, "@effect/platform-node-shared", "4.0.0-rc.115")
  await symlink(effect, join(store, "@effect+platform-node-shared@4.0.0-rc.115_effect@4.0.0-rc.115/node_modules/effect"), "dir")
  await mkdir(join(root, "node_modules/@effect"), { recursive: true })
  await symlink(shared, join(root, "node_modules/@effect/platform-node-shared"), "dir")
  await symlink(effect, join(root, "node_modules/effect"), "dir")
  await writeFile(join(store, "lock.yaml"), "")
  const installed = assertEffectFamilyInstalled(root, "4.0.0-rc.115")
  assert.deepEqual(installed.map(({ name, version }) => `${name}@${version}`), [
    "@effect/platform-node-shared@4.0.0-rc.115",
    "effect@4.0.0-rc.115"
  ])
})

test("fails a consumer that resolved no effect at all", async (t) => {
  const root = await scratch(t, "smthrs-effect-empty-")
  assert.deepEqual(installedEffectFamily(root), [])
  await effectPackage(join(root, "node_modules/@effect/platform-node"), "@effect/platform-node", "4.0.0-rc.115")
  assert.throws(() => assertEffectFamilyInstalled(root, "4.0.0-rc.115"), /no installed effect package/)
})
