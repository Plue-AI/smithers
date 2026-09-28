import { describe, expect, test } from "vitest"
import graphFixture from "../fixtures/force/graph.json" with { type: "json" }
import planFixture from "../fixtures/force/plan-typeCheck.json" with { type: "json" }
import { criticalPath, reachable } from "../src/TargetGraph.ts"
import {
  CliGraphEnvelopeSchema,
  CliPlanEnvelopeSchema,
  isPrivateLabel,
  mergePlanFacts,
  targetGraphFromCli
} from "../src/TargetGraphCli.ts"

/*
 * The captured force workspace (packages/rpc/fixtures/force/): 82 targets,
 * 94 edges. This is the dev fixture stream's read of the CLI envelope, so
 * the counts pin it end to end. The backend's own reader is held to the same
 * answer by apps/app/src/bun/TargetGraph.test.ts ("the backend's text parse
 * and the CLI envelope adapter agree").
 */

const graph = targetGraphFromCli(CliGraphEnvelopeSchema.parse(graphFixture), { repoId: "force" })

describe("public CLI plan facts", () => {
  const loaded = targetGraphFromCli(
    CliGraphEnvelopeSchema.parse({
      pattern: "//unit:*",
      format: "json",
      graph: "//unit:check\n  -data-> //unit:build",
      roots: ["//unit:check"],
      targets: [
        { label: "//unit:check", target: "Shell.Test" },
        { label: "//unit:build", target: "Shell.Build" }
      ],
      edges: [{ from: "//unit:check", to: "//unit:build", kind: "data" }],
      warnings: ["Optional compiler unavailable"]
    }),
    { repoId: "unit", generatedAt: "2026-09-28T12:00:00Z", durationMs: 7 }
  )

  test("a minimal fact changes the rule without fabricating optional plan facts", () => {
    const plan = CliPlanEnvelopeSchema.parse({
      verb: "plan",
      pattern: "//unit:check",
      roots: ["//unit:check"],
      targets: [{ label: "//unit:check", rule: "Custom.Check" }]
    })
    expect(plan.targets).toEqual([{ label: "//unit:check", rule: "Custom.Check", dependencies: [] }])
    const before = structuredClone(loaded)
    const planBefore = structuredClone(plan)
    expect(mergePlanFacts(loaded, plan)).toEqual({
      repoId: "unit",
      nodes: [
        {
          label: "//unit:check",
          package: "//unit",
          name: "check",
          rule: "Custom.Check",
          kinds: [],
          private: false,
          plan: {}
        },
        { label: "//unit:build", package: "//unit", name: "build", rule: "Shell.Build", kinds: [], private: false }
      ],
      edges: [{ from: "//unit:check", to: "//unit:build", kind: "data" }],
      warnings: ["Optional compiler unavailable"],
      generatedAt: "2026-09-28T12:00:00Z",
      durationMs: 7
    })
    expect(loaded).toEqual(before)
    expect(plan).toEqual(planBefore)
  })

  test.each(["check", "write"] as const)(
    "%s plan facts retain refusal, sandbox, outputs and explicit empty values",
    (mode) => {
      const plan = CliPlanEnvelopeSchema.parse({
        verb: "plan",
        pattern: "//unit:check",
        roots: ["//unit:check"],
        targets: [{
          label: "//unit:check",
          rule: "Custom.Check",
          mode,
          key: "",
          cacheable: false,
          dependencies: ["//unit:build"],
          argv: [],
          refusal: "Compiler unavailable",
          sandbox: "isolated",
          outDirs: ["dist"],
          outFiles: ["check.json"]
        }]
      })
      const before = structuredClone(loaded)
      const planBefore = structuredClone(plan)
      const merged = mergePlanFacts(loaded, plan)
      expect(merged.nodes[0]).toEqual({
        label: "//unit:check",
        package: "//unit",
        name: "check",
        rule: "Custom.Check",
        kinds: [],
        private: false,
        plan: {
          mode,
          key: "",
          cacheable: false,
          argv: [],
          refusal: "Compiler unavailable",
          sandbox: "isolated",
          outDirs: ["dist"],
          outFiles: ["check.json"]
        }
      })
      expect(merged.nodes[1]).toEqual({
        label: "//unit:build",
        package: "//unit",
        name: "build",
        rule: "Shell.Build",
        kinds: [],
        private: false
      })
      expect(merged.edges).toEqual([{ from: "//unit:check", to: "//unit:build", kind: "data" }])
      expect(merged.warnings).toEqual(["Optional compiler unavailable"])
      expect(loaded).toEqual(before)
      expect(plan).toEqual(planBefore)
    }
  )
})

