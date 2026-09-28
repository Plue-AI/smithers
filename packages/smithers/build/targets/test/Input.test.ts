import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as SafeFs from "../src/SafeFs.ts"

let root: string
let outside: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const at = (relative: string): string => NodePath.join(root, relative)

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

const unprivileged = process.getuid?.() !== 0

const posixOnly = process.platform !== "win32"

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-input-"))
  outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-"))
  await write("src/index.ts", "export const a = 1\n")
  await write("src/nested/deep.ts", "export const b = 2\n")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(outside, { recursive: true, force: true })
})

describe("Input nested ignore precedence", () => {
  const list = async (method: string): Promise<ReadonlyArray<string>> =>
    method === "discoverFiles"
      ? (await Input.discoverFiles(root)).filter((path) => path.endsWith(".log"))
      : Input.expandGlob(root, "", method)

  it.each(["discoverFiles", "**/*.log", "src/**/*.log", "src/nested/**/*.log"])(
    "%s lets deeper negations restore files ignored by a parent",
    async (method) => {
      await write(".gitignore", "*.log\n")
      await write("root.log", "ignored\n")
      await write("src/.gitignore", "!**/*.log\n")
      await write("src/nested/.gitignore", "*.tmp\n")
      await write("src/nested/keep.log", "kept\n")
      await write("src/nested/deeper/.gitignore", "*.log\n")
      await write("src/nested/deeper/drop.log", "ignored again\n")
      expect(await list(method)).toEqual(["src/nested/keep.log"])
    }
  )

  it.each(["discoverFiles", "**/*.log", "src/**/*.log", "src/nested/**/*.log"])(
    "%s cannot restore files below an excluded directory",
    async (method) => {
      await write(".gitignore", "src/\n")
      await write("src/.gitignore", "!**/*.log\n")
      await write("src/nested/keep.log", "still ignored\n")
      expect(await list(method)).toEqual([])
    }
  )
})

describe("Input.resolvePath", () => {
  it.each(["/src/**", "/"])("refuses the single-slash absolute path %j and names //", (value) => {
    expect(() => Input.resolvePath("pkg", value)).toThrow(/single "\/".*"\/\/"/)
  })

  it("resolves // from the workspace root and a bare path from the package", () => {
    expect(Input.resolvePath("pkg", "//src/**")).toBe("src/**")
    expect(Input.resolvePath("pkg", "src/**")).toBe("pkg/src/**")
  })
})

