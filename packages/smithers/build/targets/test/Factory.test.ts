/**
 * `Smithers.Factory`, `Smithers.Github.Policy`, `Smithers.label`, and the
 * `FactoryProjection` target.
 *
 * The properties that matter: the declaration refuses the shapes RULINGS 21
 * and 23 rule out (a second writer of `main`, an event key or flow id the
 * vocabulary cannot spell, HTML in the summary); the `on` table flattens to
 * rows in declaration order with the sentence each row shows; the projection
 * round-trips; and the target checks by default, writes only when asked,
 * never writes under the lint verb, and carries the loaded declarations the
 * planner fills rather than anything a `PACKAGE.ts` wrote.
 */
import { describe, expect, it } from "vitest"
import * as Factory from "../src/Factory.ts"
import * as Flow from "../src/Flow.ts"
import type * as FlowCatalog from "../src/FlowCatalog.ts"
import * as Home from "../src/Home.ts"
import { Smithers } from "../src/index.ts"
import type * as Input from "../src/Input.ts"
import * as Reference from "../src/Reference.ts"
import * as Target from "../src/Target.ts"
import { plannedCalls } from "./plan.ts"

const describeInput = (input: Input.Declared): string =>
  input._tag === "Glob" ? input.pattern : input._tag === "File" ? input.path : input._tag

const review = Flow.Flow({ flow: "review", summary: "Review the change.", featured: true })
const lint = Flow.Flow({ flow: "lint", summary: "Lint the named files." })

const row = (declaration: Flow.Declaration): FlowCatalog.Row => ({
  id: declaration.flow,
  description: `Describes ${declaration.flow}.`,
  summary: declaration.summary ?? null,
  featured: declaration.featured,
  kind: "mdx",
  path: `flows/${declaration.flow}/flow.mdx`,
  capabilities: ["fs:read:**"],
  model: null,
  modelInvocable: true
})

describe("Smithers.label", () => {
  it("declares a frozen reference to exactly one target", () => {
    const ci = Smithers.label("//:ci")
    expect(ci).toEqual({ _tag: "Label", label: "//:ci" })
    expect(Object.isFrozen(ci)).toBe(true)
    expect(Reference.label("//apps/app:dev")).toEqual({ _tag: "Label", label: "//apps/app:dev" })
    expect(Reference.Label.make({ label: "//packages/smithers/build:targets" }).label).toBe(
      "//packages/smithers/build:targets"
    )
  })

  it("refuses patterns, bare packages, and relative spellings", () => {
    for (const bad of ["//...", "//apps", ":ci", "ci", "//:ci:twice", "//apps/..:ci", "//:", ""]) {
      expect(() => Reference.label(bad), bad).toThrow(/exactly one target|well-formed/)
    }
    expect(() => Reference.label(`//:${"a".repeat(Reference.maximumLabelLength)}`)).toThrow(/exactly one target/)
    expect(() => Reference.label(1 as never)).toThrow(/well-formed string/)
  })
})

