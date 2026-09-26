/**
 * A rebase must replay every target whose inputs did not change.
 *
 * Coding checks run each revision of a rebased stack in a fresh export at a
 * new absolute path. Keys therefore must not carry the checkout path, commit
 * or change ids, or history: only declared content. `scripts/bench/rebase-cache.mjs`
 * measures the same property on this repository's graph.
 *
 * @since 1.0.0
 */
import { Smithers as S } from "@smthrs/targets"
import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, expect, it } from "vitest"
import * as GoExec from "../src/GoExec.ts"
import { plan } from "../src/internal/PackagePlanner.ts"
import { execute } from "../src/internal/PackageRunner.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const files: Readonly<Record<string, string>> = {
  "package.json": "{}",
  "yarn.lock": "",
  "README.md": "fixture\n",
  "a/PACKAGE.ts": "",
  "a/src/value.mjs": "export const value = 1\n",
  "b/PACKAGE.ts": "",
  "b/src/use.mjs": "export const use = 2\n",
  "b/test.mjs": "process.exit(0)\n",
  "c/PACKAGE.ts": "",
  "c/src/other.mjs": "export const other = 3\n",
  "c/test.mjs": "process.exit(0)\n"
}

const write = async (root: string, name: string, contents: string): Promise<void> => {
  await Fs.mkdir(Path.dirname(Path.join(root, name)), { recursive: true })
  await Fs.writeFile(Path.join(root, name), contents)
}

const checkout = async (label: string): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), `smithers-rebase-${label}-`)))
  temporary.push(root)
  for (const [name, contents] of Object.entries(files)) await write(root, name, contents)
  return root
}

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  ChildProcess.execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t.t", ...args], {
    encoding: "utf8"
  }).trim()

const indexOf = (root: string) => {
  const a = S.Filegroup({ cwd: "a", srcs: [S.glob("src/**")] })
  const b = S.NodeTest({
    runner: S.testRunner([S.file("//b/test.mjs")]),
    srcs: [S.glob("//b/src/**")],
    deps: [a],
    cache: true
  })
  const c = S.NodeTest({
    runner: S.testRunner([S.file("//c/test.mjs")]),
    srcs: [S.glob("//c/src/**")],
    deps: [],
    cache: true
  })
  const packageJson = S.file("//package.json")
  return PackageIndex.make({
    root,
    workspace: S.Workspace("rebase", {
      repository: "git+https://example.invalid/rebase.git",
      cache: S.Cache({ directory: ".flows" }),
      runtime: S.Runtime.Node({ version: ">=24" }),
      packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
      nodeModules: S.Npm.NodeModules({ packageJson })
    }),
    factory: undefined,
    packages: [
      { file: "a/PACKAGE.ts", packagePath: "a", value: S.Package({ targets: { a } }) },
      { file: "b/PACKAGE.ts", packagePath: "b", value: S.Package({ targets: { b } }) },
      { file: "c/PACKAGE.ts", packagePath: "c", value: S.Package({ targets: { c } }) }
    ]
  })
}

const labels = ["//a:a", "//b:b", "//c:c"] as const

const keysOf = async (root: string): Promise<Record<string, string>> => {
  const index = indexOf(root)
  const keys: Record<string, string> = {}
  for (const label of labels) {
    const planned = await plan({ index, cacheDirectory: ".flows", verb: "auto", patterns: [label] })
    const node = planned.nodes.get(label)!
    expect(node.cacheable, label).toBe(true)
    keys[label] = node.keyPreview
  }
  return keys
}

it("keys only declared content: path, history, and unrelated files never move a key", async () => {
  const plain = await checkout("plain")
  const rebased = await checkout("rebased")
  // A second history: different commit ids and an extra commit that touches
  // no declared input, as a rebase onto an unrelated change does.
  git(rebased, "init", "-q")
  git(rebased, "add", "-A")
  git(rebased, "commit", "-qm", "base")
  await write(rebased, "README.md", "an unrelated change below the stack\n")
  git(rebased, "commit", "-qam", "unrelated")

  const original = await keysOf(plain)
  expect(await keysOf(rebased)).toEqual(original)

  // Touching `a` re-keys `a` and its dependent `b`, never the independent `c`.
  await write(rebased, "a/src/value.mjs", "export const value = 10\n")
  const edited = await keysOf(rebased)
  expect(edited["//a:a"]).not.toBe(original["//a:a"])
  expect(edited["//b:b"]).not.toBe(original["//b:b"])
  expect(edited["//c:c"]).toBe(original["//c:c"])

  // Adding a matched file re-keys; removing it restores the original keys.
  await write(rebased, "a/src/value.mjs", files["a/src/value.mjs"]!)
  await write(rebased, "a/src/added.mjs", "export const added = 1\n")
  const added = await keysOf(rebased)
  expect(added["//b:b"]).not.toBe(original["//b:b"])
  expect(added["//c:c"]).toBe(original["//c:c"])
  await Fs.rm(Path.join(rebased, "a/src/added.mjs"))
  expect(await keysOf(rebased)).toEqual(original)
}, 180_000)

it("replays a verdict from a cache carried into a fresh checkout at another path", async () => {
  const first = await checkout("first")
  const second = await checkout("second")
  // Each check export plans and executes its own tree.
  const executeAt = async (root: string) => {
    const index = indexOf(root)
    const planned = await plan({ index, cacheDirectory: ".flows", verb: "test", patterns: ["//c:c"] })
    const summary = await execute(planned, {
      index,
      cacheDirectory: ".flows",
      verb: "test",
      patterns: ["//c:c"],
      log: () => {}
    })
    return summary.results.find((row) => row.label === "//c:c")!
  }
  const cold = await executeAt(first)
  expect(cold.status).toBe("ran")
  await Fs.cp(Path.join(first, ".flows", "cache"), Path.join(second, ".flows", "cache"), { recursive: true })
  const warm = await executeAt(second)
  expect(warm.status).toBe("hit")
  expect(warm.key).toBe(cold.key)
}, 180_000)

it("keeps Go module caches workspace-relative in planned environments", async () => {
  const root = await checkout("go")
  const planned = await GoExec.planRule("Go.ModDownload", { outDirs: [".gomodcache"] }, {
    root,
    packagePath: "",
    workspace: indexOf(root).workspace
  }, "/usr/bin/go")
  expect(planned.env["GOMODCACHE"]).toBe(".gomodcache")
  expect(JSON.stringify(planned.env)).not.toContain(root)
})
