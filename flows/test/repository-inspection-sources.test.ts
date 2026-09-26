import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { readRepositorySources } from "../repository/inspection.ts"

// The canary's own checks step prompt, which names manifests but no directory.
const prompt =
  "Ground every run in what this repository actually contains. First inventory the tree for CI workflow files, " +
  "build/test manifests (package.json, Makefile, tox.ini, pyproject.toml, etc.) and runnable scripts, and list what you found."

test("the inspect records the workflow directory it looked at, present or absent", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "repository-inspection-sources-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "README.md"), "# canary\n\nA disposable fixture.\n")
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const read = () =>
    Effect.runPromise(
      readRepositorySources({ fs, repositoryPath: root }, root, prompt).pipe(Effect.provide(NodeServices.layer))
    )
  const bare = await read()
  assert.deepEqual(bare.sources.map((file) => file.path), ["README.md"], "this captured tree holds only README.md")
  assert.ok(
    bare.missing.includes(".github/workflows"),
    "a repository with no workflow directory says the inspect looked there"
  )
  assert.deepEqual(bare.missing.filter((path) => path !== ".github/workflows"), [
    "package.json",
    "tox.ini",
    "pyproject.toml"
  ], "the prompt's own manifests stay recorded misses")
  await mkdir(join(root, ".github", "workflows"), { recursive: true })
  await writeFile(join(root, ".github", "workflows", "ci.yml"), "name: ci\non: push\n")
  const configured = await read()
  assert.ok(
    configured.sources.some((file) => file.path === ".github/workflows/ci.yml"),
    "an existing workflow file is read as evidence"
  )
  assert.ok(!configured.missing.includes(".github/workflows"), "a directory that exists is never reported as absent")
})
