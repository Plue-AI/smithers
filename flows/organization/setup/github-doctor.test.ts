/**
 * `doctor`'s GitHub lines: a repository that opens pull requests or takes in
 * issues needs a token GitHub accepts with push permission, and a remote
 * that takes a push; each missing piece is one failing line with its fix.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { startGitHubFixture } from "../testing/github-fixture.mjs"
import { githubLines } from "./doctor.ts"
import { init } from "./init.ts"
import { loadOrganization } from "./settings.ts"

const scratch = mkdtempSync(join(tmpdir(), "org-github-doctor-"))
const fixtures: Array<{ close: () => Promise<unknown> }> = []
after(async () => {
  for (const fixture of fixtures) await fixture.close()
  rmSync(scratch, { recursive: true, force: true })
})

const git = (...args: ReadonlyArray<string>) => spawnSync("git", args, { encoding: "utf8" })

let made = 0
const setup = async (entry: string) => {
  const root = join(scratch, `wiki-${++made}`)
  await init({ dir: root, stateDir: `${root}-state`, appName: "Smithers Org" })
  const page = join(root, "Org/Organization.md")
  writeFileSync(page, readFileSync(page, "utf8").replace(/^wiki:$/m, `repositories:\n  example/demo: ${entry}\nwiki:`))
  const repo = join(scratch, `repo-${made}`)
  const bare = `${repo}.git`
  git("init", "-q", "-b", "main", repo)
  git("-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init")
  git("init", "-q", "--bare", bare)
  git("-C", repo, "remote", "add", "origin", bare)
  return { organization: await loadOrganization(root), repo }
}

test("a repository that opens pull requests passes with a pushable token and remote", async () => {
  const fixture = await startGitHubFixture("example/demo")
  fixtures.push(fixture)
  const { organization, repo } = await setup("{ landing: pr, issues: {} }")
  const env = { SMITHERS_GITHUB_API_BASE_URL: fixture.apiBaseUrl, SMITHERS_GITHUB_TOKEN: "t", SMITHERS_ORG_GITHUB_GH: "off" }
  assert.deepEqual(await githubLines([`example/demo=${repo}`], scratch, organization, env), [
    { name: "github", status: "pass", detail: "example/demo: push and pull requests via origin; issue intake" }
  ])
  // Nothing was pushed by the dry run.
  assert.equal(git("-C", `${repo}.git`, "for-each-ref").stdout, "")
})

test("each missing piece is a failing line with its fix", async () => {
  const fixture = await startGitHubFixture("example/demo")
  fixtures.push(fixture)
  const { organization, repo } = await setup("{ landing: pr }")
  const env = { SMITHERS_GITHUB_API_BASE_URL: fixture.apiBaseUrl, SMITHERS_ORG_GITHUB_GH: "off" }
  const [token] = await githubLines([`example/demo=${repo}`], scratch, organization, env)
  assert.equal(token!.status, "fail")
  assert.equal(token!.fix, "gh auth login, or set SMITHERS_GITHUB_TOKEN in the .env file")

  fixture.state.repository.permissions.push = false
  const [permission] = await githubLines([`example/demo=${repo}`], scratch, organization, { ...env, SMITHERS_GITHUB_TOKEN: "t" })
  assert.equal(permission!.detail, "example/demo: the token may not push or open pull requests")

  fixture.state.repository.permissions.push = true
  git("-C", repo, "remote", "set-url", "origin", join(scratch, "missing.git"))
  const [remote] = await githubLines([`example/demo=${repo}`], scratch, organization, { ...env, SMITHERS_GITHUB_TOKEN: "t" })
  assert.equal(remote!.status, "fail")
  assert.match(remote!.detail, /^example\/demo: git push to origin refused: /)

  // A repository that neither opens pull requests nor takes in issues has no line.
  const local = await setup("{ landing: local }")
  assert.deepEqual(await githubLines([`example/demo=${local.repo}`], scratch, local.organization, env), [])
})
