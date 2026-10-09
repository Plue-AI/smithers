import { expect } from "@playwright/test"
import { showcase } from "../showcase"

/*
 * One Branch card per branch: its machine, activity and files. 15833e5d03 replaced the box card (files,
 * services, egress, suspend and delete) with it; the walk follows e2e/playwright/citc.spec.ts on the seed.
 */
export default showcase({
  id: "workspace",
  order: 118,
  title: "Branch",
  summary: "One card per branch: its machine, activity and files, beside Chat.",
  flows: ["branch", "branches"],
  run: async ({ page, app, backend }) => {
    await backend.cloud()
    await app.open("/")
    await app.slash("/branches")
    const branches = page.getByRole("navigation", { name: "Branches", exact: true })
    await expect(branches).toContainText("retry-webhooks")
    await app.closeComposer()
    await app.show(branches)
    await app.beat(900)

    await app.slash("/branch T9")
    const card = page.locator('.smithers-card[data-kind="branch"][data-testid]').last()
    await expect(card).toBeVisible()
    await expect(card.getByRole("tab", { name: "Activity", exact: true })).toBeVisible()
    await expect(page.locator('.smithers-card[data-kind="workspace"]')).toHaveCount(0)
    await app.closeComposer()
    await app.show(card)
    await app.beat(1200)

    await app.click(card.getByRole("button", { name: "Maximize card", exact: true }))
    const restore = page.getByRole("button", { name: "Restore", exact: true })
    await expect(restore).toBeVisible()
    await app.beat(1200)
    await app.click(restore)
    await expect(card).toHaveAttribute("data-maximized", "false")
    await expect(page.getByTestId("composer-input")).toBeAttached()
    await app.beat(900)
  }
})