describe("Input.expandGlob", () => {
  it.each(["C:/outside/*.ts", "src\\*.ts", "src/\uD800.ts", "src/\0.ts"])(
    "refuses the non-portable pattern %j",
    async (pattern) => {
      await expect(Input.expandGlob(root, "", pattern)).rejects.toThrow(/not a portable workspace path/)
    }
  )

  it.each(
    [
      ["entries", { entries: 0 }],
      ["files", { files: 1 }],
      ["depth", { depth: 1 }]
    ] as const
  )("fails closed at the %s traversal limit", async (_name, limits) => {
    await expect(Input.expandGlob(root, "", "**/*.ts", { limits })).rejects.toThrow(/limit|more than/)
  })

  it("bounds the aggregate .gitignore text read by one traversal", async () => {
    await write(".gitignore", "# root\n")
    await write("src/.gitignore", "# source\n")
    await expect(Input.expandGlob(root, "", "**/*.ts", { limits: { ignoreBytes: 8 } }))
      .rejects.toThrow(/ignoreBytes limit/)
  })

  it.each([Number.NaN, -1, 1.5, Input.maximumScanLimits.entries + 1])(
    "refuses the invalid traversal entry limit %s",
    async (entries) => {
      await expect(Input.expandGlob(root, "", "**/*.ts", { limits: { entries } }))
        .rejects.toThrow(/input scan limit entries/)
    }
  )

  it("fails closed when hostile scan limits cannot be inspected", async () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    await expect(Input.expandGlob(root, "", "**/*.ts", { limits: revoked.proxy }))
      .rejects.toThrow(/scan limits could not be inspected/)
  })

  it("observes cancellation before traversing the workspace", async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled by test"))
    await expect(Input.expandGlob(root, "", "**/*.ts", { signal: controller.signal }))
      .rejects.toThrow(/cancelled by test/)
  })

  it("never expands into the default cache directory", async () => {
    await write(".flows/cache/ab/entry.ts", "export const cached = 1\n")
    await write(".flows/knip-0.json", "{}")
    expect(await Input.expandGlob(root, "", "**/*.ts")).toEqual([
      "src/index.ts",
      "src/nested/deep.ts"
    ])
    expect(await Input.expandGlob(root, "", ".flows/**/*.ts")).toEqual([])
  })

  it("never expands into a configured cache directory", async () => {
    await write("build/cache/entry.ts", "export const cached = 1\n")
    await write(".flows/kept.ts", "export const kept = 1\n")
    await write(".flows/store/pnpm/index.ts", "export const stored = 1\n")
    expect(await Input.expandGlob(root, "", "**/*.ts", { cacheDirectory: "build/cache" })).toEqual([
      ".flows/kept.ts",
      "src/index.ts",
      "src/nested/deep.ts"
    ])
    expect(await Input.expandGlob(root, "", "build/**/*.ts", { cacheDirectory: "build/cache" })).toEqual([])
  })

  it("excludes the cache directory even when nothing ignores it", async () => {
    await write(".gitignore", "dist/\n")
    await write("dist/out.ts", "export const out = 1\n")
    await write(".flows/cache/entry.ts", "export const cached = 1\n")
    expect(await Input.expandGlob(root, "", "**/*.ts")).toEqual([
      "src/index.ts",
      "src/nested/deep.ts"
    ])
  })

  it("never descends into a subdirectory holding a PACKAGE.ts file", async () => {
    await write("src/sub/PACKAGE.ts", "export const nothing = 1\n")
    await write("src/sub/inner.ts", "export const inner = 1\n")
    await write("src/sub/deeper/deep.ts", "export const deep = 1\n")
    expect(await Input.expandGlob(root, "", "**/*.ts")).toEqual([
      "src/index.ts",
      "src/nested/deep.ts"
    ])
    expect(await Input.expandGlob(root, "", "src/**/*.ts")).toEqual([
      "src/index.ts",
      "src/nested/deep.ts"
    ])
  })

  it("scopes a package's glob to its own package", async () => {
    await write("packages/a/PACKAGE.ts", "export const nothing = 1\n")
    await write("packages/a/src/index.ts", "export const a = 1\n")
    await write("packages/a/examples/PACKAGE.ts", "export const nothing = 1\n")
    await write("packages/a/examples/demo.ts", "export const demo = 1\n")
    expect(await Input.expandGlob(root, "packages/a", "**/*.ts")).toEqual([
      "packages/a/PACKAGE.ts",
      "packages/a/src/index.ts"
    ])
  })

  it("cannot bypass a subpackage boundary with a static prefix", async () => {
    await write("packages/a/PACKAGE.ts", "export const nothing = 1\n")
    await write("packages/a/src/index.ts", "export const a = 1\n")
    expect(await Input.expandGlob(root, "", "packages/a/src/**/*.ts")).toEqual([])
    expect(await Input.expandGlob(root, "", "//packages/a/src/**/*.ts")).toEqual([])
  })

  it("allows a static prefix inside the declaring package", async () => {
    await write("packages/a/PACKAGE.ts", "export const nothing = 1\n")
    await write("packages/a/src/index.ts", "export const a = 1\n")
    expect(await Input.expandGlob(root, "packages/a", "src/**/*.ts")).toEqual([
      "packages/a/src/index.ts"
    ])
  })

  it("does not treat an explicitly entered repository as a package boundary", async () => {
    await write("vendor/repo/PACKAGE.ts", "export const nothing = 1\n")
    await write("vendor/repo/src/index.ts", "export const value = 1\n")
    expect(
      await Input.expandGlob(root, "", "vendor/repo/**/*.ts", {
        repositoryBoundaries: ["vendor/repo"]
      })
    ).toEqual([
      "vendor/repo/PACKAGE.ts",
      "vendor/repo/src/index.ts"
    ])
  })

  it("keeps root-anchored globs scoped to the declaring package", async () => {
    await write("root.ts", "export const root = 1\n")
    await write("packages/a/PACKAGE.ts", "export const nothing = 1\n")
    await write("packages/a/src/index.ts", "export const a = 1\n")
    expect(await Input.expandGlob(root, "packages/a", "//packages/a/src/**/*.ts")).toEqual([
      "packages/a/src/index.ts"
    ])
    expect(await Input.expandGlob(root, "packages/a", "//*.ts")).toEqual([])
  })

  it("keeps concurrent cache-directory options isolated", async () => {
    await write("build/cache/build.ts", "export const build = 1\n")
    await write("other/cache/other.ts", "export const other = 1\n")
    const [buildCache, otherCache] = await Promise.all([
      Input.expandGlob(root, "", "**/*.ts", { cacheDirectory: "build/cache" }),
      Input.expandGlob(root, "", "**/*.ts", { cacheDirectory: "other/cache" })
    ])
    expect(buildCache).toEqual([
      "other/cache/other.ts",
      "src/index.ts",
      "src/nested/deep.ts"
    ])
    expect(otherCache).toEqual([
      "build/cache/build.ts",
      "src/index.ts",
      "src/nested/deep.ts"
    ])
  })

  /**
   * The regression. The static prefix used to be admitted by a bare `stat`,
   * which follows symbolic links, and the walk then listed whatever it landed
   * on. A `vendor` link pointing at another repository made every file in that
   * repository a declared input of this workspace, digested under a
   * `vendor/...` name that names nothing here.
   */
  it("never walks a static prefix that is a link out of the workspace", async () => {
    await Fs.mkdir(NodePath.join(outside, "loot"), { recursive: true })
    await Fs.writeFile(NodePath.join(outside, "loot", "secret.ts"), "not ours\n", "utf8")
    await Fs.symlink(NodePath.join(outside, "loot"), at("vendor"))
    expect(await Input.expandGlob(root, "", "vendor/**/*.ts")).toEqual([])
    expect(await Input.expandGlob(root, "", "**/*.ts")).toEqual([
      "src/index.ts",
      "src/nested/deep.ts"
    ])
  })

  /**
   * The same escape, one level deeper: the prefix names a real directory on
   * the other side of the link, so the old single `stat` was satisfied and
   * walked it. Every segment is now resolved, so the link is refused where it
   * stands and the prefix is simply not reachable.
   */
  it("never walks a static prefix reached through a link out of the workspace", async () => {
    await Fs.mkdir(NodePath.join(outside, "vendor", "pkg"), { recursive: true })
    await Fs.writeFile(NodePath.join(outside, "vendor", "pkg", "a.ts"), "not ours\n", "utf8")
    await Fs.symlink(NodePath.join(outside, "vendor"), at("vendor"))
    expect(await Input.expandGlob(root, "", "vendor/pkg/**/*.ts")).toEqual([])
    expect(await Input.expandGlob(root, "", "vendor/**")).toEqual([])
  })

  /**
   * The swap seam. A directory listed as a directory, then replaced with a
   * link out of the workspace before it is read, is refused rather than
   * followed.
   */
  it("refuses a directory swapped for an outside link mid-walk", async () => {
    const target = at("src/nested")
    let seen = 0
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      // The walk works in canonical paths, which on this host are not the
      // spelling the test created the directory under.
      lstat: async (path) => {
        const stats = await SafeFs.defaultIo.lstat(path)
        if (path.endsWith(`${NodePath.sep}src${NodePath.sep}nested`)) {
          seen += 1
          if (seen === 1) {
            await Fs.rm(target, { recursive: true, force: true })
            await Fs.symlink(outside, target)
          }
        }
        return stats
      }
    }
    await expect(Input.expandGlob(root, "", "**/*.ts", { io }))
      .rejects.toThrow(/resolves outside the workspace/)
  })

  it("never descends a directory link, even one staying inside the workspace", async () => {
    await Fs.symlink(at("src"), at("mirror"))
    expect(await Input.expandGlob(root, "", "**/*.ts")).toEqual([
      "src/index.ts",
      "src/nested/deep.ts"
    ])
  })

  it("collects a file link inside the workspace and skips one leaving it", async () => {
    await Fs.writeFile(NodePath.join(outside, "secret.ts"), "not ours\n", "utf8")
    await Fs.symlink(NodePath.join(outside, "secret.ts"), at("src/escape.ts"))
    await Fs.symlink(at("src/index.ts"), at("src/alias.ts"))
    await Fs.symlink(at("src/missing.ts"), at("src/dangling.ts"))
    expect(await Input.expandGlob(root, "", "src/*.ts")).toEqual([
      "src/alias.ts",
      "src/index.ts"
    ])
  })

  it("skips file links whose targets loop or pass through a regular file", async () => {
    await Fs.symlink(at("src/loop.ts"), at("src/loop.ts"))
    await Fs.symlink(at("src/index.ts/child"), at("src/not-a-directory.ts"))
    expect(await Input.expandGlob(root, "", "src/*.ts")).toEqual(["src/index.ts"])
  })

  /**
   * A `PACKAGE.ts` that is a link is a package marker exactly when the workspace
   * index would import it. Deciding otherwise would erase a boundary the index
   * knows about, and the glob would then reach into another package's files.
   */
  it("treats a linked PACKAGE.ts as the package boundary it is", async () => {
    await write("marker.ts", "export const marker = 1\n")
    await write("src/sub/inner.ts", "export const inner = 1\n")
    await Fs.symlink(at("marker.ts"), at("src/sub/PACKAGE.ts"))
    expect(await Input.expandGlob(root, "", "**/*.ts")).toEqual([
      "marker.ts",
      "src/index.ts",
      "src/nested/deep.ts"
    ])
  })

  it("never lets a directory named PACKAGE.ts invent a package boundary", async () => {
    await Fs.mkdir(at("src/sub/PACKAGE.ts"), { recursive: true })
    await write("src/sub/inner.ts", "export const inner = 1\n")
    expect(await Input.expandGlob(root, "", "**/*.ts")).toEqual([
      "src/index.ts",
      "src/nested/deep.ts",
      "src/sub/inner.ts"
    ])
  })

  /**
   * Every `.gitignore` failure used to read as an empty file, so a matcher
   * that should have excluded generated output excluded nothing and pulled it
   * into key material instead.
   */
  it.runIf(unprivileged)("fails on a .gitignore it cannot read", async () => {
    await write(".gitignore", "src/nested/\n")
    await Fs.chmod(at(".gitignore"), 0o000)
    try {
      await expect(Input.expandGlob(root, "", "**/*.ts")).rejects.toMatchObject({ code: "EACCES" })
    } finally {
      await Fs.chmod(at(".gitignore"), 0o600).catch(() => undefined)
    }
  })

  it("fails on a .gitignore that is not valid UTF-8", async () => {
    await Fs.writeFile(at(".gitignore"), Buffer.from([0x73, 0xff, 0xfe, 0x0a]))
    await expect(Input.expandGlob(root, "", "**/*.ts")).rejects.toThrow(/not valid UTF-8/)
  })

  it("fails on a .gitignore over the size limit", async () => {
    await write(".gitignore", `${"#".repeat(1024 * 1024)}\n`)
    await expect(Input.expandGlob(root, "", "**/*.ts")).rejects.toThrow(/larger than \d+ bytes/)
  })

  it.runIf(posixOnly)("fails on a .gitignore that is a FIFO", async () => {
    execFileSync("mkfifo", [at(".gitignore")])
    await expect(Input.expandGlob(root, "", "**/*.ts")).rejects.toThrow(/not a regular file/)
  })

  it.runIf(unprivileged)("fails on a directory it cannot list", async () => {
    await Fs.chmod(at("src/nested"), 0o000)
    try {
      await expect(Input.expandGlob(root, "", "**/*.ts")).rejects.toMatchObject({ code: "EACCES" })
    } finally {
      await Fs.chmod(at("src/nested"), 0o700).catch(() => undefined)
    }
  })
})

