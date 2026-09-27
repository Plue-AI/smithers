/**
 * Local jj operations and landing requests, with backend merge gates intact.
 * @since 0.1.0
 */

import { type Client, esc, list, object, pick, positive, query, str } from "./Client.ts"
import type { Handler } from "./Resources.ts"
/**
 * @private
 * @since 1.0.0
 */
export const lines = (text: string): Array<string> => text.split("\n").filter((line) => line.trim())
/**
 * @private
 * @since 1.0.0
 */
export const revision = (c: Client, rev: string) => {
  const [change_id, commit_id, ...description] = c.exec("jj", [
    "log",
    "-r",
    rev,
    "--no-graph",
    "-T",
    "change_id ++ \"\\t\" ++ commit_id ++ \"\\t\" ++ description.first_line() ++ \"\\n\""
  ]).split("\t")
  if (!change_id) throw new Error(`Unable to resolve revision ${rev}`)
  return { change_id, commit_id, description: description.join("\t") }
}
/**
 * @private
 * @since 1.0.0
 */
export const stackChanges = (c: Client, target: string) => {
  const revset = `(::@ ~ ::present(bookmarks(exact:${JSON.stringify(target)}))) ~ empty()`
  return lines(
    c.exec("jj", [
      "--ignore-working-copy",
      "log",
      "-r",
      revset,
      "--no-graph",
      "-T",
      "change_id ++ \"\\t\" ++ commit_id ++ \"\\n\""
    ])
  ).map((line) => {
    const [change_id, commit_id] = line.split("\t")
    const description = c.exec("jj", [
      "--ignore-working-copy",
      "log",
      "-r",
      change_id!,
      "--no-graph",
      "-T",
      "description ++ \"\\n\""
    ])
    return { change_id: change_id!, commit_id: commit_id!, description }
  }).filter((change) => change.description.trim())
}
const bookmarks = (c: Client, names: Array<string> = []) =>
  lines(
    c.exec("jj", [
      "bookmark",
      "list",
      "-T",
      "if(!remote, name ++ \"\\t\" ++ if(normal_target, normal_target.change_id() ++ \"\\t\" ++ normal_target.commit_id(), \"\\t\") ++ \"\\n\")",
      ...names
    ])
  ).map((line) => {
    const [name, change, commit] = line.split("\t")
    return { name, target_change_id: change || null, ...(commit ? { target_commit_id: commit } : {}) }
  })
const files = (c: Client, id: string) =>
  lines(c.exec("jj", ["diff", "--summary", "-r", id])).flatMap((line) => {
    const match = /^([A-Z!?~]+)\s+(.*)$/.exec(line)
    return match ? [{ status: match[1]!, path: match[2]!.trim() }] : []
  })
/**
 * @private
 * @since 1.0.0
 */
export const local: Record<string, Handler> = {}
local.status = async (c) => ({ working_copy: revision(c, "@"), parent: revision(c, "@-"), files: files(c, "@") })
local["bookmark list"] = async (c) => bookmarks(c)
local["bookmark create"] = async (c, a, o) => {
  c.exec("jj", ["bookmark", "create", str(a.name), ...(o.change ? ["-r", str(o.change)] : [])])
  return bookmarks(c, [str(a.name)])[0] ?? { name: a.name, target_change_id: o.change || null }
}
local["bookmark delete"] = async (c, a) => {
  if (!bookmarks(c, [str(a.name)]).some((bookmark) => bookmark.name === a.name)) {
    throw new Error(`Bookmark ${str(a.name)} was not found`)
  }
  c.exec("jj", ["bookmark", "delete", str(a.name)])
  return { status: "deleted", name: a.name }
}
local["change list"] = async (c, _a, o) =>
  lines(
    c.exec("jj", [
      "log",
      "-n",
      str(o.limit || 10),
      "--no-graph",
      "-T",
      "change_id ++ \"\\t\" ++ description.first_line() ++ \"\\n\""
    ])
  ).map((line) => {
    const [change_id, ...rest] = line.split("\t")
    return { change_id, description: rest.join("\t") }
  })
local["change show"] = async (c, a) => revision(c, str(a.id))
local["change diff"] = async (c, a) => ({
  change_id: a.id || "@",
  diff: c.exec("jj", ["diff", "-r", str(a.id || "@")])
})
for (const name of ["files", "conflicts"]) {
  local[`change ${name}`] = async (c, a) => ({
    change_id: a.id,
    [name]: files(c, str(a.id)).filter((file) => name === "files" || file.status.includes("C")).map((file) => file.path)
  })
}
local["land create"] = (c, _a, o) => {
  const change_ids = o.change || o["change-id"]
    ? [str(o["change-id"] || o.change)]
    : o.stack
    ? stackChanges(c, str(o.target)).map((change) => change.change_id)
    : [revision(c, "@").change_id]
  return c.request("POST", c.repoPath(o.repo) + "/landings", {
    title: o.title,
    body: str(o.body),
    target_bookmark: o.target,
    change_ids
  })
}
local["land list"] = (c, _a, o) =>
  c.pages(
    (cursor) =>
      c.repoPath(o.repo) + "/landings" +
      query({
        limit: o.limit,
        state: o.state === "all" ? undefined : o.state === "landed" ? "merged" : o.state,
        cursor
      }),
    str(o.cursor),
    o.all === true,
    "landings"
  )
for (const name of ["view", "review", "checks", "conflicts", "edit", "comment", "land"]) {
  local[`land ${name}`] = async (c, a, o) => {
    const base = c.repoPath(o.repo), path = `${base}/landings/${positive(a.number)}`
    if (name === "conflicts") {
      return c.request("GET", path + "/conflicts")
    }
    if (name === "edit") {
      return c.request("PATCH", path, {
        ...pick(o, ["title", "body"]),
        ...(o.target !== undefined ? { target_bookmark: o.target } : {})
      })
    }
    if (name === "land") {
      return c.request("PUT", path + "/land", { commit_id: o.commit })
    }
    if (name === "review") {
      return c.request("POST", path + "/reviews", {
        type: o.approve ? "approve" : "comment",
        body: str(o.body),
        commit_id: o.commit
      })
    }
    if (name === "comment") return c.request("POST", path + "/comments", { body: o.body, commit_id: o.commit })
    const landing = await c.request("GET", path)
    if (name === "checks") {
      const statuses: Array<unknown> = []
      for (const change_id of list(object(landing).change_ids)) {
        for (const status of list(await c.request("GET", `${base}/commits/${esc(change_id)}/statuses`))) {
          statuses.push({ ...object(status), change_id })
        }
      }
      return { landing, statuses }
    }
    return {
      landing,
      changes: await c.request("GET", path + "/changes?page=1&per_page=100"),
      reviews: await c.request("GET", path + "/reviews?page=1&per_page=100"),
      conflicts: await c.request("GET", path + "/conflicts")
    }
  }
}
