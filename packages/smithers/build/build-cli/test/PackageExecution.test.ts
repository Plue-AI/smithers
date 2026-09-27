import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { PACKAGE_EXECUTION_FORMAT, takesExclusiveTreePermit } from "../src/PackageExec.ts"
import { repositoryPnpmVersion } from "./helpers/RepositoryPnpm.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

/** Temp directories this file created; removed after the suite so a run leaves nothing in the OS temp dir. */
const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const workspaceModule = (extra = ""): string =>
  `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
${extra}
})
`

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

const commitAll = (root: string): void => {
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
}

const temporaryWorkspace = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-package-exec-"))))

const keyOf = (planOutput: string, label: string): string => {
  const lines = planOutput.split("\n")
  for (const [index, line] of lines.entries()) {
    if (!line.includes(`"${label}"`) && !line.includes(`label: ${label}`)) continue
    for (const candidate of lines.slice(index, index + 8)) {
      const match = candidate.match(/key: ([0-9a-f]{64})/)
      if (match !== null) return match[1]!
    }
  }
  throw new Error(`no key found for ${label} in:\n${planOutput}`)
}

it("plans gitDiff digests for thousands of selected paths", async () => {
  const root = await temporaryWorkspace()
  await write(root, "WORKSPACE.ts", workspaceModule())
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  review: S.Shell.Run({ shell: "true", data: [S.gitDiff({ base: "HEAD", paths: ["src/**"] })] })
} })
`
  )
  commitAll(root)
  const paths = Array.from(
    { length: 6000 },
    (_, index) => `src/${String(index).padStart(4, "0")}-${"x".repeat(220)}.ts`
  )
  for (const path of paths) await write(root, path, "changed\n")
  git(root, "add", "src")
  const first = await serve(root, ["//:review", "--plan"])
  expect(first.exitCode, first.output + first.logs).toBe(0)
  const firstKey = keyOf(first.output, "//:review")
  await write(root, paths.at(-1)!, "changed again\n")
  const changed = await serve(root, ["//:review", "--plan"])
  expect(changed.exitCode, changed.output + changed.logs).toBe(0)
  expect(keyOf(changed.output, "//:review")).not.toBe(firstKey)
})

describe("package execution format", () => {
  it("pins the package cache format number", () => {
    // The number is part of every cache address. Bumping it declares a format
    // change, so this assertion forces that bump to be intentional.
    expect(PACKAGE_EXECUTION_FORMAT).toBe(3)
  })
})

describe("bare-label execution and verb mapping", () => {
  it("executes a Shell.Run command target via the bare-label form", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { hello: S.Shell.Run({ shell: "true" }) } })
`
    )
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:hello"])
    expect(exitCode).toBe(0)
    expect(logs).toContain("//:hello  ran")
  })

  it("reports drift for a Generate target whose write set lies inside a nested package", async () => {
    // A write set is package-relative, so a generator declared in
    // packages/site names files under packages/site. The check compares the
    // real and scratch trees over those paths; a package-scoped expansion from
    // the workspace root stops at packages/site/PACKAGE.ts and compares
    // nothing, which turned every nested generator's lint into a vacuous pass.
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {} })
`
    )
    await write(
      root,
      "packages/site/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const gen = S.Generate({ script: S.file("gen.mjs"), data: [S.file("source.txt")], changes: ["out.txt"] })
export const Package = S.Package({ targets: { gen } })
`
    )
    await write(
      root,
      "packages/site/gen.mjs",
      `import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
const here = dirname(fileURLToPath(import.meta.url))
writeFileSync(join(here, "out.txt"), readFileSync(join(here, "source.txt"), "utf8"))
`
    )
    await write(root, "packages/site/source.txt", "a")
    await write(root, "packages/site/out.txt", "a")
    commitAll(root)
    const green = await serve(root, ["//packages/site:gen"])
    expect(green.exitCode).toBe(0)
    await write(root, "packages/site/source.txt", "b")
    const red = await serve(root, ["//packages/site:gen"])
    expect(red.logs).toContain("drift in declared write-set")
    expect(red.exitCode).toBe(1)
    // Check mode never touches the real tree.
    expect(await Fs.readFile(NodePath.join(root, "packages/site/out.txt"), "utf8")).toBe("a")
  })

  it("defaults a Diff target to check mode, applies with --write, and leaves check green after", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const fmt = S.Shell.Diff({ shell: "printf b > out.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { fmt } })
`
    )
    await write(root, "out.txt", "a")
    commitAll(root)
    const check = await serve(root, ["//:fmt"])
    expect(check.exitCode).toBe(1)
    expect(check.logs).toContain("drift in declared write-set")
    // Check mode never touches the real tree.
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("a")
    const applied = await serve(root, ["//:fmt", "--write"])
    expect(applied.exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("b")
    const recheck = await serve(root, ["//:fmt"])
    expect(recheck.exitCode).toBe(0)
  })

  it("keeps check and write modes on distinct cache keys", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const fmt = S.Shell.Diff({ shell: "printf b > out.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { fmt } })
`
    )
    await write(root, "out.txt", "a")
    commitAll(root)
    const check = await serve(root, ["lint", "//:fmt", "--plan"])
    const writes = await serve(root, ["run", "//:fmt", "--plan"])
    expect(check.exitCode).toBe(0)
    expect(writes.exitCode).toBe(0)
    expect(keyOf(check.output, "//:fmt")).not.toBe(keyOf(writes.output, "//:fmt"))
  })

  it("refuses a verb the target does not participate in", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { hello: S.Shell.Run({ shell: "true" }) } })
`
    )
    commitAll(root)
    const { exitCode, output } = await serve(root, ["test", "//:hello"])
    expect(exitCode).toBe(1)
    expect(output).toContain("does not support the test verb")
  })
})

describe("write-set enforcement", () => {
  it("reverts an out-of-set write, keeps the in-set change, and fails the target", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ shell: "printf b > out.txt && printf evil > other.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "out.txt", "a")
    await write(root, "other.txt", "innocent")
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    expect(logs).toMatch(
      /wrote outside its declared write-set|sandbox: .* outside the declared write set|Operation not permitted|Read-only file system/
    )
    expect(logs).toContain("other.txt")
    expect(await Fs.readFile(NodePath.join(root, "other.txt"), "utf8")).toBe("innocent")
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("b")
  })

  it("restores an out-of-set deletion", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ shell: "printf b > out.txt && rm tracked.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "out.txt", "a")
    await write(root, "tracked.txt", "keep me")
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("tracked.txt")
    expect(await Fs.readFile(NodePath.join(root, "tracked.txt"), "utf8")).toBe("keep me")
  })

  it("judges a write through a symlink by its resolved location", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ shell: "printf pwn > out/esc", changes: ["out/**"] })
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "secret.txt", "safe")
    await Fs.mkdir(NodePath.join(root, "out"), { recursive: true })
    await Fs.symlink("../secret.txt", NodePath.join(root, "out", "esc"))
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    expect(logs).toMatch(
      /wrote outside its declared write-set|sandbox: .* outside the declared write set|Operation not permitted|Read-only file system/
    )
    expect(await Fs.readFile(NodePath.join(root, "secret.txt"), "utf8")).toBe("safe")
  })
})

describe("external-write confinement through escaping symlinks", () => {
  const externalDir = async (): Promise<string> =>
    tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-external-"))))

  it("reverts and fails a --write that escapes through an in-workspace symlink", async () => {
    const root = await temporaryWorkspace()
    const external = await externalDir()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ shell: "printf b > out.txt && printf pwned > linkdir/target.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "out.txt", "a")
    await Fs.symlink(external, NodePath.join(root, "linkdir"))
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    expect(logs).toMatch(
      /wrote outside its declared write-set|sandbox: .* outside the declared write set|Operation not permitted|Read-only file system/
    )
    expect(logs).toContain("linkdir/target.txt")
    // The external write is reverted; the in-set change stays.
    const escaped = await Fs.access(NodePath.join(external, "target.txt")).then(() => true, () => false)
    expect(escaped).toBe(false)
    // The sandbox denies the escaping write at the kernel, the command fails,
    // and the run reverts every write it made, the declared one included.
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("a")
  })

  it("reverts and fails a check-mode dry-run that touches the real tree through a symlink", async () => {
    const root = await temporaryWorkspace()
    const external = await externalDir()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ shell: "printf b > out.txt && printf pwned > linkdir/leak.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "out.txt", "a")
    await Fs.symlink(external, NodePath.join(root, "linkdir"))
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad"])
    expect(exitCode).toBe(1)
    expect(logs).toMatch(
      /check touched the real tree through a symlink|sandbox: .* outside the declared write set|Operation not permitted|Read-only file system/
    )
    const escaped = await Fs.access(NodePath.join(external, "leak.txt")).then(() => true, () => false)
    expect(escaped).toBe(false)
    // Check mode never touched the real out.txt either.
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("a")
  })
})

describe("mode-aware planning", () => {
  it("applies a --write root that is also reached as a check-mode gate", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const fmt = S.Shell.Diff({ shell: "printf b > out.txt", changes: ["out.txt"] })
const aaa = S.Shell.Run({ shell: "true", gates: [fmt] })
export const Package = S.Package({ targets: { aaa, fmt } })
`
    )
    await write(root, "out.txt", "a")
    commitAll(root)
    // //:aaa sorts before //:fmt, so fmt is first reached as aaa's check-mode
    // gate; the root loop then reaches it under --write. It must plan once, in
    // write mode, and apply — not reuse a stale check-mode node and report drift.
    const applied = await serve(root, ["//...", "--write"])
    expect(applied.exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("b")
    expect(applied.logs).toContain("//:fmt  ran")
  })
})

