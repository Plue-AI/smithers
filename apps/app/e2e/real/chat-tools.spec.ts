import type { TestInfo } from "@playwright/test"
import { authenticatedTest } from "./auth-permissions/profile"
import { launchFaultHarness } from "./chat-tools/fault-process"
import {
  assistantMessages,
  bootWorkspace,
  captureCancelReply,
  captureTurnTraffic,
  completedAssistantContaining,
  nextTurnResponse,
  parseTurnFrames,
  toolExecution,
  transcript
} from "./chat-tools/ui"
import { scenario } from "./coverage/types"
import {
  closeComposer,
  command,
  expect,
  openComposer,
  realApi,
  reloadApp,
  test
} from "./support/test"

const chatTest = process.env.SMITHERS_REAL_E2E_MODE !== undefined || process.env.SMITHERS_REAL_E2E_HOST === "production"
  ? authenticatedTest
  : test

test.setTimeout(180_000)
test.use({ actionTimeout: 20_000 })

const attachJson = async (testInfo: TestInfo, name: string, value: unknown): Promise<void> => {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json"
  })
}

chatTest("a grounded answer arrives as multiple real stream frames and completes in the transcript", scenario("chat.stream-grounded", {
  capabilities: ["agent"],
  coverage: ["action:chat.send", "host:local", "host:production", "path:success", "door:user-only", "dimension:streaming", "evidence:agent-turn-ndjson"],
  description: "Send a unique grounded prompt through the composer and correlate the rendered answer with multiple backend NDJSON deltas."
}), async ({ page }, testInfo) => {
  await bootWorkspace(page)
  const marker = `STREAM_GROUNDED_${Date.now()}`
  const expected = `${marker} ${Array.from({ length: 48 }, (_, index) => `word${index + 1}`).join(" ")}`
  const traffic = await captureTurnTraffic(page)
  const turnResponse = nextTurnResponse(page)

  await command(page, `Reply with exactly the following line and no other text:\n${expected}`)
  expect((await turnResponse).status()).toBe(200)
  const answer = await completedAssistantContaining(page, marker)
  await expect(answer.locator(".message-markdown")).toContainText(expected)

  const bodies = await traffic.read()
  const frames = parseTurnFrames(bodies)
  const deltas = frames.filter((frame) => frame.type === "delta" && frame.kind === "text" && typeof frame.text === "string" && frame.text.length > 0)
  expect(deltas.length).toBeGreaterThan(1)
  expect(deltas.map((frame) => frame.text).join("")).toContain(expected)
  expect(frames.some((frame) => frame.type === "done" && frame.error === undefined)).toBe(true)
  await attachJson(testInfo, "real-stream-frames", frames)
})

chatTest("the model invokes browser.open and cites content returned by the real fetch service", scenario("chat.tool-browser-open", {
  capabilities: ["agent", "browser.read"],
  coverage: ["action:chat.send", "action:browser.open", "host:local", "host:production", "path:success", "door:agent", "dimension:tool-loop", "dimension:network", "evidence:browser-tool-and-fetch"],
  description: "Require a real backend tool call to browser.open, correlate it with browser-fetch traffic, and verify the model reads the public page."
}), async ({ page }, testInfo) => {
  await bootWorkspace(page)
  const marker = `BROWSER_TOOL_${Date.now()}`
  const fetchResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tools/browser-fetch")
  const traffic = await captureTurnTraffic(page)
  const turnResponse = nextTurnResponse(page)

  await command(page, `Use the commands tool to execute browser.open with args https://example.com/. Read the returned page before answering. Then answer with ${marker} and the page heading.`)
  expect((await turnResponse).status()).toBe(200)
  const answer = await completedAssistantContaining(page, marker)
  await expect(answer).toContainText("Example Domain")
  const fetched = await fetchResponse
  expect(fetched.status()).toBe(200)
  const independentFetch = await realApi(page, page.context().request, "POST", "/api/tools/browser-fetch", fetched.request().postDataJSON())
  expect(independentFetch.status()).toBe(200)
  const fetchBody = await independentFetch.json() as { readonly text?: unknown; readonly finalUrl?: unknown }
  expect(fetchBody.text).toContain("Example Domain")
  expect(fetchBody.finalUrl).toBe("https://example.com/")

  const frames = parseTurnFrames(await traffic.read())
  const execution = toolExecution(frames, "browser.open")
  expect(execution?.args).toBe("https://example.com/")
  const card = transcript(page).locator('.smithers-card[data-kind="browser"]')
  await expect(card.locator(".browser-card-url")).toContainText("https://example.com/")
  await attachJson(testInfo, "browser-tool-evidence", { execution, fetchBody, frames })
})

