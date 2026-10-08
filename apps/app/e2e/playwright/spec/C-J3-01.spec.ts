import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { alice, ben, branch, claude, coding, liveBranch, maya, reviewer, smithers } from "./j3-fixtures"

// C-J3-01 UI projection. Real leases, authentication, agent lifetimes and the
// 120-action timing campaign are qualified by the reference-host journey.
test("C-J3-01: branch presence follows locations, watching and participant departures", async ({ page }) => {
  const present = branch([
    { actor: alice, where: { kind: "file", path: "retry.ts", line: 12 } },
    { actor: maya, where: { kind: "file", path: "retry.ts" } },
    { actor: coding, where: { kind: "step", label: "Implement" } },
    { actor: claude, where: { kind: "file", path: "notes.md" } },
    { actor: smithers, where: { kind: "branch" } },
    { actor: reviewer, where: { kind: "step", label: "Review" } }
  ])
  const publish = await liveBranch(page, present)
  await page.goto('/')
  await say(page, '/branch T2')
  const card = page.getByTestId('card-branch:j3-branch')
  const presence = card.getByRole('list', { name: 'On this branch', exact: true })
  await expect(presence.getByText('Alice', { exact: true })).toHaveCount(1)
  await expect(presence.getByText('Maya via SSH', { exact: true })).toBeVisible()
  await expect(presence.getByRole('button', { name: 'retry.ts:12', exact: true })).toBeVisible()
  for (const name of ['Coding agent for Ben', 'Claude Code for Ben', 'Smithers for Ben', 'Reviewer for Ben']) {
    await expect(presence.getByText(name, { exact: true })).toBeVisible()
    await expect(presence.getByRole('img', { name, exact: true })).toHaveCount(1)
  }
  await expect(presence.getByText('Implement', { exact: true })).toBeVisible()
  const watching = branch([
    { actor: ben, where: { kind: 'terminal', id: 'ben-shell' } },
    { actor: alice, where: { kind: 'terminal', id: 'ben-shell' }, watching: 'ben-shell' },
    { actor: coding, where: { kind: 'step', label: 'Implement' } }
  ])
  publish(watching)
  await expect(presence.getByText(/^watching /)).toBeVisible()
  await expect(presence.getByText('Alice', { exact: true })).toHaveCount(1)
  await expect(presence.getByText('Maya via SSH', { exact: true })).toHaveCount(0)
  await expect(presence.getByText('Claude Code for Ben', { exact: true })).toHaveCount(0)
  // The shell remains when the external agent ends; it never retains its row.
  await expect(presence.getByRole('button', { name: "Ben's terminal", exact: true })).toHaveCount(3)
  const departed = branch([{ actor: ben, where: { kind: 'terminal', id: 'ben-shell' } }])
  publish(departed)
  await expect(presence.getByText('Alice', { exact: true })).toHaveCount(0)
  await expect(presence.getByText('Coding agent for Ben', { exact: true })).toHaveCount(0)
  await page.reload()
  await say(page, '/branch T2')
  await expect(presence.getByText('Ben', { exact: true })).toBeVisible()
  await expect(presence.getByText('Maya via SSH', { exact: true })).toHaveCount(0)
  await expect(presence.getByText('Alice', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toBeEditable()
})