describe("Smithers.Github.Policy", () => {
  it("defaults to the third-party posture and accepts ours", () => {
    expect(Smithers.Github.Policy()).toEqual({
      _tag: "GithubPolicy",
      mirror: "pull",
      issues: "read",
      changes: "send-upstream",
      protectedPaths: [],
      reviewerAgents: [],
      agentIssueSources: [],
      maintainers: []
    })
    const ours = Factory.Policy({ mirror: "push", issues: "two-way", changes: "land" })
    expect(ours).toEqual({
      _tag: "GithubPolicy",
      mirror: "push",
      issues: "two-way",
      changes: "land",
      protectedPaths: [],
      reviewerAgents: [],
      agentIssueSources: [],
      maintainers: []
    })
    expect(Object.isFrozen(ours)).toBe(true)
  })

  it("adds repository-relative protected paths and refuses others", () => {
    expect(Factory.Policy({ protectedPaths: ["infra", "deploy/keys"] }).protectedPaths).toEqual([
      "infra",
      "deploy/keys"
    ])
    for (const bad of ["", " infra", "/etc", "a/../b", ".."]) {
      expect(() => Factory.Policy({ protectedPaths: [bad] }), bad).toThrow(/protectedPaths/)
    }
  })

  it("refuses two writers of main: changes land needs mirror push", () => {
    expect(() => Factory.Policy({ changes: "land" })).toThrow(/changes "land" requires mirror "push"/)
    expect(() => Factory.Policy({ mirror: "none", changes: "land" })).toThrow(/mirror "none"/)
    expect(() => Factory.Policy({ mirror: "push", changes: "land" })).not.toThrow()
  })

  it("refuses two writers of main: a pull request merged on GitHub refuses mirror push", () => {
    expect(() => Factory.Policy({ mirror: "push" })).toThrow(/changes "send-upstream" refuses mirror "push"/)
    expect(() => Factory.Policy({ mirror: "pull", issues: "two-way", changes: "send-upstream" })).not.toThrow()
  })

  it("refuses a value outside the vocabulary and an unknown option", () => {
    expect(() => Factory.Policy({ mirror: "push-on-land" as never })).toThrow(/Github.Policy/)
    expect(() => Factory.Policy({ issues: "write" as never })).toThrow(/Github.Policy/)
    expect(() => Factory.Policy({ pushOnLand: true } as never)).toThrow(/unknown option "pushOnLand"/)
  })
})