describe("write-set enforcement of gitignored paths", () => {
  it("reverts and fails an out-of-set write to a gitignored path", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ shell: "printf b > out.txt && printf leak > ignored-leak.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "out.txt", "a")
    await write(root, ".gitignore", "ignored-leak.txt\n")
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    expect(logs).toMatch(
      /wrote outside its declared write-set|sandbox: .* outside the declared write set|Operation not permitted|Read-only file system/
    )
    expect(logs).toContain("ignored-leak.txt")
    // The gitignored out-of-set write is reverted; the in-set change stays.
    const leakGone = await Fs.access(NodePath.join(root, "ignored-leak.txt")).then(() => false, () => true)
    expect(leakGone).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("b")
  })

  /**
   * The ignored guard used to stash no bytes, so its only revert was removal:
   * an out-of-set overwrite of a pre-existing `.env` deleted the user's file.
   */
  it("restores a pre-existing gitignored file that a tool overwrote out of set", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ shell: "printf b > out.txt && printf leaked > .env", changes: ["out.txt"] })
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "out.txt", "a")
    await write(root, ".env", "secret")
    await write(root, ".gitignore", ".env\n")
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    expect(logs).toMatch(
      /wrote outside its declared write-set|sandbox: .* outside the declared write set|Operation not permitted|Read-only file system/
    )
    expect(logs).toContain(".env")
    expect(await Fs.readFile(NodePath.join(root, ".env"), "utf8")).toBe("secret")
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("b")
  })

  /** A failed body reverts everything it touched, gitignored in-set output included. */
  it("reverts a failed tool's in-set gitignored writes", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({
  shell: "printf rewritten > dist/a.js && printf partial > dist/b.js && exit 1",
  changes: ["dist/**"]
})
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "dist/a.js", "old")
    await write(root, ".gitignore", "dist/\n")
    commitAll(root)
    const { exitCode } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    expect(await Fs.readFile(NodePath.join(root, "dist", "a.js"), "utf8")).toBe("old")
    const partialGone = await Fs.access(NodePath.join(root, "dist", "b.js")).then(() => false, () => true)
    expect(partialGone).toBe(true)
  })

  it("names a failure reported on stdout after an earlier step wrote stderr", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Test({ shell: "printf 'unittest OK\\\\n' >&2; printf -- '--- FAIL: TestOwner\\\\n'; exit 1" })
export const Package = S.Package({ targets: { bad } })
`
    )
    commitAll(root)
    const { exitCode, output, logs } = await serve(root, ["//:bad"])
    expect(exitCode, output + logs).toBe(1)
    // Live tool output is capped; the failure block itself must carry both streams.
    const failure = logs.slice(logs.indexOf("//:bad  failed"))
    expect(failure).toContain("unittest OK\n--- FAIL: TestOwner")
  })

  it("fails a tool that writes into a gitignored nested repository, which it cannot restore", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({
  shell: "printf b > out.txt && printf x > vendor/nested/new.txt && printf leak > leak.txt",
  changes: ["out.txt"]
})
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "out.txt", "a")
    await write(root, ".gitignore", "vendor/\nleak.txt\n")
    await write(root, "vendor/nested/x.txt", "x")
    git(NodePath.join(root, "vendor", "nested"), "init", "-q")
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    // The failure says which offender went back and which one could not.
    expect(logs).toContain("wrote outside its declared write-set: leak.txt (reverted), vendor/nested (not restored)")
    const leakGone = await Fs.access(NodePath.join(root, "leak.txt")).then(() => false, () => true)
    expect(leakGone).toBe(true)
    // The nested repository is left exactly as the tool left it: never removed.
    expect(await Fs.readFile(NodePath.join(root, "vendor", "nested", "x.txt"), "utf8")).toBe("x")
    expect(await Fs.readFile(NodePath.join(root, "vendor", "nested", "new.txt"), "utf8")).toBe("x")
  })

  it("names the gitignored paths a failed tool left that the guard could not restore", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ shell: "printf y > vendor/nested/y.txt && exit 1", changes: ["vendor/**"] })
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, ".gitignore", "vendor/\n")
    await write(root, "vendor/nested/x.txt", "x")
    git(NodePath.join(root, "vendor", "nested"), "init", "-q")
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("gitignored paths not restored: vendor/nested")
    expect(await Fs.readFile(NodePath.join(root, "vendor", "nested", "y.txt"), "utf8")).toBe("y")
  })

  /**
   * The guard has no partial mode: a gitignored tree it cannot stash whole
   * refuses the target before the body runs, and the refusal releases every
   * stash it had already taken.
   */
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a write target over a gitignored file the census cannot stash, before the body runs",
    async () => {
      const root = await temporaryWorkspace()
      await write(root, "WORKSPACE.ts", workspaceModule())
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const fmt = S.Shell.Diff({ shell: "printf b > out.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { fmt } })
`
      )
      await write(root, "out.txt", "a")
      await write(root, ".gitignore", "sealed.txt\n")
      await write(root, "sealed.txt", "x")
      commitAll(root)
      await Fs.chmod(NodePath.join(root, "sealed.txt"), 0o000)
      try {
        const { exitCode, logs } = await serve(root, ["//:fmt", "--write"])
        expect(exitCode).toBe(1)
        expect(logs).toContain("the write-set guard cannot restore the gitignored tree: sealed.txt could not be read")
        expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("a")
      } finally {
        await Fs.chmod(NodePath.join(root, "sealed.txt"), 0o644)
      }
    }
  )

  /**
   * A workspace that declares a Rust toolchain, so cargo's build directory is
   * the host state the census skips. The manifest is declared, not built:
   * nothing here runs cargo, and the guard's census is what is under test.
   */
  const cargoWorkspace = async (root: string, manifest = "//Cargo.toml"): Promise<void> => {
    await write(root, "Cargo.toml", "[workspace]\nmembers = []\n")
    await write(
      root,
      "WORKSPACE.ts",
      workspaceModule(`  toolchains: [S.Rust.Toolchain({ workspace: S.file("${manifest}"), channel: "stable" })],`)
    )
  }

  /** A gitignored file that reports `size` bytes and occupies none. */
  const sparse = async (root: string, relative: string, size: number): Promise<void> => {
    await write(root, relative, "")
    const handle = await Fs.open(NodePath.join(root, relative), "r+")
    try {
      await handle.truncate(size)
    } finally {
      await handle.close()
    }
  }

  const overCeiling = 1024 * 1024 * 1024 + 1

  /**
   * The defect this exclusion fixes. `smithers-build target <label> --write` is
   * the documented way to regenerate a checked-in artifact, and on any checkout
   * with a built Rust tree it was refused outright: the census stashed the
   * bytes of every gitignored file on disk, so `target/` alone put the
   * repository over the ceiling and no `--write` could run.
   */
  it.skipIf(process.platform === "win32")(
    "runs a write target with a cargo build directory over the byte ceiling",
    async () => {
      const root = await temporaryWorkspace()
      await cargoWorkspace(root)
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const fmt = S.Shell.Diff({ shell: "printf b > out.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { fmt } })
`
      )
      await write(root, "out.txt", "a")
      await write(root, ".gitignore", "target/\n")
      commitAll(root)
      await sparse(root, "target/debug/deps/libzerocopy.rmeta", overCeiling)
      const { exitCode, logs } = await serve(root, ["//:fmt", "--write"])
      expect(logs).not.toContain("the write-set guard cannot restore the gitignored tree")
      expect(exitCode).toBe(0)
      expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("b")
      // Skipped, never cleaned: the build directory is left exactly as it was.
      expect((await Fs.stat(NodePath.join(root, "target", "debug", "deps", "libzerocopy.rmeta"))).size)
        .toBe(overCeiling)
    }
  )

  /**
   * The ceiling still binds. Only a directory a declared toolchain owns left
   * the census, so the same bytes anywhere else still refuse the target, and
   * so does a `target/` in a workspace that declares no Rust toolchain.
   */
  it.skipIf(process.platform === "win32")(
    "still refuses a write target over a gitignored tree no toolchain owns",
    async () => {
      const root = await temporaryWorkspace()
      await cargoWorkspace(root)
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const fmt = S.Shell.Diff({ shell: "printf b > out.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { fmt } })
`
      )
      await write(root, "out.txt", "a")
      await write(root, ".gitignore", "media/\n")
      commitAll(root)
      await sparse(root, "media/raw.mov", overCeiling)
      const { exitCode, logs } = await serve(root, ["//:fmt", "--write"])
      expect(exitCode).toBe(1)
      expect(logs).toContain("the write-set guard cannot restore the gitignored tree: more than 1073741824 bytes")
      expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("a")
    }
  )

  it.skipIf(process.platform === "win32")(
    "still refuses a write target over a target directory no declared toolchain owns",
    async () => {
      const root = await temporaryWorkspace()
      await write(root, "WORKSPACE.ts", workspaceModule())
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const fmt = S.Shell.Diff({ shell: "printf b > out.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { fmt } })
`
      )
      await write(root, "out.txt", "a")
      await write(root, ".gitignore", "target/\n")
      commitAll(root)
      await sparse(root, "target/big.bin", overCeiling)
      const { exitCode, logs } = await serve(root, ["//:fmt", "--write"])
      expect(exitCode).toBe(1)
      expect(logs).toContain("the write-set guard cannot restore the gitignored tree: more than 1073741824 bytes")
    }
  )

  /**
   * The guard's own purpose, unchanged, with a build directory past the
   * ceiling sitting beside it: an out-of-set overwrite of the developer's
   * `.env` still fails the target and still puts the bytes back.
   */
  it.skipIf(process.platform === "win32")(
    "still restores a gitignored file out of set beside a cargo build directory over the ceiling",
    async () => {
      const root = await temporaryWorkspace()
      await cargoWorkspace(root)
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ shell: "printf b > out.txt && printf leaked > .env", changes: ["out.txt"] })
export const Package = S.Package({ targets: { bad } })
`
      )
      await write(root, "out.txt", "a")
      await write(root, ".env", "secret")
      await write(root, ".gitignore", "target/\n.env\n")
      commitAll(root)
      await sparse(root, "target/debug/deps/libzerocopy.rmeta", overCeiling)
      const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
      expect(exitCode).toBe(1)
      expect(logs).toContain("wrote outside its declared write-set (reverted): .env")
      expect(await Fs.readFile(NodePath.join(root, ".env"), "utf8")).toBe("secret")
      expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("b")
    }
  )

  /**
   * A cargo build directory is host state, out of the guard's sight like a
   * write under `node_modules`. A write beside it is still judged.
   */
  it("leaves a write into the cargo build directory unjudged and still judges its sibling", async () => {
    const root = await temporaryWorkspace()
    await cargoWorkspace(root)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({
  shell: "printf b > out.txt && printf o > target/leak.o && printf leak > scratch/leak.txt",
  changes: ["out.txt"]
})
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "out.txt", "a")
    await write(root, ".gitignore", "target/\nscratch/\n")
    await write(root, "target/keep.bin", "kept")
    await write(root, "scratch/keep.txt", "kept")
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("wrote outside its declared write-set (reverted): scratch/leak.txt")
    expect(logs).not.toContain("target/leak.o")
    const scratchLeakGone = await Fs.access(NodePath.join(root, "scratch", "leak.txt")).then(() => false, () => true)
    expect(scratchLeakGone).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, "target", "leak.o"), "utf8")).toBe("o")
    expect(await Fs.readFile(NodePath.join(root, "target", "keep.bin"), "utf8")).toBe("kept")
  })

  /**
   * One stash of gitignored bytes serves every guarded body in a run. The
   * second body's census must hold what the first body wrote, so a failure
   * after it restores the first body's output, not the pre-run bytes.
   */
  it("restores a failed body's gitignored writes from the stash shared with an earlier body in the run", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const aaa = S.Shell.Diff({ shell: "printf first > dist/a.js", changes: ["dist/**"] })
const bbb = S.Shell.Diff({
  shell: "printf broken > dist/a.js && printf partial > dist/b.js && exit 1",
  changes: ["dist/**"]
})
export const Package = S.Package({ targets: { aaa, bbb } })
`
    )
    await write(root, "dist/a.js", "old")
    await write(root, ".gitignore", "dist/\n")
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//...", "--write"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("//:aaa  ran")
    expect(logs).toContain("//:bbb  failed")
    // In either order the failed body went back to the bytes its own census
    // saw, and the successful body's write stands.
    expect(await Fs.readFile(NodePath.join(root, "dist", "a.js"), "utf8")).toBe("first")
    const partialGone = await Fs.access(NodePath.join(root, "dist", "b.js")).then(() => false, () => true)
    expect(partialGone).toBe(true)
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a write target over an escaping symlink the portal census cannot read, before the body runs",
    async () => {
      const root = await temporaryWorkspace()
      const external = await tracked(Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-sealed-portal-")))
      await write(root, "WORKSPACE.ts", workspaceModule())
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const fmt = S.Shell.Diff({ shell: "printf b > out.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { fmt } })
`
      )
      await write(root, "out.txt", "a")
      await Fs.symlink(external, NodePath.join(root, "portal"))
      commitAll(root)
      await Fs.chmod(external, 0o000)
      try {
        const { exitCode, logs } = await serve(root, ["//:fmt", "--write"])
        expect(exitCode).toBe(1)
        expect(logs).toContain("the write-set guard cannot confine portal")
        expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("a")
      } finally {
        await Fs.chmod(external, 0o755)
      }
    }
  )
})

