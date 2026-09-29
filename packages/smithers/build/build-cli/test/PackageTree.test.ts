/**
 * Unit coverage for the untrusted-cache boundary in the artifact store: a
 * poisoned manifest must never place bytes outside the outDir tree it is
 * materialized into, and a rebuild must heal a tampered CAS blob.
 */
import * as ChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as PackageTree from "../src/PackageTree.ts"

/** Makes one pre-digest lstat report a stale size for the growth-race test. */
const lstatSizeOverride: { path: string | undefined; size: number } = { path: undefined, size: 0 }

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...original,
    default: original,
    copyFile: vi.fn(original.copyFile),
    chmod: vi.fn(original.chmod),
    rename: vi.fn(original.rename),
    rm: vi.fn(original.rm),
    lstat: async (path: NodeFs.PathLike): Promise<NodeFs.Stats> => {
      const stats = await original.lstat(path)
      if (lstatSizeOverride.path === String(path)) {
        Object.defineProperty(stats, "size", { configurable: true, value: lstatSizeOverride.size })
      }
      return stats
    }
  }
})

let root: string
let outside: string

beforeEach(async () => {
  lstatSizeOverride.path = undefined
  const base = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-tree-")))
  root = NodePath.join(base, "workspace")
  outside = NodePath.join(base, "outside")
  await Fs.mkdir(root, { recursive: true })
  await Fs.mkdir(outside, { recursive: true })
})

afterEach(async () => {
  lstatSizeOverride.path = undefined
  await Fs.rm(NodePath.dirname(root), { recursive: true, force: true }).catch(() => {})
})

const sha256 = (bytes: string): string => createHash("sha256").update(bytes).digest("hex")

describe("git capture stays inside the requested workspace", () => {
  it("refuses an ancestor repository when the workspace has no local .git", async () => {
    ChildProcess.execFileSync("git", ["init", "--quiet", "."], { cwd: NodePath.dirname(root), stdio: "ignore" })
    await Fs.mkdir(NodePath.join(root, ".jj"))
    await expect(PackageTree.runGit(root, ["status", "--porcelain", "-z", "--untracked-files=all"]))
      .rejects.toThrow(/workspace has no local .git/)
  })

  it("captures valid output beyond the former 256 MiB execFile ceiling", async () => {
    ChildProcess.execFileSync("git", ["init", "--quiet", "."], { cwd: root, stdio: "ignore" })
    await Fs.writeFile(
      NodePath.join(root, "emit.cjs"),
      `const chunk = Buffer.alloc(1024 * 1024, "x");
async function main() {
  for (let i = 0; i < 257; i++) {
    if (!process.stdout.write(chunk)) await new Promise(resolve => process.stdout.once("drain", resolve));
  }
  process.stdout.write("終\\0");
}
main();
`
    )
    const output = await PackageTree.runGit(root, ["-c", "alias.large=!node emit.cjs", "large"])
    expect(output.length).toBe(257 * 1024 * 1024 + 2)
    expect(output.endsWith("終\0")).toBe(true)
  })
})

describe("resolveChangedPath", () => {
  it("admits a two-dot-prefixed child and refuses a genuine escape", () => {
    const workspace = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(root, "changed-")))
    const prefixed = NodePath.join(workspace, "..foo")
    NodeFs.mkdirSync(prefixed)
    NodeFs.writeFileSync(NodePath.join(prefixed, "file.txt"), "inside\n")
    const external = NodePath.join(root, "outside.txt")
    NodeFs.writeFileSync(external, "outside\n")

    expect(PackageTree.resolveChangedPath(workspace, "..foo/file.txt")).toBe("..foo/file.txt")
    expect(PackageTree.resolveChangedPath(workspace, NodePath.relative(workspace, external))).toBeUndefined()
  })
})

describe("decodeManifest confines every untrusted path", () => {
  it("rejects an outDir that escapes the workspace with ..", () => {
    const decoded = PackageTree.decodeManifest({
      outDir: "../victim",
      entries: [{ path: "pwned.txt", kind: "file", digest: sha256("x"), executable: false, target: "" }]
    })
    expect(decoded).toBeUndefined()
  })

  it("rejects an absolute outDir", () => {
    const decoded = PackageTree.decodeManifest({
      outDir: "/etc",
      entries: []
    })
    expect(decoded).toBeUndefined()
  })

  it("rejects a link entry whose target is absolute", () => {
    const decoded = PackageTree.decodeManifest({
      outDir: "dist",
      entries: [{ path: "a", kind: "link", digest: "", executable: false, target: "/abs/escape" }]
    })
    expect(decoded).toBeUndefined()
  })

  it("rejects a link entry whose target contains ..", () => {
    const decoded = PackageTree.decodeManifest({
      outDir: "dist",
      entries: [{ path: "a", kind: "link", digest: "", executable: false, target: "../../escape" }]
    })
    expect(decoded).toBeUndefined()
  })

  it("accepts a well-formed manifest", () => {
    const decoded = PackageTree.decodeManifest({
      outDir: "dist",
      entries: [{ path: "a.txt", kind: "file", digest: sha256("art"), executable: false, target: "" }]
    })
    expect(decoded).toEqual({
      outDir: "dist",
      entries: [{ path: "a.txt", kind: "file", digest: sha256("art"), executable: false, target: "" }]
    })
  })
})

describe("materializeManifest never writes through a symlink out of the tree", () => {
  it("refuses a file entry written through a symlink entry that resolves outside", async () => {
    // A poisoned manifest whose link entry resolves outside the temp tree (via
    // a `..` hop through a pre-existing escaping symlink) followed by a file
    // beneath it. The realpath confinement in materializeManifest must refuse
    // to write the file through the symlink, leaving the outside tree untouched.
    const cas = NodePath.join(root, ".flows", "cas")
    await Fs.mkdir(cas, { recursive: true })
    const digest = sha256("payload")
    await Fs.writeFile(NodePath.join(cas, digest), "payload")
    // `seed` sits beside the outDir root and points at the external directory.
    // The temp tree is built as `dist`'s sibling, so a link target of `../seed`
    // resolves through it to `outside`.
    await Fs.symlink(outside, NodePath.join(root, "seed"))
    const manifest = {
      outDir: "dist",
      entries: [
        { path: "sub", kind: "link" as const, digest: "", executable: false, target: "../seed" },
        { path: "sub/b.txt", kind: "file" as const, digest, executable: false, target: "" }
      ]
    }
    let threw = false
    await PackageTree.materializeManifest(root, ".flows", manifest).catch(() => {
      threw = true
    })
    expect(threw).toBe(true)
    const escaped = await Fs.readFile(NodePath.join(outside, "b.txt"), "utf8").then(() => true, () => false)
    expect(escaped).toBe(false)
  })

  it("materializes a fully staged normal tree", async () => {
    const cas = NodePath.join(root, ".flows", "cas")
    await Fs.mkdir(cas, { recursive: true })
    const digest = sha256("art")
    await Fs.writeFile(NodePath.join(cas, digest), "art")
    await PackageTree.materializeManifest(root, ".flows", {
      outDir: "dist",
      entries: [{ path: "a.txt", kind: "file", digest, executable: false, target: "" }]
    })
    expect(await Fs.readFile(NodePath.join(root, "dist", "a.txt"), "utf8")).toBe("art")
  })
})

describe("captureOutDir heals a tampered CAS blob", () => {
  it("rewrites an existing blob whose bytes no longer match its name", async () => {
    await Fs.mkdir(NodePath.join(root, "dist"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "a.txt"), "art")
    const first = await PackageTree.captureOutDir(root, ".flows", "dist")
    const blob = NodePath.join(root, ".flows", "cas", first.entries[0]!.digest)
    // Tamper the stored blob, then re-capture the same content: the blob must be
    // rewritten to the correct bytes rather than trusted by name.
    await Fs.writeFile(blob, "tampered")
    await PackageTree.captureOutDir(root, ".flows", "dist")
    expect(await Fs.readFile(blob, "utf8")).toBe("art")
    expect(await PackageTree.verifyManifestBlobs(root, ".flows", first)).toBeUndefined()
  })
})