describe("Smithers.Factory", () => {
  const github = Factory.Policy({ mirror: "push", issues: "two-way", changes: "land" })
  const on = {
    "issue.opened": { flow: "issue", description: "Triage every new issue" },
    "change.landed": ["wiki", "history.fold", "improve.mine"],
    "schedule:0 9 * * 1-5": "review",
    "github.push:main": "history.fold",
    manual: { flow: ["implement", "prototype"] }
  }

  it("declares a frozen, tagged declaration and is callable from the surface with Home beside it", () => {
    const factory = Smithers.Factory({
      summary: "How this repository develops itself.",
      flows: [review, lint],
      on,
      github
    })
    expect(factory._tag).toBe("FactoryDeclaration")
    expect(factory.summary).toBe("How this repository develops itself.")
    expect(factory.flows).toEqual([review, lint])
    expect(factory.on).toEqual(on)
    expect(factory.github).toEqual(github)
    expect(Object.isFrozen(factory)).toBe(true)
    expect(Object.isFrozen(factory.on)).toBe(true)
    expect(Factory.isFactoryDeclaration(factory)).toBe(true)
    expect(Factory.isFactoryDeclaration({ ...factory, _tag: "Factory" })).toBe(false)
    expect(Smithers.Factory.Home).toBe(Home.Home)
    expect(Smithers.isFactoryDeclaration(factory)).toBe(true)
  })

  it("defaults flows, on, and github, and needs only a summary", () => {
    const factory = Factory.Factory({ summary: "Minimal." })
    expect(factory.flows).toEqual([])
    expect(factory.on).toEqual({})
    expect(factory.github).toEqual(Factory.Policy())
  })

  it("refuses a summary that is empty, multi-line, too long, or markup", () => {
    expect(() => Factory.Factory({ summary: "" })).toThrow(/Factory/)
    expect(() => Factory.Factory({ summary: "one\ntwo" })).toThrow(/Factory/)
    expect(() => Factory.Factory({ summary: "x".repeat(Factory.maximumSummaryLength + 1) })).toThrow(/Factory/)
    expect(() => Factory.Factory({ summary: "<b>bold</b>" })).toThrow(/must not contain HTML/)
    expect(() => Factory.Factory({ summary: "a < b and b > c" })).not.toThrow()
  })

  it("refuses flows that are not Smithers.Flow values or name one flow twice", () => {
    expect(() => Factory.Factory({ summary: "S.", flows: [{ flow: "review" }] as never })).toThrow(
      /flows\[0\] must be a Smithers.Flow declaration/
    )
    expect(() => Factory.Factory({ summary: "S.", flows: "review" as never })).toThrow(/must be an array/)
    expect(() => Factory.Factory({ summary: "S.", flows: [review, Flow.Flow({ flow: "review" })] })).toThrow(
      /declares the flow "review" twice/
    )
  })

  it("refuses on keys outside the event vocabulary shape and flow ids discovery could not derive", () => {
    expect(() => Factory.Factory({ summary: "S.", on: { "Issue.Opened": "issue" } })).toThrow(/Factory/)
    expect(() => Factory.Factory({ summary: "S.", on: { "issue opened": "issue" } })).toThrow(/Factory/)
    expect(() => Factory.Factory({ summary: "S.", on: { "issue.opened": "" } })).toThrow(/Factory/)
    expect(() => Factory.Factory({ summary: "S.", on: { "issue.opened": [] } })).toThrow(/Factory/)
    expect(() => Factory.Factory({ summary: "S.", on: { "issue.opened": "../escape" } })).toThrow(/Factory/)
    expect(() => Factory.Factory({ summary: "S.", on: { "issue.opened": { flow: "issue", description: "<i>x</i>" } } }))
      .toThrow(/must not contain HTML/)
    expect(() => Factory.Factory({ summary: "S.", on: ["issue.opened"] as never })).toThrow(/record of event keys/)
    expect(() =>
      Factory.Factory({ summary: "S.", on: { "issue_comment": "assistant", "pull_request.opened": "review" } })
    ).not.toThrow()
    expect(() => Factory.Factory({ summary: "S.", on: { "schedule:*/15 * * * *": "repo.mirror-pull" } })).not.toThrow()
  })

  it("refuses a github value that is not a policy and unknown options", () => {
    expect(() => Factory.Factory({ summary: "S.", github: { mirror: "push" } as never })).toThrow(
      /must be a Smithers.Github.Policy value/
    )
    expect(() => Factory.Factory({ summary: "S.", workflows: {} } as never)).toThrow(/unknown option "workflows"/)
    expect(() => Factory.Factory("S." as never)).toThrow(/plain object/)
  })

  it("flattens the on table to rows in declaration order, carrying each sentence", () => {
    const factory = Factory.Factory({ summary: "S.", on })
    expect(Factory.rules(factory)).toEqual([
      { event: "issue.opened", flow: "issue", description: "Triage every new issue" },
      { event: "change.landed", flow: ["wiki", "history.fold", "improve.mine"] },
      { event: "schedule:0 9 * * 1-5", flow: "review" },
      { event: "github.push:main", flow: "history.fold" },
      { event: "manual", flow: ["implement", "prototype"] }
    ])
  })

  it("renders a stable two-space projection that parses back", () => {
    const factory = Factory.Factory({ summary: "S.", flows: [review, lint], on, github })
    const catalog = [row(review), row(lint)]
    const text = Factory.renderProjection(factory, catalog)
    expect(text.endsWith("\n")).toBe(true)
    const expected = {
      summary: "S.",
      flows: catalog,
      on: Factory.rules(factory),
      github: { mirror: "push", issues: "two-way", changes: "land" }
    }
    expect(text).toBe(`${JSON.stringify(expected, null, 2)}\n`)
    expect(Factory.parseProjection(text)).toEqual(expected)
    expect(Factory.parseProjection("{")).toMatch(/not JSON/)
    expect(Factory.parseProjection(JSON.stringify({ flows: [] }))).toMatch(
      /does not have the .smithers\/factory.json shape/
    )
    expect(Factory.parseProjection(JSON.stringify({ ...expected, github: { mirror: "push-on-land" } }))).toMatch(
      /shape/
    )
  })

  it("projects named reviewer agents", () => {
    const named = Factory.Policy({ reviewerAgents: ["review-bot"] })
    const projected = Factory.parseProjection(
      Factory.renderProjection(Factory.Factory({ summary: "S.", on, github: named }), [])
    )
    expect(typeof projected === "string" ? projected : projected.github).toEqual({
      mirror: "pull",
      issues: "read",
      changes: "send-upstream",
      reviewerAgents: ["review-bot"]
    })
    expect(() => Factory.Policy({ reviewerAgents: [" bot"] })).toThrow(/reviewerAgents/)
  })

  it("projects the agent issue sources the owner allows", () => {
    const allowed = Factory.Policy({ agentIssueSources: ["linear", "trial"] })
    const projected = Factory.parseProjection(
      Factory.renderProjection(Factory.Factory({ summary: "S.", on, github: allowed }), [])
    )
    expect(typeof projected === "string" ? projected : projected.github).toEqual({
      mirror: "pull",
      issues: "read",
      changes: "send-upstream",
      agentIssueSources: ["linear", "trial"]
    })
    expect(() => Factory.Policy({ agentIssueSources: ["email" as never] })).toThrow()
  })

  it("projects the maintainers, the auto-TODO start and the daily budget, and refuses bad values", () => {
    const policy = Factory.Policy({
      maintainers: ["roninjin10"],
      todoSince: "2026-09-29T00:00:00Z",
      dailyTokens: 2_000
    })
    const projected = Factory.parseProjection(
      Factory.renderProjection(Factory.Factory({ summary: "S.", on, github: policy }), [])
    )
    expect(typeof projected === "string" ? projected : projected.github).toEqual({
      mirror: "pull",
      issues: "read",
      changes: "send-upstream",
      maintainers: ["roninjin10"],
      todoSince: "2026-09-29T00:00:00Z",
      dailyTokens: 2_000
    })
    expect(() => Factory.Policy({ maintainers: [""] })).toThrow(/maintainers/)
    expect(() => Factory.Policy({ maintainers: ["fucory "] })).toThrow(/maintainers/)
    expect(() => Factory.Policy({ todoSince: "tomorrow" })).toThrow(/todoSince/)
    expect(() => Factory.Policy({ todoSince: "2026-13-45T00:00:00Z" })).toThrow(/todoSince/)
    expect(() => Factory.Policy({ dailyTokens: 0 })).toThrow(/dailyTokens/)
  })

  it("projects the machine the TODO lanes need, and refuses one no lane could be sized to", () => {
    const factory = Factory.Factory({
      summary: "S.",
      on,
      github,
      machine: { vcpus: 4, memoryMiB: 8192, tools: ["go", "pnpm", "g++"] }
    })
    expect(factory.machine).toEqual({ vcpus: 4, memoryMiB: 8192, tools: ["go", "pnpm", "g++"] })
    expect(Object.isFrozen(factory.machine)).toBe(true)
    const projected = Factory.parseProjection(Factory.renderProjection(factory, []))
    expect(typeof projected === "string" ? projected : projected.machine).toEqual({
      vcpus: 4,
      memoryMiB: 8192,
      tools: ["go", "pnpm", "g++"]
    })
    const bounds = Factory.Factory({ summary: "S.", machine: { vcpus: 1024, memoryMiB: 4 * 1024 * 1024 } })
    expect(bounds.machine).toEqual({ vcpus: 1024, memoryMiB: 4 * 1024 * 1024 })
    expect(Factory.Factory({ summary: "S.", machine: {} }).machine).toEqual({})

    const undeclared = Factory.renderProjection(Factory.Factory({ summary: "S.", on, github }), [])
    expect(undeclared).not.toContain("machine")

    expect(() => Factory.Factory({ summary: "S.", machine: { vcpus: 0 } })).toThrow(/vcpus must be between 1 and 1024/)
    expect(() => Factory.Factory({ summary: "S.", machine: { vcpus: 1025 } })).toThrow(/vcpus/)
    expect(() => Factory.Factory({ summary: "S.", machine: { vcpus: 1.5 } })).toThrow(/Factory machine/)
    expect(() => Factory.Factory({ summary: "S.", machine: { memoryMiB: 0 } })).toThrow(/memoryMiB/)
    expect(() => Factory.Factory({ summary: "S.", machine: { memoryMiB: 4 * 1024 * 1024 + 1 } })).toThrow(/memoryMiB/)
    expect(() => Factory.Factory({ summary: "S.", machine: { tools: ["/bin/sh"] } })).toThrow(/not a tool name/)
    expect(() => Factory.Factory({ summary: "S.", machine: { tools: ["go", "go"] } })).toThrow(/"go" twice/)
    expect(() => Factory.Factory({ summary: "S.", machine: { tools: Array.from({ length: 65 }, (_, i) => `t${i}`) } }))
      .toThrow(/more than 64 tools/)
    expect(() => Factory.Factory({ summary: "S.", machine: { gpus: 1 } as never })).toThrow(/unknown option "gpus"/)
    expect(() => Factory.Factory({ summary: "S.", machine: "big" as never })).toThrow(/must be a plain object/)
  })

  it("projects declared issue views in order and refuses duplicate ids", () => {
    const issueViews = [
      { id: "bugs", title: "Open bugs", state: "open" as const, labels: ["bug", "p1"] },
      { id: "all-done", title: "Done", state: "verified" as const },
      { id: "triage", title: "Triage", labels: ["needs-triage"] }
    ]
    const factory = Factory.Factory({ summary: "S.", on, github, issueViews })
    expect(factory.issueViews).toEqual(issueViews)
    expect(Object.isFrozen(factory.issueViews)).toBe(true)
    const projected = Factory.parseProjection(Factory.renderProjection(factory, []))
    expect(typeof projected === "string" ? projected : projected.issueViews).toEqual(issueViews)
    expect(Factory.renderProjection(Factory.Factory({ summary: "S.", issueViews: [] }), [])).not.toContain("issueViews")
    expect(Factory.renderProjection(Factory.Factory({ summary: "S." }), [])).not.toContain("issueViews")

    const refuse = (views: unknown) => () => Factory.Factory({ summary: "S.", issueViews: views as never })
    expect(refuse([{ id: "bugs", title: "A" }, { id: "bugs", title: "B" }])).toThrow(/view "bugs" twice/)
    expect(refuse("bugs")).toThrow(/must be an array/)
    expect(refuse([{ id: "Bugs", title: "A" }])).toThrow(/issueViews\[0\]/)
    expect(refuse([{ id: "-x", title: "A" }])).toThrow(/issueViews\[0\]/)
    expect(refuse([{ id: "x".repeat(65), title: "A" }])).toThrow(/issueViews\[0\]/)
    expect(refuse([{ id: "x", title: "" }])).toThrow(/issueViews\[0\]/)
    expect(refuse([{ id: "x", title: "<b>A</b>" }])).toThrow(/must not contain HTML/)
    expect(refuse([{ id: "x", title: "A", state: "stale" }])).toThrow(/issueViews\[0\]/)
    expect(refuse([{ id: "x", title: "A", kind: "chat" }])).toThrow(/unknown option "kind"/)
    expect(refuse([{ id: "x", title: "A", labels: [" bug"] }])).toThrow(/not a label name/)
    expect(refuse([{ id: "x", title: "A", labels: [""] }])).toThrow(/not a label name/)
    expect(refuse([{ id: "x", title: "A", labels: ["l".repeat(256)] }])).toThrow(/not a label name/)
    expect(refuse([{ id: "x", title: "A", labels: ["Bug", "bug"] }])).toThrow(/"bug" twice/)
    expect(refuse([{ id: "x", title: "A", labels: Array.from({ length: 17 }, (_, i) => `l${i}`) }]))
      .toThrow(/more than 16 labels/)
    expect(refuse(Array.from({ length: Factory.maximumIssueViews + 1 }, (_, i) => ({ id: `v${i}`, title: "V" }))))
      .toThrow(/more than 32 views/)
    expect(Factory.Factory({
      summary: "S.",
      issueViews: Array.from({ length: Factory.maximumIssueViews }, (_, i) => ({ id: `v${i}`, title: "V" }))
    }).issueViews).toHaveLength(32)
    expect(refuse(["bugs"])).toThrow(/must be a plain object/)
    expect(Factory.parseProjection(JSON.stringify({
      summary: "S.",
      flows: [],
      on: [],
      github: { mirror: "pull", issues: "read", changes: "send-upstream" },
      issueViews: [{ id: "Bad", title: "B" }]
    }))).toMatch(/does not have the .smithers\/factory.json shape/)
  })

  it("projects declared protected paths", () => {
    const guarded = Factory.Policy({ mirror: "push", issues: "two-way", changes: "land", protectedPaths: ["infra"] })
    const projected = Factory.parseProjection(
      Factory.renderProjection(Factory.Factory({ summary: "S.", on, github: guarded }), [])
    )
    expect(typeof projected === "string" ? projected : projected.github).toEqual({
      mirror: "push",
      issues: "two-way",
      changes: "land",
      protectedPaths: ["infra"]
    })
  })
})

