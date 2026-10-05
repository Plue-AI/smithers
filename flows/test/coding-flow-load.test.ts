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
  const none = await tree("none", { "README.md": "No flows here.\n" })

  const output = join(temporary, "host.mjs")
  await bundle(fileURLToPath(new URL("./fixtures/coding-host-flow-load-entry.ts", import.meta.url)), output)
  const flags = process.versions.bun ? [] : ["--experimental-strip-types"]
  const lines = execFileSync(process.execPath, [...flags, output, copy, edited, broken, helperA, helperB, none], {
    encoding: "utf8",
    timeout: 240_000,
    stdio: ["ignore", "pipe", "pipe"]
  }).split("\n").filter((line) => line.startsWith("versions ")).map((line) => JSON.parse(line.slice(9)))
  const [atCopy, atEdited, atBroken, atHelperA, atHelperB, atNone] = lines

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
  assert.ok(Number(atBroken[0].error.match(/^flows\/todo\/flow\.ts:(\d+)/)[1]) >= line, atBroken[0].error)
  // A changed helper the composition imports is a new version; both load.
  assert.equal(atHelperA[0].status, "loaded", atHelperA[0].error)
  assert.equal(atHelperB[0].status, "loaded", atHelperB[0].error)
  assert.notEqual(atHelperA[0].digest, atHelperB[0].digest)
  assert.notEqual(atHelperA[0].digest, served.todo)
  // A repository without flows/ declares none.
  assert.deepEqual(atNone, [])
})
