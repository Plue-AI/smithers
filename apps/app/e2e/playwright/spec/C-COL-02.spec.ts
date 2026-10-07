import { runLiveInstall } from "./live-install"
import homeFixture from "../../../../../packages/backend/internal/compose/testdata/live/home.json"
import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"

// The Go harness owns PostgreSQL and the production install. Its Chromium
// journey uses the real dispatcher, card seams and LiveChannel; only network
// delivery is interrupted. The fault test also covers retained cursors,
// rollback, source ordering and the 2 MiB budget through the upgrade route.
test("C-COL-02: composed install replays committed cards without gaps or duplicates", async () => {
  test.setTimeout(300_000)
  const stdout = await runLiveInstall("^(TestLiveTodoBrowserPostgres|TestLiveChannelComposedUpgradePostgres|TestLiveTodoCommittedCardsRollbackAndReplay)$")
  expect(stdout).toContain("PASS live install: production commands, committed TODO cards, ten-second outage and cursor replay")
  expect(stdout).toContain("PASS live install: reload reads the committed snapshot")
  for (const name of ["TestLiveTodoBrowserPostgres", "TestLiveChannelComposedUpgradePostgres", "TestLiveTodoCommittedCardsRollbackAndReplay"]) {
    expect(stdout).toContain(`--- PASS: ${name}`)
  }
  expect(stdout).not.toContain("--- SKIP:")
})

test("C-COL-02: Home replays the historical aggregate across TODO streams", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  const initial = structuredClone(homeFixture)
  const changed = { items: initial.items.slice(1).filter(item => item.n !== 3), counts: { queued: 0, starting: 0, working: 0, needs_you: 1, paused: 1, failed: 1, in_review: 0, merged: 1, dropped: 3 } }
  let active: { id: number; send: (data: string) => void; close: () => void } | undefined
  const subscriptions: Array<number | undefined> = []
  let head = 0
  const facts = [
    { Sequence: 1, RepositorySequence: 1, Type: "todo.dropped", Data: { n: 1, home: { items: initial.items.slice(1), counts: { ...initial.counts, in_review: 0, dropped: 2 } } } },
    { Sequence: 1, RepositorySequence: 2, Type: "todo.dropped", Data: { n: 3, home: changed } }
  ]
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    if (frame.topic !== "home") { socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" })); return }
    subscriptions.push(frame.cursor)
    active = { id: frame.id, send: raw => socket.send(raw), close: () => socket.close({ code: 1001 }) }
    if (frame.cursor === undefined) socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: head, data: head === 0 ? initial : { ...initial, ...facts[head - 1]!.Data.home } }))
    else for (const fact of facts.slice(frame.cursor, head)) socket.send(JSON.stringify({ t: "delta", id: frame.id, cursor: fact.RepositorySequence, data: fact }))
  }))
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Queued 1", exact: true })).toBeVisible()
  await expect.poll(() => active !== undefined).toBe(true)
  head = 1
  active!.send(JSON.stringify({ t: "delta", id: active!.id, cursor: 1, data: facts[0] }))
  await expect(page.getByRole("button", { name: "In review 0", exact: true })).toBeVisible()
  active!.close()
  head = 2
  await expect.poll(() => subscriptions).toEqual([undefined, 1])
  await expect(page.getByRole("button", { name: "Queued 0", exact: true })).toBeVisible()
  await expect(page.getByRole("list", { name: "Stack", exact: true }).getByRole("listitem")).toHaveCount(4)
  await page.reload()
  await expect(page.getByRole("button", { name: "Queued 0", exact: true })).toBeVisible()
})
