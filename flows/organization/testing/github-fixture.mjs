/**
 * A fake GitHub REST API for the organization's autonomy suites: one
 * repository's issues, comments, labels, branches, and pull requests in
 * memory, over HTTP on loopback. It answers the calls the host makes (the
 * issue sync's listings, the claim, the pull request) and records every
 * request, so a test can assert what was written and how often.
 *
 * `faults` lets a test make a call fail: `{ "POST /pulls": { status: 502, create: true, times: 1 } }`
 * answers 502 after creating the pull request (an unknown outcome), `create:
 * false` refuses without creating it.
 */
import { createServer } from "node:http"

/** Starts the fake API for `full` (`owner/name`). */
export const startGitHubFixture = async (full, options = {}) => {
  const [owner, name] = full.split("/")
  const state = {
    repository: { id: options.id ?? 4242, private: true, default_branch: "main", permissions: { push: true, pull: true } },
    issues: new Map(),
    comments: [],
    pulls: [],
    branches: new Set(options.branches ?? []),
    faults: { ...(options.faults ?? {}) }
  }
  const calls = []
  let clock = Date.parse("2026-09-26T10:00:00Z")
  const tick = () => new Date(clock += 1000).toISOString()
  let commentId = 900
  let pullNumber = 500

  const issueJson = (issue) => ({
    id: 10_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    html_url: `https://github.com/${full}/issues/${issue.number}`,
    user: { id: 1, login: issue.author ?? "owner" },
    labels: issue.labels.map((label) => ({ name: label })),
    assignees: issue.assignees.map((login) => ({ login })),
    created_at: issue.created_at,
    updated_at: issue.updated_at
  })
  const pullJson = (pull) => ({
    id: 20_000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    html_url: `https://github.com/${full}/pull/${pull.number}`,
    head: { ref: pull.head },
    base: { ref: pull.base },
    labels: pull.labels.map((label) => ({ name: label })),
    user: { id: 1, login: "owner" },
    created_at: pull.created_at,
    updated_at: pull.updated_at
  })
  const touch = (number) => {
    const issue = state.issues.get(number)
    if (issue !== undefined) issue.updated_at = tick()
  }

  const addIssue = (issue) => {
    const now = tick()
    state.issues.set(issue.number, {
      body: "",
      state: "open",
      labels: [],
      assignees: [],
      created_at: now,
      updated_at: now,
      ...issue
    })
  }
  for (const issue of options.issues ?? []) addIssue(issue)
  for (const pull of options.pulls ?? []) {
    const now = tick()
    state.pulls.push({ state: "open", labels: [], base: "main", created_at: now, updated_at: now, title: "PR", body: "", ...pull })
  }

  const fault = (key) => {
    const found = state.faults[key]
    if (found === undefined || found.times === 0) return undefined
    if (found.times !== undefined) found.times -= 1
    return found
  }

  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => body += chunk)
    request.on("end", () => {
      const url = new URL(request.url, "http://127.0.0.1")
      const payload = body === "" ? undefined : JSON.parse(body)
      calls.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: payload, authorization: request.headers.authorization })
      const send = (status, json, headers = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers })
        response.end(json === undefined ? "" : JSON.stringify(json))
      }
      const base = `/repos/${owner}/${name}`
      const path = url.pathname
      if (!path.startsWith(base)) return send(404, { message: "Not Found" })
      const rest = path.slice(base.length)
      const since = url.searchParams.get("since")
      const after = (item) => since === null || Date.parse(item.updated_at) >= Date.parse(since)
      let match
      if (request.method === "GET" && rest === "") return send(200, { ...state.repository, full_name: full })
      if (request.method === "GET" && rest === "/issues") {
        const items = [...state.issues.values(), ...state.pulls.map((pull) => ({ ...pull, isPull: true }))]
          .filter(after)
          .sort((left, right) => Date.parse(left.updated_at) - Date.parse(right.updated_at))
          .map((item) => item.isPull ? { ...pullJson(item), pull_request: { url: "x" }, assignees: [] } : issueJson(item))
        return send(200, items)
      }
      if (request.method === "GET" && rest === "/issues/comments") {
        return send(200, state.comments.filter(after).map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { id: 2, login: "org-bot" },
          html_url: `https://github.com/${full}/issues/${comment.issue}#issuecomment-${comment.id}`,
          issue_url: `https://api.github.com/repos/${full}/issues/${comment.issue}`,
          created_at: comment.created_at,
          updated_at: comment.updated_at
        })))
      }
      if ((match = /^\/issues\/(\d+)$/.exec(rest)) !== null && request.method === "GET") {
        const issue = state.issues.get(Number(match[1]))
        return issue === undefined ? send(404, { message: "Not Found" }) : send(200, issueJson(issue))
      }
      if ((match = /^\/issues\/(\d+)\/labels$/.exec(rest)) !== null && request.method === "POST") {
        const number = Number(match[1])
        const target = state.issues.get(number) ?? state.pulls.find((pull) => pull.number === number)
        if (target === undefined) return send(404, { message: "Not Found" })
        for (const label of payload.labels) if (!target.labels.includes(label)) target.labels.push(label)
        touch(number)
        return send(200, target.labels.map((label) => ({ name: label })))
      }
      if ((match = /^\/issues\/(\d+)\/labels\/(.+)$/.exec(rest)) !== null && request.method === "DELETE") {
        const issue = state.issues.get(Number(match[1]))
        const label = decodeURIComponent(match[2])
        if (issue === undefined || !issue.labels.includes(label)) return send(404, { message: "Label does not exist" })
        issue.labels = issue.labels.filter((each) => each !== label)
        touch(issue.number)
        return send(200, issue.labels.map((each) => ({ name: each })))
      }
      if ((match = /^\/issues\/(\d+)\/comments$/.exec(rest)) !== null) {
        const number = Number(match[1])
        if (request.method === "GET") {
          return send(200, state.comments.filter((comment) => comment.issue === number).map((comment) => ({
            id: comment.id,
            body: comment.body,
            html_url: `https://github.com/${full}/issues/${number}#issuecomment-${comment.id}`
          })))
        }
        if (request.method === "POST") {
          const now = tick()
          const comment = { id: ++commentId, issue: number, body: payload.body, created_at: now, updated_at: now }
          state.comments.push(comment)
          touch(number)
          return send(201, { id: comment.id, body: comment.body, html_url: `https://github.com/${full}/issues/${number}#issuecomment-${comment.id}` })
        }
      }
      if ((match = /^\/issues\/comments\/(\d+)$/.exec(rest)) !== null && request.method === "PATCH") {
        const comment = state.comments.find((each) => each.id === Number(match[1]))
        if (comment === undefined) return send(404, { message: "Not Found" })
        comment.body = payload.body
        comment.updated_at = tick()
        touch(comment.issue)
        return send(200, { id: comment.id, body: comment.body, html_url: `https://github.com/${full}/issues/${comment.issue}#issuecomment-${comment.id}` })
      }
      if ((match = /^\/branches\/(.+)$/.exec(rest)) !== null && request.method === "GET") {
        const branch = decodeURIComponent(match[1])
        return state.branches.has(branch) ? send(200, { name: branch }) : send(404, { message: "Branch not found" })
      }
      if (rest === "/pulls" && request.method === "GET") {
        const head = url.searchParams.get("head")
        const wanted = url.searchParams.get("state") ?? "open"
        return send(200, state.pulls
          .filter((pull) => wanted === "all" || pull.state === wanted)
          .filter((pull) => head === null || `${owner}:${pull.head}` === head)
          .map(pullJson))
      }
      if (rest === "/pulls" && request.method === "POST") {
        const injected = fault("POST /pulls")
        if (injected !== undefined && injected.create === false) return send(injected.status, { message: "refused by the fixture" })
        if (state.pulls.some((pull) => pull.head === payload.head && pull.state === "open")) {
          return send(422, { message: "Validation Failed", errors: [{ message: "A pull request already exists" }] })
        }
        const now = tick()
        const pull = { number: ++pullNumber, title: payload.title, body: payload.body, head: payload.head, base: payload.base, state: "open", labels: [], created_at: now, updated_at: now }
        state.pulls.push(pull)
        if (injected !== undefined) return send(injected.status, { message: "the fixture lost the answer" })
        return send(201, pullJson(pull))
      }
      return send(404, { message: `no fixture route for ${request.method} ${path}` })
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    apiBaseUrl: `http://127.0.0.1:${server.address().port}`,
    state,
    calls,
    addIssue,
    /** The writes the host made (every non-GET call). */
    writes: () => calls.filter((call) => call.method !== "GET"),
    close: () => new Promise((resolve) => server.close(resolve))
  }
}