chatTest("Stop generating cancels the live backend turn and leaves an honest stable interruption", scenario("chat.stop-real-turn", {
  capabilities: ["agent"],
  coverage: ["action:chat.send", "action:chat.stop", "host:local", "host:production", "path:success", "door:button", "door:user-only", "dimension:cancellation", "evidence:backend-cancel-ack"],
  description: "Start a long real model response, stop it through the visible control, and verify the cancellation endpoint and stable interrupted state."
}), async ({ page }, testInfo) => {
  await bootWorkspace(page)
  const marker = `STOP_REAL_${Date.now()}`
  await command(page, `Write a detailed 2500-word technical essay about distributed systems. Begin with ${marker}.`)
  // Cancel a proven running provider turn, after admission and the first delta.
  await expect(assistantMessages(page).last()).toContainText(marker, { timeout: 90_000 })
  await expect(transcript(page)).toHaveAttribute("aria-busy", "true")
  await openComposer(page)
  const stop = page.locator('[data-flow="chat.stop"]:visible')
  await expect(stop).toBeVisible({ timeout: 30_000 })
  const cancelTraffic = await captureCancelReply(page)
  const cancelling = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/turn/cancel")
  await stop.click()

  const cancelResponse = await cancelling
  expect(cancelResponse.status()).toBe(200)
  const cancelBodies = await cancelTraffic.read()
  expect(cancelBodies).toHaveLength(1)
  const cancelBody = JSON.parse(cancelBodies[0]!) as { readonly ok?: unknown; readonly status?: unknown }
  expect(cancelBody.status, JSON.stringify(cancelBody)).toBe("cancelled")
  const interrupted = assistantMessages(page).last()
  await expect(interrupted.locator(".bubble-system-note")).toContainText("Turn interrupted")
  await expect(transcript(page)).toHaveAttribute("aria-busy", "false")
  const stableText = await interrupted.textContent()
  await page.waitForTimeout(750)
  expect(await interrupted.textContent()).toBe(stableText)
  await attachJson(testInfo, "cancel-evidence", cancelBody)
})

chatTest("a killed real chat transport fails visibly and Retry succeeds after the process returns", scenario("chat.failure-retry-process", {
  capabilities: ["agent"],
  coverage: ["action:chat.send", "action:chat.retry", "host:local", "path:error", "path:success", "door:button", "dimension:process-fault", "dimension:retry", "evidence:killed-upstream-process-and-retry"],
  description: "Kill an actual passthrough process used by a real product server, observe the failed turn, restart it, and retry through the UI."
}), async ({ page, request }, testInfo) => {
  const harness = await launchFaultHarness()
  try {
    await bootWorkspace(page, harness.origin)
    const bootstrapResponse = await realApi(page, request, "GET", "/api/bootstrap")
    expect(bootstrapResponse.status()).toBe(200)
    const bootstrap = await bootstrapResponse.json() as { readonly host?: unknown; readonly capabilities?: unknown }
    expect(bootstrap.host).toBe("local")
    expect(Array.isArray(bootstrap.capabilities) && bootstrap.capabilities.includes("agent")).toBe(true)

    const marker = `RETRY_RECOVERED_${Date.now()}`
    const prompt = `Reply with exactly ${marker}`
    await harness.fault()
    const failedTraffic = await captureTurnTraffic(page)
    await command(page, prompt)
    const failed = assistantMessages(page).last()
    await expect(failed.locator(".bubble-system-note")).toHaveText("Turn failed", { timeout: 30_000 })
    const failedFrames = parseTurnFrames(await failedTraffic.read())
    expect(failedFrames.some((frame) => frame.type === "done" && typeof frame.error === "string")).toBe(true)

    await harness.restore()
    const retryTraffic = await captureTurnTraffic(page)
    await closeComposer(page)
    const retry = failed.getByRole("button", { name: "Retry turn", exact: true })
    await retry.focus()
    await retry.press("Enter")
    await completedAssistantContaining(page, marker)
    const retryFrames = parseTurnFrames(await retryTraffic.read())
    expect(retryFrames.some((frame) => frame.type === "done" && frame.error === undefined)).toBe(true)
    await expect(transcript(page).locator('.smithers-chat-message[data-role="user"]').filter({ hasText: prompt })).toHaveCount(1)
    await attachJson(testInfo, "process-fault-evidence", {
      processLog: harness.evidence(),
      failedFrames,
      retryFrames
    })
  } finally {
    await harness.close()
  }
})

