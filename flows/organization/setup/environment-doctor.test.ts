import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { environmentLines } from "./doctor.ts"

const repo = mkdtempSync(join(tmpdir(), "org-doctor-env-"))
after(() => rmSync(repo, { recursive: true, force: true }))
spawnSync("git", ["init", "-q", repo])
writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
spawnSync("git", ["-C", repo, "add", "-A"])
spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"])

const organization = (repositories: Record<string, unknown>) =>
  ({ loaded: { organization: { repositories } } }) as never

test("an environment's key paths must exist at HEAD; a repository without one prints nothing", () => {
  const ok = organization({
    "acme/app": {
      prepare: { run: "pnpm install --frozen-lockfile", key: ["pnpm-lock.yaml"], network: ["registry.npmjs.org"] },
      checks: [{ name: "tests", run: "pnpm test" }]
    },
    "acme/tools": { network: "all", checks: [{ name: "a", run: "true" }, { name: "b", run: "true" }] },
    "acme/cli": { prepare: { run: "make", key: ["pnpm-lock.yaml", "Cargo.lock"], network: "all" } }
  })
  assert.deepEqual(environmentLines([`acme/app=${repo}`, `acme/tools=${repo}`, `acme/other=${repo}`], "/", ok), [
    { name: "env", status: "pass", detail: "acme/app: prepare registry.npmjs.org; builders offline; 1 check" },
    { name: "env", status: "pass", detail: "acme/tools: no prepare; builders full network; 2 checks" }
  ])
  assert.deepEqual(environmentLines([`acme/cli=${repo}`], "/", ok), [{
    name: "env",
    status: "fail",
    detail: "acme/cli: Cargo.lock not at HEAD",
    fix: "fix repositories.acme/cli.prepare.key in Org/Organization.md"
  }])
  assert.deepEqual(environmentLines([`acme/app=${repo}`], "/", organization({ "acme/app": {} })), [
    { name: "env", status: "pass", detail: "acme/app: no prepare; builders offline; 0 checks" }
  ])
  assert.deepEqual(environmentLines([`acme/app=${repo}`], "/", undefined), [])
})

test("base: the commit a task starts from, fetched from its remote; tools: found in the prepared base", async () => {
  const { baseLines } = await import("./base.ts")
  const { hostMachines } = await import("../../../packages/smithers/agent/organization/test/workspaceSupport.ts")
  const git = (dir: string, ...args: Array<string>) =>
    spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).stdout
      .trim()
  const remote = mkdtempSync(join(tmpdir(), "org-doctor-remote-"))
  after(() => rmSync(remote, { recursive: true, force: true }))
  git(remote, "init", "-q", "--bare", "-b", "main")
  git(repo, "remote", "add", "origin", remote)
  git(repo, "push", "-q", "origin", "HEAD:refs/heads/main")
  const head = git(repo, "rev-parse", "HEAD")
  const check = { name: "acme/app", repo, key: "doctor/acme" }

  assert.deepEqual(await baseLines({ ...check, environment: {} }), [
    { name: "base", status: "pass", detail: `acme/app: HEAD → ${head.slice(0, 12)}` }
  ])
  assert.deepEqual(await baseLines({ ...check, environment: { base: "origin/main" } }), [
    { name: "base", status: "pass", detail: `acme/app: origin/main → ${head.slice(0, 12)} (fetched)` }
  ])
  const [gone] = await baseLines({ ...check, environment: { base: "origin/gone" } })
  assert.equal(gone!.status, "fail")
  assert.match(gone!.detail, /^acme\/app: git fetch origin gone failed: /)
  assert.equal(gone!.fix, `git -C ${repo} fetch, or fix repositories.acme/app.base in Org/Organization.md`)

  const prepare = (tools: Array<string>) => ({
    prepare: { run: "true", key: ["pnpm-lock.yaml"] as [string], network: "none" as const, tools }
  })
  assert.deepEqual((await baseLines({ ...check, environment: prepare(["git"]) }))[1], {
    name: "tools",
    status: "skip",
    detail: "acme/app: no microVM to look in (fix the boot line)"
  })
  const { machines } = hostMachines()
  const found = await baseLines({ ...check, environment: prepare(["git", "sh"]), machines })
  assert.equal(found[1]!.status, "pass")
  assert.match(found[1]!.detail, /^acme\/app: git sh in base \S+$/)
  const lacking = await baseLines({ ...check, environment: prepare(["git", "smithers-no-such-tool"]), machines })
  assert.deepEqual(lacking[1], {
    name: "tools",
    status: "fail",
    detail: "acme/app: the prepared base lacks smithers-no-such-tool",
    fix: "fix repositories.acme/app.prepare in Org/Organization.md"
  })
  assert.deepEqual(await baseLines({ ...check, environment: prepare([]), machines }), [
    { name: "base", status: "pass", detail: `acme/app: HEAD → ${head.slice(0, 12)}` }
  ])
})