describe("write-set enforcement against a concurrent peer", () => {
  /**
   * A script that writes its own file and then stays inside its body until the
   * peer's file appears, so both bodies are provably in flight at once. The
   * deadline keeps the test honest when the two are correctly serialized:
   * the peer never appears, the wait ends, and the run still finishes.
   */
  const rendezvous = (own: string, peer: string, contents: string): string =>
    `import { existsSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
mkdirSync(dirname(${JSON.stringify(own)}), { recursive: true })
writeFileSync(${JSON.stringify(own)}, ${JSON.stringify(contents)})
const deadline = Date.now() + 1500
while (!existsSync(${JSON.stringify(peer)}) && Date.now() < deadline) {
  await new Promise((resume) => setTimeout(resume, 10))
}
`

  it("does not let one write node revert a concurrent write node's output", async () => {
    // The guard snapshots the whole repository, so a peer's write is
    // indistinguishable from this node writing outside its own set. Two write
    // nodes each reverted the other's file and both failed naming the other's
    // path.
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "alpha.mjs", rendezvous("alpha.txt", "beta.txt", "alpha"))
    await write(root, "beta.mjs", rendezvous("beta.txt", "alpha.txt", "beta"))
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const alpha = S.Generate({ script: S.file("//alpha.mjs"), changes: ["alpha.txt"] })
const beta = S.Generate({ script: S.file("//beta.mjs"), changes: ["beta.txt"] })
export const Package = S.Package({ targets: { alpha, beta } })
`
    )
    commitAll(root)

    const { exitCode, logs } = await serve(root, ["//...", "--write"])
    expect(logs).not.toContain("wrote outside its declared write-set")
    expect(exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "alpha.txt"), "utf8")).toBe("alpha")
    expect(await Fs.readFile(NodePath.join(root, "beta.txt"), "utf8")).toBe("beta")
  })

  it("does not let a write node delete a concurrent build's gitignored output directory", async () => {
    // The ignored-path census was the more destructive half: an out-of-set
    // gitignored path was removed recursively, so a peer emitting into dist/
    // lost the whole directory. This is also why the exclusion cannot be
    // between write nodes alone; the peer here never enters write mode.
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "alpha.mjs", rendezvous("alpha.txt", "dist/out.js", "alpha"))
    await write(root, "build.mjs", rendezvous("dist/out.js", "alpha.txt", "built"))
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const alpha = S.Generate({ script: S.file("//alpha.mjs"), changes: ["alpha.txt"] })
const build = S.Shell.Build({ script: S.file("//build.mjs"), outFiles: ["//dist/out.js"] })
export const Package = S.Package({ targets: { alpha, build } })
`
    )
    await write(root, ".gitignore", "dist/\n")
    commitAll(root)

    const { exitCode, logs } = await serve(root, ["//...", "--write"])
    expect(logs).not.toContain("wrote outside its declared write-set")
    expect(exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "alpha.txt"), "utf8")).toBe("alpha")
    expect(await Fs.readFile(NodePath.join(root, "dist", "out.js"), "utf8")).toBe("built")
  })
})