/**
 * A tree the walk reads through a fake {@link SafeFs.Io}, so a test can watch
 * how many listings the traversal holds open at the same time. Every listing
 * defers to a macrotask, which is what makes concurrently requested reads
 * overlap the way a real `opendir` handle does.
 */
const seamTree = (
  siblings: number,
  failing?: string
): {
  readonly io: SafeFs.Io
  peak: () => number
  active: () => number
} => {
  const names = Array.from({ length: siblings }, (_, index) => `d${String(index).padStart(4, "0")}`)
  const directories = new Set(["/ws", "/ws/src", ...names.map((name) => `/ws/src/${name}`)])
  const stats = (directory: boolean): SafeFs.Stats =>
    ({
      isDirectory: () => directory,
      isFile: () => !directory,
      isSymbolicLink: () => false,
      dev: 1n,
      ino: 1n,
      size: 0n,
      mtimeNs: 0n,
      ctimeNs: 0n
    }) as unknown as SafeFs.Stats
  const dirent = (name: string, directory: boolean) =>
    ({
      name,
      isDirectory: () => directory,
      isFile: () => !directory,
      isSymbolicLink: () => false
    }) as unknown as Awaited<ReturnType<SafeFs.Io["readdir"]>>[number]
  let inFlight = 0
  let peak = 0
  return {
    peak: () => peak,
    active: () => inFlight,
    io: {
      realpath: async (path) => path,
      lstat: async (path) => {
        if (directories.has(path)) return stats(true)
        if (path.endsWith("/file.ts")) return stats(false)
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
      },
      readdir: async (path) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        try {
          await new Promise((resolve) => setTimeout(resolve, 1))
          if (failing !== undefined && path === `/ws/src/${failing}`) {
            throw Object.assign(new Error(`EACCES: ${path}`), { code: "EACCES" })
          }
          if (path === "/ws") return [dirent("src", true)]
          if (path === "/ws/src") return names.map((name) => dirent(name, true))
          return [dirent("file.ts", false)]
        } finally {
          inFlight -= 1
        }
      },
      open: async () => {
        throw new Error("open should not be called")
      }
    }
  }
}

