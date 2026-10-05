/*
 * The tiny real proof run behind fixtures/results.json: one journey test, one
 * proofStep per feature, recorded the way EVIDENCE-CONTRACT.md asks (a step per
 * feature id, a screenshot attachment named by the feature id, a failed step
 * that does not hide the rest, and "blocked by <id>" for a step that cannot run).
 * Regenerate with `bun apps/app/proof/test/record-fixture.ts`.
 */
import { expect, test, type Page, type TestInfo } from "@playwright/test"

const screen = (title: string, body: string) =>
  `data:text/html,${encodeURIComponent(`<!doctype html><title>${title}</title><body style="font:20px system-ui;margin:24px;background:#f7f4ee"><h1>${title}</h1>${body}</body>`)}`

test("fx journey", async ({ page }, info) => {
  const failed = new Set<string>()
  const proofStep = async (id: string, fn: () => Promise<void>, after?: string) => {
    await test.step(id, async () => {
      if (after !== undefined && failed.has(after)) throw new Error(`blocked by ${after}`)
      await fn()
      await attach(page, info, id)
    }).catch(() => { failed.add(id) })
  }
  await proofStep("fx-pass", async () => {
    await page.goto(screen("Setup", "<button>Continue</button>"))
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible()
  })
  await proofStep("fx-fail", async () => {
    await page.goto(screen("Make TODO", "<p>Draft</p>"))
    await attach(page, info, "fx-fail")
    await expect(page.getByRole("button", { name: "Commit" }), "the Commit button").toBeVisible({ timeout: 300 })
  })
  await proofStep("fx-blocked", async () => {
    await page.getByRole("button", { name: "Commit" }).click()
  }, "fx-fail")
  await proofStep("fx-disagree", async () => {
    await page.goto(screen("Merged", "<p>T1 merged</p>"))
    await expect(page.getByText("T1 merged")).toBeVisible()
  })
  expect([...failed], "proof steps that did not pass").toEqual([])
})

const attach = async (page: Page, info: TestInfo, id: string) => {
  if (info.attachments.some(each => each.name === id)) return
  await info.attach(id, { body: await page.screenshot(), contentType: "image/png" })
}
