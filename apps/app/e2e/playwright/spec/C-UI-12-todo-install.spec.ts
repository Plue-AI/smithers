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
  await branch.getByRole("button", { name: "Retry from the install", exact: true }).press("Enter")
  await expect.poll(() => todoReads.length).toBe(previousReads + 1)
  await expect(todo).toContainText("Retry from the install")
  expect(todoReads.every(method => method === "GET")).toBe(true)
  expect(reads).toEqual(["GET"])
  await expect(page.getByTestId("composer-input")).toBeEnabled()
})
