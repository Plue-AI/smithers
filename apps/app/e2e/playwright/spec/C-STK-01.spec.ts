import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-STK-01.md.
// Written before implementation: mvp.md §4.1, J2.3–J2.6; lands with T-STK-01
test("C-STK-01: stop and resume preserve the TODO and a question refuses Stop", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §4.1, J2.3–J2.6; lands with T-STK-01")
  // Seed T2 Working with completed Plan, T3 Needs you with an open question,
  // T4 Failed with one retained attempt, and T5 Merged. Hold machine admission
  // after Resume/Retry so Queued is observable. Transition matrix receipts remain separate.
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  const card = () => page.locator(".smithers-card").last()
  await say(page, "/todo T2")
  await expect(card().getByText("Working", { exact: true }).last()).toBeVisible()
  await card().getByRole("button", { name: "Stop", exact: true }).last().press("Enter")
  await expect(card().getByText("Paused", { exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/todo T2")
  await card().getByRole("button", { name: "Resume", exact: true }).last().press("Enter")
  await expect(card().getByText("Queued", { exact: true }).last()).toBeVisible()
  await expect(card().getByText("Plan", { exact: true }).last()).toBeVisible()
  await say(page, "/todo T3")
  await expect(card().getByText("Needs you", { exact: true }).last()).toBeVisible()
  await expect(card().getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await expect(card().getByRole("button", { name: "Answer", exact: true }).last()).toBeVisible()
  await say(page, "/todo T4")
  await expect(card().getByText("Failed", { exact: true }).last()).toBeVisible()
  await card().getByLabel("Steer the retry", { exact: true }).last().fill("Use the existing retry helper")
  await card().getByRole("button", { name: "Retry", exact: true }).last().press("Enter")
  await expect(card().getByText("Queued", { exact: true }).last()).toBeVisible()
  await expect(card().getByText("Use the existing retry helper", { exact: true }).last()).toBeVisible()
  await say(page, "/todo T5")
  await expect(card().getByText("Merged", { exact: true }).last()).toBeVisible()
  for (const name of ["Stop", "Resume", "Retry", "Drop"]) {
    await expect(card().getByRole("button", { name, exact: true })).toHaveCount(0)
  }
})
