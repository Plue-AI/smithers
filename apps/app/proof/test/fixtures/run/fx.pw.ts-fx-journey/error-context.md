# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: fx.pw.ts >> fx journey
- Location: proof/test/fx.pw.ts:13:5

# Error details

```
Error: proof steps that did not pass

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 4

- Array []
+ Array [
+   "fx-fail",
+   "fx-blocked",
+ ]
```

# Page snapshot

```yaml
- generic [active] [ref=f2e1]:
  - heading "Merged" [level=1] [ref=f2e2]
  - paragraph [ref=f2e3]: T1 merged
```

# Test source

```ts
  1  | /*
  2  |  * The tiny real proof run behind fixtures/results.json: one journey test, one
  3  |  * proofStep per feature, recorded the way EVIDENCE-CONTRACT.md asks (a step per
  4  |  * feature id, a screenshot attachment named by the feature id, a failed step
  5  |  * that does not hide the rest, and "blocked by <id>" for a step that cannot run).
  6  |  * Regenerate with `bun apps/app/proof/test/record-fixture.ts`.
  7  |  */
  8  | import { expect, test, type Page, type TestInfo } from "@playwright/test"
  9  | 
  10 | const screen = (title: string, body: string) =>
  11 |   `data:text/html,${encodeURIComponent(`<!doctype html><title>${title}</title><body style="font:20px system-ui;margin:24px;background:#f7f4ee"><h1>${title}</h1>${body}</body>`)}`
  12 | 
  13 | test("fx journey", async ({ page }, info) => {
  14 |   const failed = new Set<string>()
  15 |   const proofStep = async (id: string, fn: () => Promise<void>, after?: string) => {
  16 |     await test.step(id, async () => {
  17 |       if (after !== undefined && failed.has(after)) throw new Error(`blocked by ${after}`)
  18 |       await fn()
  19 |       await attach(page, info, id)
  20 |     }).catch(() => { failed.add(id) })
  21 |   }
  22 |   await proofStep("fx-pass", async () => {
  23 |     await page.goto(screen("Setup", "<button>Continue</button>"))
  24 |     await expect(page.getByRole("button", { name: "Continue" })).toBeVisible()
  25 |   })
  26 |   await proofStep("fx-fail", async () => {
  27 |     await page.goto(screen("Make TODO", "<p>Draft</p>"))
  28 |     await attach(page, info, "fx-fail")
  29 |     await expect(page.getByRole("button", { name: "Commit" }), "the Commit button").toBeVisible({ timeout: 300 })
  30 |   })
  31 |   await proofStep("fx-blocked", async () => {
  32 |     await page.getByRole("button", { name: "Commit" }).click()
  33 |   }, "fx-fail")
  34 |   await proofStep("fx-disagree", async () => {
  35 |     await page.goto(screen("Merged", "<p>T1 merged</p>"))
  36 |     await expect(page.getByText("T1 merged")).toBeVisible()
  37 |   })
> 38 |   expect([...failed], "proof steps that did not pass").toEqual([])
     |                                                        ^ Error: proof steps that did not pass
  39 | })
  40 | 
  41 | const attach = async (page: Page, info: TestInfo, id: string) => {
  42 |   if (info.attachments.some(each => each.name === id)) return
  43 |   await info.attach(id, { body: await page.screenshot(), contentType: "image/png" })
  44 | }
  45 | 
```