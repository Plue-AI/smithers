/**
 * flow-load (engineering spec §11.3.1, C-J5-02) on the packaged coding host:
 * each overridable flow a repository declares at one commit is loaded with
 * the host's own loader and answered as one version, its digest and whether
 * it loaded. The oracles are literal fixture trees and the built-in digest
 * the backend serves (services/builtin_flows.json).
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { bundle } from "../coding/build.mjs"

const builtin = fileURLToPath(new URL("../todo/flow.ts", import.meta.url))
const served: Record<string, string> = JSON.parse(
  await readFile(new URL("../../packages/backend/internal/services/builtin_flows.json", import.meta.url), "utf8")
)

test("flow-load answers each overridable flow's version and whether it loaded", { timeout: 300_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-flow-load-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const source = await readFile(builtin, "utf8")
  const tree = async (name: string, files: Record<string, string>) => {
    const root = join(temporary, name)
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true })
      await writeFile(join(root, path), text)
    }
    return root
  }
  // A byte-identical copy of the built-in composition, and the same copy
  // beside a system name a repository cannot take.
  const copy = await tree("copy", {
    "flows/todo/flow.ts": source,
    "flows/merge/flow.ts": "export default {}\n",
    "src/index.ts": "export const unrelated = 1\n"
  })
  // The scripted [FLOWEDIT] change: the composition plus a changelog step.
  const edited = await tree("edited", {
    "flows/todo/flow.ts": source.replace(
      "Request.child(input)",
      "Request.child({ ...input, prompt: `${input.prompt}\\n\\n[CHANGELOG] Add one line for this change to CHANGELOG.md.` })"
    )
  })
  // A syntax error on one line of the composition.
  const broken = await tree("broken", {
    "flows/todo/flow.ts": source.replace("Request.child(input)", "Request.child(input")
  })
  // A composition that imports a helper; the helper's bytes are its version.
  const withHelper = (value: string) =>
    tree(`helper-${value}`, {
      "flows/todo/flow.ts": `import { label } from "./label.ts"\n${source}\nvoid label\n`,
      "flows/todo/label.ts": `export const label = ${JSON.stringify(value)}\n`
    })
  const [helperA, helperB] = [await withHelper("a"), await withHelper("b")]
  const outsideA = await tree("outside-a", {
    "flows/todo/flow.ts": `import { label } from "../../lib/label.ts"\n${source}\nvoid label\n`,
    "lib/label.ts": "export const label = 'a'\n"
  })
  const outsideB = await tree("outside-b", {
    "flows/todo/flow.ts": `import { label } from "../../lib/label.ts"\n${source}\nvoid label\n`,
    "lib/label.ts": "export const label = 'b'\n"
  })
  const lockA = await tree("lock-a", { "flows/todo/flow.ts": source, "pnpm-lock.yaml": "lockfileVersion: 9\n# a\n" })
  const lockB = await tree("lock-b", { "flows/todo/flow.ts": source, "pnpm-lock.yaml": "lockfileVersion: 9\n# b\n" })
  const manager = await tree("bin", {
    "pnpm": `#!/bin/sh
case "$PWD" in
  */install-failed) exit 1 ;;
  */lock-mutated) printf changed > pnpm-lock.yaml ;;
  */other-lock-mutated) printf changed > package-lock.json ;;
