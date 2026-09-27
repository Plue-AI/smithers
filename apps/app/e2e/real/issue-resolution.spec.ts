import { randomUUID } from "node:crypto"
import { authenticatedTest } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { awaitBoot, closeComposer, command, expect, realApi, reloadApp } from "./support/test"
import { finishFirstVisit } from "./support/first-visit"
import { scenarioOutcome, TEARDOWN_ANNOTATION, TeardownProblem } from "./support/teardown"

authenticatedTest("an owner resolves unknown deliveries with skip, sent and retry through the keyboard form", scenario("issues.owner-resolution-durable-replay", {
  capabilities: ["identity", "cloud"],
  description: "Create an owned repository and chat issue, submit an unknown worker receipt through the real claim API, exercise skip, sent and retry through the form, and independently verify the durable event and replay refusal. This proves host recovery, not an external provider send.",
  coverage: ["action:issues.sync.resolve", "host:local", "host:production", "path:success", "path:error", "path:persistence", "path:keyboard", "door:button", "dimension:keyboard", "dimension:owner-resolution", "dimension:duplicate-input", "dimension:reload", "evidence:backend-mapping-event-and-replay-readback"]
}), async ({ page, request }, testInfo) => {
  testInfo.setTimeout(180_000)
  const userResponse = await realApi(page, request, "GET", "/api/user")
  expect(userResponse.status()).toBe(200)
  const user = await userResponse.json() as { id: number; username: string }
  const name = `smithers-e2e-resolution-${randomUUID()}`
  const repo = `${user.username}/${name}`
  const repoPath = `/api/repos/${encodeURIComponent(user.username)}/${name}`
  let submitted = false, failure: unknown
  const cleanup: unknown[] = []
  try {
    // Only this uniquely named repository is eligible for cleanup, including
    // when creation succeeds but its response is lost. No import/job is started.
    submitted = true
    const createdRepo = await realApi(page, request, "POST", "/api/user/repos", { name, private: true, auto_init: false })
    expect(createdRepo.status()).toBe(201)
    expect(await createdRepo.json()).toMatchObject({ full_name: repo, private: true })
    for (const action of ["skip", "sent", "retry"] as const) {
      const createdIssue = await realApi(page, request, "POST", `${repoPath}/issues`, { title: "Owner delivery recovery", kind: "chat", visibility: "private" })
      expect(createdIssue.status()).toBe(201)
      const issue = await createdIssue.json() as { id: number; number: number }
      expect(issue.number).toEqual(expect.any(Number))
      const issuePath = `${repoPath}/issues/${issue.number}`
      const mapping = await realApi(page, request, "PUT", `${issuePath}/sync`, {
        provider: "telegram", connection_id: `${name}-${action}`, scope_id: "123", conversation_id: "-100"
      })
      expect(mapping.status()).toBe(200)
      const comment = await realApi(page, request, "POST", `${issuePath}/comments`, { body: "Owned delivery recovery acceptance" })
      expect(comment.status()).toBe(201)
      const deliveriesPath = `${repoPath}/issues/sync/deliveries`
      const deliveries = await realApi(page, request, "GET", deliveriesPath)
      expect(deliveries.status()).toBe(200)
      const rows = await deliveries.json() as Array<{ id: number; state: string; issue_id: number }>
      const issueRows = rows.filter(row => row.issue_id === issue.id)
      expect(issueRows).toHaveLength(1)
      expect(issueRows[0]).toMatchObject({ state: "pending", issue_id: issue.id })
      const deliveryId = issueRows[0]!.id
      const receiptPath = `${deliveriesPath}/${deliveryId}`
      const claimed = await realApi(page, request, "POST", receiptPath, {})
      expect(claimed.status()).toBe(200)
      const claim = await claimed.json() as { token: string }
      expect(claim.token).toMatch(/^[a-f0-9-]{36}$/)
      // The real worker receipt protocol prepares the uncertain state. There is
      // deliberately no provider credential or external delivery in this test.
      const unknown = await realApi(page, request, "PUT", receiptPath, {
        state: "outcome_unknown", token: claim.token, error: "Worker reported an unknown outcome for recovery acceptance"
      })
      expect(unknown.status()).toBe(200)
      const readMapping = async () => {
        const response = await realApi(page, request, "GET", `${issuePath}/sync`)
        expect(response.status()).toBe(200)
        return response.json()
      }
      expect(await readMapping()).toMatchObject({ state: "outcome_unknown", delivery_id: deliveryId, resolution_token: claim.token })

      const started = performance.now()
      await page.goto(`/${repo}`, { waitUntil: "domcontentloaded" })
      await awaitBoot(page, "navigate", started)
      await finishFirstVisit(page)
      await command(page, `/issues.view ${issue.number} ${repo}`)
      await closeComposer(page)
      // Frame navigation may reuse the existing card identity for a new issue.
      const card = page.locator('.smithers-card[data-kind="issue"]').filter({ has: page.getByTestId(`conversation-${issue.number}`) })
      const state = card.locator(".thread-slack-state")
      await expect(state).toHaveAttribute("data-state", "outcome_unknown")
      await card.getByRole("button", { name: "Resolve", exact: true }).press("Enter")
      const form = page.getByTestId("card-form-issues.sync.resolve")
      await expect(form.getByRole("spinbutton", { name: "Delivery id", exact: true })).toHaveValue(String(deliveryId))
      await form.getByRole("combobox", { name: "Sent, skip, or retry (may duplicate)", exact: true }).selectOption(action)
      const evidence = `Owner chose ${action} ${randomUUID()}`
      const messageId = action === "sent" ? "10" : ""
      await form.getByRole("textbox", { name: "Message ID (required for sent)", exact: true }).fill(messageId)
      await form.getByRole("textbox", { name: "Evidence / reason", exact: true }).fill(evidence)
      const submit = form.getByTestId("flow-form-submit")
      await expect(submit).toBeEnabled()
      await submit.focus()
      await expect(submit).toBeFocused()
      const completed = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === receiptPath, { timeout: 30_000 })
      void completed.catch(() => undefined)
      await page.keyboard.press("Enter")
      const response = await completed
      expect(response.status()).toBe(200)
      const decision = { resolution: action, expected_token: claim.token, state: { skip: "unsupported", sent: "sent", retry: "pending" }[action], error: evidence, message_id: messageId }
      const expectedState = action === "sent" ? "synced" : decision.state
      expect(response.request().postDataJSON()).toEqual(decision)
      await expect(state).toHaveAttribute("data-state", expectedState)
      await expect(card.getByRole("button", { name: "Resolve", exact: true })).toHaveCount(0)
      const settled = await readMapping()
      expect(settled.state).toBe(expectedState)
      expect(settled.error ?? "").toBe(action === "sent" ? "" : `Owner ${action}: ${evidence}`)
      expect(settled.delivery_id ?? 0).toBe(action === "sent" ? 0 : deliveryId)
      expect(settled.resolution_token ?? "").toBe("")
      const readResolutions = async () => {
        const events = await realApi(page, request, "GET", `${issuePath}/events`)
        expect(events.status()).toBe(200)
        return (await events.json() as Array<{ id: number; event_type: string; actor_id: number; payload: unknown }>).filter(event => event.event_type === "sync.resolved")
      }
      const resolutions = await readResolutions()
      expect(resolutions).toHaveLength(1)
      expect(resolutions[0]).toMatchObject({ actor_id: user.id, payload: { delivery_id: deliveryId, resolution: action, evidence, message_id: messageId, previous: { state: "outcome_unknown" } } })
      await reloadApp(page)
      await expect(state).toHaveAttribute("data-state", expectedState)
      await expect(card.getByRole("button", { name: "Resolve", exact: true })).toHaveCount(0)
      expect(await readMapping()).toEqual(settled)
      const repeated = await realApi(page, request, "PUT", receiptPath, decision)
      expect(repeated.status()).toBe(409)
      const lateWorker = await realApi(page, request, "PUT", receiptPath, { state: "sent", token: claim.token, message_id: "10" })
      expect(lateWorker.status()).toBe(409)
      expect(await readMapping()).toEqual(settled)
      expect(await readResolutions()).toEqual(resolutions)
      await testInfo.attach(`owner-resolution-${action}-readback`, { contentType: "application/json", body: Buffer.from(JSON.stringify({ repo, action, issue: issue.number, deliveryId, settled, resolutions, replayStatus: repeated.status(), lateWorkerStatus: lateWorker.status() })) })
    }
  } catch (error) { failure = error }
  finally {
    if (submitted) {
      try {
        const deleted = await realApi(page, request, "DELETE", repoPath)
        expect([204, 404]).toContain(deleted.status())
        expect((await realApi(page, request, "GET", repoPath)).status()).toBe(404)
        await testInfo.attach("owned-resolution-repository-cleanup", { contentType: "application/json", body: Buffer.from(JSON.stringify({ repo, status: 404 })) })
      } catch (error) { cleanup.push(new TeardownProblem(`Removing owned resolution repository ${repo} failed`, { cause: error })) }
    }
  }
  const outcome = scenarioOutcome({ repository: repo, bodyError: failure, teardownFailures: cleanup })
  for (const description of outcome.teardown) testInfo.annotations.push({ type: TEARDOWN_ANNOTATION, description })
  if (outcome.verdict !== undefined) throw outcome.verdict
})
