import { describe, expect, it } from "vitest"
import * as CellPrompt from "../src/internal/cellPrompt.ts"
import * as DemandText from "../src/internal/demandText.ts"

const contract = () => CellPrompt.make({}).find((section) => section.id === "cell-contract")!.text

describe("completion teaching across task kinds", () => {
  it("finishes conversational and read-only answers without requiring invented work", () => {
    // The live chat request "Reply with only the letter A" printed A six
    // times, then looked for a failing test instead of completing its answer.
    const text = contract()
    expect(text).toContain("Conversational or read-only request: `ctx.done(answer)` directly")
    expect(text).toContain("no edit, command, baseline or tree review")
    expect(text).toContain("`console.log` alone does not finish")
  })

  it("scopes edit and proof rules to requested workspace changes while retaining their safeguards", () => {
    const text = contract()
    expect(text).toContain("Workspace change: finish behind the deciding check")
    expect(text).toContain("8. Workspace change: read broadly in ONE cell, then edit")
    expect(text).toContain("9. Bug-fix proof, fewest frames")
    expect(text).toContain("if (before.exitCode !== 0 && after.exitCode === 0) ctx.done(")
    expect(text).toContain("`git status --porcelain` and `git diff` in the completing cell")
    expect(text).toContain("NEVER undo your own edit to re-prove a baseline")
  })

  it("allows an already answerable request to finish at the read-only notice without weakening edit evidence or the cap", () => {
    const notice = DemandText.readOnly(6, 6)
    expect(notice).toContain("If the current request is already answered, call ctx.done(answer) now")
    expect(notice).toContain("A conversational or read-only answer needs no invented edit or command")
    expect(notice).toContain("If a workspace change is still required")
    expect(notice).toContain("the file, the change, and the check you have watched fail that will now pass")
    expect(notice).toContain("ctx.justify(")
    expect(notice).toContain("Do not write something merely to answer this notice")
    expect(notice).toContain("At 12 consecutive read-only frames the run stops as a failure")
    expect(notice).not.toContain("The next cell must do one of two things")
    expect(notice).not.toContain("frames remain in which to commit to a change")
  })
})
