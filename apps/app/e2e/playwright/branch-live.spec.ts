import { expect, test } from "./browserTest"
import { fillComposer } from "./composer"
import { installCloudFixture } from "./cloudFixture"

// Browser contract proof. The PostgreSQL/SSH/lease journey remains reference-host evidence.
for (const optionalStreams of ["served", "unsupported"] as const) test(`install /branch T2 renders captured facts with ${optionalStreams} streams and forks without waking`, async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  const posts: unknown[] = []
  const presence: unknown[] = []
  const fileReads: string[] = []
  const capturedHead = "1111111111111111111111111111111111111111"
  await page.route("**/api/branches/smithers%2Fretry-webhooks/files/retry.ts*", route => {
    fileReads.push(route.request().url().split("/api/")[1]!)
    expect(route.request().method()).toBe("GET")
    return route.fulfill({ json: { path: "retry.ts", branch: "smithers/retry-webhooks", language: "typescript",
      digest: "sha256:captured", content: { kind: "text", text: "export const retry = 2;\n" },
      mode: "read_only", diagnostics: [], authors: [], editors: [] } })
  })
  const writer = { id: "member:2", member_id: "2", kind: "person", login: "presence-owner", name: "Alice", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 0, via: "ssh" }
  await page.route("**/api/todos/2", route => route.fulfill({ json: { branch: { name: "smithers/retry-webhooks" } } }))
  await page.route("**/api/branches/smithers%2Fretry-webhooks", route => route.fulfill({ json: { name: "smithers/retry-webhooks", machine: { id: "b-live" } } }))
  await page.route("**/api/branches", route => {
    posts.push(route.request().postDataJSON())
    return route.fulfill({ status: 201, json: { name: "scratch/ben/try-retry", kind: "scratch" } })
  })
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t === "presence") { presence.push(frame.where); return }
    if (frame.t !== "sub") return
    const data = frame.topic === "branch:b-live" || frame.topic === "branch:smithers/retry-webhooks" ? {
      id: "b-live", name: "smithers/retry-webhooks", head: capturedHead, machine: { state: "asleep" },
      item: { n: 2, title: "Retry webhooks", state: "working", place: 2 },
      rebase: { state: "pending", onto: "main" },
      presence: [{ actor: { kind: "person", login: "maya", name: "Maya", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 1, via: "ssh" }, where: { kind: "file", path: "retry.ts", line: 12 } }],
      terminals: [], ssh_line: "ssh -p 2222 retry-webhooks@localhost"
    } : frame.topic === "branch:b-live:activity" && optionalStreams === "served" ? [{ id: "outside-1", at: "2026-10-06T12:00:00Z", kind: "burst", actor: { id: "outside", kind: "outside", via: "tool" }, files: [{ path: "retry.ts", change: "modified" }] }, { id: "owned-1", at: "2026-10-06T12:00:01Z", kind: "burst", actor: writer, files: [{ path: "retry.ts", change: "modified" }] }]
      : frame.topic === "branch:b-live:files" && optionalStreams === "served" ? { changed: [{ path: "retry.ts", change: "modified", last_writer: writer }], open: [] } : undefined
    socket.send(JSON.stringify(data === undefined ? { t: "err", id: frame.id, code: "unsupported" } : { t: "snap", id: frame.id, cursor: 1, data }))
  }))
  await page.goto("/")
  await fillComposer(page, "/branch T2")
  await page.getByTestId("composer-send").click()
  const card = page.getByTestId("card-branch:b-live")
  await expect(card).toContainText("smithers/retry-webhooks")
  await expect(card).toContainText("Asleep")
  await expect(card).toContainText("Retry webhooks")
  await expect(card).toContainText("Rebase pending")
  await expect(card.getByRole("button", { name: "Rebase now", exact: true })).toHaveCount(0)
  if (optionalStreams === "served") {
    await expect(card).toContainText("changed outside Smithers")
    await expect(card.getByRole("tabpanel")).toContainText("Alice via SSH")
    await card.getByRole("tab", { name: /Files\s*1/ }).press("Enter")
    await expect(card.getByRole("tabpanel")).toContainText("retry.ts")
    await card.getByRole("tabpanel").getByRole("button", { name: "retry.ts", exact: true }).press("Enter")
    const file = page.getByTestId("card-file-branch-smithers/retry-webhooks-retry.ts")
    await expect(file).toContainText("export const retry = 2;")
    await expect.poll(() => fileReads).toEqual([
      `branches/smithers%2Fretry-webhooks/files/retry.ts?at=${capturedHead}`
    ])
    expect(posts).toEqual([])
    await card.getByRole("tab", { name: "Activity", exact: true }).press("Enter")
    await card.getByRole("button", { name: "retry.ts:12", exact: true }).press("Enter")
    await expect.poll(() => fileReads.length).toBe(2)
    expect(fileReads[1]).toBe(`branches/smithers%2Fretry-webhooks/files/retry.ts?at=${capturedHead}`)
    await expect(file).toBeVisible()
    await expect(page.getByTestId("composer-input")).toBeEnabled()
  }
  await expect(card).toContainText("Maya via SSH")
  await expect(card).toContainText("retry.ts:12")
  await expect(card).toContainText("ssh -p 2222 retry-webhooks@localhost")
  await expect(card.locator('[data-flow="box.resume"]')).toHaveCount(0)
  await expect.poll(() => presence[0]).toEqual({ branch: "b-live" })
  await card.getByRole("button", { name: "Fork", exact: true }).press("Enter")
  await expect.poll(() => posts).toEqual([{ from: "T2" }])
  await expect(page.getByTestId("composer-input")).toBeEnabled()
})

test("install Branch follows machine admission queue positions without waking", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  const writes: string[] = []
  await page.route("**/api/branches/queued", route => {
    if (route.request().method() !== "GET") writes.push(route.request().method())
    return route.fulfill({ json: { name: "queued", machine: { id: "b-queued" } } })
  })
  let publish: ((machine: unknown) => void) | undefined
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    if (frame.topic === "branch:b-queued") {
      let cursor = 0
      publish = machine => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: {
        id: "b-queued", name: "queued", machine, scratch: { forked_from: { kind: "main" } },
        presence: [], terminals: [], ssh_line: "ssh -p 2222 queued@localhost"
      } }))
      publish({ state: "waiting", position: 2 })
    } else socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data: [] }))
  }))
  await page.goto("/")
  await fillComposer(page, "/branch queued")
  await page.getByTestId("composer-send").click()
  const card = page.getByTestId("card-branch:b-queued")
  await expect(card).toContainText("Waiting for a machine · #2")
  await expect(card.getByRole("button", { name: /^(Sleep|Wake|Retry)$/ })).toHaveCount(0)
  publish!({ state: "waiting", position: 1 })
  await expect(card).toContainText("Waiting for a machine · #1")
  publish!({ state: "waking" })
  await expect(card).toContainText("Waking")
  await expect(card).not.toContainText("Waiting for a machine")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  expect(writes).toEqual([])
})
