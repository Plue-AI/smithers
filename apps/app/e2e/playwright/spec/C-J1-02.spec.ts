import { expect, test } from "../browserTest"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { owner } from "./j1-fixtures"

// Hermetic browser proof through the real dispatcher, InstallSeam and
// CardRenderers. GitHub/LAN/bundle receipts remain reference-host checks.
async function installHost(page: import("@playwright/test").Page) {
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["identity", "install"], authFlow: "redirect", sandbox: null
  } }))
}

test("C-J1-02: Setup reload retains source and machine progress as separate steps", async ({ page }) => {
  await installHost(page)
  const model = installFixture()
  model.steps[5] = { id: "source", state: "running", pct: 37 }
  model.steps[6] = { id: "machine", state: "pending" }
  const writes: string[] = []
  let publish = () => {}
  let cursor = 0
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    const frame = JSON.parse(String(raw))
    if (frame.t === "sub" && frame.topic === "install") {
      publish = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: model }))
      publish()
    }
  }))
  await page.route("**/api/install", route => route.fulfill({ json: model }))
  await page.route("**/api/install/setup/*", route => {
    writes.push(route.request().url())
    return route.fulfill({ status: 500, json: { class: "infra", code: "unexpected", message: "Unexpected launch" } })
  })
  await page.goto("/")
  const card = page.getByRole("region", { name: "Set up Smithers", exact: true })
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.locator("[data-step]")).toHaveCount(7)
  expect(await card.locator("[data-step]").evaluateAll(rows => rows.map(row => row.getAttribute("data-step")))).toEqual([
    "address", "app_manifest", "sign_in", "repository", "models", "source", "machine"
  ])
  await expect(card.locator('[data-step="source"]')).toHaveAttribute("data-state", "running")
  await expect(card.locator('[data-step="source"] progress')).toHaveAttribute("value", "37")
  await expect(card.locator('[data-step="machine"]')).toHaveAttribute("data-state", "pending")
  await expect(card.locator('[data-step="machine"] button')).toHaveCount(0)
  await page.reload()
  await expect(card.locator('[data-step="source"] progress')).toHaveAttribute("value", "37")
  model.steps[5] = { id: "source", state: "done" }
  model.steps[6] = { id: "machine", state: "running", pct: 61 }
  await page.reload()
  await expect(card.getByText("Source ready", { exact: true })).toBeVisible()
  await expect(card.getByText("Machine ready", { exact: true })).toHaveCount(0)
  await expect(card.locator('[data-step="machine"] progress')).toHaveAttribute("value", "61")
  await page.reload()
  await expect(card.locator('[data-step="machine"] progress')).toHaveAttribute("value", "61")
  model.steps[6] = { id: "machine", state: "done" }
  publish()
  await expect(card.getByText("Source ready", { exact: true })).toBeVisible()
  await expect(card.getByText("Machine ready", { exact: true })).toBeVisible()
  await page.reload()
  await expect(card.getByText("Source ready", { exact: true })).toBeVisible()
  await expect(card.getByText("Machine ready", { exact: true })).toBeVisible()
  expect(writes).toEqual([])
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

test("C-J1-02: blocked squash and failed image keep their literal fixes", async ({ page }) => {
  await installHost(page)
  const model = installFixture()
  model.steps[3] = { id: "repository", state: "blocked", blocked: { line: "Enable squash merging on GitHub ↗", fix_url: "https://github.com/smithersai/smithers/settings" } }
  for (const step of model.steps.slice(4)) step.state = "pending"
  await page.route("**/api/install", route => route.fulfill({ json: model }))
  await page.goto("/")
  const card = page.getByRole("region", { name: "Set up Smithers", exact: true })
  await expect(card.getByRole("link", { name: "Enable squash merging on GitHub ↗" })).toHaveAttribute("href", "https://github.com/smithersai/smithers/settings")
  await expect(card.locator('[data-step="repository"]').getByRole("button", { name: "Retry", exact: true })).toBeVisible()
  await expect(card.locator('[data-step="source"] button')).toHaveCount(0)
  for (const step of model.steps.slice(3, 6)) step.state = "done"
  model.steps[6] = { id: "machine", state: "failed", error: { class: "user", code: "image_failed", message: "figlet missing; update .smithers/machine.json" } }
  await page.reload()
  const machine = card.locator('[data-step="machine"]')
  await expect(machine.getByRole("alert")).toHaveText("user")
  await machine.locator("summary").press("Enter")
  await expect(machine.getByRole("region", { name: "Failure details", exact: true })).toHaveText("figlet missing; update .smithers/machine.json")
  await expect(card.locator('[data-step="machine"]').getByRole("button", { name: "Retry", exact: true })).toBeEnabled()
})

test("C-J1-02: the explicit setup address shows completed readiness", async ({ page }) => {
  await installHost(page)
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.goto("/setup")
  const card = page.getByRole("region", { name: "Set up Smithers", exact: true })
  await expect(card.getByText("Source ready", { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(card.getByText("Machine ready", { exact: true })).toBeVisible()
})
