import { expect, test, type Page } from "@playwright/test"
import { AUTHORED_FLOW, AUTHORING_READ, AUTHORING_VALIDATE, GRAPH_FLOW, GRAPH_REPO } from "./workspace"
import { finishSignup, openChat } from "./app"

const command = async (page: Page, text: string) => {
  const composer = page.getByTestId("composer-input")
  await openChat(page)
  await composer.fill(text)
  await composer.press("Enter")
}

/*
 * The builder loop, end to end, on the production path.
 *
 * The author is scripted — no provider is involved — and nothing under it is.
 * The run writes a real `@smthrs/flow` graph file, shaped the way
 * `flows/create-flow/scaffold/flow.mdx` teaches one, through the engine's
 * workspace sandbox and copy-back. The box then DISCOVERS it: a real registry,
 * a real measured module load, and the catalog refresh that registers the
 * rebuilt body with the running engine. Nothing is registered on the authored
 * flow's behalf, which is what the listing that does not hold it, the plan
 * this card redraws, and the run it launches are evidence of (D-081).
 */
test("authors, edits, replans and runs the written source from chat", async ({ page }) => {
  await page.goto("/")
  await finishSignup(page)
  // Nothing on this host names the authored flow yet: its entry file has not
  // been written, and the registry lists what is on disk.
  await command(page, `/flow.list ${GRAPH_REPO}`)
  await expect(page.locator(`[data-flow="flow.run"][data-flow-args="${GRAPH_FLOW}"]`)).toBeVisible()
  await expect(page.locator(`[data-flow="flow.run"][data-flow-args="${AUTHORED_FLOW}"]`)).toHaveCount(0)
  const request = `/flow.create Build a flow ${GRAPH_REPO}`
  await command(page, request)
  const author = page.locator('.smithers-card[data-kind="run-trace"]').first()
  await expect(author).toContainText("Creating a flow")
  const plan = page.locator('.smithers-card[data-kind="flow-plan"]')
  const read = plan.locator(`.flow-graph-node[data-node="${AUTHORING_READ}"]`)
  const validate = plan.locator(`.flow-graph-node[data-node="${AUTHORING_VALIDATE}"]`)
  await expect(read).toBeVisible()
  await expect(validate).toHaveCount(0)
  const planId = await plan.getAttribute("data-testid")

  // Repeating the command neither launches another author nor blocks chat.
  await command(page, request)
  await expect(page.locator('.smithers-card[data-kind="run-trace"]')).toHaveCount(1)
  await command(page, "hello")
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await expect(page.getByText("Local chat accepts /flow.* commands.", { exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-stop")).not.toBeVisible()
  await expect(page.locator("body")).not.toContainText("stub:")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("composer-overlay")).not.toBeVisible()

  await read.click()
  await expect(plan.locator(".flow-graph-drawer")).toHaveAttribute("data-node", AUTHORING_READ)
  await command(page, `/flow.create Add validation to authoring-demo ${GRAPH_REPO}`)

  await expect(validate).toBeVisible()
  await expect(plan).toHaveCount(1)
  await expect(plan).toHaveAttribute("data-testid", planId!)
  await expect(plan.locator(".flow-graph-drawer")).toHaveAttribute("data-node", AUTHORING_READ)
  await expect(plan.locator(".flow-graph-drawer")).toContainText("unchanged")
  await validate.click()
  await expect(plan.locator(".flow-graph-drawer")).toContainText("added")
  await expect(plan.locator(".flow-plan-key-changes")).toContainText("changed keys")
  // The source update moved the same plan beside its authoring card.
  const editor = page.locator('.smithers-card[data-kind="run-trace"]').last()
  const order = await page.locator('.smithers-card').evaluateAll(cards => cards.map(card => card.getAttribute("data-testid")))
  expect(order.indexOf(planId)).toBe(order.indexOf(await editor.getAttribute("data-testid")) - 1)
  await expect(page.locator('.mvp-notice[data-tone="live"]')).toHaveCount(0)
  await page.reload()
  await expect(validate).toBeVisible()
  await expect(plan).toHaveCount(1)
  await expect(plan).toHaveAttribute("data-testid", planId!)
  await expect(plan.locator(".flow-graph-drawer")).toHaveAttribute("data-node", AUTHORING_VALIDATE)
  await expect(plan.locator(".flow-graph-drawer")).toContainText("added")

  /*
   * And the box really DISCOVERED it. The listing is the registry's own
   * answer, so a flow appearing in it after a run wrote its entry file — and
   * nowhere in it before — is the whole claim: nothing on this host was
   * registered for `authoring-demo` until discovery found the file.
   */
  await command(page, `/flow.list ${GRAPH_REPO}`)
  await expect(page.locator(`[data-flow="flow.run"][data-flow-args="${AUTHORED_FLOW}"]`)).toBeVisible()

  await plan.locator('[data-flow="flow.run"]').click()
  await expect(page.locator('.smithers-card[data-kind="run-trace"]')).toHaveCount(3)
  const executed = page.locator('.smithers-card[data-kind="run-trace"]').last().locator('.run-trace[data-testid]')
  await expect(page.locator('.smithers-card[data-kind="run-trace"]').last()).toContainText("authoring-demo")
  await expect(executed).toHaveAttribute("data-testid", /^run-trace-(?!pending-).+/)
  const runId = (await executed.getAttribute("data-testid"))!.replace("run-trace-", "")
  await expect(page.getByTestId(`run-outcome-${runId}`)).toContainText("Finished")
  await executed.locator(`[data-flow="runs.trace.view"][data-flow-args="${runId} graph"]`).click()
  await expect(executed.locator('.flow-graph-node').filter({ hasText: "authoring/Validate" })).toHaveAttribute("data-state", "built")
})
