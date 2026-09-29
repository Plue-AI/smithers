import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { normalizeArgv } from "../src/Cli.ts"
import * as GitHooks from "../src/GitHooks.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

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

const forceSpec = NodePath.resolve(import.meta.dirname, "fixtures/force-spec")
const goldenRoot = NodePath.resolve(import.meta.dirname, "fixtures/git-hooks")

const openIndex = async (): Promise<PackageIndex> => {
  const discovery = await PackageDiscovery.discover(forceSpec)
  const loaded = await PackageLoader.load(discovery)
  return PackageIndex.make(loaded)
}

const temporaryRoot = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-git-hooks-"))))

/** Runs one rendered hook script under a controlled PATH. */
const runScript = (script: string, path: string): Promise<{
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      script,
      [],
      { env: { PATH: path } },
      (error, stdout, stderr) => {
        const exitCode = error === null
          ? 0
          : typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 1
        resolve({ exitCode, stdout, stderr })
      }
    )
  })

describe("resolveHookLabels", () => {
  it("resolves the force-spec workspace bindings to root labels", async () => {
    const index = await openIndex()
    const bindings = GitHooks.resolveHookLabels(index.workspace, index)
    expect(bindings).toEqual({
      preCommit: "//:preCommit",
      postCommit: "//:postCommit",
      prePush: "//:prePush",
      postMerge: "//:postMerge"
    })
  })

  it("returns no bindings for a workspace without gitHooks", async () => {
    const index = await openIndex()
    const bare = { ...index.workspace, gitHooks: undefined }
    expect(GitHooks.resolveHookLabels(bare, index)).toEqual({})
  })

  it("refuses a bound hook target no Package map lists", async () => {
    const index = await openIndex()
    try {
      GitHooks.resolveHookLabels(index.workspace, { labelOf: () => undefined })
      throw new Error("expected a GitHooksError")
    } catch (cause) {
      if (!GitHooks.isGitHooksError(cause)) throw cause
      expect(cause.code).toBe("unlabeled_hook_target")
      expect(cause.message).toContain("preCommit")
    }
  })
})

describe("render goldens", () => {
  it("renders the exact golden script set from the force-spec bindings", async () => {
    const index = await openIndex()
    const rendered = GitHooks.render(GitHooks.resolveHookLabels(index.workspace, index))
    expect(rendered.map((hook) => hook.file)).toEqual(["pre-commit", "post-commit", "pre-push", "post-merge"])
    for (const hook of rendered) {
      const goldenPath = NodePath.join(goldenRoot, hook.file)
      if (process.env["UPDATE_GOLDENS"] === "1") {
        await Fs.mkdir(NodePath.dirname(goldenPath), { recursive: true })
        await Fs.writeFile(goldenPath, hook.content, "utf8")
      }
      const golden = await Fs.readFile(goldenPath, "utf8")
      expect(hook.content, hook.file).toBe(golden)
    }
  })

  it("is byte-stable across two renders", async () => {
    const index = await openIndex()
    const bindings = GitHooks.resolveHookLabels(index.workspace, index)
    expect(GitHooks.render(bindings)).toEqual(GitHooks.render(bindings))
  })

  it("skips unbound hooks and keeps the fixed order", () => {
    const rendered = GitHooks.render({ prePush: "//:prePush", preCommit: "//:preCommit" })
    expect(rendered.map((hook) => hook.file)).toEqual(["pre-commit", "pre-push"])
  })

  it("refuses a label the one-shell-word grammar cannot carry", () => {
    try {
      GitHooks.render({ preCommit: "//:pre'Commit" })
      throw new Error("expected a GitHooksError")
    } catch (cause) {
      if (!GitHooks.isGitHooksError(cause)) throw cause
      expect(cause.code).toBe("invalid_label")
    }
  })
})