/**
 * A wide tree used to fan every sibling directory out at once, so the number
 * of open directory handles was the width of the tree rather than a bound the
 * rest of the input pipeline already respects. A failure returned to the
 * caller while its siblings were still reading, too.
 */
describe("Input.expandGlob traversal fan-out", () => {
  it("holds no more listings open than the digest concurrency", async () => {
    const seam = seamTree(256)
    const found = await Input.expandGlob("/ws", "", "src/**/*.ts", { io: seam.io })
    expect(found).toHaveLength(256)
    expect(seam.peak()).toBeLessThanOrEqual(Input.defaultDigestConcurrency)
    // Still concurrent: a serial descent would never hold two listings at once.
    expect(seam.peak()).toBeGreaterThan(1)
    expect(seam.active()).toBe(0)
  })

  it("leaves no listing in flight when a directory fails", async () => {
    const seam = seamTree(256, "d0100")
    await expect(Input.expandGlob("/ws", "", "src/**/*.ts", { io: seam.io }))
      .rejects.toMatchObject({ code: "EACCES" })
    expect(seam.active()).toBe(0)
    expect(seam.peak()).toBeLessThanOrEqual(Input.defaultDigestConcurrency)
  })

  it("bounds discoverFiles the same way", async () => {
    const seam = seamTree(256)
    expect(await Input.discoverFiles("/ws", { io: seam.io })).toHaveLength(256)
    expect(seam.peak()).toBeLessThanOrEqual(Input.defaultDigestConcurrency)
    expect(seam.active()).toBe(0)
  })
})

