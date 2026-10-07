import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// UI projection of .specs/engineering/checks/C-J11-02.md.
// Written before implementation: mvp.md J11.2–J11.3, §6.14 Write flows, §6.12; lands with T-APP-05, T-FLW-04, T-FLW-05, T-FLW-07
test("C-J11-02: Source and Plan test a draft flow on a scratch branch", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J11.2–J11.3, §6.14 Write flows, §6.12; lands with T-APP-05, T-FLW-04, T-FLW-05, T-FLW-07")
// Seed hello with required name and custom presentation; TODO flow active D1.
// Source creates a Proposed TODO branch; editing inserts notify. Draft Run
// changes NOTES.md but ends before Propose. Process/GitHub absence needs host receipts.
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/hello')
  await expect(page.getByText(/Usage:/)).toHaveCount(0)
  await page.getByLabel('name', { exact: true }).last().fill('Ada')
  await page.getByRole('button', { name: 'Run', exact: true }).last().press('Enter')
  await page.getByRole('button', { name: 'Inspect', exact: true }).last().press('Enter')
  await expect(page.getByText('Hello, Ada', { exact: true }).last()).toBeVisible()
  await say(page, '/flow todo')
  await page.getByRole('button', { name: 'Source', exact: true }).last().press('Enter')
  await expect(page.getByText('flows/todo/flow.ts', { exact: true }).last()).toBeVisible()
  const source = page.getByRole('textbox', { name: /flow.ts/ }).last()
  // The seeded source includes this complete standalone check call.
  const original = await source.inputValue()
  expect(original).toContain('yield* check()')
  await source.fill(original.replace('yield* check()', 'yield* check()\n    yield* notify()'))
  await say(page, '/branch.fork')
  await page.getByLabel('Name', { exact: true }).last().fill('test-notify')
  await page.getByRole('button', { name: 'Fork', exact: true }).last().press('Enter')
  await say(page, '/flow todo')
  await page.getByRole('button', { name: 'Proposed', exact: true }).last().press('Enter')
  await page.getByRole('button', { name: 'Plan', exact: true }).last().press('Enter')
  await expect(page.getByRole('region', { name: /Plan/ }).last()).toContainText(/Check[\s\S]*Notify[\s\S]*Review/)
  await page.getByRole('button', { name: 'Run', exact: true }).last().press('Enter')
  await page.getByLabel(/Prompt|Input/).last().fill("Add the line 'draft' to NOTES.md")
  await page.getByRole('button', { name: 'Run', exact: true }).last().press('Enter')
  await expect(page.getByText('draft version', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Inspect', exact: true }).last().press('Enter')
  await expect(page.getByRole('button', { name: 'Notify', exact: true }).last()).toBeVisible()
  await expect(page.getByText('Completed', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('region', { name: /Selected step|Selected cell/ }).last()).not.toContainText('Hello, Ada')
  await say(page, '/flow todo')
  await page.getByRole('button', { name: 'Active', exact: true }).last().press('Enter')
  await expect(page.getByText('D1', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Proposed', exact: true }).last()).toBeVisible()
  await say(page, '/stack')
  await expect(page.getByRole('region', { name: /Stack/ }).last()).not.toContainText('test-notify')
})

// Install-seam projection proof. Machine execution, source editing and absence
// of GitHub writes still require the complete reference-host journey above.
test("C-J11-02: installed draft Run and Inspect retain their label after reload", async ({ page }) => {
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "credentials", sandbox: null
  } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/members", route => route.fulfill({ json: { members: [], access_url: "https://example.test/access" } }))
  const model = {
    id: "scratch-draft", flow: "todo", version: "draft version", title: "Scratch notify", branch: "scratch/owner/notify", state: "done",
    attempts: [{ n: 1, run_id: "scratch-draft", state: "done", graph: [
      { id: "check", label: "Check", state: "done", deps: [] },
      { id: "notify", label: "Notify", state: "done", deps: ["check"] },
      { id: "review", label: "Review", state: "done", deps: ["notify"] }
    ], steps: [], phases: [] }], waits: [], tokens: 0, time_s: 1, cost_usd: 0, engine: [], journal: []
  }
  await page.route("**/api/runs", route => route.fulfill({ json: [model] }))
  await page.route("**/api/runs/scratch-draft/trace*", route => route.fulfill({ json: model }))
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    const frame = JSON.parse(String(raw)) as { t: string; id: number; topic?: string }
    if (frame.t !== "sub") return
    socket.send(JSON.stringify(frame.topic === "run:scratch-draft" ? { t: "snap", id: frame.id, cursor: 1, data: model }
      : { t: "err", id: frame.id, code: "unsupported" }))
  }))
  const writes: string[] = []
  page.on("request", request => {
    if (request.url().includes("/api/") && request.method() !== "GET") writes.push(request.url())
  })
  await page.goto("/")
  await say(page, "/run.inspect scratch-draft")
  const run = page.getByRole("region", { name: "Run Scratch notify", exact: true })
  await expect(run.getByText("draft version", { exact: true })).toBeVisible()
  await expect(run).toContainText("Notify")
  await expect(run.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await expect(run.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Restore", exact: true }).press("Enter")
  await expect(run.getByText("draft version", { exact: true })).toBeVisible()
  await run.getByRole("button", { name: "Inspect", exact: true }).press("Enter")
  await expect(run.getByText("draft version", { exact: true })).toBeVisible()
  await page.reload()
  await say(page, "/run.inspect scratch-draft")
  await expect(run.getByText("draft version", { exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
  expect(writes.filter(url => url.includes("/api/todos") || url.includes("/api/workflow/rpc"))).toEqual([])
})
