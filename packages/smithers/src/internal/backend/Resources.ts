/**
 * Backend issue, wiki, organization and repository resource commands.
 * @since 0.1.0
 */

import { mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { Refused, UsageError } from "../../CliError.ts"
import { chunksOf, type Client, esc, list, object, pick, positive, query, str, type Values } from "./Client.ts"
import * as ProductApi from "./ProductApi.ts"

/**
 * @private
 * @since 1.0.0
 */
export type Handler = (client: Client, args: Values, options: Values) => Promise<unknown>
/**
 * @private
 * @since 1.0.0
 */
export const resources: Record<string, Handler> = {}
const add = (name: string, handler: Handler) => {
  resources[name] = handler
}
const repo = (c: Client, o: Values, suffix: string) => c.repoPath(o.repo) + suffix
const page = (o: Values) => ({ page: o.page ?? 1, per_page: o.limit ?? 30 })

add("issue create", (c, a, o) => {
  const title = str(o.title || a.title)
  if (!title.trim()) throw new UsageError({ message: "Issue title is required" })
  return c.request("POST", repo(c, o, "/issues"), {
    title,
    body: str(o.body),
    ...(o.assignee ? { assignees: [o.assignee] } : {})
  })
})
add(
  "issue list",
  (c, _a, o) =>
    c.pages(
      (cursor) =>
        repo(c, o, "/issues") +
        query({
          limit: o.limit ?? 30,
          // A saved view carries its own state; the API refuses both.
          ...(o.view ? { view: o.view } : { state: o.state === "all" ? undefined : o.state ?? "open" }),
          cursor
        }),
      str(o.cursor),
      o.all === true,
      "issues"
    )
)
add("issue view", (c, a, o) => c.request("GET", repo(c, o, `/issues/${positive(a.number)}`)))
add("issue views", (c, _a, o) => c.request("GET", repo(c, o, "/issue-views")))
for (const action of ["close", "reopen"]) {
  add(`issue ${action}`, async (c, a, o) => {
    const path = repo(c, o, `/issues/${positive(a.number)}`)
    if (o.comment) await c.request("POST", path + "/comments", { body: o.comment })
    return c.request("PATCH", path, { state: action === "close" ? "closed" : "open" })
  })
}
add("issue edit", async (c, a, o) => {
  const path = repo(c, o, `/issues/${positive(a.number)}`), body = pick(o, ["title", "body"])
  if (o.label) await c.request("POST", path + "/labels", { labels: [o.label] })
  if (o.assignee) {
    const current = object(await c.request("GET", path))
    const assignees = list(current.assignees).map((entry) => str(object(entry).login)).filter(Boolean)
    if (!assignees.some((login) => login.toLowerCase() === str(o.assignee).toLowerCase())) {
      assignees.push(str(o.assignee))
    }
    body.assignees = assignees
  }
  return c.request("PATCH", path, body)
})
add(
  "issue comment",
  (c, a, o) => c.request("POST", repo(c, o, `/issues/${positive(a.number)}/comments`), { body: o.body })
)
for (const action of ["list", "search", "view", "create", "edit", "delete", "revisions", "index", "history"]) {
  add(`wiki ${action}`, async (c, a, o) => {
    let suffix = "/wiki", method = "GET", body: Values | undefined
    let filters: Values = { visibility: o.visibility }
    if (action === "list" || action === "search") {
      if (action === "search") {
        suffix += "/search"
      }
      filters = { ...page(o), q: o.query, ...filters }
    }
    if (["view", "edit", "delete", "revisions"].includes(action)) suffix += `/${esc(a.slug)}`
    if (action === "revisions") {
      suffix += "/revisions"
      filters = { ...page(o), ...filters }
    }
    if (action === "history") {
      suffix += `/history/${positive(a["page-id"])}`
      filters = { ...page(o), ...filters }
    }
    if (action === "index") suffix += "/navigation/index"
    if (action === "create") {
      method = "POST"
      body = { title: o.title, slug: o.slug || null, body: str(o.body), ...pick(o, ["path"]) }
    }
    if (action === "edit") {
      method = "PATCH"
      body = pick(o, ["title", "slug", "body", "path"])
      if (Number(o["expected-revision"]) > 0) body.expected_revision = o["expected-revision"]
    }
    if (action === "delete") method = "DELETE"
    const result = await c.request(method, repo(c, o, suffix) + query(filters), body)
    return action === "delete" ? { status: "deleted", slug: a.slug } : result
  })
}
for (const category of ["repos", "issues", "code", "users"]) {
  add(`search ${category}`, (c, a, o) =>
    c.request(
      "GET",
      `/api/search/${category === "repos" ? "repositories" : category}` + query({ q: a.query, ...page(o) })
    ))
}
add("label list", (c, _a, o) => c.request("GET", repo(c, o, "/labels")))
add(
  "label create",
  (c, a, o) =>
    c.request("POST", repo(c, o, "/labels"), { name: a.name, color: o.color, description: str(o.description) })
)
add("label delete", async (c, a, o) => {
  await c.request("DELETE", repo(c, o, `/labels/${positive(a.id)}`))
  return { status: "deleted", id: Number(a.id) }
})
for (const kind of ["secret", "variable"]) {
  const plural = kind === "secret" ? "secrets" : "variables"
  add(`${kind} list`, (c, _a, o) => c.request("GET", repo(c, o, `/${plural}`)))
  add(`${kind} delete`, async (c, a, o) => {
    await c.request("DELETE", repo(c, o, `/${plural}/${esc(a.name)}`))
    return { status: "deleted", name: a.name }
  })
}
add("secret set", async (c, a, o) => {
  if (!o["body-stdin"]) throw new UsageError({ message: "Secret values require --body-stdin" })
  const value = await c.stdin("Secret")
  return c.request("POST", repo(c, o, "/secrets"), {
    name: a.name,
    value,
    ...(o["main-only"] ? { main_only: true } : {}),
    ...(list(o.host).length > 0 || list(o.header).length > 0
      ? { hosts: list(o.host), match_headers: list(o.header) }
      : {})
  })
})
add(
  "secret bind",
  (c, a, o) =>
    c.request("PATCH", repo(c, o, `/secrets/${esc(a.name)}`), { hosts: list(o.host), match_headers: list(o.header) })
)
add(
  "secret scope",
  (c, a, o) => c.request("PATCH", repo(c, o, `/secrets/${esc(a.name)}`), { main_only: a.scope === "main-only" })
)
add("variable get", (c, a, o) => c.request("GET", repo(c, o, `/variables/${esc(a.name)}`)))
add("variable set", (c, a, o) => c.request("POST", repo(c, o, "/variables"), { name: a.name, value: str(o.body) }))
add("ssh-key list", (c) => ProductApi.getApiUserKeys(c))
add("ssh-key add", (c, _a, o) => ProductApi.postApiUserKeys(c, { body: { title: str(o.title), key: str(o.key) } }))
add("ssh-key delete", async (c, a) => {
  const id = positive(a.id)
  await ProductApi.deleteApiUserKeysId(c, { path: { id } })
  return { status: "deleted", id }
})
add(
  "notification list",
  (c, _a, o) =>
    c.pages(
      (cursor) =>
        "/api/notifications/list" + query({ limit: o.limit ?? 30, status: o.unread ? "unread" : undefined, cursor }),
      str(o.cursor),
      o.all === true,
      "data"
    )
)
add("notification read", async (c, a, o) => {
  if (o.all) {
    await c.request("PUT", "/api/notifications/mark-read")
    return { status: "all_read" }
  }
  if (!a.id) throw new UsageError({ message: "Provide a notification ID or --all" })
  return c.request("PATCH", `/api/notifications/${esc(a.id)}`, { read: true })
})
for (const action of ["list", "stats", "clear"]) {
  add(`cache ${action}`, async (c, _a, o) => {
    return c.request(
      action === "clear" ? "DELETE" : "GET",
      repo(c, o, action === "stats" ? "/caches/stats" : "/caches") +
        query({ ...(action === "list" ? page(o) : {}), key: o.key, bookmark: o.bookmark })
    )
  })
}
add("cache token create", (c, _a, o) => c.request("POST", repo(c, o, "/build-cache/tokens"), { name: str(o.name) }))
add("cache token list", (c, _a, o) => c.request("GET", repo(c, o, "/build-cache/tokens")))
add("cache token revoke", async (c, _a, o) => {
  const id = positive(o.id)
  await c.request("DELETE", repo(c, o, `/build-cache/tokens/${id}`))
  return { revoked: id }
})
for (const action of ["create", "list", "view", "edit"]) {
  add(`org ${action}`, (c, a, o) => {
    const path = action === "list" ? "/api/user/orgs" : `/api/orgs${action === "create" ? "" : `/${esc(a.name)}`}`
    return c.request(
      action === "create" ? "POST" : action === "edit" ? "PATCH" : "GET",
      path,
      action === "create"
        ? { username: a.name, description: str(o.description), visibility: o.visibility }
        : action === "edit"
        ? { ...pick(o, ["description"]), ...(o.visibility ? { visibility: o.visibility } : {}) }
        : undefined
    )
  })
}
for (const action of ["list", "add", "remove"]) {
  add(`org member ${action}`, async (c, a) => {
    const path = `/api/orgs/${esc(a.org)}/members`
    const result = await c.request(
      action === "list" ? "GET" : action === "add" ? "POST" : "DELETE",
      path + (action === "remove" ? `/${esc(a.username)}` : ""),
      action === "add" ? { username: a.username } : undefined
    )
    return action === "remove" ? { status: "removed", org: a.org, username: a.username } : result
  })
}
for (const action of ["list", "create", "view", "edit", "delete"]) {
  add(`org team ${action}`, async (c, a, o) => {
    const path = `/api/orgs/${esc(a.org)}/teams` +
      (["view", "edit", "delete"].includes(action) ? `/${esc(a.team)}` : "")
    const result = await c.request(
      action === "create" ? "POST" : action === "edit" ? "PATCH" : action === "delete" ? "DELETE" : "GET",
      path,
      action === "create"
        ? { name: a.name, description: str(o.description), permission: o.permission }
        : action === "edit"
        ? { ...pick(o, ["name", "description"]), ...(o.permission ? { permission: o.permission } : {}) }
        : undefined
    )
    return action === "delete" ? { status: "deleted", org: a.org, team: a.team } : result
  })
}
for (const kind of ["member", "repo"]) {
  for (const action of ["list", "add", "remove"]) {
    add(`org team ${kind} ${action}`, async (c, a) => {
      const path = `/api/orgs/${esc(a.org)}/teams/${esc(a.team)}/${kind === "member" ? "members" : "repos"}` +
        (action === "list" ? "" : `/${kind === "member" ? esc(a.username) : c.repo(a.repo)}`)
      const result = await c.request(action === "list" ? "GET" : action === "add" ? "PUT" : "DELETE", path)
      return action === "remove"
        ? {
          status: "removed",
          org: a.org,
          team: a.team,
          ...(kind === "member" ? { username: a.username } : { repo: a.repo })
        }
        : result
    })
  }
}
for (const action of ["create", "get", "list", "land"]) {
  add(`changeset ${action}`, (c, _a, o) => {
    const path = `/api/orgs/${esc(o.org)}/changesets`
    if (action === "list") return c.request("GET", path + query(page(o)))
    if (action !== "create") {
      return c.request(
        action === "land" ? "POST" : "GET",
        `${path}/${positive(o.id)}${action === "land" ? "/land" : ""}`
      )
    }
    const members = list(o.member).flatMap((item) => str(item).split(",")).filter((item) => item.trim()).map((item) => {
      const equals = item.indexOf("=")
      const repo = item.slice(0, equals).trim(), change_id = item.slice(equals + 1).trim()
      if (equals < 1 || !repo || !change_id) throw new UsageError({ message: "Member must be REPO=CHANGE_ID" })
      return { repo, change_id }
    })
    if (!members.length) throw new UsageError({ message: "At least one --member is required" })
    return c.request("POST", path, {
      description: str(o.description),
      target_bookmark: o.target,
      members,
      ...(o.parent ? { parent_change_id: o.parent } : {})
    })
  })
}
for (const action of ["create", "list", "view", "update", "delete", "deliveries"]) {
  add(`webhook ${action}`, async (c, a, o) => {
    const path = repo(c, o, "/hooks") +
      (["view", "update", "delete", "deliveries"].includes(action) ? `/${positive(a.id)}` : "")
    if (action === "view") {
      return { hook: await c.request("GET", path), deliveries: await c.request("GET", path + "/deliveries") }
    }
    if (action === "deliveries") {
      return c.request(
        o.replay ? "POST" : "GET",
        path + "/deliveries" + (o.replay ? `/${positive(o.replay)}/redeliver` : "")
      )
    }
    const body: Values = {}
    if (action === "create" || action === "update") {
      if (o.url !== undefined) {
        body.url = o.url
      }
      if (o.events !== undefined) body.events = list(o.events).length ? o.events : action === "create" ? ["push"] : []
      if (o.active !== undefined) body.is_active = o.active
      if (o["secret-stdin"]) body.secret = await c.stdin("Webhook secret", true)
    }
    const result = await c.request(
      action === "create" ? "POST" : action === "update" ? "PATCH" : action === "delete" ? "DELETE" : "GET",
      path,
      ["create", "update"].includes(action) ? body : undefined
    )
    return action === "delete" ? { status: "deleted", id: a.id } : result
  })
}
add("artifact list", (c, a, o) => c.request("GET", repo(c, o, `/actions/runs/${positive(a.runId)}/artifacts`)))
add("artifact download", async (c, a, o) => {
  const record = object(
    await c.request("GET", repo(c, o, `/actions/runs/${positive(a.runId)}/artifacts/${esc(a.name)}/download`))
  )
  if (!record.download_url) {
    throw new Refused({ fault: "infra", code: "backend_protocol", message: "Artifact response omitted download_url" })
  }
  const name = str(record.name || a.name), safeName = basename(name.replaceAll("\\", "/"))
  if (!o.output && ["", ".", "..", "/"].includes(safeName)) {
    throw new UsageError({ message: "Artifact has no safe name" })
  }
  const path = resolve(str(o.output) || safeName)
  const response = await fetch(str(record.download_url), { signal: AbortSignal.timeout(300_000) })
  if (!response.ok) {
    throw new Refused({
      fault: "infra",
      code: "artifact_download_failed",
      message: `Artifact download failed (${response.status})`
    })
  }
  await mkdir(dirname(path), { recursive: true })
  // writeFile accepts an async iterable without buffering the artifact in memory.
  let bytes = 0
  async function* bounded() {
    if (response.body) {
      for await (const chunk of chunksOf(response.body)) {
        bytes += chunk.length
        if (bytes > 2 ** 31) {
          throw new Refused({ fault: "policy", code: "artifact_too_large", message: "Artifact exceeds 2 GiB" })
        }
        yield chunk
      }
    }
  }
  await writeFile(path, bounded())
  return { name, path, size: record.size, content_type: record.content_type }
})
