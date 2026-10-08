import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { authenticatedTest as test, launchAuthenticatedProfile } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { awaitBoot, command, expect, realApi } from "./support/test"

const execute = promisify(execFile)
const connection = (): string[] => {
  const host = process.env.SMITHERS_PRESENCE_SSH_HOST
  const port = process.env.SMITHERS_PRESENCE_SSH_PORT
  if (!host || host.startsWith("-") || !port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("Reference journey requires SMITHERS_PRESENCE_SSH_HOST and SMITHERS_PRESENCE_SSH_PORT for Maya on T2")
  }
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", port, host]
}

// C-J3-06 steps 1, 2 and the SSH write/presence part of step 5. The reference
// operator provisions Maya's GitHub key and browser profile, T2 and src/retry.ts.
// SFTP, forwarding, capacity, revocation and recorded VS Code remain separate
// reference receipts; this scenario never seeds rows or mocks app transport.
test("C-J3-06: GitHub-key SSH identity, half-close and attributed file presence", scenario("branch.ssh", {
  capabilities: ["install", "ssh", "multiplayer"],
  coverage: ["action:branch", "path:success", "door:slash", "evidence:ssh-presence", "host:local"]
}), async ({ page, playwright, baseURL }, info) => {
  test.setTimeout(120_000)
  if (!baseURL) throw new Error("Reference install URL required")
  const args = connection()
  const maya = await launchAuthenticatedProfile(playwright, baseURL, "SMITHERS_PRESENCE_MAYA_PROFILE")
  const transcript: Array<{ command: string; stdout: string; stderr: string }> = []
  try {
    await awaitBoot(maya.page)
    const keys = await realApi(maya.page, maya.page.context().request, "GET", "/api/user/keys")
    expect(keys.status()).toBe(200)
    const body = await keys.json()
    const rows = Array.isArray(body) ? body : body.keys
    expect(rows.some((row: { source: string }) => row.source === "github")).toBe(true)
    const identity = await execute("ssh", [...args, "id -un; pwd"], { timeout: 30_000 })
    expect(identity.stdout.trim().split(/\r?\n/)).toEqual(["maya", "/workspace"])
    transcript.push({ command: "id -un; pwd", ...identity })
    try {
      await execute("ssh", [...args, "exit 7"], { timeout: 30_000 })
      throw new Error("SSH discarded the remote exit status")
    } catch (error) {
      expect((error as { code?: number }).code).toBe(7)
    }
    const count = spawn("ssh", [...args, "wc -c"], { stdio: ["pipe", "pipe", "pipe"], timeout: 45_000 })
    let counted = ""
    let countError = ""
    count.stdout.on("data", bytes => { counted += bytes.toString() })
    count.stderr.on("data", bytes => { countError += bytes.toString() })
    const countedExit = new Promise<number | null>((resolve, reject) => {
      count.once("error", reject)
      count.once("close", resolve)
    })
    count.stdin.end(Buffer.alloc(1_048_576, 120))
    expect(await countedExit).toBe(0)
    expect(counted.trim()).toBe("1048576")
    transcript.push({ command: "wc -c < one MiB", stdout: counted, stderr: countError })

    await page.goto("/")
    await awaitBoot(page)
    await command(page, "/branch T2")
    const presence = page.getByRole("list", { name: "On this branch", exact: true }).last()
    // Keep the actual SSH session alive while its attributed write is shown.
    // EOF ends the session cleanly; no fabricated heartbeat or timed fixture.
    const remote = "printf '\\n// maya remote edit\\n' >> src/retry.ts; printf 'saved\\n'; read -r done"
    const session = spawn("ssh", [...args, remote], { stdio: ["pipe", "pipe", "pipe"], timeout: 45_000 })
    let output = ""
    let stderr = ""
    session.stdout.on("data", bytes => { output += bytes.toString() })
    session.stderr.on("data", bytes => { stderr += bytes.toString() })
    const ended = new Promise<number | null>((resolve, reject) => {
      session.once("error", reject)
      session.once("close", resolve)
    })
    try {
      await expect.poll(() => output, { timeout: 30_000 }).toContain("saved")
      await expect(presence.getByText("Maya via SSH", { exact: true })).toHaveCount(1, { timeout: 1000 })
      await expect(presence.getByRole("button", { name: /(?:src\/)?retry\.ts(?::\d+)?$/ })).toBeVisible({ timeout: 1000 })
      await expect(page.getByRole("button", { name: "Maya via SSH changed 1 file", exact: true }).last()).toBeVisible()
    } finally {
      session.stdin.end("done\n")
      expect(await ended).toBe(0)
      transcript.push({ command: remote, stdout: output, stderr })
    }
    await expect(presence.getByText("Maya via SSH", { exact: true })).toHaveCount(0, { timeout: 1000 })
  } finally {
    await info.attach("ssh-transcript", { body: JSON.stringify(transcript), contentType: "application/json" })
    await maya.close()
  }
})
