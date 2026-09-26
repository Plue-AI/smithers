import { expect, it } from "bun:test"
import * as Command from "../src/tab-command.ts"

it("opens the picker for missing ids and reports unknown ids without acting", () => {
  const calls: string[] = []
  const target = (ids: Set<string>): Command.Target => ({
    has: (id) => ids.has(id),
    retry: (id) => calls.push(`retry:${id}`),
    cancel: (id) => {
      calls.push(`stop:${id}`)
    }
  })
  const options = {
    flows: target(new Set(["flow"])),
    workers: target(new Set(["worker"])),
    pick: () => {
      calls.push("pick")
    },
    report: (message: string) => {
      calls.push(message)
    }
  }
  for (const verb of ["retry", "stop"] as const) {
    Command.run(verb, "", options)
    Command.run(verb, "missing", options)
    Command.run(verb, "flow", options)
    Command.run(verb, "worker", options)
  }
  expect(calls).toEqual([
    "pick",
    "Unknown tab: missing",
    "retry:flow",
    "retry:worker",
    "pick",
    "Unknown tab: missing",
    "stop:flow",
    "stop:worker"
  ])
})