describe("write-set enforcement against a foreign writer", () => {
  /**
   * A tool that writes its output and then stays inside its body until the
   * test drops a sentinel, so the test's own edits land after the guard's
   * snapshot and before its judgement: exactly an editor saving a file while
   * `--write` runs. The deadline keeps a broken rendezvous from hanging.
   */
  const waiting = (output: string, sentinel: string): string =>
    `printf b > ${output} && i=0; while [ ! -f ${sentinel} ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done`

  const exists = (path: string): Promise<boolean> => Fs.access(path).then(() => true, () => false)

  const until = async (path: string): Promise<void> => {
    const deadline = Date.now() + 60_000
    while (!(await exists(path))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
      await new Promise((resume) => setTimeout(resume, 20))
    }
  }

  const fixture = async (target: string): Promise<string> => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const fmt = ${target}
export const Package = S.Package({ targets: { fmt } })
`
    )
    await write(root, "src/.keep", "")
    await write(root, "lib/user.ts", "original\n")
    await write(root, ".gitignore", ".flows/\n")
    commitAll(root)
    return root
  }

  /** Edits a tracked file and creates a note while the body runs, then releases the body. */
  const editWhileRunning = async (root: string, output: string, sentinel: string): Promise<void> => {
    await until(NodePath.join(root, output))
    await write(root, "lib/user.ts", "edited by the developer\n")
    await write(root, "notes/new-note.md", "a note\n")
    await write(root, sentinel, "")
  }

  const keptAt = (logs: string): string => {
    const match = logs.match(/the reverted bytes are kept at (\S+)/)
    if (match === null) throw new Error(`no quarantine named in:\n${logs}`)
    return match[1]!
  }

  it("leaves a change the confined tool could not have made exactly as its writer left it", async () => {
    const root = await fixture(
      `S.Shell.Diff({ shell: ${JSON.stringify(waiting("src/out.txt", "src/go"))}, changes: ["src/**"] })`
    )
    const [run] = await Promise.all([
      serve(root, ["//:fmt", "--write"]),
      editWhileRunning(root, "src/out.txt", "src/go")
    ])
    expect(run.logs).not.toContain("wrote outside its declared write-set")
    expect(run.exitCode, run.logs).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "src", "out.txt"), "utf8")).toBe("b")
    expect(await Fs.readFile(NodePath.join(root, "lib", "user.ts"), "utf8")).toBe("edited by the developer\n")
    expect(await Fs.readFile(NodePath.join(root, "notes", "new-note.md"), "utf8")).toBe("a note\n")
    expect(await exists(NodePath.join(root, ".flows", "reverted"))).toBe(false)
  })

  it("keeps a change it reverts inside the tool's writable directory in the quarantine it names", async () => {
    // A literal root file opens the workspace root for the tool, so the guard
    // cannot tell the developer's edit from the tool's: it reverts it, and
    // the edit survives in the quarantine.
    const root = await fixture(
      `S.Shell.Diff({ shell: ${JSON.stringify(waiting("out.txt", "go.txt"))}, changes: ["out.txt"] })`
    )
    const [run] = await Promise.all([
      serve(root, ["//:fmt", "--write"]),
      editWhileRunning(root, "out.txt", "go.txt")
    ])
    expect(run.exitCode).toBe(1)
    expect(run.logs).toContain(
      "wrote outside its declared write-set (reverted): go.txt, lib/user.ts, notes/new-note.md"
    )
    const kept = NodePath.join(root, keptAt(run.logs))
    expect(keptAt(run.logs)).toMatch(/^\.flows\/reverted\/fmt-/)
    expect(await Fs.readFile(NodePath.join(root, "lib", "user.ts"), "utf8")).toBe("original\n")
    expect(await Fs.readFile(NodePath.join(kept, "lib", "user.ts"), "utf8")).toBe("edited by the developer\n")
    expect(await Fs.readFile(NodePath.join(kept, "notes", "new-note.md"), "utf8")).toBe("a note\n")
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("b")
  })

  it("keeps every change it reverts for an unconfined tool, which nothing bounds", async () => {
    const root = await fixture(
      `S.Shell.Diff({ shell: ${
        JSON.stringify(waiting("src/out.txt", "src/go"))
      }, changes: ["src/**"], sandbox: "none" })`
    )
    const [run] = await Promise.all([
      serve(root, ["//:fmt", "--write"]),
      editWhileRunning(root, "src/out.txt", "src/go")
    ])
    expect(run.exitCode).toBe(1)
    expect(run.logs).toContain("wrote outside its declared write-set (reverted): lib/user.ts, notes/new-note.md")
    const kept = NodePath.join(root, keptAt(run.logs))
    expect(await Fs.readFile(NodePath.join(kept, "lib", "user.ts"), "utf8")).toBe("edited by the developer\n")
    expect(await Fs.readFile(NodePath.join(kept, "notes", "new-note.md"), "utf8")).toBe("a note\n")
  })
})

describe("artifact store", () => {
  const buildFixture = async (): Promise<string> => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const dist = S.Shell.Build({ shell: "mkdir -p dist && printf art > dist/a.txt", outDirs: ["dist"] })
export const Package = S.Package({ targets: { dist } })
`
    )
    commitAll(root)
    return root
  }

  it("captures outDirs on green, answers a hit, and restores a deleted tree", async () => {
    const root = await buildFixture()
    const first = await serve(root, ["//:dist"])
    expect(first.exitCode).toBe(0)
    expect(first.logs).toContain("//:dist  ran")
    await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
    const second = await serve(root, ["//:dist"])
    expect(second.exitCode).toBe(0)
    expect(second.logs).toContain("//:dist  hit")
    expect(await Fs.readFile(NodePath.join(root, "dist", "a.txt"), "utf8")).toBe("art")
  })

  it("treats a tampered blob as a miss and re-executes", async () => {
    const root = await buildFixture()
    const first = await serve(root, ["//:dist"])
    expect(first.exitCode).toBe(0)
    const cas = NodePath.join(root, ".flows", "cas")
    const blobs = await Fs.readdir(cas)
    expect(blobs.length).toBeGreaterThan(0)
    for (const blob of blobs) await Fs.writeFile(NodePath.join(cas, blob), "tampered")
    await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
    const second = await serve(root, ["//:dist"])
    expect(second.exitCode).toBe(0)
    expect(second.logs).toContain("cache miss")
    expect(second.logs).toContain("//:dist  ran")
    expect(await Fs.readFile(NodePath.join(root, "dist", "a.txt"), "utf8")).toBe("art")
  })

  it("refuses a poisoned cache manifest whose outDir escapes the workspace", async () => {
    const root = await buildFixture()
    const first = await serve(root, ["//:dist"])
    expect(first.exitCode).toBe(0)
    // A sibling directory outside the workspace root, holding precious content.
    const victim = NodePath.join(NodePath.dirname(root), "victim")
    await Fs.mkdir(victim, { recursive: true })
    await Fs.writeFile(NodePath.join(victim, "precious.txt"), "precious")
    // Poison the on-disk cache entry: rewrite the manifest's outDir to point at
    // the external sibling. A hit that trusted it would rename-swap `../victim`.
    const cacheRoot = NodePath.join(root, ".flows", "cache")
    const files: Array<string> = []
    for (const shard of await Fs.readdir(cacheRoot)) {
      const shardPath = NodePath.join(cacheRoot, shard)
      if (!(await Fs.stat(shardPath)).isDirectory()) continue
      for (const name of await Fs.readdir(shardPath)) files.push(NodePath.join(shardPath, name))
    }
    let poisoned = 0
    for (const file of files) {
      const entry = JSON.parse(await Fs.readFile(file, "utf8"))
      if (entry?.output?.kind !== "build") continue
      for (const manifest of entry.output.manifests) manifest.outDir = "../victim"
      await Fs.writeFile(file, JSON.stringify(entry))
      poisoned += 1
    }
    expect(poisoned).toBeGreaterThan(0)
    await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
    const second = await serve(root, ["//:dist"])
    // The poisoned entry is rejected as a miss and the build re-executes; the
    // external sibling is untouched.
    expect(second.logs).toContain("//:dist  ran")
    expect(await Fs.readFile(NodePath.join(victim, "precious.txt"), "utf8")).toBe("precious")
    expect(await Fs.readFile(NodePath.join(root, "dist", "a.txt"), "utf8")).toBe("art")
  })

  it("answers a Shell.Test repeat with a cache hit", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { check: S.Shell.Test({ shell: "true" }) } })
`
    )
    commitAll(root)
    const first = await serve(root, ["//:check"])
    expect(first.exitCode).toBe(0)
    expect(first.logs).toContain("//:check  ran")
    const second = await serve(root, ["//:check"])
    expect(second.exitCode).toBe(0)
    expect(second.logs).toContain("//:check  hit")
  })

  it("fans Shell.Test shards into independently cached executions", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "test.sh", `test "$1" = "--shard=$VITE_SHARD_ID/3"\n`)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { check: S.Shell.Test({ script: S.file("//test.sh"), shards: 3 }) } })
`
    )
    commitAll(root)
    const first = await serve(root, ["//:check"])
    expect(first.exitCode).toBe(0)
    expect(first.logs).toContain("//:check  ran")
    const second = await serve(root, ["//:check"])
    expect(second.exitCode).toBe(0)
    expect(second.logs).toContain("//:check  hit")
  })

  it("refuses a shell-form shard fan-out instead of running the same command N times", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { check: S.Shell.Test({ shell: "true", shards: 3 }) } })
`
    )
    commitAll(root)
    const planned = await serve(root, ["//:check", "--plan"])
    expect(planned.output).toContain("Shell.Test shards cannot fan out a shell-form declaration")
  })

  it("spawns a declared script under the interpreter its extension names, under either rule", async () => {
    // optimism runs one sync-superchain.sh under both S.Shell.Build and
    // S.Generate; a shell script handed to node is a parse error, not a run.
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "sync.sh", "printf ok > out.txt\n")
    await write(root, "gen.mjs", "import { writeFileSync } from \"node:fs\"\nwriteFileSync(\"out.txt\", \"ok\")\n")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const shellGenerate = S.Generate({ script: S.file("//sync.sh"), changes: ["out.txt"] })
const nodeGenerate = S.Generate({ script: S.file("//gen.mjs"), changes: ["out.txt"] })
const shellBuild = S.Shell.Build({ script: S.file("//sync.sh"), outFiles: ["//out.txt"] })
export const Package = S.Package({ targets: { nodeGenerate, shellBuild, shellGenerate } })
`
    )
    commitAll(root)
    const planned = await serve(root, ["//...", "--plan"])
    expect(planned.output).toContain("/bin/sh,sync.sh")
    expect(planned.output).toMatch(/argv\[2\]: [^\n]*node,gen\.mjs/)
    expect(planned.output).not.toMatch(/node,sync\.sh/)
  })

  it("redirects a declared Generate stdout for the command form, not only for script and bin", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { gen: S.Generate({ command: "printf ok", stdout: "out.txt" }) } })
