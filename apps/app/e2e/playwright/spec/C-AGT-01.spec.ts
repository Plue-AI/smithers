import { expectRecordedConversation, importedRows } from "../../real/external-transcript.checks"
import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { identityRoute } from "../identity"
import { runLiveInstall } from "./live-install"
import recorded from "../../../src/mainview/state/testdata/external-recorded-conversation.json"

// C-AGT-01's browser projection (mvp.md M-38), at two tiers that make the same assertions
// (e2e/real/external-transcript.checks.ts). The decoders' own acceptance evidence is the harness package's tests;
// a member's live session through a machine is C-AGT-02.

// The composed install. The Go harness owns PostgreSQL and starts the production composition: its own event pump
// imports the recorded Codex and Claude Code captures through the packaged adapters, and two signed-in members'
// Chromium browsers read it. Nothing the browsers ask is intercepted: identity, history and Live frames are the
// install's own. Only the daemon's side of the machine link is scripted; no machine boots.
test("C-AGT-01: a composed install shows both external formats ordered and read-only to two members", async () => {
  test.setTimeout(300_000)
  const stdout = await runLiveInstall("^TestExternalTranscriptBrowserPostgres$")
  for (const line of [
    "PASS composed install: both members read 83 imported entries of four agent processes, ordered and read-only",
    "PASS composed install: ben saw the live entries",
    "PASS composed install: maya saw the live entries",
    "PASS composed install: both members' edit, stop and delete of an imported entry are refused",
    "PASS composed install: the imported conversation survives a reload unchanged",
    "--- PASS: TestExternalTranscriptBrowserPostgres"
  ]) expect(stdout).toContain(line)
  expect(stdout).not.toContain("--- SKIP:")
})

// The app tier. This test does not talk to an install: it intercepts the browser's identity and conversation
// requests and answers the conversation from a recorded response. The backend test
// TestExternalImportIsTheRecordedBrowserConversation fails when that file drifts from the import pipeline's
// output, but here it is a file. It keeps the rendering assertions in the suite that needs no database.
test("C-AGT-01: the app renders a recorded imported conversation ordered and read-only", async ({ page }) => {
  let reads = 0
  await installCloudFixture(page, { capabilities: ["install", "identity", "agent"] })
  // Intercepted: an install reads the signed-in member from its own browser session.
  await page.route("**/api/auth/session", identityRoute())
  // Intercepted: the recorded conversation.
  await page.route("**/api/conversations/main", route => { reads++; return route.fulfill({ json: recorded }) })
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: { queue: [] } }))
  // An imported entry offers nothing to send. The viewer's own read position is theirs to save; any other write
  // to the conversation (a prompt, an edit, a stop, a delete) fails the check.
  const writes: string[] = []
  await page.route("**/api/conversations/main/**", route => {
    const call = `${route.request().method()} ${new URL(route.request().url()).pathname}`
    if (route.request().method() !== "GET" && call !== "PUT /api/conversations/main/view-state") writes.push(call)
    return route.fallback()
  })
  await page.goto("/")
  await expect(page.getByRole("log", { name: "Conversation", exact: true })).toBeVisible({ timeout: 30_000 })

  await expectRecordedConversation(page, expect)
  // The transcript's own commands, paths and requests are text. None became a card, a run or a request.
  await expect(page.getByText("Merged T8", { exact: true })).toHaveCount(0)
  expect(writes).toEqual([])
  const before = await importedRows(page).allTextContents()
  await page.reload()
  await expect(page.getByRole("log", { name: "Conversation", exact: true })).toBeVisible({ timeout: 30_000 })
  await expectRecordedConversation(page, expect)
  expect(await importedRows(page).allTextContents()).toEqual(before)
  expect(reads).toBeGreaterThanOrEqual(2)
  expect(writes).toEqual([])
})
