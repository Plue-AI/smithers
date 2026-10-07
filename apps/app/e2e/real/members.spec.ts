import { cardCaptureInventory } from "./support/card-capture"
import { registerKeyboardJourney, registerJourneyCapture, journeyActivate, journeyEnter, journeySelect } from "./support/keyboard-journey-input"
import { readFileSync } from "node:fs"
import { test, expect, type Page } from "../playwright/browserTest"
import { command } from "./support/test"
import { scenario } from "./coverage/types"

// Reference-host inputs are owned scratch accounts and saved browser profiles.
// This test never changes GitHub permissions or writes to a GitHub repository.
// The operator stops the backend for ten seconds during the annotated outage step.
interface MembersRun {
  ownerOrigin: string
  publicOrigin: string
  repository: string
  commit: string
  ownerState: string
  memberState: string
  refusedState: string
  maintainer: string
  member: string
  refused: string
}
const card = (page: Page) => page.getByRole("region", { name: "Members", exact: true }).last()

test("C-J1-05 Members on the install and LAN", scenario("journey.members", {
  capabilities: ["identity", "install"],
  coverage: ["host:local", "host:production", "action:members", "action:members.add", "action:members.role", "action:members.remove", "door:button", "door:slash", "dimension:keyboard", "path:success", "path:permission", "path:error", "evidence:members"]
}), async ({ browser }, info) => {
  info.setTimeout(240_000)
  const path = process.env.SMITHERS_MEMBERS_RUN
  if (!path) throw new Error("SMITHERS_MEMBERS_RUN must name the reference-host Members inputs JSON")
  const input = JSON.parse(readFileSync(path, "utf8")) as MembersRun
  for (const field of ["ownerOrigin", "publicOrigin", "repository", "commit", "ownerState", "memberState", "refusedState", "maintainer", "member", "refused"] as const) {
    if (!input[field]) throw new Error(`Members inputs missing ${field}`)
  }
  expect(new URL(input.publicOrigin).protocol).toMatch(/^https?:$/)
  expect(new URL(input.publicOrigin).hostname).not.toMatch(/^(localhost|127\.0\.0\.1)$/)
  const theme = process.env.SMITHERS_JOURNEY_THEME
  if (theme !== undefined && theme !== "light" && theme !== "dark") throw new Error("SMITHERS_JOURNEY_THEME must be light or dark")
  if (process.env.SMITHERS_JOURNEY_KEYBOARD !== undefined && process.env.SMITHERS_JOURNEY_KEYBOARD !== "1") throw new Error("SMITHERS_JOURNEY_KEYBOARD must be 1 or absent")
  expect(new URL(input.ownerOrigin).protocol).toMatch(/^https?:$/)
  expect(input.repository).toMatch(/^smithers-mvp-canary\/[a-zA-Z0-9._-]+$/)
  expect(input.commit).toMatch(/^[0-9a-f]{40}$/)
  const ownerContext = await browser.newContext({ storageState: input.ownerState,
    recordVideo: { dir: info.outputPath("owner-video") }, recordHar: { path: info.outputPath("owner.har") } })
  const memberContext = await browser.newContext({ storageState: input.memberState,
    recordVideo: { dir: info.outputPath("member-video") }, recordHar: { path: info.outputPath("member.har") } })
  const refusedContext = await browser.newContext({ storageState: input.refusedState,
    recordVideo: { dir: info.outputPath("refused-video") }, recordHar: { path: info.outputPath("refused.har") } })
  await ownerContext.tracing.start({ screenshots: true, snapshots: true })
  await memberContext.tracing.start({ screenshots: true, snapshots: true })
  await refusedContext.tracing.start({ screenshots: true, snapshots: true })
  const captures = cardCaptureInventory(async (name, bytes) => { await info.attach(name, { body: bytes, contentType: "image/png" }) })
  const pages = new Map<string, { page: Page; keys?: ReturnType<typeof registerKeyboardJourney>; ready: boolean }>()
  const register = async (page: Page, actor: string, origin: string) => {
    const capture = async () => { if (theme && pages.get(actor)?.ready) await captures.capture(page, actor, theme) }
    const keys = process.env.SMITHERS_JOURNEY_KEYBOARD === "1" ? registerKeyboardJourney(page, new URL(origin).origin, capture) : undefined
    pages.set(actor, { page, keys, ready: false })
    registerJourneyCapture(page, capture)
    await keys?.ready()
  }
  const selectTheme = async (actor: string) => {
    const entry = pages.get(actor)!
    if (theme && await entry.page.locator("html").getAttribute("data-theme") !== theme) await command(entry.page, "/theme")
    if (theme) await expect(entry.page.locator("html")).toHaveAttribute("data-theme", theme)
    entry.ready = true
    if (theme) await captures.capture(entry.page, actor, theme)
  }
  try {
    const owner = await ownerContext.newPage()
    await register(owner, "Will", input.ownerOrigin)
    await owner.goto(input.ownerOrigin)
    await selectTheme("Will")
    const bootstrap = await owner.request.get(`${input.ownerOrigin}/api/bootstrap`)
    expect(bootstrap.status()).toBe(200)
    const host = await bootstrap.json()
    expect(host.buildSha).toBe(input.commit)
    await info.attach("members-host", { body: JSON.stringify(host), contentType: "application/json" })
    await command(owner, "/members")
    const roster = card(owner)
    for (const login of [input.maintainer, input.member]) {
      await journeyEnter(roster.getByLabel("GitHub username", { exact: true }), login)
      const committed = owner.waitForResponse(r => new URL(r.url()).pathname === "/api/members" && r.request().method() === "POST")
      await journeyActivate(roster.getByRole("button", { name: "Add", exact: true }))
      expect((await committed).status()).toBe(204)
      await expect(roster.locator(`li[data-login="${login}"]`)).toBeVisible({ timeout: 1000 })
    }
    // Add creates a Member; the owner promotes Ben through the role door.
    const maintainer = roster.locator(`li[data-login="${input.maintainer}"]`)
    await journeySelect(maintainer.getByRole("combobox"), "Maintainer")
    await journeyActivate(maintainer.getByRole("button", { name: "Role", exact: true }))
    await expect(roster.locator(`li[data-login="${input.maintainer}"] select`)).toHaveValue("maintainer")
    await expect(roster.locator(`li[data-login="${input.member}"] select`)).toHaveValue("member")
    await journeyEnter(roster.getByLabel("GitHub username"), input.refused)
    await journeyActivate(roster.getByRole("button", { name: "Add", exact: true }))
    await expect(roster.getByRole("link", { name: /needs access on GitHub/ })).toHaveAttribute("href", `https://github.com/${input.repository}/settings/access`)
    await expect(roster.locator(`li[data-login="${input.refused}"]`)).toHaveCount(0)

    const teammate = await memberContext.newPage()
    await register(teammate, "Alice", input.publicOrigin)
    await teammate.goto(`${input.publicOrigin}/api/auth/github`)
    // A saved GitHub profile or the reference operator completes GitHub's own door.
    await teammate.waitForURL(url => url.origin === input.publicOrigin && !url.pathname.startsWith("/api/"))
    const identity = await teammate.request.get(`${input.publicOrigin}/api/user`)
    expect(identity.status()).toBe(200)
    expect((await identity.json()).username).toBe(input.member)
    await selectTheme("Alice")
    await command(teammate, "/members")
    await expect(card(teammate).getByRole("button", { name: /^(Add|Role|Remove)$/ })).toHaveCount(0)
    const denied = await refusedContext.newPage()
    const refusal = denied.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/github/callback")
    await denied.goto(`${input.publicOrigin}/api/auth/github`)
    expect((await refusal).status()).toBe(403)
    expect((await refusedContext.cookies(input.publicOrigin)).filter(cookie => cookie.name !== "__csrf")).toEqual([])

    const row = roster.locator(`li[data-login="${input.member}"]`)
    for (const role of ["maintainer", "member"]) {
      await journeySelect(row.getByRole("combobox"), role === "maintainer" ? "Maintainer" : "Member")
      await journeyActivate(row.getByRole("button", { name: "Role", exact: true }))
      await expect(row.getByRole("combobox")).toHaveValue(role)
      const other = card(teammate).locator(`li[data-login="${input.member}"]`)
      if (role === "maintainer") await expect(other.getByRole("combobox")).toHaveValue(role)
      else { await expect(other).toContainText("Member"); await expect(card(teammate).getByRole("button", { name: "Add", exact: true })).toHaveCount(0) }
    }
    console.log("C-J1-05 reference operator: stop the backend now for ten seconds, then restart it.")
    info.annotations.push({ type: "reference-operator", description: "Stop the backend now for ten seconds, then restart it." })
    await expect.poll(async () => {
      try { return (await owner.request.get(`${input.ownerOrigin}/api/members`, { timeout: 1000 })).status() >= 500 }
      catch { return true }
    }, { timeout: 60_000 }).toBe(true)
    const outageAt = Date.now()
    await command(owner, "/members")
    await expect(owner.getByRole("alert").filter({ hasText: /Not your fault/ }).last()).toBeVisible()
    await expect(row).toBeVisible()
    await expect.poll(async () => {
      try { return (await owner.request.get(`${input.ownerOrigin}/api/members`, { timeout: 1000 })).status() }
      catch { return 0 }
    }, { timeout: 60_000 }).toBe(200)
    expect(Date.now() - outageAt).toBeGreaterThanOrEqual(10_000)
    await expect(owner.getByRole("alert").filter({ hasText: "Members unavailable" })).toHaveCount(0)
    await journeyActivate(row.getByRole("button", { name: "Remove", exact: true }))
    const confirmation = row.getByRole("alertdialog", { name: `Remove @${input.member}?`, exact: true })
    await journeyActivate(confirmation.getByRole("button", { name: "Cancel", exact: true }))
    await expect(confirmation).toHaveCount(0)
    await expect(row).toBeVisible()
    await journeyActivate(row.getByRole("button", { name: "Remove", exact: true }))
    await journeyActivate(confirmation.getByRole("button", { name: "OK", exact: true }))
    await expect(row).toHaveCount(0)
    const committed = await owner.request.get(`${input.ownerOrigin}/api/members`)
    expect(committed.status()).toBe(200)
    await info.attach("members-committed-roster", { body: await committed.body(), contentType: "application/json" })
    for (const [actor, entry] of pages) {
      if (theme) await captures.capture(entry.page, actor, theme)
      if (entry.keys?.snapshot().inputs.some(input => input.result === "allowed")) await entry.keys.observe()
      if (entry.keys?.snapshot().inputs.length) entry.keys.finish()
    }
    await info.attach("members-owner", { body: await owner.screenshot(), contentType: "image/png" })
  } finally {
    await info.attach("card-capture-inventory", { body: JSON.stringify(captures.snapshot()), contentType: "application/json" })
    for (const [actor, entry] of pages) if (entry.keys) await info.attach(`keyboard-${actor}`, { body: JSON.stringify(entry.keys.snapshot()), contentType: "application/json" })
    await ownerContext.tracing.stop({ path: info.outputPath("owner-trace.zip") })
    await memberContext.tracing.stop({ path: info.outputPath("member-trace.zip") })
    await refusedContext.tracing.stop({ path: info.outputPath("refused-trace.zip") })
    await ownerContext.close(); await memberContext.close(); await refusedContext.close()
  }
})
