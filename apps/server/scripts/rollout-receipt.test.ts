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
    await restoreRolloutReceipt("smithersai/smithers", directory, { async json(path) {
        if (path.includes("/artifacts?")) return { artifacts }
        const id = Number(path.split("/").at(-1))
        return { path: id === 6 ? ".github/workflows/untrusted.yml" : ".github/workflows/apps-deploy.yml",
          event: id === 5 ? "pull_request" : "push", head_branch: id === 4 ? "feature" : "main",
          status: id === 3 ? "in_progress" : "completed", conclusion: "failure" }
      }, async download(id, destination) {
      downloads.push(String(id))
      mkdirSync(join(destination, "rollout"), { recursive: true })
      writeFileSync(join(destination, "rollout", "last-rollback.json"), '{"evidence":"retained"}')
      }
    })
    expect(downloads).toEqual(["2"])
    expect(JSON.parse(readFileSync(join(directory, "last-rollback.json"), "utf8"))).toEqual({ evidence: "retained" })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("receipt read failures propagate; no unverified fallback", async () => {
  await expect(restoreRolloutReceipt("smithersai/smithers", "/unused", { async json() { throw Error("read failed") }, async download() { throw Error("unexpected download") } })).rejects.toThrow("read failed")
})

test("expired evidence cannot select an older artifact", async () => {
  const calls: string[] = []
  await restoreRolloutReceipt("smithersai/smithers", "/unused", {
    async json(path) {
      calls.push(path)
      return path.includes("/artifacts?")
        ? { artifacts: [{ id: 2, expired: true, workflow_run: { id: 2 } }, { id: 1, expired: false, workflow_run: { id: 1 } }] }
        : { path: ".github/workflows/apps-deploy.yml", event: "push", head_branch: "main", status: "completed" }
    },
    async download() { throw Error("unexpected download") }
  })
  expect(calls.length).toBe(2)
})

test("a real deploy without rollback evidence does not resurrect older receipts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollout-receipt-no-history-"))
  const downloads: string[] = []
  try {
    await restoreRolloutReceipt("smithersai/smithers", directory, {
      async json(path) { return path.includes("/artifacts?")
        ? { artifacts: [2, 1].map(id => ({ id, expired: false, workflow_run: { id } })) }
        : { path: ".github/workflows/apps-deploy.yml", event: "push", head_branch: "main", status: "completed" } },
      async download(id, destination) {
        downloads.push(String(id))
        writeFileSync(join(destination, "latest.json"), '{}')
      }
    })
    expect(downloads).toEqual(["2"])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
