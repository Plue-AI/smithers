import { describe, expect, it } from "@effect/vitest"
import { Action } from "@smthrs/flow"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const actionDir = fileURLToPath(new URL("../src/Action/", import.meta.url))

const errors = [
  "AttemptTimedOut",
  "ConcurrentKeylessDispatch",
  "DuplicateImplementation",
  "ImplementationVersionMismatch",
  "InfraInterrupt",
  "InfraInterruptRetriesExhausted",
  "IrreversibleRetryRequiresIdempotencyKey",
  "UncanonicalIdempotencyKey"
] as const

describe("Action error modules", () => {
  it.each(errors)("%s lives in its own module and is re-exported by the barrel", async (name) => {
    const module = await import(`../src/Action/${name}.ts`)
    expect(Object.keys(module)).toEqual([name])
    expect(module[name]).toBe(Action[name])
  })

  it("keeps one tagged error per file", () => {
    for (const file of readdirSync(actionDir).filter((file) => file.endsWith(".ts"))) {
      const source = readFileSync(`${actionDir}${file}`, "utf8")
      const count = source.match(/Schema\.TaggedError</g)?.length ?? 0
      expect(count, file).toBeLessThanOrEqual(1)
    }
  })
})
