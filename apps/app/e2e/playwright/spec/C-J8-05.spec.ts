import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { ISSUE_REPO, issueTodoInstall } from "./issue-todo-fixture"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "@smthrs/rpc/TodoCard"

// Exact-revision browser projection. Real co-editing, decision following and
// three fresh-install model runs remain in real/wiki-decision-follow.spec.ts.
test("C-J8-05: older and newer TODO cards open their own decision revision", async ({ page }) => {
  await issueTodoInstall(page)
  const models: TodoCard[] = [1, 2].map(n => ({
    ...structuredClone(fixtures.queued.model), n, title: "Retry webhook deliveries",
    state: n === 1 ? "dropped" : "in_review", queue: undefined,
    evidence: [{ attempt: 1, revision: n === 1 ? "control" : "next", items: [{
      kind: "wiki", slug: "decisions/webhook-retries", pageID: "42", revision: n,
      digest: n === 1 ? "04cbfadd98b29ef5b7d4bf6b05c09fd6cf7eb1c3e63c066d99f28694518cd2b3" : "f7460cf359d890c3e25b8dc685f3aff14c5d72bc4fbc9cddf804c049498afc12",
      url: `/api/repos/${ISSUE_REPO}/wiki/history/42/${n}/content?visibility=public`
    }] }]
  }))
  await page.route("**/api/todos", route => route.fulfill({ json: models }))
  for (const model of models) await page.route(`**/api/todos/${model.n}`, route => route.fulfill({ json: model }))
  await page.goto(`/${ISSUE_REPO}`)
  for (const [n, body] of [[1, "Decision: webhook redelivery uses `retryExponential()`. Reason: provider rate limits."], [2, "Decision: webhook redelivery uses `retryFixed(5000)`. `retryExponential()` is not used for webhooks. Reason: the provider's idempotency window."]] as const) {
    await say(page, `/todo T${n}`)
    const card = page.getByRole("article", { name: `TODO T${n}`, exact: true }).last()
    await expect(card).toBeVisible()
    const link = card.getByRole("link", { name: `decisions/webhook-retries · r${n}`, exact: true })
    const path = `/api/repos/${ISSUE_REPO}/wiki/history/42/${n}/content`
    await expect(link).toHaveAttribute("href", `${path}?visibility=public`)
    await expect(card.getByRole("link", { name: `decisions/webhook-retries · r${n === 1 ? 2 : 1}`, exact: true })).toHaveCount(0)
    await page.route(`**${path}?visibility=public`, route => route.fulfill({ contentType: "text/plain", body }))
    const response = page.waitForResponse(r => new URL(r.url()).pathname === path)
    await link.press("Enter")
    expect(await (await response).text()).toBe(body)
    await page.goBack()
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await say(page, `/todo T${n}`)
    await expect(card).toBeVisible()
  }
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