describe("the force CLI graph envelope as a TargetGraphResponse", () => {
  test("parses 82 nodes and 94 edges", () => {
    expect(graph.nodes.length).toBe(82)
    expect(graph.edges.length).toBe(94)
  })

  test("every node splits into package and name, rule from the loader row", () => {
    const typeCheck = graph.nodes.find((node) => node.label === "//src:typeCheck")
    expect(typeCheck?.package).toBe("//src")
    expect(typeCheck?.name).toBe("typeCheck")
    expect(typeCheck?.rule).toBe("Shell.Test")
    const ci = graph.nodes.find((node) => node.label === "//.github:ci")
    expect(ci?.rule).toBe("Github.Workflow")
  })

  test("edge kinds are the classified set (data, gates, services)", () => {
    const kinds = new Set(graph.edges.map((edge) => edge.kind))
    expect([...kinds].sort()).toEqual(["data", "gates", "services"])
  })

  test("reachable answers deps and rdeps for focus", () => {
    const deps = reachable(graph.edges, "//:prePush", "deps")
    expect(deps.has("//src:lint")).toBe(true)
    expect(deps.has("//src:typeCheck")).toBe(true)
    expect(deps.has("//src:test")).toBe(true)
    expect(deps.has("//src:agentLints")).toBe(true)
    const rdeps = reachable(graph.edges, "//src:typeCheck", "rdeps")
    expect(rdeps.has("//:prePush")).toBe(true)
    expect(rdeps.has("//:preCommit")).toBe(true)
    expect(rdeps.has("//src:typeCheck")).toBe(false)
  })

  test("the plan envelope merges rule, key, argv, and cacheability onto its nodes", () => {
    const merged = mergePlanFacts(graph, CliPlanEnvelopeSchema.parse(planFixture))
    const typeCheck = merged.nodes.find((node) => node.label === "//src:typeCheck")
    expect(typeCheck?.plan?.mode).toBe("execute")
    expect(typeCheck?.plan?.cacheable).toBe(true)
    expect(typeCheck?.plan?.key).toMatch(/^83972035/)
    expect(typeCheck?.plan?.argv?.[0]).toContain("tsc")
    const relay = merged.nodes.find((node) => node.label === "//src:relayArtifacts")
    expect(relay?.rule).toBe("Shell.Build")
    // Nodes the plan never names keep the loader row untouched.
    const ci = merged.nodes.find((node) => node.label === "//.github:ci")
    expect(ci?.plan).toBeUndefined()
  })

  test("a private helper is the generated `__private_` label, not any `__` name", () => {
    expect(isPrivateLabel("//src:__private_Overlay_4")).toBe(true)
    expect(isPrivateLabel("//src:typeCheck")).toBe(false)
    /*
     * The only private form the build system emits is
     * `//<package>:__private_<Rule>_<n>` (build-cli internal/PackagePlanner
     * `labelOf`). A declared key named `__helper` is addressable, and the
     * backend's reader has always called it public; reading a bare `__`
     * prefix as private hid it from the graph card on one path only.
     */
    expect(isPrivateLabel("//src:__helper")).toBe(false)
    expect(isPrivateLabel("//src:not__private_x")).toBe(false)
  })

  test("criticalPath is pure over the same edges the UI renders", () => {
    const path = criticalPath(
      [
        { label: "//:prePush", status: "ran", durationMs: 10 },
        { label: "//src:lint", status: "ran", durationMs: 30 },
        { label: "//src:test", status: "ran", durationMs: 5 }
      ],
      graph.edges
    )
    expect(path).toEqual(["//src:lint", "//:prePush"])
  })
})
