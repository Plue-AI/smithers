import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md J11.2, §6.14, Appendix A /flow.source; lands with T-APP-05, T-FLW-04, T-FLW-05
test("A-FLOW-SOURCE: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J11.2, §6.14, Appendix A /flow.source; lands with T-APP-05, T-FLW-04, T-FLW-05")
  await owner(page)
  await page.goto("/")
  // Live seed: C-J11-02 proposed TODO branch; File card saves on the machine.
  await say(page, "/flow.source todo")
  await expect(page.getByText("flows/todo/flow.ts", { exact: true }).last()).toBeVisible()
  const source = page.getByRole("textbox", { name: /flow.ts/ }).last()
  const original = await source.inputValue()
  expect(original).toContain("yield* check()")
  await source.fill(original.replace("yield* check()", "yield* check()\n    yield* notify()"))
  await expect(page.getByText("Saved to the machine", { exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/flow.source todo")
  await expect(source).toHaveValue(/yield\* notify\(\)/)
  await say(page, "/flow todo")
  await expect(page.getByRole("button", { name: "Active", exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Proposed", exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded read projection; live provider qualification remains above.
test("A-FLOW-SOURCE: mounted command projection", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/flow.source todo")
  await expect(page.getByText("flows/todo/flow.ts", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Saved to the machine", { exact: true })).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
