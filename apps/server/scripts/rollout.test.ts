import { expect, test } from "bun:test"
import { workerRolloutHost } from "./rollout"
import { rollout } from "../../../flows/rollout/runtime.ts"

const previous = { version: "11111111-1111-1111-1111-111111111111", revision: "a".repeat(40) }
const next = { version: "22222222-2222-2222-2222-222222222222", revision: "b".repeat(40) }
test("Worker failing site probe invokes pinned rollback and checks restored SHA", async () => {
  let live = previous.version
  const commands: string[][] = []
  const host = workerRolloutHost({
    previous, serverDir: "/server/", accountId: "account", worker: "worker", token: "fake",
    inviteConfigured: false,
    publish: async () => { live = next.version; return next },
    record: async () => {},
    get: async path => path.endsWith("/deployments")
      ? { success: true, result: { deployments: [{ versions: [{ version_id: live, percentage: 100 }] }] } }
      : { success: true, result: { id: previous.version } },
    run: async cmd => {
      commands.push([...cmd])
      if (cmd.includes("rollback")) live = previous.version
      // Deliberately red executable probe; no deployment or credential required.
      const probe = Bun.spawnSync(["bun", "-e", `process.exit(${cmd.includes("scripts/canary/site-probe.ts") && live === next.version ? 1 : 0})`])
      return { exitCode: probe.exitCode, output: "" }
    },
    sleep: async () => {}
  })
  const result = await rollout(host)
  expect(result.status).toBe("rolled-back")
  expect(result.failedChecks).toEqual(["site"])
  const restore = commands.find(c => c.includes("rollback"))!
  expect(restore).toEqual(["node", "/server/node_modules/wrangler/bin/wrangler.js", "rollback", previous.version, "--yes", "--message", "Automatic rollback: required rollout check failed"])
  expect(commands.at(-3)).toContain(previous.revision)
  expect(result.skippedChecks).toEqual(["CN-23"])
})
test("CN-24 refuses a split deployment or missing captured target", async () => {
  for (const result of [{ success: true, result: { id: "other" } }, { success: false }]) {
    const host = workerRolloutHost({ previous, serverDir: "/server/", accountId: "account", worker: "worker", token: "fake", inviteConfigured: false,
      publish: async () => next, record: async () => {}, run: async () => ({ exitCode: 0, output: "" }), get: async () => result })
    await expect(host.check("CN-24", previous, "baseline")).resolves.toEqual({ status: "failed" })
  }
})
