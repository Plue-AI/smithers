import { fixtureProtocolId } from "../support/values"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { APIRequestContext, Page } from "@playwright/test"
import { expect, realApi } from "../support/test"
import { withOwnerAuthRetry } from "../auth-permissions/owner-session"
import { readAuthenticatedSession } from "../auth-permissions/profile"
import { repositoryApiPath } from "../repositories-github/production"

export type OwnedRepository = { readonly name: string; readonly fullName: string; readonly path: string }

export const withOwnedRepository = async <T>(
  page: Page, request: APIRequestContext, use: (repo: OwnedRepository) => Promise<T>
): Promise<T> => {
  const owner = await readAuthenticatedSession(page)
  expect(owner, "the matrix requires an authenticated product owner").toBeDefined()
  const name = fixtureProtocolId(`smithers-matrix-${randomUUID().slice(0, 12)}`)
  const fullName = `${owner!.login}/${name}`
  const path = repositoryApiPath(fullName)
  let bodyFailed = false
  let bodyError: unknown
  try {
    const created = await realApi(page, request, "POST", "/api/user/repos", {
      name, private: true, auto_init: true, default_bookmark: "main"
    })
    expect(created.status(), `create ${fullName}: ${await created.text()}`).toBe(201)
    expect(await created.json()).toMatchObject({ name, full_name: fullName, private: true, default_bookmark: "main" })
    return await use({ name, fullName, path })
  } catch (error) {
    bodyFailed = true
    bodyError = error
    throw error
  } finally {
    try {
      const existing = await realApi(page, request, "GET", path)
      if (existing.status() === 200) {
        const deleted = await realApi(page, request, "DELETE", path)
        expect(deleted.status(), `delete ${fullName}`).toBe(204)
      } else {
        expect(existing.status(), `probe possibly-created ${fullName}`).toBe(404)
      }
      expect((await realApi(page, request, "GET", path)).status()).toBe(404)
    } catch (cleanupError) {
      if (bodyFailed) throw new AggregateError([bodyError, cleanupError], `${String(bodyError)}\nRepository cleanup also failed: ${String(cleanupError)}`)
      throw cleanupError
    }
  }
}

/**
 * The one repository an install wraps (mvp.md §2 rule 2), when the mode's
 * launcher names it (SMITHERS_REAL_INSTALL_REPOSITORY). An install adds no
 * repository and deletes none: /repo.create is deferred (§8, Appendix B).
 */
export const installRepository = (): OwnedRepository | undefined => {
  const fullName = process.env.SMITHERS_REAL_INSTALL_REPOSITORY?.trim()
  if (!fullName) return undefined
  const [owner, name, extra] = fullName.split("/")
  if (!owner || !name || extra !== undefined) throw new Error(`SMITHERS_REAL_INSTALL_REPOSITORY must be owner/name: ${fullName}`)
  return { name, fullName, path: repositoryApiPath(fullName) }
}

/** A matrix scenario's repository: the install's own on an install, else one this scenario creates and deletes. */
export const withProductRepository = async <T>(
  page: Page, request: APIRequestContext, use: (repo: OwnedRepository) => Promise<T>
): Promise<T> => {
  const installed = installRepository()
  if (installed === undefined) return withOwnedRepository(page, request, use)
  const read = await realApi(page, request, "GET", installed.path)
  expect(read.status(), `read the install's repository ${installed.fullName}`).toBe(200)
  expect(await read.json()).toMatchObject({ full_name: installed.fullName, default_bookmark: "main" })
  return use(installed)
}

