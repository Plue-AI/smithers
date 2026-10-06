import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// UI projection of C-UI-13; its unit/CLI acceptance evidence remains separate.
// Card reads use retained seeds, with served install fixtures for Flow and Agents.
// Confirmation behavior is covered in C-UI-13-confirm-install.spec.ts.
// Written before implementation: mvp.md §6, §8; lands with T-APP-01, T-APP-02, T-APP-03, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-APP-16, T-APP-15, T-FLW-07, T-FLW-08, T-UI-14
for (const [line, copy] of [
  ["/stack", "Upgrade the Stripe SDK to v17"], ["/todo T8", "Upgrade the Stripe SDK to v17"],
  ["/branch retry-webhooks", "retry-webhooks"], ["/flow todo", "TODO flow"],
  ["/wiki", "Webhook retries"], ["/settings", "This Mac"], ["/members", "Members"],
  ["/help", "Commands"], ["/agent implementer", "Implementer agent"]
] as const) test(`C-UI-13: ${line} reaches its replacement View`, async ({ page }) => {
  await owner(page)
  if (line === "/flow todo" || line === "/agent implementer") {
    await installCloudFixture(page, { capabilities: ["identity", "install"] })
    await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
    await page.route("**/api/flows", route => route.fulfill({ json: [{
      name: "todo", source: { builtin: true }, system: false,
      versions: [{ id: "d1", state: "active", steps: [{ id: "implement", label: "Implement", agent: "implementer" }] }]
    }] }))
  }
  if (line === "/agent implementer") await page.route("**/api/agents", route => route.fulfill({ json: {
    native: false, canAssign: true, agents: [{ id: "implementer", label: "Implementer agent", purpose: "",
      model: { id: "model-a", label: "model-a", provider: "openai-responses" }, builtin: true,
      available: false, account: "", reason: "", source: "owner", instructions: "flows/todo/flow.ts" }]
  } }))
  await page.goto("/")
  await say(page, line)
  const card = page.locator(".smithers-card").last()
  await expect(card).toBeVisible()
  await expect(card).toContainText(copy)
  await expect(card).not.toContainText("Set up a job")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// SetupView already mounts through the install seam on first paint.
test("C-UI-13: Setup View mounts from the install fixture", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["install"] })
  await page.route("**/api/install", route => route.fulfill({ json: {
    address: { listen: "mac", bind: "127.0.0.1", origins: ["http://localhost:4000"] },
    steps: ["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"]
      .map(id => ({ id, state: "pending" })),
    this_mac: { memory_gb: 64, disk_free_gb: 200, capacity: 4 },
    github: { signed_in: false, app_installed: false },
    models: [
      { role: "fast", provider: "Cerebras", key: "none" },
      { role: "coding", provider: "Anthropic", key: "none" },
      { role: "jev", provider: "Vercel", key: "none" }
    ], chatgpt: false, capacity: 4
  } }))
  await page.goto("/")
  const setup = page.getByRole("region", { name: "Set up Smithers" })
  await expect(setup).toBeVisible()
  await expect(setup.getByRole("button", { name: "This Mac only", exact: true })).toBeEnabled()
  await expect(setup.getByRole("button", { name: "Network", exact: true })).toBeEnabled()
  await expect(setup.getByText("64 GB · 200 GB free", { exact: true })).toBeVisible()
  await expect(setup).not.toContainText("Set up a job")
  await page.reload()
  await expect(page.getByRole("region", { name: "Set up Smithers" })).toBeVisible()
})

// T-UI-14: the real dispatcher and mounted Commands card; other doors above retain their own wiring gates.
test("C-UI-13: /help mounts live Commands inline, maximized and after reload", async ({ page }) => {
  await owner(page)
  await page.route("**/contents/.smithers/factory.json", route => route.fulfill({ json: { content: JSON.stringify({ on: [], flows: [
    { id: "release-notes", description: "Write release notes", summary: "Live repository summary", featured: false, kind: "ts", path: "flows/release-notes/flow.ts", capabilities: [], model: null, modelInvocable: true }
  ] }) } }))
  await page.goto("/")
  await say(page, "/repo.select smithersai/smithers")
  for (const mode of ["light", "dark"]) {
    await say(page, `/theme ${mode}`)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await say(page, "/help")
      const commands = page.getByRole("article", { name: "Commands", exact: true })
      await expect(commands).toHaveCount(1)
      await expect(commands).toBeVisible()
      await expect(commands).toContainText("/help")
      await expect(commands).toContainText("List these commands")
      await expect(commands).toContainText("/release-notes [owner/repo] [JSON object]")
      await expect(commands).toContainText("Live repository summary")
      await expect(commands.locator("button")).toHaveCount(0)
      await expect(commands).not.toContainText("/chat.commands")
      const card = page.locator('.smithers-card[data-kind="commands"]')
      await card.getByRole("button", { name: "Maximize card", exact: true }).press("Enter")
      await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible()
      await expect(commands).toBeVisible()
      await page.getByRole("button", { name: "Restore", exact: true }).press("Enter")
    }
  }
  await page.reload()
  await expect(page.getByRole("article", { name: "Commands", exact: true })).toContainText("/help")
})

// T-FLW-07: the retained design provider exercises the mounted Run View and
// durable gestures while authenticated install run topics are being composed.
test("C-UI-13: Run selection survives Inspect reopening and reload", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/run.inspect run-retry")
  const run = page.getByRole("region", { name: "Run Retry failed webhooks with backoff", exact: true })
  await expect(run).toBeVisible()
  const read = run.getByRole("button", { name: /Read retry.ts/ }).first()
  await read.press("Enter")
  await expect(run.getByRole("region", { name: "Selected cell", exact: true })).toContainText("await sleep(30_000)")
  await page.getByRole("button", { name: "Restore", exact: true }).press("Enter")
  await say(page, "/run.inspect run-retry")
  await expect(run.getByRole("region", { name: "Selected cell", exact: true })).toContainText("await sleep(30_000)")
  await page.reload()
  await say(page, "/run.inspect run-retry")
  await expect(run.getByRole("region", { name: "Selected cell", exact: true })).toContainText("await sleep(30_000)")
})
