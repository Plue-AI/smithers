import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { authenticatedTest as test } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { awaitBoot, command, expect, realApi } from "./support/test"

const execute = promisify(execFile)
// Provisioned reference canary: T2, twelve src files (retry/deliver/a included),
// Maya's SSH key/session, and Ben's signed-in browser. All writes run in the guest.
const ssh = async (operation: string) => {
  const host = process.env.SMITHERS_OUTSIDE_SSH_HOST
  const port = process.env.SMITHERS_OUTSIDE_SSH_PORT
  if (!host || host.startsWith("-") || !port || !/^\d+$/.test(port)) throw new Error("Set SMITHERS_OUTSIDE_SSH_HOST and SMITHERS_OUTSIDE_SSH_PORT for Maya's branch")
  return (await execute("ssh", ["-o", "BatchMode=yes", "-p", port, host, operation], { timeout: 30_000 })).stdout
}
type Entry = { id: string; actor: { kind: string; login?: string; via?: string }; files: { path: string }[]; versions?: string }

test("C-J3-03 reference: outside burst updates the open card; Restore refuses a later edit", scenario("branch.outside-change", {
  capabilities: ["install", "ssh"],
  coverage: ["action:branch", "action:file", "action:diff", "action:file.restore", "door:slash", "door:button", "path:success", "path:error", "surface:file-card", "evidence:outside-burst-restore", "host:local"]
}), async ({ page, request }, info) => {
  test.setTimeout(180_000)
  const branch = process.env.SMITHERS_OUTSIDE_BRANCH
  if (!branch) throw new Error("Set SMITHERS_OUTSIDE_BRANCH to the provisioned T2 branch id")
  const activity = async (): Promise<Entry[]> => {
    const response = await realApi(page, request, "GET", `/api/branches/${encodeURIComponent(branch)}/activity`)
    expect(response.status()).toBe(200)
    return await response.json() as Entry[]
  }
  await page.goto("/"); await awaitBoot(page)
  await command(page, "/branch T2")
  await command(page, `/file ${JSON.stringify({ branch, path: "src/retry.ts" })}`)
  const file = page.locator('[data-kind="file"][aria-label="src/retry.ts"]').last()
  await expect(file).toBeVisible()
  const before = await ssh("cat src/retry.ts")
  const initial = new Set((await activity()).map(entry => entry.id))
  // pnpm format must change exactly the twelve canary files.
  await ssh("pnpm format")
  const formatted = await ssh("cat src/retry.ts")
  expect(formatted).not.toBe(before)
  await expect(file).toHaveAttribute("data-digest", createHash("sha256").update(formatted).digest("hex"), { timeout: 1000 })
  let burst: Entry | undefined
  await expect.poll(async () => {
    const changes = (await activity()).filter(entry => !initial.has(entry.id))
    if (changes.length === 1) burst = changes[0]
    return changes.length
  }, { timeout: 10_000 }).toBe(1)
  expect(burst!.files).toHaveLength(12)
  expect(burst!.actor.login).toBe("maya")
  expect(burst!.actor.via).toBe("ssh")
  expect(burst!.versions).toMatch(/^[0-9a-f]{40}$/)
  await command(page, `/diff ${JSON.stringify({ branch, entry: burst!.id, path: "src/retry.ts" })}`)
  const diff = page.locator('[data-kind="diff"][aria-label="src/retry.ts changes"]').last()
  await expect(diff).toBeVisible()
  await diff.getByRole("button", { name: "Restore this file", exact: true }).click()
  await expect.poll(() => ssh("cat src/retry.ts")).toBe(before)
  await expect(file).toHaveAttribute("data-digest", createHash("sha256").update(before).digest("hex"), { timeout: 1000 })
  await expect.poll(async () => (await activity()).some(entry => !initial.has(entry.id) && entry.id !== burst!.id && entry.actor.kind === "person" && entry.actor.login !== "maya")).toBe(true)

  await ssh("printf '\\n// later outside edit\\n' >> src/deliver.ts")
  const later = await ssh("cat src/deliver.ts")
  await command(page, `/diff ${JSON.stringify({ branch, entry: burst!.id, path: "src/deliver.ts" })}`)
  await page.locator('[data-kind="diff"][aria-label="src/deliver.ts changes"]').last().getByRole("button", { name: "Restore this file", exact: true }).click()
  await expect(page.locator('[data-kind="compare"]').last()).toBeVisible()
  expect(await ssh("cat src/deliver.ts")).toBe(later)
  // Allow the preceding burst to close before measuring ignored writes.
  await page.waitForTimeout(2000)
  const count = (await activity()).length
  await ssh("mkdir -p node_modules/outside-check; printf ignored > node_modules/outside-check/file")
  await page.waitForTimeout(2000)
  expect((await activity()).length).toBe(count)
  await info.attach("outside-change", { body: JSON.stringify({ burst, before, formatted, later, activity: await activity() }), contentType: "application/json" })
})

test("C-J3-03 reference: two busy member sessions produce outside attribution", scenario("branch.outside-change-overlap", {
  capabilities: ["install", "ssh", "multiplayer"],
  coverage: ["action:branch", "door:slash", "path:success", "evidence:outside-two-active-sessions", "host:local"]
}), async ({ page, request }, info) => {
  const branch = process.env.SMITHERS_OUTSIDE_BRANCH
  const host = process.env.SMITHERS_OUTSIDE_BEN_SSH_HOST
  const port = process.env.SMITHERS_OUTSIDE_SSH_PORT
  if (!branch || !host || host.startsWith("-") || !port || !/^\d+$/.test(port)) throw new Error("Provision Ben's second SSH identity in SMITHERS_OUTSIDE_BEN_SSH_HOST")
  await page.goto("/"); await awaitBoot(page); await command(page, "/branch T2")
  const activity = async (): Promise<Entry[]> => {
    const response = await realApi(page, request, "GET", `/api/branches/${encodeURIComponent(branch)}/activity`)
    expect(response.status()).toBe(200)
    return await response.json() as Entry[]
  }
  const before = new Set((await activity()).map(entry => entry.id))
  // Both sessions burn CPU across the same burst; neither can own it.
  const ben = execute("ssh", ["-o", "BatchMode=yes", "-p", port, host, "end=$(( $(date +%s) + 8 )); while [ $(date +%s) -lt $end ]; do :; done"], { timeout: 20_000 })
  try {
    await page.waitForTimeout(1000)
    await ssh("printf '\\n// overlap\\n' >> src/a.ts; end=$(( $(date +%s) + 3 )); while [ $(date +%s) -lt $end ]; do :; done")
    await expect.poll(async () => (await activity()).filter(entry => !before.has(entry.id)).length, { timeout: 10_000 }).toBe(1)
    const entries = (await activity()).filter(entry => !before.has(entry.id))
    expect(entries[0]!.actor.kind).toBe("outside")
    expect(entries[0]!.files.map(file => file.path)).toEqual(["src/a.ts"])
    await info.attach("overlap", { body: JSON.stringify(entries), contentType: "application/json" })
  } finally { await ben }
})