describe("Input.expandPnpmWorkspace", () => {
  it("ignores comments and unrelated scalar, object, and array settings", async () => {
    await write("package.json", "{}\n")
    await write("packages/included/package.json", "{}\n")
    await write("packages/excluded/package.json", "{}\n")
    await write(
      "pnpm-workspace.yaml",
      [
        "# pnpm may preserve operator comments",
        "packages:",
        "  - packages/*",
        "  - '!packages/excluded'",
        "futureSetting:",
        "  enabled: true",
        "minimumReleaseAgeExclude:",
        "  - example@1.0.0",
        "linkWorkspacePackages: true",
        ""
      ].join("\n")
    )

    expect(await Input.expandPnpmWorkspace(root, "", Input.pnpmWorkspace("//pnpm-workspace.yaml")))
      .toEqual([
        "package.json",
        "packages/included/package.json",
        "pnpm-workspace.yaml"
      ])
  })

  it("resolves members relative to a workspace file below the root", async () => {
    await write("package.json", "{}\n")
    await write("sub/package.json", "{}\n")
    await write("sub/member/package.json", "{}\n")
    await write("sub/pnpm-workspace.yaml", "packages:\n  - '*'\n")

    expect(await Input.expandPnpmWorkspace(root, "", Input.pnpmWorkspace("//sub/pnpm-workspace.yaml")))
      .toEqual([
        "sub/member/package.json",
        "sub/package.json",
        "sub/pnpm-workspace.yaml"
      ])
  })

  /**
   * A workspace declaration is the membership source for every package the
   * lockfile resolves, so a file it cannot read as one is a refusal rather
   * than an empty member set that silently drops packages from key material.
   */
  it.each([
    ["a missing file", undefined, /pnpm workspace does not exist: pnpm-workspace\.yaml/],
    ["YAML that does not parse", "packages: [unclosed\n", /could not parse pnpm workspace pnpm-workspace\.yaml/],
    [
      "a missing packages key",
      "linkWorkspacePackages: true\n",
      /could not validate pnpm workspace pnpm-workspace\.yaml/
    ],
    ["an empty packages list", "packages: []\n", /could not validate pnpm workspace pnpm-workspace\.yaml/],
    ["packages that is not a list", "packages: everything\n", /could not validate pnpm workspace pnpm-workspace\.yaml/],
    ["an empty exclusion", "packages:\n  - '!'\n", /contains an empty exclusion/],
    ["no package inclusion", "packages:\n  - '!packages/excluded'\n", /contains no package inclusion/]
  ])("refuses %s", async (_label, contents, message) => {
    await write("package.json", "{}\n")
    if (contents !== undefined) await write("pnpm-workspace.yaml", contents)
    await expect(Input.expandPnpmWorkspace(root, "", Input.pnpmWorkspace("//pnpm-workspace.yaml")))
      .rejects.toThrow(message)
  })
})

