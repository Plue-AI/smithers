import { expect, test } from "./browserTest"
import { fillComposer } from "./composer"
import { owner, say } from "./spec/j1-fixtures"
import { installFixture } from "../../src/mainview/state/seams/InstallFixtures.test-support"
import * as Y from "yjs"
import { fixtures } from "../../../../packages/rpc/test/fixtures/Todo"

// Browser proof of receipt navigation and the real app HTTP seam. The HTTP
// projections are literal fixtures, not evidence of merge admission/microVMs.
test("a merged TODO opens its proposal, which remains embedded and survives reload", async ({ page }) => {
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "credentials", sandbox: null
  } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/members", route => route.fulfill({ json: { members: [], access_url: "https://github.com/acme/api/settings/access" } }))
  const todo = { ...fixtures.merged.model, n: 7, lessons: 2,
    lessons_receipt: { todo: 7, lessons: [{ title: "Retry decision", ref: "wiki:retry-decision" }, { title: "Run lint before review", ref: "proposal:check:lint@review" }] } }
  await page.route("**/api/todos", route => route.fulfill({ json: [todo] }))
  await page.route("**/api/todos/7", route => route.fulfill({ json: todo }))
  const doc = new Y.Doc()
  doc.getText("markdown").insert(0, "# Retry decision\n\nUse the existing retry helper because it already backs off. [Change #41](https://github.com/acme/api/pull/41)")
  const row = { id: 42, slug: "retry-decision", path: "retry-decision.md", title: "Retry decision", body: doc.getText("markdown").toString(),
    revision: 1, author: { id: 1, login: "coding" }, created_at: "2026-10-06", updated_at: "2026-10-06" }
  const document = { page: row, state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"), state_vector: Buffer.from(Y.encodeStateVector(doc)).toString("base64") }
  doc.destroy()
  await page.route("**/api/repos/smithersai/smithers/wiki?*", route => route.fulfill({ json: [row] }))
  await page.route("**/api/repos/smithersai/smithers/wiki/navigation/index?*", route => route.fulfill({ json: { pages: [{ ...row, metadata: {} }] } }))
  await page.route("**/api/repos/smithersai/smithers/wiki/retry-decision/document?*", route => route.fulfill({ json: document }))
  let state = "open", accepts = 0
  const proposal = () => ({ id: "check:lint@review", title: "Run lint before review", evidence: ["3 of the last 5 failed lint at review"],
    refs: [{ label: "T7", url: "https://github.com/acme/api/pull/41" }], state,
    ...(state === "accepted" ? { todo: { n: 8, title: "Run lint before review" } } : {}) })
  await page.route("**/api/proposals", route => route.fulfill({ json: [proposal()] }))
  await page.route("**/api/proposals/check%3Alint%40review/accept", route => {
    accepts++; state = "accepted"; return route.fulfill({ status: 202, json: proposal() })
  })
  await page.goto("/")
  await say(page, "/todo T7")
  const receipt = page.getByRole("region", { name: "Lessons from T7" })
  await expect(receipt).toContainText("2 lessons")
  await receipt.getByRole("button", { name: "Retry decision", exact: true }).press("Enter")
  await expect(page.getByTestId("card-wiki-open-wiki:smithersai/smithers:42")).toContainText("Use the existing retry helper")
  await receipt.getByRole("button", { name: "Run lint before review", exact: true }).press("Enter")
  const card = page.locator('[data-kind="proposal"]').last()
  await expect(card).toContainText("3 of the last 5 failed lint at review")
  expect(accepts).toBe(0)
  await card.getByRole("button", { name: "Make TODO", exact: true }).press("Enter")
  await expect(card).toContainText("Accepted")
  expect(accepts).toBe(1)
  await page.reload()
  await expect(card).toContainText("Accepted")
  await expect(card).toContainText("T8")
  await fillComposer(page, "Continue chatting")
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await expect(page.locator('[data-maximized="true"]')).toHaveCount(0)
})
