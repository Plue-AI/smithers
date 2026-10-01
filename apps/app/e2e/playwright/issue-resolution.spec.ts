import { expect, test } from "./browserTest"
import { SCOPED_TEST_USER, skipSignup, identityRoute } from "./identity"

// Real browser SQLite and flow forms; API replies are explicit fixtures, not
// evidence that a remote provider performed a delivery.
test("delivery resolution saves before sending, keeps Chat usable, and restores the readback", async ({ page }) => {
  const repo = "smithersai/smithers"
  await page.route("**/api/**", route => route.fulfill({ status: 404, json: { message: "No fixture" } }))
  await page.route("**/api/bootstrap", route => route.fulfill({ json: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["agent", "identity", "cloud"], authFlow: "native-handoff", sandbox: null } }))
  await page.route("**/api/user", identityRoute())
  await page.route("**/api/user/repos", route => route.fulfill({ json: [{ owner: "smithersai", name: "smithers", full_name: repo, owner_type: "Organization", default_bookmark: "main" }] }))
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: repo }] } }))
  await page.route(`**/api/repos/${repo}/contents`, route => route.fulfill({ json: [] }))
  await page.route(`**/api/repos/${repo}/issues/8`, route => route.fulfill({ json: {
    number: 8, title: "Delivery fixture", kind: "chat", visibility: "private", state: "open", author: { login: SCOPED_TEST_USER.login }, body: "", labels: []
  } }))
  await page.route(`**/api/repos/${repo}/issues/8/comments`, route => route.fulfill({ json: [] }))
  let state = "outcome_unknown"
  await page.route(`**/api/repos/${repo}/issues/8/sync`, route => route.fulfill({ json: {
    provider: "telegram", connection_id: "bot", scope_id: "123", conversation_id: "-100", state, delivery_id: 41, resolution_token: "claim-1"
  } }))
  const response = Promise.withResolvers<void>()
  const writes: unknown[] = []
  await page.route(`**/api/repos/${repo}/issues/sync/deliveries/41`, async route => {
    writes.push(route.request().postDataJSON())
    await response.promise
    state = "unsupported"
    await route.fulfill({ json: {} })
  })
  // Pause the actual COMMIT only after SQLite receives the resolution row.
  await page.addInitScript(() => {
    const nativePost = Worker.prototype.postMessage
    const held: Array<() => void> = []
    const probe = { armed: true, requested: false, commits: 0, release: () => { probe.armed = false; for (const send of held.splice(0)) send() } }
    ;(window as any).resolutionCommitProbe = probe
    Worker.prototype.postMessage = function(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      const send = () => Reflect.apply(nativePost, this, [message, options])
      if (probe.armed && typeof message === "object" && message !== null) {
        if ("params" in message && Array.isArray(message.params) && message.params.some(value => typeof value === "string" && value.includes('"resolution":') && value.includes('"status":"requested"'))) probe.requested = true
        if (probe.requested && "sql" in message && typeof message.sql === "string" && /^\s*COMMIT\b/i.test(message.sql)) {
          probe.commits++; held.push(send); return
        }
      }
      send()
    }
  })
  try {
    await page.goto(`/${repo}/`)
    await skipSignup(page)
    const input = page.getByTestId("composer-input")
    // Before the first job the cloud web app keeps Chat's controls away; Control+K is Chat's door throughout.
    if (!await input.isVisible()) await page.keyboard.press("Control+k")
    await input.fill(`/issues.view 8 ${repo}`)
    await input.press("Enter")
    const card = page.getByTestId(`card-issue-${repo}-8`)
    const resolve = card.getByRole("button", { name: "Resolve", exact: true })
    await expect(resolve).toBeVisible()
    await resolve.focus()
    await page.keyboard.press("Enter")
    const form = page.getByTestId("card-form-issues.sync.resolve")
    await expect(form).toBeVisible()
    await form.getByRole("combobox", { name: "Sent, skip, or retry (may duplicate)", exact: true }).selectOption("skip")
    await form.getByRole("textbox", { name: "Evidence / reason", exact: true }).fill("Verified this delivery should be skipped")
    const submit = form.getByTestId("flow-form-submit")
    await expect(submit).toBeEnabled()
    await submit.focus()
    await expect(submit).toBeFocused()
    await page.keyboard.press("Enter")
    await expect.poll(() => page.evaluate(() => (window as any).resolutionCommitProbe.commits)).toBeGreaterThan(0)
    expect(writes).toHaveLength(0)
    await page.keyboard.press("Control+k")
    await input.fill("A draft while the decision saves")
    await expect(input).toHaveValue("A draft while the decision saves")
    await page.evaluate(() => (window as any).resolutionCommitProbe.release())
    await expect.poll(() => writes.length).toBe(1)
    const toast = page.getByRole("status").filter({ hasText: "Resolving delivery" })
    await expect(toast).toBeVisible()
    await input.fill("Still editing while delivery resolution runs")
    await expect(input).toHaveValue("Still editing while delivery resolution runs")
    response.resolve()
    await expect(card.locator(".thread-slack-state")).toHaveAttribute("data-state", "unsupported")
    expect(writes).toEqual([{ resolution: "skip", expected_token: "claim-1", state: "unsupported", error: "Verified this delivery should be skipped", message_id: "" }])
    await expect(toast).toHaveCount(0)
    await page.reload()
    await expect(card.locator(".thread-slack-state")).toHaveAttribute("data-state", "unsupported")
    await expect(card.getByRole("button", { name: "Resolve", exact: true })).toHaveCount(0)
    expect(writes).toHaveLength(1)
  } finally {
    response.resolve()
    await page.evaluate(() => (window as any).resolutionCommitProbe.release()).catch(() => {})
  }
})
