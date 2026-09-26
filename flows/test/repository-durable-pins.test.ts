import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding, type NativeRevision } from "../coding/native.ts"
import { captureRepository } from "../repository/inspection.ts"

const exporter = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
const gate = {
  skip: exporter === undefined ? "Set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to the native source exporter" : false,
  timeout: 120_000
}

/**
 * One repository host holding an ordinary automation workspace: a bookmarked
 * history the repository publishes, and an empty working-copy commit over it
 * that only this workspace has ever held. A second clone of the same repository
 * stands in for the workspace that replaces it.
 */
async function fixture(t: TestContext) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "repository-durable-pins-")))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, "host"), fresh = join(temporary, "fresh")
  const jj = (path: string, ...args: string[]) =>
    execFileSync("jj", ["-R", path, ...args], { stdio: "pipe" }).toString()
  execFileSync("jj", ["git", "init", "--colocate", root], { stdio: "pipe" })
  jj(root, "config", "set", "--repo", "user.name", "Durable pins test")
  jj(root, "config", "set", "--repo", "user.email", "durable-pins@example.invalid")
  await writeFile(join(root, "README.md"), "# canary-sandbox\n\n## Purpose\nA disposable fixture.\n")
  jj(root, "describe", "-m", "seed the canary sandbox")
  jj(root, "bookmark", "create", "main", "-r", "@")
  jj(root, "new")
  const published = jj(root, "--ignore-working-copy", "log", "--no-graph", "-r", "main", "-T", "commit_id").trim()
  execFileSync("jj", ["git", "clone", join(root, ".git"), fresh], { stdio: "pipe" })
  const at = () =>
    JSON.parse(jj(root, "--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "json(self)")).id as string
  const revision = (): Extract<NativeRevision, { kind: "resolved" }> => {
    const [raw, empty] = jj(
      root,
      "--ignore-working-copy",
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      "json(self) ++ \"\t\" ++ empty"
    ).split("\t")
    const value = JSON.parse(raw!)
    const tree = JSON.parse(execFileSync(exporter!, [root, value.commit_id, temporary], { stdio: "pipe" }).toString())
    return {
      kind: "resolved",
      changeId: tree.changeId,
      commitId: tree.commitId,
      treeId: tree.treeId,
      operationId: at(),
      parentCommitIds: value.parents,
      empty: empty === "true"
    }
  }
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const options = {
    repositoryPath: root,
    fs,
    exporterPath: exporter,
    environment: { PATH: process.env.PATH!, HOME: temporary }
  }
  const native: NativeCoding["Service"] = {
    sourcePublication: "cloud",
    read: () =>
      Effect.sync(() => ({
        status: "read" as const,
        operationId: at(),
        head: revision(),
        revisions: [],
        capabilities: []
      })),
    apply: () => Effect.die("editing mutations are forbidden"),
    publishOriginalSource: () => Effect.die("unexpected publication"),
    createSource: () => Effect.die("unexpected source creation")
  }
  const owned = Layer.merge(
    Layer.succeed(NativeCoding, native),
    Jj.layerNoop({
      snapshot: () =>
        Effect.sync(() => {
          jj(root, "status")
          const current = revision()
          return { commitId: current.commitId, changeId: current.changeId }
        })
    })
  )
    .pipe(Layer.provideMerge(NodeServices.layer))
  /** What the replacement workspace's own repository can resolve. */
  const resolvesOnFreshClone = (commitId: string) =>
    execFileSync("jj", [
      "-R",
      fresh,
      "--ignore-working-copy",
      "log",
      "--no-graph",
      "-r",
      `commit_id("${commitId}")`,
      "-T",
      "commit_id"
    ], { stdio: "pipe" }).toString().trim() === commitId
  const workingCopy = () => jj(root, "--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "commit_id").trim()
  const capture = (mode: "snapshot" | "immutable") =>
    Effect.runPromise(
      captureRepository(options, { repo: "example/repo", prompt: "README.md" }, mode).pipe(Effect.provide(owned))
    )
  return { root, fresh, published, capture, resolvesOnFreshClone, workingCopy }
}

for (const mode of ["snapshot", "immutable"] as const) {
  test(
    `the commit an inspection pins is published history a replacement workspace resolves (${mode})`,
    gate,
    async (t) => {
      const f = await fixture(t)
      assert.equal(f.resolvesOnFreshClone(f.published), true, "the fixture's published history reaches a fresh clone")
      assert.equal(
        f.resolvesOnFreshClone(f.workingCopy()),
        false,
        "and this workspace's own working-copy commit does not"
      )

      const evidence = await f.capture(mode)
      assert.equal(
        evidence.source.commitId,
        f.published,
        "the pin is the repository head this host holds, not its snapshot"
      )
      assert.equal(
        f.resolvesOnFreshClone(evidence.source.commitId),
        true,
        `a case pinned to ${
          evidence.source.commitId.slice(0, 12)
        } cannot be evaluated on the workspace that replaces this one`
      )
      assert.equal(
        evidence.files.find((file) => file.path === "README.md")?.text.includes("A disposable fixture."),
        true,
        "the pinned commit is the source the inspection actually read"
      )
    }
  )
}

test("two inspections of one unchanged repository pin the same commit", gate, async (t) => {
  const f = await fixture(t)
  const first = await f.capture("snapshot")
  const second = await f.capture("snapshot")
  assert.equal(first.source.commitId, second.source.commitId)
  assert.equal(first.source.commitId, f.published)
})
