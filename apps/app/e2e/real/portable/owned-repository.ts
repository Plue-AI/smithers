import { fixtureProtocolId } from "../support/values"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { APIRequestContext, Page } from "@playwright/test"
import { expect, realApi } from "../support/test"
import { readAuthenticatedSession } from "../auth-permissions/profile"
import { repositoryApiPath } from "../repositories-github/production"

export type OwnedRepository = { readonly name: string; readonly fullName: string; readonly path: string }

export const withOwnedRepository = async <T>(page: Page, request: APIRequestContext, use: (repo: OwnedRepository) => Promise<T>): Promise<T> => {
  const owner = await readAuthenticatedSession(page)
  expect(owner, "the matrix requires an authenticated product owner").toBeDefined()
  const name = fixtureProtocolId(`smithers-matrix-${randomUUID().slice(0, 12)}`)
  const fullName = `${owner!.login}/${name}`
  const path = repositoryApiPath(fullName)
  const created = await realApi(page, request, "POST", "/api/user/repos", {
    name, private: true, auto_init: true, default_bookmark: "main"
  })
  expect(created.status(), `create ${fullName}: ${await created.text()}`).toBe(201)
  try { return await use({ name, fullName, path }) }
  finally {
    const deleted = await realApi(page, request, "DELETE", path)
    expect(deleted.status(), `delete ${fullName}`).toBe(204)
    expect((await realApi(page, request, "GET", path)).status()).toBe(404)
  }
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
  const name = process.env.SMITHERS_REAL_AUTH_ENVIRONMENT
  const raw = name ? process.env[name] : undefined
  if (!raw) throw new Error("owner credential envelope is unavailable for the local git fixture")
  const credentials = JSON.parse(raw) as { readonly username: string; readonly password: string }
  const tokenName = fixtureProtocolId(`matrix-git-${randomUUID().slice(0, 8)}`)
  const response = await realApi(page, request, "POST", "/api/auth/local/token", {
    username: credentials.username, password: credentials.password, name: tokenName
  })
  expect(response.status()).toBe(200)
  const body = await response.json() as { readonly token?: unknown }
  if (typeof body.token !== "string" || body.token === "") throw new Error("owner token endpoint returned no token")
  return body.token
}

/** Commit `files` on `branch` (created from main unless it is main) and push it. */
const pushFiles = async (
  page: Page, request: APIRequestContext, repo: OwnedRepository, branch: string, message: string,
  files: Readonly<Record<string, string>>
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "smithers-matrix-git-"))
  const work = join(root, "checkout")
  try {
    const origin = process.env.SMITHERS_REAL_GIT_ORIGIN ?? process.env.SMITHERS_REAL_API_ORIGIN ?? new URL(page.url()).origin
    const url = new URL(`/${repo.fullName}.git`, origin).toString()
    const token = await gitToken(page, request)
    await runGit(root, ["clone", url, work], token)
    if (branch !== "main") await runGit(work, ["checkout", "-b", branch])
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(work, path)), { recursive: true })
      await writeFile(join(work, path), content)
      await runGit(work, ["add", path])
    }
    await runGit(work, ["-c", "user.name=Matrix", "-c", "user.email=matrix@example.test", "commit", "-m", message])
    const commit = await runGit(work, ["rev-parse", "HEAD"])
    await runGit(work, ["push", "origin", branch], token)
    return commit
  } finally { await rm(root, { recursive: true, force: true }) }
}

export const pushLocalFixture = async (page: Page, request: APIRequestContext, repo: OwnedRepository): Promise<{ readonly commit: string; readonly marker: string }> => {
  const marker = `fixture-${randomUUID()}`
  const commit = await pushFiles(page, request, repo, "fixture", "Add local fixture", { "fixture.txt": `${marker}\n` })
  return { commit, marker }
}

/** Declare project files on main, before a box checks it out. */
export const pushMainFiles = (page: Page, request: APIRequestContext, repo: OwnedRepository, files: Readonly<Record<string, string>>): Promise<string> =>
  pushFiles(page, request, repo, "main", "Add project files", files)

/** Open a box of `repo` on main, wait for it to run, and delete it afterwards. */
export const runningWorkspace = async <T>(page: Page, request: APIRequestContext, repo: OwnedRepository, use: (id: string) => Promise<T>): Promise<T> => {
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
