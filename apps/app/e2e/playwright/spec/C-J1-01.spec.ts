import { expect, test } from "../browserTest"
import { setup } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J1-01.md.
// Real host, GitHub, installation and timing receipts remain in the reference-host check.
// Seed requirements: canary Node/Go repositories, owner, held image build,
// mirrored src/mail/expiry.ts, and the access outcomes named below.
// Written before implementation: mvp.md J1; lands with T-INS-08
test("C-J1-01: Fresh install opens the ordered setup card", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1; lands with T-INS-08")
  await page.goto("/setup")
  const card = setup(page)
  await expect(card).toBeVisible()
  await expect(card.locator("ol > li strong")).toHaveText([
    "Address", "GitHub App", "Sign in", "Repository", "Model access", "Source", "Machine"
  ])
  await expect(card.getByText("This Mac only", { exact: false })).toBeVisible()
  await expect(card.getByText("This Mac", { exact: true })).toBeVisible()
  await expect(card.getByText("Fast model", { exact: true })).toBeVisible()
  await expect(card.getByText("Coding model", { exact: true })).toBeVisible()
  await expect(card.getByText("Decisions", { exact: true })).toBeVisible()
  await expect(card).not.toContainText(/VPN|tunnel|Smithers account/)
  await page.reload()
  await expect(setup(page)).toBeVisible()
})

// Implemented UI portion; this does not qualify bundle, launchd or LAN isolation.
test("C-J1-01: current setup renders detected capacity and ordered steps without an account", async ({ page }) => {
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
  const card = page.getByRole("region", { name: "Set up Smithers" })
  await expect(card).toBeVisible()
  await expect(card.locator("ol > li strong")).toHaveText([
    "Address", "GitHub App", "Sign in", "Repository", "Model access", "Source", "Machine"
  ])
  await expect(card.getByText("64 GB · 200 GB free", { exact: true })).toBeVisible()
  await expect(card.getByRole("button", { name: "Address", exact: true })).toBeEnabled()
  await expect(card.getByRole("button", { name: "Create GitHub App", exact: true })).toHaveCount(0)
  await expect(card.getByText("This Mac only · 127.0.0.1", { exact: true })).toBeVisible()
  await expect(card).not.toContainText(/VPN|tunnel|Smithers account/)
  await page.reload()
  await expect(page.getByRole("region", { name: "Set up Smithers" })).toBeVisible()
})