describe("Input.discoverFiles", () => {
  it("lists every workspace file, including PACKAGE.ts files", async () => {
    await write("PACKAGE.ts", "export const nothing = 1\n")
    await write("packages/a/PACKAGE.ts", "export const nothing = 1\n")
    await write("packages/a/src/index.ts", "export const a = 1\n")
    expect(await Input.discoverFiles(root)).toEqual([
      "PACKAGE.ts",
      "packages/a/PACKAGE.ts",
      "packages/a/src/index.ts",
      "src/index.ts",
      "src/nested/deep.ts"
    ])
  })

  /**
   * git applies a `.gitignore` in every directory, not only the root one. A
   * fallback listing that read the root file alone reported files git would
   * never have listed, so the fallback and the git listing disagreed about
   * what the workspace contained.
   */
  it("honors a nested .gitignore, not only the root one", async () => {
    await write(".gitignore", "/generated/\n")
    await write("generated/out.ts", "export const out = 1\n")
    await write("packages/a/.gitignore", "dist/\n")
    await write("packages/a/dist/bundle.ts", "export const bundle = 1\n")
    await write("packages/a/src/index.ts", "export const a = 1\n")
    expect(await Input.discoverFiles(root)).toEqual([
      ".gitignore",
      "packages/a/.gitignore",
      "packages/a/src/index.ts",
      "src/index.ts",
      "src/nested/deep.ts"
    ])
  })

  it("never lists host state or content outside the workspace", async () => {
    await Fs.writeFile(NodePath.join(outside, "secret.ts"), "not ours\n", "utf8")
    await Fs.mkdir(NodePath.join(outside, "tree"), { recursive: true })
    await Fs.writeFile(NodePath.join(outside, "tree", "deep.ts"), "not ours\n", "utf8")
    await Fs.symlink(NodePath.join(outside, "secret.ts"), at("escape.ts"))
    await Fs.symlink(NodePath.join(outside, "tree"), at("mirror"))
    await write(".flows/cache/entry.json", "{}")
    await write("build/cache/entry.json", "{}")
    expect(await Input.discoverFiles(root, { cacheDirectory: "build/cache" })).toEqual([
      ".flows/cache/entry.json",
      "src/index.ts",
      "src/nested/deep.ts"
    ])
  })
})

describe("Input.digestFile", () => {
  it("digests content and reports a missing file as undefined", async () => {
    expect(await Input.digestFile(at("src/index.ts"), { workspaceRoot: root }))
      .toBe(sha256("export const a = 1\n"))
    expect(await Input.digestFile(at("src/gone.ts"), { workspaceRoot: root })).toBeUndefined()
  })

  it("refuses a declared file that is a link out of the workspace", async () => {
    await Fs.writeFile(NodePath.join(outside, "secret.ts"), "not ours\n", "utf8")
    await Fs.symlink(NodePath.join(outside, "secret.ts"), at("src/escape.ts"))
    await expect(Input.digestFile(at("src/escape.ts"), { workspaceRoot: root }))
      .rejects.toThrow(/symbolic link leaving the workspace/)
  })

  it("digests a link that stays inside the workspace, agreeing with the walk", async () => {
    await Fs.symlink(at("src/index.ts"), at("src/alias.ts"))
    expect(await Input.digestFile(at("src/alias.ts"), { workspaceRoot: root }))
      .toBe(sha256("export const a = 1\n"))
    expect(await Input.expandGlob(root, "", "src/alias.ts")).toEqual(["src/alias.ts"])
  })

  it.runIf(posixOnly)("refuses a declared input that is not a regular file", async () => {
    execFileSync("mkfifo", [at("pipe")])
    await expect(Input.digestFile(at("pipe"), { workspaceRoot: root }))
      .rejects.toThrow(/not a regular file/)
  })
})