const runGit = async (cwd: string, args: readonly string[], token?: string): Promise<string> => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    ...(token ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` } : {}) }
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("git", [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    child.once("error", reject)
    child.once("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`git ${args.filter((arg) => !arg.includes("Authorization")).join(" ")} exited ${code}: ${stderr}`)))
  })
}

const gitToken = async (page: Page, request: APIRequestContext): Promise<string> => {
  if (process.env.SMITHERS_REAL_AUTH_KIND === "application-token") {
    const name = process.env.SMITHERS_REAL_AUTH_ENVIRONMENT
    const token = name ? process.env[name] : undefined
    if (!token) throw new Error("application token is unavailable for the local git fixture")
    return token
  }
  const tokenName = fixtureProtocolId(`matrix-git-${randomUUID().slice(0, 8)}`)
  const { response } = await withOwnerAuthRetry(async () => {
    const response = await realApi(page, request, "POST", "/api/user/tokens", {
      name: tokenName, scopes: ["read:repository", "write:repository"], expires_at: new Date(Date.now() + 3_600_000).toISOString()
    })
    return { status: response.status(), retryAfter: response.headers()["retry-after"] ?? null, response }
  })
  expect(response.status()).toBe(201)
  const body = await response.json() as { readonly token?: unknown }
  if (typeof body.token !== "string" || body.token === "") throw new Error("owner token endpoint returned no token")
  return body.token
}

/** Commit `files` on `branch` (created from main unless it is main) and push it; `changeId` stamps jj's change-id header and force-pushes a new revision of that change. */
const pushFiles = async (
  page: Page, request: APIRequestContext, repo: OwnedRepository, branch: string, message: string,
  files: Readonly<Record<string, string>>, changeId?: string
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "smithers-matrix-git-"))
  const work = join(root, "checkout")
  try {
    const origin = process.env.SMITHERS_REAL_GIT_ORIGIN ?? process.env.SMITHERS_REAL_API_ORIGIN ?? new URL(page.url()).origin
    // A person's external main edit is simulated in githubfake's own Git
    // repository. Product/agent credentials never write the install mirror.
    const fakeGitRoot = installRepository() ? process.env.SMITHERS_REAL_INSTALL_GIT_ROOT : undefined
    if (installRepository() && !fakeGitRoot) throw new Error("Install flow fixtures require githubfake's Git root")
    const url = fakeGitRoot ? join(fakeGitRoot, `${repo.fullName}.git`) : new URL(`/${repo.fullName}.git`, origin).toString()
    const token = fakeGitRoot ? undefined : await gitToken(page, request)
    await runGit(root, ["clone", url, work], token)
    if (branch !== "main") await runGit(work, ["checkout", "-b", branch])
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(work, path)), { recursive: true })
      await writeFile(join(work, path), content)
      await runGit(work, ["add", path])
    }
    await runGit(work, ["-c", "user.name=Matrix", "-c", "user.email=matrix@example.test", "commit", "-m", message])
    if (changeId === undefined) {
      const commit = await runGit(work, ["rev-parse", "HEAD"])
      await runGit(work, ["push", "origin", branch], token)
      return commit
    }
    // jj reads a commit's change id from its `change-id` header, so a later commit with the same header is the change's next revision.
    const raw = await runGit(work, ["cat-file", "commit", "HEAD"])
    const stamped = raw.replace(/^(committer .*)$/mu, `$1\nchange-id ${changeId}`)
    const objectPath = join(root, "commit")
    await writeFile(objectPath, `${stamped}\n`)
    const commit = await runGit(work, ["hash-object", "-t", "commit", "-w", objectPath])
    await runGit(work, ["update-ref", `refs/heads/${branch}`, commit])
    await runGit(work, ["push", "--force", "origin", branch], token)
    return commit
  } finally { await rm(root, { recursive: true, force: true }) }
}

/** A fresh jj change id: 32 reverse-hex letters (`z` for 0 … `k` for f). */
export const newChangeId = (): string =>
  randomUUID().replaceAll("-", "").replace(/[0-9a-f]/gu, (digit) => "zyxwvutsrqponmlk"[Number.parseInt(digit, 16)]!)

/** Commit `files` on a fixture bookmark forked from main as the next revision of `changeId`; each call replaces the previous revision. */
export const pushChangeRevision = (
  page: Page, request: APIRequestContext, repo: OwnedRepository, changeId: string, files: Readonly<Record<string, string>>
): Promise<string> => pushFiles(page, request, repo, "fixture", "Change fixture", files, changeId)

/** Declare project files on main, before a box checks it out. */
export const pushMainFiles = async (page: Page, request: APIRequestContext, repo: OwnedRepository, files: Readonly<Record<string, string>>): Promise<string> => {
  type FlowCard = { name: string; versions: Array<{ id: string; state: string }> }
  const previous = installRepository() ? await (await realApi(page, request, "GET", "/api/flows")).json() as FlowCard[] : []
  const commit = await pushFiles(page, request, repo, "main", "Add project files", files)
  if (installRepository()) {
    const sync = await realApi(page, request, "POST", "/api/github/sync", {})
    expect(sync.status(), await sync.text()).toBe(202)
    await expect.poll(async () => {
      const response = await realApi(page, request, "GET", `${repo.path}/bookmarks`)
      if (!response.ok()) return undefined
      const body = await response.json()
      return body.items.find((row: { name: string }) => row.name === "main")?.target_commit_id
    }, { timeout: 120_000 }).toBe(commit)
    for (const path of Object.keys(files)) {
      const name = /^flows\/(.+)\/flow\.mdx$/.exec(path)?.[1]
      if (!name) continue
      const prior = previous.find(card => card.name === name)?.versions.find(version => version.state === "active")?.id
      await expect.poll(async () => {
        const response = await realApi(page, request, "GET", "/api/flows")
        expect(response.status()).toBe(200)
        const cards = await response.json() as FlowCard[]
        const versions = cards.find(card => card.name === name)?.versions
        return versions?.some(version => version.id !== prior && version.state === "active") && !versions.some(version => version.state === "merged-syncing")
      }, { timeout: 120_000 }).toBe(true)
    }
  }
  return commit
}

/** Open a box of `repo` on main, wait for it to run, and delete it afterwards. */
export const runningWorkspace = async <T>(page: Page, request: APIRequestContext, repo: OwnedRepository, use: (id: string) => Promise<T>): Promise<T> => {
  if (installRepository()) return runningInstallBranch(page, request, use)
  const created = await realApi(page, request, "POST", `${repo.path}/workspaces`, { name: "matrix", source_bookmark: "main", kind: "container" })
  expect([201, 202]).toContain(created.status())
  const workspace = await created.json() as { readonly id?: unknown }
  expect(workspace.id).toEqual(expect.any(String))
  const id = workspace.id as string
  const path = `${repo.path}/workspaces/${encodeURIComponent(id)}`
  try {
    await expect.poll(async () => {
      const response = await realApi(page, request, "GET", path)
      expect(response.status()).toBe(200)
      return (await response.json() as { readonly status?: string }).status
    }, { timeout: 120_000, intervals: [500, 1_000, 2_000] }).toBe("running")
    return await use(id)
  } finally {
    const deleted = await realApi(page, request, "DELETE", path)
    expect(deleted.status()).toBe(204)
    expect((await realApi(page, request, "GET", path)).status()).toBe(404)
  }
}

/** Fork main through the install's stack service; retain its machine identity. */
export const runningInstallBranch = async <T>(page: Page, request: APIRequestContext, use: (id: string, branch: string) => Promise<T>): Promise<T> => {
  const created = await realApi(page, request, "POST", "/api/branches", { from: "main", name: `matrix-${randomUUID().slice(0, 8)}` })
  expect(created.status(), await created.text()).toBe(201)
  const branch = await created.json() as { name: string; machine?: { id: string } }
  const path = `/api/branches/${encodeURIComponent(branch.name)}`
  try {
    let machine: string | undefined
    await expect.poll(async () => {
      const response = await realApi(page, request, "GET", path)
      expect(response.status()).toBe(200)
      const row = await response.json()
      machine = row.machine?.id
      return row.state
    }, { timeout: 120_000 }).toBe("awake")
    expect(machine).toEqual(expect.any(String))
    return await use(machine!, branch.name)
  } finally {
    const archived = await realApi(page, request, "POST", `${path}/archive`, {})
    expect([200, 202], await archived.text()).toContain(archived.status())
  }
}