`
    )
    commitAll(root)
    const written = await serve(root, ["//:gen", "--write"])
    expect(written.exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("ok")
  })
})

describe("NodeModule.Bin resolution through the package bin map", () => {
  /** Writes one installed fixture package plus the `.bin` entries it exposes. */
  const installFixturePackage = async (
    root: string,
    packageName: string,
    bin: string | Readonly<Record<string, string>>,
    binNames: ReadonlyArray<string>
  ): Promise<void> => {
    await write(
      root,
      NodePath.join("node_modules", ...packageName.split("/"), "package.json"),
      `${JSON.stringify({ name: packageName, version: "1.0.0", bin })}\n`
    )
    for (const name of binNames) {
      await write(root, NodePath.join("node_modules", ".bin", name), "#!/bin/sh\nexit 0\n")
      await Fs.chmod(NodePath.join(root, "node_modules", ".bin", name), 0o755)
    }
  }

  it("resolves a string-form bin to the package basename", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { stringy: S.Shell.Test({ bin: S.NodeModule.Bin("@scope/stringy") }) } })
`
    )
    // Only the basename entry exists: resolving any other name would refuse.
    await installFixturePackage(root, "@scope/stringy", "./cli.js", ["stringy"])
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:stringy"])
    expect(exitCode).toBe(0)
    expect(logs).toContain("//:stringy  ran")
  })

  it("resolves a one-entry bin map to its key, not the package basename", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { pw: S.Shell.Test({ bin: S.NodeModule.Bin("@playwright/test") }) } })
`
    )
    // `.bin/playwright` exists; `.bin/test` (the basename) deliberately does not.
    await installFixturePackage(root, "@playwright/test", { playwright: "cli.js" }, ["playwright"])
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:pw"])
    expect(exitCode).toBe(0)
    expect(logs).toContain("//:pw  ran")
    expect(logs).not.toContain("node_modules/.bin/test")
  })

  it("resolves a multi-entry bin map to the entry named after the package", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { deadCode: S.Shell.Test({ bin: S.NodeModule.Bin("knip") }) } })
`
    )
    // knip ships { knip, knip-bun }: one argument selects the package-name entry.
    await installFixturePackage(root, "knip", { "knip": "bin/knip.js", "knip-bun": "bin/knip-bun.js" }, [
      "knip",
      "knip-bun"
    ])
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:deadCode"])
    expect(exitCode).toBe(0)
    expect(logs).toContain("//:deadCode  ran")
  })

  it("resolves a scoped package's multi-entry bin map to its unscoped name", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { lint: S.Shell.Test({ bin: S.NodeModule.Bin("@biomejs/biome") }) } })
`
    )
    // The unscoped basename decides: @biomejs/biome resolves the `biome` entry.
    await installFixturePackage(root, "@biomejs/biome", { "biome": "bin/biome", "biome-check": "bin/check" }, [
      "biome",
      "biome-check"
    ])
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:lint"])
    expect(exitCode).toBe(0)
    expect(logs).toContain("//:lint  ran")
  })

  it("refuses a multi-entry bin map without an explicit name and accepts the named one", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const ambiguous = S.Shell.Test({ bin: S.NodeModule.Bin("multi") })
const explicit = S.Shell.Test({ bin: S.NodeModule.Bin("multi", "beta") })
export const Package = S.Package({ targets: { ambiguous, explicit } })
`
    )
    await installFixturePackage(root, "multi", { alpha: "a.js", beta: "b.js" }, ["alpha", "beta"])
    commitAll(root)
    const refused = await serve(root, ["//:ambiguous"])
    expect(refused.exitCode).toBe(1)
    expect(refused.logs).toContain("//:ambiguous  failed")
    expect(refused.logs).toContain(`package "multi" exposes 2 binaries (alpha, beta)`)
    expect(refused.logs).toContain("S.NodeModule.Bin(package, bin)")
    const named = await serve(root, ["//:explicit"])
    expect(named.exitCode).toBe(0)
    expect(named.logs).toContain("//:explicit  ran")
  })
})

describe("workspace-era pnpm manager", () => {
  it("loads, plans, and executes with the pnpm manifest + lockfile declaration", async () => {
    const root = await temporaryWorkspace()
    await write(
      root,
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("pnpmfixture", {
  repository: "git+https://example.invalid/pnpmfixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml"), version: "8" }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`
    )
    await write(root, "package.json", `{ "name": "pnpmfixture", "private": true }\n`)
    await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { check: S.Shell.Test({ shell: "true" }) } })
`
    )
    commitAll(root)
    const planned = await serve(root, ["//:check", "--plan"])
    expect(planned.exitCode).toBe(0)
    expect(planned.output).not.toContain("refusal")
    const { exitCode, logs } = await serve(root, ["//:check"])
    expect(exitCode).toBe(0)
    expect(logs).toContain("//:check  ran")
  })
})

