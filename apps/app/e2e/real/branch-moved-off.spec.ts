import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { authenticatedTest as test, launchAuthenticatedProfile } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { awaitBoot, command, expect, realApi } from "./support/test"

const execute = promisify(execFile)
// The reference lane provisions T2 and its SSH identity in githubfake's canary.
// No browser routing, seeded DesignWorld or host repository execution is used.
const ssh = async (operation: string): Promise<string> => {
  const host = process.env.SMITHERS_MOVED_OFF_SSH_HOST
  const port = process.env.SMITHERS_MOVED_OFF_SSH_PORT
  if (!host || host.startsWith("-") || !port || !/^\d+$/.test(port)) {
    throw new Error("Reference lane requires SMITHERS_MOVED_OFF_SSH_HOST and SMITHERS_MOVED_OFF_SSH_PORT")
  }
  const { stdout } = await execute("ssh", ["-o", "BatchMode=yes", "-p", port, host, operation], { timeout: 30_000, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}
const record = async () => {
  const commit = await ssh("jj log --no-graph -r @ -T commit_id")
  const change = await ssh("jj log --no-graph -r @ -T change_id")
  expect(commit).toMatch(/^[0-9a-f]{40}$/)
  expect(change).toMatch(/^[k-z]{32}$/)
  return { commit, change, head: await ssh("git rev-parse HEAD"), files: await ssh("git ls-files -z | xargs -0 sha256sum") }
}

test("C-J3-09 reference: Return restores the item; Keep holds Needs you", scenario("branch.moved-off", {
  capabilities: ["install", "ssh"],
  coverage: ["action:todo.return-to-item", "action:todo.keep-moved", "path:success", "door:button", "evidence:ssh-item-restore", "host:local"]
}), async ({ page, request }, info) => {
  test.setTimeout(180_000)
  await page.goto("/")
  await awaitBoot(page)
  await command(page, "/branch T2")
  const before = await record()
  await info.attach("before", { body: JSON.stringify(before), contentType: "application/json" })
  const todo = async () => {
    const response = await realApi(page, request, "GET", "/api/todos/2")
    expect(response.status()).toBe(200)
    return await response.json() as { state: string; waits: Array<{ kind: string }> }
  }
  const returnButton = page.getByRole("button", { name: "Return to T2", exact: true }).last()
  await ssh("git checkout main")
  await expect(returnButton).toBeVisible({ timeout: 1000 })
  await expect.poll(async () => (await todo()).state).toBe("needs_you")
  await returnButton.click()
  await expect.poll(async () => (await todo()).state).toBe("working")
  expect(await record()).toEqual(before)

  await ssh("git checkout main")
  await expect(returnButton).toBeVisible({ timeout: 1000 })
  await ssh("printf 'recoverable after move\\n' > notes.txt")
  await returnButton.click()
  await expect.poll(async () => (await todo()).state).toBe("working")
  expect(await ssh("test ! -e notes.txt && printf absent")).toBe("absent")
  expect(await ssh("jj log --no-graph -r 'all()' -T 'commit_id ++ \"\\n\"' | while read id; do jj file show -r \"$id\" notes.txt 2>/dev/null; done")).toContain("recoverable after move")

  await ssh("jj new main")
  await expect(returnButton).toBeVisible({ timeout: 1000 })
  await page.getByRole("button", { name: "Keep for now", exact: true }).last().click()
  const heldUntil = Date.now() + 30_000
  while (Date.now() < heldUntil) {
    expect((await todo()).state).toBe("needs_you")
    expect((await todo()).waits.some(wait => wait.kind === "moved_off")).toBe(true)
    await page.waitForTimeout(1000)
  }
  await ssh(`jj edit ${before.commit}`)
  await expect.poll(async () => (await todo()).state).toBe("working")
  expect(await record()).toEqual(before)
  await info.attach("after", { body: JSON.stringify(await record()), contentType: "application/json" })
})

// A second authenticated member must be provisioned by the reference lane.
// The actual served cards, sessions and first-answer transaction are exercised.
test("C-J3-09 reference: both members see the move and only one choice wins", scenario("branch.moved-off-members", {
  capabilities: ["install", "ssh", "multiplayer"],
  coverage: ["action:todo.return-to-item", "action:todo.keep-moved", "path:success", "path:permission", "door:button", "evidence:moved-off-first-answer", "host:local"]
}), async ({ page, request, playwright, baseURL }, info) => {
  test.setTimeout(120_000)
  if (!baseURL) throw new Error("Reference install URL required")
  const member = await launchAuthenticatedProfile(playwright, baseURL, "SMITHERS_MOVED_OFF_MEMBER_PROFILE")
  try {
    await page.goto("/"); await awaitBoot(page)
    await awaitBoot(member.page)
    await command(page, "/branch T2")
    await command(member.page, "/branch T2")
    const before = await record()
    const initial = await realApi(page, request, "GET", "/api/todos/2")
    expect(initial.status()).toBe(200)
    const owner = (await initial.json()).owner.login
    expect(member.session.login).not.toBe(owner)
    await ssh("git checkout main")
    await expect(page.getByRole("button", { name: "Return to T2", exact: true }).last()).toBeVisible()
    await expect(member.page.getByRole("button", { name: "Keep for now", exact: true }).last()).toBeVisible()
    await expect(page.getByText("T2 needs you", { exact: true }).last()).toBeVisible()
    await expect(member.page.getByText("T2 needs you", { exact: true }).last()).toBeVisible()
    const current = await realApi(page, request, "GET", "/api/todos/2")
    const wait = (await current.json()).waits.find((wait: { kind: string }) => wait.kind === "moved_off")
    expect(wait?.id).toBeTruthy()
    const post = async (target: typeof page, op: string) => {
      const origin = new URL(process.env.SMITHERS_REAL_API_ORIGIN ?? baseURL).origin
      const csrf = (await target.context().cookies(origin)).find(cookie => cookie.name === "__csrf")?.value
      if (!csrf) throw new Error("Member CSRF cookie required")
      return target.context().request.post(new URL("/api/todos/2", origin).toString(), {
        headers: { Origin: origin, "X-CSRF-Token": csrf, "Idempotency-Key": `moved-race-${wait.id}-${op}` },
        data: { op, id: wait.id }
      })
    }
    const responses = await Promise.all([post(page, "return-to-item"), post(member.page, "keep-moved")])
    expect(responses.map(response => response.status()).sort()).toEqual([202, 409])
    const refusal = await responses.find(response => response.status() === 409)!.json()
    expect([owner, member.session.login]).toContain(refusal.answered_by)
    await info.attach("first-answer", { body: JSON.stringify({ statuses: responses.map(response => response.status()), answered_by: refusal.answered_by, wait: wait.id }), contentType: "application/json" })
    if (responses[1]!.status() === 202) {
      // The winning Keep leaves the move and both live cards visible.
      await expect(page.getByText(wait.prompt, { exact: true }).last()).toBeVisible()
      await expect(member.page.getByText(wait.prompt, { exact: true }).last()).toBeVisible()
      await ssh(`jj edit ${before.commit}`)
    }
    await expect.poll(async () => {
      const response = await realApi(page, request, "GET", "/api/todos/2")
      expect(response.status()).toBe(200)
      return (await response.json()).waits.some((row: { id: string }) => row.id === wait.id)
    }).toBe(false)
    expect(await record()).toEqual(before)
  } finally { await member.close() }
})
