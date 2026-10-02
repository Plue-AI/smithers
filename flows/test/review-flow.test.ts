import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

test("review body instructs jj diff that yields output in a jj repo", async (t) => {
  const body = await readFile(new URL("../review/flow.ts", import.meta.url), "utf8")
  assert.match(body, /Flow\.make\("review"/)
  const reader = await readFile(new URL("../review/src/git/loadDiffs.ts", import.meta.url), "utf8")
  assert.match(reader, /"jj", \["diff", "--git"/)

  const parent = await mkdtemp(join(tmpdir(), "smithers-1884-"))
  const repo = join(parent, "repo")
  t.after(() => rm(parent, { recursive: true, force: true }))

  execFileSync("jj", ["git", "init", "--colocate", repo], { stdio: "pipe" })
  await writeFile(join(repo, "changed.txt"), "review this change\n")
  const diff = execFileSync("jj", ["diff", "--git"], { cwd: repo, encoding: "utf8" })
  assert.match(diff, /diff --git/)
})
