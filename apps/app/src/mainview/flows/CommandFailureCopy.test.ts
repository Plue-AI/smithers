import { describe, expect, test } from "bun:test"
import { Authorize } from "@smthrs/chain"
import { HarnessError, type HarnessErrorCode } from "@smthrs/harness/HarnessError"
import { commandFailureSentence } from "./CommandFailureCopy"
import { runCause } from "../state/RunCause"

const RAW = "stack at Cell.run (Cell.ts:412)"
const HARNESS_CODES: ReadonlyArray<HarnessErrorCode> = [
  "assembly_failed", "incompatible_journal", "render_failed", "model_failed", "engine_failed",
  "read_only_cap", "completion_unjudged", "claim_unproven", "suspended"
]

describe("a command that failed before its flow answered", () => {
  test("every harness code reads as its written sentence, never the harness's message", () => {
    for (const code of HARNESS_CODES) {
      const sentence = commandFailureSentence("issues.list", new HarnessError({ code, message: RAW }))
      expect(sentence).not.toContain("Cell.ts")
      expect(sentence).toBe(code === "suspended" ? "/issues.list is waiting for permission." : runCause(`/harness/HarnessError/${code}`)!)
    }
  })

  test("each authorization refusal names the command and never the capability pattern", () => {
    const refused = (code: "denied" | "approval_required" | "authorize_unavailable") =>
      commandFailureSentence("box.delete", new Authorize.AuthorizeError({ code, message: `"box.delete" needs approval for fs:write:/**` }))
    expect(refused("denied")).toBe("Smithers isn't allowed to run /box.delete here.")
    expect(refused("approval_required")).toBe("/box.delete needs your approval first.")
    expect(refused("authorize_unavailable")).toBe("Smithers couldn't check whether it may run /box.delete. Not your fault.")
    for (const code of ["denied", "approval_required", "authorize_unavailable"] as const) expect(refused(code)).not.toContain("fs:write")
  })

  test("an untagged error gets the generic sentence and is reported, not printed", () => {
    const reported: Array<unknown> = []
    const error = new Error(RAW)
    expect(commandFailureSentence("issues.list", error, e => reported.push(e))).toBe("/issues.list failed. Not your fault.")
    expect(reported).toEqual([error])
  })
})
