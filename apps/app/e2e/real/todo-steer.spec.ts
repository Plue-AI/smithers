import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { promisify } from "node:util"
import type { Page } from "@playwright/test"
import { test, realApi } from "./support"
import { withComposedInstall } from "./todo/composed-install"
import { journeyActivate, journeyEnter } from "./support/keyboard-journey-input"
import { scenario } from "./coverage/types"
import { attachJson, expect, required, runSlash, withReference } from "./todo/reference"

const browserSteer = "use the existing retry helper"
const agentSteer = "keep the max at 5"
const execute = promisify(execFile)
const todoCard = (page: Page, n: number) => page.getByRole("article", { name: `TODO T${n}`, exact: true }).last()
const openTodo = async (page: Page, n: number) => {
  await runSlash(page, `/todo T${n}`)
  await expect(todoCard(page, n)).toBeVisible()
}

// Run on Ben's laptop, in the directory where the installed Smithers skill
// is discoverable, after smthrs login <origin> --agent claude-code. The real
// provider observer writes JSONL {run_id, dispatch_at, messages}; it records
// requests when dispatched, not responses. Keep credentials out of this log.
test("C-J3-05 browser and Claude Code steer the same implementing run", scenario("journey-todo-steer", {
  capabilities: ["install"], coverage: ["host:production", "host:local", "surface:todo", "door:slash", "door:agent", "path:success", "dimension:next-model-turn", "dimension:attribution"]
}), async ({ browser }, info) => {
  test.setTimeout(960_000)
  if (process.env.SMITHERS_JOURNEY_COMPOSED_HOST) {
    // Supplemental browser proof uses the same served doors. Claude Code,
    // real model timing and helper semantics remain reference-host evidence.
    await withComposedInstall(async f => {
      const ben = f.pages.Ben
      const will = f.pages.Will
      const read = async () => {
        const response = await realApi(will, will.context().request, "GET", "/api/todos/1")
        expect(response.status()).toBe(200)
        return response.json()
      }
      const before = await read()
      expect(before.state).toBe("needs_you")
      await runSlash(ben, `/todo.steer T1 ${browserSteer}`)
      await runSlash(ben, "/todo.amend T1")
      const draft = ben.getByRole("region", { name: "Change an unmerged TODO's prompt", exact: true }).last()
      await f.snapshot("amend-draft", ben)
      await expect(draft).toBeVisible()
      const prompt = draft.getByRole("textbox", { name: "Prompt", exact: true })
      await expect(prompt).toBeVisible()
      await journeyEnter(prompt, agentSteer)
      const pending = ben.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/todos/1")
      await journeyActivate(draft.getByRole("button", { name: "Amend", exact: true }))
      expect((await pending).status()).toBe(202)
      await expect.poll(async () => (await read()).prompt_revisions.length).toBe(2)
      const held = await read()
      expect(held.state).toBe("needs_you")
      expect(held.waits[0].id).toBe(before.waits[0].id)
      await openTodo(will, 1)
      const card = todoCard(will, 1)
      await expect(card).toContainText("+1")
      await expect(card).toContainText(browserSteer)
      await expect(card).toContainText(agentSteer)
      await expect(will.getByRole("button", { name: "Chat", exact: true })).toBeEnabled()
      await f.snapshot("todo-before-answer", will)
      const answered = will.waitForResponse(response => response.request().method() === "POST" && response.request().postDataJSON()?.wait === held.waits[0].id)
      await runSlash(will, `/todo.answer ${JSON.stringify({ n: 1, wait: held.waits[0].id, answer: "Use the existing retry helper" })}`)
      expect((await answered).status()).toBe(202)
      await expect.poll(async () => (await read()).state, { timeout: 300_000 }).toBe("in_review")
      const after = await read()
      expect(after.run.id).toBe(before.run.id)
      expect(after.run.attempt).toBe(before.run.attempt)
      expect(after.branch.id).toBe(before.branch.id)
      f.keep("browser-steer-amend", { before, held, after, events: f.sql("SELECT event_type,data FROM product_job_events WHERE event_type IN ('todo.steer_received','todo.amended','branch.activity') ORDER BY sequence") })
      await f.snapshot("todo-in-review", will)
      const workspace = () => f.sql("SELECT request_run_id,attempt,workspace_id FROM mythical_items WHERE source='todo' AND number=1")
      const originalWorkspace = workspace()
      let reviewed = after
      // The browser must be able to steer again after each completed review.
      // A 202 followed by a stalled retained run is not successful steering.
      for (const text of ["Also log each retry attempt 1", "Also log each retry attempt 2"]) {
        const admission = ben.waitForResponse(response => response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/todos/1" && response.request().postDataJSON()?.steer === text)
        await runSlash(ben, `/todo.steer T1 ${text}`)
        expect((await admission).status()).toBe(202)
        await expect(ben.getByRole("button", { name: "Chat", exact: true })).toBeEnabled()
        // This fixture asks a planning question on every implement launch.
        // Re-entry must reach that real wait, which only the owner answers.
        await expect.poll(async () => (await read()).state, { timeout: 300_000 }).toBe("needs_you")
        const question = (await read()).waits[0]
        expect(question.kind).toBe("question")
        expect(question.id).not.toBe(held.waits[0].id)
        const resumed = will.waitForResponse(response => response.request().method() === "POST" &&
          response.request().postDataJSON()?.wait === question.id)
        await runSlash(will, `/todo.answer ${JSON.stringify({ n: 1, wait: question.id, answer: "Use the existing retry helper" })}`)
        expect((await resumed).status()).toBe(202)
        await expect.poll(async () => {
          const current = await read()
          return current.state === "in_review" && current.pr.head !== reviewed.pr.head
        }, { timeout: 300_000 }).toBe(true)
        const current = await read()
        expect(current.run.id).toBe(before.run.id)
        expect(current.run.attempt).toBe(before.run.attempt)
        expect(current.branch.id).toBe(before.branch.id)
        expect(current.pr.number).toBe(after.pr.number)
        expect(workspace()).toEqual(originalWorkspace)
        expect(current.steers.filter((steer: any) => steer.text === text)).toHaveLength(1)
        await expect.poll(() => f.sql("SELECT checks->'review' AS review FROM mythical_items WHERE source='todo' AND number=1")[0]?.review,
          { timeout: 300_000 }).toMatchObject({ head: current.pr.head, verdict: "approve", posted: true })
        await openTodo(will, 1)
        await expect(todoCard(will, 1)).toContainText(text)
        f.keep(`retained-review-${current.pr.head}`, current)
        reviewed = current
      }
      await f.snapshot("todo-retained-review", will)
    })
    return
  }
  await withReference(browser, info, async f => {
    const ben = f.members.Ben.page
    const will = f.members.Will.page
    const before = await f.read("Ben", "/api/todos/1")
    expect(before.state).toBe("working")
    const identity = (card: any) => ({ run: card.run.id, attempt: card.run.attempt, branch: card.branch.id })
    const item = () => f.sql("SELECT request_run_id, attempt, workspace_id FROM mythical_items WHERE source='todo' AND number=1")
    const changeArgv = JSON.parse(required("SMITHERS_JOURNEY_CHANGE_ID_COMMAND")) as string[]
    const changeId = async () => (await execute(changeArgv[0]!, changeArgv.slice(1))).stdout.trim()
    const originalChange = await changeId()
    expect(originalChange).toMatch(/^[a-z]+$/)
    const original = item()
    expect(original).toHaveLength(1)
    const login = (await f.read("Ben", "/api/user")).username
    const name = (await f.read("Ben", "/api/user")).display_name || login
    const admissions: Array<{ text: string; at: number }> = []
    const requested = ben.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/todos/1")
      .then(() => Date.now())
    const pending = ben.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/todos/1")
      .then(response => ({ response, at: Date.now() }))
    await runSlash(ben, `/todo.steer T1 ${browserSteer}`)
    const accepted = await pending
    const requestedAt = await requested
    expect(accepted.response.status()).toBe(202)
    expect(accepted.at - requestedAt).toBeLessThan(1000)
    admissions.push({ text: browserSteer, at: requestedAt })
    await expect(ben.getByRole("button", { name: "Chat", exact: true })).toBeEnabled()
    const agentAt = Date.now()
    const session = await execute(required("SMITHERS_JOURNEY_CLAUDE_BINARY"), ["--print", "--output-format", "json", "--allowedTools", "Skill,Bash(smthrs *),Read",
      `Use the installed smithers skill to steer T1 with exactly: ${agentSteer}. Run the skill's smthrs todo steer command once. Do not amend or create a TODO.`],
      { cwd: required("SMITHERS_JOURNEY_BEN_CLAUDE_DIRECTORY"), timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
    admissions.push({ text: agentSteer, at: agentAt })
    await info.attach("claude-code-session", { body: session.stdout, contentType: "application/json" })
    await expect.poll(async () => (await f.read("Will", "/api/todos/1")).steers.map((steer: any) => steer.text), { timeout: 120_000 }).toEqual([browserSteer, agentSteer])
    await openTodo(will, 1)
    const card = todoCard(will, 1)
    for (const text of [browserSteer, agentSteer]) await expect(card).toContainText(text)
    const cardText = await card.innerText()
    expect(cardText.indexOf(browserSteer)).toBeLessThan(cardText.indexOf(agentSteer))
    await expect(card).toContainText(`Claude Code for ${name}`)
    await expect(card.locator('.todo-authored').filter({ hasText: browserSteer }).locator('.avatar[data-kind="person"]')).toBeVisible()
    await info.attach("todo-steers", { body: await card.screenshot(), contentType: "image/png" })
    await runSlash(will, `/branch ${before.branch.name}`)
    const activity = will.locator(".branch-activity > li")
    for (const text of [browserSteer, agentSteer]) await expect(activity.filter({ hasText: text })).toHaveCount(1)
    const activityText = (await activity.allTextContents()).join("\n")
    expect(activityText.indexOf(browserSteer)).toBeLessThan(activityText.indexOf(agentSteer))
    await expect(activity.filter({ hasText: agentSteer })).toContainText(`Claude Code for ${name}`)
    await info.attach("branch-steers", { body: await will.screenshot(), contentType: "image/png" })
    const events = f.sql("SELECT sequence,event_type,data FROM product_job_events WHERE event_type IN ('todo.steer_received','branch.activity') AND data->>'n'='1' ORDER BY sequence")
    for (const type of ["todo.steer_received", "branch.activity"]) {
      const rows = events.filter(row => row.event_type === type && [browserSteer, agentSteer].includes(row.data.text))
      expect(rows.map(row => row.data.text)).toEqual([browserSteer, agentSteer])
      expect(rows[0].data.actor).toMatchObject({ kind: "person", login })
      expect(rows[1].data.actor).toMatchObject({ kind: "agent", agent: "claude-code", for_member: { login } })
    }
    const trace = await f.read("Will", `/api/runs/${encodeURIComponent(before.run.id)}/trace`)
    for (const text of [browserSteer, agentSteer]) {
      const cells = trace.attempts.flatMap((attempt: any) => attempt.phases.flatMap((phase: any) => phase.cells))
      expect(cells.filter((cell: any) => cell.kind === "steer" && (cell.quote ?? cell.code ?? cell.output) === text)).toHaveLength(1)
    }
    await expect.poll(async () => (await f.read("Will", "/api/todos/1")).state, { timeout: 900_000 }).toBe("in_review")
    const after = await f.read("Will", "/api/todos/1")
    expect(identity(after)).toEqual(identity(before))
    expect(item()).toEqual(original)
    expect(await changeId()).toBe(originalChange)
    const requests = readFileSync(required("SMITHERS_JOURNEY_MODEL_REQUESTS"), "utf8").trim().split("\n").map(line => JSON.parse(line))
      .filter(turn => turn.run_id === before.run.id)
    for (const input of admissions) {
      const first = requests.find(turn => Date.parse(turn.dispatch_at) >= input.at)
      expect(first, `first model dispatch after ${input.text}`).toBeDefined()
      expect(JSON.stringify(first.messages)).toContain(input.text)
    }
    const files = await f.github("Ben", "GET", `/pulls/${after.pr.number}/files`) as Array<{ filename: string; patch?: string }>
    const patch = files.find(file => file.filename === "src/deliver.ts")?.patch ?? ""
    expect(patch).toMatch(/\+.*import.*withRetry.*(?:\.\/retry|src\/retry)/)
    expect(patch).toMatch(/\+.*(?:max|attempts|retries).*\b5\b/i)
    await attachJson(info, "steer-evidence", { admissions, original, after: item(), events, trace, requests, files })
  })
})
