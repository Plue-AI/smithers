import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import { Effect, Schema, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestContext } from "node:test"
import { templates, TemplateState } from "../release-content/jev-template.ts"
import type { Analysis, Draft, Evidence } from "../release-support/schema.ts"

export const evidence: Evidence = {
  version: "1.0.0-rc.1",
  currentVersion: "1.0.0-rc.1",
  sourceSha: "a".repeat(40),
  from: "b".repeat(40),
  date: "2026-09-06",
  commits: `${"c".repeat(40)} fix: resume approval`,
  changes: "src/approval.ts",
  documents: "HumanTask resumes approvals after restart.",
  sources: ["README.md"],
  recordings: []
}
export const analysis: Analysis = {
  title: "Resume release approvals",
  summary: "Release approvals survive restarts.",
  highlights: ["Resume approval after restart"],
  risks: [],
  migration: [],
  claims: [{ id: "approval", text: "Approvals resume after restart", sources: ["README.md"] }]
}
export const outline = { angle: "Durable approvals", outline: ["Resume an approval"] }
/** Jev's narrative beside the writer's outline, the way the flow assembles it. */
export const brief = { template: "reliability report", ...outline }
/** One offline judge dispatches narrative and completion questions. Narrative
 * selection reads the supplied ledger and evidence; completion reads its own
 * recorded work through the limited completion fixture. */
export const scriptedTemplate = Evaluator.layerScripted((request) => {
  if (Object.keys(request.questions).length === 1 && "template" in request.questions) {
    const state = Schema.decodeUnknownSync(TemplateState)(request.state)
    const prose = `${state.ledger} ${state.evidence}`.toLowerCase()
    const template = /migration|breaking|removed/.test(prose) ?
      "migration guide"
      : /fix|restart|durab|approval/.test(prose) ?
      "reliability report"
      : /feature|new capability/.test(prose)
      ? "feature deep dive"
      : "release roundup"
    return {
      template: {
        choice: template,
        probabilities: Object.fromEntries(templates.map((name) => [name, name === template ? 0.95 : 0.05 / 3]))
      }
    }
  }
  return Effect.flatMap(Evaluator.Evaluator, (judge) => judge.evaluate(request)).pipe(
    Effect.provide(ScriptedJudge.layer),
    Effect.map((result) => result.answers)
  )
})
export const copy = { text: "Release approvals resume after a process restart.", claimIds: ["approval"] }
export const draft: Draft = { changelog: copy, blog: copy, thread: { tweets: [copy] } }
export const review = { passed: true, score: 0.95, feedback: [] }

export const repository = async (test: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-release-flow-"))
  test.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Release workflow test")
  git("config", "user.email", "release-test@example.invalid")
  await writeFile(join(root, ".gitignore"), ".flows/\n")
  await mkdir(join(root, "packages/smithers"), { recursive: true })
  await writeFile(
    join(root, "packages/smithers/package.json"),
    JSON.stringify({ name: "@smthrs/cli", version: evidence.version })
  )
  await writeFile(join(root, "README.md"), "# Smithers\nDurable release approvals.\n")
  git("add", ".")
  git("commit", "-m", "fixture")
  git("tag", "v0.35.0")
  const sourceSha = git("rev-parse", "HEAD")
  return { root, git, evidence: { ...evidence, sourceSha } }
}

/** Real AgentAction/QuickJS loop; only the provider stream is scripted. */
export const scriptedSeats = (
  counts: Record<string, number>,
  options: { failReviews?: number; allChannels?: boolean; prompts?: string[] } = {}
) => {
  const model = Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        const asked = [
          ...request.system.map((part) => part.text),
          ...request.messages.flatMap((message) =>
            message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
          )
        ].join("\n")
        options.prompts?.push(asked)
        let stage: string
        let output: unknown
        if (asked.includes("Analyze this release.")) {
          stage = "analyze"
          output = analysis
        } else if (asked.includes("this release calls for")) {
          stage = "outline-template"
          output = outline
        } else if (asked.includes("Draft the user-facing changelog")) {
          stage = "changelog"
          output = copy
        } else if (asked.includes("Draft an X thread")) {
          stage = "thread"
          output = draft.thread
        } else if (asked.includes("Outline a technical release blog")) {
          stage = "outline"
          output = brief
        } else if (asked.includes("Write the release blog")) {
          stage = "blog"
          output = copy
        } else if (asked.includes("Independently review the release materials")) {
          stage = "score"
          const fail = (counts.score ?? 0) < (options.failReviews ?? 0)
          output = fail ? { passed: false, score: 0.4, feedback: ["Explain restart behavior"] } : review
        } else if (asked.includes("Revise every enabled channel")) {
          stage = "revise"
          output = options.allChannels
            ? draft
            : { changelog: copy, blog: { text: "", claimIds: [] }, thread: { tweets: [] } }
        } else if (asked.includes("Identify any undocumented")) {
          stage = "audit"
          output = { passed: true, missing: [], explanation: "The supplied docs cover the changes." }
        } else throw new Error(`Unexpected agent task: ${asked.slice(0, 200)}`)
        counts[stage] = (counts[stage] ?? 0) + 1
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: "cell",
            text: `\`\`\`cell\nctx.done(${JSON.stringify(output)})\n\`\`\``
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
  return SeatResolver.layer({
    resolve: (id) =>
      Effect.succeed(Seat.make({
        id,
        modelId: "scripted-release",
        model,
        contextWindowTokens: 200_000,
        route: {
          prepare: () =>
            Effect.succeed({
              routeId: "release-test",
              protocolId: "release-test",
              method: "POST",
              url: "https://example.invalid",
              publicHeaders: {},
              body: new TextEncoder().encode("{}"),
              bodyText: "{}"
            })
        }
      }))
  })
}
