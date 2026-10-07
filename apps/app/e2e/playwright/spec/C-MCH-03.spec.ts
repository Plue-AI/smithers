import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// UI projection of .specs/engineering/checks/C-MCH-03.md; not a qualification receipt.
// The real PostgreSQL/router capture and admission proof lives in branch_sleep_integration_test.go.
test("C-MCH-03: Captured sleeping files remain readable and only a terminal wakes the branch", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  const branch = "upgrade-stripe", id = "sleep-branch"
  const head = "1111111111111111111111111111111111111111"
  const content = "export const backoff = (attempt: number) => Math.min(1000 * 2 ** attempt, 30000);\n"
  const reads: string[] = [], writes: unknown[] = []
  let awake = false
  const publish: Array<() => void> = []
  await page.route("**/api/branches", route => route.fulfill({ json: [{ id, name: branch }] }))
  await page.route(`**/api/branches/${branch}`, route => route.fulfill({ json: { name: branch, machine: { id } } }))
  await page.route(`**/api/branches/${branch}/files/src/backoff.ts*`, route => {
    reads.push(route.request().url())
    expect(route.request().method()).toBe("GET")
    expect(new URL(route.request().url()).searchParams.get("at")).toBe(head)
    return route.fulfill({ json: { path: "src/backoff.ts", branch, language: "typescript", digest: "sha256:captured",
      content: { kind: "text", text: content }, mode: "read_only", diagnostics: [], authors: [], editors: [] } })
  })
  await page.route(`**/api/branches/${branch}/diff*`, route => {
    expect(route.request().method()).toBe("GET")
    reads.push(route.request().url())
    return route.fulfill({ json: { files: [{ path: "src/backoff.ts", branch,
      against: { kind: "fork", rev: "2222222222222222222222222222222222222222" }, change: "added",
      hunks: [{ old_start: 0, new_start: 1, lines: [{ op: "+", text: content.trim() }] }] }] } })
  })
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    let cursor = 0
    const send = () => {
      const data = frame.topic === `branch:${id}` || frame.topic === `branch:${branch}` ? {
        id, name: branch, head, machine: { state: awake ? "awake" : "asleep" }, presence: [], terminals: [],
        ssh_line: "ssh -p 2222 upgrade-stripe@localhost"
      } : frame.topic === `branch:${id}:files` ? { changed: [{ path: "src/backoff.ts", change: "added" }], open: [] }
        : frame.topic === `branch:${id}:activity` ? [] : undefined
      socket.send(JSON.stringify(data === undefined ? { t: "err", id: frame.id, code: "unsupported" }
        : { t: "snap", id: frame.id, cursor: ++cursor, data }))
    }
    publish.push(send)
    send()
  }))
  await page.route("**/api/terminals", route => {
    writes.push(route.request().postDataJSON())
    awake = true
    for (const send of publish) send()
    return route.fulfill({ status: 202, json: { id: "terminal-sleep", workspace_id: id } })
  })
  await page.route("**/workspace/sessions/terminal-sleep", route => route.fulfill({ json: { status: "starting" } }))
  await page.goto("/")
  await say(page, `/branch ${branch}`)
  const card = page.getByTestId(`card-branch:${id}`)
  await expect(card).toContainText("Asleep")
  await card.getByRole("tab", { name: /^Files/ }).press("Enter")
  await card.getByRole("button", { name: "src/backoff.ts", exact: true }).press("Enter")
  await expect(page.getByTestId(`card-file-branch-${branch}-src/backoff.ts`)).toContainText(content.trim())
  await say(page, `/diff ${branch}`)
  await expect(page.getByTestId(`card-diff-branch-${branch}`)).toContainText(content.trim())
  await expect(card).toContainText("Asleep")
  expect(reads).toHaveLength(2)
  expect(writes).toEqual([])
  await card.getByRole("button", { name: "New terminal", exact: true }).press("Enter")
  await expect.poll(() => writes).toEqual([{ branch }])
  await expect(card).toContainText("Awake")
  await expect(page.getByTestId("composer-input")).toBeEnabled()
})

// Mounted snapshot projection; runtime wake/capture qualification remains above.
test("C-MCH-03: Reading sleeping branch panels preserves Asleep after reload", async ({ page }) => {
  await page.goto("/")
  await say(page, "/branch upgrade-stripe")
  await expect(page.getByText("Asleep", { exact: true }).last()).toBeVisible()
  const files = page.getByRole("tab", { name: /^Files/ }).last()
  await files.press("Enter")
  await expect(files).toHaveAttribute("aria-selected", "true")
  await expect(page.getByText("Asleep", { exact: true }).last()).toBeVisible()
  await page.getByRole("tab", { name: /^Activity/ }).last().press("Enter")
  await expect(page.getByText("Asleep", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByText("Asleep", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("tab", { name: /^Activity/ }).last()).toHaveAttribute("aria-selected", "true")
})