describe("toolchain identity in keys", () => {
  it("misses the build cache when a resolved binary changes without changing its version", async () => {
    const root = await temporaryWorkspace()
    const tools = await temporaryWorkspace()
    const binary = NodePath.join(tools, "cache-compiler")
    const install = async (value: string): Promise<void> => {
      await Fs.writeFile(
        binary,
        `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.0; exit 0; fi\nmkdir -p dist\nprintf '${value}' > dist/a.txt\n`,
        { mode: 0o755 }
      )
    }
    await install("one")
    await write(root, "WORKSPACE.ts", workspaceModule(`  host: S.Host({ bins: ["cache-compiler"] }),`))
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const dist = S.Shell.Build({ bin: S.Host.bin("cache-compiler"), outDirs: ["dist"] })
export const Package = S.Package({ targets: { dist } })
`
    )
    commitAll(root)
    vi.stubEnv("PATH", `${tools}${NodePath.delimiter}${process.env["PATH"] ?? ""}`)
    try {
      const first = await serve(root, ["//:dist"])
      expect(first.exitCode, first.logs).toBe(0)
      const warm = await serve(root, ["//:dist"])
      expect(warm.logs).toContain("//:dist  hit")
      await install("two")
      await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
      const changed = await serve(root, ["//:dist"])
      expect(changed.exitCode, changed.logs).toBe(0)
      expect(changed.logs).toContain("//:dist  ran")
      expect(await Fs.readFile(NodePath.join(root, "dist/a.txt"), "utf8")).toBe("two")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("misses a command build when the PATH-resolved executable changes", async () => {
    const root = await temporaryWorkspace()
    const tools = await temporaryWorkspace()
    const originalPath = process.env["PATH"] ?? ""
    for (const name of ["one", "two"]) {
      await write(tools, `${name}/cache-compiler`, `#!/bin/sh\nmkdir -p dist\nprintf '${name}:%s' "$CI" > dist/a.txt\n`)
      await Fs.chmod(NodePath.join(tools, name, "cache-compiler"), 0o755)
    }
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const dist = S.Shell.Build({ shell: "cache-compiler", outDirs: ["dist"] })
export const Package = S.Package({ targets: { dist } })
`
    )
    commitAll(root)
    try {
      for (const [tool, ci] of [["one", "first"], ["two", "first"]]) {
        vi.stubEnv("PATH", `${NodePath.join(tools, tool!)}${NodePath.delimiter}${originalPath}`)
        vi.stubEnv("CI", ci!)
        const result = await serve(root, ["//:dist"])
        expect(result.exitCode, result.logs).toBe(0)
        expect(result.logs).toContain("//:dist  ran")
        expect(await Fs.readFile(NodePath.join(root, "dist/a.txt"), "utf8")).toBe(`${tool}:${ci}`)
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("shares keys across inherited home and temp values but keys declared environment values", async () => {
    const root = await temporaryWorkspace()
    const home = await temporaryWorkspace()
    const tmp = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    const declaration = (flavor: string) =>
      `import { Smithers as S } from "@smthrs/targets"
const dist = S.Shell.Build({ shell: "true", outDirs: ["dist"], env: { FLAVOR: "${flavor}" } })
export const Package = S.Package({ targets: { dist } })
`
    await write(root, "PACKAGE.ts", declaration("one"))
    commitAll(root)
    try {
      const first = await serve(root, ["//:dist", "--plan"])
      vi.stubEnv("HOME", home)
      vi.stubEnv("TMPDIR", tmp)
      const relocated = await serve(root, ["//:dist", "--plan"])
      expect(first.exitCode, first.logs).toBe(0)
      expect(relocated.exitCode, relocated.logs).toBe(0)
      expect(keyOf(relocated.output, "//:dist")).toBe(keyOf(first.output, "//:dist"))
      await write(root, "PACKAGE.ts", declaration("two"))
      const changed = await serve(root, ["//:dist", "--plan"])
      expect(changed.exitCode, changed.logs).toBe(0)
      expect(keyOf(changed.output, "//:dist")).not.toBe(keyOf(first.output, "//:dist"))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("re-keys a target when the resolved node_modules package version changes", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { tool: S.Shell.Test({ bin: S.NodeModule.Bin("mytool") }) } })
`
    )
    await write(root, "node_modules/mytool/package.json", `{ "name": "mytool", "version": "1.0.0" }\n`)
    await write(root, "node_modules/.bin/mytool", "#!/bin/sh\nexit 0\n")
    await Fs.chmod(NodePath.join(root, "node_modules", ".bin", "mytool"), 0o755)
    commitAll(root)
    const first = await serve(root, ["//:tool", "--plan"])
    expect(first.exitCode).toBe(0)
    await write(root, "node_modules/mytool/package.json", `{ "name": "mytool", "version": "2.0.0" }\n`)
    const second = await serve(root, ["//:tool", "--plan"])
    expect(second.exitCode).toBe(0)
    expect(keyOf(first.output, "//:tool")).not.toBe(keyOf(second.output, "//:tool"))
  })

  it("keys the four sandbox declarations apart", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const confined = S.Shell.Run({ shell: "true" })
const loopback = S.Shell.Run({ shell: "true", sandbox: { network: "loopback" } })
const networked = S.Shell.Run({ shell: "true", sandbox: { network: true } })
const open = S.Shell.Run({ shell: "true", sandbox: "none" })
export const Package = S.Package({ targets: { confined, loopback, networked, open } })
`
    )
    commitAll(root)
    const confined = await serve(root, ["//:confined", "--plan"])
    const loopback = await serve(root, ["//:loopback", "--plan"])
    const networked = await serve(root, ["//:networked", "--plan"])
    const open = await serve(root, ["//:open", "--plan"])
    const keys = [
      keyOf(confined.output, "//:confined"),
      keyOf(loopback.output, "//:loopback"),
      keyOf(networked.output, "//:networked"),
      keyOf(open.output, "//:open")
    ]
    expect(new Set(keys).size).toBe(4)
  })
})

describe("secrets", () => {
  it("does not read a missing secret when the job makes no outbound request", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const push = S.Shell.Run({
  shell: "true",
  secrets: [S.HttpSecret(S.Secret("SMTHRS_TEST_ABSENT_SECRET"), ["http://127.0.0.1:9"])],
  // A closed network cannot reach the secret proxy, so Exec refuses it.
  sandbox: { network: true }
})
export const Package = S.Package({ targets: { push } })
`
    )
    commitAll(root)
    delete process.env["SMTHRS_TEST_ABSENT_SECRET"]
    const { exitCode, logs } = await serve(root, ["//:push"])
    expect(exitCode).toBe(0)
    expect(logs).not.toContain("missing secret")
  })

  it("refuses in --plan an HTTPS audience the payload never names through S.SecretOrigin", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const push = S.Shell.Run({
  shell: "curl -fsS https://api.example.test/user",
  secrets: [S.HttpSecret(S.Secret("SMTHRS_TEST_HTTPS_SECRET"), ["https://api.example.test"])],
  sandbox: { network: true }
})
export const Package = S.Package({ targets: { push } })
`
    )
    commitAll(root)
    const planned = await serve(root, ["//:push", "--plan"])
    expect(planned.output).toContain(
      "the declared secret SMTHRS_TEST_HTTPS_SECRET is bound to https://api.example.test"
    )
    // The plan renders the refusal as a quoted string, so its quotes are escaped.
    expect(planned.output).toContain("point the tool at S.SecretOrigin(\\\"https://api.example.test\\\")")
  })

  it("resolves S.SecretOrigin in env to a brokered origin that substitutes the placeholder", async () => {
    let authorization: string | undefined
    const upstream = NodeHttp.createServer((request, response) => {
      authorization = request.headers.authorization
      response.end("ok")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    const secret = "package-origin-secret"
    process.env["SMTHRS_TEST_ORIGIN_SECRET"] = secret
    try {
      const root = await temporaryWorkspace()
      await write(root, "WORKSPACE.ts", workspaceModule())
      const command = `case "$API" in http://127.0.0.1:${port}) exit 92;; http://127.0.0.1:*) ;; *) exit 91;; esac; ` +
        `curl -sf --noproxy '*' -H "authorization: Bearer $SMTHRS_TEST_ORIGIN_SECRET" "$API/"`
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const push = S.Shell.Run({
  shell: ${JSON.stringify(command)},
  env: { API: S.SecretOrigin("http://127.0.0.1:${port}") },
  secrets: [S.HttpSecret(S.Secret("SMTHRS_TEST_ORIGIN_SECRET"), ["http://127.0.0.1:${port}"])],
  sandbox: "none"
})
export const Package = S.Package({ targets: { push } })
`
      )
      commitAll(root)
      const { exitCode, logs } = await serve(root, ["//:push"])
      expect(exitCode).toBe(0)
      expect(authorization).toBe(`Bearer ${secret}`)
      expect(logs).not.toContain(secret)
    } finally {
      delete process.env["SMTHRS_TEST_ORIGIN_SECRET"]
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it("gives the job a placeholder and substitutes only on the outbound request", async () => {
    let authorization: string | undefined
    const upstream = NodeHttp.createServer((request, response) => {
      authorization = request.headers.authorization
      response.end("ok")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    const secret = "package-boundary-secret"
    process.env["SMTHRS_TEST_BOUNDARY_SECRET"] = secret
    try {
      const root = await temporaryWorkspace()
      await write(root, "WORKSPACE.ts", workspaceModule())
      const command = `case "$SMTHRS_TEST_BOUNDARY_SECRET" in smithers-build-secret-*) ;; *) exit 91;; esac; ` +
        `curl -sf -H "authorization: Bearer $SMTHRS_TEST_BOUNDARY_SECRET" http://127.0.0.1:${port}/`
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const push = S.Shell.Run({
  shell: ${JSON.stringify(command)},
  secrets: [S.HttpSecret(S.Secret("SMTHRS_TEST_BOUNDARY_SECRET"), ["http://127.0.0.1:${port}"])],
  sandbox: "none"
})
export const Package = S.Package({ targets: { push } })
`
      )
      commitAll(root)
      const { exitCode, logs } = await serve(root, ["//:push"])
      expect(exitCode).toBe(0)
      expect(authorization).toBe(`Bearer ${secret}`)
      expect(logs).not.toContain(secret)
    } finally {
      delete process.env["SMTHRS_TEST_BOUNDARY_SECRET"]
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
})

describe.runIf(process.platform === "darwin")("sandbox enforcement (macOS)", () => {
  it("denies undeclared host files outside the workspace", async () => {
    const root = await temporaryWorkspace()
    const hostFiles = await temporaryWorkspace()
    await write(hostFiles, ".ssh/fixture", "synthetic ssh data")
    await write(hostFiles, ".aws/fixture", "synthetic aws data")
    await write(hostFiles, "smithers/fixture", "synthetic state")
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const probe = S.Shell.Test({ shell: ${
        JSON.stringify(
          `cat '${hostFiles}/.ssh/fixture' '${hostFiles}/.aws/fixture' '${hostFiles}/smithers/fixture' > /dev/null`
        )
      } })
export const Package = S.Package({ targets: { probe } })
`
    )
    commitAll(root)
    const result = await serve(root, ["//:probe"])
    expect(result.exitCode, result.logs).toBe(1)
    expect(result.logs).toContain("//:probe  failed")
    for (const file of [".ssh/fixture", ".aws/fixture", "smithers/fixture"]) {
      expect(result.logs).toContain(`${hostFiles}/${file}: Operation not permitted`)
    }
  })

  it("denies network by default, allows it under { network: true }, and skips the wrapper for none", async () => {
    const server = NodeHttp.createServer((_request, response) => response.end("ok"))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    try {
      const root = await temporaryWorkspace()
      await write(root, "WORKSPACE.ts", workspaceModule())
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const fetchCommand = "curl -sf http://127.0.0.1:${port}/ > /dev/null"
const confined = S.Shell.Run({ shell: fetchCommand })
const networked = S.Shell.Run({ shell: fetchCommand, sandbox: { network: true } })
const open = S.Shell.Run({ shell: fetchCommand, sandbox: "none" })
export const Package = S.Package({ targets: { confined, networked, open } })
`
      )
      commitAll(root)
      const confined = await serve(root, ["//:confined"])
      expect(confined.exitCode).toBe(1)
      const networked = await serve(root, ["//:networked"])
      expect(networked.exitCode).toBe(0)
      const open = await serve(root, ["//:open"])
      expect(open.exitCode).toBe(0)
    } finally {
      server.close()
    }
  })

  it("admits loopback listeners under { network: \"loopback\" } and nothing else", async () => {
    // A listener on 127.0.0.1 and one on ::1, each connected to once: the
    // shape of a Go httptest suite. The default profile fails the bind.
    const listen = [
      "const net = require('node:net');",
      "const once = (host) => new Promise((resolve, reject) => {",
      "  const server = net.createServer((socket) => socket.end());",
      "  server.on('error', reject);",
      "  server.listen(0, host, () => {",
      "    const client = net.connect(server.address().port, host, () => client.end());",
      "    client.on('error', reject);",
      "    client.on('close', () => server.close(() => resolve()));",
      "  });",
      "});",
      "once('127.0.0.1').then(() => once('::1')).then(() => process.exit(0), () => process.exit(1));"
    ].join(" ")
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "listen.cjs", `${listen}\n`)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const confined = S.Shell.Run({ shell: ${
        JSON.stringify(`${process.execPath} listen.cjs`)
      }, data: [S.file("listen.cjs")] })
const loopback = S.Shell.Run({ shell: ${
        JSON.stringify(`${process.execPath} listen.cjs`)
      }, data: [S.file("listen.cjs")], sandbox: { network: "loopback" } })
const egress = S.Shell.Run({ shell: "curl -sf --max-time 5 https://example.com/ > /dev/null", sandbox: { network: "loopback" } })
export const Package = S.Package({ targets: { confined, egress, loopback } })
`
    )
    commitAll(root)
    const confined = await serve(root, ["//:confined"])
    expect(confined.exitCode).toBe(1)
    const loopback = await serve(root, ["//:loopback"])
    expect(loopback.exitCode).toBe(0)
    const egress = await serve(root, ["//:egress"])
    expect(egress.exitCode).toBe(1)
  })
})

