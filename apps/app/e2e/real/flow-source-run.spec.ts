import { readFile } from "node:fs/promises"
import { scenario } from "./coverage/types"
import { test } from "./support"
import { expect, required, runSlash, withReference } from "./todo/reference"
import { journeyActivate, journeyEnter, journeyTerminalInput } from "./support/keyboard-journey-input"
import { acceptedRunId, waitForTerminalRun } from "./flow-execution/production"

// C-J11-02. All changes use the rendered install doors and Ben's own guest
// terminal. LiveCodeDocuments stays disabled: this pass uses the S2 editor.
// E-19 places notify after delivery; verification/review remain engine launches.
const edit = 'codex exec "In flows/todo/flow.ts add a recorded action named notify after delivery, implemented as a no-op with implementationVersion notify/v1. Keep the tagged Flow.make composition and every existing step. Do not merge, push, open a PR or change any other file."'
const prompt = "Add the line 'draft' to NOTES.md"

test("C-J11-02 Source, Plan and draft Run use the scratch machine", scenario("journey.flow-source-run", {
 capabilities: ["install"], coverage: ["host:local", "host:production", "door:slash", "door:button", "dimension:keyboard", "surface:flow-api", "surface:file-card", "path:success", "path:persistence"]
}), async ({ browser }, info) => {
 test.setTimeout(1_800_000)
 expect(required("SMITHERS_JOURNEY_KEYBOARD")).toBe("1")
 expect(required("SMITHERS_JOURNEY_THEME")).toMatch(/^(light|dark)$/)
 await withReference(browser, info, async f => {
  const page = f.members.Ben.page, owner = f.members.Will.page
  const catalog = await f.read("Ben", "/api/flows")
  const active = catalog.find((flow: any) => flow.name === "todo")?.versions.find((version: any) => version.state === "active")
  expect(active?.id).toMatch(/^[0-9a-f]{64}$/)
  expect(catalog.find((flow: any) => flow.name === "todo")?.versions.some((version: any) => version.state === "proposed")).toBe(false)

  await runSlash(page, "/flow todo")
  const flow = page.locator(".flow-view").last()
  await journeyActivate(flow.getByRole("button", { name: "Source", exact: true }))
  const draft = page.locator('.smithers-card[data-kind="draft"]').last()
  await expect(draft.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue(/Change flows\/todo\/flow.ts: Edit the source/)
  await journeyActivate(draft.getByRole("button", { name: "Commit", exact: true }))
  const file = page.locator('.smithers-card[data-kind="file"]').last()
  await expect(file).toContainText("flows/todo/flow.ts", { timeout: 660_000 })
  const proposed = (await f.read("Ben", "/api/flows")).find((flow: any) => flow.name === "todo").versions.find((version: any) => version.state === "proposed")
  expect(proposed?.todo).toEqual(expect.any(Number))
  const sourceTodo = await f.read("Ben", `/api/todos/${proposed.todo}`)
  await runSlash(page, `/branch ${sourceTodo.branch.name}`)
  const branch = page.locator('.smithers-card[data-kind="branch"]').last()
  const wake = branch.getByRole("button", { name: "Wake", exact: true })
  if (await wake.isVisible()) await journeyActivate(wake)
  await expect(branch).toContainText("Awake", { timeout: 120_000 })
  // The prepared hello flow declares a required name and a custom view.
  const helloTracker = { runs: new Set<string>(), ambiguities: [] as string[] }
  await runSlash(page, "/hello")
  await journeyEnter(page.locator('.flow-form [data-field="name"] input').last(), "Ada")
  const helloRequest = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/workflow/rpc" && request.postDataJSON()?.procedure === "Run")
  const helloAccepted = acceptedRunId(page, f.repo, helloTracker)
  await journeyActivate(page.getByRole("button", { name: /Submit|Run flow/, exact: true }).last())
  const helloRun = await helloAccepted
  const helloCall = page.locator(`.smithers-card[data-kind="run-trace"][data-run-id="${helloRun}"]`)
  await expect(helloCall).toBeVisible()
  const helloWorkspace = (await helloRequest).postDataJSON().workspaceId
  expect(helloWorkspace).toMatch(/^[0-9a-f-]{36}$/)
  await waitForTerminalRun(page, page.context().request, f.repo, helloRun, 300_000, helloWorkspace!)
  await runSlash(page, `/run ${helloWorkspace}:${helloRun}`)
  const helloCard = page.locator('.smithers-card[data-kind="run"]').last()
  await journeyActivate(helloCard.getByRole("button", { name: "Inspect", exact: true }))
  await expect(page.locator('.smithers-card[data-kind="run"]').last()).toContainText("Hello, Ada")

  await journeyActivate(branch.getByRole("button", { name: "New terminal", exact: true }))
  await journeyTerminalInput(page.locator(".terminal-view").last())
  await page.keyboard.type(edit)
  await page.keyboard.press("Enter")
  await expect.poll(async () => (await f.read("Ben", `/api/branches/${encodeURIComponent(sourceTodo.branch.name)}/files/flows/todo/flow.ts`)).content.text, { timeout: 300_000 }).toContain('"notify"')
  await runSlash(page, `/branch ${sourceTodo.branch.name}`)
  const forked = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/branches")
  await journeyActivate(branch.getByRole("button", { name: "Fork", exact: true }))
  const forkResponse = await forked
  expect(forkResponse.status()).toBe(201)
  const scratch = await forkResponse.json()
  expect(scratch.name).toMatch(/^scratch\//)
  expect(scratch.machine.id).toMatch(/^[0-9a-f-]{36}$/)
  await expect.poll(async () => (await f.read("Ben", `/api/branches/${encodeURIComponent(scratch.name)}`)).state, { timeout: 120_000 }).toBe("awake")
  await runSlash(page, `/branch ${scratch.name}`)
  const scratchHead = await f.read("Ben", `/api/branches/${encodeURIComponent(scratch.name)}`)
  expect(scratchHead.head).toMatch(/^[0-9a-f]{40}$/)
  const input = { prompt, base: { commitId: scratchHead.head, ref: `refs/smithers/workspaces/${scratch.machine.id}/sources/${scratchHead.head}` } }
  await runSlash(page, "/flow todo")
  await journeyActivate(flow.getByRole("button", { name: "Plan", exact: true }))
  await journeyEnter(page.locator('.flow-form[data-flow-name="flow.plan"] input:not(:disabled)').last(), JSON.stringify(input))
  await journeyActivate(page.getByRole("button", { name: "Submit", exact: true }).last())
  await expect(page.locator('.smithers-card[data-kind="flow-plan"]').last()).toContainText("notify", { timeout: 120_000 })
  // Plan executes no actions and files no item for the scratch branch.
  expect(f.sql(`SELECT count(*)::int AS n FROM mythical_items WHERE workspace_id='${scratch.machine.id}'`)).toEqual([{ n: 0 }])
  await runSlash(page, "/flow todo")
  await journeyActivate(flow.getByRole("button", { name: "Run", exact: true }))
  await journeyEnter(page.locator('.flow-form[data-flow-name="flow.run"] input:not(:disabled)').last(), JSON.stringify(input))
  const tracker = { runs: new Set<string>(), ambiguities: [] as string[] }
  const accepted = acceptedRunId(page, f.repo, tracker)
  await journeyActivate(page.getByRole("button", { name: "Submit", exact: true }).last())
  const run = await accepted
  await runSlash(page, `/run ${scratch.machine.id}:${run}`)
  const runCard = page.locator('.smithers-card[data-kind="run"]').last()
  await expect(runCard).toContainText("draft version")
  await journeyActivate(runCard.getByRole("button", { name: "Inspect", exact: true }))
  await expect(page.locator('.smithers-card[data-kind="run"]').last()).toContainText("notify")
  await expect(page.locator('.smithers-card[data-kind="run"]').last()).not.toContainText("Hello, Ada")
  await runSlash(owner, "/todo.new")
  const next = owner.locator('.smithers-card[data-kind="draft"]').last()
  await journeyEnter(next.getByRole("textbox", { name: "Title", exact: true }), "Active pin after scratch Run")
  await journeyEnter(next.getByRole("textbox", { name: "Prompt", exact: true }), "Add a note to NOTES.md using the active factory flow.")
  const filed = owner.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/todos")
  await journeyActivate(next.getByRole("button", { name: "Commit", exact: true }))
  const x = (await (await filed).json()).n
  await expect.poll(async () => (await f.read("Will", `/api/todos/${x}`)).flow_version?.digest, { timeout: 120_000 }).toBe(active.id)
  const terminal = await waitForTerminalRun(page, page.context().request, f.repo, run, 660_000, scratch.machine.id)
  if (terminal.status !== "completed") expect(JSON.stringify(terminal)).toContain("not_a_todo_run")
  const observed = await f.read("Ben", "/api/flows")
  const versions = observed.find((flow: any) => flow.name === "todo").versions
  expect(versions.find((version: any) => version.state === "active")?.id).toBe(active.id)
  expect(versions.find((version: any) => version.state === "proposed")?.todo).toBe(proposed.todo)
  expect(f.sql(`SELECT count(*)::int AS n FROM mythical_items WHERE request_run_id='${run}' OR workspace_id='${scratch.machine.id}' OR pending_op::text LIKE '%${run}%'`)).toEqual([{ n: 0 }])
  const pulls = await f.github("Ben", "GET", "/pulls?state=all") as any[]
  expect(pulls.filter(pull => pull.head.ref === scratch.name)).toEqual([])
  // The operator retains approved, redacted host/process observations. These
  // files supplement the production readbacks; they cannot qualify isolation.
  for (const kind of ["HOST_LOG", "PROCESS_LOG", "GITHUB_WRITES"] as const) {
   await info.attach(kind.toLowerCase(), { body: await readFile(required(`SMITHERS_JOURNEY_FLOW_${kind}`)), contentType: "text/plain" })
  }
 })
})
