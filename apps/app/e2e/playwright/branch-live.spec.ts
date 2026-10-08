import { expect, test } from "./browserTest"
import { fillComposer } from "./composer"
import { installCloudFixture } from "./cloudFixture"

test("install item Diff reads its branch while burst Diff refuses substitution", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  const reads: string[] = []
  await page.route("**/api/branches/**/diff**", route => {
    reads.push(route.request().url())
    return route.fulfill({ json: { files: [{ path: "retry.ts", branch: "smithers/retry-webhooks",
      against: { kind: "item_base", rev: "2222222222222222222222222222222222222222" }, change: "modified",
      hunks: [{ old_start: 1, new_start: 1, lines: [{ op: "-", text: "const delay = 1" }, { op: "+", text: "const delay = 2" }] }] }] } })
  })
  await page.goto("/")
  await fillComposer(page, '/diff {"branch":"smithers/retry-webhooks","entry":"6ad2b1a9-1869-4d1a-b087-8ba32a09b102"}')
  await page.getByTestId("composer-send").click()
  await expect(page.getByText("Burst diff unavailable", { exact: true }).last()).toBeVisible()
  await expect(page.locator('[data-testid^="card-diff"]')).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  expect(reads).toEqual([])
  await fillComposer(page, "/diff smithers/retry-webhooks")
  await page.getByTestId("composer-send").click()
  const diff = page.getByTestId("card-diff-branch-smithers/retry-webhooks")
  await expect(diff).toBeVisible()
  await expect(diff).toContainText("retry.ts")
  await expect.poll(() => reads.length).toBe(1)
  expect(new URL(reads[0]!).pathname).toBe("/api/branches/smithers%2Fretry-webhooks/diff")
})

