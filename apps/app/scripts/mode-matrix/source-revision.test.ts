import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "../test-child"
import { sourceRevision } from "./source-revision"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const jj = (root: string, ...args: string[]): string => {
  const result = spawnSync("jj", args, { cwd: root })
  if (result.status !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

test("packaged source revision follows content across jj's empty post-push working copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-matrix-revision-"))
  roots.push(root)
  jj(root, "git", "init", "--colocate")
  writeFileSync(join(root, "README"), "landed content\n")
  jj(root, "describe", "-m", "landed")
  const landed = jj(root, "log", "-r", "@", "--no-graph", "-T", "commit_id")
  jj(root, "new")
  expect(await sourceRevision(root)).toBe(landed)

  writeFileSync(join(root, "README"), "edited content\n")
  const edited = jj(root, "log", "-r", "@", "--no-graph", "-T", "commit_id")
  expect(edited).not.toBe(landed)
  expect(await sourceRevision(root)).toBe(edited)
// Several real jj processes initialize and snapshot a repository; this is not a 5 s latency contract.
}, 30_000)

const git = (root: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd: root })
  if (result.status !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

const withGitOnlyEnvironment = async (run: () => Promise<void>): Promise<void> => {
  const previousPath = process.env.PATH
  const previousConfig = process.env.GIT_CONFIG_GLOBAL
  const previousSystemConfig = process.env.GIT_CONFIG_NOSYSTEM
  // Exercise the Git fallback without discovering an installed jj or user hooks/signing.
  process.env.PATH = "/usr/bin:/bin"
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  try {
    await run()
  } finally {
    for (const [key, value] of [["PATH", previousPath], ["GIT_CONFIG_GLOBAL", previousConfig], ["GIT_CONFIG_NOSYSTEM", previousSystemConfig]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("Git-only source revision refuses staged and unstaged edits", () => withGitOnlyEnvironment(async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-matrix-git-revision-"))
  roots.push(root)
  git(root, "init")
  const file = join(root, "product.ts")
  writeFileSync(file, "export const product = 1\n")
  git(root, "add", "product.ts")
  git(root, "-c", "user.name=Matrix Test", "-c", "user.email=matrix@example.test", "commit", "-m", "initial")
  const head = git(root, "rev-parse", "HEAD")
  expect(await sourceRevision(root)).toBe(head)

  writeFileSync(file, "export const product = 2\n")
  expect(git(root, "status", "--porcelain")).toContain("product.ts")
  await expect(sourceRevision(root)).rejects.toThrow("cannot identify the exact source revision")

  git(root, "add", "product.ts")
  expect(git(root, "status", "--porcelain")).toContain("product.ts")
  await expect(sourceRevision(root)).rejects.toThrow("cannot identify the exact source revision")

  git(root, "restore", "--staged", "product.ts")
  writeFileSync(file, "export const product = 1\n")
  expect(git(root, "status", "--porcelain")).toBe("")
  expect(await sourceRevision(root)).toBe(head)
}), 30_000)
