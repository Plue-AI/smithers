import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sourceRevision } from "./source-revision"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const jj = (root: string, ...args: string[]): string => {
  const result = Bun.spawnSync(["jj", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
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
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

test("Git-only source revision refuses staged and unstaged edits", async () => {
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
}, 30_000)
