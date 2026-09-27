/**
 * Repository operations and scoped checkout transfer through the backend API.
 * @since 0.1.0
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { APIError, list, object, pick, query, str, type Values } from "./Client.ts"
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
repositories["repo fork"] = (c, a, o) =>
  c.request("POST", c.repoPath(a.repo) + "/forks", pick(o, ["name", "organization"]))
repositories["repo transfer"] = (c, a, o) => c.request("POST", c.repoPath(a.repo) + "/transfer", { new_owner: o.to })
repositories["repo edit"] = (c, a, o) =>
  c.request("PATCH", c.repoPath(a.repo), pick(o, ["name", "description", "private"]))
repositories["repo mirror-sync"] = (c, _a, o) => c.request("POST", c.repoPath(o.repo) + "/mirror-sync")
for (const action of ["archive", "unarchive", "delete"]) {
  repositories[`repo ${action}`] = async (c, a, o) => {
    const repo = c.repo(a.repo)
    if (action === "delete") await c.confirm(o.yes, `delete repository ${repo}`)
    await c.request(
      action === "archive" ? "POST" : "DELETE",
      `/api/repos/${repo}${action === "delete" ? "" : "/archive"}`
    )
    return { status: action === "delete" ? "deleted" : `${action}d`, repo }
  }
}
repositories["repo clone"] = async (c, a, o) => {
  const input = str(a.repo)
  if (!input) throw new Error("Repository is required")
  const protocol = str(o.protocol || c.session.config().git_protocol)
  const isSlug = /^[\w.-]+\/[\w.-]+$/.test(input)
  const slug = isSlug ? c.repo(input) : ""
  const name = isSlug ? slug.split("/")[1]! : input.slice(input.lastIndexOf("/") + 1).replace(/\.git$/, "")
  const rest = list(a.rest).map(str)
  const directory = str(o.directory) || (rest[0] && !rest[0].startsWith("-") ? rest.shift() : "") || name
  let url = input
  if (isSlug) {
    const host = c.session.target().host
    url = protocol === "https" ? `https://${host}/${slug}.git` : `git@ssh.${host}:${slug}.git`
    if (c.session.resolve()) {
      try {
        await c.request("GET", `/api/repos/${slug}`)
      } catch (error) {
        if (error instanceof APIError && ![401, 403].includes(error.status)) throw error
      }
    }
  }
  const extra = [...list(o["clone-arg"]).map(str), ...rest]
  let backend = "jj"
  try {
    c.exec("jj", ["git", "clone", url, directory, ...extra])
  } catch {
    backend = "git"
    c.exec("git", ["clone", url, directory, ...extra])
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
  ) throw new Error("Invalid ref name")
  const repository = c.repo(o.repo, githubOrigin), path = `/api/repos/${repository}`
  if (o.list) return c.request("GET", path + "/user-refs")
  const auth = c.session.require(), env = gitAuth(auth.api_url, auth.token)
  let gitDir = "", commit = "", uncommitted = false, jj = false
  try {
    c.exec("jj", ["root"])
    jj = true
  } catch { /* git checkout */ }
  if (o.delete) gitDir = jj ? c.exec("jj", ["git", "root"]) : c.exec("git", ["rev-parse", "--absolute-git-dir"])
  else if (jj) {
    gitDir = c.exec("jj", ["git", "root"])
    const commits = lines(
      c.exec("jj", ["log", "-r", o["working-copy"] ? "@" : "@-", "--no-graph", "-T", "commit_id ++ \"\\n\""])
    )
    if (commits.length !== 1 || /^0+$/.test(commits[0]!)) throw new Error("Push exactly one non-root commit")
    commit = commits[0]!
  } else {
    if (o["working-copy"]) throw new Error("--working-copy requires a jj checkout")
    gitDir = c.exec("git", ["rev-parse", "--absolute-git-dir"])
    commit = c.exec("git", ["rev-parse", "--verify", "HEAD^{commit}"])
    uncommitted = !!c.exec("git", ["status", "--porcelain"])
  }
  if (o["working-copy"] && object(await c.request("GET", path)).is_public) {
    throw new Error("--working-copy is refused on a public repository")
  }
  const id = Number(object(await c.request("GET", "/api/user")).id)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("API returned no user id")
  const ref = `refs/smithers/users/${id}/${name}`, remote = `${auth.api_url}/${repository}.git`
  const advertised = c.exec("git", ["--git-dir", gitDir, "ls-remote", remote, ref], env)
  const previous = lines(advertised).map((line) => line.split(/\s+/)).find((fields) => fields[1] === ref)?.[0] || ""
  const result: Values = { repository, ref, previous: previous || null }
  if (o.delete) {
    if (previous) {
      c.exec("git", ["--git-dir", gitDir, "push", `--force-with-lease=${ref}:${previous}`, remote, `:${ref}`], env)
    }
    return { ...result, deleted: !!previous }
  }
  if (previous !== commit) {
    c.exec(
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
  try {
    const value: unknown = JSON.parse(await readFile(configPath(), "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid .smithers/config.json")
    return object(value)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
}
const saveConfig = async (value: Values) => {
  await mkdir(resolve(".smithers"), { recursive: true })
  await writeFile(configPath(), JSON.stringify(value, null, 2) + "\n")
}
const requireJj = async () => {
  if (!(await stat(".jj")).isDirectory()) throw new Error("NOT_JJ_REPO")
}
const permitted = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0"]
const licenseOf = async (repository: Values) => {
  const spdx = str(object(repository.license).spdx_id)
  const canonical = permitted.find((id) => id.toLowerCase() === spdx.toLowerCase())
  if (canonical) return canonical
  if (spdx && !["NOASSERTION", "NONE"].includes(spdx.toUpperCase())) throw new Error("LICENSE_NOT_PERMITTED")
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
  throw new Error("LICENSE_NOT_PERMITTED")
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
  if (github.private) throw new Error("REPO_NOT_PUBLIC")
  const license_spdx_id = await licenseOf(github)
  let status = object(await c.request("GET", `/api/repos/${slug}/github-app-status`))
  if (!status.github_app_installed) {
    c.write(
      `Install ${str(status.install_url) || "https://github.com/apps/smitherspreviewrelease/installations/new"}\n`
    )
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
  if (!record.token) throw new Error("API returned no public read token")
  const declaration = `export const remoteCache = Smithers.RemoteCache.smithersCloud({ repo: ${
    JSON.stringify(repository)
  }, publicReadToken: ${JSON.stringify(record.token)} })`
  if (o.write === false) return { build_file, declaration, changed: false }
  if (existing && !/import\s+\*\s+as\s+Smithers\s+from/.test(existing)) {
    throw new Error("PACKAGE.ts must import Smithers")
  }
  const updated = existing
    ? `${existing.trimEnd()}\n\n${declaration}\n`
    : `import * as Smithers from "@smthrs/build"\n\n${declaration}\n`
  await mkdir(resolve(str(o.workspace) || "."), { recursive: true })
  await writeFile(build_file, updated)
  return { build_file, declaration, changed: true, endpoint: record.endpoint }
}
