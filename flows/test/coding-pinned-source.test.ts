/**
 * A TODO's pinned flow source (flows/repository/pinned.ts, spec §11.4.1),
 * read from a real Git store: the file at the pinned commit, never the
 * working copy; a commit the store lacks is imported once through the
 * stack's retained ref, else refused; a malformed pin spawns nothing.
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { repositorySource } from "../repository/pinned.ts"

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "user.name=Pinned", "-c", "user.email=pinned@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()

const commitAll = (cwd: string, message: string) => {
  git(cwd, "add", "-A")
  git(cwd, "commit", "-qm", message)
  return git(cwd, "rev-parse", "HEAD")
}

/** A repository with the flow at one commit, without it at the next, and another version in the working copy. */
const repository = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "coding-pinned-source-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, "init", "-q")
  await mkdir(join(root, "flows", "todo"), { recursive: true })
  await writeFile(join(root, "flows", "todo", "flow.ts"), "export default \"pinned\"\n")
  const withFlow = commitAll(root, "with the flow")
  git(root, "rm", "-q", "flows/todo/flow.ts")
  await writeFile(join(root, "README.md"), "# fixture\n")
  const without = commitAll(root, "without the flow")
  await mkdir(join(root, "flows", "todo"), { recursive: true })
  await writeFile(join(root, "flows", "todo", "flow.ts"), "export default \"working copy\"\n")
  return { root, withFlow, without }
}

const platform = NodeServices.layer

const reader = (
  root: string,
  fetch?: (commit: string) => Effect.Effect<void, string>,
  spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"]
) =>
  Effect.gen(function*() {
    return repositorySource(
      root,
      spawner ?? (yield* ChildProcessSpawner.ChildProcessSpawner),
      yield* FileSystem.FileSystem,
      yield* Path.Path,
      fetch
    )
  }).pipe(Effect.provide(platform), Effect.runPromise)

const read = (source: Awaited<ReturnType<typeof reader>>, commit: string, relative = "flows/todo/flow.ts") =>
  Effect.runPromise(source(commit, relative))

test("the pinned flow is read at its commit from the Git store, never from the working copy", async (t) => {
  const { root, withFlow, without } = await repository(t)
  const source = await reader(root)
  assert.equal(await read(source, withFlow), "export default \"pinned\"\n")
  assert.equal(await read(source, without), undefined, "a commit without the file answers none: the built-in")
  assert.equal(await read(source, withFlow, "flows/review/flow.ts"), undefined)
})

test("a commit the store lacks is imported once through the stack's retained ref, else refused", async (t) => {
  const { root, withFlow } = await repository(t)
  // Another clone holds a commit this one has not fetched.
  const other = await mkdtemp(join(tmpdir(), "coding-pinned-source-other-"))
  t.after(() => rm(other, { recursive: true, force: true }))
  git(other, "clone", "-q", root, ".")
  await mkdir(join(other, "flows", "todo"), { recursive: true })
  await writeFile(join(other, "flows", "todo", "flow.ts"), "export default \"retained\"\n")
  const retained = commitAll(other, "a version only the stack holds")
  const imported: Array<string> = []
  const importing = await reader(root, (commit) =>
    Effect.sync(() => {
      imported.push(commit)
      git(root, "fetch", "-q", other, commit)
    }))
  assert.equal(await read(importing, retained), "export default \"retained\"\n")
  assert.deepEqual(imported, [retained])
  // Present now, and a present commit is never imported again.
  assert.equal(await read(importing, retained), "export default \"retained\"\n")
  assert.equal(await read(importing, withFlow), "export default \"pinned\"\n")
  assert.deepEqual(imported, [retained])
  // An import that fails, or none at all, refuses with the reason.
  const missing = "a".repeat(40)
  const failing = await reader(root, () => Effect.fail("the lane has no retained ref"))
  await assert.rejects(read(failing, missing), /could not be imported: the lane has no retained ref/)
  await assert.rejects(read(await reader(root), missing), /is not in this repository/)
})

test("a pinned flow larger than its bound is refused", async (t) => {
  const { root } = await repository(t)
  await writeFile(join(root, "flows", "todo", "flow.ts"), `export default ${JSON.stringify("x".repeat(1_100_000))}\n`)
  const large = commitAll(root, "a flow over the bound")
  await assert.rejects(read(await reader(root), large), /exceeds 1000000 bytes/)
})

// Property: a pin whose commit is not 40 lowercase hex, or whose file is not
// flows/<name>/flow.ts, is refused before any process starts.
test("a malformed pin spawns nothing", async (t) => {
  const { root, withFlow } = await repository(t)
  let spawned = 0
  const counting = {
    spawn: () => {
      spawned++
      return Effect.die("a malformed pin must not spawn")
    }
  } as unknown as ChildProcessSpawner.ChildProcessSpawner["Service"]
  const source = await reader(root, undefined, counting)
  let seed = 0x5eed
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff)
  const alphabet = "0123456789abcdefABCDEF/.-_ g\n\0"
  const text = (length: number) => Array.from({ length }, () => alphabet[next() % alphabet.length]).join("")
  const commits = [
    withFlow.toUpperCase(),
    withFlow.slice(1),
    `${withFlow}0`,
    `${withFlow.slice(0, 39)}g`,
    `-${withFlow.slice(1)}`,
    ...Array.from({ length: 200 }, () => text(next() % 45))
  ].filter((value) => !/^[0-9a-f]{40}$/.test(value))
  for (const commit of commits) {
    await assert.rejects(read(source, commit), /is not a commit and flow file/, commit)
  }
  const paths = [
    "flows/todo/../todo/flow.ts",
    "/flows/todo/flow.ts",
    "flows/Todo/flow.ts",
    "flows/todo/flow.js",
    "flows/todo/sub/flow.ts",
    "flows/-todo/flow.ts",
    ...Array.from({ length: 200 }, () => `flows/${text(next() % 12)}/flow.ts`)
  ].filter((value) => !/^flows\/[a-z][a-z0-9-]*\/flow\.ts$/.test(value))
  for (const relative of paths) {
    await assert.rejects(read(source, withFlow, relative), /is not a commit and flow file/, relative)
  }
  assert.ok(commits.length > 100 && paths.length > 100)
  assert.equal(spawned, 0)
})
