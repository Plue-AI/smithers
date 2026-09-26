import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Graph } from "@smthrs/flow"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Option } from "effect"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { buildProductHost } from "./build.mjs"
import history from "./history/flow.ts"
import { catalog } from "./host.ts"

const exec = promisify(execFile)
test("catalog keeps write-once artifact identity and honest configured model metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "librarian-identity-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = {
    root,
    stateRoot: join(root, "state"),
    repo: "test/repo",
    gatewayId: "test",
    credential: "test",
    artifactDigest: "a".repeat(64),
    sourceRevision: "b".repeat(40),
    ownerGeneration: 1,
    model: "openai:test"
  }
  const first = await catalog(options), again = await catalog(options)
  for (const [index, entry] of first.entries()) {
    assert.deepEqual(entry.descriptor, again[index]!.descriptor)
    assert.equal(Option.getOrThrow(entry.descriptor.model), "openai:test")
    assert.equal(
      await readFile(entry.descriptor.path, "utf8"),
      JSON.stringify({ artifact: options.artifactDigest, flow: entry.descriptor.name })
    )
  }
  const path = first[0]!.descriptor.path
  await chmod(path, 0o644)
  await writeFile(path, "tampered")
  await assert.rejects(catalog(options), /identity was modified/)
})

test("the product flow is its own delegate and carries the declaration's authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "librarian-collapse-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = {
    root,
    stateRoot: join(root, "state"),
    repo: "test/repo",
    gatewayId: "test",
    credential: "test",
    artifactDigest: "b".repeat(64),
    sourceRevision: "c".repeat(40),
    ownerGeneration: 1,
    model: "openai:test"
  }
  const entries = await catalog(options)

  assert.deepEqual(entries.map((entry) => entry.descriptor.name), ["librarian/history"])
  for (const entry of entries) {
    // The module IS the flow, so the descriptor names no delegate at all.
    assert.deepEqual(entry.descriptor.flows, [])
    // This host implements the action, so its own catalog still offers it,
    // while the declaration says `modelInvocable: false` for every other scan.
    assert.equal(entry.descriptor.modelInvocable, true)
  }
  assert.deepEqual(entries[0]!.descriptor.capabilities, ["fs:read:**", "fs:write:.git/**"])
  assert.deepEqual(entries[0]!.descriptor.effects.writes, [
    ".git/objects/**",
    ".git/refs/heads/mythical",
    ".git/refs/notes/mythical"
  ])

  // The flow's payload is the caller's own input, and its whole body is the
  // one action this host implements. That is what a delegating declaration
  // plus a wrapper flow used to say between two values.
  const calls = Graph.nodes(Graph.build(history, { repo: "test/repo" }))
    .filter((node) => node.kind === "ActionCall")
  assert.deepEqual(calls.map((node) => (node.draft.material.body as { action: string }).action), [
    "librarian/create-history"
  ])
  assert.deepEqual({ ...calls[0]!.payload as object }, { repo: "test/repo" })

  // A host that registers no delegate at all still makes it runnable,
  // because the module default-exports the flow it declares.
  const delegates = await Effect.runPromise(
    Effect.forEach(entries, (entry) =>
      Executable.fromDescriptor(entry.descriptor, {
        delegates: [],
        load: () => Effect.succeed({ default: entry.declaration })
      }).pipe(Effect.map((executable) => executable.delegate ?? "self"))).pipe(
        Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
      )
  )
  assert.deepEqual(delegates, ["self"])
})

test(
  "built artifact regenerates its sidecar and refuses off-loopback transcript startup",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "librarian-artifact-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    const artifact = join(root, "smithers.mjs")
    const digest = await buildProductHost(artifact)
    assert.equal(digest, createHash("sha256").update(await readFile(artifact)).digest("hex"))
    assert.equal(await readFile(`${artifact}.sha256`, "utf8"), `${digest}  smithers.mjs\n`)
    for (const record of ["0", "1"]) {
      await assert.rejects(
        exec(process.execPath, [artifact, "serve", "--root", resolve(root)], {
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            SMITHERS_LIBRARIAN_TRANSCRIPTS: root,
            SMITHERS_PRODUCT_API_URL: "https://example.com",
            SMITHERS_LIBRARIAN_RECORD: record
          }
        }),
        (error) => /loopback SMITHERS_PRODUCT_API_URL/.test(String((error as { stderr: string }).stderr))
      )
    }
  }
)