test("a multiline draft survives keyboard dismissal and a real reload before submission", scenario("chat.multiline-draft-persistence", {
  capabilities: [],
  coverage: ["action:chat.open", "host:local", "host:production", "path:keyboard", "path:persistence", "door:user-only", "dimension:keyboard", "dimension:multiline-draft", "evidence:reload-draft-value"],
  description: "Create a multiline draft using Shift+Enter, dismiss and reopen the composer, then reload and verify the exact draft remains."
}), async ({ page }, testInfo) => {
  await bootWorkspace(page)
  await openComposer(page)
  const input = page.getByTestId("composer-input")
  const first = `draft-first-${Date.now()}`
  const second = `draft-second-${Date.now()}`
  await input.fill(first)
  await input.press("Shift+Enter")
  await input.type(second)
  const expected = `${first}\n${second}`
  await expect(input).toHaveValue(expected)
  await closeComposer(page)
  await openComposer(page)
  await expect(input).toHaveValue(expected)
  await closeComposer(page)
  await reloadApp(page)
  await page.getByRole("button", { name: "Chat", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await expect(page.getByTestId("composer-input")).toHaveValue(expected)
  await attachJson(testInfo, "draft-persistence-evidence", { expected, url: page.url() })
})

test("Copy message writes the complete rendered catalog to the real browser clipboard", scenario("chat.copy-message-clipboard", {
  capabilities: [],
  coverage: ["action:chat.commands", "action:chat.copy-message", "host:local", "host:production", "path:success", "path:keyboard", "door:slash", "door:button", "dimension:keyboard", "dimension:clipboard", "evidence:browser-clipboard-readback"],
  description: "Render the command catalog, use its Copy message control, and independently read the browser clipboard contents."
}), async ({ page, context }, testInfo) => {
  await bootWorkspace(page)
  await command(page, "/chat.commands")
  const catalog = transcript(page).locator(".smithers-chat-message").filter({ hasText: "/chat.stop" }).last()
  await expect(catalog).toContainText("/chat.send")
  await closeComposer(page)
  const heading = await catalog.locator(".message-markdown p").first().innerText()
  const rows = await catalog.locator(".message-markdown li").evaluateAll((items) => {
    const markdown = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ""
      const contents = [...node.childNodes].map(markdown).join("")
      return node instanceof HTMLElement && node.tagName === "CODE" ? "`" + contents + "`" : contents
    }
    return items.map(markdown)
  })
  const expected = `${heading}\n\n${rows.map((row) => `- ${row}`).join("\n")}\n\nType \`/\` in the composer to filter these as you type.`
  expect(rows.length).toBeGreaterThan(1)
  const origin = new URL(page.url()).origin
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin })
  const copy = catalog.getByRole("button", { name: "Copy message", exact: true })
  await copy.focus()
  await expect(copy).toBeFocused()
  await copy.press("Enter")
  await expect(catalog.getByRole("button", { name: "Copied", exact: true })).toBeVisible()
  const clipboard = await page.evaluate(() => navigator.clipboard.readText())
  expect(clipboard).toBe(expected)
  await attachJson(testInfo, "clipboard-evidence", { length: clipboard.length, exactMatch: clipboard === expected })

})

