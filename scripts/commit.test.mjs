import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"

import { fixtureEnv, schemaFixture } from "./migration-fixture.mjs"

const script = resolve(import.meta.dirname, "commit.mjs")
const copyHygiene = (directory) => {
  mkdirSync(join(directory, "scripts"))
  copyFileSync(resolve(import.meta.dirname, "check-tracked-hygiene.mjs"), join(directory, "scripts/check-tracked-hygiene.mjs"))
}
const command = (cwd, bin, args) => spawnSync(bin, args, { cwd, encoding: "utf8", env: fixtureEnv })
const ok = (cwd, bin, args) => {
  const result = command(cwd, bin, args)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
for (const vcs of ["git", "jj"]) {
  test(`${vcs}: commits all contributors, preserves main, ignores secrets, pushes only on request`, () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-commit-test-"))
    const remote = mkdtempSync(join(tmpdir(), "smithers-commit-remote-"))
    try {
      copyHygiene(directory)
      schemaFixture(directory)
      ok(directory, "git", ["init", "-b", "main"])
      ok(directory, "git", ["config", "user.name", "Commit test"])
      ok(directory, "git", ["config", "user.email", "test@example.com"])
      writeFileSync(join(directory, ".gitignore"), ".env\n")
      ok(directory, "git", ["add", ".gitignore", "scripts/check-tracked-hygiene.mjs"])
      ok(directory, "git", ["commit", "-m", "initial"])
      ok(remote, "git", ["init", "--bare", "-b", "main"])
      ok(directory, "git", ["remote", "add", "origin", remote])
      if (vcs === "jj") {
        ok(directory, "jj", ["git", "init", "--colocate"])
        ok(directory, "jj", ["config", "set", "--repo", "user.name", "Commit test"])
        ok(directory, "jj", ["config", "set", "--repo", "user.email", "test@example.com"])
      }
      writeFileSync(join(directory, "first.txt"), "first contributor\n")
      writeFileSync(join(directory, "second.txt"), "second contributor\n")
      writeFileSync(join(directory, ".env"), "ignored test data\n")
      ok(directory, "node", [script, "--message", "test: both contributors"])
      assert.equal(ok(directory, "git", ["log", "main", "-1", "--format=%s"]), "test: both contributors")
      assert.match(ok(directory, "git", ["show", "main:first.txt"]), /first contributor/)
      assert.match(ok(directory, "git", ["show", "main:second.txt"]), /second contributor/)
      assert.equal(ok(directory, "git", ["ls-tree", "--name-only", "main", ".env"]), "")
      assert.equal(ok(remote, "git", ["for-each-ref", "refs/heads/main"]), "")
      const before = ok(directory, "git", ["rev-parse", "main"])
      ok(directory, "node", [script, "--push"])
      assert.equal(ok(remote, "git", ["rev-parse", "main"]), before)
      assert.equal(ok(directory, "git", ["rev-parse", "main"]), before)
      assert.equal(readFileSync(join(directory, ".env"), "utf8"), "ignored test data\n")
      if (vcs === "jj") {
        ok(directory, "jj", ["new"])
        writeFileSync(join(directory, "third.txt"), "unlanded lineage\n")
        const refused = command(directory, "node", [script])
        assert.notEqual(refused.status, 0)
        assert.match(refused.stderr, /must be on main/)
        assert.equal(ok(directory, "git", ["rev-parse", "main"]), before)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
      rmSync(remote, { recursive: true, force: true })
    }
  })
  for (const finding of ["scaffold", "dangling", "untracked", "deleted"]) {
    test(`${vcs}: ${finding} hygiene failure prevents commit and requested push`, () => {
      const directory = mkdtempSync(join(tmpdir(), "smithers-commit-hygiene-test-"))
      const remote = mkdtempSync(join(tmpdir(), "smithers-commit-hygiene-remote-"))
      try {
        copyHygiene(directory)
        ok(directory, "git", ["init", "-b", "main"])
        ok(directory, "git", ["config", "user.name", "Commit test"])
        ok(directory, "git", ["config", "user.email", "test@example.com"])
        writeFileSync(join(directory, "PACKAGE.ts"), "const target = { paths: ['source.ts'] }\n")
        writeFileSync(join(directory, "source.ts"), "export const value = 1\n")
        ok(directory, "git", ["add", "."])
        ok(directory, "git", ["commit", "-m", "initial"])
        ok(remote, "git", ["init", "--bare", "-b", "main"])
        ok(directory, "git", ["remote", "add", "origin", remote])
        ok(directory, "git", ["push", "origin", "main"])
        if (vcs === "jj") {
          ok(directory, "jj", ["git", "init", "--colocate"])
          ok(directory, "jj", ["config", "set", "--repo", "user.name", "Commit test"])
          ok(directory, "jj", ["config", "set", "--repo", "user.email", "test@example.com"])
        }
        if (finding === "deleted") {
          rmSync(join(directory, "source.ts"))
        } else if (finding === "untracked") {
          writeFileSync(join(directory, "fresh.ts"), `export const path = 'scratchpad/${"lanes"}/a'\n`)
        } else if (finding === "scaffold") {
          writeFileSync(join(directory, "source.ts"), `export const path = 'scratchpad/${"lanes"}/a'\n`)
        } else {
          writeFileSync(join(directory, "PACKAGE.ts"), "const target = { paths: ['deleted.ts'] }\n")
        }
        const before = ok(directory, "git", ["rev-parse", "main"])
        const stagedBefore = ok(directory, "git", ["diff", "--cached"])
        const parentBefore = vcs === "jj" ? ok(directory, "jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]) : null
        const refused = command(directory, process.execPath, [script, "--message", "must not commit", "--push"])
        assert.notEqual(refused.status, 0)
        assert.match(refused.stderr, finding === "deleted"
          ? /PACKAGE\.ts:1: dangling: paths names "source\.ts", which no tracked file matches/
          : finding === "dangling"
          ? /PACKAGE\.ts:1: dangling: paths names "deleted\.ts", which no tracked file matches/
          : finding === "untracked" ? /fresh\.ts:1: scaffold: lane scaffolding/ : /source\.ts:1: scaffold: lane scaffolding/)
        assert.match(refused.stderr, /tracked hygiene: 1 finding\(s\)/)
        assert.equal(ok(directory, "git", ["rev-parse", "main"]), before)
        assert.equal(ok(remote, "git", ["rev-parse", "main"]), before)
        assert.equal(ok(directory, "git", ["diff", "--cached"]), stagedBefore)
        if (vcs === "jj") {
          assert.equal(ok(directory, "jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]), parentBefore)
        }
        // A subsequent clean invocation proves the failed preflight released its lock.
        writeFileSync(join(directory, "PACKAGE.ts"), "const target = { paths: ['source.ts'] }\n")
        writeFileSync(join(directory, "source.ts"), "export const value = 1\n")
        if (finding === "untracked") rmSync(join(directory, "fresh.ts"))
        ok(directory, process.execPath, [script])
        assert.equal(ok(directory, "git", ["rev-parse", "main"]), before)
      } finally {
        rmSync(directory, { recursive: true, force: true })
        rmSync(remote, { recursive: true, force: true })
      }
    })
  }
}