// Browser contract proof. The PostgreSQL/SSH/lease journey remains reference-host evidence.
for (const optionalStreams of ["served", "unsupported", "scratch"] as const) test(`install /branch T2 renders captured facts with ${optionalStreams} streams without waking`, async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
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
    if (route.request().method() === "GET") return route.fulfill({ json: [{ name: "smithers/retry-webhooks", kind: "item", state: "asleep", machine: { id: "b-live" } }] })
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
      ...(optionalStreams === "scratch" ? { scratch: { forked_from: { kind: "item", n: 2, title: "Retry webhooks" } } } : { item: { n: 2, title: "Retry webhooks", state: "working", place: 2 } }),
      rebase: { state: "pending", onto: "main" },
      presence: [{ actor: { kind: "person", login: "maya", name: "Maya", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 1, via: "ssh" }, where: { kind: "file", path: "retry.ts", line: 12 } }],
      terminals: [{ id: "t-live", title: "Shell", owner: { kind: "person", login: "maya", name: "Maya", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 1 }, agents: [], watchers: [], frozen: false }], ssh_line: "ssh -p 2222 retry-webhooks@localhost"
    } : frame.topic === "branch:b-live:activity" && optionalStreams === "served" ? [{ id: "outside-1", at: "2026-10-06T12:00:00Z", kind: "burst", actor: { id: "outside", kind: "outside", via: "tool" }, files: [{ path: "retry.ts", change: "modified" }] }, { id: "owned-1", at: "2026-10-06T12:00:01Z", kind: "burst", actor: writer, files: [{ path: "retry.ts", change: "modified" }] },
      { id: "steer-1", at: "2026-10-06T12:00:02Z", kind: "steer", actor: { kind: "person", login: "presence-owner", name: "Alice", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 0 }, text: "Keep retry backoff bounded" },
      { id: "answer-1", at: "2026-10-06T12:00:03Z", kind: "answer", actor: { kind: "person", login: "presence-owner", name: "Alice", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 0 }, text: "Use the existing retry helper" }]
      : frame.topic === "branch:b-live:files" && optionalStreams === "served" ? { changed: [{ path: "retry.ts", change: "modified", last_writer: writer }], open: [] } : undefined
    socket.send(JSON.stringify(data === undefined ? { t: "err", id: frame.id, code: "unsupported" } : { t: "snap", id: frame.id, cursor: 1, data }))
  }))
  await page.goto("/")
  await fillComposer(page, "/ssh T2")
  await page.getByTestId("composer-send").click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("ssh -p 2222 retry-webhooks@localhost")
  await expect(page.getByTestId("card-branch:b-live")).toHaveCount(0)
  expect(posts).toEqual([])
  await fillComposer(page, "/branch T2")
  await page.getByTestId("composer-send").click()
  const card = page.getByTestId("card-branch:b-live")
  await expect(card).toContainText("smithers/retry-webhooks")
  await expect(card).toContainText("Asleep")
  await expect(card).toContainText("Retry webhooks")
  await expect(card).toContainText("Rebase pending")
  await expect(card.getByRole("button", { name: "Rebase now", exact: true })).toBeVisible()
  if (optionalStreams === "served") {
    await expect(card).toContainText("changed outside Smithers")
    await expect(card.getByRole("tabpanel")).toContainText("Alice via SSH")
    const inputs = card.locator('[data-kind="steer"], [data-kind="answer"]')
    await expect(inputs).toHaveCount(2)
    await expect(inputs.nth(0)).toContainText("Alice")
    await expect(inputs.nth(0)).toContainText("Keep retry backoff bounded")
    await expect(inputs.nth(1)).toContainText("Alice")
    await expect(inputs.nth(1)).toContainText("Use the existing retry helper")
    for (const row of [inputs.nth(0), inputs.nth(1)]) {
      await expect(row).not.toContainText("changed")
      await expect(row).not.toContainText("files")
    }
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
  await expect(card.locator('[data-flow="box.resume"]')).toBeVisible()
  await expect.poll(() => presence[0]).toEqual({ branch: "b-live" })
  await card.getByRole("tab", { name: /Terminals\s*1/ }).press("Enter")
  await card.getByRole("button", { name: /Shell/ }).press("Enter")
  await expect(page.getByTestId("card-terminal:t-live")).toBeVisible()
  await fillComposer(page, "/ssh T2")
  await page.getByTestId("composer-send").click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("ssh -p 2222 retry-webhooks@localhost")
  expect(posts).toEqual([])
  if (optionalStreams === "scratch") {
    await expect(card).toContainText("Scratch")
    await expect(card).toContainText("T2 Retry webhooks")
    await expect(card.getByRole("button", { name: "Add to stack", exact: true })).toBeVisible()
    expect(posts).toEqual([])
  } else {
    await card.getByRole("button", { name: "Fork", exact: true }).press("Enter")
    await expect.poll(() => posts).toEqual([{ from: "T2" }])
  }
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

test("install Branch agent step opens its admitted run inline through the shared flow", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route("**/api/branches/working", route => route.fulfill({ json: { name: "working", machine: { id: "b-working" } } }))
  const subscriptions: string[] = []
  const writes: string[] = []
  page.on("request", request => {
    if (request.url().includes("/api/") && request.method() !== "GET") writes.push(request.url())
  })
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    subscriptions.push(frame.topic)
    const data = frame.topic === "branch:b-working" ? {
      id: "b-working", name: "working", machine: { state: "awake" }, scratch: { forked_from: { kind: "main" } },
      presence: [{ actor: { kind: "agent", id: "coding-1", agent: "coding", run_id: "admitted-run", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 6 },
        where: { kind: "step", label: "Implement" } }], terminals: [], ssh_line: "ssh -p 2222 working@localhost"
    } : frame.topic === "run:admitted-run" ? {
      id: "admitted-run", flow: "todo", version: "digest-1", title: "Implement retries", state: "running",
      attempts: [], waits: [], tokens: 0, time_s: 0, cost_usd: 0, engine: [], journal: []
    } : []
    socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data }))
  }))
  await page.goto("/")
  await fillComposer(page, "/branch working")
  await page.getByTestId("composer-send").click()
  const branch = page.getByTestId("card-branch:b-working")
  await branch.getByRole("button", { name: "Implement", exact: true }).press("Enter")
  await expect(page.getByTestId("card-run:admitted-run")).toContainText("Implement retries")
  await expect.poll(() => subscriptions.includes("run:admitted-run")).toBe(true)
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toHaveCount(0)
  await expect(branch).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
  expect(writes.filter(url => url.includes("/api/branches") || url.includes("/api/runs/"))).toEqual([])
})