test("slash browser.open fetches and renders a public page without interception", scenario("chat.browser-fetch-public", {
  capabilities: ["browser.read"],
  coverage: ["action:browser.open", "host:local", "host:production", "path:success", "door:slash", "dimension:network", "evidence:browser-fetch-response"],
  description: "Open a public URL through the slash door and verify the real fetch response and rendered browser card."
}), async ({ page }, testInfo) => {
  await bootWorkspace(page)
  const fetching = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tools/browser-fetch")
  await command(page, "/browser.open https://example.com/")
  const response = await fetching
  expect(response.status()).toBe(200)
  const body = await response.json() as { readonly text?: unknown; readonly finalUrl?: unknown; readonly frameable?: unknown }
  expect(body.text).toContain("Example Domain")
  expect(body.finalUrl).toBe("https://example.com/")
  const card = transcript(page).locator('.smithers-card[data-kind="browser"]')
  await expect(card).toBeVisible()
  await expect(card.locator(".browser-card-url")).toContainText("https://example.com/")
  await attachJson(testInfo, "public-browser-fetch-evidence", body)
})

test("slash browser.open exposes the real service rejection for a loopback target", scenario("chat.browser-fetch-private-error", {
  capabilities: ["browser.read"],
  coverage: ["action:browser.open", "host:local", "host:production", "path:error", "door:slash", "dimension:ssrf", "dimension:network"],
  description: "Attempt a loopback fetch through the real UI and require the browser-fetch service and card to expose the protected-target error."
}), async ({ page }, testInfo) => {
  await bootWorkspace(page)
  const fetching = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tools/browser-fetch")
  await command(page, "/browser.open https://127.0.0.1/")
  const response = await fetching
  expect(response.status()).toBe(400)
  expect(response.request().postDataJSON()).toEqual({ url: "https://127.0.0.1/" })
  const body = await response.json() as { readonly status?: unknown; readonly message?: unknown }
  expect(body).toMatchObject({
    status: "error",
    code: "request_invalid",
    message: "That address points at a private host, which the browser tool never reads."
  })
  const card = transcript(page).locator('.smithers-card[data-kind="browser"]')
  await expect(card).toBeVisible()
  await expect(card.getByRole("alert")).toHaveText(body.message as string)
  await expect(card.locator("iframe")).toHaveCount(0)
  await expect(card.getByRole("link", { name: "Open in a new tab", exact: true })).toHaveCount(0)
  await attachJson(testInfo, "private-browser-fetch-evidence", { status: response.status(), body })
})

