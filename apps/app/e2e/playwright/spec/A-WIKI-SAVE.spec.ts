import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import * as Y from "yjs"

// The slash door saves the same literal Markdown as the answer's button.
// SQL attribution and live repository citations remain reference-host checks.
test("A-WIKI-SAVE: the slash door persists one literal answer", async ({ page }) => {
  await owner(page)
  const markdown = "Use `redeliver` in [retry.ts](src/webhooks/retry.ts)."
  const writes: Array<{ title: string; body: string; slug: string }> = []
  const saved = () => ({ id: 42, slug: writes[0]!.slug, title: "Retry answer", path: "Retry answer.md", revision: 1,
    author: { id: 1, login: "canary-owner" }, created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" })
  await page.route(url => url.pathname.includes("/wiki"), async route => {
    if (route.request().method() === "POST") {
      writes.push(route.request().postDataJSON())
      await route.fulfill({ status: 201, json: saved() })
    } else if (new URL(route.request().url()).pathname.endsWith("/document")) {
      const doc = new Y.Doc(); doc.getText("markdown").insert(0, markdown)
      await route.fulfill({ json: { page: { ...saved(), body: markdown }, state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"), state_vector: Buffer.from(Y.encodeStateVector(doc)).toString("base64") } })
    } else await route.fulfill({ json: { pages: [], folders: [], tags: [] } })
  })
  await page.goto("/")
  await say(page, `/wiki.save ${JSON.stringify({ name: "Retry answer", text: markdown })}`)
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toMatchObject({ title: "Retry answer", body: markdown })
  await expect(page.locator('[data-kind="world"]').last()).toContainText("redeliver")
  await page.reload()
  await say(page, `/wiki.save ${JSON.stringify({ name: "Retry answer", text: markdown })}`)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  expect(writes).toHaveLength(1)
})

test("A-WIKI-SAVE: without an answer it refuses before a page write", async ({ page }) => {
  await owner(page)
  let writes = 0
  await page.route(url => url.pathname.includes("/wiki"), route => { if (route.request().method() === "POST") writes++; return route.fulfill({ status: 500 }) })
  await page.goto("/")
  await say(page, "/wiki.save Retry answer")
  await expect(page.getByText("Choose an answer to save.", { exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
  expect(writes).toBe(0)
})
