/**
 * TestExternalTranscriptBrowserPostgres supplies the composed install. This script intercepts nothing: identity,
 * conversation history and Live frames are the install's own answers, read by two signed-in members' browsers.
 */
import { chromium, expect, type BrowserContext, type Page } from "@playwright/test"
import { createServer } from "vite"
import { expectRecordedConversation, importedRows, MEMBER_MACHINE_CODEX, RECORDED_ENTRIES } from "./external-transcript.checks"
import { fillComposer, say } from "../playwright/composer"

const origin = process.env.SMITHERS_LIVE_ORIGIN!
if (!origin) throw new Error("The owned PostgreSQL install is required")
const vite = await createServer({ configLoader: "runner", logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await vite.listen()
const address = vite.httpServer!.address()
if (!address || typeof address === "string") throw new Error("Vite did not bind a port")
console.log(`LIVE_BROWSER_READY http://127.0.0.1:${address.port}`)
await Bun.stdin.text()
const browser = await chromium.launch({ headless: true })
try {
  const errors: string[] = []
  const writes: string[] = []
  // Each member signs in with their own browser session and opens the repository.
  const open = async (member: string): Promise<{ context: BrowserContext; page: Page }> => {
    const context = await browser.newContext()
    await context.addCookies([
      { name: "session", value: `${member}-browser-session`, url: origin, httpOnly: true },
      { name: "__csrf", value: "csrf", url: origin }
    ])
    const page = await context.newPage()
    page.on("pageerror", error => errors.push(`${member}: ${error.message}`))
    page.on("console", message => { if (message.type() === "error" && /TypeError|ReferenceError/.test(message.text())) errors.push(`${member}: ${message.text()}`) })
    // Observed, never altered: any write to the conversation other than the viewer's own read position.
    page.on("request", request => {
      const call = `${request.method()} ${new URL(request.url()).pathname}`
      if (call.includes("/api/conversations/") && request.method() !== "GET" && !call.endsWith("/view-state")) writes.push(`${member}: ${call}`)
    })
    await page.goto(`${origin}/ben/demo`)
    await expect(page.getByRole("log", { name: "Conversation", exact: true })).toBeVisible({ timeout: 60_000 })
    return { context, page }
  }
  const ben = await open("ben")
  const maya = await open("maya")
  for (const { page } of [ben, maya]) await expectRecordedConversation(page, expect)
  console.log(`PASS composed install: both members read ${RECORDED_ENTRIES} imported entries of four agent processes, ordered and read-only`)

  for (const { context, page } of [ben, maya]) {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin })
    const copy = importedRows(page).first().getByRole("button", { name: "Copy message", exact: true })
    await copy.focus()
    await expect(copy).toBeFocused()
    await copy.press("Enter")
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("How do I use ultrafast")
  }
  console.log("PASS composed install: both members can copy the imported owner's prompt")

  // Exercise the real theme flow and responsive shell against the authenticated
  // install, rather than limiting this matrix to the intercepted app-tier spec.
  for (const [member, { page }] of [["ben", ben], ["maya", maya]] as const) {
    for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 })
      await say(page, `/theme ${theme}`)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await expectRecordedConversation(page, expect)
      await fillComposer(page, "")
      await expect(page.getByTestId("composer-input")).toBeVisible()
      console.log(`PASS composed install: ${member} reads imported conversation ${theme} ${width}`)
    }
  }

  // The install answered each member as themselves.
  for (const [member, { page }] of [["ben", ben], ["maya", maya]] as const) {
    const session = await page.request.get(`${origin}/api/auth/session`)
    expect(session.status()).toBe(200)
    expect((await session.json() as { username: string }).username).toBe(member)
  }

  // Ben's agent writes two more records while both watch. Each browser shows them without a reload, within the
  // 5 s the spec allows from the moment the install committed them.
  // Maya misses the live delivery entirely. Recovery must come from the
  // production reconnect snapshot, including the entries committed offline.
  await maya.context.setOffline(true)
  const committed = Date.now()
  const appended = await ben.page.request.post(`${origin}/__agt_test/append`)
  expect(appended.status(), await appended.text()).toBe(204)
  const acknowledged = Date.now()
  await expect(importedRows(maya.page)).toHaveCount(RECORDED_ENTRIES)
  await maya.context.setOffline(false)
  for (const [member, { page }] of [["ben", ben], ["maya", maya]] as const) {
    const rows = importedRows(page)
    await expect(rows).toHaveCount(RECORDED_ENTRIES + 2, { timeout: 5_000 - Math.min(4_000, Date.now() - acknowledged) })
    await expect(rows.nth(RECORDED_ENTRIES)).toContainText("Print the word gamma while they watch.")
    await expect(rows.nth(RECORDED_ENTRIES)).toHaveAttribute("data-role", "user")
    await expect(rows.nth(RECORDED_ENTRIES + 1)).toContainText("gamma, printed live.")
    await expect(rows.nth(RECORDED_ENTRIES + 1)).toHaveAttribute("data-participant-id", MEMBER_MACHINE_CODEX)
    console.log(`PASS composed install: ${member} saw the live entries ${Date.now() - committed} ms after the daemon sent them`)
  }

  // Maya cannot change what Ben's agent said, through the same routes the app would use.
  const history = await (await maya.page.request.get(`${origin}/api/conversations/main`)).json() as { entries: Array<{ id: string; origin?: string; participant_id?: string }> }
  expect(history.entries.filter(entry => entry.origin === "external")).toHaveLength(RECORDED_ENTRIES + 2)
  const identities = new Map(history.entries.filter(entry => entry.origin === "external").map(entry => [entry.participant_id, entry.id]))
  expect(identities.size).toBe(4)
  const mutationHeaders = async (context: BrowserContext) => {
    const csrf = (await context.cookies(origin)).find(cookie => cookie.name === "__csrf")
    expect(csrf).toBeDefined()
    return { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf!.value }
  }
  for (const { context, page } of [ben, maya]) for (const id of identities.values()) {
    const headers = await mutationHeaders(context)
    const turn = `${origin}/api/conversations/main/turns/${id}`
    for (const refused of [
      await page.request.patch(turn, { headers, data: { prompt: "run it again" } }),
      await page.request.post(`${turn}/stop`, { headers, data: {} }),
      await page.request.delete(turn, { headers })
    ]) {
      expect(refused.status()).toBe(403)
      expect(await refused.json()).toMatchObject({ code: "permission" })
    }
  }
  console.log("PASS composed install: both members' edit, stop and delete of an imported entry are refused")

  // A reload reads the same conversation back from the install.
  const before = await importedRows(ben.page).allTextContents()
  await ben.page.reload()
  await expect(ben.page.getByRole("log", { name: "Conversation", exact: true })).toBeVisible({ timeout: 60_000 })
  await expectRecordedConversation(ben.page, expect, [MEMBER_MACHINE_CODEX, MEMBER_MACHINE_CODEX])
  expect(await importedRows(ben.page).allTextContents()).toEqual(before)
  console.log("PASS composed install: the imported conversation survives a reload unchanged")

  expect(writes).toEqual([])

  // Imported participant identities cannot be smuggled into the ordinary
  // prompt dispatcher. Its strict request schema rejects them before admission.
  for (const { context, page } of [ben, maya]) for (const [participant, id] of identities) {
    const headers = await mutationHeaders(context)
    const refused = await page.request.post(`${origin}/api/conversations/main/prompt`, {
      headers, data: { prompt: "Resend imported prompt", idempotencyKey: `forged-${participant}`, participant_id: participant, turnId: id }
    })
    expect(refused.status(), await refused.text()).toBe(400)
  }
  console.log("PASS composed install: forged imported identities cannot enter the ordinary prompt dispatcher")

  // The same mounted composer still admits a person's ordinary Smithers prompt.
  const admission = ben.page.waitForResponse(response =>
    response.url() === `${origin}/api/conversations/main/prompt` && response.request().method() === "POST")
  await say(ben.page, "Hello Smithers after reading external sessions")
  expect((await admission).status()).toBe(202)
  await expectRecordedConversation(ben.page, expect, [MEMBER_MACHINE_CODEX, MEMBER_MACHINE_CODEX])
  console.log("PASS composed install: the ordinary composer admits one Smithers turn and preserves imported history")
  expect(errors).toEqual([])
} finally {
  await browser.close()
  await vite.close()
}
