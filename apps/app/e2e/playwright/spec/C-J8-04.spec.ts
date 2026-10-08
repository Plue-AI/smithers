import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { ISSUE_REPO, issueTodoInstall } from "./issue-todo-fixture"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "@smthrs/rpc/TodoCard"

// Browser projection only. The microVM plan/selector receipt is qualified by
// TestPlanWikiCitationsReferenceHost; these responses exercise the real seam.
test("C-J8-04: Retry preserves old citations and opens captured history after reload", async ({ page }) => {
  await issueTodoInstall(page)
  const model: TodoCard = structuredClone(fixtures.failed.model)
  model.n = 12
  const citation = (revision: number, digest: string) => ({
    kind: "wiki" as const, slug: "retry-policy", pageID: "42", revision, digest,
    url: `/api/repos/${ISSUE_REPO}/wiki/history/42/${revision}/content?visibility=public`
  })
  model.evidence = [{ attempt: 1, revision: "first", items: [citation(3,
    "0314a7d6edf2ad4b7057d059f7dfdf17df0ab800ec24b502f02ecb38c1bbed22")] }]
  const earlier = structuredClone(model.evidence[0])
  const writes: { key: string; body: unknown }[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/12", async route => {
    if (route.request().method() === "POST") {
      writes.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() })
      model.state = "in_review"
      delete model.failure
      model.evidence.push({ attempt: 2, revision: "second", items: [citation(4,
        "e47d2d025a859ead6080b931b2b718bfa2937244433746068d08770278b36c7c")] })
      await route.fulfill({ status: 202, json: { state: "accepted", attempt: 2 } })
    } else await route.fulfill({ json: model })
  })
  await page.goto(`/${ISSUE_REPO}`)
  await say(page, "/todo T12")
  const card = page.getByRole("article", { name: "TODO T12", exact: true }).last()
  await expect(card.getByRole("link", { name: "retry-policy · r3", exact: true })).toHaveAttribute("href", `/api/repos/${ISSUE_REPO}/wiki/history/42/3/content?visibility=public`)
  await card.getByRole("button", { name: "Retry", exact: true }).press("Enter")
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]!.body).toEqual({ op: "retry" })
  expect(writes[0]!.key).toBeTruthy()
  expect(model.evidence[0]).toEqual(earlier)
  await page.reload()
  await expect(card.getByRole("region", { name: "Attempt 1 evidence", exact: true }).getByRole("link", { name: "retry-policy · r3", exact: true })).toBeVisible()
  await expect(card.getByRole("region", { name: "Attempt 2 evidence", exact: true }).getByRole("link", { name: "retry-policy · r4", exact: true })).toBeVisible()
  await expect(card.getByRole("link", { name: /release-process/ })).toHaveCount(0)
  for (const [revision, body] of [[3, "Webhook retries use `retry()` with exponential backoff."], [4, "Webhook retries use `retryFixed(5000)`."]] as const) {
    const path = `/api/repos/${ISSUE_REPO}/wiki/history/42/${revision}/content`
    await page.route(`**${path}?visibility=public`, route => route.fulfill({ contentType: "text/plain", body }))
    const response = page.waitForResponse(r => new URL(r.url()).pathname === path)
    await card.getByRole("link", { name: `retry-policy · r${revision}`, exact: true }).press("Enter")
    expect(await (await response).text()).toBe(body)
    // A history content link is a native navigation; return to the persisted card.
    await page.goBack()
    await expect(card).toBeVisible()
  }
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
