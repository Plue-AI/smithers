import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { say } from "./j1-fixtures"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// Production dispatcher, LiveChannel and TODO seam/card. The independent
// committed-source oracle and actual PostgreSQL upgrade/replay are qualified
// by live_channel_integration_test.go and live_todo_cards_integration_test.go.
test("C-COL-02: a TODO card resumes committed facts once and recovers a gap", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  const queued = { ...structuredClone(fixtures.queued.model), n: 12, title: "Replay this TODO" }
  const facts = [
    { Sequence: 1, Type: "todo.run_updated", State: "starting", Data: { card: { ...structuredClone(fixtures.starting.model), n: 12, title: "Replay this TODO" } } },
    { Sequence: 2, Type: "todo.run_updated", State: "working", Data: { card: { ...structuredClone(fixtures.working.model), n: 12, title: "Replay this TODO" } } },
    { Sequence: 3, Type: "todo.run_updated", State: "needs_you", Data: { card: { ...structuredClone(fixtures.needs_you.model), n: 12, title: "Replay this TODO" } } },
    { Sequence: 4, Type: "todo.run_updated", State: "in_review", Data: { card: { ...structuredClone(fixtures.in_review.model), n: 12, title: "Replay this TODO" } } }
  ]
  let head = 0
  let active: { id: number; send: (raw: string) => void; close: () => void } | undefined
  const subscriptions: Array<number | undefined> = []
  const model = () => head === 0 ? queued : facts[head - 1]!.Data.card
  await page.route("**/api/todos", route => route.fulfill({ json: [model()] }))
  await page.route("**/api/todos/12", route => route.fulfill({ json: model() }))
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    if (frame.topic !== "todo:12") { socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" })); return }
    subscriptions.push(frame.cursor)
    active = { id: frame.id, send: raw => socket.send(raw), close: () => socket.close({ code: 1001, reason: "fixture network fault" }) }
    if (frame.cursor === undefined) socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: head, data: model() }))
    else for (const fact of facts.slice(frame.cursor, head)) socket.send(JSON.stringify({ t: "delta", id: frame.id, cursor: fact.Sequence, data: fact }))
  }))
  await page.goto("/")
  await say(page, "/todo T12")
  const card = page.getByRole("article", { name: "TODO T12", exact: true })
  await expect(card).toContainText("Replay this TODO")
  await expect.poll(() => subscriptions.length).toBe(1)
  expect(subscriptions).toEqual([undefined])
  head = 1
  active!.send(JSON.stringify({ t: "delta", id: active!.id, cursor: 1, data: facts[0] }))
  await expect(card).toContainText("Starting")
  head = 2
  active!.send(JSON.stringify({ t: "delta", id: active!.id, cursor: 2, data: facts[1] }))
  await expect(card).toContainText("Working")
  active!.close()
  head = 4 // Two facts commit while the client has no connection.
  await expect.poll(() => subscriptions.length).toBe(2)
  expect(subscriptions).toEqual([undefined, 2])
  await expect(card).toContainText("In review")
  await expect(card).toHaveCount(1)
  active!.send(JSON.stringify({ t: "gap", id: active!.id }))
  await expect.poll(() => subscriptions.length).toBe(3)
  expect(subscriptions).toEqual([undefined, 2, undefined])
  await expect(card).toContainText("In review")
  await page.reload()
  await say(page, "/todo T12")
  await expect(card).toContainText("In review")
  await expect(card).toHaveCount(1)
})
