import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { restoreRolloutReceipt } from "./rollout-receipt"

test("fresh runners recover evidence only from completed main-push deploy artifacts, including failed runs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollout-receipt-test-"))
  const downloads: string[] = []
  try {
    const artifacts = [6, 5, 4, 3, 2, 1].map(id => ({ id, expired: false, workflow_run: { id } }))
    await restoreRolloutReceipt("smithersai/smithers", directory, async args => {
      if (args[0] === "api") {
        const path = args[1]!
        if (path.includes("/artifacts?")) return JSON.stringify({ artifacts })
        const id = Number(path.split("/").at(-1))
        return JSON.stringify({ path: id === 6 ? ".github/workflows/untrusted.yml" : ".github/workflows/apps-deploy.yml",
          event: id === 5 ? "pull_request" : "push", head_branch: id === 4 ? "feature" : "main",
          status: id === 3 ? "in_progress" : "completed", conclusion: "failure" })
      }
      downloads.push(args[2]!)
      const destination = args[args.indexOf("--dir") + 1]!
      mkdirSync(join(destination, "rollout"), { recursive: true })
      writeFileSync(join(destination, "rollout", "last-rollback.json"), '{"evidence":"retained"}')
      return ""
    })
    expect(downloads).toEqual(["2"])
    expect(JSON.parse(readFileSync(join(directory, "last-rollback.json"), "utf8"))).toEqual({ evidence: "retained" })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("receipt read failures propagate; no unverified fallback", async () => {
  await expect(restoreRolloutReceipt("smithersai/smithers", "/unused", async () => { throw Error("read failed") })).rejects.toThrow("read failed")
})

test("expired evidence cannot select an older artifact", async () => {
  const calls: string[][] = []
  await restoreRolloutReceipt("smithersai/smithers", "/unused", async args => {
    calls.push(args)
    return args[1]!.includes("/artifacts?")
      ? JSON.stringify({ artifacts: [{ id: 2, expired: true, workflow_run: { id: 2 } }, { id: 1, expired: false, workflow_run: { id: 1 } }] })
      : JSON.stringify({ path: ".github/workflows/apps-deploy.yml", event: "push", head_branch: "main", status: "completed" })
  })
  expect(calls.length).toBe(2)
  expect(calls.some(args => args[0] === "run")).toBe(false)
})

test("a real deploy without rollback evidence does not resurrect older receipts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollout-receipt-no-history-"))
  const downloads: string[] = []
  try {
    await restoreRolloutReceipt("smithersai/smithers", directory, async args => {
      if (args[0] === "api") return args[1]!.includes("/artifacts?")
        ? JSON.stringify({ artifacts: [2, 1].map(id => ({ id, expired: false, workflow_run: { id } })) })
        : JSON.stringify({ path: ".github/workflows/apps-deploy.yml", event: "push", head_branch: "main", status: "completed" })
      downloads.push(args[2]!)
      writeFileSync(join(args[args.indexOf("--dir") + 1]!, "latest.json"), '{}')
      return ""
    })
    expect(downloads).toEqual(["2"])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