describe("script behavior", () => {
  it("fails open with a warning when both public and legacy CLIs are absent", async () => {
    const root = await temporaryRoot()
    const [hook] = GitHooks.render({ preCommit: "//:preCommit" })
    const script = NodePath.join(root, hook!.file)
    await Fs.writeFile(script, hook!.content, { encoding: "utf8", mode: 0o755 })
    const empty = NodePath.join(root, "empty-path")
    await Fs.mkdir(empty)
    const result = await runScript(script, empty)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("smthrs: CLI not found on PATH")
    expect(result.stderr).toContain("fail-open")
  })

  it("prefers the public bare-label command and propagates its failure", async () => {
    const root = await temporaryRoot()
    const [hook] = GitHooks.render({ prePush: "//:prePush" })
    const script = NodePath.join(root, hook!.file)
    await Fs.writeFile(script, hook!.content, { encoding: "utf8", mode: 0o755 })
    const bin = NodePath.join(root, "bin")
    await Fs.mkdir(bin)
    const log = NodePath.join(root, "argv.log")
    await Fs.writeFile(
      NodePath.join(bin, "smthrs"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nexit 7\n`,
      { encoding: "utf8", mode: 0o755 }
    )
    await Fs.writeFile(
      NodePath.join(bin, "smithers-build"),
      "#!/bin/sh\nexit 23\n",
      { encoding: "utf8", mode: 0o755 }
    )
    const result = await runScript(script, bin)
    expect(result.exitCode).toBe(7)
    const argv = (await Fs.readFile(log, "utf8")).split("\n").filter((line) => line !== "")
    expect(argv).toEqual(["//:prePush"])
    // The bare-label form runs the label's flavor-implied verb; `run` would refuse a lint or test target.
    expect(normalizeArgv(argv)).toEqual(["target", "//:prePush"])
  })

  it("falls back to the legacy CLI when the public CLI is absent", async () => {
    const root = await temporaryRoot()
    const [hook] = GitHooks.render({ prePush: "//:prePush" })
    const script = NodePath.join(root, hook!.file)
    await Fs.writeFile(script, hook!.content, { encoding: "utf8", mode: 0o755 })
    const bin = NodePath.join(root, "bin")
    await Fs.mkdir(bin)
    const log = NodePath.join(root, "argv.log")
    await Fs.writeFile(
      NodePath.join(bin, "smithers-build"),
      `#!/bin/sh\nprintf '%s' "$1" > '${log}'\n`,
      { encoding: "utf8", mode: 0o755 }
    )
    const result = await runScript(script, bin)
    expect(result.exitCode).toBe(0)
    expect(await Fs.readFile(log, "utf8")).toBe("//:prePush")
  })
})

describe("check and install", () => {
  it("reports missing before install, clean after, stale on drift", async () => {
    const root = await temporaryRoot()
    NodeChildProcess.execFileSync("git", ["init", "-q", root])
    const rendered = GitHooks.render({ preCommit: "//:preCommit", postMerge: "//:postMerge" })
    const before = await GitHooks.check(root, rendered)
    expect(before.clean).toBe(false)
    expect(before.entries.every((entry) => entry.status === "missing")).toBe(true)
    const installed = await GitHooks.install(root, rendered)
    expect(installed.wrote).toEqual(["pre-commit", "post-merge"])
    const after = await GitHooks.check(root, rendered)
    expect(after.clean).toBe(true)
    const stats = await Fs.stat(NodePath.join(root, ".git", "hooks", "pre-commit"))
    expect(stats.mode & 0o111).not.toBe(0)
    await Fs.appendFile(NodePath.join(root, ".git", "hooks", "pre-commit"), "# manual edit\n", "utf8")
    const drifted = await GitHooks.check(root, rendered)
    expect(drifted.clean).toBe(false)
    expect(drifted.entries).toContainEqual({ file: "pre-commit", status: "stale" })
    await GitHooks.install(root, rendered)
    expect((await GitHooks.check(root, rendered)).clean).toBe(true)
  })

  it("installs into the shared hooks directory from a linked worktree", async () => {
    const root = await temporaryRoot()
    const repository = NodePath.join(root, "repository")
    const worktree = NodePath.join(root, "worktree")
    NodeChildProcess.execFileSync("git", ["init", "-q", repository])
    NodeChildProcess.execFileSync("git", [
      "-C",
      repository,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-qm",
      "init"
    ])
    NodeChildProcess.execFileSync("git", ["-C", repository, "worktree", "add", "--detach", worktree])
    expect((await Fs.stat(NodePath.join(worktree, ".git"))).isFile()).toBe(true)
    const rendered = GitHooks.render({ preCommit: "//:preCommit" })
    expect((await GitHooks.check(worktree, rendered)).clean).toBe(false)
    await GitHooks.install(worktree, rendered)
    expect(await Fs.readFile(NodePath.join(repository, ".git", "hooks", "pre-commit"), "utf8"))
      .toBe(rendered[0]!.content)
    expect((await GitHooks.check(worktree, rendered)).clean).toBe(true)
    await Fs.appendFile(NodePath.join(repository, ".git", "hooks", "pre-commit"), "# drift\n")
    expect((await GitHooks.check(worktree, rendered)).entries)
      .toEqual([{ file: "pre-commit", status: "stale" }])
  })

  it.each(["relative", "absolute"])("honors a %s core.hooksPath for install and check", async (kind) => {
    const root = await temporaryRoot()
    NodeChildProcess.execFileSync("git", ["init", "-q", root])
    const hooksDirectory = NodePath.join(root, "custom hooks")
    NodeChildProcess.execFileSync("git", [
      "-C",
      root,
      "config",
      "core.hooksPath",
      kind === "relative" ? "custom hooks" : hooksDirectory
    ])
    const rendered = GitHooks.render({ preCommit: "//:preCommit" })
    // A matching file in the default directory must not conceal a missing active hook.
    await Fs.writeFile(NodePath.join(root, ".git", "hooks", "pre-commit"), rendered[0]!.content)
    expect((await GitHooks.check(root, rendered)).entries)
      .toEqual([{ file: "pre-commit", status: "missing" }])
    await GitHooks.install(root, rendered)
    expect(await Fs.readFile(NodePath.join(hooksDirectory, "pre-commit"), "utf8"))
      .toBe(rendered[0]!.content)
    expect((await Fs.stat(NodePath.join(hooksDirectory, "pre-commit"))).mode & 0o111).not.toBe(0)
    expect((await GitHooks.check(root, rendered)).clean).toBe(true)
    await Fs.appendFile(NodePath.join(hooksDirectory, "pre-commit"), "# drift\n")
    expect((await GitHooks.check(root, rendered)).entries)
      .toEqual([{ file: "pre-commit", status: "stale" }])
  })

  it("refuses a core.hooksPath outside the repository and leaves it untouched", async () => {
    const root = await temporaryRoot()
    const repository = NodePath.join(root, "repository")
    const shared = NodePath.join(root, "global-hooks")
    NodeChildProcess.execFileSync("git", ["init", "-q", repository])
    NodeChildProcess.execFileSync("git", ["-C", repository, "config", "core.hooksPath", shared])
    await Fs.mkdir(shared)
    await Fs.writeFile(NodePath.join(shared, "pre-commit"), "#!/bin/sh\ngit secrets --scan\n", { mode: 0o755 })
    const rendered = GitHooks.render({ preCommit: "//:preCommit" })
    await expect(GitHooks.install(repository, rendered)).rejects.toMatchObject({
      name: "GitHooksError",
      code: "hooks_path_outside_repository"
    })
    await expect(GitHooks.check(repository, rendered)).rejects.toMatchObject({
      code: "hooks_path_outside_repository"
    })
    expect(await Fs.readFile(NodePath.join(shared, "pre-commit"), "utf8")).toBe("#!/bin/sh\ngit secrets --scan\n")
  })

  it.each(["install", "check"] as const)("%s refuses a repository link to external hooks", async (action) => {
    const root = await temporaryRoot()
    const repository = NodePath.join(root, "repository")
    const external = NodePath.join(root, "external-hooks")
    NodeChildProcess.execFileSync("git", ["init", "-q", repository])
    await Fs.mkdir(external)
    const hook = NodePath.join(external, "pre-commit")
    await Fs.writeFile(hook, "#!/bin/sh\necho external\n", { mode: 0o755 })
    await Fs.symlink(external, NodePath.join(repository, "linked-hooks"), "dir")
    NodeChildProcess.execFileSync("git", ["-C", repository, "config", "core.hooksPath", "linked-hooks"])
    const beforeEntries = await Fs.readdir(external)
    const beforeBytes = await Fs.readFile(hook)
    const rendered = GitHooks.render({ preCommit: "//:preCommit" })

    const [result] = await Promise.allSettled([GitHooks[action](repository, rendered)])
    expect(await Fs.readdir(external)).toEqual(beforeEntries)
    expect(await Fs.readFile(hook)).toEqual(beforeBytes)
    expect(result).toMatchObject({
      status: "rejected",
      reason: { code: "hooks_path_outside_repository" }
    })
  })

  it.each(["install", "check"] as const)("%s refuses a missing descendant under an external link", async (action) => {
    const root = await temporaryRoot()
    const repository = NodePath.join(root, "repository")
    const external = NodePath.join(root, "external-hooks")
    NodeChildProcess.execFileSync("git", ["init", "-q", repository])
    await Fs.mkdir(external)
    const sentinel = NodePath.join(external, "sentinel")
    await Fs.writeFile(sentinel, "external data\n")
    await Fs.symlink(external, NodePath.join(repository, "linked-hooks"), "dir")
    NodeChildProcess.execFileSync("git", [
      "-C",
      repository,
      "config",
      "core.hooksPath",
      "linked-hooks/not-created/hooks"
    ])
    const beforeEntries = await Fs.readdir(external)
    const beforeBytes = await Fs.readFile(sentinel)
    const rendered = GitHooks.render({ preCommit: "//:preCommit" })

    const [result] = await Promise.allSettled([GitHooks[action](repository, rendered)])
    expect(await Fs.readdir(external)).toEqual(beforeEntries)
    expect(await Fs.readFile(sentinel)).toEqual(beforeBytes)
    expect(result).toMatchObject({
      status: "rejected",
      reason: { code: "hooks_path_outside_repository" }
    })
  })

  it("allows a hooks directory linked within the repository", async () => {
    const root = await temporaryRoot()
    NodeChildProcess.execFileSync("git", ["init", "-q", root])
    const hooksDirectory = NodePath.join(root, "internal-hooks")
    await Fs.mkdir(hooksDirectory)
    await Fs.symlink(hooksDirectory, NodePath.join(root, "linked-hooks"), "dir")
    NodeChildProcess.execFileSync("git", ["-C", root, "config", "core.hooksPath", "linked-hooks"])
    const rendered = GitHooks.render({ preCommit: "//:preCommit" })
    expect((await GitHooks.check(root, rendered)).entries).toEqual([{ file: "pre-commit", status: "missing" }])
    expect((await GitHooks.install(root, rendered)).wrote).toEqual(["pre-commit"])
    expect(await Fs.readFile(NodePath.join(hooksDirectory, "pre-commit"), "utf8")).toBe(rendered[0]!.content)
    expect((await GitHooks.check(root, rendered)).clean).toBe(true)
  })

  it("accepts a symlink alias for the canonical repository root", async () => {
    const root = await temporaryRoot()
    const repository = NodePath.join(root, "repository")
    const alias = NodePath.join(root, "alias")
    NodeChildProcess.execFileSync("git", ["init", "-q", repository])
    await Fs.symlink(repository, alias, "dir")
    const rendered = GitHooks.render({ preCommit: "//:preCommit" })
    expect((await GitHooks.check(alias, rendered)).entries).toEqual([{ file: "pre-commit", status: "missing" }])
    expect((await GitHooks.install(alias, rendered)).wrote).toEqual(["pre-commit"])
    expect(await Fs.readFile(NodePath.join(repository, ".git", "hooks", "pre-commit"), "utf8"))
      .toBe(rendered[0]!.content)
    expect((await GitHooks.check(alias, rendered)).clean).toBe(true)
  })

  it("keeps a hand-written hook as a .bak before replacing it", async () => {
    const root = await temporaryRoot()
    NodeChildProcess.execFileSync("git", ["init", "-q", root])
    const hook = NodePath.join(root, ".git", "hooks", "pre-commit")
    await Fs.mkdir(NodePath.dirname(hook), { recursive: true })
    await Fs.writeFile(hook, "#!/bin/sh\necho mine\n", { mode: 0o755 })
    const rendered = GitHooks.render({ preCommit: "//:preCommit" })
    await GitHooks.install(root, rendered)
    expect(await Fs.readFile(`${hook}.bak`, "utf8")).toBe("#!/bin/sh\necho mine\n")
    expect(await Fs.readFile(hook, "utf8")).toBe(rendered[0]!.content)
    await Fs.rm(`${hook}.bak`)
    await GitHooks.install(root, rendered)
    await expect(Fs.stat(`${hook}.bak`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("falls back to .git/hooks only when git is unavailable", async () => {
    const root = await temporaryRoot()
    await Fs.mkdir(NodePath.join(root, ".git"))
    const emptyPath = NodePath.join(root, "empty-path")
    await Fs.mkdir(emptyPath)
    const rendered = GitHooks.render({ preCommit: "//:preCommit" })
    vi.stubEnv("PATH", emptyPath)
    try {
      expect((await GitHooks.check(root, rendered)).clean).toBe(false)
      await GitHooks.install(root, rendered)
      expect(await Fs.readFile(NodePath.join(root, ".git", "hooks", "pre-commit"), "utf8"))
        .toBe(rendered[0]!.content)
      expect((await GitHooks.check(root, rendered)).clean).toBe(true)
      await expect(GitHooks.install(emptyPath, rendered)).rejects.toMatchObject({
        name: "GitHooksError",
        code: "not_a_git_repository"
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("does not fall back when git rejects an invalid .git directory", async () => {
    const root = await temporaryRoot()
    await Fs.mkdir(NodePath.join(root, ".git"))
    const rendered = GitHooks.render({ preCommit: "//:preCommit" })
    await expect(GitHooks.install(root, rendered)).rejects.toMatchObject({
      name: "GitHooksError",
      code: "not_a_git_repository"
    })
    await expect(GitHooks.check(root, rendered)).rejects.toMatchObject({
      name: "GitHooksError",
      code: "not_a_git_repository"
    })
    await expect(Fs.stat(NodePath.join(root, ".git", "hooks"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses to install outside a git repository", async () => {
    const root = await temporaryRoot()
    const rendered = GitHooks.render({ preCommit: "//:preCommit" })
    await expect(GitHooks.install(root, rendered)).rejects.toMatchObject({
      name: "GitHooksError",
      code: "not_a_git_repository"
    })
  })
})

describe("bindings against the target objects the index labels", () => {
  it("binds through the same target identity a Package map lists", async () => {
    const index = await openIndex()
    const workspace = index.workspace
    const bound = workspace.gitHooks?.preCommit
    expect(bound).toBeDefined()
    const [row] = index.resolve("//:preCommit")
    expect(row!.target).toBe(bound)
  })
})

describe("hooks directory resolution failures", () => {
  it.each(["install", "check"] as const)("%s refuses external fallback hooks without Git", async (action) => {
    const root = await temporaryRoot()
    const repository = NodePath.join(root, "repository")
    const external = NodePath.join(root, "external")
    await Fs.mkdir(NodePath.join(repository, ".git"), { recursive: true })
    await Fs.mkdir(external)
    await Fs.writeFile(NodePath.join(external, "pre-commit"), "external hook\n")
    await Fs.symlink(external, NodePath.join(repository, ".git", "hooks"), "dir")
    vi.stubEnv("PATH", repository)
    try {
      await expect(GitHooks[action](repository, GitHooks.render({ preCommit: "//:preCommit" })))
        .rejects.toMatchObject({ code: "hooks_path_outside_repository" })
      expect(await Fs.readdir(external)).toEqual(["pre-commit"])
      expect(await Fs.readFile(NodePath.join(external, "pre-commit"), "utf8")).toBe("external hook\n")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each(["linked-hooks", "linked-hooks/missing/hooks"])(
    "refuses a dangling %s without creating its target",
    async (hooksPath) => {
      const root = await temporaryRoot()
      const repository = NodePath.join(root, "repository")
      const external = NodePath.join(root, "missing-external")
      NodeChildProcess.execFileSync("git", ["init", "-q", repository])
      await Fs.symlink(external, NodePath.join(repository, "linked-hooks"), "dir")
      NodeChildProcess.execFileSync("git", ["-C", repository, "config", "core.hooksPath", hooksPath])
      const rendered = GitHooks.render({ preCommit: "//:preCommit" })
      for (const action of ["install", "check"] as const) {
        await expect(GitHooks[action](repository, rendered)).rejects.toMatchObject({ code: "not_a_git_repository" })
      }
      await expect(Fs.lstat(external)).rejects.toMatchObject({ code: "ENOENT" })
      expect((await Fs.lstat(NodePath.join(repository, "linked-hooks"))).isSymbolicLink()).toBe(true)
    }
  )
})