describe("suite aggregation", () => {
  it("runs members keep-going and reports per-member statuses on red", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const good = S.Shell.Test({ shell: "true" })
const bad = S.Shell.Test({ shell: "false" })
const all = S.Suite({ tests: [good, bad] })
export const Package = S.Package({ targets: { all, bad, good } })
`
    )
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:all"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("//:good  ran")
    expect(logs).toContain("//:bad  failed")
    expect(logs).toContain("suite is red")
    expect(logs).toContain("//:good=ran")
    expect(logs).toContain("//:bad=failed")
  })
})

describe("host binaries", () => {
  it("refuses a declared host binary that is absent from PATH, typed and loud", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(`  host: S.Host({ bins: ["smthrs-definitely-absent-tool"] }),`))
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const scan = S.Shell.Test({ bin: S.Host.bin("smthrs-definitely-absent-tool") })
export const Package = S.Package({ targets: { scan } })
`
    )
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:scan"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("smthrs-definitely-absent-tool")
    expect(logs).toContain("not present on PATH")
  })

  it("fails the graph load for an undeclared host binary", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const scan = S.Shell.Test({ bin: S.Host.bin("undeclared-tool") })
export const Package = S.Package({ targets: { scan } })
`
    )
    commitAll(root)
    const { exitCode, output } = await serve(root, ["query", "//..."])
    expect(exitCode).toBe(1)
    expect(output).toContain("undeclared_host_bin")
  })
})

describe("the review verb and an absent engine CLI", () => {
  /**
   * A PATH carrying `git` and nothing else this test needs to be missing.
   *
   * The review spawns `git` for its diff and then the engine CLI for the
   * model call. Pointing PATH at a directory holding only a `git` shim is what
   * makes "the engine is not installed" a fact of the test rather than a fact
   * of whoever's laptop is running it.
   */
  const pathWithoutEngine = async (root: string): Promise<string> => {
    const bin = NodePath.join(root, ".test-bin")
    await Fs.mkdir(bin, { recursive: true })
    const git = NodeChildProcess.execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    // A host's Git may itself be a policy wrapper needing an interpreter and
    // the underlying Git on PATH. Preserve that environment only inside Git;
    // the review still sees a PATH with no engine executable.
    await Fs.writeFile(
      NodePath.join(bin, "git"),
      `#!/bin/sh\nPATH=${quote(process.env["PATH"] ?? "")}\nexport PATH\nexec ${quote(git)} "$@"\n`,
      { mode: 0o755 }
    )
    return bin
  }

  const withPath = async <A>(bin: string, body: () => Promise<A>): Promise<A> => {
    const previous = process.env["PATH"]
    process.env["PATH"] = bin
    try {
      return await body()
    } finally {
      if (previous === undefined) delete process.env["PATH"]
      else process.env["PATH"] = previous
    }
  }

  const reviewWorkspace = async (): Promise<string> => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const review = S.LlmLint({
  changes: S.gitDiff("HEAD"),
  include: [S.glob("src/**/*.ts")],
  deps: [],
  prompt: "p",
  rubric: "r",
  engine: "codex",
  model: "gpt-5.6-luna",
  batchSize: 1
})
export const Package = S.Package({ targets: { review } })
`
    )
    await write(root, "src/a.ts", "export const a = 1\n")
    commitAll(root)
    // One changed file, so the review reaches the engine call instead of
    // returning the empty report an unchanged tree produces.
    await write(root, "src/a.ts", "export const a = 2\n")
    return root
  }

  it("plans a review target under review alone and refuses it under lint", async () => {
    const root = await reviewWorkspace()
    const review = await serve(root, ["review", "//:review", "--plan"])
    expect(review.exitCode).toBe(0)
    expect(review.output).toContain("//:review")
    // An exact label under a verb its rule does not participate in is the same
    // refusal every other unsupported verb produces, not a silent no-op.
    const lint = await serve(root, ["lint", "//:review", "--plan"])
    expect(lint.exitCode).toBe(1)
    expect(lint.output).toContain("does not support the lint verb")
    // A wildcard under the aggregate verb selects nothing and says so, rather
    // than expanding the target's plan-time git diff against a base the
    // checkout may not carry.
    const ci = await serve(root, ["ci", "//...", "--plan"])
    expect(ci.output).not.toContain("LlmLint")
  })

  it("skips rather than fails when the engine CLI is not installed", async () => {
    const root = await reviewWorkspace()
    const bin = await pathWithoutEngine(root)
    const engine = NodeChildProcess.spawnSync("/bin/sh", ["-c", "command -v codex"], {
      env: { ...process.env, PATH: bin },
      encoding: "utf8"
    })
    expect(engine.status).not.toBe(0)
    expect(engine.stdout).toBe("")
    const { exitCode, logs } = await withPath(bin, () => serve(root, ["review", "//:review"]))
    // Green: a host with no model CLI cannot say whether the diff is clean,
    // and reporting "unclean" for that is a red gate no commit can turn green.
    expect(exitCode).toBe(0)
    expect(logs).toContain("//:review")
    expect(logs).toContain("//:review  skipped")
    // The notice names the executable, so the report says WHY the review did
    // not run rather than only that it did not.
    expect(logs).toContain("the codex CLI is not installed on this host, so the review did not run")
    expect(logs).toContain("0 failed, 1 skipped")
  })
})

describe("data-edge law", () => {
  it("fails the graph load when a Run target is reachable through data", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const side = S.Shell.Run({ shell: "true" })
const consumer = S.Shell.Test({ shell: "true", data: [side] })
export const Package = S.Package({ targets: { consumer, side } })
`
    )
    commitAll(root)
    const { exitCode, output } = await serve(root, ["query", "//..."])
    expect(exitCode).toBe(1)
    expect(output).toContain("illegal_data_target")
  })
})

describe("generate", () => {
  it("emits a declared symlink with --write, then checks green until it is removed", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const claudeMd = S.Generate({ emit: { "CLAUDE.md": S.symlink("AGENTS.md") } })
export const Package = S.Package({ targets: { claudeMd } })
`
    )
    await write(root, "AGENTS.md", "# agents\n")
    commitAll(root)
    const missing = await serve(root, ["//:claudeMd"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs).toContain("drift in declared emit outputs")
    const applied = await serve(root, ["//:claudeMd", "--write"])
    expect(applied.exitCode).toBe(0)
    expect(await Fs.readlink(NodePath.join(root, "CLAUDE.md"))).toBe("AGENTS.md")
    const green = await serve(root, ["//:claudeMd"])
    expect(green.exitCode).toBe(0)
    await Fs.rm(NodePath.join(root, "CLAUDE.md"))
    const red = await serve(root, ["//:claudeMd"])
    expect(red.exitCode).toBe(1)
  })

  it("checks script drift against a scratch copy and applies with --write", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const gen = S.Generate({ script: S.file("//gen.mjs"), changes: ["out.gen.txt"] })
export const Package = S.Package({ targets: { gen } })
`
    )
    await write(
      root,
      "gen.mjs",
      `import { writeFileSync } from "node:fs"\nwriteFileSync("out.gen.txt", "generated\\n")\n`
    )
    await write(root, "out.gen.txt", "generated\n")
    commitAll(root)
    const green = await serve(root, ["//:gen"])
    expect(green.exitCode).toBe(0)
    await write(root, "out.gen.txt", "hand edited\n")
    const red = await serve(root, ["//:gen"])
    expect(red.exitCode).toBe(1)
    expect(red.logs).toContain("out.gen.txt")
    // Check mode never repaired the real tree.
    expect(await Fs.readFile(NodePath.join(root, "out.gen.txt"), "utf8")).toBe("hand edited\n")
    const applied = await serve(root, ["//:gen", "--write"])
    expect(applied.exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out.gen.txt"), "utf8")).toBe("generated\n")
  })

  it("runs the bin form through the same check, drift, and write bracket", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(`  host: S.Host({ bins: ["sh"] }),`))
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const gen = S.Generate({
  bin: S.Host.bin("sh"),
  args: ["-c", "printf 'generated\\n' > out.gen.txt"],
  changes: ["out.gen.txt"]
})
export const Package = S.Package({ targets: { gen } })
`
    )
    await write(root, "out.gen.txt", "generated\n")
    commitAll(root)
    const green = await serve(root, ["//:gen"])
    expect(green.exitCode).toBe(0)
    expect(green.logs).not.toContain("NotImplemented")
    await write(root, "out.gen.txt", "hand edited\n")
    const red = await serve(root, ["//:gen"])
    expect(red.exitCode).toBe(1)
    expect(red.logs).toContain("out.gen.txt")
    expect(await Fs.readFile(NodePath.join(root, "out.gen.txt"), "utf8")).toBe("hand edited\n")
    const applied = await serve(root, ["//:gen", "--write"])
    expect(applied.exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out.gen.txt"), "utf8")).toBe("generated\n")
  })

  it("captures the stdout form inside the same check and write bracket", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(`  host: S.Host({ bins: ["sh"] }),`))
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const gen = S.Generate({ bin: S.Host.bin("sh"), args: ["-c", "echo generated"], stdout: "out.gen.txt" })
export const Package = S.Package({ targets: { gen } })
`
    )
    await write(root, "out.gen.txt", "old\n")
    commitAll(root)
    const red = await serve(root, ["//:gen"])
    expect(red.exitCode).toBe(1)
    expect(red.logs).toContain("out.gen.txt")
    expect(await Fs.readFile(NodePath.join(root, "out.gen.txt"), "utf8")).toBe("old\n")
    expect((await serve(root, ["//:gen", "--write"])).exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out.gen.txt"), "utf8")).toBe("generated\n")
    expect((await serve(root, ["//:gen"])).exitCode).toBe(0)
  })
})

