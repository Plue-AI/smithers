/**
 * The bundled implementation flow, end to end, with the model scripted and
 * everything else real: the kernel-guarded filesystem pinned to the root, the
 * grant store that denies `.git/` and `.flows/`, the envelope, the sandbox.
 */
import * as EventSink from "@smthrs/agent/EventSink"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Brief from "../../src/suggest/Brief.ts"
import * as Checklist from "../../src/suggest/Checklist.ts"
import * as SuggestFlow from "../../src/suggest/SuggestFlow.ts"

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

const project = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "smthrs-suggest-flow-"))
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "acme", scripts: { test: "vitest run" } }))
  mkdirSync(join(directory, ".git"))
  writeFileSync(join(directory, ".git", "config"), "[remote \"origin\"]\n\turl = git@github.com:acme/acme.git\n")
  return directory
}

const flowBody = "---\ndescription: Reruns the tests whose inputs changed.\nmodel: openai:gpt-5.6-sol\n---\n\n# Test\n"

const suggestionOf = async (id: string, repository: Checklist.Repository): Promise<Checklist.Suggestion> => {
  for await (const suggestion of Checklist.scan(repository)) if (suggestion.id === id) return suggestion
  throw new Error(`no ${id} suggestion`)
}

const execute = (
  directory: string,
  brief: string,
  script: SuggestFlow.Script,
  events: Array<AgentEvent.AgentEvent> = []
) =>
  Effect.runPromise(
    SuggestFlow.run(brief).pipe(
      Effect.provide(
        SuggestFlow.layerScripted({ root: directory, script }).pipe(
          Layer.provideMerge(
            Layer.succeed(EventSink.EventSink)(EventSink.make({
              emit: (event) => Effect.sync(() => void events.push(event))
            }))
          )
        )
      )
    )
  )

describe("the suggest flow with a scripted model", { timeout: 120_000 }, () => {
  it("hands the agent the brief and the teaching, and writes the flow through the guarded filesystem", async () => {
    root = project()
    const repository = Checklist.repository(root)
    const context = { seat: "openai:gpt-5.6-sol", facts: Checklist.evidence(repository) }
    const suggestion = await suggestionOf("test-target", repository)
    const asked: Array<string> = []
    const events: Array<AgentEvent.AgentEvent> = []
    const result = await execute(root, Brief.suggestion(context, suggestion), (prompt) => {
      asked.push(prompt)
      return [
        `await ctx.call("write", { path: "flows/test-target/flow.mdx", content: ${JSON.stringify(flowBody)} })`,
        SuggestFlow.done({ files: ["flows/test-target/flow.mdx"], command: "smthrs up test-target", notes: "scripted" })
      ].join("\n")
    }, events)

    expect(result).toEqual({
      files: ["flows/test-target/flow.mdx"],
      command: "smthrs up test-target",
      notes: "scripted"
    })
    expect(readFileSync(join(root, "flows", "test-target", "flow.mdx"), "utf8")).toBe(flowBody)
    // The teaching and the brief both reach the model, in that order.
    expect(asked[0]).toContain("# Implementing one suggestion in a Smithers project")
    expect(asked[0]).toContain("# Suggestion `test-target`: A test target that reruns only what changed")
    expect(asked[0]).toContain("Seat for the flow's `model:` line: `openai:gpt-5.6-sol`")
    expect(asked[0]).toContain("- test runner: vitest")
    // The host's judge is real, so the run arms judged discipline and is
    // taught to call jev.
    expect(events.find((event) => event._tag === "discipline-armed")).toMatchObject({ judged: true })
    expect(asked[0]).toContain(`await ctx.call("jev", {`)
  })

  it("refuses a write under .git through the grant store, so the agent cannot commit by hand", async () => {
    root = project()
    const outcomes: Array<string> = []
    const result = await execute(root, "# Suggestion `x`\n\nWrite.", (prompt) => {
      if (outcomes.length === 0) {
        outcomes.push("first")
        return `const r = await ctx.call("write", { path: ".git/HEAD", content: "ref: refs/heads/hacked" });`
      }
      outcomes.push(prompt)
      return SuggestFlow.done({ files: [], command: "smthrs ls", notes: "denied" })
    })

    expect(result.notes).toBe("denied")
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toContain("github.com")
    expect(existsSync(join(root, ".git", "HEAD"))).toBe(false)
  })

  it("refuses a relative root before building anything", async () => {
    const exit = await Effect.runPromiseExit(
      SuggestFlow.run("brief").pipe(Effect.provide(SuggestFlow.layerScripted({ root: "relative", script: () => "" })))
    )

    expect(exit._tag).toBe("Failure")
    expect(String(exit)).toContain("must be an absolute path")
  })

  it("fails a relative root with a tagged refusal naming the root", async () => {
    const root = await Effect.runPromise(
      SuggestFlow.run("brief").pipe(
        Effect.provide(SuggestFlow.layerScripted({ root: "relative", script: () => "" })),
        Effect.map(() => "ran"),
        Effect.catchTag("/suggest/RelativeRoot", (error) => Effect.succeed(error.root))
      )
    )

    expect(root).toBe("relative")
  })

  it("renders a failure as one sentence naming the failure class", () => {
    expect(SuggestFlow.failureMessage({ _tag: "flows/agent/AgentFailed", message: "no answer" })).toBe(
      "AgentFailed: no answer"
    )
    expect(SuggestFlow.failureMessage(new Error("plain"))).toBe("plain")
    expect(SuggestFlow.failureMessage("text")).toBe("text")
  })
})

describe("Brief.followUp", () => {
  it("names the implemented files and the command, and asks for the CI workflow or the target", () => {
    const facts = Checklist.evidence(Checklist.memoryRepository("/repo", { ".github/workflows/ci.yml": "" }))
    const suggestion: Checklist.Suggestion = {
      id: "lint-target",
      title: "Lint",
      why: "why",
      effort: "small",
      followUp: false,
      followUps: [Checklist.followUps.ci, Checklist.followUps.incremental],
      files: []
    }
    const implemented = { files: ["flows/lint-target/flow.mdx"], command: "smthrs up lint-target" }
    const ci = Brief.followUp({ seat: "s:m", facts }, suggestion, implemented, Checklist.followUps.ci)
    const incremental = Brief.followUp({ seat: "s:m", facts }, suggestion, implemented, Checklist.followUps.incremental)

    expect(ci).toContain("# Follow-up on `lint-target`: Run this in CI?")
    expect(ci).toContain("It wrote: `flows/lint-target/flow.mdx`. It runs with `smthrs up lint-target`.")
    expect(ci).toContain(".github/workflows/ci.yml")
    expect(incremental).toContain("Make it incremental")
    expect(incremental).toContain("`PACKAGE.ts` target")
  })
})
