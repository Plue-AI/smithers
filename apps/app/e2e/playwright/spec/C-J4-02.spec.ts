import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "@smthrs/rpc/TodoCard"

// App boundary receipt: HTTP projections, production dispatcher, real TODO seam,
// CardRenderers and Views. Actual flow/GitHub execution, streamed chat timing and
// reference-host qualification remain separate C-J4-02 requirements.
test("C-J4-02: served TODO cards answer, merge, move and retry while Chat stays usable", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/members", route => route.fulfill({ json: {
    members: [{ login: "canary-owner", name: "Will", avatar_url: "https://example.com/owner.png", color_index: 0,
      role: "owner", needs_access: false, suspended: false, actions: [] }],
    access_url: "https://github.com/smithers-mvp-canary/node/settings/access"
  } }))
  const models: TodoCard[] = [fixtures.in_review.model, fixtures.needs_you.model, fixtures.failed.model, fixtures.draft_pr.model]
    .map((model, index) => ({ ...structuredClone(model), n: index + 1, place: index + 1, title: `J4 TODO ${index + 1}` }))
  const writes: { n: number; body: Record<string, unknown>; key: string }[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: models }))
  await page.route(url => /^\/api\/todos\/[1-4](\/(answer|merge))?$/.test(url.pathname), async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    const n = Number(path.split("/")[3]), model = models[n - 1]!
    if (request.method() !== "POST") return route.fulfill({ json: model })
    const body = request.postDataJSON() as Record<string, unknown>
    writes.push({ n, body, key: request.headers()["idempotency-key"]! })
    if (path.endsWith("/answer")) {
      expect(body).toEqual({ answer: "Use the existing helper", wait: model.waits.find(wait => wait.kind === "question")!.id })
      model.waits = []; model.state = "working"
    } else if (path.endsWith("/merge")) {
      expect(body).toEqual({ reviewed_head_sha: fixtures.in_review.model.pr!.head })
      model.state = "merged"; model.merge = { state: "done", on_github: false }
    } else if (body.op === "move") {
      expect(body).toEqual({ op: "move", direction: "up" })
      model.place = 3; models[2]!.place = 4
    } else {
      expect(body).toEqual({ op: "retry", steer: "FIXED: fix the real bug, keep the test" })
      model.state = "queued"; model.run = { ...model.run!, attempt: 3 }
    }
    return route.fulfill({ status: 202, json: { state: "accepted", n,
      ...(body.op === "retry" ? { attempt: 3 } : {}), ...(body.op === "move" ? { place: 3 } : {}) } })
  })
  await page.goto("/")
  const card = (n: number) => page.getByRole("article", { name: `TODO T${n}` }).last()
  await say(page, "/todo T2")
  await card(2).getByLabel("Answer", { exact: true }).fill("Use the existing helper")
  await card(2).getByRole("button", { name: "Answer", exact: true }).press("Enter")
  await expect(card(2).locator("header .state")).toContainText("Working")
  await say(page, "/todo T1")
  await card(1).getByRole("button", { name: "Merge", exact: true }).press("Enter")
  await expect(card(1).locator("header .state")).toHaveText("Merged")
  await say(page, "/todo T4")
  await page.getByRole("button", { name: "Order J4 TODO 4", exact: true }).press("Enter")
  await page.getByRole("menuitem", { name: /Move up/ }).press("Enter")
  await expect.poll(() => writes.some(write => write.n === 4 && write.body.op === "move")).toBe(true)
  await expect(card(4)).toContainText("#3 in stack")
  await say(page, "/todo T3")
  const previousEvidence = structuredClone(models[2]!.evidence)
  const retry = card(3).locator("form").filter({ has: page.getByRole("button", { name: "Retry", exact: true }) })
  await retry.getByLabel("Steer", { exact: true }).fill("FIXED: fix the real bug, keep the test")
  await retry.getByRole("button", { name: "Retry", exact: true }).press("Enter")
  await page.keyboard.press("Enter")
  await expect.poll(() => writes.length).toBe(4)
  await expect(card(3).locator("header .state")).toContainText("Queued")
  const notice = page.locator('.notice[data-tone="live"]').filter({ hasText: "J4 TODO 3" })
  await expect(notice).toBeVisible()
  await say(page, "/todo T4")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await expect(notice).toBeVisible()
  models[2]!.state = "working"; models[2]!.failure = undefined
  await expect(card(3).locator("header .state")).toContainText("Working")
  await expect(notice).toHaveCount(0)
  expect(models[2]!.evidence).toEqual(previousEvidence)
  expect(writes.map(write => write.n)).toEqual([2, 1, 4, 3])
  expect(new Set(writes.map(write => write.key)).size).toBe(4)
  expect(writes.every(write => write.key.length > 0)).toBe(true)
})
