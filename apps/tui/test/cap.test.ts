/** A worker stopped at its run cap, resumed from the cap form: the chosen allowance reaches its run, and no other. */
import { expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Budget from "../src/budget.ts"
import * as Host from "../src/host.ts"
import { Workspace } from "../src/workspace.ts"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

it("resumes a worker stopped at its run cap with the chosen allowance, for it alone, and keeps it on later retries", async () => {
  const runs: Array<Host.TurnInput> = []
  const finish = new Map<string, (outcome: Host.Outcome) => void>()
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-cap-")),
    runCap: 100,
    judged: false,
    compaction: async () => undefined,
    dispose: async () => {},
    run: (input) => {
      runs.push(input)
      return { done: new Promise((resolve) => finish.set(input.source!, resolve)), cancel: () => {} }
    }
  }
  const workspace = new Workspace({ host, workerSeat: "worker:test", history: () => [], persist: () => {} })
  const stop = (id: string) =>
    finish.get(id)!({
      _tag: "failed",
      message: "cap",
      detail: "",
      error: { _tag: "flows/agent/BudgetExceeded", scope: "tokens", used: 100, max: 100 }
    })
  workspace.request({ id: "w", title: "w", prompt: "w" })
  workspace.request({ id: "other", title: "other", prompt: "other" })
  await tick()
  stop("w")
  await tick()
  expect(Budget.capped(workspace.snapshot().tabs[0]!.failure)).toBe(true)
  expect(() => workspace.raiseCap("other", { times: 2 })).toThrow("Only a worker stopped at its run cap")
  expect(workspace.snapshot().tabs[1]!.caps).toBeUndefined()
  workspace.raiseCap("w", { times: 2 })
  await tick()
  expect(runs.map((run) => [run.source, run.caps])).toEqual([["w", undefined], ["other", undefined], ["w", {
    times: 2
  }]])
  // A child the raised worker delegates runs under the host's cap.
  runs.at(-1)!.runtime!.delegate!({ id: "kid", title: "kid", prompt: "kid" })
  await tick()
  expect(runs.at(-1)).toMatchObject({ source: "w/kid" })
  expect(runs.at(-1)!.caps).toBeUndefined()
  stop("w")
  await tick()
  workspace.retry("w")
  await tick()
  expect(runs.at(-1)!.caps).toEqual({ times: 2 })
})

it("follows the operator's run cap up or down: the choice is a multiple of it", () => {
  const policy = { tokens: { max: 1000, onExceeded: "fail" as const }, daily: { max: 5000 } }
  expect(Host.raised(policy, {})).toEqual(policy)
  expect(Host.raised(policy, { times: 2 })).toEqual({ ...policy, tokens: { max: 2000, onExceeded: "fail" } })
  expect(Host.raised({ ...policy, tokens: { max: 50, onExceeded: "fail" } }, { times: 2 }).tokens?.max).toBe(100)
})
