import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-UI-14.md; not a qualification receipt.
// Written before implementation: mvp.md §6.8, M-43; spec.md §7.4.5; lands with T-UI-19
test("C-UI-14: two members see live edits within the keystroke budget", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.8, M-43; spec.md §7.4.5; lands with T-UI-19")
  test.setTimeout(700_000)
  // Requires two authenticated reference Macs on one real branch, each with
  // a File card editor. The harness supplies a second member session and
  // runs this scenario once with the carets flag on, then once off.
  // Hermetic execution cannot qualify reference-host latency or colours.
  await owner(page)
  const other = await page.context().browser()!.newContext()
  const alice = await other.newPage()
  try {
    // The reference harness supplies Alice's authenticated identity here.
    await Promise.all([page.goto("/"), alice.goto("/")])
    await Promise.all([say(page, "/file retry-webhooks:src/webhooks/retry.ts"), say(alice, "/file retry-webhooks:src/webhooks/retry.ts")])
    const benEditor = page.getByRole("textbox", { name: /retry.ts/ }).last()
    const aliceEditor = alice.getByRole("textbox", { name: /retry.ts/ }).last()
    const samples: number[][] = [[], []]
    const start = Date.now()
    for (let i = 0; i < 1000 || Date.now() - start < 300_000; i++) {
      for (const [index, editor, observer] of [[0, benEditor, aliceEditor], [1, aliceEditor, benEditor]] as const) {
        const marker = `// member ${index} edit ${i}`
        const before = Date.now()
        await editor.press("Control+End")
        await editor.press("Enter")
        await editor.pressSequentially(marker)
        await expect(observer).toHaveValue(new RegExp(marker))
        samples[index]!.push(Date.now() - before)
      }
      await expect(page.getByText("Alice", { exact: true }).last()).toBeVisible()
      await expect(alice.getByText("Ben", { exact: true }).last()).toBeVisible()
    }
    for (const values of samples) {
      expect(values.length).toBeGreaterThanOrEqual(1000)
      values.sort((a, b) => a - b)
      expect(values[Math.ceil(values.length * 0.95) - 1]).toBeLessThanOrEqual(1000)
    }
    await test.info().attach("latency-samples", { body: JSON.stringify(samples), contentType: "application/json" })
  } finally {
    await other.close()
  }
})
