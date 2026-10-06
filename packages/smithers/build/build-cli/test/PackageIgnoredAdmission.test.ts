import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const git = (root: string, ...args: ReadonlyArray<string>): void => {
  NodeChildProcess.execFileSync("git", ["-C", root, ...args])
}

const fixture = async (declareHostDirectory = true, rust = false): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-ignored-admission-")))
  roots.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows"${declareHostDirectory ? ", hostDirectories: [\"go-cache\"]" : ""} }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson })${
      rust ? ",\n  toolchains: [S.Rust.Toolchain({ workspace: S.file(\"//Cargo.toml\"), channel: \"stable\" })]" : ""
    }
})
`
  )
  await write(root, "package.json", "{\"name\":\"fixture\",\"private\":true}\n")
  await write(root, "yarn.lock", "")
  await write(root, ".gitignore", "go-cache/\ntarget/\ndocs/private.tmp\n")
  if (rust) await write(root, "Cargo.toml", "[workspace]\nmembers = []\n")
  await write(root, "docs/output.md", "before\n")
  await write(root, "docs/private.tmp", "secret\n")
  await write(root, "go-cache/owned.txt", "tracked\n")
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  docs: S.Shell.Diff({ shell: "printf 'after\\n' > docs/output.md", changes: ["docs/**"], sandbox: "none" }),
  docsCurrent: S.Shell.Diff({ shell: "printf 'before\\n' > docs/output.md", changes: ["docs/**"], sandbox: "none" }),
  generated: S.Generate({ command: "printf 'generated\\n'", stdout: "docs/generated.md" }),
  badDocs: S.Shell.Diff({ shell: "printf 'after\\n' > docs/output.md && printf leaked > docs/private.tmp", changes: ["docs/output.md"], sandbox: "none" }),
  badCacheTracked: S.Shell.Diff({ shell: "printf 'after\\n' > docs/output.md && printf leaked > go-cache/owned.txt", changes: ["docs/output.md"], sandbox: "none" }),
  cacheWrite: S.Shell.Diff({ shell: "printf 'after\\n' > docs/output.md && printf rebuilt > go-cache/new.bin", changes: ["docs/output.md"], sandbox: "none" }),
  failedDocs: S.Shell.Diff({ shell: "printf 'partial\\n' > docs/output.md && exit 1", changes: ["docs/**"], sandbox: "none" })
} })
`
  )
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "add", "-f", "go-cache/owned.txt")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  const cache = NodePath.join(root, "go-cache", "pkg", "mod", "cache.bin")
  await Fs.mkdir(NodePath.dirname(cache), { recursive: true })
  const handle = await Fs.open(cache, "w")
  try {
    await handle.truncate(1024 * 1024 * 1024 + 1)
  } finally {
    await handle.close()
  }
  return root
}

it.skipIf(process.platform === "win32")(
  "runs a docs target beside a declared oversized ignored Go cache",
  async () => {
    const root = await fixture()
    const result = await serve(root, ["//:docs", "--write"])
    expect(result.exitCode, result.output + result.logs).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "docs/output.md"), "utf8")).toBe("after\n")
    expect((await Fs.stat(NodePath.join(root, "go-cache/pkg/mod/cache.bin"))).size).toBe(1024 * 1024 * 1024 + 1)
    expect(await Fs.readFile(NodePath.join(root, "docs/private.tmp"), "utf8")).toBe("secret\n")
  }
)

it.skipIf(process.platform === "win32")(
  "runs a Generate target beside a declared oversized ignored Go cache",
  async () => {
    const root = await fixture()
    const result = await serve(root, ["//:generated", "--write"])
    expect(result.exitCode, result.output + result.logs).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "docs/generated.md"), "utf8")).toBe("generated\n")
    expect((await Fs.stat(NodePath.join(root, "go-cache/pkg/mod/cache.bin"))).size).toBe(1024 * 1024 * 1024 + 1)
  }
)

it.skipIf(process.platform === "win32")(
  "still refuses an oversized ignored Go cache without explicit host ownership",
  async () => {
    const root = await fixture(false)
    const result = await serve(root, ["//:docs", "--write"])
    expect(result.exitCode).toBe(1)
    expect(result.output + result.logs).toContain(
      "the write-set guard cannot restore the gitignored tree: more than 1073741824 bytes"
    )
    expect(await Fs.readFile(NodePath.join(root, "docs/output.md"), "utf8")).toBe("before\n")
  }
)

it.skipIf(process.platform === "win32")(
  "admits a declared cache above the ignored entry ceiling and refuses it when undeclared",
  async () => {
    const root = await fixture()
    // The existing cache file and docs/private.tmp bring this to 50,001 ignored files.
    const directory = NodePath.join(root, "go-cache", "entries")
    await Fs.mkdir(directory, { recursive: true })
    await Fs.truncate(NodePath.join(root, "go-cache/pkg/mod/cache.bin"), 0)
    let next = 0
    await Promise.all(Array.from({ length: 64 }, async () => {
      while (next < 49_999) {
        const index = next++
        await Fs.writeFile(NodePath.join(directory, `${index}.bin`), "")
      }
    }))

    const admitted = await serve(root, ["//:generated", "--write"])
    expect(admitted.exitCode, admitted.output + admitted.logs).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "docs/generated.md"), "utf8")).toBe("generated\n")
    // Check mode runs in a scratch copy and measures portals itself; the
    // declared cache stays outside that census too.
    const checked = await serve(root, ["//:docsCurrent"])
    expect(checked.exitCode, checked.output + checked.logs).toBe(0)

    await write(root, "docs/generated.md", "keep\n")
    const workspace = await Fs.readFile(NodePath.join(root, "WORKSPACE.ts"), "utf8")
    expect(workspace).toContain(", hostDirectories: [\"go-cache\"]")
    await write(root, "WORKSPACE.ts", workspace.replace(", hostDirectories: [\"go-cache\"]", ""))
    const refused = await serve(root, ["//:generated", "--write"])
    expect(refused.exitCode).toBe(1)
    expect(refused.output + refused.logs).toContain(
      "the write-set guard cannot restore the gitignored tree: more than 50000 entries"
    )
    expect(await Fs.readFile(NodePath.join(root, "docs/generated.md"), "utf8")).toBe("keep\n")
    const refusedCheck = await serve(root, ["//:docsCurrent"])
    expect(refusedCheck.exitCode).toBe(1)
    expect(refusedCheck.output + refusedCheck.logs).toContain(
      "the write-set guard cannot restore the gitignored tree: more than 50000 entries"
    )
  },
  300_000
)

