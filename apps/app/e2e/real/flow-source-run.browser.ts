/** Supplemental C-J11-02 composition proof, driven by the backend test. No
 * browser API interception, seeded app world or substituted flow RPC. */
import { chromium, expect } from "@playwright/test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { registerKeyboardJourney, journeyActivate, journeyEnter } from "./support/keyboard-journey-input"
import { awaitBoot } from "./support"
import { runSlash as command } from "./issues/local"
import { gatewayCall, waitForTerminalRun, acceptedRunId } from "./flow-execution/production"
const origin = process.env.SMITHERS_FLOW_SOURCE_RUN_ORIGIN!
if (!origin) throw new Error("Run TestFlowSourceRunBrowserComposedInstall")
const browser = await chromium.launch({ headless: true })
try {
 const context = await browser.newContext({ baseURL: origin })
 const cookies: Array<{ Name: string; Value: string }> = JSON.parse(process.env.SMITHERS_FLOW_SOURCE_RUN_COOKIES!)
 await context.addCookies(cookies.map(cookie => ({ name: cookie.Name, value: cookie.Value, url: origin })))
 const page = await context.newPage()
 const keys = registerKeyboardJourney(page, origin)
 await keys.ready()
 try {
  await page.goto(origin + "/rehearsal-owner/app")
  await awaitBoot(page)
  for (const theme of ["light", "dark"] as const) {
   if (await page.locator("html").getAttribute("data-theme") !== theme) await command(page, "/theme")
   await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
   await command(page, "/flow todo")
   const flow = page.locator(".flow-view").last()
   await expect(flow.getByRole("button", { name: "Plan", exact: true })).toBeVisible()
   await journeyActivate(flow.getByRole("button", { name: "Source", exact: true }))
   await expect(page.getByRole("textbox", { name: "Prompt", exact: true }).last()).toHaveValue(/Change flows\/todo\/flow.ts: Edit the source/, { timeout: 30_000 })
   // J5's Edit and Make TODO doors use the real catalog and durable Draft.
   // No TODO admission is needed to verify the proposed diff survives reload.
   await command(page, "/flow todo")
   await journeyActivate(flow.getByRole("button", { name: "Edit", exact: true }))
   await expect(page.getByLabel("Request", { exact: true }).last()).toBeVisible()
   const diff = "diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n+notify"
   await command(page, `/flow.edit ${JSON.stringify({ name: "todo", request: "Record notification", diff })}`)
   await expect(flow.locator(".flow-proposal pre")).toHaveText(diff, { timeout: 30_000 })
   await journeyActivate(flow.getByRole("button", { name: "Make TODO", exact: true }))
   const draft = page.getByRole("textbox", { name: "Prompt", exact: true }).last()
   const expectedPrompt = "Change flows/todo/flow.ts: Record notification; start from the built-in composition when no override exists\n\nProposed diff (untrusted context):\n> diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n> +notify"
   await expect(draft).toHaveValue(expectedPrompt)
   await page.reload()
   await awaitBoot(page)
   await expect(draft).toHaveValue(expectedPrompt)
   // No source TODO is committed by this regression. Scratch creation and
   // its machine's code are reached through the person's ordinary slash door.
   const forked = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/branches")
   await command(page, `/branch.fork ${JSON.stringify({ from: "main", name: `flow-${theme}` })}`)
   const fork = await forked
   expect(fork.status()).toBe(201)
   const branch = await fork.json()
   await expect.poll(async () => (await (await context.request.get(`/api/branches/${encodeURIComponent(branch.name)}`)).json()).state, { timeout: 120_000 }).toBe("awake")
   await command(page, `/branch ${branch.name}`)
   await expect(page.locator('.smithers-card[data-kind="branch"]').last()).toContainText(branch.name, { timeout: 30_000 })
   await command(page, "/flow todo")
   await journeyActivate(flow.getByRole("button", { name: "Plan", exact: true }))
   await journeyEnter(page.locator('.flow-form[data-flow-name="flow.plan"] input:not(:disabled)').last(), "{}")
   const planned = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/workflow/rpc" && response.request().postDataJSON()?.procedure === "Plan", { timeout: 180_000 })
   await journeyActivate(page.getByRole("button", { name: "Submit", exact: true }).last())
   const plan = await planned
   expect(plan.status()).toBe(200)
   const result = await plan.json()
   expect(result.ok, JSON.stringify(result.error)).toBe(true)
   await expect(page.locator('.smithers-card[data-kind="flow-plan"]').last()).toContainText("notify", { timeout: 30_000 })
   await command(page, `/file ${JSON.stringify({ branch: branch.machine.id, path: "flows/todo/flow.ts" })}`)
   await expect(page.locator('.smithers-card[data-kind="file"]').last()).toContainText("notify", { timeout: 30_000 })
   await command(page, "/flow todo")
   await journeyActivate(flow.getByRole("button", { name: "Run", exact: true }))
   await journeyEnter(page.locator('.flow-form[data-flow-name="flow.run"] input:not(:disabled)').last(), "{}")
   const tracker = { runs: new Set<string>(), ambiguities: [] as string[] }
   const accepted = acceptedRunId(page, "rehearsal-owner/app", tracker)
   await journeyActivate(page.getByRole("button", { name: "Submit", exact: true }).last())
   const run = await accepted
   const row = await waitForTerminalRun(page, context.request, "rehearsal-owner/app", run, 120_000, branch.machine.id).catch(async error => {
    const observations = []
    for (const tag of ["run-summary", "run-events", "approvals"]) observations.push({ tag, answer: await gatewayCall(page, context.request, "rehearsal-owner/app", "Projection.Snapshot", { selector: { _tag: tag, runId: run } }, branch.machine.id) })
    await writeFile(join(process.env.SMITHERS_FLOW_SOURCE_RUN_EVIDENCE!, `run-${theme}-failure.json`), JSON.stringify(observations, null, 2))
    throw error
   })
   expect(row.status).toBe("completed")
   expect(row.finalOutput).toBe("notified")
   await expect(page.getByTestId("composer-input")).toBeEnabled()
   await page.screenshot({ path: join(process.env.SMITHERS_FLOW_SOURCE_RUN_EVIDENCE!, `flow-${theme}.png`) })
  }
  keys.finish()
 } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error } finally { await writeFile(join(process.env.SMITHERS_FLOW_SOURCE_RUN_EVIDENCE!, "keyboard.json"), JSON.stringify(keys.snapshot())) }
 await context.close()
} finally { await browser.close() }
