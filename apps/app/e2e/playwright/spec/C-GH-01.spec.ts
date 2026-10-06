import { expect, test } from "../browserTest"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { owner } from "./j1-fixtures"

// Browser proof through the mounted card, dispatcher and InstallSeam.
// Manifest exchange, LAN security and restart identity have separate backend/reference-host receipts.
test("C-GH-01: App setup waits for Address and owner claim before repository selection", async ({ page }) => {
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["identity", "install"], authFlow: "redirect", sandbox: null
  } }))
  const model = installFixture()
  for (const step of model.steps) step.state = "pending"
  model.github = { signed_in: false, app_installed: false }
  model.repository = undefined
  model.repositories = ["smithers-mvp-canary/node"]
  const writes: { step: string; body: unknown }[] = []
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
  await page.route("**/api/install/setup/*", async route => {
    const step = route.request().url().split("/").at(-1)!
    writes.push({ step, body: route.request().postDataJSON() })
    if (step === "address") {
      model.steps[0].state = "done"
      model.address = { listen: "mac", bind: "127.0.0.1:4000", origins: ["http://localhost:4000"] }
      await route.fulfill({ json: model })
    } else {
      model.steps[step === "app" ? 1 : 3].state = "running"
      await route.fulfill({ status: 202, json: { operationId: `op-${step}`, requestId: `req-${step}`, kind: step, state: "accepted" } })
      publish()
    }
  })
  await page.goto("/setup")
  const card = page.getByRole("region", { name: "Set up Smithers", exact: true })
  // If the previous document still holds the writer while its work retires,
  // recover through the product's explicit takeover control rather than bypassing its lock.
  const reload = async () => {
    await page.reload()
    const takeover = page.getByRole("button", { name: "Use Smithers here", exact: true })
    await expect(card.or(takeover)).toBeVisible({ timeout: 15_000 })
    if (await takeover.isVisible()) await takeover.press("Enter")
    await expect(card).toBeVisible({ timeout: 15_000 })
  }
  const app = card.locator('[data-step="app_manifest"]')
  const claim = card.locator('[data-step="sign_in"]')
  const repo = card.locator('[data-step="repository"]')
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(app.getByRole("button")).toHaveCount(0)
  await expect(claim.getByRole("button")).toHaveCount(0)
  await expect(repo.getByRole("combobox")).toHaveCount(0)
  await card.getByRole("button", { name: "This Mac only", exact: true }).press("Enter")
  await expect(app.getByRole("button", { name: "Create GitHub App", exact: true })).toBeVisible()
  await app.getByLabel("Owner", { exact: true }).fill("smithers-mvp-canary")
  await app.getByRole("button", { name: "Create GitHub App", exact: true }).press("Enter")
  await expect(app).toHaveAttribute("data-state", "running")
  await expect(claim.getByRole("button")).toHaveCount(0)
  await expect(repo.getByRole("combobox")).toHaveCount(0)
  await expect.poll(() => writes).toEqual([
    { step: "address", body: { bind: "127.0.0.1:4000", origins: ["http://localhost:4000"] } },
    { step: "app", body: { owner: "smithers-mvp-canary" } }
  ])
  // The callback's authoritative projection, rather than the launch receipt, completes App setup.
  model.steps[1].state = "done"
  model.github.owner = "smithers-mvp-canary"
  publish()
  await expect(claim.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
  await expect(repo.getByRole("combobox")).toHaveCount(0)
  // Owner OAuth is an external browser journey; project its committed claim separately.
  model.steps[2].state = "done"
  model.github.signed_in = true
  await reload()
  await repo.getByRole("combobox").selectOption("smithers-mvp-canary/node")
  await repo.getByRole("button", { name: "Repository", exact: true }).press("Enter")
  await expect(repo).toHaveAttribute("data-state", "running")
  await expect.poll(() => writes.at(-1)).toEqual({ step: "repository", body: { repository: "smithers-mvp-canary/node" } })
  model.steps[3].state = "done"
  model.github.app_installed = true
  model.repository = { owner: "smithers-mvp-canary", name: "node" }
  publish()
  await expect(repo).toHaveAttribute("data-state", "done")
  await reload()
  await expect(app).toHaveAttribute("data-state", "done")
  await expect(claim).toHaveAttribute("data-state", "done")
  await expect(repo).toHaveAttribute("data-state", "done")
  await expect(app.getByRole("button")).toHaveCount(0)
  expect(writes).toHaveLength(3)
  await expect(card).not.toContainText("PRIVATE KEY")
})
