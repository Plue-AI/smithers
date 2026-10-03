/**
 * The in-container tree measurement: what the script skips, what its output
 * means, and the three answers two measurements can give.
 *
 * The script itself is exercised against a real shell once here, because
 * every guarantee it makes is about POSIX tools and not about TypeScript: a
 * change to `find`'s prune group or `stat`'s format is invisible to a unit
 * test of the string.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as TreeFingerprint from "../src/TreeFingerprint.ts"
import * as WorkspaceLists from "../src/TreeFingerprint.ts"

/** Runs the measurement script in `cwd` with the host's `sh`, the way a container would. */
const measure = (cwd: string): TreeFingerprint.Measurement | undefined => {
  const result = spawnSync("sh", ["-c", TreeFingerprint.script()], { cwd, encoding: "utf8" })
  return result.status === 0 ? TreeFingerprint.parse(result.stdout) : undefined
}

const write = (root: string, path: string, text: string, at?: number): void => {
  mkdirSync(join(root, path, ".."), { recursive: true })
  writeFileSync(join(root, path), text)
  if (at !== undefined) utimesSync(join(root, path), at, at)
}

/** `stat -c` is GNU and busybox; BSD `stat` on this host has no `-c`, so the live cases run where `find`+`stat -c` do. */
const hostCanMeasure = spawnSync("sh", ["-c", "stat -c '%s %Y %n' . >/dev/null 2>&1"]).status === 0

describe("TreeFingerprint.script", () => {
  it("prunes every directory and suffix the host walk prunes", () => {
    const script = TreeFingerprint.script()
    for (const name of WorkspaceLists.defaultPrune) expect(script).toContain(`-name '${name}'`)
    for (const suffix of WorkspaceLists.defaultIgnoreSuffixes) expect(script).toContain(`! -name '*${suffix}'`)
    expect(script).toContain(`head -n ${TreeFingerprint.maxPaths + 1}`)
    expect(script).toContain("cksum")
  })

  it("names the prune list under a custom set, single-quoted", () => {
    expect(TreeFingerprint.script({ prune: ["it's"], ignoreSuffixes: [] })).toContain(`-name 'it'\\''s'`)
  })

  it.skipIf(!hostCanMeasure)("moves for a write, holds still for a re-read, and ignores derived output", () => {
    const root = mkdtempSync(join(tmpdir(), "tree-fingerprint-"))
    try {
      write(root, "src/a.py", "one", 1_700_000_000)
      const first = measure(root)
      expect(first).toMatchObject({ paths: 1, complete: true })
      expect(measure(root)).toEqual(first)

      write(root, "__pycache__/a.cpython-39.pyc", "bytecode")
      write(root, "src/a.so", "compiled")
      write(root, ".git/index", "index")
      expect(measure(root)).toEqual(first)

      write(root, "src/a.py", "one, changed", 1_700_000_000)
      const changed = measure(root)
      expect(changed?.digest).not.toBe(first?.digest)
      expect(TreeFingerprint.moved(first, changed)).toBe(true)
      expect(TreeFingerprint.moved(first, first)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("TreeFingerprint.parse", () => {
  it("reads the checksum and the count", () => {
    expect(TreeFingerprint.parse("4038471504 22\n3\n")).toEqual({ digest: "4038471504:22", paths: 3, complete: true })
  })

  it("reads an empty tree as measured", () => {
    expect(TreeFingerprint.parse("4294967295 0\n0\n")).toEqual({ digest: "4294967295:0", paths: 0, complete: true })
  })

  it("marks a listing that reached the bound as partial", () => {
    expect(TreeFingerprint.parse(`1 2\n${TreeFingerprint.maxPaths + 1}\n`)).toEqual({
      digest: "1:2",
      paths: TreeFingerprint.maxPaths,
      complete: false
    })
  })

  it("accepts the exact path bound and ignores surrounding whitespace", () => {
    expect(TreeFingerprint.parse(`  1 2  \n  ${TreeFingerprint.maxPaths}  \n`)).toEqual({
      digest: "1:2",
      paths: TreeFingerprint.maxPaths,
      complete: true
    })
    expect(TreeFingerprint.parse("bad checksum\n3")).toBeUndefined()
    expect(TreeFingerprint.parse("1 2\n3\nextra")).toBeUndefined()
  })

  it("reads anything else as unmeasured", () => {
    expect(TreeFingerprint.parse("")).toBeUndefined()
    expect(TreeFingerprint.parse("sh: find: not found\n")).toBeUndefined()
    expect(TreeFingerprint.parse("1 2\n")).toBeUndefined()
    expect(TreeFingerprint.parse("1 2\nthree\n")).toBeUndefined()
  })
})

describe("TreeFingerprint.moved", () => {
  const whole = (digest: string): TreeFingerprint.Measurement => ({ digest, paths: 2, complete: true })
  const partial = (digest: string): TreeFingerprint.Measurement => ({ digest, paths: 2, complete: false })

  it("answers only from two complete measurements", () => {
    expect(TreeFingerprint.moved(whole("a"), whole("b"))).toBe(true)
    expect(TreeFingerprint.moved(whole("a"), whole("a"))).toBe(false)
    // A prefix that held still, or that moved, says nothing about the tree.
    expect(TreeFingerprint.moved(partial("a"), whole("a"))).toBeUndefined()
    expect(TreeFingerprint.moved(whole("a"), partial("b"))).toBeUndefined()
    expect(TreeFingerprint.moved(undefined, whole("a"))).toBeUndefined()
    expect(TreeFingerprint.moved(whole("a"), undefined)).toBeUndefined()
  })
})