describe("scratchCopy keeps installed dependencies as host state", () => {
  it.skipIf(process.platform === "win32")("removes the scratch tree when copying fails", async () => {
    const temporary = NodePath.join(outside, "tmp")
    await Fs.mkdir(temporary)
    vi.stubEnv("TMPDIR", temporary)
    try {
      await Fs.writeFile(NodePath.join(root, "source.txt"), "partially copied")
      ChildProcess.execFileSync("mkfifo", [NodePath.join(root, "pipe")])
      await expect(PackageTree.scratchCopy(root, ".flows")).rejects.toThrow()
      expect(await Fs.readdir(temporary)).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("removes the scratch tree when linking installed dependencies fails", async () => {
    const temporary = NodePath.join(outside, "tmp")
    await Fs.mkdir(temporary)
    await Fs.mkdir(NodePath.join(root, "node_modules"))
    await Fs.writeFile(NodePath.join(root, "source.txt"), "copied")
    vi.stubEnv("TMPDIR", temporary)
    const failure = new Error("symlink failed")
    const link = vi.spyOn(Fs, "symlink").mockRejectedValueOnce(failure)
    try {
      await expect(PackageTree.scratchCopy(root, ".flows")).rejects.toBe(failure)
      expect(await Fs.readdir(temporary)).toEqual([])
    } finally {
      link.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it("links a real node_modules directory instead of copying its contents", async () => {
    await Fs.mkdir(NodePath.join(root, "node_modules", "fixture"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "node_modules", "fixture", "index.js"), "export {}")
    await Fs.writeFile(NodePath.join(root, "source.ts"), "export const source = true")
    const scratch = await PackageTree.scratchCopy(root, ".flows")
    try {
      expect((await Fs.lstat(NodePath.join(scratch, "node_modules"))).isSymbolicLink()).toBe(true)
      expect(await Fs.realpath(NodePath.join(scratch, "node_modules"))).toBe(
        await Fs.realpath(NodePath.join(root, "node_modules"))
      )
      expect(await Fs.readFile(NodePath.join(scratch, "source.ts"), "utf8")).toContain("source = true")
    } finally {
      await Fs.rm(scratch, { recursive: true, force: true })
    }
  })

  it("never copies version-control state or a nested checkout", async () => {
    // A linked worktree carries a `.git` file, a clone a `.git` directory, and
    // either may hold its own installed dependencies: none of it is workspace
    // content, and copying it is what filled a disk.
    await Fs.mkdir(NodePath.join(root, ".claude", "worktrees", "agent", "node_modules", "dep"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, ".claude", "worktrees", "agent", ".git"), "gitdir: /elsewhere\n")
    await Fs.writeFile(NodePath.join(root, ".claude", "worktrees", "agent", "node_modules", "dep", "index.js"), "")
    await Fs.writeFile(NodePath.join(root, ".claude", "worktrees", "agent", "stale.ts"), "stale")
    await Fs.mkdir(NodePath.join(root, ".jj", "repo", "op_store"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, ".jj", "repo", "op_store", "view"), "jj state")
    await Fs.mkdir(NodePath.join(root, "vendor", "clone", ".git"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "vendor", "clone", "lib.rs"), "")
    await Fs.mkdir(NodePath.join(root, "apps", "site"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "apps", "site", "index.ts"), "site")
    const scratch = await PackageTree.scratchCopy(root, ".flows")
    try {
      const present = (relative: string) =>
        Fs.lstat(NodePath.join(scratch, ...relative.split("/"))).then(() => true, () => false)
      expect(await present(".claude/worktrees/agent")).toBe(false)
      expect(await present(".jj")).toBe(false)
      expect(await present("vendor/clone")).toBe(false)
      expect(await Fs.readFile(NodePath.join(scratch, "apps", "site", "index.ts"), "utf8")).toBe("site")
    } finally {
      await Fs.rm(scratch, { recursive: true, force: true })
    }
  })

  it("omits the roots the caller is going to clear anyway", async () => {
    await Fs.mkdir(NodePath.join(root, "out", "nested"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "out", "nested", "stale.js"), "stale")
    await Fs.writeFile(NodePath.join(root, "kept.txt"), "kept")
    const scratch = await PackageTree.scratchCopy(root, ".flows", ["out"])
    try {
      expect(await Fs.lstat(NodePath.join(scratch, "out")).then(() => true, () => false)).toBe(false)
      expect(await Fs.readFile(NodePath.join(scratch, "kept.txt"), "utf8")).toBe("kept")
    } finally {
      await Fs.rm(scratch, { recursive: true, force: true })
    }
  })
})

describe("the write-set guard reads git honestly", () => {
  const git = (args: ReadonlyArray<string>, input?: Buffer): Buffer =>
    ChildProcess.execFileSync("git", [...args], {
      cwd: root,
      ...(input === undefined ? {} : { input }),
      encoding: "buffer",
      stdio: ["pipe", "pipe", "pipe"]
    })

  /**
   * Stages one path whose bytes are not valid UTF-8.
   *
   * The path is placed in the index rather than on disk because APFS refuses
   * a filename that is not valid UTF-8 (EILSEQ), while ext4 accepts one. Git
   * reports the staged-then-missing entry in `status` and `ls-files` either
   * way, which is the output the guard decodes.
   */
  const stageInvalidUtf8Path = (): void => {
    const blob = git(["hash-object", "-w", "--stdin"], Buffer.from("body\n")).toString("utf8").trim()
    const entry = Buffer.concat([
      Buffer.from(`100644 blob ${blob}\tbad-`),
      Buffer.from([0xff]),
      Buffer.from(".txt\0")
    ])
    const tree = git(["mktree", "-z"], entry).toString("utf8").trim()
    git(["read-tree", tree])
  }

  beforeEach(() => {
    git(["init", "--quiet", "."])
  })

  it("refuses git output that is not valid UTF-8 instead of returning a lossy decoding", async () => {
    stageInvalidUtf8Path()
    // A silent U+FFFD substitution names a path that does not exist. The guard
    // would report it out of set and then "revert" it with a `force: true`
    // removal that cannot fail, leaving the real write in the tree while the
    // node failed claiming it had been reverted.
    await expect(PackageTree.runGit(root, ["ls-files", "-z"])).rejects.toThrow(/not valid UTF-8/)
    await expect(PackageTree.snapshotTree(root, ".flows")).rejects.toThrow(/not valid UTF-8/)
  })

  /** A `.git` that names no repository: git is asked and cannot answer. */
  const breakGit = async (): Promise<void> => {
    await Fs.rm(NodePath.join(root, ".git"), { recursive: true, force: true })
    await Fs.writeFile(NodePath.join(root, ".git"), `gitdir: ${NodePath.join(outside, "missing")}\n`)
  }

  it("fails the ignored-path census when git cannot answer, instead of reporting nothing ignored", async () => {
    // `listIgnored` runs once before the body and once after. Swallowing the
    // failure disarms the guard when it fails after, and makes every ignored
    // path read as newly created when it fails before, which sends each one
    // that does not match the write-set to `revertIgnored` as a created path.
    await breakGit()
    await expect(PackageTree.snapshotIgnored(root, ".flows")).rejects.toThrow(/git status failed/)
  })

  it("fails the portal census when git cannot answer, instead of measuring no portals", async () => {
    await breakGit()
    await expect(PackageTree.snapshotPortals(root, ".flows")).rejects.toThrow(/git (ls-files|status) failed/)
  })
})

/**
 * A `jj workspace add` checkout has `.jj` and no `.git`. Git cannot census it
 * (it would walk out to an ancestor repository), and jj lists neither ignored
 * paths nor file modes, so the guard measures the whole tree from the
 * filesystem: every file is held in the stash and restored from it.
 */
describe("the write-set guard measures a workspace without a local .git from the filesystem", () => {
  const file = async (relative: string, content: string): Promise<void> => {
    const absolute = NodePath.join(root, relative)
    await Fs.mkdir(NodePath.dirname(absolute), { recursive: true })
    await Fs.writeFile(absolute, content)
  }

  beforeEach(async () => {
    // An ancestor repository the census must never consult.
    ChildProcess.execFileSync("git", ["init", "--quiet", "."], { cwd: NodePath.dirname(root), stdio: "ignore" })
    await file(".jj/repo", "jj state")
    await file(".gitignore", "dist/\n")
    await file("src/a.ts", "source")
    await file("dist/a.js", "built")
    await file("node_modules/dep/index.js", "dep")
    await file(".flows/cache/entry", "cache")
  })

  it("censuses every file outside host state, and restores a changed, created, or deleted one", async () => {
    await Fs.chmod(NodePath.join(root, "src", "a.ts"), 0o600)
    const tree = await PackageTree.snapshotTree(root, ".flows")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      expect(tree.trackedModes.size).toBe(0)
      expect([...snapshot.entries.keys()].sort()).toEqual([".gitignore", "dist/a.js", "src/a.ts"])
      await file("src/a.ts", "rewritten")
      await Fs.chmod(NodePath.join(root, "src", "a.ts"), 0o644)
      await file("src/b.ts", "created")
      await Fs.rm(NodePath.join(root, "dist", "a.js"))
      await file("node_modules/dep/index.js", "host state")
      expect(await PackageTree.changedSinceSnapshot(tree, ".flows")).toEqual([])
      const changed = await PackageTree.changedIgnored(snapshot, ".flows")
      expect(changed).toEqual(["dist/a.js", "src/a.ts", "src/b.ts"])
      for (const path of changed) expect(await PackageTree.revertIgnored(snapshot, path)).toBe(true)
      expect(await Fs.readFile(NodePath.join(root, "src", "a.ts"), "utf8")).toBe("source")
      expect((await Fs.lstat(NodePath.join(root, "src", "a.ts"))).mode & 0o777).toBe(0o600)
      expect(await Fs.readFile(NodePath.join(root, "dist", "a.js"), "utf8")).toBe("built")
      expect(await Fs.lstat(NodePath.join(root, "src", "b.ts")).then(() => true, () => false)).toBe(false)
    } finally {
      await PackageTree.releaseIgnored(snapshot)
      await PackageTree.releaseSnapshot(tree)
    }
  })

  it("finds an escaping symlink anywhere in the tree as a portal", async () => {
    await Fs.mkdir(NodePath.join(outside, "open"), { recursive: true })
    await Fs.symlink(NodePath.join(outside, "open"), NodePath.join(root, "src", "portal"))
    await Fs.symlink("a.ts", NodePath.join(root, "src", "inside"))
    const snapshot = await PackageTree.snapshotPortals(root, ".flows")
    try {
      expect(snapshot.portals.map((portal) => portal.link)).toEqual(["src/portal"])
    } finally {
      await PackageTree.releasePortals(snapshot)
    }
  })
})

describe("snapshot rollback preserves file permissions", () => {
  beforeEach(() => {
    ChildProcess.execFileSync("git", ["init", "--quiet", "."], { cwd: root, stdio: "ignore" })
  })

  const permissions = async (path: string): Promise<number> => (await Fs.lstat(path)).mode & 0o7777

  for (const mode of [0o600, 0o640, 0o750]) {
    for (const contentChanges of [true, false]) {
      const change = contentChanges ? "content and permissions" : "permissions alone"
      it.skipIf(process.platform === "win32")(
        `restores an ordinary file at ${mode.toString(8)} after changing ${change}`,
        async () => {
          const secret = NodePath.join(root, "credentials.txt")
          await Fs.writeFile(secret, "secret")
          await Fs.chmod(secret, mode)
          const snapshot = await PackageTree.snapshotTree(root, ".flows")
          try {
            if (contentChanges) await Fs.writeFile(secret, "overwritten")
            await Fs.chmod(secret, 0o644)
            expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual(["credentials.txt"])
            await PackageTree.revertPath(snapshot, "credentials.txt")
            expect(await Fs.readFile(secret, "utf8")).toBe("secret")
            expect(await permissions(secret)).toBe(mode)
            expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual([])
          } finally {
            await PackageTree.releaseSnapshot(snapshot)
          }
        }
      )

      for (const directoryPortal of [true, false]) {
        it.skipIf(process.platform === "win32")(
          `restores a ${directoryPortal ? "directory" : "file"} portal at ${mode.toString(8)} after changing ${change}`,
          async () => {
            const secret = NodePath.join(outside, "credentials.txt")
            await Fs.writeFile(secret, "secret")
            await Fs.chmod(secret, mode)
            await Fs.symlink(directoryPortal ? outside : secret, NodePath.join(root, "portal"))
            const snapshot = await PackageTree.snapshotPortals(root, ".flows")
            try {
              if (contentChanges) await Fs.writeFile(secret, "overwritten")
              await Fs.chmod(secret, 0o644)
              expect(await PackageTree.revertChangedPortals(snapshot)).toEqual([
                directoryPortal ? "portal/credentials.txt" : "portal"
              ])
              expect(await Fs.readFile(secret, "utf8")).toBe("secret")
              expect(await permissions(secret)).toBe(mode)
              expect(await PackageTree.revertChangedPortals(snapshot)).toEqual([])
            } finally {
              await PackageTree.releasePortals(snapshot)
            }
          }
        )
      }
    }
  }
})

describe.skipIf(process.platform === "win32")("revertPath restores clean tracked files", () => {
  const tracked = "credentials.txt"
  const trackedFile = (): string => NodePath.join(root, tracked)
  const permissions = async (path: string): Promise<number> => (await Fs.lstat(path)).mode & 0o7777
  const rollbackDirectories = async (): Promise<ReadonlyArray<string>> =>
    (await Fs.readdir(root)).filter((name) => name.startsWith(".smthrs-rollback-"))
  const git = (...args: ReadonlyArray<string>): string =>
    ChildProcess.execFileSync("git", [...args], { cwd: root, encoding: "utf8" })

  const cleanSnapshot = async (mode: number): Promise<PackageTree.TreeSnapshot> => {
    git("init", "--quiet", ".")
    await Fs.writeFile(trackedFile(), "original\n")
    if ((mode & 0o111) !== 0) await Fs.chmod(trackedFile(), 0o755)
    git("add", tracked)
    git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "initial")
    await Fs.chmod(trackedFile(), mode)
    expect(git("status", "--porcelain")).toBe("")
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    expect(snapshot.states.has(tracked)).toBe(false)
    return snapshot
  }

  for (const mode of [0o600, 0o640, 0o750]) {
    it(`restores content and ${mode.toString(8)} permissions after an overwrite`, async () => {
      const snapshot = await cleanSnapshot(mode)
      try {
        await Fs.writeFile(trackedFile(), "overwritten\n")
        await Fs.chmod(trackedFile(), 0o644)
        expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual([tracked])
        await PackageTree.revertPath(snapshot, tracked)
        expect(await Fs.readFile(trackedFile(), "utf8")).toBe("original\n")
        expect(await permissions(trackedFile())).toBe(mode)
        expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual([])
      } finally {
        await PackageTree.releaseSnapshot(snapshot)
      }
    })

    it(`restores ${mode.toString(8)} permissions after deletion`, async () => {
      const snapshot = await cleanSnapshot(mode)
      try {
        await Fs.rm(trackedFile())
        expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual([tracked])
        await PackageTree.revertPath(snapshot, tracked)
        expect(await Fs.readFile(trackedFile(), "utf8")).toBe("original\n")
        expect(await permissions(trackedFile())).toBe(mode)
        expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual([])
      } finally {
        await PackageTree.releaseSnapshot(snapshot)
      }
    })

    it(`replaces a symlink with the original file and ${mode.toString(8)} permissions`, async () => {
      const snapshot = await cleanSnapshot(mode)
      const replacement = NodePath.join(outside, "replacement.txt")
      try {
        await Fs.writeFile(replacement, "outside\n")
        await Fs.rm(trackedFile())
        await Fs.symlink(replacement, trackedFile())
        expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual([tracked])
        await PackageTree.revertPath(snapshot, tracked)
        expect((await Fs.lstat(trackedFile())).isFile()).toBe(true)
        expect(await Fs.readFile(trackedFile(), "utf8")).toBe("original\n")
        expect(await permissions(trackedFile())).toBe(mode)
        expect(await Fs.readFile(replacement, "utf8")).toBe("outside\n")
        expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual([])
      } finally {
        await PackageTree.releaseSnapshot(snapshot)
      }
    })
  }

  it("detects a clean tracked file's mode-only change and restores its snapshot mode", async () => {
    const snapshot = await cleanSnapshot(0o600)
    try {
      await Fs.chmod(trackedFile(), 0o640)
      expect(git("status", "--porcelain")).toBe("")
      expect(await Fs.readFile(trackedFile(), "utf8")).toBe("original\n")
      expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual([tracked])
      await PackageTree.revertPath(snapshot, tracked)
      expect(await Fs.readFile(trackedFile(), "utf8")).toBe("original\n")
      expect(await permissions(trackedFile())).toBe(0o600)
      expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual([])
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("restores a special permission bit after a same-bytes mode-only change", async (context) => {
    const originalMode = 0o4600
    const snapshot = await cleanSnapshot(originalMode)
    try {
      // Some filesystems do not preserve setuid on unprivileged files.
      if (await permissions(trackedFile()) !== originalMode) context.skip("filesystem does not preserve setuid")
      await Fs.chmod(trackedFile(), 0o600)
      expect(git("status", "--porcelain")).toBe("")
      expect(await Fs.readFile(trackedFile(), "utf8")).toBe("original\n")
      expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual([tracked])
      await PackageTree.revertPath(snapshot, tracked)
      expect(await Fs.readFile(trackedFile(), "utf8")).toBe("original\n")
      expect(await permissions(trackedFile())).toBe(originalMode)
      expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual([])
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("does not rewrite a hardlinked alias while restoring the tracked file", async () => {
    const snapshot = await cleanSnapshot(0o600)
    const alias = NodePath.join(outside, "alias.txt")
    try {
      await Fs.link(trackedFile(), alias)
      await Fs.writeFile(trackedFile(), "changed through the shared inode\n")
      await Fs.chmod(trackedFile(), 0o644)
      const aliasBefore = await Fs.lstat(alias)
      expect(await Fs.readFile(alias, "utf8")).toBe("changed through the shared inode\n")
      expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual([tracked])
      await PackageTree.revertPath(snapshot, tracked)
      expect(await Fs.readFile(trackedFile(), "utf8")).toBe("original\n")
      expect(await permissions(trackedFile())).toBe(0o600)
      expect(await Fs.readFile(alias, "utf8")).toBe("changed through the shared inode\n")
      expect(await permissions(alias)).toBe(0o644)
      expect((await Fs.lstat(alias)).ino).toBe(aliasBefore.ino)
      expect((await Fs.lstat(trackedFile())).ino).not.toBe(aliasBefore.ino)
      expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual([])
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("keeps the destination intact when Git cannot read the indexed blob", async () => {
    const snapshot = await cleanSnapshot(0o600)
    try {
      await Fs.writeFile(trackedFile(), "current work\n")
      await Fs.chmod(trackedFile(), 0o640)
      const blob = git("rev-parse", `HEAD:${tracked}`).trim()
      const object = NodePath.join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2))
      expect((await Fs.lstat(object)).isFile()).toBe(true)
      await Fs.rm(object)
      await expect(PackageTree.revertPath(snapshot, tracked)).rejects.toThrow()
      expect(await Fs.readFile(trackedFile(), "utf8")).toBe("current work\n")
      expect(await permissions(trackedFile())).toBe(0o640)
      expect(await rollbackDirectories()).toEqual([])
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("retries checkout when an older Git rejects the optional skip-worktree flag", async () => {
    const snapshot = await cleanSnapshot(0o600)
    const shimDirectory = NodePath.join(outside, "git-shim")
    const log = NodePath.join(outside, "checkout-attempts.log")
    const realGit = ChildProcess.execFileSync("which", ["git"], { encoding: "utf8" }).trim()
    await Fs.mkdir(shimDirectory)
    const shim = NodePath.join(shimDirectory, "git")
    await Fs.writeFile(
      shim,
      `#!/bin/sh
checkout=0
for argument in "$@"; do
  if [ "$argument" = "checkout-index" ]; then checkout=1; fi
done
if [ "$checkout" -eq 1 ]; then printf '%s\\n' "$*" >> "$SMTHRS_TEST_GIT_LOG"; fi
for argument in "$@"; do
  if [ "$argument" = "--ignore-skip-worktree-bits" ]; then
    printf '%s\\n' "error: unknown option 'ignore-skip-worktree-bits'" >&2
    exit 129
  fi
done
exec "$SMTHRS_TEST_REAL_GIT" "$@"
`
    )
    await Fs.chmod(shim, 0o755)
    await Fs.writeFile(trackedFile(), "current work\n")
    vi.stubEnv("PATH", `${shimDirectory}${NodePath.delimiter}${process.env.PATH ?? ""}`)
    vi.stubEnv("SMTHRS_TEST_REAL_GIT", realGit)
    vi.stubEnv("SMTHRS_TEST_GIT_LOG", log)
    try {
      await PackageTree.revertPath(snapshot, tracked)
      expect(await Fs.readFile(trackedFile(), "utf8")).toBe("original\n")
      expect(await permissions(trackedFile())).toBe(0o600)
      const attempts = (await Fs.readFile(log, "utf8")).trim().split("\n")
      expect(attempts).toHaveLength(2)
      expect(attempts[0]).toContain("--ignore-skip-worktree-bits")
      expect(attempts[1]).not.toContain("--ignore-skip-worktree-bits")
      expect(await rollbackDirectories()).toEqual([])
    } finally {
      vi.unstubAllEnvs()
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("sets staged permissions before publishing the restored file", async () => {
    const snapshot = await cleanSnapshot(0o600)
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    await Fs.writeFile(trackedFile(), "current work\n")
    let sawPublish = false
    const rename = vi.mocked(Fs.rename)
    rename.mockImplementationOnce(async (from, to) => {
      expect(String(to)).toBe(trackedFile())
      expect((await Fs.lstat(NodePath.dirname(String(from)))).mode & 0o7777).toBe(0o700)
      expect(await permissions(String(from))).toBe(0o600)
      expect(await Fs.readFile(trackedFile(), "utf8")).toBe("current work\n")
      sawPublish = true
      await original.rename(from, to)
    })
    try {
      await PackageTree.revertPath(snapshot, tracked)
      expect(sawPublish).toBe(true)
      expect(await Fs.readFile(trackedFile(), "utf8")).toBe("original\n")
      expect(await permissions(trackedFile())).toBe(0o600)
      expect(await rollbackDirectories()).toEqual([])
    } finally {
      rename.mockReset().mockImplementation(original.rename)
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("keeps a replacement directory intact and removes staging after chmod fails", async () => {
    const snapshot = await cleanSnapshot(0o600)
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    await Fs.rm(trackedFile())
    await Fs.mkdir(trackedFile())
    await Fs.writeFile(NodePath.join(trackedFile(), "current.txt"), "current work\n")
    const failure = new Error("staged chmod failed")
    vi.mocked(Fs.chmod).mockRejectedValueOnce(failure)
    try {
      await expect(PackageTree.revertPath(snapshot, tracked)).rejects.toBe(failure)
      expect((await Fs.lstat(trackedFile())).isDirectory()).toBe(true)
      expect(await Fs.readFile(NodePath.join(trackedFile(), "current.txt"), "utf8")).toBe("current work\n")
      expect(await rollbackDirectories()).toEqual([])
    } finally {
      vi.mocked(Fs.chmod).mockReset().mockImplementation(original.chmod)
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("preserves a populated submodule worktree during gitlink rollback", async () => {
    const source = NodePath.join(outside, "source")
    await Fs.mkdir(source)
    ChildProcess.execFileSync("git", ["init", "--quiet", "."], { cwd: source, stdio: "ignore" })
    await Fs.writeFile(NodePath.join(source, "child.txt"), "original child\n")
    ChildProcess.execFileSync("git", ["add", "child.txt"], { cwd: source, stdio: "ignore" })
    ChildProcess.execFileSync(
      "git",
      ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "initial"],
      { cwd: source, stdio: "ignore" }
    )
    git("init", "--quiet", ".")
    git("-c", "protocol.file.allow=always", "submodule", "add", "--quiet", source, "dependency")
    git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "submodule")
    expect(git("status", "--porcelain")).toBe("")

    const child = NodePath.join(root, "dependency", "child.txt")
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    try {
      expect(snapshot.states.has("dependency")).toBe(false)
      await Fs.writeFile(child, "current child work\n")
      expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual(["dependency"])
      await PackageTree.revertPath(snapshot, "dependency")
      expect((await Fs.lstat(NodePath.join(root, "dependency"))).isDirectory()).toBe(true)
      expect(await Fs.readFile(child, "utf8")).toBe("current child work\n")
      expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual(["dependency"])
      expect(await rollbackDirectories()).toEqual([])
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })
})

describe.skipIf(process.platform === "win32")("snapshotTree tracks regular file modes", () => {
  const git = (...args: ReadonlyArray<string>): void => {
    ChildProcess.execFileSync("git", [...args], { cwd: root, stdio: "ignore" })
  }

  it("omits tracked symlinks and paths missing beneath a replaced directory", async () => {
    git("init", "--quiet", ".")
    await Fs.writeFile(NodePath.join(root, "regular.txt"), "regular")
    await Fs.symlink("regular.txt", NodePath.join(root, "link.txt"))
    await Fs.mkdir(NodePath.join(root, "parent"))
    await Fs.writeFile(NodePath.join(root, "parent", "child.txt"), "child")
    git("add", "-A")
    git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "initial")
    await Fs.rm(NodePath.join(root, "parent"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "parent"), "replacement")
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    try {
      expect([...snapshot.trackedModes.keys()]).toEqual(["regular.txt"])
      expect(snapshot.trackedModes.get("regular.txt")).toBe(
        (await Fs.lstat(NodePath.join(root, "regular.txt"))).mode & 0o7777
      )
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("removes the partial stash when reading a tracked file mode fails", async () => {
    git("init", "--quiet", ".")
    await Fs.writeFile(NodePath.join(root, "regular.txt"), "regular")
    git("add", "regular.txt")
    git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "initial")
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const failure = new Error("mode read failed")
    let stash: string | undefined
    const mkdtemp = vi.spyOn(Fs, "mkdtemp").mockImplementationOnce(async (prefix) => {
      stash = await original.mkdtemp(prefix)
      return stash
    })
    const lstat = vi.spyOn(Fs, "lstat").mockRejectedValueOnce(failure)
    try {
      await expect(PackageTree.snapshotTree(root, ".flows")).rejects.toBe(failure)
      expect(stash).toBeDefined()
      await expect(Fs.lstat(stash!)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      lstat.mockRestore()
      mkdtemp.mockRestore()
      if (stash !== undefined) await Fs.rm(stash, { recursive: true, force: true })
    }
  })
})

describe("failed snapshot acquisition removes its partial stash", () => {
  it.each(["tree", "portals"] as const)("preserves the %s acquisition error when cleanup also fails", async (kind) => {
    ChildProcess.execFileSync("git", ["init", "--quiet", "."], { cwd: root, stdio: "ignore" })
    await Fs.writeFile(NodePath.join(kind === "tree" ? root : outside, "source.txt"), "source")
    if (kind === "portals") await Fs.symlink(NodePath.join(outside, "source.txt"), NodePath.join(root, "portal"))
    const original = await vi.importActual<typeof Fs>("node:fs/promises")
    const failure = new Error("snapshot acquisition failed")
    let stash: string | undefined
    vi.mocked(Fs.copyFile).mockImplementationOnce(async (_source, destination) => {
      stash = NodePath.dirname(String(destination))
      throw failure
    })
    vi.mocked(Fs.rm).mockRejectedValueOnce(new Error("snapshot cleanup failed"))
    try {
      await expect((kind === "tree" ? PackageTree.snapshotTree : PackageTree.snapshotPortals)(root, ".flows")).rejects
        .toBe(failure)
      expect(stash).toBeDefined()
      expect((await original.stat(stash!)).isDirectory()).toBe(true)
    } finally {
      vi.mocked(Fs.copyFile).mockReset().mockImplementation(original.copyFile)
      vi.mocked(Fs.rm).mockReset().mockImplementation(original.rm)
      if (stash !== undefined) await original.rm(stash, { recursive: true, force: true })
    }
  })

  for (const kind of ["tree", "portals"] as const) {
    it(`removes the ${kind} stash when the second copy fails`, async () => {
      ChildProcess.execFileSync("git", ["init", "--quiet", "."], { cwd: root, stdio: "ignore" })
      const directory = kind === "tree" ? root : outside
      await Fs.writeFile(NodePath.join(directory, "a.txt"), "first")
      await Fs.writeFile(NodePath.join(directory, "b.txt"), "second")
      if (kind === "portals") {
        await Fs.symlink(NodePath.join(outside, "a.txt"), NodePath.join(root, "a-portal"))
        await Fs.symlink(NodePath.join(outside, "b.txt"), NodePath.join(root, "b-portal"))
      }
      const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      const failure = new Error("second snapshot copy failed")
      let stashDirectory: string | undefined
      let copiedFiles: Array<string> = []
      const copy = vi.mocked(Fs.copyFile)
      copy.mockImplementationOnce(original.copyFile).mockImplementationOnce(async (_source, destination) => {
        stashDirectory = NodePath.dirname(String(destination))
        copiedFiles = await original.readdir(stashDirectory)
        throw failure
      })
      try {
        const acquire = kind === "tree" ? PackageTree.snapshotTree : PackageTree.snapshotPortals
        await expect(acquire(root, ".flows")).rejects.toBe(failure)
        expect(copiedFiles).toHaveLength(1)
        expect(stashDirectory).toBeDefined()
        await expect(Fs.lstat(stashDirectory!)).rejects.toMatchObject({ code: "ENOENT" })
      } finally {
        copy.mockReset().mockImplementation(original.copyFile)
        if (stashDirectory !== undefined) await Fs.rm(stashDirectory, { recursive: true, force: true })
      }
    })
  }
})

describe("treeMatchesManifest compares the tree, not just the manifest", () => {
  const capture = async (): Promise<PackageTree.OutDirManifest> => {
    await Fs.mkdir(NodePath.join(root, "dist", "nested"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "a.txt"), "art")
    await Fs.writeFile(NodePath.join(root, "dist", "nested", "b.txt"), "deep")
    return PackageTree.captureOutDir(root, ".flows", "dist")
  }

  it("matches the tree it captured", async () => {
    const manifest = await capture()
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toBeUndefined()
  })

  it("matches nested directories created by materializeManifest", async () => {
    const manifest = await capture()
    await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
    await PackageTree.materializeManifest(root, ".flows", manifest)
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toBeUndefined()
  })

  /**
   * `PackageExec` skips materialization entirely when this answers undefined,
   * so anything it cannot see survives a cache hit into the declared output
   * tree. Iterating only the manifest's own entries left a stale artifact from
   * a previous build in place forever.
   */
  it("reports a file on disk that the manifest does not name", async () => {
    const manifest = await capture()
    await Fs.writeFile(NodePath.join(root, "dist", "nested", "stale.txt"), "left over")
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toMatch(/nested\/stale\.txt is not in the captured/)
  })

  it("reports a symlink on disk that the manifest does not name", async () => {
    const manifest = await capture()
    await Fs.symlink("a.txt", NodePath.join(root, "dist", "alias"))
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toMatch(/dist\/alias is not in the captured/)
  })

  it("reports an extra empty directory", async () => {
    const manifest = await capture()
    await Fs.mkdir(NodePath.join(root, "dist", "empty"))
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toBe(
      "dist/empty is not in the captured tree"
    )
  })

  it("reports an extra empty nested directory", async () => {
    const manifest = await capture()
    await Fs.mkdir(NodePath.join(root, "dist", "nested", "empty", "deeper"), { recursive: true })
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toBe(
      "dist/nested/empty is not in the captured tree"
    )
  })

  /** Capture records the executable bit; the comparison used to ignore it. */
  it("reports executable-bit drift", async () => {
    const manifest = await capture()
    await Fs.chmod(NodePath.join(root, "dist", "a.txt"), 0o755)
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toMatch(
      /dist\/a\.txt does not match the captured mode/
    )
  })
})

describe("output capture refuses a symlinked parent", () => {
  it("refuses an outFile whose parent leaves the workspace", async () => {
    await Fs.symlink(outside, NodePath.join(root, "link"))
    await Fs.writeFile(NodePath.join(outside, "secret.txt"), "host bytes")
    await expect(PackageTree.captureFile(root, ".flows", "link/secret.txt"))
      .rejects.toThrow(/resolves outside the workspace through a symlinked parent/)
  })

  it("refuses an outDir whose parent leaves the workspace", async () => {
    await Fs.symlink(outside, NodePath.join(root, "link"))
    await Fs.mkdir(NodePath.join(outside, "dist"), { recursive: true })
    await expect(PackageTree.captureOutDir(root, ".flows", "link/dist"))
      .rejects.toThrow(/resolves outside the workspace through a symlinked parent/)
  })

  it("refuses to restore a file through a symlinked parent", async () => {
    const cas = NodePath.join(root, ".flows", "cas")
    await Fs.mkdir(cas, { recursive: true })
    const digest = sha256("restored")
    await Fs.writeFile(NodePath.join(cas, digest), "restored")
    await Fs.writeFile(NodePath.join(outside, "keep.txt"), "untouched")
    await Fs.symlink(outside, NodePath.join(root, "link"))
    await expect(
      PackageTree.materializeFile(root, ".flows", { path: "link/new/a.txt", digest, executable: false })
    ).rejects.toThrow(/resolves outside the workspace through a symlinked parent/)
    expect(await Fs.readdir(outside)).toEqual(["keep.txt"])
  })

  it("refuses to restore a manifest before creating a temp tree through a symlinked parent", async () => {
    await Fs.writeFile(NodePath.join(outside, "keep.txt"), "untouched")
    await Fs.symlink(outside, NodePath.join(root, "link"))
    await expect(
      PackageTree.materializeManifest(root, ".flows", { outDir: "link/dist", entries: [] })
    ).rejects.toThrow(/resolves outside the workspace through a symlinked parent/)
    const externalEntries = await Fs.readdir(outside)
    expect(externalEntries).toEqual(["keep.txt"])
    expect(externalEntries.filter((name) => name.startsWith(".smthrs-mat-"))).toEqual([])
  })
})

describe("captureFile heals a tampered CAS blob", () => {
  /**
   * `captureOutDir` verified an existing blob's bytes; `captureFile` trusted
   * the name, so a poisoned blob was re-admitted by every rebuild and every
   * restore kept refusing with `cas blob tampered`.
   */
  it("rewrites an existing blob whose bytes no longer match its name", async () => {
    await Fs.writeFile(NodePath.join(root, "out.txt"), "art")
    const first = await PackageTree.captureFile(root, ".flows", "out.txt")
    const blob = NodePath.join(root, ".flows", "cas", first.digest)
    await Fs.writeFile(blob, "tampered")
    await PackageTree.captureFile(root, ".flows", "out.txt")
    expect(await Fs.readFile(blob, "utf8")).toBe("art")
    expect(await PackageTree.verifyFileManifest(root, ".flows", first)).toBeUndefined()
  })

  it("refuses a declared output file the target never created", async () => {
    await expect(PackageTree.captureFile(root, ".flows", "never-written.txt"))
      .rejects.toThrow(/declared output file was not created: never-written.txt/)
  })

  it("reports a missing and a tampered CAS blob against the same manifest", async () => {
    await Fs.writeFile(NodePath.join(root, "out.txt"), "art")
    const manifest = await PackageTree.captureFile(root, ".flows", "out.txt")
    const blob = NodePath.join(root, ".flows", "cas", manifest.digest)
    await Fs.writeFile(blob, "tampered")
    expect(await PackageTree.verifyFileManifest(root, ".flows", manifest))
      .toBe("cas blob tampered for out.txt")
    await Fs.rm(blob)
    expect(await PackageTree.verifyFileManifest(root, ".flows", manifest))
      .toBe("cas blob missing for out.txt")
  })
})

describe("the CAS publish path", () => {
  it("leaves no temp files beside the blobs it writes", async () => {
    await Fs.mkdir(NodePath.join(root, "dist"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "a.txt"), "art")
    await Fs.writeFile(NodePath.join(root, "out.txt"), "other")
    const tree = await PackageTree.captureOutDir(root, ".flows", "dist")
    const file = await PackageTree.captureFile(root, ".flows", "out.txt")
    const listed = (await Fs.readdir(NodePath.join(root, ".flows", "cas"))).sort()
    expect(listed).toEqual([tree.entries[0]!.digest, file.digest].sort())
  })

  it("removes its temp file when the publishing rename fails", async () => {
    // A directory squatting on the blob's content-addressed name: the verify
    // read fails (EISDIR), the temp copy succeeds, and the rename onto a
    // directory fails. The failed publish must not strand the temp file.
    await Fs.writeFile(NodePath.join(root, "out.txt"), "art")
    const digest = PackageTree.digestBytes(Buffer.from("art", "utf8"))
    const cas = NodePath.join(root, ".flows", "cas")
    await Fs.mkdir(NodePath.join(cas, digest), { recursive: true })
    await expect(PackageTree.captureFile(root, ".flows", "out.txt")).rejects.toThrow()
    expect(await Fs.readdir(cas)).toEqual([digest])
  })

  it("names blobs by lowercase sha256 hex alone", () => {
    const digest = sha256("art")
    expect(PackageTree.isSha256Hex(digest)).toBe(true)
    expect(PackageTree.isSha256Hex(digest.toUpperCase())).toBe(false)
    expect(PackageTree.isSha256Hex(digest.slice(1))).toBe(false)
    expect(PackageTree.isSha256Hex(`${digest}0`)).toBe(false)
    expect(PackageTree.isSha256Hex("../".padEnd(64, "a"))).toBe(false)
  })
})

describe("captureOutDir bounds the tree it walks", () => {
  it("refuses a tree deeper than the declared depth limit", async () => {
    const segments = Array.from({ length: PackageTree.outDirLimits.depth + 2 }, (_, index) => `d${index}`)
    await Fs.mkdir(NodePath.join(root, "dist", ...segments), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", ...segments, "leaf.txt"), "deep")
    await expect(PackageTree.captureOutDir(root, ".flows", "dist")).rejects.toThrow(/crosses the depth limit/)
  })

  it("captures a tree exactly at the depth limit", async () => {
    const segments = Array.from({ length: PackageTree.outDirLimits.depth }, (_, index) => `d${index}`)
    await Fs.mkdir(NodePath.join(root, "dist", ...segments), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", ...segments, "leaf.txt"), "deep")
    const manifest = await PackageTree.captureOutDir(root, ".flows", "dist")
    expect(manifest.entries).toHaveLength(1)
  })

  it("accepts the entries boundary and refuses one entry over it", async () => {
    const limits = { ...PackageTree.outDirLimits, entries: 2 }
    await Fs.mkdir(NodePath.join(root, "dist", "nested"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "nested", "a"), "a")
    await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, limits)).resolves.toMatchObject({
      entries: [{ path: "nested/a" }]
    })

    await Fs.writeFile(NodePath.join(root, "dist", "z"), "z")
    await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, limits)).rejects.toMatchObject({
      limit: "entries"
    })
  })

  it("accepts the pathBytes boundary and refuses one byte over it", async () => {
    const limits = { ...PackageTree.outDirLimits, pathBytes: 5 }
    await Fs.mkdir(NodePath.join(root, "dist"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "abcde"), "exact")
    await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, limits)).resolves.toBeDefined()

    await Fs.writeFile(NodePath.join(root, "dist", "abcdef"), "over")
    await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, limits)).rejects.toMatchObject({
      limit: "pathBytes"
    })
  })

  it("accepts the manifestBytes boundary and refuses one byte over it", async () => {
    await Fs.mkdir(NodePath.join(root, "dist"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "a.txt"), "x")
    const expectedEntry: PackageTree.ManifestEntry = {
      path: "a.txt",
      kind: "file",
      digest: sha256("x"),
      executable: false,
      target: ""
    }
    const encodedSize = Buffer.byteLength(JSON.stringify([expectedEntry]), "utf8")
    await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, {
      ...PackageTree.outDirLimits,
      manifestBytes: encodedSize
    })).resolves.toEqual({ outDir: "dist", entries: [expectedEntry] })

    await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, {
      ...PackageTree.outDirLimits,
      manifestBytes: encodedSize - 1
    })).rejects.toMatchObject({ limit: "manifestBytes" })
  })

  it("does not publish a blob when a later entry crosses a limit", async () => {
    const cas = NodePath.join(root, ".flows", "cas")
    await Fs.mkdir(NodePath.join(root, "dist"), { recursive: true })
    await Fs.mkdir(cas, { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "a"), "first")
    await Fs.writeFile(NodePath.join(root, "dist", "b"), "second")

    await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, {
      ...PackageTree.outDirLimits,
      entries: 1
    })).rejects.toMatchObject({ limit: "entries" })
    expect(await Fs.readdir(cas)).toEqual([])
  })

  it("enforces file and total byte limits against the bytes the digest consumed", async () => {
    const file = NodePath.join(root, "dist", "growing.txt")
    await Fs.mkdir(NodePath.dirname(file), { recursive: true })
    await Fs.writeFile(file, "12")
    lstatSizeOverride.path = file
    lstatSizeOverride.size = 0
    try {
      await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, {
        ...PackageTree.outDirLimits,
        fileBytes: 1
      })).rejects.toMatchObject({ limit: "fileBytes" })
      await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, {
        ...PackageTree.outDirLimits,
        fileBytes: 2,
        totalBytes: 1
      })).rejects.toMatchObject({ limit: "totalBytes" })
    } finally {
      lstatSizeOverride.path = undefined
    }
  })
})

describe("the portal census refuses what it cannot measure", () => {
  const git = (...args: ReadonlyArray<string>): void => {
    ChildProcess.execFileSync("git", [...args], { cwd: root, stdio: "ignore" })
  }

  /**
   * `snapshotPortals` used to catch every failure of the portal walk — the
   * documented over-`portalEntryCap` case, but also a permission error or a
   * directory racing the census — report it through a log line, and run the
   * target anyway with the write-set guard silently disarmed over that portal.
   */
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails the census when an escaping portal's target cannot be read",
    async () => {
      git("init", "--quiet", ".")
      await Fs.mkdir(NodePath.join(outside, "sealed"), { recursive: true })
      await Fs.writeFile(NodePath.join(outside, "sealed", "a.txt"), "x")
      await Fs.symlink(NodePath.join(outside, "sealed"), NodePath.join(root, "portal"))
      await Fs.chmod(NodePath.join(outside, "sealed"), 0o000)
      try {
        const censused = await PackageTree.snapshotPortals(root, ".flows").then(
          () => undefined,
          (cause: unknown) => cause
        )
        expect(censused).toBeInstanceOf(PackageTree.PortalCensusError)
        expect((censused as PackageTree.PortalCensusError).link).toBe("portal")
        expect((censused as PackageTree.PortalCensusError).reason).toBe("unreadable")
      } finally {
        await Fs.chmod(NodePath.join(outside, "sealed"), 0o755)
      }
    }
  )

  it("censuses and reverts a file created through a dangling escaping symlink", async () => {
    git("init", "--quiet", ".")
    const escapedTarget = NodePath.join(outside, "created.txt")
    await Fs.symlink(escapedTarget, NodePath.join(root, "portal"))
    const snapshot = await PackageTree.snapshotPortals(root, ".flows")
    try {
      expect(snapshot.portals).toHaveLength(1)
      expect(snapshot.portals[0]).toMatchObject({ link: "portal", realTarget: escapedTarget })
      expect([...snapshot.portals[0]!.states]).toEqual([])
      expect(await PackageTree.revertChangedPortals(snapshot)).toEqual([])

      await Fs.writeFile(NodePath.join(root, "portal"), "escaped")
      expect(await PackageTree.revertChangedPortals(snapshot)).toEqual(["portal"])
      expect(await Fs.lstat(escapedTarget).then(() => true, () => false)).toBe(false)
    } finally {
      await PackageTree.releasePortals(snapshot)
    }
  })

  it("leaves a dangling symlink to an in-workspace destination to the git guard", async () => {
    git("init", "--quiet", ".")
    await Fs.symlink("created.txt", NodePath.join(root, "inside"))
    const snapshot = await PackageTree.snapshotPortals(root, ".flows")
    try {
      expect(snapshot.portals).toEqual([])
    } finally {
      await PackageTree.releasePortals(snapshot)
    }
  })

  it("measures a readable escaping portal", async () => {
    git("init", "--quiet", ".")
    await Fs.mkdir(NodePath.join(outside, "open"), { recursive: true })
    await Fs.writeFile(NodePath.join(outside, "open", "a.txt"), "x")
    await Fs.symlink(NodePath.join(outside, "open"), NodePath.join(root, "portal"))
    const snapshot = await PackageTree.snapshotPortals(root, ".flows")
    try {
      expect(snapshot.portals.map((portal) => portal.link)).toEqual(["portal"])
    } finally {
      await PackageTree.releasePortals(snapshot)
    }
  })
})

describe("the ignored guard restores what a body changed", () => {
  const git = (cwd: string, ...args: ReadonlyArray<string>): void => {
    ChildProcess.execFileSync("git", [...args], { cwd, stdio: "ignore" })
  }
  const ignoring = async (patterns: string): Promise<void> => {
    git(root, "init", "--quiet", ".")
    await Fs.writeFile(NodePath.join(root, ".gitignore"), patterns)
  }
  const exists = (path: string): Promise<boolean> => Fs.lstat(path).then(() => true, () => false)
  const refusal = (limits?: PackageTree.IgnoredLimits): Promise<unknown> =>
    PackageTree.snapshotIgnored(root, ".flows", limits).then(
      (snapshot) => PackageTree.releaseIgnored(snapshot).then(() => undefined),
      (cause: unknown) => cause
    )

  /**
   * The guard used to record an ignored path's identity and no bytes, so the
   * only revert it had was removal: a tool that overwrote `.env` out of set
   * had the user's `.env` deleted for it.
   */
  it("restores an overwritten pre-existing ignored file with its bytes and mode", async () => {
    await ignoring(".env\n")
    const env = NodePath.join(root, ".env")
    await Fs.writeFile(env, "secret")
    await Fs.chmod(env, 0o600)
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      await Fs.writeFile(env, "leaked bytes")
      await Fs.chmod(env, 0o644)
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual([".env"])
      expect(await PackageTree.revertIgnored(snapshot, ".env")).toBe(true)
      expect(await Fs.readFile(env, "utf8")).toBe("secret")
      expect((await Fs.lstat(env)).mode & 0o777).toBe(0o600)
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
    expect(snapshot.ownsStash).toBe(true)
    expect(await exists(snapshot.stash.directory)).toBe(false)
  })

  it("restores a deleted ignored file and removes a created one", async () => {
    await ignoring("dist/\n")
    await Fs.mkdir(NodePath.join(root, "dist", "sub"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "sub", "a.js"), "old")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
      await Fs.mkdir(NodePath.join(root, "dist"))
      await Fs.writeFile(NodePath.join(root, "dist", "b.js"), "new")
      const changed = await PackageTree.changedIgnored(snapshot, ".flows")
      expect(changed).toEqual(["dist/b.js", "dist/sub/a.js"])
      for (const path of changed) expect(await PackageTree.revertIgnored(snapshot, path)).toBe(true)
      expect(await Fs.readFile(NodePath.join(root, "dist", "sub", "a.js"), "utf8")).toBe("old")
      expect(await exists(NodePath.join(root, "dist", "b.js"))).toBe(false)
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  it("restores a replaced ignored symlink to its target", async () => {
    await ignoring("alias\n")
    await Fs.symlink("dist", NodePath.join(root, "alias"))
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      await Fs.rm(NodePath.join(root, "alias"))
      await Fs.writeFile(NodePath.join(root, "alias"), "not a link")
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual(["alias"])
      expect(await PackageTree.revertIgnored(snapshot, "alias")).toBe(true)
      expect(await Fs.readlink(NodePath.join(root, "alias"))).toBe("dist")
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  it("does not count a path that merely stopped being ignored", async () => {
    await ignoring("keep.txt\n")
    await Fs.writeFile(NodePath.join(root, "keep.txt"), "kept")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      await Fs.writeFile(NodePath.join(root, ".gitignore"), "")
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual([])
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  /**
   * Git never enters a nested repository, so the census sees only its
   * directory and the stash holds none of its contents. The old revert removed
   * the whole directory; the honest answer is to name it and leave it.
   */
  it("names a nested repository it cannot restore and leaves it in place", async () => {
    await ignoring("vendor/\n")
    const nested = NodePath.join(root, "vendor", "nested")
    await Fs.mkdir(nested, { recursive: true })
    git(nested, "init", "--quiet", ".")
    await Fs.writeFile(NodePath.join(nested, "x.txt"), "x")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      await Fs.writeFile(NodePath.join(nested, "y.txt"), "y")
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual(["vendor/nested"])
      expect(await PackageTree.revertIgnored(snapshot, "vendor/nested")).toBe(false)
      expect(await Fs.readFile(NodePath.join(nested, "x.txt"), "utf8")).toBe("x")
      expect(await Fs.readFile(NodePath.join(nested, "y.txt"), "utf8")).toBe("y")
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  /**
   * A tool that removed a nested repository's `.git` makes git list the files
   * it used to hide. They read as created, and removing them would be the
   * same loss; a path under a directory the census never entered is left.
   */
  it("leaves the files a tool surfaced by un-initializing a nested repository", async () => {
    await ignoring("vendor/\n")
    const nested = NodePath.join(root, "vendor", "nested")
    await Fs.mkdir(nested, { recursive: true })
    git(nested, "init", "--quiet", ".")
    await Fs.writeFile(NodePath.join(nested, "x.txt"), "x")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      await Fs.rm(NodePath.join(nested, ".git"), { recursive: true, force: true })
      const changed = await PackageTree.changedIgnored(snapshot, ".flows")
      expect(changed).toEqual(["vendor/nested", "vendor/nested/x.txt"])
      for (const path of changed) expect(await PackageTree.revertIgnored(snapshot, path)).toBe(false)
      expect(await Fs.readFile(NodePath.join(nested, "x.txt"), "utf8")).toBe("x")
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  /**
   * The tool ran `git init` inside `dist`, so a directory git will not enter
   * now stands where the census saw files. Those files are still the user's;
   * the guard leaves the directory rather than removing it.
   */
  it("leaves a directory git stopped entering during the body", async () => {
    await ignoring("dist/\n")
    await Fs.mkdir(NodePath.join(root, "dist"))
    await Fs.writeFile(NodePath.join(root, "dist", "a.js"), "old")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      git(NodePath.join(root, "dist"), "init", "--quiet", ".")
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual(["dist"])
      expect(await PackageTree.revertIgnored(snapshot, "dist")).toBe(false)
      expect(await Fs.readFile(NodePath.join(root, "dist", "a.js"), "utf8")).toBe("old")
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  it("counts a path that stopped being ignored only when it also changed", async () => {
    await ignoring("keep.txt\n")
    await Fs.writeFile(NodePath.join(root, "keep.txt"), "kept")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      await Fs.writeFile(NodePath.join(root, ".gitignore"), "")
      await Fs.writeFile(NodePath.join(root, "keep.txt"), "rewritten")
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual(["keep.txt"])
      expect(await PackageTree.revertIgnored(snapshot, "keep.txt")).toBe(true)
      expect(await Fs.readFile(NodePath.join(root, "keep.txt"), "utf8")).toBe("kept")
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  it("refuses a census over the entry ceiling", async () => {
    await ignoring("*.log\n")
    await Fs.writeFile(NodePath.join(root, "a.log"), "a")
    await Fs.writeFile(NodePath.join(root, "b.log"), "b")
    const refused = await refusal({ ...PackageTree.ignoredLimits, entries: 1 })
    expect(refused).toBeInstanceOf(PackageTree.IgnoredCensusError)
    expect((refused as PackageTree.IgnoredCensusError).reason).toBe("entries")
  })

  it("refuses a census whose stash would cross the byte ceiling, and stashes one under it", async () => {
    await ignoring("*.bin\n")
    await Fs.writeFile(NodePath.join(root, "a.bin"), "ab")
    expect(await refusal({ ...PackageTree.ignoredLimits, totalBytes: 2 })).toBeUndefined()
    await Fs.writeFile(NodePath.join(root, "b.bin"), "c")
    const refused = await refusal({ ...PackageTree.ignoredLimits, totalBytes: 2 })
    expect(refused).toBeInstanceOf(PackageTree.IgnoredCensusError)
    expect((refused as PackageTree.IgnoredCensusError).reason).toBe("totalBytes")
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a census with an ignored file it cannot read",
    async () => {
      await ignoring("sealed.txt\n")
      const sealed = NodePath.join(root, "sealed.txt")
      await Fs.writeFile(sealed, "x")
      await Fs.chmod(sealed, 0o000)
      try {
        const refused = await refusal()
        expect(refused).toBeInstanceOf(PackageTree.IgnoredCensusError)
        expect((refused as PackageTree.IgnoredCensusError).reason).toBe("unreadable")
        expect((refused as PackageTree.IgnoredCensusError).path).toBe("sealed.txt")
      } finally {
        await Fs.chmod(sealed, 0o644)
      }
    }
  )
})

describe("the ignored census costs what a body can change", () => {
  const git = (cwd: string, ...args: ReadonlyArray<string>): void => {
    ChildProcess.execFileSync("git", [...args], { cwd, stdio: "ignore" })
  }
  const ignoring = async (patterns: string): Promise<void> => {
    git(root, "init", "--quiet", ".")
    await Fs.writeFile(NodePath.join(root, ".gitignore"), patterns)
  }
  const file = async (relative: string, content: string | Buffer): Promise<void> => {
    const absolute = NodePath.join(root, relative)
    await Fs.mkdir(NodePath.dirname(absolute), { recursive: true })
    await Fs.writeFile(absolute, content)
  }
  const exists = (path: string): Promise<boolean> => Fs.lstat(path).then(() => true, () => false)
  const stashFiles = async (stash: PackageTree.IgnoredStash): Promise<number> =>
    (await Fs.readdir(stash.directory)).length
  const mib = 1024 * 1024

  /**
   * The skip applied to the root `node_modules` alone, so a workspace's
   * nested ones were censused (15,000 entries and 672 MiB on this
   * repository, most of it under `marketing/hermes-site/node_modules`) and
   * counted against ceilings the JSDoc said they never touched.
   */
  it("excludes node_modules at every depth from the census and its ceilings, and still censuses the sibling", async () => {
    await ignoring("node_modules/\n*.log\n")
    await file("node_modules/root/index.js", "r".repeat(64))
    await file("marketing/site/node_modules/dep/index.js", "d".repeat(4096))
    await file("marketing/site/node_modules/dep/nested/node_modules/deep/index.js", "n".repeat(4096))
    await file("marketing/site/build.log", "log")
    // Ceilings only the sibling fits under: one entry of three bytes. The
    // census refuses if any node_modules entry counts toward either.
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows", { entries: 1, totalBytes: 3 })
    try {
      expect([...snapshot.entries.keys()]).toEqual(["marketing/site/build.log"])
      expect(snapshot.census).toEqual({ entries: 1, bytes: 3, copied: 1, copiedBytes: 3, reused: 0 })
      // A write under a nested node_modules is host state, out of the guard's
      // sight like a write under the root one; the sibling is still judged.
      await file("marketing/site/node_modules/dep/index.js", "rewritten")
      await file("marketing/site/node_modules/cache/new.js", "new")
      await file("marketing/site/build.log", "changed")
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual(["marketing/site/build.log"])
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  /**
   * The stash was taken fresh for every guarded body, copying every ignored
   * file each time. Shared across bodies, a census copies only what moved,
   * and the tool's own accounting says so: no stopwatch needed.
   */
  it("measures unchanged large ignored files by lstat and copies none of them again", async () => {
    await ignoring("blobs/\n")
    const blob = Buffer.alloc(mib, 7)
    for (let index = 0; index < 24; index += 1) await file(`blobs/${index}.bin`, blob)
    const stash = await PackageTree.openIgnoredStash()
    try {
      const first = await PackageTree.snapshotIgnored(root, ".flows", PackageTree.ignoredLimits, stash)
      expect(first.ownsStash).toBe(false)
      expect(first.census).toEqual({ entries: 24, bytes: 24 * mib, copied: 24, copiedBytes: 24 * mib, reused: 0 })
      await PackageTree.releaseIgnored(first)
      // Releasing a snapshot leaves the shared stash, and its files, in place.
      expect(await stashFiles(stash)).toBe(24)
      const second = await PackageTree.snapshotIgnored(root, ".flows", PackageTree.ignoredLimits, stash)
      expect(second.census).toEqual({ entries: 24, bytes: 24 * mib, copied: 0, copiedBytes: 0, reused: 24 })
      await PackageTree.releaseIgnored(second)
      // One rewritten file is the only copy the next census makes, and a
      // removed one leaves the stash, which never outgrows the census.
      await file("blobs/3.bin", Buffer.alloc(mib + 1, 9))
      await Fs.rm(NodePath.join(root, "blobs", "5.bin"))
      const third = await PackageTree.snapshotIgnored(root, ".flows", PackageTree.ignoredLimits, stash)
      expect(third.census).toEqual({ entries: 23, bytes: 23 * mib + 1, copied: 1, copiedBytes: mib + 1, reused: 22 })
      expect(stash.held.size).toBe(23)
      expect(await stashFiles(stash)).toBe(23)
      await PackageTree.releaseIgnored(third)
      expect(await exists(stash.directory)).toBe(true)
    } finally {
      await PackageTree.releaseIgnoredStash(stash)
    }
    expect(await exists(stash.directory)).toBe(false)
  })

  it("restores a changed ignored file byte for byte from the stash shared with an earlier census", async () => {
    await ignoring("dist/\n")
    const original = Buffer.from([0, 255, 10, 13, 0, 128, 7])
    const target = NodePath.join(root, "dist", "a.bin")
    await file("dist/a.bin", original)
    await Fs.chmod(target, 0o640)
    const stash = await PackageTree.openIgnoredStash()
    try {
      // An earlier body's census filled the stash; this one reuses it whole.
      const earlier = await PackageTree.snapshotIgnored(root, ".flows", PackageTree.ignoredLimits, stash)
      await PackageTree.releaseIgnored(earlier)
      const snapshot = await PackageTree.snapshotIgnored(root, ".flows", PackageTree.ignoredLimits, stash)
      expect(snapshot.census).toMatchObject({ copied: 0, reused: 1 })
      // The body truncates and rewrites in place, then fails.
      await Fs.writeFile(target, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))
      await Fs.chmod(target, 0o600)
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual(["dist/a.bin"])
      expect(await PackageTree.revertIgnored(snapshot, "dist/a.bin")).toBe(true)
      expect((await Fs.readFile(target)).equals(original)).toBe(true)
      expect((await Fs.lstat(target)).mode & 0o777).toBe(0o640)
      await PackageTree.releaseIgnored(snapshot)
    } finally {
      await PackageTree.releaseIgnoredStash(stash)
    }
  })

  it("records an ignored symlink by its target without walking through it, and hands ignored links to the portal census", async () => {
    await ignoring("alias\nvendor/\n")
    await file("vendor/real/x.txt", "x")
    await Fs.symlink("vendor/real", NodePath.join(root, "alias"))
    await Fs.mkdir(NodePath.join(outside, "target"), { recursive: true })
    await Fs.symlink(NodePath.join(outside, "target"), NodePath.join(root, "vendor", "portal"))
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      expect([...snapshot.entries.keys()].sort()).toEqual(["alias", "vendor/portal", "vendor/real/x.txt"])
      expect(snapshot.entries.get("alias")).toMatchObject({ kind: "link", target: "vendor/real" })
      // The link under the ignored directory reaches the portal census from
      // this snapshot, and from a census of its own when no snapshot is given.
      const fromSnapshot = await PackageTree.snapshotPortals(root, ".flows", snapshot)
      try {
        expect(fromSnapshot.portals.map((portal) => portal.link)).toEqual(["vendor/portal"])
      } finally {
        await PackageTree.releasePortals(fromSnapshot)
      }
      const fromCensus = await PackageTree.snapshotPortals(root, ".flows")
      try {
        expect(fromCensus.portals.map((portal) => portal.link)).toEqual(["vendor/portal"])
      } finally {
        await PackageTree.releasePortals(fromCensus)
      }
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  it("stops walking at a nested repository inside an ignored directory", async () => {
    await ignoring("vendor/\n")
    await file("vendor/plain/a.txt", "a")
    await file("vendor/nested/x.txt", "x")
    git(NodePath.join(root, "vendor", "nested"), "init", "--quiet", ".")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      expect([...snapshot.entries.keys()].sort()).toEqual(["vendor/nested", "vendor/plain/a.txt"])
      expect(snapshot.entries.get("vendor/nested")?.kind).toBe("dir")
      expect(snapshot.census).toEqual({ entries: 2, bytes: 1, copied: 1, copiedBytes: 1, reused: 0 })
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  it("applies the entry ceiling while walking an ignored directory", async () => {
    await ignoring("dist/\n")
    for (let index = 0; index < 5; index += 1) await file(`dist/${index}.js`, "x")
    const refused = await PackageTree.snapshotIgnored(root, ".flows", { ...PackageTree.ignoredLimits, entries: 3 })
      .then((snapshot) => PackageTree.releaseIgnored(snapshot).then(() => undefined), (cause: unknown) => cause)
    expect(refused).toBeInstanceOf(PackageTree.IgnoredCensusError)
    expect((refused as PackageTree.IgnoredCensusError).reason).toBe("entries")
    expect((refused as PackageTree.IgnoredCensusError).path).toMatch(/^dist\/\d\.js$/)
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a census with an ignored directory it cannot read",
    async () => {
      await ignoring("sealed/\n")
      await file("sealed/x.txt", "x")
      const sealed = NodePath.join(root, "sealed")
      await Fs.chmod(sealed, 0o000)
      try {
        const refused = await PackageTree.snapshotIgnored(root, ".flows")
          .then((snapshot) => PackageTree.releaseIgnored(snapshot).then(() => undefined), (cause: unknown) => cause)
        expect(refused).toBeInstanceOf(PackageTree.IgnoredCensusError)
        expect((refused as PackageTree.IgnoredCensusError).reason).toBe("unreadable")
        expect((refused as PackageTree.IgnoredCensusError).path).toBe("sealed")
      } finally {
        await Fs.chmod(sealed, 0o755)
      }
    }
  )
})

/**
 * The census insures the developer's own gitignored state, and a toolchain's
 * build directory is not that: cargo rebuilds every byte of `target/` on
 * demand, exactly as a package manager rebuilds `node_modules`. Counting it
 * turned the byte ceiling into a census of the host's build artifacts, and a
 * checkout with a built Rust tree had 908 MiB of `.rmeta` refuse every
 * `--write` before its body ran.
 */
describe("the ignored census skips the build directory a declared toolchain owns", () => {
  const git = (cwd: string, ...args: ReadonlyArray<string>): void => {
    ChildProcess.execFileSync("git", [...args], { cwd, stdio: "ignore" })
  }
  const ignoring = async (patterns: string): Promise<void> => {
    git(root, "init", "--quiet", ".")
    await Fs.writeFile(NodePath.join(root, ".gitignore"), patterns)
  }
  const file = async (relative: string, content: string): Promise<void> => {
    const absolute = NodePath.join(root, relative)
    await Fs.mkdir(NodePath.dirname(absolute), { recursive: true })
    await Fs.writeFile(absolute, content)
  }

  it("counts neither the entries nor the bytes of a host tree, and still counts its siblings", async () => {
    await ignoring("target/\n.env\n")
    await file("target/debug/deps/libzerocopy.rmeta", "r".repeat(4096))
    await file("target/debug/build.log", "b".repeat(4096))
    await file(".env", "sec")
    // Ceilings only the sibling fits under: the census refuses if one entry or
    // one byte of `target/` counts toward either.
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows", { entries: 1, totalBytes: 3 }, undefined, [
      "target"
    ])
    try {
      expect([...snapshot.entries.keys()]).toEqual([".env"])
      expect(snapshot.census).toEqual({ entries: 1, bytes: 3, copied: 1, copiedBytes: 3, reused: 0 })
      // A write under the host tree is out of the guard's sight like a write
      // under node_modules; the sibling is still judged and still restored.
      await file("target/debug/deps/libzerocopy.rmeta", "rebuilt")
      await file("target/debug/deps/new.rmeta", "new")
      await file(".env", "leaked")
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual([".env"])
      expect(await PackageTree.revertIgnored(snapshot, ".env")).toBe(true)
      expect(await Fs.readFile(NodePath.join(root, ".env"), "utf8")).toBe("sec")
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  it("names host trees by path, so a source directory of the same name is still censused", async () => {
    await ignoring("target/\nsrc/plugins/target/\n")
    await file("target/big.rmeta", "x")
    await file("src/plugins/target/generated.ts", "y")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows", PackageTree.ignoredLimits, undefined, ["target"])
    try {
      expect([...snapshot.entries.keys()]).toEqual(["src/plugins/target/generated.ts"])
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  it("skips a host tree beside a nested workspace manifest, not one at the root", async () => {
    await ignoring("crates/target/\ntarget/\n")
    await file("crates/target/big.rmeta", "x")
    await file("target/mine.txt", "y")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows", PackageTree.ignoredLimits, undefined, [
      "crates/target"
    ])
    try {
      expect([...snapshot.entries.keys()]).toEqual(["target/mine.txt"])
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })
})

describe("materialization publication ownership and cleanup", () => {
  const manifest = (outDir: string, digest: string): PackageTree.OutDirManifest => ({
    outDir,
    entries: [{ path: "next.txt", kind: "file", digest, executable: false, target: "" }]
  })
  const seed = async (): Promise<string> => {
    const digest = sha256("next")
    await Fs.mkdir(NodePath.join(root, ".flows/cas"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, ".flows/cas", digest), "next")
    return digest
  }
  const strand = async (name: string): Promise<string> => {
    const backup = NodePath.join(root, name)
    await Fs.mkdir(backup)
    await Fs.writeFile(NodePath.join(backup, "previous.txt"), "previous alpha")
    return backup
  }

  for (const succeeds of [true, false]) {
    for (const legacy of [true, false]) {
      it(`preserves ${legacy ? "unowned legacy" : "alpha-owned"} backups during ${succeeds ? "successful" : "failed"} beta publication`, async () => {
        const digest = await seed()
        const owner = sha256(NodePath.join(root, "alpha"))
        const backup = await strand(legacy ? ".smthrs-old-crashed" : `.smthrs-old-${owner}-crashed`)
        const publish = PackageTree.materializeManifest(
          root,
          ".flows",
          manifest("beta", succeeds ? digest : "0".repeat(64))
        )
        if (succeeds) await publish
        else await expect(publish).rejects.toThrow()
        expect(await Fs.readFile(NodePath.join(backup, "previous.txt"), "utf8")).toBe("previous alpha")
        await expect(Fs.lstat(NodePath.join(root, "beta/previous.txt"))).rejects.toMatchObject({ code: "ENOENT" })
        if (succeeds) expect(await Fs.readFile(NodePath.join(root, "beta/next.txt"), "utf8")).toBe("next")
      })
    }
  }

  it("recovers only the requested destination before failed staging", async () => {
    const alpha = await strand(`.smthrs-old-${sha256(NodePath.join(root, "alpha"))}-crashed`)
    const beta = await strand(`.smthrs-old-${sha256(NodePath.join(root, "beta"))}-crashed`)
    await expect(PackageTree.materializeManifest(root, ".flows", manifest("alpha", "0".repeat(64)))).rejects.toThrow()
    expect(await Fs.readFile(NodePath.join(root, "alpha/previous.txt"), "utf8")).toBe("previous alpha")
    await expect(Fs.lstat(alpha)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await Fs.readFile(NodePath.join(beta, "previous.txt"), "utf8")).toBe("previous alpha")
  })

  it("leaves ambiguous backups untouched", async () => {
    const prefix = `.smthrs-old-${sha256(NodePath.join(root, "alpha"))}`
    const first = await strand(`${prefix}-first`)
    const second = await strand(`${prefix}-second`)
    await expect(PackageTree.materializeManifest(root, ".flows", manifest("alpha", "0".repeat(64)))).rejects.toThrow()
    for (const backup of [first, second]) {
      expect(await Fs.readFile(NodePath.join(backup, "previous.txt"), "utf8")).toBe("previous alpha")
    }
    await expect(Fs.lstat(NodePath.join(root, "alpha"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("requires removal of a stranded publisher lock before recovering its backup", async () => {
    const owner = sha256(NodePath.join(root, "alpha"))
    const backup = await strand(`.smthrs-old-${owner}-crashed`)
    const lock = NodePath.join(root, `.smthrs-lock-${owner}`)
    await Fs.mkdir(lock)
    const missing = manifest("alpha", "0".repeat(64))
    await expect(PackageTree.materializeManifest(root, ".flows", missing)).rejects.toThrow(/publication lock/)
    expect((await Fs.lstat(lock)).isDirectory()).toBe(true)
    expect(await Fs.readFile(NodePath.join(backup, "previous.txt"), "utf8")).toBe("previous alpha")
    await expect(Fs.lstat(NodePath.join(root, "alpha"))).rejects.toMatchObject({ code: "ENOENT" })

    // Simulate the operator confirming the crashed publisher has stopped.
    await Fs.rmdir(lock)
    await expect(PackageTree.materializeManifest(root, ".flows", missing)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await Fs.readFile(NodePath.join(root, "alpha/previous.txt"), "utf8")).toBe("previous alpha")
    expect((await Fs.readdir(root)).filter((name) => name.startsWith(".smthrs-"))).toEqual([])
  })

  it("documents the reader-visible absence window and excludes another publisher", async () => {
    const digest = await seed()
    await Fs.mkdir(NodePath.join(root, "alpha"))
    await Fs.writeFile(NodePath.join(root, "alpha/previous.txt"), "previous")
    const original = await vi.importActual<typeof Fs>("node:fs/promises")
    const rename = vi.mocked(Fs.rename)
    let observed = false
    rename.mockImplementation(async (from, to) => {
      await original.rename(from, to)
      if (observed || String(from) !== NodePath.join(root, "alpha")) return
      observed = true
      await expect(Fs.lstat(NodePath.join(root, "alpha"))).rejects.toMatchObject({ code: "ENOENT" })
      // A sibling may publish, but the same output (including an alias) must
      // fail before it can recover the first publisher's set-aside tree.
      await PackageTree.materializeManifest(root, ".flows", manifest("beta", digest))
      await expect(PackageTree.materializeManifest(root, ".flows", manifest("./alpha", digest)))
        .rejects.toThrow(/publication lock/)
      expect(
        (await Fs.lstat(NodePath.join(root, `.smthrs-lock-${sha256(NodePath.join(root, "alpha"))}`))).isDirectory()
      )
        .toBe(true)
    })
    try {
      await PackageTree.materializeManifest(root, ".flows", manifest("alpha", digest))
      expect(observed).toBe(true)
      expect(await Fs.readFile(NodePath.join(root, "alpha/next.txt"), "utf8")).toBe("next")
      expect((await Fs.readdir(root)).filter((name) => name.startsWith(".smthrs-"))).toEqual([])
    } finally {
      rename.mockReset().mockImplementation(original.rename)
    }
  })

  it("documents staged publication without promising atomic visibility", async () => {
    const source = await Fs.readFile(new URL("../src/PackageTree.ts", import.meta.url), "utf8")
    const jsdoc = source.slice(
      source.lastIndexOf("/**", source.indexOf("export const materializeManifest")),
      source.indexOf("export const materializeManifest")
    )
    expect(jsdoc).toContain("brief absence window")
    expect(jsdoc).not.toContain("atomically")
  })

  it("leaves no copied file temporary after an obstructed destination on repeated attempts", async () => {
    const digest = await seed()
    await Fs.mkdir(NodePath.join(root, "output"))
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(PackageTree.materializeFile(root, ".flows", { path: "output", digest, executable: false })).rejects
        .toThrow()
      expect((await Fs.readdir(root)).filter((name) => name.startsWith("output.smthrs-"))).toEqual([])
    }
  })

  for (const operation of ["copyFile", "chmod"] as const) {
    it(`removes a partial file after failed ${operation} and preserves the error`, async () => {
      const digest = await seed()
      const original = await vi.importActual<typeof Fs>("node:fs/promises")
      const failure = new Error(`injected ${operation} failure`)
      if (operation === "copyFile") {
        vi.mocked(Fs.copyFile).mockImplementationOnce(async (_from, to) => {
          await original.writeFile(to, "partial")
          throw failure
        })
      } else {
        vi.mocked(Fs.chmod).mockRejectedValueOnce(failure)
      }
      await expect(PackageTree.materializeFile(root, ".flows", { path: "output", digest, executable: false })).rejects
        .toBe(failure)
      expect((await Fs.readdir(root)).filter((name) => name.startsWith("output.smthrs-"))).toEqual([])
    })
  }
})

/**
 * A revert removes the bytes the guard judged, and the guard cannot tell a
 * write the body made from one another writer made while the body ran. So a
 * revert never destroys: it first copies what it is about to remove into a
 * quarantine named in the failure.
 */
describe("the write-set guard quarantines what it reverts", () => {
  const git = (...args: ReadonlyArray<string>): void => {
    ChildProcess.execFileSync("git", [...args], { cwd: root, stdio: "ignore" })
  }
  const exists = (path: string): Promise<boolean> => Fs.lstat(path).then(() => true, () => false)
  const commit = (): void => {
    git("add", "-A")
    git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  }

  it("copies a tracked file's, an untracked file's, a link's and a tree's current bytes before restoring", async () => {
    git("init", "--quiet", ".")
    await Fs.writeFile(NodePath.join(root, "user.ts"), "original\n")
    await Fs.writeFile(NodePath.join(root, ".gitignore"), ".flows/\n")
    commit()
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    const quarantine = PackageTree.openQuarantine(root, ".flows", "//pkg:fmt")
    try {
      await Fs.writeFile(NodePath.join(root, "user.ts"), "edited by someone else\n")
      await Fs.mkdir(NodePath.join(root, "notes", "deep"), { recursive: true })
      await Fs.writeFile(NodePath.join(root, "notes", "deep", "a.md"), "a note\n")
      await Fs.writeFile(NodePath.join(root, "new-note.md"), "a new note\n")
      await Fs.symlink("user.ts", NodePath.join(root, "alias"))
      const changed = await PackageTree.changedSinceSnapshot(snapshot, ".flows")
      expect(changed).toEqual(["alias", "new-note.md", "notes/deep/a.md", "user.ts"])
      for (const path of changed) await PackageTree.revertPath(snapshot, path, quarantine)
      expect(await Fs.readFile(NodePath.join(root, "user.ts"), "utf8")).toBe("original\n")
      expect(await exists(NodePath.join(root, "new-note.md"))).toBe(false)
      expect(quarantine.directory).toMatch(/^\.flows\/reverted\/pkg_fmt-/)
      const kept = NodePath.join(root, quarantine.directory)
      expect(await Fs.readFile(NodePath.join(kept, "user.ts"), "utf8")).toBe("edited by someone else\n")
      expect(await Fs.readFile(NodePath.join(kept, "new-note.md"), "utf8")).toBe("a new note\n")
      expect(await Fs.readFile(NodePath.join(kept, "notes", "deep", "a.md"), "utf8")).toBe("a note\n")
      expect(await Fs.readlink(NodePath.join(kept, "alias"))).toBe("user.ts")
      expect([...quarantine.held].sort()).toEqual(changed)
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("copies a directory a body left where a file stood", async () => {
    git("init", "--quiet", ".")
    await Fs.writeFile(NodePath.join(root, "user.ts"), "original\n")
    commit()
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    const quarantine = PackageTree.openQuarantine(root, ".flows", "dir")
    try {
      await Fs.mkdir(NodePath.join(root, "tree", "sub"), { recursive: true })
      await Fs.writeFile(NodePath.join(root, "tree", "sub", "x.txt"), "x")
      await PackageTree.revertPath(snapshot, "tree", quarantine)
      expect(await exists(NodePath.join(root, "tree"))).toBe(false)
      expect(await Fs.readFile(NodePath.join(root, quarantine.directory, "tree", "sub", "x.txt"), "utf8")).toBe("x")
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("copies a gitignored file's current bytes before restoring or removing it", async () => {
    git("init", "--quiet", ".")
    await Fs.writeFile(NodePath.join(root, ".gitignore"), ".env\ndist/\n.flows/\n")
    await Fs.writeFile(NodePath.join(root, ".env"), "secret")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    const quarantine = PackageTree.openQuarantine(root, ".flows", "ignored")
    try {
      await Fs.writeFile(NodePath.join(root, ".env"), "rotated by the developer")
      await Fs.mkdir(NodePath.join(root, "dist"))
      await Fs.writeFile(NodePath.join(root, "dist", "out.js"), "built")
      const changed = await PackageTree.changedIgnored(snapshot, ".flows")
      expect(changed).toEqual([".env", "dist/out.js"])
      for (const path of changed) expect(await PackageTree.revertIgnored(snapshot, path, quarantine)).toBe(true)
      expect(await Fs.readFile(NodePath.join(root, ".env"), "utf8")).toBe("secret")
      const kept = NodePath.join(root, quarantine.directory)
      expect(await Fs.readFile(NodePath.join(kept, ".env"), "utf8")).toBe("rotated by the developer")
      expect(await Fs.readFile(NodePath.join(kept, "dist", "out.js"), "utf8")).toBe("built")
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  it("creates nothing when nothing was reverted, and nothing for a path that is already gone", async () => {
    git("init", "--quiet", ".")
    await Fs.writeFile(NodePath.join(root, "user.ts"), "original\n")
    commit()
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    const quarantine = PackageTree.openQuarantine(root, ".flows", "empty")
    try {
      await Fs.rm(NodePath.join(root, "user.ts"))
      await PackageTree.revertPath(snapshot, "user.ts", quarantine)
      expect(await Fs.readFile(NodePath.join(root, "user.ts"), "utf8")).toBe("original\n")
      expect(quarantine.held).toEqual([])
      expect(await exists(NodePath.join(root, ".flows", "reverted"))).toBe(false)
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })
})

describe("judgedChanges", () => {
  it("keeps only the changes that resolve inside a location the body could write", async () => {
    await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
    await Fs.mkdir(NodePath.join(root, "notes"), { recursive: true })
    await Fs.symlink("../notes", NodePath.join(root, "src", "portal"))
    const changed = ["lib/user.ts", "notes/new.md", "src/out.txt", "srcfoo.txt", "src/portal/x.md"]
    expect(PackageTree.judgedChanges(root, changed, undefined)).toEqual(changed)
    expect(PackageTree.judgedChanges(root, changed, ["src"])).toEqual(["src/out.txt"])
    expect(PackageTree.judgedChanges(root, changed, [""])).toEqual(changed)
    expect(PackageTree.judgedChanges(root, changed, [])).toEqual([])
  })
})
