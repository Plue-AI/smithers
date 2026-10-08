import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { branch, liveBranch, maya } from "./j3-fixtures"

// C-J3-06 UI projection through the real app provider. Public gateway,
// authentication, SFTP, forwarding and revocation need reference-host receipts.
test("C-J3-06: SSH uses the install address and remote edits update presence", async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const publish = await liveBranch(page, branch([], 'asleep'))
  const diffRequests: string[] = []
  await page.route('**/api/branches/smithers%2Fretry-webhooks/diff?entry=*', route => {
    diffRequests.push(new URL(route.request().url()).searchParams.get('entry')!)
    return route.fulfill({ json: { files: [{ branch: 'smithers/retry-webhooks', path: 'src/retry.ts',
      against: { kind: 'burst', burst: '11111111-1111-4111-8111-111111111111', actor: maya, at: '2026-10-08T04:00:00Z' },
      change: 'modified', hunks: [{ old_start: 12, new_start: 12, lines: [
        { op: '-', text: 'const attempts = 1' }, { op: '+', text: 'const attempts = 3' }
      ] }] }] } })
  })
  await page.goto('/')
  await say(page, '/branch T2')
  const card = page.getByTestId('card-branch:j3-branch')
  await expect(card.getByText('Asleep', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Copy SSH line', exact: true }).press('Enter')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('ssh -p 2222 retry-webhooks@maya-mini.tail1234.ts.net')
  const saved = branch([{ actor: maya, where: { kind: 'file', path: 'retry.ts', line: 12 } }])
  saved.activity = [{ id: '11111111-1111-4111-8111-111111111111', actor: maya, kind: 'change', text: 'changed 1 file', files: 1,
    at: '2026-10-08T04:00:00Z', actions: [] }]
  publish(saved)
  const presence = card.getByRole('list', { name: 'On this branch', exact: true })
  await expect(presence.getByText('Maya via SSH', { exact: true })).toBeVisible()
  await expect(presence.getByRole('button', { name: 'retry.ts:12', exact: true })).toBeVisible()
  await expect(card.getByText('Awake', { exact: true })).toBeVisible()
  const activity = card.locator('[data-kind="change"]')
  await expect(activity).toContainText('Maya via SSH')
  await expect(activity).toContainText('changed 1 file')
  await activity.getByRole('button', { name: 'Diff', exact: true }).press('Enter')
  const diff = page.getByTestId('card-diff-burst-smithers/retry-webhooks-11111111-1111-4111-8111-111111111111-')
  await expect(diff).toContainText('src/retry.ts')
  await expect(diff).toContainText('const attempts = 1')
  await expect(diff).toContainText('const attempts = 3')
  expect(diffRequests).toEqual(['11111111-1111-4111-8111-111111111111'])
  await page.reload()
  await say(page, '/branch T2')
  await expect(presence.getByText('Maya via SSH', { exact: true })).toBeVisible()
  publish(branch())
  await expect(card.getByText('Nobody here', { exact: true })).toBeVisible()
  await expect(page.getByTestId('composer-input')).toBeEditable()
})
