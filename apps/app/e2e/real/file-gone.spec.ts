import { journeyReach } from "./support/keyboard-journey-input"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { authenticatedTest as test } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { awaitBoot, command, expect, realApi } from "./support/test"

const execute = promisify(execFile)
type Entry = { id: string; actor: { login?: string; via?: string }; files: { path: string }[] }

// C-J3-08 S2, also the real backend + machine reload integration for T-APP-11.
// Ben's authenticated browser and Maya's SSH identity use one provisioned,
// awake branch. No test-host file store, event injection or repository push.
test("C-J3-08: deleted Restore, renamed Follow and atomic save on the installed branch", scenario("file.gone", {
  capabilities: ["install", "ssh"],
  coverage: ["action:file", "action:file.restore-deleted", "action:file.follow-rename", "door:slash", "door:button", "path:success", "dimension:keyboard", "surface:file-card", "evidence:file-gone-machine-readback", "host:local"]
}), async ({ page, request }, info) => {
  test.setTimeout(120_000)
  const branch = process.env.SMITHERS_OUTSIDE_BRANCH
  const host = process.env.SMITHERS_OUTSIDE_SSH_HOST
  const port = process.env.SMITHERS_OUTSIDE_SSH_PORT
  if (!branch || !host || host.startsWith("-") || !port || !/^\d+$/.test(port)) throw new Error("Provision SMITHERS_OUTSIDE_BRANCH, SMITHERS_OUTSIDE_SSH_HOST and SMITHERS_OUTSIDE_SSH_PORT for Maya")
  const sshLog: { command: string; stdout: string; at: string }[] = []
  const ssh = async (operation: string) => {
    const { stdout } = await execute("ssh", ["-o", "BatchMode=yes", "-p", port, host, operation], { timeout: 30_000 })
    sshLog.push({ command: operation, stdout, at: new Date().toISOString() })
    return stdout
  }
  const fileUrl = (path: string) => `/api/branches/${encodeURIComponent(branch)}/files/${path}`
  const activity = async (): Promise<Entry[]> => {
    const response = await realApi(page, request, "GET", `/api/branches/${encodeURIComponent(branch)}/activity`)
    expect(response.status()).toBe(200)
    return await response.json() as Entry[]
  }
  const digest = (text: string) => createHash("sha256").update(text).digest("hex")
  const deltas: string[] = []
  page.on("websocket", socket => socket.on("framereceived", frame => deltas.push(String(frame.payload))))
  await page.goto("/"); await awaitBoot(page)
  await command(page, `/file ${JSON.stringify({ branch, path: "src/retry.ts" })}`)
  await command(page, `/file ${JSON.stringify({ branch, path: "src/webhook.ts" })}`)
  const retry = page.locator('[data-kind="file"][aria-label="src/retry.ts"]').last()
  const webhook = page.locator('[data-kind="file"][aria-label="src/webhook.ts"]').last()
  const before = await ssh("cat src/retry.ts")
  const webhookBefore = await ssh("cat src/webhook.ts")
  await expect(retry).toHaveAttribute("data-digest", digest(before))
  await expect(retry.getByRole("textbox")).toHaveAttribute("aria-readonly", "true")
  // An expando independently detects a replaced DOM card, including Follow.
  await webhook.evaluate(element => { (element as HTMLElement & { canaryIdentity?: string }).canaryIdentity = "same-card" })
  const initial = new Set((await activity()).map(entry => entry.id))
  const oneEntry = async (known: Set<string>, login: string, path: string) => {
    await expect.poll(async () => (await activity()).filter(entry => !known.has(entry.id)).length, { timeout: 10_000 }).toBe(1)
    const entries = (await activity()).filter(entry => !known.has(entry.id))
    expect(entries[0]!.actor.login).toBe(login)
    expect(entries[0]!.files.map(file => file.path)).toEqual([path])
    return entries[0]!
  }
  try {
    await ssh("rm src/retry.ts")
    await expect(retry).toContainText("Deleted by Maya via SSH", { timeout: 1000 })
    await expect(retry.getByRole("textbox")).toContainText(before.trimEnd())
    const deleted = await realApi(page, request, "GET", fileUrl("src/retry.ts"))
    expect(deleted.status()).toBe(200)
    expect((await deleted.json()).content).toEqual({ kind: "text", text: before })
    const deletion = await oneEntry(initial, "maya", "src/retry.ts")
    expect(deletion.actor.via).toBe("ssh")
    const afterDelete = new Set((await activity()).map(entry => entry.id))
    await journeyReach(retry.getByRole("button", { name: "Restore", exact: true }))
    await page.keyboard.press("Enter")
    await expect.poll(() => ssh("cat src/retry.ts")).toBe(before)
    await expect(retry).not.toContainText("Deleted by")
    await expect(retry).toHaveAttribute("data-digest", digest(before))
    await oneEntry(afterDelete, "ben", "src/retry.ts")
    const afterRestore = new Set((await activity()).map(entry => entry.id))
    await ssh("git mv src/webhook.ts src/deliver.ts")
    await expect(webhook).toContainText("Renamed to deliver.ts by Maya via SSH", { timeout: 1000 })
    const rename = await oneEntry(afterRestore, "maya", "src/webhook.ts")
    expect(rename.actor.via).toBe("ssh")
    await journeyReach(webhook.getByRole("button", { name: "Follow", exact: true }))
    await page.keyboard.press("Enter")
    const deliver = page.locator('[data-kind="file"][aria-label="src/deliver.ts"]').last()
    await expect(deliver).toHaveAttribute("data-digest", digest(webhookBefore))
    expect(await deliver.evaluate(element => (element as HTMLElement & { canaryIdentity?: string }).canaryIdentity)).toBe("same-card")
    await expect(page.locator('[data-kind="file"][aria-label="src/webhook.ts"]')).toHaveCount(0)
    const afterRename = new Set((await activity()).map(entry => entry.id))
    await deliver.evaluate(element => {
      const notices: string[] = []
      const observer = new MutationObserver(() => {
        const text = element.querySelector(".code-file-notice")?.textContent ?? ""
        if (/Deleted by|Renamed to/.test(text)) notices.push(text)
      })
      observer.observe(element, { subtree: true, childList: true, characterData: true })
      ;(element as HTMLElement & { atomicNotices?: string[]; atomicObserver?: MutationObserver }).atomicNotices = notices
      ;(element as HTMLElement & { atomicObserver?: MutationObserver }).atomicObserver = observer
    })
    await ssh("printf 'export const atomicSave = 42;\n' > src/.deliver.ts.tmp && mv src/.deliver.ts.tmp src/deliver.ts")
    const saved = "export const atomicSave = 42;\n"
    await expect(deliver).toHaveAttribute("data-digest", digest(saved), { timeout: 1000 })
    await expect(deliver).toContainText("export const atomicSave = 42;")
    await expect(deliver).not.toContainText("Deleted by")
    await expect(deliver).not.toContainText("Renamed to")
    const readback = await realApi(page, request, "GET", fileUrl("src/deliver.ts"))
    expect(readback.status()).toBe(200)
    expect((await readback.json()).content).toEqual({ kind: "text", text: saved })
    await oneEntry(afterRename, "maya", "src/deliver.ts")
    expect(await ssh("cat src/deliver.ts")).toBe(saved)
    expect(await deliver.evaluate(element => {
      const observed = element as HTMLElement & { atomicNotices?: string[]; atomicObserver?: MutationObserver }
      observed.atomicObserver?.disconnect()
      return observed.atomicNotices
    })).toEqual([])
  } finally {
    await info.attach("files-deltas", { body: deltas.join("\n"), contentType: "application/x-ndjson" })
    await info.attach("maya-ssh", { body: JSON.stringify(sshLog), contentType: "application/json" })
    await info.attach("restored-file-digest", { body: JSON.stringify({ sha256: digest(before), bytes: Buffer.byteLength(before), branch }), contentType: "application/json" })
  }
})
