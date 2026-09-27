/**
 * Stacked GitHub requests backed by the existing stack API.
 * @since 1.0.0
 */

import { APIError, type Client, esc, list, object, query, str, type Values } from "./Client.ts"
import { stackChanges } from "./Local.ts"
import type { Handler } from "./Resources.ts"

const missing = (error: unknown, codes = [404]) => error instanceof APIError && codes.includes(error.status)
const authSource = (c: Client) => c.env.GITHUB_TOKEN ? "github_token" : "server_github_app_installation"
const branch = (change: Values) => str(change.branch_name) || `smithers/${str(change.change_id).slice(0, 8)}`
const mapped = (value: unknown) =>
  list(object(value).changes).map(object).filter((change) => change.change_id).sort((a, b) =>
    Number(a.position ?? 2 ** 30) - Number(b.position ?? 2 ** 30)
  )
const target = (o: Values) => str(o.target).trim() || "main"
const endpoint = (c: Client, o: Values) => c.repoPath(o.repo) + "/stacks/active"
const load = async (c: Client, o: Values) => {
  try {
    return object(await c.request("GET", endpoint(c, o) + query({ target_ref: target(o) })))
  } catch (error) {
    if (missing(error)) return {}
    throw error
  }
}
const remove = async (c: Client, o: Values) => {
  try {
    await c.request("DELETE", endpoint(c, o) + query({ target_ref: target(o) }))
  } catch (error) {
    if (!missing(error)) throw error
  }
}
const github = async (c: Client, o: Values, method: string, path: string, body?: Values) => {
  const full = `/repos/${c.repo(o.repo)}${path}`
  const data = c.env.GITHUB_TOKEN
    ? await c.request(method, full, body, {
      origin: c.env.SMITHERS_GITHUB_API_URL || "https://api.github.com",
      token: c.env.GITHUB_TOKEN,
      headers: {
        authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    })
    : await c.request("POST", c.repoPath(o.repo) + "/github-proxy", { method, path: full, ...(body ? { body } : {}) })
  return Array.isArray(data) ? { items: data } : object(data)
}
const description = (change: Values) => {
  const [title, ...body] = str(change.description).trim().split("\n")
  return { title: title || str(change.change_id), body: body.join("\n").trim() }
}
const summary = (c: Client, changes: Array<Values>) =>
  changes.map((change) => ({
    auth_source: authSource(c),
    branch: branch(change),
    change_id: change.change_id,
    pr_number: change.pr_number,
    pr_url: change.pr_url,
    push_target: `origin/${branch(change)}`,
    ...(change.title ? { title: change.title } : {}),
    ...(change.status ? { status: change.status } : {})
  }))
const blockStart = "<!-- smithers:stack:start -->", blockEnd = "<!-- smithers:stack:end -->"
const body = (changes: Array<Values>, change: Values) => {
  let text = str(change.body).trim()
  const start = text.indexOf(blockStart), end = text.indexOf(blockEnd, start)
  if (start >= 0 && end >= 0) {
    text = [text.slice(0, start).trim(), text.slice(end + blockEnd.length).trim()].filter(Boolean).join("\n\n")
  }
  const block = [
    blockStart,
    "### Smithers Stack",
    "",
    "| | Change | PR | Branch |",
    "|---|---|---|---|",
    ...changes.map((row) =>
      `| ${row.change_id === change.change_id ? "→" : ""} | ${
        row.change_id === change.change_id ? `**${str(row.title)}**` : str(row.title)
      } | #${str(row.pr_number)} | \`${branch(row)}\` |`
    ),
    "",
    "> ⚠️ Do not merge this PR directly. Use `smithers stack land` to land changes in order.",
    "",
    "*Managed by Smithers*",
    blockEnd
  ].join("\n")
  return [text, block].filter(Boolean).join("\n\n")
}
const push = (c: Client, change: Values) => {
  c.exec("jj", ["--ignore-working-copy", "bookmark", "set", "-B", branch(change), "-r", str(change.change_id)])
  const session = c.env.GITHUB_TOKEN ? undefined : c.session.require()
  c.exec(
    "jj",
    ["--ignore-working-copy", "git", "push", "--bookmark", branch(change)],
    session
      ? {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: `http.https://${session.host}/.extraHeader`,
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${session.token}`,
        GIT_CONFIG_KEY_1: "http.followRedirects",
        GIT_CONFIG_VALUE_1: "false"
      }
      : {}
  )
}
const persist = (c: Client, o: Values, changes: Array<Values>) =>
  c.request("POST", endpoint(c, o), {
    target_ref: target(o),
    changes: changes.map((change, position) => ({
      branch_name: branch(change),
      change_id: change.change_id,
      position,
      pr_number: change.pr_number,
      pr_state: change.pr_state,
      ci_status: change.ci_status || "pending",
      review_status: change.review_status || "pending"
    }))
  })
const normalizeCI = (value: unknown) =>
  ["passing", "success", "passed"].includes(str(value))
    ? "passing"
    : ["failing", "failure", "failed", "error", "cancelled", "canceled"].includes(str(value))
    ? "failing"
    : "pending"
const normalizeReview = (value: unknown) => {
  const status = str(value).toLowerCase().replaceAll(/[ -]/g, "_")
  return ["approved", "changes_requested"].includes(status) ? status : "pending"
}
const refresh = async (c: Client, o: Values, change: Values, strict: boolean) => {
  const result: Values & { checks: Array<Values>; reviewers: Array<Values> } = {
    ...change,
    ci_status: normalizeCI(change.ci_status),
    review_status: normalizeReview(change.review_status),
    checks: [] as Array<Values>,
    reviewers: [] as Array<Values>,
    mergeable: false
  }
  if (!change.pr_number) return result
  try {
    const pull = await github(c, o, "GET", `/pulls/${str(change.pr_number)}`)
    Object.assign(result, {
      mergeable: pull.mergeable === true,
      pr_state: pull.merged ? "merged" : pull.state,
      pr_url: pull.html_url || change.pr_url
    })
    const sha = object(pull.head).sha
    if (sha) {
      result.checks = list((await github(c, o, "GET", `/commits/${esc(sha)}/check-runs`)).check_runs).map(object).map((
        run
      ) => ({
        name: run.name || "unnamed check",
        status: run.status !== "completed"
          ? "pending"
          : ["success", "neutral", "skipped"].includes(str(run.conclusion))
          ? "success"
          : ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"].includes(
              str(run.conclusion)
            )
          ? "failure"
          : "pending"
      }))
      result.ci_status = result.checks.some((check) => check.status === "failure")
        ? "failing"
        : !result.checks.length || result.checks.some((check) => check.status === "pending")
        ? "pending"
        : "passing"
    } else if (strict) result.ci_status = "pending"
    const latest = new Map<string, Values>()
    for (
      const review of list((await github(c, o, "GET", `/pulls/${str(change.pr_number)}/reviews`)).items).map(object)
    ) {
      const login = str(object(review.user).login), state = normalizeReview(review.state)
      if (login && state !== "pending") latest.set(login.toLowerCase(), { login, state })
    }
    result.reviewers = [...latest].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value)
    result.review_status = result.reviewers.some((review) => review.state === "changes_requested")
      ? "changes_requested"
      : result.reviewers.some((review) => review.state === "approved")
      ? "approved"
      : "pending"
    return result
  } catch (error) {
    if (strict) throw error
    return result
  }
}
const refusal = (change: Values) =>
  change.review_status !== "approved"
    ? "review is not approved"
    : change.ci_status !== "passing"
    ? `CI is ${str(change.ci_status)}`
    : change.pr_state !== "open"
    ? `PR is ${str(change.pr_state)}`
    : ""
const restack = async (c: Client, o: Values, changes: Array<Values>) => {
  if (!changes.length) {
    await remove(c, o)
    return { fetched: true, stack_deleted: true, stack_id: null, remaining: [] }
  }
  const local = new Map(stackChanges(c, target(o)).map((change) => [change.change_id, change]))
  for (const [index, change] of changes.entries()) {
    const match = local.get(str(change.change_id))
    if (!match) throw new Error(`Local stack is missing ${str(change.change_id)}; run smithers stack submit`)
    Object.assign(change, description(match))
    const [name, email] = c.exec("jj", [
      "--ignore-working-copy",
      "log",
      "-r",
      str(change.change_id),
      "--no-graph",
      "-T",
      "author.name() ++ \"\\t\" ++ author.email() ++ \"\\n\""
    ]).split("\t")
    c.exec("jj", [
      "--ignore-working-copy",
      ...(name ? ["--config", `user.name=${JSON.stringify(name)}`] : []),
      ...(email ? ["--config", `user.email=${JSON.stringify(email)}`] : []),
      "rebase",
      "--revisions",
      str(change.change_id),
      "--onto",
      index ? str(changes[index - 1]!.change_id) : target(o)
    ])
  }
  for (const change of changes) push(c, change)
  for (const [index, change] of changes.entries()) {
    const updated = await github(c, o, "PATCH", `/pulls/${str(change.pr_number)}`, {
      base: index ? branch(changes[index - 1]!) : target(o),
      title: change.title,
      body: body(changes, change)
    })
    Object.assign(change, { pr_state: updated.state || change.pr_state, pr_url: updated.html_url || change.pr_url })
  }
  const saved = object(await persist(c, o, changes))
  return { fetched: true, stack_deleted: false, stack_id: saved.id, remaining: summary(c, changes) }
}
/** @private
 * @since 1.0.0
 */
export const stacks: Record<string, Handler> = {}
stacks["stack submit"] = async (c, _a, o) => {
  const existing = mapped(await load(c, o)), changes: Array<Values> = []
  for (const change of stackChanges(c, target(o)).reverse()) {
    const entry: Values = { ...change, ...description(change), branch_name: branch(change), status: "created" }
    push(c, entry)
    const payload = { base: changes.length ? branch(changes.at(-1)!) : target(o), title: entry.title, body: entry.body }
    let pull: Values | undefined
    const prior = existing.find((item) => item.change_id === change.change_id)
    if (prior?.pr_number) {
      try {
        pull = await github(c, o, "PATCH", `/pulls/${str(prior.pr_number)}`, payload)
        entry.status = "updated"
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
    pull ??= await github(c, o, "POST", "/pulls", { ...payload, draft: o.draft === true, head: branch(change) })
    if (!(Number(pull.number) > 0)) throw new Error("GitHub did not return a PR number")
    changes.push({ ...entry, pr_number: pull.number, pr_state: pull.state || "open", pr_url: pull.html_url })
  }
  if (!changes.length) throw new Error("No non-empty changes found between @ and target")
  for (const change of changes) {
    await github(c, o, "PATCH", `/pulls/${str(change.pr_number)}`, { body: body(changes, change) })
  }
  const saved = object(await persist(c, o, changes))
  return {
    auth_source: authSource(c),
    change_ids: changes.map((change) => change.change_id),
    changes: summary(c, changes),
    pr_numbers: changes.map((change) => change.pr_number),
    push_target: "origin/smithers/*",
    stack_id: saved.id,
    target: target(o)
  }
}
stacks["stack unsubmit"] = async (c, _a, o) => {
  const existing = await load(c, o), prs: Array<Values> = [], branches: Array<Values> = []
  if (existing.id) {
    for (const change of mapped(existing)) {
      if (change.pr_number) {
        let status = "missing"
        try {
          const pull = await github(c, o, "GET", `/pulls/${str(change.pr_number)}`)
          status = "already_closed"
          if (pull.state === "open") {
            try {
              await github(c, o, "PATCH", `/pulls/${str(change.pr_number)}`, { state: "closed" })
              status = "closed"
            } catch (error) {
              if (
                !missing(error, [422]) ||
                (await github(c, o, "GET", `/pulls/${str(change.pr_number)}`)).state === "open"
              ) throw error
            }
          }
        } catch (error) {
          if (!missing(error)) throw error
        }
        prs.push({ pr_number: change.pr_number, status })
      }
      let status = "deleted"
      try {
        await github(c, o, "DELETE", `/git/refs/heads/${esc(branch(change))}`)
      } catch (error) {
        if (!missing(error, [404, 422])) throw error
        status = "missing"
      }
      branches.push({ branch: branch(change), status })
    }
    await remove(c, o)
  }
  return { branches, prs, stack_deleted: !!existing.id, target: target(o) }
}
stacks["stack status"] = async (c, _a, o) => {
  const existing = await load(c, o)
  if (!existing.id) return { changes: [], stack_id: null, state: "inactive", target: target(o) }
  const changes = mapped(existing)
  let locals: ReturnType<typeof stackChanges> = []
  try {
    locals = stackChanges(c, target(o))
  } catch { /* backend status works outside a local checkout */ }
  const ordered: Array<Values> = [
    ...locals.map((local) => ({ ...local, ...changes.find((change) => change.change_id === local.change_id) })),
    ...changes.filter((change) => !locals.some((local) => local.change_id === change.change_id))
  ]
  const output = []
  for (const change of ordered) {
    output.push(
      await refresh(c, o, {
        ...change,
        description: description(change).title,
        pr_number: change.pr_number || null,
        pr_state: change.pr_state || (change.pr_number ? "open" : null),
        pr_url: change.pr_url ||
          (change.pr_number ? `https://github.com/${c.repo(o.repo)}/pull/${str(change.pr_number)}` : null)
      }, false)
    )
  }
  return {
    changes: output,
    stack_id: existing.id,
    state: existing.state || "active",
    target: existing.target_ref || target(o)
  }
}
stacks["stack sync"] = async (c, _a, o) => {
  c.exec("jj", ["--ignore-working-copy", "git", "fetch"])
  const existing = await load(c, o), merged: Array<Values> = [], remaining: Array<Values> = []
  if (!existing.id) {
    return {
      fetched: true,
      merged,
      remaining,
      stack_deleted: false,
      stack_found: false,
      stack_id: null,
      target: target(o)
    }
  }
  for (const change of mapped(existing)) {
    if (!change.pr_number) throw new Error("Stack mapping is missing pr_number; run smithers stack submit")
    const pull = await github(c, o, "GET", `/pulls/${str(change.pr_number)}`)
    if (pull.state === "closed" && pull.merged === true) {
      merged.push({ branch: branch(change), change_id: change.change_id, pr_number: change.pr_number })
    } else {remaining.push({
        ...change,
        pr_state: pull.state || change.pr_state || "open",
        pr_url: pull.html_url || change.pr_url
      })}
  }
  return { ...await restack(c, o, remaining), merged, stack_found: true, target: target(o) }
}
stacks["stack land"] = async (c, _a, o) => {
  if (o.change !== undefined && (!str(o.change).trim() || o.all)) {
    throw new Error("Specify a non-empty --change or --all")
  }
  const existing = await load(c, o), landed: Array<Values> = []
  if (!existing.id) {
    return {
      fetched: false,
      landed,
      remaining: [],
      stack_deleted: false,
      stack_found: false,
      stack_id: null,
      target: target(o)
    }
  }
  let remaining: Array<Values> = []
  for (const change of mapped(existing)) {
    if (!change.pr_number) throw new Error("Stack mapping is missing pr_number")
    remaining.push(await refresh(c, o, change, true))
  }
  if (!remaining.length) throw new Error("Active stack has no changes to land")
  let count = 1
  if (o.change !== undefined) {
    const matches = remaining.map((change, index) => str(change.change_id).startsWith(str(o.change)) ? index : -1)
      .filter((index) => index >= 0)
    if (matches.length !== 1) throw new Error("Change prefix is missing or ambiguous")
    count = matches[0]! + 1
  } else if (o.all) {
    count = remaining.findIndex((change) => refusal(change))
    if (count < 0) count = remaining.length
    if (!count) throw new Error(refusal(remaining[0]!))
  }
  for (const change of remaining.slice(0, count)) {
    if (refusal(change)) throw new Error(`Refusing to land PR #${str(change.pr_number)}: ${refusal(change)}`)
  }
  let result: Values = {}
  for (let index = 0; index < count; index++) {
    const change = await refresh(c, o, remaining[0]!, true)
    if (refusal(change)) throw new Error(`Refusing to land PR #${str(change.pr_number)}: ${refusal(change)}`)
    let merged = false
    for (const method of ["merge", "squash", "rebase"]) {
      try {
        const response = await github(c, o, "PUT", `/pulls/${str(change.pr_number)}/merge`, { merge_method: method })
        if (response.merged === false) throw new Error("GitHub did not merge the PR")
        merged = true
        break
      } catch (error) {
        if (!missing(error, [405])) throw error
      }
    }
    if (!merged) throw new Error("GitHub rejected available merge methods")
    landed.push(summary(c, [change])[0]!)
    remaining = remaining.slice(1)
    c.exec("jj", ["--ignore-working-copy", "git", "fetch"])
    result = await restack(c, o, remaining)
  }
  return { ...result, landed, stack_found: true, target: target(o) }
}