describe("target body execution", () => {
  it("pins the fixtures/target-body pnpm to the repository pin", async () => {
    // A bump of the root packageManager must also update these two files, or
    // the families test below makes pnpm switch versions mid-install.
    const fixture = NodePath.join(import.meta.dirname, "fixtures/target-body")
    const manifest = JSON.parse(await Fs.readFile(NodePath.join(fixture, "package.json"), "utf8")) as {
      readonly packageManager: string
    }
    expect(manifest.packageManager).toBe(`pnpm@${repositoryPnpmVersion}`)
    await expect(Fs.readFile(NodePath.join(fixture, "PACKAGE.ts"), "utf8")).resolves
      .toContain(`S.PackageManager.Pnpm({ version: "${repositoryPnpmVersion}", runtime })`)
  })

  it("runs the repository target families and aggregate verbs from PACKAGE.ts", async () => {
    const fixture = NodePath.join(import.meta.dirname, "fixtures/target-body")
    const root = await temporaryWorkspace()
    await Fs.cp(fixture, root, { recursive: true })
    const generated = [
      ".flows",
      ".git",
      ".github",
      "dist",
      "generated-tsconfig.json",
      "generated.txt",
      "node_modules"
    ]
    try {
      commitAll(root)
      const dependencies = NodePath.resolve(import.meta.dirname, "../node_modules")
      await Fs.mkdir(NodePath.join(root, "node_modules"))
      for (const name of await Fs.readdir(dependencies)) {
        if (name === ".bin") {
          await Fs.mkdir(NodePath.join(root, "node_modules", name))
          for (const binary of await Fs.readdir(NodePath.join(dependencies, name))) {
            // Keep each shim's real location: copying a pnpm shim or linking
            // only its directory breaks its relative path to the tool.
            await Fs.symlink(
              await Fs.realpath(NodePath.join(dependencies, name, binary)),
              NodePath.join(root, "node_modules", name, binary),
              "file"
            )
          }
        } else if (name.startsWith("@")) {
          await Fs.mkdir(NodePath.join(root, "node_modules", name))
          for (const scoped of await Fs.readdir(NodePath.join(dependencies, name))) {
            await Fs.symlink(
              await Fs.realpath(NodePath.join(dependencies, name, scoped)),
              NodePath.join(root, "node_modules", name, scoped),
              "dir"
            )
          }
        } else {
          await Fs.symlink(
            await Fs.realpath(NodePath.join(dependencies, name)),
            NodePath.join(root, "node_modules", name),
            "dir"
          )
        }
      }
      // An empty bunx cache must still resolve the same installed Vitest
      // that the fixture imports, without downloading another version.
      const vitestVersion = JSON.parse(await Fs.readFile(NodePath.join(dependencies, "vitest/package.json"), "utf8"))
        .version
      const toolProbe = NodeChildProcess.spawnSync("bun", ["x", "--bun", "--no-install", "vitest", "--version"], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, BUN_INSTALL_CACHE_DIR: NodePath.join(root, ".flows/bun-probe-cache") }
      })
      expect(toolProbe.status, toolProbe.stderr).toBe(0)
      expect(toolProbe.stdout).toContain(`vitest/${vitestVersion} `)
      for (
        const args of [
          ["test", "//:nodeTest"],
          ["test", "//:vitest"],
          ["build", "//:typecheck"],
          ["lint", "//:eslint"],
          ["lint", "//:dprint"],
          ["build", "//:tsconfig"],
          ["build", "//:build"],
          ["run", "//:generate"],
          ["build", "//:lockfile"],
          ["//:ci", "--write"],
          ["docs", "//:docs"],
          ["ci", "//:docs"],
          ["ci", "//:nodeTest"]
        ]
      ) {
        const result = await serve(root, args)
        expect(result.exitCode, `${args.join(" ")}\n${result.output}\n${result.logs}`).toBe(0)
        expect(result.output + result.logs).not.toContain("NotImplemented")
      }
      const cached = await serve(root, ["docs", "//:docs"])
      expect(cached.exitCode, `${cached.output}\n${cached.logs}`).toBe(0)
      expect(cached.output).toContain("hit: 1")
      await Fs.rm(NodePath.join(root, "node_modules"), { recursive: true, force: true })
      await write(
        root,
        "package.json",
        `${
          JSON.stringify(
            {
              name: "target-body-fixture",
              private: true,
              type: "module",
              packageManager: `pnpm@${repositoryPnpmVersion}`,
              engines: { node: ">=26.4.0" },
              dependencies: { "fixture-dep": "link:dep" }
            },
            undefined,
            2
          )
        }\n`
      )
      await write(
        root,
        "pnpm-lock.yaml",
        "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    dependencies:\n      fixture-dep:\n        specifier: link:dep\n        version: link:dep\n"
      )
      const installed = await serve(root, ["install"])
      expect(installed.exitCode, `${installed.output}\n${installed.logs}`).toBe(0)
      await expect(Fs.readFile(NodePath.join(root, "generated.txt"), "utf8")).resolves.toBe("generated\n")
      await expect(Fs.stat(NodePath.join(root, "dist/esm/value.js"))).resolves.toBeDefined()
      await expect(Fs.stat(NodePath.join(root, ".github/workflows/ci.yml"))).resolves.toBeDefined()
    } finally {
      await Promise.all(generated.map((path) => Fs.rm(NodePath.join(root, path), { recursive: true, force: true })))
    }
  }, 120_000)
})

describe("declaration modules", () => {
  it("names the exported namespaces when a declaration reads a rule off an absent one", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const test = S.Zig.Build({ context: "." })
export const Package = S.Package({ targets: { test } })
`
    )
    commitAll(root)
    const { exitCode, output, logs } = await serve(root, ["query", "//..."])
    expect(exitCode).toBe(1)
    const text = output + logs
    expect(text).toContain("module_import_failed")
    expect(text).toContain("reading 'Build'")
    expect(text).toContain("this loader exports no such namespace")
    expect(text).toContain("Shell")
    expect(text).toContain("Github")
  })
})

describe("the whole-tree permit", () => {
  it("is exclusive for every rule that snapshots the tree, not only for write mode", () => {
    // Docs.Page, Agent.Diff and Agent.Pr reach the write-set guard through the
    // candidate applier while their mode is `execute`, so a permit keyed on
    // write mode alone let them snapshot and revert the whole repository
    // beside a peer that was writing its own declared outputs.
    for (const rule of ["Docs.Page", "Agent.Diff", "Agent.Pr", "Git.Commit"]) {
      expect(takesExclusiveTreePermit({ rule, mode: "execute" })).toBe(true)
    }
    // Scratch checks census live ignored paths and restore escaping symlink
    // targets too. A library rebuild must not race that census or rollback.
    expect(takesExclusiveTreePermit({ rule: "Generate", mode: "write" })).toBe(true)
    for (const rule of ["Generate", "Shell.Diff", "Changesets.Version", "Go.Generate", "Go.Lint"]) {
      expect(takesExclusiveTreePermit({ rule, mode: "check" })).toBe(true)
    }
    // An ordinary build remains shared; an overlay consumer uses the same
    // scratch/portal bracket as a check and must exclude its peers.
    expect(takesExclusiveTreePermit({ rule: "Shell.Build", mode: "execute" })).toBe(false)
    expect(takesExclusiveTreePermit({
      rule: "Shell.Build",
      mode: "execute",
      overlays: [{ overlay: "//:patch", path: "input.txt", source: "patch.txt", digest: "patch-digest" }]
    })).toBe(true)
    // Agent.Lint returns its report before it touches the applier in check
    // mode, and its fix mode is write mode, so it needs no special case.
    expect(takesExclusiveTreePermit({ rule: "Agent.Lint", mode: "check" })).toBe(false)
  })
})