describe("Input.digestFiles", () => {
  it("digests workspace-relative paths under the canonical root", async () => {
    expect(await Input.digestFiles(root, ["src/nested/deep.ts", "src/index.ts", "src/gone.ts"])).toEqual([
      { path: "src/gone.ts", digest: undefined },
      { path: "src/index.ts", digest: sha256("export const a = 1\n") },
      { path: "src/nested/deep.ts", digest: sha256("export const b = 2\n") }
    ])
  })

  it("refuses a path that resolves outside the workspace", async () => {
    await Fs.mkdir(NodePath.join(outside, "src"), { recursive: true })
    await Fs.writeFile(NodePath.join(outside, "src", "a.ts"), "not ours\n", "utf8")
    await Fs.symlink(NodePath.join(outside, "src"), at("vendor"))
    await expect(Input.digestFiles(root, ["vendor/a.ts"]))
      .rejects.toThrow(/resolves outside the workspace/)
  })

  it("bounds descriptor concurrency while preserving sorted output order", async () => {
    let active = 0
    let peak = 0
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      open: async (path) => {
        const handle = await SafeFs.defaultIo.open(path)
        active += 1
        peak = Math.max(peak, active)
        return {
          ...handle,
          read: async (into) => {
            await new Promise((resolve) => setTimeout(resolve, 10))
            return handle.read(into)
          },
          close: async () => {
            try {
              await handle.close()
            } finally {
              active -= 1
            }
          }
        }
      }
    }

    const digests = await Input.digestFiles(
      root,
      ["src/nested/deep.ts", "src/index.ts"],
      { concurrency: 1, io }
    )
    expect(digests.map((entry) => entry.path)).toEqual(["src/index.ts", "src/nested/deep.ts"])
    expect(peak).toBe(1)
    expect(active).toBe(0)
  })

  it("refuses an oversized digest batch before opening a file", async () => {
    let opened = false
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      open: async (path) => {
        opened = true
        return SafeFs.defaultIo.open(path)
      }
    }
    await expect(Input.digestFiles(root, ["src/index.ts"], { io, maximumFiles: 0 }))
      .rejects.toThrow(/exceeding its limit/)
    expect(opened).toBe(false)
  })

  it.each([0, 1.5, Input.defaultDigestConcurrency + 1])(
    "refuses the invalid digest concurrency %s",
    async (concurrency) => {
      await expect(Input.digestFiles(root, [], { concurrency })).rejects.toThrow(/digest concurrency/)
    }
  )

  it.each([-1, 1.5, Input.maximumDigestFiles + 1])(
    "refuses the invalid digest file limit %s",
    async (maximumFiles) => {
      await expect(Input.digestFiles(root, [], { maximumFiles })).rejects.toThrow(/digest file limit/)
    }
  )

  /**
   * A limit read out of an environment variable or a JSON config arrives as
   * text. Rendering it back verbatim would read as an accepted value that was
   * refused anyway, so the message names the type it actually got.
   */
  it("names the type of a bound that is not a number at all", async () => {
    await expect(Input.digestFiles(root, [], { maximumFiles: "500" as never })).rejects.toThrow(
      `digest file limit must be an integer from 0 to ${Input.maximumDigestFiles}, received string`
    )
    await expect(Input.digestFiles(root, [], { concurrency: true as never })).rejects.toThrow(
      `digest concurrency must be an integer from 1 to ${Input.defaultDigestConcurrency}, received boolean`
    )
  })
})

describe("Input.rootRelative", () => {
  it("renders workspace-root paths from both the root and a package directory", () => {
    expect(Input.rootRelative("", "//src/index.ts")).toBe("src/index.ts")
    expect(Input.rootRelative("packages/app", "//scripts/check.mjs")).toBe("../../scripts/check.mjs")
  })
})

