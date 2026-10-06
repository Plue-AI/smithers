import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { CardSchema, LEGACY_CARD_KINDS } from "../src/Cards"

// T-CUT-01's shared ledger replaces a second cut list in follow-up tickets.
const manifest = JSON.parse(readFileSync(new URL("../src/catalog/cuts.json", import.meta.url), "utf8")) as {
  version: number
  deferred: Array<{ id: string; disposition: string; flowNames: string[]; cardKinds: string[]; sourcePaths: string[]; cliGroups?: string[]; legacyCardKinds?: string[] }>
  rows: Array<{ id: string; disposition: string; flowNames: string[]; cardKinds: string[]; sourcePaths: string[] }>
}
const root = new URL("../../../", import.meta.url)

describe("MVP cut manifest", () => {
  it("records the cut kinds without absorbing deferred or replacement kinds", () => {
    expect(manifest.version).toBe(1)
    expect(manifest.rows.flatMap(row => row.cardKinds).sort()).toEqual([
      "admin-health", "agent", "commit", "commit-list", "connect", "grant-confirm", "notifications", "registration", "repository-setup"
    ])
    expect(manifest.rows.every(row => row.disposition === "cut")).toBe(true)
    expect(new Set(manifest.rows.map(row => row.id)).size).toBe(manifest.rows.length)
    const names = manifest.rows.flatMap(row => row.flowNames)
    expect(new Set(names).size).toBe(names.length)
    for (const kept of ["issues", "flows", "admin.devtools", "repo.choose", "billing.plans", "notifications.allow"]) {
      expect(names).not.toContain(kept)
    }
  })

  it("has no remaining cut source paths", () => {
    const paths = manifest.rows.flatMap(row => row.sourcePaths)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.filter(path => existsSync(fileURLToPath(new URL(path, root))))).toEqual([])
  })
})

// Extend C-CUT-01's existing ledger assertions; discovery tests keep their own literal oracle.
describe("MVP deferred manifest", () => {
  it("records the reviewed hidden doors without treating retained cards as cuts", () => {
    expect(manifest.deferred.map(row => [row.id, row.disposition])).toEqual([
      ["billing", "defer"], ["cloud", "defer"], ["multi-repository", "defer"],
      ["repository-import", "hide"], ["triggers", "defer"], ["sync-operations", "hide"],
      ["machine-view", "defer"], ["manual-signals", "defer"], ["in-app-review", "defer"],
      ["maintainer-issue-tools", "defer"], ["tui", "defer"], ["organization-cli", "defer"]
    ])
    expect(manifest.deferred.flatMap(row => row.flowNames).sort()).toEqual([
      "billing.balance", "billing.plans", "billing.upgrade", "billing.portal",
      "cloud.sign-in", "cloud.prompt", "cloud.sign-out",
      "repo.choose", "repo.create", "repo.select", "repo.overview", "repo.update", "repo.tree", "flow.repo.choose",
      "repos.import", "repos.import.retry", "triggers.list", "triggers.register", "triggers.approve",
      "triggers.run", "triggers.resume", "triggers.pause", "sync.ops.show-more",
      "box.facet", "box.services", "box.egress", "box.images", "egress.allow", "egress.session", "runs.signal",
      "prs.review", "review.request", "review.unrequest", "review.since-mine", "review.done", "review.ack", "review.reopen",
      "issue.repro", "issue.poc", "issue.add-flow", "issue.flows"
    ].sort())
    expect(manifest.deferred.flatMap(row => row.cardKinds).sort()).toEqual([
      "balance", "billing-plans", "anonymous-ceiling", "repository-choice", "repo-update",
      "trigger-list", "sync-ops", "environment-images"
    ].sort())
    expect(manifest.deferred.flatMap(row => row.cliGroups ?? []).sort()).toEqual(["org", "triggers", "tui"])
    const cutNames = manifest.rows.flatMap(row => row.flowNames)
    const cutKinds = manifest.rows.flatMap(row => row.cardKinds)
    for (const row of manifest.deferred) {
      for (const name of row.flowNames) expect(cutNames).not.toContain(name)
      for (const kind of row.cardKinds) expect(cutKinds).not.toContain(kind)
      expect(row.sourcePaths.length).toBeGreaterThan(0)
      for (const path of row.sourcePaths) expect(existsSync(fileURLToPath(new URL(path, root))), path).toBe(true)
    }
  })

  it("keeps deferred cards live and replaced repository pickers readable as tombstones", () => {
    const current = CardSchema.options.map(option => option.shape.kind.value)
    for (const kind of manifest.deferred.flatMap(row => row.cardKinds)) {
      expect(current, kind).toContain(kind)
      expect(LEGACY_CARD_KINDS, kind).not.toContain(kind)
    }
    const legacy = manifest.deferred.flatMap(row => row.legacyCardKinds ?? [])
    expect(legacy).toEqual(["workflow-repo"])
    for (const kind of legacy) {
      expect(current).not.toContain(kind)
      expect(LEGACY_CARD_KINDS).toContain(kind)
      expect(CardSchema.parse({ id: "saved-picker", title: "Repository", status: "active",
        createdAt: 1, ordinal: 1, kind, payload: { intent: "create", repos: ["owner/repo"] } }))
        .toMatchObject({ kind: "retired", status: "acted", payload: { was: kind } })
    }
  })

  it("records the removed launch TUI pages while keeping package-local docs", () => {
    expect(manifest.rows.find(row => row.id === "tui-launch-docs")).toEqual({
      id: "tui-launch-docs", disposition: "cut", flowNames: [], cardKinds: [], sourcePaths: [
        "apps/site/src/content/docs/docs/tui/index.mdx", "apps/site/src/content/docs/docs/tui/extend.mdx",
        "apps/site/src/content/docs/docs/tui/commands.mdx", "apps/site/src/content/docs/docs/tui/keys.mdx",
        "apps/site/src/content/docs/docs/tui/cli.mdx", "apps/site/src/content/docs/docs/tui/configuration.mdx",
        "apps/site/src/content/docs/docs/tui/views.mdx"
      ]
    })
    expect(existsSync(fileURLToPath(new URL("apps/tui/docs/README.md", root)))).toBe(true)
  })
})
