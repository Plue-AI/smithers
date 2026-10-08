import { writeFile } from "node:fs/promises"
import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"

// Production native CheckCommand runs on immutable exports in the composed
// install. Run TestJ11ThrashBrowser; no browser response or topic is replaced.
test("C-J11-04: native unchanged failures mark the TODO and Inspect, and a passing check clears them", async ({ page, context }, testInfo) => {
  const origin = process.env.SMITHERS_J11_ORIGIN
  const n = process.env.SMITHERS_J11_THRASH_N
  const cleared = process.env.SMITHERS_J11_CLEAR_N
  test.skip(!origin || !n || !cleared, "Run TestJ11ThrashBrowser with SMITHERS_J11_THRASH_BROWSER=1")
  const cookies: Array<{ Name: string; Value: string }> = JSON.parse(process.env.SMITHERS_J11_COOKIES!)
  await context.addCookies(cookies.map(c => ({ name: c.Name, value: c.Value, url: origin! })))
  await page.goto(origin!)
  await say(page, `/todo T${n}`)
  const todo = page.getByRole("article", { name: `TODO T${n}`, exact: true }).last()
  await expect(todo).toContainText("Thrashing: TestRetryBackoff failed 3×")
  await say(page, `/run.inspect ${process.env.SMITHERS_J11_THRASH_RUN}`)
  const run = page.locator('.mvp-run[data-maximized]')
  await expect(run.getByText(/Thrashed at Ran checks/).first()).toBeVisible()
  const flagged = await (await page.request.get(`${origin}/api/runs/${encodeURIComponent(process.env.SMITHERS_J11_THRASH_RUN!)}/trace`)).json()
  await writeFile(testInfo.outputPath("unchanged-journal-and-run.json"), JSON.stringify(flagged, null, 2))
  expect(flagged.attempts[0].phases.some((phase: { title: string; tone: string; indicator?: string }) => phase.title === "Ran checks · 1 failed" && phase.tone === "thrash" && phase.indicator === "Thrashing: TestRetryBackoff failed 3×")).toBe(true)
  await expect(run.getByRole("navigation", { name: "Run timeline" })).toContainText("Ran checks · 1 failed")
  await page.getByRole("button", { name: "Restore", exact: true }).press("Enter")
  await say(page, `/todo T${cleared}`)
  const clear = page.getByRole("article", { name: `TODO T${cleared}`, exact: true }).last()
  await expect(clear).toBeVisible()
  await expect(clear).not.toContainText("Thrashing")
  const evidence = await page.request.get(`${origin}/api/runs/${encodeURIComponent(process.env.SMITHERS_J11_CLEAR_RUN!)}/trace`)
  expect(evidence.status()).toBe(200)
  const monitor = await evidence.json()
  const probes = monitor.attempts[0].steps.filter((step: { output?: unknown }) => typeof step.output === "string" && step.output.includes('"checkId":"TestRetryBackoff"'))
  expect(probes.map((step: { output: string }) => JSON.parse(step.output).status)).toEqual(["failed", "failed", "failed", "passed"])
  for (const probe of probes) expect(probe.usage).toBeUndefined()
})