describe("Input.declaredDirectory", () => {
  it("renders a workspace-rooted file's directory relative to the workspace", () => {
    expect(Input.declaredDirectory("//packages/x/package.json", { packageDirectory: undefined })).toBe("packages/x")
    expect(Input.declaredDirectory("//package.json", { packageDirectory: undefined })).toBe(".")
    // The declaring package never moves a rooted path.
    expect(Input.declaredDirectory("//packages/x/jsr.json", { packageDirectory: "/workspace/packages/app" }))
      .toBe("packages/x")
  })

  it("resolves a package-relative file from the declaring package directory", () => {
    expect(Input.declaredDirectory("package.json", { packageDirectory: "/workspace/packages/app" }))
      .toBe(NodePath.resolve("/workspace/packages/app"))
    expect(Input.declaredDirectory("dist/jsr.json", { packageDirectory: "/workspace/packages/app" }))
      .toBe(NodePath.resolve("/workspace/packages/app/dist"))
  })

  it("falls back to the process working directory outside a PACKAGE.ts", () => {
    expect(Input.declaredDirectory("package.json", { packageDirectory: undefined })).toBe(process.cwd())
    expect(Input.declaredDirectory("dist/jsr.json", { packageDirectory: undefined })).toBe(NodePath.resolve("dist"))
  })
})

describe("Input.gitDiff", () => {
  it.each(["", "--output=outside", "\uD800", "\uD800x", "\uDC00", "HEAD\0other"])(
    "refuses the unsafe base %j",
    (base) => {
      expect(() => Input.gitDiff(base)).toThrow(/not a usable revision/)
    }
  )

  it("accepts an ordinary revision expression", () => {
    expect(Input.gitDiff("origin/main...HEAD")).toEqual({ _tag: "GitDiff", base: "origin/main...HEAD" })
    expect(Input.gitDiff("release-😀")).toEqual({ _tag: "GitDiff", base: "release-😀" })
    expect(Input.gitDiff({
      base: "main",
      paths: ["src/a.ts"],
      added: ["src/new.ts"],
      addedLines: "changed"
    })).toEqual({
      _tag: "GitDiff",
      base: "main",
      paths: ["src/a.ts"],
      added: ["src/new.ts"],
      addedLines: "changed"
    })
  })

  it("rejects a non-string member in the PACKAGE.ts glob shorthand", () => {
    expect(() => Input.glob(["src/**/*.ts", 7 as never])).toThrow(/glob patterns must be strings/)
  })
})

describe("concurrent glob walk", () => {
  it("expands a wide, deep tree to the same sorted list a serial walk produced", async () => {
    // 40 directories x 12 files each descends and fans out enough that the
    // concurrent descent interleaves many branches at once. The expected list
    // is built independently and sorted, so any order leaking out of the walk
    // shows up here.
    const expected: Array<string> = []
    for (let dir = 0; dir < 40; dir += 1) {
      for (let file = 0; file < 12; file += 1) {
        const relative = `wide/d${String(dir).padStart(2, "0")}/n/f${String(file).padStart(2, "0")}.ts`
        await write(relative, `export const v = ${dir}_${file}\n`)
        expected.push(relative)
      }
    }
    const matches = await Input.expandGlob(root, ".", "wide/**/*.ts")
    expect(matches).toEqual([...expected].sort())
  })

  it("is deterministic across repeated expansions of one tree", async () => {
    for (let dir = 0; dir < 20; dir += 1) {
      for (let file = 0; file < 8; file += 1) await write(`rep/d${dir}/f${file}.ts`, `export const v = ${file}\n`)
    }
    const seen = new Set<string>()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      seen.add(JSON.stringify(await Input.expandGlob(root, ".", "rep/**/*.ts")))
    }
    expect([...seen]).toHaveLength(1)
  })

  it("never serves a stale digest after a file changes", async () => {
    for (let dir = 0; dir < 12; dir += 1) {
      for (let file = 0; file < 6; file += 1) await write(`fresh/d${dir}/f${file}.ts`, `export const v = ${file}\n`)
    }
    const digestAll = async (): Promise<string> => {
      const matches = await Input.expandGlob(root, ".", "fresh/**/*.ts")
      return Input.digestText(JSON.stringify(await Input.digestFiles(root, matches, {})))
    }
    const before = await digestAll()
    expect(await digestAll()).toBe(before)
    await write("fresh/d5/f3.ts", "export const v = 999\n")
    expect(await digestAll()).not.toBe(before)
  })

  it("still refuses to descend a directory symbolic link while walking concurrently", async () => {
    for (let dir = 0; dir < 15; dir += 1) await write(`link/d${dir}/f.ts`, "export const v = 1\n")
    await Fs.symlink(at("link/d0"), at("link/loop"))
    const matches = await Input.expandGlob(root, ".", "link/**/*.ts")
    expect(matches.some((path) => path.startsWith("link/loop/"))).toBe(false)
  })
})
