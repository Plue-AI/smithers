import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-STK-08.md.
// Requires scenario-specific seeded events; backend and reference-host receipts remain separate.
// Written before implementation: mvp.md §4.1, J10.5; lands with T-STK-01
test("C-STK-08: independent waits survive Resume and an external merge wins", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §4.1, J10.5; lands with T-STK-01")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Required seed: T1 paused with a retained question and a machine wait;
  // release admission after Resume, then deliver an external GitHub merge.
  await say(page, "/todo T1")
  const card = () => page.locator(".smithers-card").last()
  await expect(card()).toContainText("Paused")
  await card().getByRole("button", { name: "Resume", exact: true }).press("Enter")
  await expect(card()).toContainText("Queued")
  await expect(card()).toContainText("waiting for a machine")
  await expect(card()).toContainText("Starting")
  await expect(card()).toContainText("Needs you")
  await expect(card().getByRole("button", { name: "Answer", exact: true })).toBeVisible()
  await expect(card().getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await expect(card()).toContainText("Merged")
  await expect(card().getByRole("button", { name: "Answer", exact: true })).toHaveCount(0)
  await page.reload()
  await say(page, "/todo T1")
  await expect(card()).toContainText("Merged")
})
