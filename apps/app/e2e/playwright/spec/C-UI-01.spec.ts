import { controlTabKey, expect, test, type Locator } from "../browserTest"
import { owner } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-UI-01.md.
// Integration and reference-host evidence remains required separately.
// Written before implementation: mvp.md §5, §6.4, §9; lands with T-REL-02
test("C-UI-01: Every P0 journey completes keyboard-only", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §5, §6.4, §9; lands with T-REL-02")
  // Required seed: all P0 journey prerequisites, members and scenario events.
  // External install, GitHub and SSH steps belong to the reference harness.
  await owner(page)
  await page.goto("/")
  // Fail any pointer/edit shortcut: all app input uses the keyboard boundary.
  for (const method of ["click", "dblclick", "hover", "tap", "dragTo", "check", "setChecked", "fill", "selectOption"]) {
    Object.defineProperty(page, method, { value: () => { throw new Error(`Forbidden input: ${method}`) } })
  }
  for (const method of ["click", "dblclick", "move", "down", "up", "wheel"]) {
    Object.defineProperty(page.mouse, method, { value: () => { throw new Error(`Forbidden mouse input: ${method}`) } })
  }
  const reach = async (target: Locator) => {
    await expect(target).toBeVisible()
    for (let n = 0; n < 200; n++) {
      if (await target.evaluate(element => element === document.activeElement)) break
      await page.keyboard.press(controlTabKey(page))
    }
    await expect(target).toBeFocused()
    expect(await target.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("solid")
  }
  const act = async (name: string) => {
    await reach(page.getByRole("button", { name, exact: true }).last())
    await page.keyboard.press("Enter")
  }
  const write = async (name: string, value: string) => {
    await reach(page.getByLabel(name, { exact: true }).last())
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.type(value)
  }
  const command = async (line: string) => {
    const input = page.getByTestId("composer-input")
    if (!await input.isVisible()) await page.keyboard.press("Control+k")
    await expect(input).toBeFocused()
    await input.pressSequentially(line)
    await page.keyboard.press("Enter")
    await expect(input).toHaveValue("")
    await page.keyboard.press("Escape")
  }
  // J1: seeded host/GitHub setup prerequisites; complete the first change.
  await command("/settings")
  await expect(page.locator(".smithers-card").last()).toContainText("This Mac")
  await command("/todo.new")
  await write("Title", "Add sum")
  await write("Prompt", "Implement sum and its tests")
  await act("Commit")
  await expect(page.locator(".smithers-card").last()).toContainText("In review")
  await act("Merge")
  await act("Merge")
  await expect(page.locator(".smithers-card").last()).toContainText("Merged into main")
  await command("/members")
  await expect(page.locator(".smithers-card").last()).toContainText("Ben")
  await command("/secrets")
  await expect(page.locator(".smithers-card").last()).toContainText("Secrets")
  // J2: issue draft, placement, question, evidence and merge.
  await command("/issue 42")
  await act("Make TODO")
  await act("Commit")
  await reach(page.getByRole("textbox", { name: /Answer the coding agent/ }).last())
  await page.keyboard.type("Use backoff")
  await act("Answer")
  await expect(page.locator(".smithers-card").last()).toContainText("In review")
  await act("Diff")
  await expect(page.locator(".smithers-card").last()).toContainText("retry.ts")
  await command("/todo T14")
  await act("Merge")
  await act("Merge")
  await expect(page.locator(".smithers-card").last()).toContainText("Merged into main")
  // J3 and J6: join, edit and type into the person's own terminal.
  await command("/branch retry-webhooks")
  await act("Wake")
  await expect(page.locator(".smithers-card").last()).toContainText("Awake")
  await reach(page.getByRole("button", { name: /retry.ts/ }).last())
  await page.keyboard.press("Enter")
  await reach(page.getByRole("textbox", { name: /File/ }).last())
  await page.keyboard.press("End")
  await page.keyboard.type("\n// keyboard edit")
  await command("/branch retry-webhooks")
  await act("New terminal")
  await reach(page.getByRole("region", { name: /terminal output/ }).last())
  await page.keyboard.type("claude")
  await page.keyboard.press("Enter")
  await expect(page.getByText("Claude Code for Ben", { exact: true }).last()).toBeVisible()
  // J4: reorder and retry without leaving Chat blocked.
  await command("/home")
  await reach(page.getByRole("button", { name: "Order Log every webhook retry attempt", exact: true }))
  await page.keyboard.press("Enter")
  await reach(page.getByRole("menuitem", { name: "Move up", exact: true }))
  await page.keyboard.press("Enter")
  await act("Retry")
  await command("Show the running work")
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  // J5: a factory edit is a reviewed change, activated after sync.
  await command("Every TODO must run pnpm test and update the changelog.")
  await act("Make TODO")
  await act("Commit")
  await act("Merge")
  await act("Merge")
  await command("/flow todo")
  await expect(page.locator(".smithers-card").last()).toContainText("Active")
  // J7: amend, fork and add the scratch change to the stack.
  await command("/todo.amend T9")
  await write("Prompt", "Also log each retry")
  await act("Commit")
  await command("/branch retry-webhooks")
  await act("Fork")
  await write("Name", "ben/retry-try-2")
  await act("Fork")
  await act("Add to stack")
  await act("Commit")
  await expect(page.locator(".smithers-card").last()).toContainText("Queued")
  // J8: a learned decision remains editable and supplies the next plan.
  await command("/wiki.page retries")
  await reach(page.getByRole("textbox", { name: /Wiki/ }).last())
  await page.keyboard.press("End")
  await page.keyboard.type("\nUse the existing retry helper.")
  await expect(page.locator(".smithers-card").last()).toContainText("Revision")
  // J10: fixture GitHub comments and laptop push arrive while on this branch.
  await command("/todo T9")
  await expect(page.locator(".smithers-card").last()).toContainText("Needs you")
  await act("Bring in")
  await act("Confirm")
  await expect(page.locator(".smithers-card").last()).toContainText("In review")
  // J11: inspect and replay, open source, run it on the scratch branch.
  await act("Inspect")
  await reach(page.getByRole("slider", { name: /Replay/ }).last())
  await page.keyboard.press("Home")
  await page.keyboard.press("End")
  await command("/flow todo")
  await act("Source")
  await expect(page.locator(".smithers-card").last()).toContainText("flows/todo/flow.ts")
  await command("/branch ben/retry-try-2")
  await command("/flow.run todo")
  await expect(page.locator(".smithers-card").last()).toContainText("Run")
  await command("/agent coding")
  await reach(page.getByRole("button", { name: /^Model:/ }).last())
  await page.keyboard.press("Enter")
  await reach(page.getByRole("option").last())
  await page.keyboard.press("Enter")
  await page.keyboard.press("Escape")
  await page.keyboard.press(controlTabKey(page))
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY")

})

// Executable slice of C-UI-01 on the mounted seeded Home; full journeys above.
test("C-UI-01: Home order menu and composer are reachable by keyboard", async ({ page }) => {
  await page.goto("/")
  const order = page.getByRole("button", { name: "Order Log every webhook retry attempt", exact: true })
  await expect(order).toBeVisible()
  for (let n = 0; n < 100; n++) {
    if (await order.evaluate(element => element === document.activeElement)) break
    await page.keyboard.press(controlTabKey(page))
  }
  await expect(order).toBeFocused()
  expect(await order.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("solid")
  await page.keyboard.press("Enter")
  const up = page.getByRole("menuitem", { name: "Move up", exact: true })
  await expect(up).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(up).toHaveCount(0)
  await expect(order).toBeFocused()
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("composer-input")).toBeHidden()
})