esac
printf '%s' "$*" > installed
`
  })
  await (await import("node:fs/promises")).chmod(join(manager, "pnpm"), 0o700)
  const importCanary = (name: string) =>
    `import { writeFileSync } from "node:fs"\nwriteFileSync(${
      JSON.stringify(join(temporary, "import-" + name))
    }, "evaluated")\n${source}`
  const canaryLoaded = await tree("canary-loaded", {
    "flows/todo/flow.ts": importCanary("loaded"),
    "pnpm-lock.yaml": "lockfileVersion: 9\n"
  })
  const installFailed = await tree("install-failed", {
    "flows/todo/flow.ts": importCanary("failed"),
    "pnpm-lock.yaml": "lockfileVersion: 9\n"
  })
  const lockMutated = await tree("lock-mutated", {
    "flows/todo/flow.ts": importCanary("mutated"),
    "pnpm-lock.yaml": "lockfileVersion: 9\n"
  })
  const otherLockMutated = await tree("other-lock-mutated", {
    "flows/todo/flow.ts": source,
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
    "package-lock.json": "{}\n"
  })
  const none = await tree("none", { "README.md": "No flows here.\n" })

  const output = join(temporary, "host.mjs")
  await bundle(fileURLToPath(new URL("./fixtures/coding-host-flow-load-entry.ts", import.meta.url)), output)
  const flags = process.versions.bun ? [] : ["--experimental-strip-types"]
  const lines = execFileSync(process.execPath, [
    ...flags,
    output,
    copy,
    edited,
    broken,
    helperA,
    helperB,
    none,
    lockA,
    lockB,
    outsideA,
    outsideB,
    installFailed,
    lockMutated,
    otherLockMutated,
    canaryLoaded
  ], {
    env: { ...process.env, CODING_TEST_MANAGER_PATH: manager + ":/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 240_000,
    stdio: ["ignore", "pipe", "pipe"]
  }).split("\n").filter((line) => line.startsWith("versions ")).map((line) => JSON.parse(line.slice(9)))
  const [
    atCopy,
    atEdited,
    atBroken,
    atHelperA,
    atHelperB,
    atNone,
    atLockA,
    atLockB,
    atOutsideA,
    atOutsideB,
    atInstallFailed,
    atLockMutated,
    atOtherLockMutated,
    atCanaryLoaded
  ] = lines

  // The copy is the built-in version: the digest GET /api/flows serves as D1.
  assert.deepEqual(atCopy, [{ name: "todo", path: "flows/todo/flow.ts", digest: served.todo, status: "loaded" }])
  // The edit loads as a new version.
  assert.equal(atEdited.length, 1)
  assert.equal(atEdited[0].status, "loaded")
  assert.match(atEdited[0].digest, /^[0-9a-f]{64}$/)
  assert.notEqual(atEdited[0].digest, served.todo)
  // A broken composition is a failed version whose error names the file and line.
  assert.equal(atBroken.length, 1)
  assert.equal(atBroken[0].status, "failed")
  assert.notEqual(atBroken[0].digest, served.todo)
  const line = source.split("\n").findIndex((text) => text.includes("Request.child(input)")) + 1
  assert.ok(line > 0)
  assert.match(atBroken[0].error, /^flows\/todo\/flow\.ts:\d+: /)
  assert.ok(Number(atBroken[0].error.match(/^flows\/todo\/flow\.ts:(\d+)/)![1]) >= line, atBroken[0].error)
  // A changed helper the composition imports is a new version; both load.
  assert.equal(atHelperA[0].status, "loaded", atHelperA[0].error)
  assert.equal(atHelperB[0].status, "loaded", atHelperB[0].error)
  assert.notEqual(atHelperA[0].digest, atHelperB[0].digest)
  assert.deepEqual(atHelperA[0].dependencies, ["flows/todo/label.ts"])
  assert.notEqual(atHelperA[0].digest, served.todo)
  // A repository without flows/ declares none.
  assert.deepEqual(atNone, [])
  assert.equal(atLockA[0].status, "loaded")
  assert.equal(atLockB[0].status, "loaded")
  assert.notEqual(atLockA[0].digest, served.todo)
  assert.notEqual(atLockA[0].digest, atLockB[0].digest)
  assert.equal(atOutsideA[0].status, "loaded", atOutsideA[0].error)
  assert.equal(atOutsideB[0].status, "loaded", atOutsideB[0].error)
  assert.deepEqual(atOutsideA[0].dependencies, ["lib/label.ts"])
  assert.notEqual(atOutsideA[0].digest, atOutsideB[0].digest)
  assert.equal(await readFile(join(lockA, "installed"), "utf8"), "install --frozen-lockfile")
  assert.equal(await readFile(join(lockB, "installed"), "utf8"), "install --frozen-lockfile")
  assert.equal(atInstallFailed[0].status, "failed")
  assert.match(atInstallFailed[0].error, /Pinned flow dependencies could not be resolved/)
  assert.doesNotMatch(atInstallFailed[0].error, /repository evaluated/)
  assert.equal(atLockMutated[0].status, "failed")
  assert.match(atLockMutated[0].error, /installation changed its lockfile/)
  assert.equal(atOtherLockMutated[0].status, "failed")
  assert.match(atOtherLockMutated[0].error, /installation changed its lockfiles/)
  await assert.rejects(readFile(join(temporary, "import-failed")), { code: "ENOENT" })
  await assert.rejects(readFile(join(temporary, "import-mutated")), { code: "ENOENT" })
  assert.equal(atCanaryLoaded[0].status, "loaded", atCanaryLoaded[0].error)
  assert.equal(await readFile(join(temporary, "import-loaded"), "utf8"), "evaluated")
})
