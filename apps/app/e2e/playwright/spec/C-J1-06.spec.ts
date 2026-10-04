import { expect, test } from "../browserTest"
import { firstTodo, owner, sourceReady } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J1-06.md.
// Real host, GitHub, installation and timing receipts remain in the reference-host check.
// Seed requirements: canary Node/Go repositories, owner, held image build,
// mirrored src/mail/expiry.ts, and the access outcomes named below.
// Written before implementation: mvp.md J1; lands with T-MCH-10
test("C-J1-06: Undeclared Node and Go repositories prepare machines and show detected checks", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1; lands with T-MCH-10")
  await owner(page)
  for (const [repository, checks] of [
    ["node", ["pnpm test", "pnpm lint"]],
    ["go", ["go test ./..."]]
  ] as const) {
    await page.goto(`/smithers-mvp-canary/${repository}`)
    await sourceReady(page)
    await expect(page.getByText("Machine ready", { exact: true })).toBeVisible()
    await firstTodo(page, "Add a sum(a, b) export with a test")
    for (const check of checks) await expect(page.getByText(check, { exact: false }).first()).toBeVisible()
    await expect(page.getByRole("link", { name: /on GitHub/ }).first()).toBeVisible()
    await expect(page.getByText(/commit.*\.smithers\/|target index/i)).toHaveCount(0)
  }
})