test("native edit and attempt boundaries suppress thrash, and a passing retry clears the same TODO", async ({ page, context }, testInfo) => {
  const origin = process.env.SMITHERS_J11_ORIGIN
  test.skip(!origin || !process.env.SMITHERS_J11_EDIT_RUN, "Run TestJ11ThrashBrowser with SMITHERS_J11_THRASH_BROWSER=1")
  const cookies: Array<{ Name: string; Value: string }> = JSON.parse(process.env.SMITHERS_J11_COOKIES!)
  await context.addCookies(cookies.map(c => ({ name: c.Name, value: c.Value, url: origin! })))
  const trace = async (id: string) => {
    const response = await page.request.get(`${origin}/api/runs/${encodeURIComponent(id)}/trace`)
    expect(response.status()).toBe(200)
    return response.json()
  }
  const edited = await trace(process.env.SMITHERS_J11_EDIT_RUN!)
  const split = await trace(process.env.SMITHERS_J11_SPLIT_RUN!)
  const splitPrevious = await trace(split.attempts[0].run_id)
  const passed = await trace(process.env.SMITHERS_J11_PASS_RUN!)
  const previous = await trace(process.env.SMITHERS_J11_PASS_PREVIOUS_RUN!)
  for (const [name, value] of [["edit-reset", edited], ["attempt-boundary", split], ["attempt-boundary-first", splitPrevious], ["same-todo-before", previous], ["same-todo-passed", passed]] as const) {
    await writeFile(testInfo.outputPath(`${name}-journal-and-run.json`), JSON.stringify(value, null, 2))
  }
  expect(edited.attempts[0].steps.filter((step: { output?: string }) => typeof step.output === "string" && step.output.includes('"checkId":"TestRetryBackoff"'))).toHaveLength(3)
  expect(edited.attempts[0].steps.some((step: { output?: string }) => typeof step.output === "string" && step.output.includes('"writes":["retry.go"]'))).toBe(true)
  expect(edited.attempts[0].phases.some((phase: { tone: string }) => phase.tone === "thrash")).toBe(false)
  expect(split.attempts.map((attempt: { n: number }) => attempt.n)).toEqual([1, 2])
  expect(split.attempts.map((attempt: { steps: Array<{ output?: string }> }) => attempt.steps.filter(step => typeof step.output === "string" && step.output.includes('"checkId":"TestRetryBackoff"')).length)).toEqual([2, 1])
  expect(split.attempts.some((attempt: { phases: Array<{ tone: string }> }) => attempt.phases.some(phase => phase.tone === "thrash"))).toBe(false)
  expect(previous.state).toBe("failed")
  const historicalResponse = await page.request.get(`${origin}/api/runs/${encodeURIComponent(process.env.SMITHERS_J11_PASS_PREVIOUS_RUN!)}/trace?at=${previous.journal.at(-1).seq}`)
  expect(historicalResponse.status()).toBe(200)
  const historical = await historicalResponse.json()
  await writeFile(testInfo.outputPath("same-todo-historical-journal-and-run.json"), JSON.stringify(historical, null, 2))
  expect(historical.attempts[0].phases.some((phase: { tone: string }) => phase.tone === "thrash")).toBe(true)
  expect(previous.attempts[0].steps.filter((step: { output?: string }) => typeof step.output === "string" && step.output.includes('"checkId":"TestRetryBackoff"'))).toHaveLength(3)
  expect(passed.attempts.map((attempt: { n: number }) => attempt.n)).toEqual([1, 2])
  expect(passed.attempts[1].phases.some((phase: { tone: string }) => phase.tone === "thrash")).toBe(false)
  for (const id of [process.env.SMITHERS_J11_EDIT_RUN!, process.env.SMITHERS_J11_SPLIT_RUN!, process.env.SMITHERS_J11_PASS_RUN!]) {
    expect(await trace(id)).toEqual(await trace(id))
  }
  await page.goto(origin!)
  for (const n of [process.env.SMITHERS_J11_EDIT_N!, process.env.SMITHERS_J11_SPLIT_N!, process.env.SMITHERS_J11_PASS_N!]) {
    await say(page, `/todo T${n}`)
    const card = page.getByRole("article", { name: `TODO T${n}`, exact: true }).last()
    await expect(card).toBeVisible()
    await expect(card).not.toContainText("Thrashing")
  }
})



test("native Retry launches another pinned attempt and retains the failed journal", async ({ page, context }) => {
  test.setTimeout(180_000)
  const origin = process.env.SMITHERS_J11_ORIGIN
  const n = process.env.SMITHERS_J11_RETRY_N
  const id = process.env.SMITHERS_J11_RETRY_RUN
  test.skip(!origin || !n || !id, "Run TestJ11NativeRetryBrowser with SMITHERS_J11_RETRY_BROWSER=1")
  const cookies: Array<{ Name: string; Value: string }> = JSON.parse(process.env.SMITHERS_J11_COOKIES!)
  await context.addCookies(cookies.map(c => ({ name: c.Name, value: c.Value, url: origin! })))
  const before = await (await page.request.get(`${origin}/api/todos/${n}`)).json()
  expect(before.run.attempt).toBe(1)
  await page.goto(origin!)
  await say(page, `/run.inspect ${id}`)
  const run = page.locator('.mvp-run[data-maximized]')
  await expect(run).toBeVisible()
  await run.getByRole("button", { name: "Retry", exact: true }).press("Enter")
  await expect.poll(async () => (await (await page.request.get(`${origin}/api/todos/${n}`)).json()).run?.attempt, { timeout: 120_000 }).toBe(2)
  await expect.poll(async () => (await (await page.request.get(`${origin}/api/todos/${n}`)).json()).state, { timeout: 120_000 }).toBe("failed")
  const after = await (await page.request.get(`${origin}/api/todos/${n}`)).json()
  expect(after.run.id).not.toBe(before.run.id)
  expect(after.flow_version).toEqual(before.flow_version)
  const previous = await page.request.get(`${origin}/api/runs/${encodeURIComponent(id!)}/trace`)
  expect(previous.status()).toBe(200)
  expect((await previous.json()).state).toBe("failed")
  const currentID = `${after.branch.id}:${after.run.id}`
  const current = await page.request.get(`${origin}/api/runs/${encodeURIComponent(currentID)}/trace`)
  expect(current.status()).toBe(200)
  const monitor = await current.json()
  expect(monitor.state).toBe("failed")
  expect(monitor.version).toEqual(before.flow_version.digest)
  expect(monitor.attempts.map((attempt: { n: number }) => attempt.n)).toEqual([1, 2])
  await page.getByRole("button", { name: "Restore", exact: true }).press("Enter")
  await say(page, `/run.inspect ${currentID}`)
  const retried = page.locator('.mvp-run[data-maximized]')
  await expect(retried.getByRole("list", { name: "Attempt 1", exact: true })).toBeVisible()
  await expect(retried.getByRole("list", { name: "Attempt 2", exact: true })).toBeVisible()
  const earlier = retried.getByRole("list", { name: "Attempt 1", exact: true }).getByRole("button").first()
  await earlier.focus()
  await earlier.press("Enter")
  await expect(retried.locator(".mvp-run-detail")).toBeVisible()
  await expect(earlier).toHaveAttribute("data-selected", "true")
})
