import { expect, test } from "../browserTest"
import { owner, setup, sourceReady } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J1-02.md.
// Real host, GitHub, installation and timing receipts remain in the reference-host check.
// Seed requirements: canary Node/Go repositories, owner, held image build,
// mirrored src/mail/expiry.ts, and the access outcomes named below.
// Written before implementation: mvp.md J1; lands with T-APP-03
test("C-J1-02: Setup persists progress and separates source from machine readiness", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1; lands with T-APP-03")
  await owner(page)
  await page.goto("/setup")
  const card = setup(page)
  await expect(card).toBeVisible()
  await page.getByLabel("Bind", { exact: true }).fill("0.0.0.0:4000")
  await page.getByLabel("Origins", { exact: true }).fill("http://canary-mini.local:4000")
  await card.getByRole("button", { name: "Network", exact: true }).press("Enter")
  await card.getByRole("button", { name: "Create GitHub App", exact: true }).press("Enter")
  // The seeded setup world must model GitHub's manifest return and owner claim.
  await page.getByRole("button", { name: /sign in.*GitHub/i }).first().press("Enter")
  await page.getByLabel("Repository", { exact: true }).selectOption("smithers-mvp-canary/node")
  await page.getByRole("button", { name: "Submit", exact: true }).press("Enter")
  await expect(page.getByRole("link", { name: /Enable squash merging on GitHub/ })).toHaveAttribute("href", /github.com.*settings/)
  // Seeded world holds squash disabled until the person returns from its fix link.
  await page.getByRole("link", { name: /Enable squash merging on GitHub/ }).press("Enter")
  for (const [role, provider] of [["Coding model", "Anthropic"], ["Fast model", "Cerebras"], ["Decisions", "Vercel"]]) {
    await card.getByRole("button", { name: "Save key", exact: true }).first().press("Enter")
    await page.getByLabel("Role", { exact: true }).selectOption({ label: role })
    await page.getByLabel("Provider", { exact: true }).fill(provider)
    const key = page.getByLabel("Key", { exact: true })
    await expect(key).toHaveAttribute("type", "password")
    if (role === "Coding model") {
      await key.fill("invalid-canary-key")
      await page.getByRole("button", { name: "Save", exact: true }).last().press("Enter")
      await expect(page.getByRole("alert")).toBeVisible()
    }
    await key.fill("valid-canary-key")
    await page.getByRole("button", { name: "Save", exact: true }).last().press("Enter")
    await expect(card).not.toContainText("valid-canary-key")
  }
  await expect(card.getByLabel("AI Gateway key")).toHaveAttribute("type", "password")
  await sourceReady(page)
  await page.reload()
  await sourceReady(page)
  await expect(page.getByText("Machine ready", { exact: true })).toBeVisible()
  await expect(page.getByText("Source ready", { exact: true })).toBeVisible()
})
