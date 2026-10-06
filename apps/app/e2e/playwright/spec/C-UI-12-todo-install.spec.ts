import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"

test("C-UI-12 TODO: Open branch reaches the install provider from a REST-served card", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  const model = {
    n: 24, title: "Retry from the install", state: "working",
    owner: { login: "canary-owner", name: "Ben", avatar_url: "https://example.test/avatar.png" },
    branch: { id: "b-live", name: "smithers/retry-webhooks", machine: { state: "asleep" } },
    prompt_revisions: [], steps: [], steers: [], evidence: [], present: [], waits: [],
    merge: { state: "waiting", reason: "attention", on_github: false }
  }
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  const todoReads: string[] = []
  await page.route("**/api/todos/24", route => {
    todoReads.push(route.request().method())
    return route.fulfill({ json: model })
  })
  const reads: string[] = []
  await page.route("**/api/branches/smithers%2Fretry-webhooks", route => {
    reads.push(route.request().method())
    return route.fulfill({ json: { name: "smithers/retry-webhooks", machine: { id: "b-live" } } })
  })
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    const data = frame.topic === "branch:b-live" ? {
      id: "b-live", name: "smithers/retry-webhooks", machine: { state: "asleep" },
      item: { n: 24, title: "Retry from the install", state: "working", place: 1 },
      presence: [], terminals: [], ssh_line: "ssh -p 2222 retry-webhooks@localhost"
    } : frame.topic === "branch:b-live:activity" || frame.topic === "branch:b-live:files" ? [] : undefined
    socket.send(JSON.stringify(data === undefined ? { t: "err", id: frame.id, code: "unsupported" } : { t: "snap", id: frame.id, cursor: 1, data }))
  }))
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible({ timeout: 120_000 })
  await say(page, "/todo T24")
  const todo = page.getByRole("article", { name: "TODO T24", exact: true })
  await expect(todo).toContainText("Retry from the install")
  await expect(todo.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await todo.getByRole("button", { name: "Open branch", exact: true }).press("Enter")
  const branch = page.getByTestId("card-branch:b-live")
  await expect(branch).toContainText("smithers/retry-webhooks")
  await expect(branch).toContainText("ssh -p 2222 retry-webhooks@localhost")
  await branch.getByRole("tab", { name: "Files", exact: true }).press("Enter")
  await expect(branch.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true")
  await page.reload()
  await expect(branch.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true")
  await branch.getByRole("tab", { name: "Terminals", exact: true }).press("Space")
  await expect(branch.getByRole("tab", { name: "Terminals", exact: true })).toHaveAttribute("aria-selected", "true")
  await branch.getByRole("tab", { name: "Activity", exact: true }).press("Enter")
  await expect(branch.getByRole("tab", { name: "Activity", exact: true })).toHaveAttribute("aria-selected", "true")
  const previousReads = todoReads.length
  const reopened = page.waitForRequest(request => request.url().endsWith("/api/todos/24") && request.method() === "GET")
  await branch.getByRole("button", { name: "Retry from the install", exact: true }).press("Enter")
  await reopened
  // REST polling continues while no valid TODO live snapshot is served.
  await expect.poll(() => todoReads.length).toBeGreaterThan(previousReads)
  await expect(todo).toContainText("Retry from the install")
  expect(todoReads.every(method => method === "GET")).toBe(true)
  expect(reads).toEqual(["GET"])
  await expect(page.getByTestId("composer-input")).toBeEnabled()
})


for (const conflict of [false, true]) test(`C-UI-12 TODO: Discard confirms the displayed outside push before the real seam submits${conflict ? "; stale answer refreshes the newer push" : ""}`, async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  // Discard is a maintainer decision; the shared fixture remains a member.
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/members", route => route.fulfill({ json: {
    members: [{ login: "canary-owner", name: "Ben", avatar_url: "https://example.test/avatar.png", role: "owner",
      color_index: 0, needs_access: false, suspended: false, actions: [] }],
    access_url: "https://github.com/acme/app/settings/access"
  } }))
  const model = {
    n: 24, title: "Retry from the install", state: "needs_you",
    owner: { login: "canary-owner", name: "Ben", avatar_url: "https://example.test/avatar.png" },
    branch: { id: "b-live", name: "smithers/retry-webhooks", machine: { state: "asleep" } },
    prompt_revisions: [], steps: [], steers: [], evidence: [], present: [],
    waits: [{ id: "foreign-1", kind: "foreign_push", prompt: "Alice pushed", since: "2026-10-05T12:00:00Z",
      sha: "1111111111111111111111111111111111111111", by: { kind: "github", login: "alice", color_index: 7 },
      actions: [{ tag: "branch.discard-foreign", label: "Discard" }] }],
    merge: { state: "waiting", reason: "attention", on_github: false }
  }
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/24", route => route.fulfill({ json: model }))
  const requests: { body: unknown; key: string | undefined }[] = []
  let finish: (() => void) | undefined
  await page.route("**/api/branches/smithers%2Fretry-webhooks", async route => {
    requests.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] })
    if (conflict && requests.length === 1) {
      model.waits[0]!.sha = "2222222222222222222222222222222222222222"
      model.waits[0]!.prompt = "Alice pushed again"
      await route.fulfill({ status: 409, json: { class: "conflict", code: "conflict", message: "Outside push changed; refresh the TODO" } })
      return
    }
    await new Promise<void>(resolve => { finish = resolve })
    model.waits = []
    model.state = "working"
    await route.fulfill({ status: 202, json: { state: "accepted", n: 24 } })
  })
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible({ timeout: 120_000 })
  await say(page, "/todo T24")
  const todo = page.getByRole("article", { name: "TODO T24", exact: true })
  await expect(todo).toContainText("Alice pushed")
  await expect(todo.getByRole("button", { name: "Bring in", exact: true })).toHaveCount(0)
  await todo.getByRole("button", { name: "Discard", exact: true }).press("Enter")
  const confirm = page.getByRole("button", { name: "Confirm: discard this outside push", exact: true }).last()
  await expect(confirm).toBeVisible()
  expect(requests).toEqual([])
  await confirm.press("Enter")
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]!.body).toEqual({ op: "discard-foreign", id: "foreign-1", revision: "1111111111111111111111111111111111111111" })
  expect(requests[0]!.key).toBeTruthy()
  if (conflict) {
    await expect(todo).toContainText("Alice pushed again")
    await expect(page.getByText("Outside push changed; refresh the TODO", { exact: false }).first()).toBeVisible()
    await todo.getByRole("button", { name: "Discard", exact: true }).press("Enter")
    await page.getByRole("button", { name: "Confirm: discard this outside push", exact: true }).last().press("Enter")
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[1]!.body).toEqual({ op: "discard-foreign", id: "foreign-1", revision: "2222222222222222222222222222222222222222" })
    expect(requests[1]!.key).not.toBe(requests[0]!.key)
  }
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await expect(todo).toContainText("Alice pushed")
  finish!()
  await expect(todo).not.toContainText("Alice pushed")
  await expect(todo.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0)
})
