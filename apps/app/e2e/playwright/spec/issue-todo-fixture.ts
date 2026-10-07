import type { Page } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "@smthrs/rpc/TodoCard"

export const ISSUE_REPO = "smithers-mvp-canary/node"
export const snapshotDigest = "a".repeat(64)
export async function issueTodoInstall(page: Page, label = false) {
  await installCloudFixture(page, { capabilities: ["identity", "install"], repos: [{ owner: "smithers-mvp-canary", name: "node", full_name: ISSUE_REPO, default_bookmark: "main", owner_type: "User" }] })
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: { ...installFixture(), repository: { owner: "smithers-mvp-canary", name: "node" }, repositories: [ISSUE_REPO] } }))
  await page.route("**/api/members", route => route.fulfill({ json: {
    members: [{ login: "canary-owner", name: "Canary owner", avatar_url: "https://example.com/owner.png", color_index: 0,
      role: "owner", needs_access: false, suspended: false, actions: [] }],
    access_url: `https://github.com/${ISSUE_REPO}/settings/access`
  } }))
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: ISSUE_REPO }] } }))
  const make = (n: number, text: string): TodoCard => ({ ...fixtures.queued.model, n, title: n === 1 && label ? "Retry webhooks" : `Fixture ${n}`, place: n, issue: undefined, prompt_revisions: [{ ...fixtures.queued.model.prompt_revisions[0]!, text, acceptance: [] }] })
  let todos = label ? [make(1, "Retry webhooks\n\nB1")] : [make(1, "First"), make(2, "Second")]
  const commits: unknown[] = []
  const committedKeys = new Set<string>()
  const thread = (n: number) => ({ issue_digest: snapshotDigest, make_todo_allowed: true,
    issue: { number: n, title: label ? "Retry webhooks v2" : "Webhooks fail on 502", body: label ? "B2" : "Webhooks fail on 502", state: "open", html_url: `https://github.com/${ISSUE_REPO}/issues/${n}`, user: { login: "ben" }, labels: [], assignees: [] },
    comments: label ? [] : [{ id: 1, body: "retry at most 5 times with jittered backoff", user: { login: "alice" } }] })
  await page.route(url => /^\/api\/issues\/\d+$/.test(url.pathname), route => route.fulfill({ json: thread(Number(new URL(route.request().url()).pathname.split("/").pop())) }))
  await page.route("**/api/todos", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: todos })
    const key = route.request().headers()["idempotency-key"]!
    if (committedKeys.has(key)) return route.fulfill({ status: 202, json: { state: "accepted", n: 3, rev: 1 } })
    committedKeys.add(key)
    const body = route.request().postDataJSON(); commits.push(body)
    const made = { ...make(3, body.prompt), title: body.title, place: 2, issue: { number: 7, url: `https://github.com/${ISSUE_REPO}/issues/7`, fixes: body.fixes }, prompt_revisions: [{ ...fixtures.queued.model.prompt_revisions[0]!, text: body.prompt, acceptance: body.acceptance }] }
    todos = [todos[0]!, made, { ...todos[1]!, place: 3 }]
    return route.fulfill({ status: 202, json: { state: "accepted", n: 3, rev: 1 } })
  })
  await page.route(url => /^\/api\/todos\/\d+$/.test(url.pathname), route => route.fulfill({ json: todos.find(todo => todo.n === Number(new URL(route.request().url()).pathname.split("/").pop())) }))
  return commits
}
