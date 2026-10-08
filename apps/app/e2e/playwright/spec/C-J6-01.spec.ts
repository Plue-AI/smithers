import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// UI projection of .specs/engineering/checks/C-J6-01.md.
// Full journey needs an installed branch terminal, packaged CLI/skill and Claude Code credentials. Token isolation/revocation and separate S1/S2 authorization require reference-host receipts. The test below exercises the attribution slice through the install app with test-only HTTP responses.
// These UI assertions do not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J6.1–J6.3, M-21, M-34; lands with T-TRM-02, T-APP-09, T-REL-02
test("C-J6-01: a terminal agent acts for Ben and waits for his confirmation", async ({ page }) => {
  test.fixme(true, "Reference-host terminal/packaged skill/Claude Code journey pending; served attribution slice runs below")
  await owner(page)
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "ben", is_admin: false } }))
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/branch T1')
  await page.getByRole('button', { name: 'Terminal', exact: true }).last().press('Enter')
  const terminal = page.getByRole('region', { name: /Ben.*output/ }).last()
  await terminal.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('smthrs auth status')
  await page.keyboard.press('Enter')
  await expect(terminal).toContainText('Ben')
  await page.keyboard.type('claude')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Claude Code for Ben', { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/Ben answered/).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm', exact: true }).last()).toBeVisible()
  await say(page, '/stack')
  await expect(page.getByText('Agent follow-up', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Confirm', exact: true }).last().press('Enter')
  await expect(page.getByText('Agent follow-up', { exact: true }).last()).toBeVisible()
  await say(page, '/branch T1')
  await expect(page.getByText('Claude Code for Ben', { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/Review & merge/).last()).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().press('Enter')
  await say(page, '/todo T1')
  await expect(page.getByText('In review', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Merged', { exact: true })).toHaveCount(0)
})

// Attribution slice only: HTTP responses are inert recorded data. The full
// installed terminal/skill/confirmation journey above still needs host evidence.
test("C-J6-01: served delegated attribution survives reload and person actions keep their identity", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "ben", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  const ben = { login: "ben", name: "Ben Carter", avatar_url: "https://example.com/ben.png" }
  const delegated = { kind: "agent" as const, id: "agent-session-terminal-ben", agent: "claude-code" as const,
    avatar_url: "https://example.com/claude.png", session_id: "terminal-ben", for_member: ben, color_index: 3 }
  const person = { kind: "person" as const, ...ben, color_index: 3 }
  const coding = { kind: "agent" as const, id: "agent-run-coding", agent: "coding" as const,
    avatar_url: "https://example.com/coding.png", run_id: "coding", color_index: 6 }
  let model = { ...structuredClone(fixtures.working.model), n: 1, owner: ben, present: [delegated, coding],
    first_answer: { by: delegated as typeof delegated | typeof person, text: "Include optional exports", at: "2026-10-06T12:00:00Z" },
    steers: [{ by: delegated as typeof delegated | typeof person, text: "Test the export", at: "2026-10-06T12:01:00Z" }] }
  await page.route("**/api/todos/1", route => route.fulfill({ json: model }))
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible({ timeout: 60_000 })
  await say(page, "/todo T1")
  const card = page.getByRole("article", { name: "TODO T1" }).last()
  await expect(card.getByText("Claude Code for Ben answered", { exact: true })).toBeVisible()
  const chip = card.getByRole("img", { name: "Claude Code for Ben", exact: true }).first()
  await expect(chip).toHaveAttribute("data-kind", "agent")
  await expect(chip).toHaveAttribute("data-for", "true")
  await expect(chip).toHaveAttribute("style", /--who: var\(--lane-3\)/)
  await expect(card.getByRole("img", { name: "Coding agent", exact: true })).toHaveAttribute("style", /--who: var\(--lane-6\)/)
  await page.reload()
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible({ timeout: 60_000 })
  await say(page, "/todo T1")
  await expect(card.getByText("Claude Code for Ben answered", { exact: true })).toBeVisible()
  // The credential classifier's person result has no delegated actor fields.
  // Rendering must consume that result, never a guessed harness identity.
  model = { ...model, present: [coding], first_answer: { ...model.first_answer, by: person },
    steers: [{ ...model.steers[0]!, by: person }] }
  await expect(card.getByText("Ben answered", { exact: true })).toBeVisible()
  await expect(card.getByRole("img", { name: "Claude Code for Ben", exact: true })).toHaveCount(0)
  await expect(card.getByRole("img", { name: "Ben", exact: true }).last()).toHaveAttribute("data-kind", "person")
})
