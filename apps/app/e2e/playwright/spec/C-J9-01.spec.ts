import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import * as Y from "yjs"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// Browser seam proof. Live repository citations and SQL-author receipts are
// qualified by the reference-install journey, not this deterministic answer.
test("C-J9-01: an answer opens a private Draft and saves its literal Markdown", async ({ page }) => {
  await owner(page)
  // The answer travels through the host's streamed agent boundary; the cloud
  // fixture deliberately refuses all API routes it has not supplied.
  await page.route("**/api/agent/**", route => route.continue())
  let committed: typeof fixtures.queued.model | undefined
  const todoWrites: unknown[] = []
  const wikiWrites: { title: string; body: string; slug: string; path: string }[] = []
  await page.route("**/api/todos", async route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON()
      todoWrites.push(body)
      committed = { ...structuredClone(fixtures.queued.model), n: 30, title: body.title,
        prompt_revisions: [{ ...fixtures.queued.model.prompt_revisions[0]!, text: body.prompt, acceptance: body.acceptance }] }
      await route.fulfill({ status: 202, json: { state: "accepted", n: 30 } })
    } else await route.fulfill({ json: committed ? [committed] : [] })
  })
  await page.route("**/api/todos/30", route => route.fulfill({ json: committed }))
  const wikiPage = () => ({ id: 20, slug: wikiWrites[0]?.slug ?? "retry", title: "Retry", path: "Retry.md", revision: 1,
    updated_at: "2026-10-05T00:00:00Z", created_at: "2026-10-05T00:00:00Z", author: { id: 1, login: "canary-owner" },
    visibility: "public", content_digest: "a".repeat(64), metadata: { frontmatter: null, aliases: [], tags: [], headings: [], links: [] }, backlinks: [] })
  await page.route(url => url.pathname.includes("/wiki"), async route => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === "POST" && path.endsWith("/wiki")) {
      wikiWrites.push(route.request().postDataJSON())
      await route.fulfill({ json: wikiPage() })
    } else if (path.endsWith("/navigation/index")) await route.fulfill({ json: { pages: wikiWrites.length ? [wikiPage()] : [], folders: [], tags: [] } })
    else if (path.endsWith("/document")) {
      const doc = new Y.Doc(); doc.getText("markdown").insert(0, wikiWrites[0]!.body)
      await route.fulfill({ json: { page: { ...wikiPage(), body: wikiWrites[0]!.body }, state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"), state_vector: Buffer.from(Y.encodeStateVector(doc)).toString("base64") } })
    } else await route.fulfill({ status: 404, json: { message: "Absent fixture" } })
  })
  await page.goto("/")
  await say(page, "Explain src/webhooks/retry.ts and redeliver")
  const answer = page.locator('.smithers-chat-message[data-role="assistant"]').filter({ has: page.locator(".message-answer-actions") }).last()
  await expect(answer.getByRole("button", { name: "Make TODO", exact: true })).toBeVisible()
  const markdown = await answer.locator(".message-markdown").innerText()
  await answer.getByRole("button", { name: "Make TODO", exact: true }).press("Enter")
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true }).last()).toHaveValue(markdown)
  await page.getByRole("textbox", { name: "Title", exact: true }).last().fill("Document webhook retries")
  await page.getByRole("button", { name: "Commit", exact: true }).last().press("Enter")
  await page.keyboard.press("Enter")
  await expect.poll(() => todoWrites.length).toBe(1)
  expect(committed!.title).toBe("Document webhook retries")
  expect(committed!.prompt_revisions[0]!.text).toBe(markdown)
  await answer.getByRole("button", { name: "Save to wiki", exact: true }).press("Enter")
  await page.getByLabel("Name", { exact: true }).last().fill("Retry")
  const save = page.getByRole("button", { name: "Save", exact: true }).last()
  await expect(save).toBeEnabled()
  await save.press("Enter")
  await expect.poll(() => wikiWrites.length).toBe(1)
  expect(wikiWrites).toEqual([{ title: "Retry", body: markdown, path: "Retry.md", slug: expect.stringMatching(/^answer-/) }])
})
