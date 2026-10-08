import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { HomeCardSchema } from "@smthrs/rpc/HomeCard"
import homeFixture from "../../../../../packages/backend/internal/compose/testdata/live/home.json"

// Exercises the mounted install cards and LiveChannel. Runtime coalescing and
// confirmed-stop ownership are independently covered by Linux Go conformance.
test("C-MCH-11: queued admission becomes Starting on Branch and Home", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  const home = HomeCardSchema.parse(structuredClone(homeFixture))
  const item = { ...home.items[0]!, n: 5, title: "Admission starts", state: "queued" as const, branch: { id: "admission-branch", name: "smithers/admission" }, queue: { reason: "machine" as const, position: 1 } }
  home.items = [item]
  home.counts = { queued: 1, starting: 0, working: 0, needs_you: 0, paused: 0, failed: 0, in_review: 0, merged: 0, dropped: 0 }
  let started = false
  const readers = new Map<string, { send: (frame: string) => void; id: number }>()
  const branch = () => ({ id: "admission-branch", name: "smithers/admission", machine: started ? { state: "waking" } : { state: "waiting", position: 1 }, item: { n: 5, title: item.title, state: started ? "starting" : "queued", place: 1 }, presence: [], terminals: [], ssh_line: "ssh -p 2222 admission@localhost" })
  await page.route("**/api/branches/smithers%2Fadmission", route => route.fulfill({ json: { name: "smithers/admission", machine: { id: "admission-branch" } } }))
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    const data = frame.topic === "home" ? home : frame.topic === "branch:admission-branch" ? branch() : frame.topic === "branch:admission-branch:activity" || frame.topic === "branch:admission-branch:files" ? [] : undefined
    if (data !== undefined) readers.set(frame.topic, { id: frame.id, send: value => socket.send(value) })
    socket.send(JSON.stringify(data === undefined ? { t: "err", id: frame.id, code: "unsupported" } : { t: "snap", id: frame.id, cursor: started ? 2 : 1, data }))
  }))
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Queued 1", exact: true })).toBeVisible()
  await say(page, "/branch smithers/admission")
  const card = page.getByRole("region", { name: "smithers/admission", exact: true }).last()
  await expect(card).toContainText("Waiting for a machine")
  await expect(card).toContainText("Waiting for a machine · #1")
  started = true
  const { queue: _queue, ...admitted } = item
  home.items = [{ ...admitted, state: "starting" }]
  home.counts = { ...home.counts, queued: 0, starting: 1 }
  const homeReader = readers.get("home")!, branchReader = readers.get("branch:admission-branch")!
  homeReader.send(JSON.stringify({ t: "delta", id: homeReader.id, cursor: 2, data: { Type: "todo.started", Data: { home: { items: home.items, counts: home.counts } } } }))
  branchReader.send(JSON.stringify({ t: "delta", id: branchReader.id, cursor: 2, data: { Type: "todo.started", Data: { card: { ...admitted, n: 5, state: "starting", branch: { id: "admission-branch", name: "smithers/admission", machine: { state: "waking" } } } } } }))
  await expect(card).toContainText("Starting")
  await expect(card).toContainText("Waking")
  await expect(card).not.toContainText("Waiting for a machine")
  await say(page, "/home")
  await expect(page.getByRole("list", { name: "Stack", exact: true }).last()).toContainText("Starting")
  await expect(page.getByRole("button", { name: "Working 1", exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByText("Starting", { exact: true }).last()).toBeVisible()
})
