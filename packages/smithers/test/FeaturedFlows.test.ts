/**
 * The featured-flow presentation `ls` folds in from the `flows` rows of
 * `.smithers/factory.json`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as FeaturedFlows from "../src/internal/FeaturedFlows.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const project = (projection?: string): string => {
  const root = mkdtempSync(join(tmpdir(), "smthrs-featured-flows-"))
  roots.push(root)
  if (projection !== undefined) {
    mkdirSync(join(root, ".smithers"), { recursive: true })
    writeFileSync(join(root, ".smithers", "factory.json"), projection)
  }
  return root
}

/** A projection carrying the given catalog rows and an empty Dispatcher table. */
const projection = (flows: ReadonlyArray<unknown>): string =>
  JSON.stringify({
    summary: "How it develops itself.",
    flows,
    on: [],
    github: { mirror: "pull", issues: "read", changes: "send-upstream" }
  })

const row = (id: string, featured: boolean, summary: string | null) => ({
  id,
  description: `Describes ${id}.`,
  summary,
  featured,
  kind: "mdx" as const,
  path: `flows/${id}/flow.mdx`,
  capabilities: [],
  model: null,
  modelInvocable: true
})

const withHome = (root: string, home: string): string => {
  mkdirSync(join(root, ".smithers"), { recursive: true })
  writeFileSync(join(root, ".smithers", "home.json"), home)
  return root
}

const items = [
  { flowId: "alpha", description: "Describes alpha." },
  { flowId: "lint", description: "Describes lint." },
  { flowId: "review", description: "Describes review." }
]

describe("FeaturedFlows.read", () => {
  it("reads a checked-in projection and treats an absent or malformed one as none", () => {
    expect(FeaturedFlows.read(project(projection([row("review", true, "Review it.")])))?.flows.map((flow) => flow.id))
      .toEqual(["review"])
    expect(FeaturedFlows.read(project())).toBeUndefined()
    expect(FeaturedFlows.read(project("{"))).toBeUndefined()
    expect(FeaturedFlows.read(project(projection([{ id: "review" }])))).toBeUndefined()
    expect(FeaturedFlows.read(project(JSON.stringify({ flows: [row("review", true, "Review it.")] })))).toBeUndefined()
  })
})

describe("FeaturedFlows.present", () => {
  it("lists the page unchanged without a catalog", () => {
    expect(FeaturedFlows.present(items, undefined)).toBe(items)
  })

  it("leads with the featured flows in catalog order and decorates only what the catalog declares", () => {
    const catalog = {
      flows: [
        row("review", true, "Review it."),
        row("lint", true, null),
        row("alpha", false, "Alpha summary."),
        row("ghost", true, "Names no listed flow.")
      ]
    }
    expect(FeaturedFlows.present(items, catalog)).toEqual([
      { flowId: "review", description: "Describes review.", featured: true, summary: "Review it." },
      { flowId: "lint", description: "Describes lint.", featured: true },
      { flowId: "alpha", description: "Describes alpha.", summary: "Alpha summary." }
    ])
  })
})

describe("FeaturedFlows.human", () => {
  it("stars featured rows and prefers the summary over the description", () => {
    const listed = FeaturedFlows.present(items, {
      flows: [row("review", true, "Review it."), row("alpha", false, null)]
    })
    expect(FeaturedFlows.human(listed)).toBe(
      "* review  Review it.\n" +
        "  alpha   Describes alpha.\n" +
        "  lint    Describes lint.\n"
    )
    expect(FeaturedFlows.human([])).toBe("No flows discovered under flows/.\n")
  })

  it("recognizes only a flow page whose items carry an id and a description", () => {
    expect(FeaturedFlows.isFlowPage({ _tag: "flows", items })).toBe(true)
    expect(FeaturedFlows.isFlowPage({ _tag: "flows", items: [{ flowId: 1 }] })).toBe(false)
    expect(FeaturedFlows.isFlowPage({ _tag: "runs", items: [] })).toBe(false)
    expect(FeaturedFlows.isFlowPage(null)).toBe(false)
  })
})

describe("FeaturedFlows.apps", () => {
  it("reads the homepage's app blocks and treats an absent or malformed homepage as none", () => {
    const home = JSON.stringify({
      blocks: [
        { type: "prompt", title: "What should we work on?" },
        { type: "app", flow: "issue.implement", title: "Fix an issue", picture: "issue" },
        { type: "app", flow: "review", title: "Review a PR", picture: "review" }
      ]
    })
    expect(FeaturedFlows.apps(withHome(project(), home))).toEqual([
      { flow: "issue.implement", title: "Fix an issue", picture: "issue" },
      { flow: "review", title: "Review a PR", picture: "review" }
    ])
    expect(FeaturedFlows.apps(project())).toEqual([])
    expect(FeaturedFlows.apps(withHome(project(), "{"))).toEqual([])
    expect(FeaturedFlows.apps(withHome(project(), JSON.stringify({ blocks: [{ type: "app", flow: "review" }] }))))
      .toEqual([])
    expect(
      FeaturedFlows.appsOf({
        _tag: "flows",
        items: [],
        apps: [{ flow: "review", title: "Review a PR", picture: "review" }, { flow: 1 }]
      })
    )
      .toEqual([{ flow: "review", title: "Review a PR", picture: "review" }])
    expect(FeaturedFlows.appsOf({ _tag: "flows", items: [] })).toEqual([])
  })

  it("lists the apps after the flows, one line each", () => {
    const apps = [{ flow: "issue.implement", title: "Fix an issue", picture: "issue" }, {
      flow: "review",
      title: "Review a PR",
      picture: "review"
    }]
    expect(FeaturedFlows.human(items, apps)).toBe(
      "  alpha   Describes alpha.\n  lint    Describes lint.\n  review  Describes review.\napps:\n  Fix an issue  issue.implement\n  Review a PR   review\n"
    )
    expect(FeaturedFlows.human(items, [])).toBe(FeaturedFlows.human(items))
    expect(FeaturedFlows.human([], apps)).toBe(
      "No flows discovered under flows/.\napps:\n  Fix an issue  issue.implement\n  Review a PR   review\n"
    )
  })
})
