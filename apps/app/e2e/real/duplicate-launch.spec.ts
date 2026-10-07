import { test } from "./support"
import { scenario } from "./coverage/types"
import { withReference, runSlash, required, openTodo, todoCard, expect, attachJson } from "./todo/reference"
import { journeyReach, captureJourney, keyboardInputFor } from "./support/keyboard-journey-input"

// §21: real served Commit, physical double activation, then the identical
// command/key again. No request interception, fixture route or model replacement.
test("T-REL-02 duplicate Commit and command replay retain one TODO and attempt", scenario("journey-duplicate-launch", {
  capabilities: [], coverage: ["host:local", "host:production", "door:slash", "door:button", "surface:todo", "surface:draft", "dimension:keyboard", "path:persistence", "evidence:idempotent-launch"]
}), async ({ browser }, info) => {
  test.setTimeout(960_000)
  expect(required("SMITHERS_JOURNEY_KEYBOARD")).toBe("1")
  expect(["light", "dark"]).toContain(required("SMITHERS_JOURNEY_THEME"))
  await withReference(browser, info, async f => {
    const page = f.members.Will.page
    expect(await f.read("Will", "/api/todos")).toEqual([])
    const prompt = "Before editing README.md, ask me whether to document backoff or fixed delay. Wait for my answer."
    await runSlash(page, `/todo.new ${prompt}`)
    const draft = page.locator('.smithers-card[data-kind="draft"]').last()
    await expect(draft.getByLabel("Prompt", { exact: true })).toHaveValue(prompt)
    const commit = draft.getByRole("button", { name: "Commit", exact: true })
    await journeyReach(commit)
    await captureJourney(page)
    const created = page.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/todos")
    // Two actual activations of the same focused door, without a locator focus
    // shortcut or waiting for launch completion between them.
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    const response = await created
    expect(response.status()).toBe(202)
    const accepted = await response.json()
    expect(accepted.n).toBe(1)
    const request = response.request()
    const headers = await request.allHeaders()
    const key = headers["idempotency-key"]
    expect(key).toEqual(expect.any(String))
    expect(key.trim()).not.toBe("")
    // Carry only the production app's CSRF pair and key. BrowserContext owns
    // the member cookie. Never retain request headers/cookies in attachments.
    expect(headers["x-csrf-token"]).toEqual(expect.any(String))
    const replay = () => page.context().request.post(request.url(), {
      headers: { "Content-Type": "application/json", Origin: new URL(page.url()).origin,
        "X-CSRF-Token": headers["x-csrf-token"]!, "Idempotency-Key": key },
      data: request.postDataJSON()
    })
    const repeated = await replay()
    expect(repeated.status()).toBe(response.status())
    expect(await repeated.json()).toEqual(accepted)
    let waiting: any
    await expect.poll(async () => {
      const todos = await f.read("Will", "/api/todos")
      expect(todos).toHaveLength(1)
      waiting = await f.read("Will", "/api/todos/1")
      return waiting.state
    }, { timeout: 900_000, intervals: [1000, 2000] }).toBe("needs_you")
    expect(waiting.run.id).toEqual(expect.any(String))
    expect(waiting.waits.filter((wait: any) => wait.kind === "question")).toHaveLength(1)
    const identity = { run: waiting.run.id, attempt: waiting.run.attempt, flow: waiting.flow_version }
    // Replay after execution has reached a durable wait, too.
    const late = await replay()
    expect(late.status()).toBe(202)
    expect(await late.json()).toEqual(accepted)
    await openTodo(page, 1)
    await expect(todoCard(page, 1)).toContainText("Needs you")
    await runSlash(f.members.Ben.page, "/home")
    expect(await f.read("Ben", "/api/todos")).toHaveLength(1)
    const after = await f.read("Will", "/api/todos/1")
    expect({ run: after.run.id, attempt: after.run.attempt, flow: after.flow_version }).toEqual(identity)
    expect(after.state).toBe("needs_you")
    const events = await f.read("Will", "/api/todos/1/events")
    expect(events.Events.filter((event: any) => event.Type === "todo.created")).toHaveLength(1)
    await keyboardInputFor(page)!.observe()
    await attachJson(info, "duplicate-launch", { n: accepted.n, identity, commandReplays: 2, buttonActivations: 2,
      createdEvents: 1, state: after.state })
  })
})
