import { expect, test } from "@playwright/test"
import { fixtures } from "@smthrs/rpc/fixtures/Draft"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const shots = process.env.DRAFT_SHOTS_DIR ?? join(homedir(), "design-lanes/shots/T-UI-03")
// Pinned audit engine; optionally supply a local copy for offline runs.
const axeSource = process.env.DRAFT_AXE_PATH
const auditUrl = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.3/axe.min.js"
for (const name of Object.keys(fixtures)) {
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 390]) {
      test(`${name} ${theme} ${width}`, async ({ page }) => {
        const errors: string[] = []
        page.on("pageerror", error => errors.push(error.message))
        page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
        await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
        await page.goto(`/?story=${name}&theme=${theme}`)
        await expect(page.getByRole("region", { name: "Draft", exact: true })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.addScriptTag(axeSource ? { path: axeSource } : { url: auditUrl })
        const violations = await page.evaluate(async () => {
          const axe = (window as unknown as { axe: { run(): Promise<{ violations: { id: string; impact: string; nodes: unknown[] }[] }> } }).axe
          return (await axe.run()).violations
        })
        await mkdir(shots, { recursive: true })
        const basename = `${name}-${theme}-${width}`
        await writeFile(join(shots, `${basename}.axe.json`), JSON.stringify(violations, null, 2))
        await page.screenshot({ path: join(shots, `${basename}.png`), fullPage: true })
        expect(violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([])
        expect(errors).toEqual([])
        const committed = name === "committed" || name === "committed_amendment"
        if (committed) {
          await expect(page.locator(".draft-actions button")).toHaveCount(0)
          await expect(page.locator(".draft-private")).toHaveCount(0)
        } else {
          await expect(page.locator(".draft-private")).toHaveText("Only you")
          const commitTag = name === "amend" ? "todo.amend" : "todo.new"
          const commit = page.locator(`button[data-flow="${commitTag}"]`)
          if (name === "empty_stack") {
            await expect(commit).toBeDisabled()
            await expect(page.locator(".draft-actions")).toContainText("Add a title")
          } else {
            await commit.focus()
            await page.keyboard.press("Enter")
          }
          await page.locator('button[data-flow="draft.discard"]').focus()
          await page.keyboard.press("Enter")
          const expected: unknown[] = name === "empty_stack" ? [] : [[commitTag,
            name === "before" ? { before: "8" } : name === "amend" ? { n: "9" } : {}]]
          expected.push(["draft.discard", { draft: "entry-draft-1" }])
          expect(await page.evaluate(() => (window as unknown as { draftCalls: unknown[] }).draftCalls)).toEqual(expected)
          await page.goto(`/?story=${name}&theme=${theme}&removeFirst`)
          await expect(page.locator(`button[data-flow="${commitTag}"]`)).toHaveCount(0)
          await expect(page.locator('button[data-flow="draft.discard"]')).toHaveCount(1)
        }
      })
    }
  }
}
