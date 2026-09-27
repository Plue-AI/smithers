import * as Audience from "@smthrs/build-cli/Audience"
import type { ControlSchema } from "@smthrs/control"
import { afterEach, expect, it, vi } from "vitest"
import * as Bridge from "../src/cli/ControlBridge.ts"
import { createRunsCli } from "../src/cli/ControlCommands.ts"

afterEach(() => vi.restoreAllMocks())
it("bounds agent log pulls, closes the iterator, and retains the connection in its next-page command", async () => {
  let consumed = 0
  let closed = false
  vi.spyOn(Bridge, "hasRecords").mockReturnValue(true)
  vi.spyOn(Bridge, "events").mockImplementation(() =>
    (async function*() {
      try {
        for (let sequence = 1; sequence <= 101; sequence++) {
          consumed++
          yield {
            sequence,
            occurredAt: sequence,
            kind: "control.agent.cell-printed",
            runId: "run-one",
            payload: { text: "event" }
          } satisfies ControlSchema.ControlEvent
        }
      } finally {
        closed = true
      }
    })()
  )
  let stdout = ""
  let code = 0
  await createRunsCli({ presentation: Audience.resolve({ audience: "agent", env: {} }) }).serve([
    "logs",
    "run-one",
    "--root",
    "/fixture",
    "--format",
    "jsonl"
  ], {
    stdout: (text) => {
      stdout += text
    },
    exit: (status) => {
      code = status
    }
  })
  expect(code).toBe(0)
  expect(consumed).toBe(100)
  expect(closed).toBe(true)
  const lines = stdout.trim().split("\n").map((line) => JSON.parse(line))
  expect(lines.filter((line) => line.type === "chunk")).toHaveLength(100)
  expect(JSON.stringify(lines.at(-1))).toContain("--after 100")
  expect(JSON.stringify(lines.at(-1))).toContain("--root /fixture")
})