authenticatedTest("production recommendations come from the live recommender and clicking one reports its outcome", scenario("chat.production-recommendation-outcome", {
  capabilities: ["agent", "cloud", "identity"],
  coverage: ["action:chat.send", "action:system.recommend", "host:production", "path:success", "door:button", "dimension:recommendations", "dimension:network", "dimension:admin-audit-readback", "evidence:recommend-answer-and-durable-outcome"],
  description: "On smithers.sh, complete a real turn, match rendered pills to the live recommendation answer, and verify the chosen outcome request and its durable server log row."
}), async ({ page, request }, testInfo) => {
  await bootWorkspace(page)
  const sessionResponse = await realApi(page, request, "GET", "/api/user")
  expect(sessionResponse.status()).toBe(200)
  const identity = await sessionResponse.json() as { readonly login?: unknown; readonly allowlisted?: unknown; readonly admin?: unknown }
  expect(identity.login,
    "Live recommendation success requires a real signed-in production browser session; anonymous refusal is not coverage.")
    .toEqual(expect.any(String))
  expect((identity.login as string).trim()).not.toBe("")
  expect(identity.allowlisted, "The real identity must have access to production chat.").toBe(true)
  expect(identity.admin, "The durable outcome audit requires the real admin canary profile.").toBe(true)
  const bootstrapResponse = await realApi(page, request, "GET", "/api/bootstrap")
  expect(bootstrapResponse.status()).toBe(200)
  const bootstrap = await bootstrapResponse.json() as { readonly host?: unknown; readonly buildSha?: unknown }
  expect(bootstrap.host, "This scenario requires the production cloud host.").toBe("cloud")
  expect(typeof bootstrap.buildSha).toBe("string")

  const marker = `RECOMMEND_${Date.now()}`
  const recommendation = page.waitForResponse((response) => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/recommend") return false
    const submitted = response.request().postDataJSON() as { readonly tail?: ReadonlyArray<{ readonly role?: unknown; readonly text?: unknown }> }
    return submitted.tail?.some((entry) => entry.role === "assistant" && entry.text === marker) === true
  }, { timeout: 120_000 })
  await command(page, `I am only browsing this repository and want to read its documentation, issues, or command catalog. Reply with exactly ${marker}`)
  // Opening the composer is itself an outcome-reporting action. Open it
  // while the real turn is running, before its completed-answer recommendation.
  await openComposer(page)
  await completedAssistantContaining(page, marker)
  const response = await recommendation
  expect(response.status()).toBe(200)
  const answer = await response.json() as { readonly id?: unknown; readonly model?: unknown; readonly commands?: readonly unknown[] }
  expect(typeof answer.id).toBe("string")
  expect(typeof answer.model).toBe("string")
  expect(Array.isArray(answer.commands) && answer.commands.length > 0).toBe(true)

  const readOffered = () => page.locator(".smithers-suggestion:visible").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-flow")).filter((flow): flow is string => flow !== null))
  const named = answer.commands!.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.replace(/^\/+/, ""))
  // The client may omit duplicate, unknown, or current-surface suggestions.
  // Every rendered pill must still come from this completed-answer response.
  await expect.poll(async () => {
    const current = await readOffered()
    return current.length > 0 && current.every((flow) => named.includes(flow))
  }).toBe(true)
  const offered = await readOffered()
  // These doors only read state or open local UI. Remote mutation flows are
  // not eligible for the recommendation-click fixture.
  const safeActions = new Set([
    "wiki", "chat.commands", "appearance.theme", "search.open", "auth.prompt", "cloud.prompt",
    "issues.list", "prs.list", "flow.list", "runs.list", "approvals.list", "plugins", "connect", "account.show"
  ])
  const recommended = named.find((entry) => safeActions.has(entry) && offered.includes(entry))
  await attachJson(testInfo, "recommendation-before-click", { bootstrap, answer, offered, eligible: recommended })
  expect(typeof recommended, "The real recommender must offer a read-only or local-UI action for this fixture.").toBe("string")
  const flow = recommended!.replace(/^\/+/, "")
  const outcome = page.waitForResponse((candidate) =>
    candidate.request().method() === "POST" && new URL(candidate.url()).pathname === "/api/recommend/outcome")
  await page.locator(`.smithers-suggestion[data-flow="${flow}"]`).click()
  const outcomeResponse = await outcome
  expect(outcomeResponse.status()).toBe(204)
  const outcomeRequest = outcomeResponse.request().postDataJSON() as { readonly id?: unknown; readonly command?: unknown }
  expect(outcomeRequest).toEqual({ id: answer.id, command: flow })
  const audit = await realApi(page, request, "GET", "/api/admin/recommend/log?limit=200")
  expect(audit.status()).toBe(200)
  const log = await audit.json() as { readonly status?: unknown; readonly rows?: ReadonlyArray<{
    readonly id?: unknown; readonly commands?: unknown; readonly model?: unknown; readonly outcome?: { readonly command?: unknown }
  }> }
  expect(log.status).toBe("ok")
  const ownRows = log.rows?.filter((row) => row.id === answer.id)
  expect(ownRows).toHaveLength(1)
  expect(ownRows![0]).toMatchObject({ id: answer.id, commands: answer.commands, model: answer.model, outcome: { command: flow } })
  await attachJson(testInfo, "recommendation-evidence", { bootstrap, answer, offered, outcomeRequest, ownedLogRow: ownRows![0] })
})

test("files.add explains the unavailable attachment capability through its slash action", scenario("chat.attachment-unavailable", {
  capabilities: [],
  coverage: ["action:files.add", "host:local", "host:production", "path:error", "door:slash", "dimension:attachment-unavailable"],
  description: "The shipped host explicitly lacks attachment upload; the registered files.add action must explain that limitation and its supported repository alternative."
}), async ({ page }) => {
  await bootWorkspace(page)
  await command(page, "/files.add")
  await closeComposer(page)
  await expect(transcript(page)).toContainText("Attachments aren't available on this host yet. Connect a repository and Smithers can read its files.")
})