it.skipIf(process.platform === "win32")(
  "restores an ignored out-of-set file in an admitted directory and rolls back a failed command",
  async () => {
    const root = await fixture()
    const escaped = await serve(root, ["//:badDocs", "--write"])
    expect(escaped.exitCode, escaped.logs).toBe(1)
    expect(escaped.logs).toContain("docs/private.tmp")
    expect(await Fs.readFile(NodePath.join(root, "docs/private.tmp"), "utf8")).toBe("secret\n")
    await write(root, "docs/output.md", "before\n")
    const failed = await serve(root, ["//:failedDocs", "--write"])
    expect(failed.exitCode, failed.logs).toBe(1)
    expect(failed.logs).toContain("command failed (exit 1)")
    expect(await Fs.readFile(NodePath.join(root, "docs/output.md"), "utf8")).toBe("before\n")
    expect((await Fs.stat(NodePath.join(root, "go-cache/pkg/mod/cache.bin"))).size).toBe(1024 * 1024 * 1024 + 1)
  }
)

it.skipIf(process.platform === "win32")(
  "keeps a sibling cache prefix under the ignored census ceiling",
  async () => {
    const root = await fixture()
    const sibling = NodePath.join(root, "go-cache-old", "big.bin")
    await write(root, ".gitignore", "go-cache/\ngo-cache-old/\ndocs/private.tmp\n")
    await Fs.mkdir(NodePath.dirname(sibling), { recursive: true })
    const handle = await Fs.open(sibling, "w")
    try {
      await handle.truncate(1024 * 1024 * 1024 + 1)
    } finally {
      await handle.close()
    }
    const result = await serve(root, ["//:docs", "--write"])
    expect(result.exitCode).toBe(1)
    expect(result.logs).toContain("go-cache-old/big.bin")
    expect(await Fs.readFile(NodePath.join(root, "docs/output.md"), "utf8")).toBe("before\n")
  }
)

it.skipIf(process.platform === "win32")(
  "still guards tracked files under a declared host directory",
  async () => {
    const root = await fixture()
    const result = await serve(root, ["//:badCacheTracked", "--write"])
    expect(result.exitCode, result.logs).toBe(1)
    expect(result.logs).toContain("go-cache/owned.txt")
    expect(await Fs.readFile(NodePath.join(root, "go-cache/owned.txt"), "utf8")).toBe("tracked\n")
  }
)

it.skipIf(process.platform === "win32")(
  "allows regenerated ignored contents inside a declared host directory",
  async () => {
    const root = await fixture()
    const result = await serve(root, ["//:cacheWrite", "--write"])
    expect(result.exitCode, result.output + result.logs).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "go-cache/new.bin"), "utf8")).toBe("rebuilt")
    expect(await Fs.readFile(NodePath.join(root, "docs/output.md"), "utf8")).toBe("after\n")
  }
)

it.skipIf(process.platform === "win32")(
  "combines declared cache and Rust host directories under the same ignored byte ceiling",
  async () => {
    const root = await fixture(true, true)
    const artifact = NodePath.join(root, "target", "debug", "deps", "libfixture.rmeta")
    await Fs.mkdir(NodePath.dirname(artifact), { recursive: true })
    const handle = await Fs.open(artifact, "w")
    try {
      await handle.truncate(1024 * 1024 * 1024 + 1)
    } finally {
      await handle.close()
    }
    const result = await serve(root, ["//:docs", "--write"])
    expect(result.exitCode, result.output + result.logs).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "docs/output.md"), "utf8")).toBe("after\n")
    expect((await Fs.stat(artifact)).size).toBe(1024 * 1024 * 1024 + 1)
  }
)

describe("declared cache host directories", () => {
  it("accepts canonical relative directory names", () => {
    const cache = WorkspaceDeclaration.Cache({ directory: ".flows", hostDirectories: ["go-cache", "nested/cache"] })
    expect(cache.hostDirectories).toEqual(["go-cache", "nested/cache"])
  })

  it.each([
    "",
    ".",
    "..",
    "../escape",
    "/absolute",
    "nested/../cache",
    "nested//cache",
    "cache/",
    "nested\\cache",
    "cache/*",
    "cache?",
    "cache[0]",
    "cache{a,b}",
    "x\nname"
  ])(
    "rejects noncanonical host directory %s",
    (directory) => {
      expect(() => WorkspaceDeclaration.Cache({ directory: ".flows", hostDirectories: [directory] })).toThrow()
    }
  )

  it("rejects non-array and non-string host directory values", () => {
    expect(() => WorkspaceDeclaration.Cache({ directory: ".flows", hostDirectories: "go-cache" as never })).toThrow()
    expect(() => WorkspaceDeclaration.Cache({ directory: ".flows", hostDirectories: [1] as never })).toThrow()
  })
})
