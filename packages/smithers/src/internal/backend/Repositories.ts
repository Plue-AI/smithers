/**
 * Repository operations and scoped checkout transfer through the backend API.
 * @since 0.1.0
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Refused, UsageError } from "../../CliError.ts"
import { APIError, list, object, pick, query, str, type Values, withCause } from "./Client.ts"
import { lines } from "./Local.ts"
import type { Handler } from "./Resources.ts"

/**
 * @private
 * @since 1.0.0
 */
export const gitAuth = (origin: string, token: string): NodeJS.ProcessEnv => ({
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`,
  GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  GIT_CONFIG_KEY_1: "http.followRedirects",
  GIT_CONFIG_VALUE_1: "false"
})
/**
 * @private
 * @since 1.0.0
 */
export const repositories: Record<string, Handler> = {}
repositories["repo create"] = (c, a, o) =>
  c.request("POST", "/api/user/repos", {
    name: a.name,
    ...(o.description ? { description: o.description } : {}),
    ...(o.private ? { private: true } : {})
  })
repositories["repo list"] = (c, _a, o) =>
  c.request("GET", "/api/user/repos" + query({ page: o.page, per_page: o.limit }))
repositories["repo view"] = (c, a, o) => c.request("GET", c.repoPath(o.repo || a.repo))
repositories["repo home"] = (c, a, o) => c.request("GET", c.repoPath(o.repo || a.repo) + "/home")
// The cached registration result (Registration.Report, #3239): another account's finished report of a
// public repository at its current commit, or none; nothing is launched and no model runs.
repositories["repo report"] = async (c, a, o) => {
  const repo = c.repo(a.repo)
  const answer = object(
    await c.request("POST", "/api/workflow/rpc", {
      repo,
      procedure: "Registration.Report",
      payload: { repo: repo.toLowerCase() },
      workspaceId: str(o.workspace)
    })
  )
  const shared = object(object(answer.payload).report)
  return typeof shared.commit === "string" && shared.report
    ? { cached: true, repo, commit: shared.commit, recordedAt: shared.recordedAt, report: shared.report }
    : { cached: false, repo }
}
repositories["repo edit"] = (c, a, o) =>
  c.request("PATCH", c.repoPath(a.repo), pick(o, ["name", "description", "private"]))
repositories["repo mirror-sync"] = (c, _a, o) => c.request("POST", c.repoPath(o.repo) + "/mirror-sync")
for (const action of ["archive", "unarchive", "delete"]) {
  repositories[`repo ${action}`] = async (c, a, o) => {
    const repo = c.repo(a.repo)
    if (action === "delete") await c.confirm(o.yes, `delete repository ${repo}`)
    await c.request(
      action === "delete" ? "DELETE" : "POST",
      `/api/repos/${repo}${action === "delete" ? "" : `/${action}`}`
    )
    return { status: action === "delete" ? "deleted" : `${action}d`, repo }
  }
}
repositories["repo clone"] = async (c, a, o) => {
  const input = str(a.repo)
  if (!input) throw new UsageError({ message: "Repository is required" })
  const protocol = str(o.protocol || c.session.config().git_protocol)
  const isSlug = /^[\w.-]+\/[\w.-]+$/.test(input)
  const slug = isSlug ? c.repo(input) : ""
  const name = isSlug ? slug.split("/")[1]! : input.slice(input.lastIndexOf("/") + 1).replace(/\.git$/, "")
  const rest = list(a.rest).map(str)
  const directory = str(o.directory) || (rest[0] && !rest[0].startsWith("-") ? rest.shift() : "") || name
  let url = input
  let cloneEnv: NodeJS.ProcessEnv = {}
  if (isSlug) {
    const target = c.session.target()
    url = protocol === "https" ? `${target.api_url}/${slug}.git` : `git@ssh.${target.host}:${slug}.git`
    const auth = await c.session.resolve()
    if (auth) {
      try {
        await c.request("GET", `/api/repos/${slug}`)
      } catch (error) {
        if (error instanceof APIError && ![401, 403].includes(error.status)) throw error
      }
      if (protocol === "https") cloneEnv = gitAuth(auth.api_url, auth.token)
    }
  }
  const extra = [...list(o["clone-arg"]).map(str), ...rest]
  let backend = "jj"
  try {
    await c.exec("jj", ["git", "clone", url, directory, ...extra], cloneEnv)
  } catch {
    backend = "git"
    await c.exec("git", ["clone", url, directory, ...extra], cloneEnv)
  }
  return { cloned: isSlug ? slug : directory, directory, protocol, tool: backend }
}
// A checkout of a GitHub-mirrored repository pushes under the name its origin names.
const githubOrigin: ReadonlySet<string> = new Set(["github.com", "ssh.github.com"])
repositories["repo push"] = async (c, _a, o) => {
  const name = str(o.name) || "head"
  if (
    !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(name) ||
    name.split("/").some((part) =>
      [".", ".."].includes(part) || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock")
    ) || name.includes("..")
  ) throw new UsageError({ message: "Invalid ref name" })
  const repository = c.repo(o.repo, githubOrigin), path = `/api/repos/${repository}`
  if (o.list) return c.request("GET", path + "/user-refs")
  const auth = await c.session.require(), env = gitAuth(auth.api_url, auth.token)
  let gitDir = "", commit = "", uncommitted = false, jj = false
  try {
    await c.exec("jj", ["root"])
    jj = true
  } catch { /* git checkout */ }
  if (o.delete) {
    gitDir = jj
      ? await c.exec("jj", ["git", "root"])
      : await c.exec("git", ["rev-parse", "--absolute-git-dir"])
  } else if (jj) {
    gitDir = await c.exec("jj", ["git", "root"])
    const commits = lines(
      await c.exec("jj", ["log", "-r", o["working-copy"] ? "@" : "@-", "--no-graph", "-T", "commit_id ++ \"\\n\""])
    )
    if (commits.length !== 1 || /^0+$/.test(commits[0]!)) {
      throw new Refused({ fault: "user", code: "nothing_to_push", message: "Push exactly one non-root commit" })
    }
    commit = commits[0]!
  } else {
    if (o["working-copy"]) throw new UsageError({ message: "--working-copy requires a jj checkout" })
    gitDir = await c.exec("git", ["rev-parse", "--absolute-git-dir"])
    commit = await c.exec("git", ["rev-parse", "--verify", "HEAD^{commit}"])
    uncommitted = !!await c.exec("git", ["status", "--porcelain"])
  }
  if (o["working-copy"] && object(await c.request("GET", path)).is_public) {
    throw new Refused({
      fault: "policy",
      code: "public_repository",
      message: "--working-copy is refused on a public repository"
    })
  }
  const id = Number(object(await c.request("GET", "/api/user")).id)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Refused({ fault: "infra", code: "backend_protocol", message: "API returned no user id" })
  }
  const ref = `refs/smithers/users/${id}/${name}`, remote = `${auth.api_url}/${repository}.git`
  const advertised = await c.exec("git", ["--git-dir", gitDir, "ls-remote", remote, ref], env)
  const previous = lines(advertised).map((line) => line.split(/\s+/)).find((fields) => fields[1] === ref)?.[0] || ""
  const result: Values = { repository, ref, previous: previous || null }
  if (o.delete) {
    if (previous) {
      await c.exec(
        "git",
        ["--git-dir", gitDir, "push", `--force-with-lease=${ref}:${previous}`, remote, `:${ref}`],
        env
      )
    }
    return { ...result, deleted: !!previous }
  }
  if (previous !== commit) {
    await c.exec(
      "git",
      ["--git-dir", gitDir, "push", `--force-with-lease=${ref}:${previous}`, remote, `${commit}:${ref}`],
      env
    )
  }
  const renewed = object(await c.request("POST", path + "/user-refs/renew", { name }))
  return { ...result, commit, uncommitted, updated: previous !== commit, expires_at: renewed.expires_at }
}
const configPath = () => resolve(".smithers/config.json")
const readConfig = async (): Promise<Values> => {
  const invalid = () => new Refused({ fault: "user", code: "invalid_config", message: "Invalid .smithers/config.json" })
  let value: unknown
  try {
    value = JSON.parse(await readFile(configPath(), "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    if (error instanceof SyntaxError) throw withCause(invalid(), error)
    throw error
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid()
  return object(value)
}
const saveConfig = async (value: Values) => {
  await mkdir(resolve(".smithers"), { recursive: true })
  await writeFile(configPath(), JSON.stringify(value, null, 2) + "\n")
}
const requireJj = async () => {
  const refusal = () =>
    new Refused({ fault: "user", code: "not_jj_repo", message: "Run this from the root of a jj checkout" })
  const info = await stat(".jj").catch((error: NodeJS.ErrnoException) => {
    throw error.code === "ENOENT" || error.code === "ENOTDIR" ? withCause(refusal(), error) : error
  })
  if (!info.isDirectory()) throw refusal()
}
const licenseRefused = () =>
  new Refused({
    fault: "user",
    code: "license_not_permitted",
    message: "The repository license must be MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC or MPL-2.0"
  })
const permitted = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0"]
const licenseOf = async (repository: Values) => {
  const spdx = str(object(repository.license).spdx_id)
  const canonical = permitted.find((id) => id.toLowerCase() === spdx.toLowerCase())
  if (canonical) return canonical
  if (spdx && !["NOASSERTION", "NONE"].includes(spdx.toUpperCase())) throw licenseRefused()
  for (const base of ["LICENSE", "COPYING", "license", "copying"]) {
    for (const extension of ["", ".md", ".txt"]) {
      let content = ""
      try {
        content = (await readFile(base + extension, "utf8")).toLowerCase()
      } catch {
        continue
      }
      const marker = /spdx-license-identifier:\s*(\S+)/.exec(content)?.[1]
      const marked = permitted.find((id) => id.toLowerCase() === marker)
      if (marked) return marked
      if (
        (content.includes("mit license") || content.includes("permission is hereby granted, free of charge")) &&
        content.includes("without limitation the rights to use")
      ) return "MIT"
      if (content.includes("apache license") && content.includes("version 2.0")) return "Apache-2.0"
      if (content.includes("mozilla public license") && /version 2.0|v. 2.0/.test(content)) return "MPL-2.0"
      if (
        content.includes("permission to use, copy, modify, and/or distribute this software for any purpose")
      ) return "ISC"
      if (content.includes("redistribution and use in source and binary forms")) {
        if (content.includes("neither the name")) return "BSD-3-Clause"
        if (
          content.includes("this software is provided by the copyright holders and contributors \"as is\"")
        ) return "BSD-2-Clause"
      }
    }
  }
  throw licenseRefused()
}
repositories["repo connect"] = async (c, a) => {
  await requireJj()
  const slug = c.repo(a.repo), [owner, repo] = slug.split("/")
  const github = object(
    await c.request("GET", `/repos/${slug}`, undefined, {
      origin: c.env.SMITHERS_GITHUB_API_URL || "https://api.github.com",
      anonymous: true,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
        ...(c.env.GITHUB_TOKEN ? { Authorization: `Bearer ${c.env.GITHUB_TOKEN}` } : {})
      }
    })
  )
  if (github.private) {
    throw new Refused({
      fault: "user",
      code: "repo_not_public",
      message: "Only public GitHub repositories can connect"
    })
  }
  const license_spdx_id = await licenseOf(github)
  let status = object(await c.request("GET", `/api/repos/${slug}/github-app-status`))
  if (status.github_app_configured === false) throw new Refused({ fault: "user", code: "github_app_not_configured", message: "The GitHub App is not configured" })
  if (!status.github_app_installed) {
    const installUrl = str(status.install_url)
    if (!installUrl) throw new Refused({ fault: "user", code: "github_app_not_configured", message: "The GitHub App is not configured" })
    c.write(`Install ${installUrl}\n`)
  }
  while (!status.github_app_installed) {
    await delay(Number(c.env.SMITHERS_GITHUB_APP_POLL_INTERVAL_MS) || 2000, undefined, { signal: c.runtime.signal })
    status = object(await c.request("GET", `/api/repos/${slug}/github-app-status`))
  }
  await c.request("POST", "/api/repo-connection", { license_spdx_id, owner, repo })
  try {
    await saveConfig({
      ...await readConfig(),
      repo_connection: { repo: slug, license_spdx_id, connected_at: new Date().toISOString() }
    })
  } catch (error) {
    await c.request("DELETE", "/api/repo-connection", { owner, repo })
    throw error
  }
  return { connected: true, github_app_installed: true, license_spdx_id, repo: slug }
}
repositories["repo disconnect"] = async (c) => {
  await requireJj()
  const config = await readConfig(), current = object(config.repo_connection)
  if (current.repo) {
    const [owner, repo] = c.repo(current.repo).split("/")
    await c.request("DELETE", "/api/repo-connection", { owner, repo })
    delete config.repo_connection
    await saveConfig(config)
  }
  return { connected: false }
}
repositories["repo status"] = async (c) => {
  await requireJj()
  const current = object((await readConfig()).repo_connection)
  return {
    connected: !!current.repo,
    ...current,
    ...(current.repo
      ? object(await c.request("GET", c.repoPath(current.repo) + "/github-app-status"))
      : { github_app_installed: false })
  }
}
repositories["cache connect"] = async (c, _a, o) => {
  const build_file = join(str(o.workspace) || ".", "PACKAGE.ts")
  let existing = ""
  try {
    existing = await readFile(build_file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const old = /^export const \w+ = Smithers\.RemoteCache\.smithersCloud\([^\n]*\)\s*$/m.exec(existing)?.[0]
  if (old) return { build_file, declaration: old.trim(), changed: false }
  const repository = c.repo(o.repo),
    record = object(
      await c.request("POST", `/api/repos/${repository}/build-cache/tokens`, { name: "smithers cache connect" })
    )
  if (!record.token) {
    throw new Refused({ fault: "infra", code: "backend_protocol", message: "API returned no public read token" })
  }
  const declaration = `export const remoteCache = Smithers.RemoteCache.smithersCloud({ repo: ${
    JSON.stringify(repository)
  }, publicReadToken: ${JSON.stringify(record.token)} })`
  if (o.write === false) return { build_file, declaration, changed: false }
  if (existing && !/import\s+(?:\*\s+as\s+Smithers|\{\s*Smithers\s*\})\s+from/.test(existing)) {
    throw new Refused({ fault: "user", code: "invalid_package", message: "PACKAGE.ts must import Smithers" })
  }
  const updated = existing
    ? `${existing.trimEnd()}\n\n${declaration}\n`
    : `import { Smithers } from "@smthrs/targets"\n\n${declaration}\n`
  await mkdir(resolve(str(o.workspace) || "."), { recursive: true })
  await writeFile(build_file, updated)
  return { build_file, declaration, changed: true, endpoint: record.endpoint }
}
