import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { say } from "./j1-fixtures"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// Production command dispatcher, request persistence, LiveChannel and card.
// Machine execution and reference-host evidence are qualified separately.
test("C-UI-05: held admission leaves chat usable, and retry follows committed live state", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let admitted = false, head = 0
  let model = { ...structuredClone(fixtures.queued.model), n: 12, title: "Held launch" }
  const requests: string[] = []
  const retries: string[] = []
  let active: { id: number; send: (raw: string) => void } | undefined
  const publish = (next: typeof model) => {
    model = next; head++
    active?.send(JSON.stringify({ t: "delta", id: active.id, cursor: head, data: { Sequence: head, Type: "todo.run_updated", State: model.state, Data: { card: model } } }))
  }
  await page.route("**/api/todos", async route => {
    if (route.request().method() === "POST") {
      requests.push(route.request().headers()["idempotency-key"]!)
      await hold
      admitted = true
      await route.fulfill({ status: 202, json: { state: "accepted", n: 12 } })
    } else await route.fulfill({ json: admitted ? [model] : [] })
  })
  await page.route("**/api/todos/12", async route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON()
      expect(body.op).toBe("retry")
      retries.push(route.request().headers()["idempotency-key"]!)
      await route.fulfill({ status: 202, json: { state: "accepted", n: 12, attempt: 2 } })
    } else await route.fulfill({ json: model })
  })
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    if (frame.topic !== "todo:12") { socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" })); return }
    active = { id: frame.id, send: raw => socket.send(raw) }
    socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: head, data: model }))
  }))
  let chatAccepted = false
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: {} }))
  await page.route("**/api/conversations/main/prompt", async route => {
    expect(route.request().postDataJSON().prompt).toBe("What is waiting?")
    chatAccepted = true
    await route.fulfill({ status: 202, json: { status: "accepted", turnId: "independent-chat", terminal: false } })
  })
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: chatAccepted ? [{
    id: "independent-chat", author: 1, authorLogin: "ben", runId: "chat-run", prompt: "What is waiting?", state: "completed",
    frames: [{ runId: "chat-run", type: "delta", kind: "text", text: "The launch is waiting" }, { runId: "chat-run", type: "done", reason: "stop" }]
  }] : [] } }))
  await page.goto("/")
  await say(page, "/todo.new")
  await page.getByLabel("Title", { exact: true }).fill("Held launch")
  await page.getByLabel("Prompt", { exact: true }).fill("Exercise honest launch state")
  await page.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  await expect.poll(() => requests.length).toBe(1)
  await expect(page.getByText("Commit pending", { exact: true }).first()).toBeVisible()
  await expect(page.getByRole("region", { name: "Draft", exact: true }).getByText("Working", { exact: true })).toHaveCount(0)
  await say(page, "What is waiting?")
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await expect(page.locator('[data-shared-turn="independent-chat"]')).toContainText("The launch is waiting")
  release()
  const card = page.getByRole("article", { name: "TODO T12", exact: true })
  await expect(card).toContainText("Waiting for a machine")
  await page.reload()
  await say(page, "/todo T12")
  await expect(card).toContainText("Waiting for a machine")
  publish({ ...structuredClone(fixtures.failed.model), n: 12, title: "Held launch" })
  await expect(card).toContainText("Failed")
  await say(page, "/todo.retry T12")
  await say(page, "/todo.retry T12")
  await expect.poll(() => retries.length).toBe(1)
  publish({ ...structuredClone(fixtures.working.model), n: 12, title: "Held launch", run: { ...fixtures.working.model.run!, attempt: 2 } })
  await expect(card).toContainText("Working")
  expect(retries).toHaveLength(1)
  publish({ ...structuredClone(fixtures.in_review.model), n: 12, title: "Held launch", run: { ...fixtures.in_review.model.run!, attempt: 2 } })
  await expect(card).toContainText("In review")
  await page.reload()
  await say(page, "/todo T12")
  await expect(card).toContainText("In review")
  await expect(card).toHaveCount(1)
  expect(requests).toHaveLength(1)
  expect(retries).toHaveLength(1)
})
