import { assertCanaryRepository } from "./canary-repo.mjs"
import { githubApi } from "./github-api.mjs"
import { cli, createStepLog, isMain, required, safeRelativePath } from "./lib.mjs"

export const ACTORS = ["owner", "ben", "alice"]
const sha = (value) => {
  if (!/^[a-f0-9]{40}$/.test(value ?? "")) throw new Error("Expected a GitHub commit SHA")
  return value
}
const number = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Expected a positive PR number")
  return value
}
const branchName = (value, prefix = "smithers/") => {
  if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-zA-Z0-9/_-]+$/.test(value) || value.endsWith("/") || value.includes("//")) throw new Error(`Expected a ${prefix} branch`)
  return value
}

export async function githubActors({ repository, env = process.env, fetchImpl = fetch, log = async () => {}, verifyAccess = true }) {
  assertCanaryRepository(repository)
  const apis = {}
  const identities = {}
  for (const actor of ACTORS) {
    const token = required(env[`JOURNEY_${actor.toUpperCase()}_TOKEN`], `JOURNEY_${actor.toUpperCase()}_TOKEN`)
    apis[actor] = githubApi({ actor, token, fetchImpl, log })
  }
  for (const actor of ACTORS) {
    const user = await apis[actor]("GET", "/user")
    if (user?.type !== "User" || !Number.isSafeInteger(user.id) || user.id < 1 || typeof user.login !== "string" || !/^[a-zA-Z0-9-]+$/.test(user.login)) throw new Error(`${actor} needs a personal GitHub account`)
    if (Object.values(identities).some((other) => other.id === user.id || other.login.toLowerCase() === user.login.toLowerCase())) throw new Error("Owner, Ben and Alice must be distinct GitHub accounts")
    const expected = env[`JOURNEY_${actor.toUpperCase()}_LOGIN`]
    if (expected && expected.toLowerCase() !== user.login.toLowerCase()) throw new Error(`${actor} token belongs to a different login`)
    identities[actor] = { id: user.id, login: user.login }
    await log({ event: "github.actor", actor, ...identities[actor] })
  }
  let accessVerified = false
  const verifyActorAccess = async () => {
    accessVerified = false
    for (const actor of ACTORS) {
      const permission = await apis[actor]("GET", `/repos/${repository}/collaborators/${encodeURIComponent(identities[actor].login)}/permission`)
      if (!["admin", "maintain", "write"].includes(permission?.permission) || (actor === "owner" && permission.permission !== "admin")) throw new Error(`${actor} lacks the required canary repository access`)
    }
    accessVerified = true
  }
  if (verifyAccess) await verifyActorAccess()
  const apiFor = (actor) => {
    if (!ACTORS.includes(actor)) throw new Error("Unknown journey actor")
    if (!accessVerified) throw new Error("Journey actor access has not been verified")
    return apis[actor]
  }
  const pull = async (api, pr, prefix = "smithers/") => {
    const value = await api("GET", `/repos/${repository}/pulls/${number(pr)}`)
    if (value?.head?.repo?.full_name !== repository || value?.base?.repo?.full_name !== repository || value?.base?.ref !== "main") throw new Error("PR must be wholly inside the canary repository and based on main")
    branchName(value.head.ref, prefix)
    sha(value.head.sha)
    return value
  }
  const push = async (api, { branch, path, content, message, expectedHead }, prefix = "smithers/") => {
    branchName(branch, prefix)
    safeRelativePath(path)
    required(content, "file content")
    required(message, "commit message")
    const refPath = `/repos/${repository}/git/ref/heads/${branch}`
    const ref = await api("GET", refPath)
    const parent = sha(ref?.object?.sha)
    if (expectedHead && parent !== sha(expectedHead)) throw new Error("Canary branch moved before actor push")
    const previous = await api("GET", `/repos/${repository}/git/commits/${parent}`)
    const blob = await api("POST", `/repos/${repository}/git/blobs`, { content, encoding: "utf-8" })
    const tree = await api("POST", `/repos/${repository}/git/trees`, { base_tree: sha(previous?.tree?.sha), tree: [{ path, mode: "100644", type: "blob", sha: sha(blob?.sha) }] })
    const commit = await api("POST", `/repos/${repository}/git/commits`, { message, tree: sha(tree?.sha), parents: [parent] })
    // force:false is GitHub's fast-forward compare: a concurrent agent push
    // makes this fail instead of overwriting the person's or agent's work.
    await api("PATCH", `/repos/${repository}/git/refs/heads/${branch}`, { sha: sha(commit?.sha), force: false })
    await log({ event: "github.push", branch, parent, sha: commit.sha })
    return commit
  }
  return {
    identities,
    verifyAccess: verifyActorAccess,
    async reviewComment(actor, { pr, commitSha, path, line, body }) {
      const api = apiFor(actor)
      const value = await pull(api, pr)
      if (value.head.sha !== sha(commitSha)) throw new Error("Review comment head is stale")
      safeRelativePath(path)
      number(line)
      return await api("POST", `/repos/${repository}/pulls/${pr}/comments`, { body: required(body, "review comment"), commit_id: commitSha, path, line, side: "RIGHT" })
    },
    async pushTodo(actor, input) { return await push(apiFor(actor), input) },
    async mergePr(actor, { pr, expectedHead }) {
      const api = apiFor(actor)
      const value = await pull(api, pr)
      if (value.head.sha !== sha(expectedHead)) throw new Error("Merge head is stale")
      const result = await api("PUT", `/repos/${repository}/pulls/${pr}/merge`, { sha: expectedHead, merge_method: "squash" })
      if (result?.merged !== true) throw new Error("GitHub did not report a completed merge")
      return result
    },
    async setPrState(actor, { pr, state }) {
      if (!["closed", "open"].includes(state)) throw new Error("PR state must be closed or open")
      const api = apiFor(actor)
      const value = await pull(api, pr)
      if (value.merged) throw new Error("Cannot close/reopen a merged PR")
      return await api("PATCH", `/repos/${repository}/pulls/${pr}`, { state })
    },
    async unrelatedMerge(actor, { branch, content, message }) {
      const api = apiFor(actor)
      branchName(branch, "journey/")
      required(content, "file content")
      required(message, "commit message")
      const main = await api("GET", `/repos/${repository}/git/ref/heads/main`)
      await api("POST", `/repos/${repository}/git/refs`, { ref: `refs/heads/${branch}`, sha: sha(main?.object?.sha) })
      const commit = await push(api, { branch, path: "docs/unrelated.md", content, message, expectedHead: main.object.sha }, "journey/")
      const opened = await api("POST", `/repos/${repository}/pulls`, { title: message, head: branch, base: "main", body: "MVP canary: unrelated change" })
      const value = await pull(api, opened.number, "journey/")
      if (value.head.sha !== commit.sha) throw new Error("Unrelated PR head changed")
      const merged = await api("PUT", `/repos/${repository}/pulls/${opened.number}/merge`, { sha: commit.sha, merge_method: "squash" })
      if (merged?.merged !== true) throw new Error("Unrelated merge did not complete")
      return { pr: opened.number, ...merged }
    }
  }
}

if (isMain(import.meta.url)) await cli(async () => {
  const [repository, actor, action, inputPath] = process.argv.slice(2)
  const { readFile } = await import("node:fs/promises")
  const log = await createStepLog(new URL(`../../.artifacts/checks/C-J10-01/${new Date().toISOString()}/`, import.meta.url).pathname)
  const actors = await githubActors({ repository, log })
  if (!["reviewComment", "pushTodo", "mergePr", "setPrState", "unrelatedMerge"].includes(action)) throw new Error("Unknown GitHub actor action")
  const result = await actors[action](actor, JSON.parse(await readFile(required(inputPath, "action JSON file"), "utf8")))
  await log({ event: "github.action.completed", actor, action, id: result.id ?? result.pr ?? null, sha: result.sha ?? null })
})