describe("FactoryProjection target", () => {
  const factory = Factory.Factory({ summary: "S.", flows: [review] })
  const home = Home.Home({
    blocks: [Home.Prompt({ placeholder: "Change it…" }), Home.Flows(), Home.Markdown({ path: "README.md" })]
  })

  it("checks by default, keys on the declaration, the entries, and both files, and plans one projection", () => {
    const checking = Factory.FactoryProjection({})
    const metadata = Target.metadata(checking)
    expect(metadata.attrs).toEqual({
      root: "flows",
      declaration: ".smithers/FACTORY.ts",
      output: ".smithers/factory.json",
      homeOutput: ".smithers/home.json",
      mode: "check"
    })
    expect(metadata.cacheable).toBe(true)
    expect(metadata.outputs).toEqual({ cwd: ".", paths: [] })
    expect(metadata.inputs.map(describeInput)).toEqual([
      "//flows/**/flow.ts",
      "//flows/**/flow.mdx",
      "//flows/**/SKILL.md",
      "//.smithers/FACTORY.ts",
      "//.smithers/factory.json",
      "//.smithers/home.json"
    ])
    expect(plannedCalls(checking)).toEqual([{
      action: "smithers-build/factory-projection",
      payload: {
        root: "flows",
        output: ".smithers/factory.json",
        homeOutput: ".smithers/home.json",
        mode: "check",
        factory: null,
        home: null
      }
    }])
  })

  it("writes both files when asked and carries the filled declarations into the payload", () => {
    const writing = Factory.FactoryProjection({
      mode: "write",
      root: "//recipes",
      declaration: "FACTORY.ts",
      output: "//meta/factory.json",
      homeOutput: "//meta/home.json",
      factory,
      home
    })
    const written = Target.metadata(writing)
    expect(written.cacheable).toBe(false)
    expect(written.outputs).toEqual({ cwd: ".", paths: ["meta/factory.json", "meta/home.json"] })
    expect(written.inputs.map(describeInput)).toEqual([
      "//recipes/**/flow.ts",
      "//recipes/**/flow.mdx",
      "//recipes/**/SKILL.md",
      "//FACTORY.ts"
    ])
    expect(plannedCalls(writing)).toEqual([{
      action: "smithers-build/factory-projection",
      payload: {
        root: "recipes",
        output: "meta/factory.json",
        homeOutput: "meta/home.json",
        mode: "write",
        factory,
        home
      }
    }])
  })

  it("forces the non-writing view under the lint verb and keeps build as declared", () => {
    const metadata = Target.metadata(Factory.FactoryProjection({ mode: "write" }))
    expect((metadata.forKind("lint").attrs as Factory.Attrs).mode).toBe("check")
    expect((metadata.forKind("build").attrs as Factory.Attrs).mode).toBe("write")
    expect((Target.metadata(Factory.FactoryProjection({})).forKind("lint").attrs as Factory.Attrs).mode).toBe("check")
  })

  it("refuses declarations that are not factory or home values", () => {
    expect(() => Factory.FactoryProjection({ factory: { summary: "S." } as never })).toThrow()
    expect(() => Factory.FactoryProjection({ home: { blocks: [] } as never })).toThrow()
  })
})
