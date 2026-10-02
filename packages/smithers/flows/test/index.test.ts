import * as FlowPackage from "@smthrs/flow"
import * as Effect from "effect/Effect"
import { readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { readWorkspaceInventory } from "../../../../scripts/readWorkspaceInventory.ts"
import * as Flows from "../src/index.ts"

/**
 * The expected namespace list is derived from each package's declared
 * `smthrs.group`, never hardcoded (issue #161). Not every package in the
 * monorepo belongs in the durable-engine barrel: the agent layer is a separate
 * release surface built on the engine, and build-tool packages have their own
 * public surfaces. Adding an engine package, however, fails this test until
 * `src/index.ts` re-exports it. A missing or unknown group fails closed below
 * rather than silently excluding a new package.
 */
const umbrellaRoot = resolve(import.meta.dirname, "..")
const inventory = readWorkspaceInventory(resolve(umbrellaRoot, "../../.."))
const packageGroups = ["engine", "agent", "tooling"] as const
type PackageGroup = typeof packageGroups[number]
const isPackageGroup = (value: unknown): value is PackageGroup => packageGroups.some((group) => group === value)
const isFile = (path: string) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
// Directory name → exported namespace name, the convention src/index.ts uses:
// kebab-case to PascalCase (engine-store → EngineStore, time-travel →
// TimeTravel).
//
// Three kinds of package are NOT re-exported and so are excluded here: the
// barrel itself (`flows`), the `platform-*` bundles, and packages outside the
// engine group. A platform bundle is chosen by the program that runs, not by
// the library it depends on — the same reason `effect`'s index does not
// re-export `@effect/platform-node` — and re-exporting all three would make one
// import resolve `node:child_process`, ZenFS, and Bun at once.
//
// The agent group is a separate release surface built on the engine; this
// barrel gathers the durable engine only. The tooling group is excluded for
// the same class of reason, decided in review when smithers build was absorbed into
// this repo (2026-08-15). It is the legacy declaration build system — `@smthrs/build`
// (install/package-manager actions), `@smthrs/targets` (legacy declaration rules), and
// `@smthrs/build-cli` (the `smithers-build` binary) — not part of the durable flow engine
// surface this barrel exists to gather.
// Re-exporting them would also break two invariants the barrel holds today:
// `@smthrs/targets` and `@smthrs/build-cli` are `private: true` and never published, so
// the published `@smthrs/flows` would depend on packages no consumer can
// resolve; and `@smthrs/build-cli` pulls `@effect/platform-node`, which would drag
// `node:child_process` into the barrel that `pnpm browser` asserts is
// browser-safe. Reach them through their own packages.
// A package is named by its own directory, which is its path's last segment: a
// granular package can sit inside the product package it belongs to, and
// `packages/smithers/flows/canonical` is `@smthrs/canonical` exporting `Canonical`.
const leaf = (directory: string) => directory.slice(directory.lastIndexOf("/") + 1)
const namespaceName = (directory: string) =>
  leaf(directory)
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
const isPlatformBundle = (name: string) => leaf(name).startsWith("platform-")
const packageNames = inventory.manifests.map(({ name }) => name)
const packageManifests = inventory.manifests.map(({ name, path: manifestPath, manifest }) => {
  const group = manifest.smthrs?.group
  if (!isPackageGroup(group)) {
    throw new Error(
      `${manifestPath}: smthrs.group must be one of ${packageGroups.join(", ")}; received ${JSON.stringify(group)}`
    )
  }
  return { name, group }
})
const packageNamesForGroup = (group: PackageGroup) =>
  packageManifests.filter((manifest) => manifest.group === group).map((manifest) => manifest.name)
const enginePackageNames = packageNamesForGroup("engine")
const namespacedEnginePackageNames = enginePackageNames
  .filter((name) => leaf(name) !== "flows" && leaf(name) !== "flow" && !isPlatformBundle(name))
// `@smthrs/flow` is the one package re-exported FLAT rather than as a single
// namespace: writing a flow is the point of the library, so `Flow`,
// `Action`, `RetryPolicy`, and their siblings sit at the top level. Its
// contribution is therefore derived from the package's own exports, not from
// its directory name — a new authoring namespace there fails this test until
// the barrel re-exports it, exactly as a new package does.
const expected = [
  ...new Set([
    ...namespacedEnginePackageNames.map(namespaceName),
    ...Object.keys(FlowPackage)
  ])
].sort()

describe("barrel", () => {
  it("keeps the flat authoring names disjoint from the engine namespaces", () => {
    // `src/index.ts` pairs `export * from "@smthrs/flow"` with the `export * as
    // X` namespaces, and an explicit named export SHADOWS a star export. So if
    // `@smthrs/flow` ever exported a name an engine package already claims —
    // `Plan`, `Artifacts`, `Sandbox` and `Journal` are all plausible authoring
    // names — the flat export would vanish from the barrel with no error. The
    // `Set` below would hide exactly that: both sources contribute the same
    // string, the expected universe is unchanged, and every assertion stays
    // green while a public export disappears. This is the assertion that
    // catches it; the `Set` only keeps the sorted comparison well-formed.
    expect(namespacedEnginePackageNames.map(namespaceName).filter((name) => name in FlowPackage)).toEqual([])
  })

  it("ships no unsupported Cloudflare durable-runtime subpath", () => {
    expect(isFile(join(umbrellaRoot, "src", "CloudflareRuntime.ts"))).toBe(false)
    const manifest = JSON.parse(readFileSync(join(umbrellaRoot, "package.json"), "utf8"))
    for (const exports of [manifest.exports, manifest.publishConfig.exports]) {
      expect(exports["./CloudflareRuntime"]).toBeUndefined()
      expect(Object.entries(exports).filter(([key, target]) => key.includes("*") && target !== null)).toEqual([])
    }
  })

  it("derives a non-trivial universe from the barrel manifest", () => {
    // Guard the derivation itself: an empty or near-empty universe would make
    // every assertion below vacuously green.
    expect(expected.length).toBeGreaterThanOrEqual(10)
    expect(expected).toContain("EngineStore")
    expect(expected).toContain("TimeTravel")
    // the flat authoring re-export is part of the universe too
    expect(expected).toContain("Flow")
    expect(expected).toContain("Action")
  })

  it("excludes the platform bundles, and there are some to exclude", () => {
    // Guard the exclusion the same way: if `platform-*` ever stopped matching,
    // the filter would silently become a no-op instead of a decision.
    expect(packageNames.filter(isPlatformBundle).length).toBeGreaterThanOrEqual(3)
    expect(enginePackageNames.filter(isPlatformBundle).length).toBeGreaterThanOrEqual(3)
    expect(namespacedEnginePackageNames.filter(isPlatformBundle)).toEqual([])
    expect(expected.filter((name) => name.startsWith("Platform"))).toEqual([])
  })

  it("excludes the separate agent release surface", () => {
    // Guard the group decision itself: an empty agent group would make its
    // exclusion vacuous instead of proving the boundary is represented.
    expect(packageNamesForGroup("agent").length).toBeGreaterThan(0)
  })

  it("excludes the smithers-build build tooling, and there is some to exclude", () => {
    // Same guard as the platform bundles above: the tooling group must remain
    // represented rather than turning its exclusion into a silent no-op.
    // `build/infra` is the hosted cache Worker that ships inside
    // `smithers-build`; it is a member nested under `packages/smithers/build`, and the
    // universe descends now, so it is named here like every other tooling
    // package. The private repo-targets package owns repository policy macros.
    expect(packageNamesForGroup("tooling").sort()).toEqual([
      "repo-targets",
      "rpc",
      "smithers/build",
      "smithers/build/build-cli",
      "smithers/build/infra",
      "smithers/build/targets"
    ])
    expect(expected.filter((name) => name.startsWith("Build"))).toEqual([])
  })

  it("re-exports every engine package as a namespace", () => {
    // `namespaces` is the barrel's one runtime value (issue #169) — the
    // executable statement that gives the coverage gate a non-empty
    // denominator. Everything else is a namespace re-export.
    expect(Object.keys(Flows).sort()).toEqual([...expected, "namespaces"].sort())
  })

  it("pins the runtime namespace list to the derived universe (issue #169)", () => {
    expect([...Flows.namespaces].sort()).toEqual(expected)
  })

  it.each(expected.map((name) => ({ name })))("$name namespace is populated", ({ name }) => {
    const namespace = (Flows as Record<string, object>)[name]
    expect(namespace).toBeDefined()
    expect(Object.keys(namespace ?? {}).length).toBeGreaterThan(0)
  })

  /**
   * `TimeTravel` is the one entry that is a service KEY rather than a
   * namespace, so `yield* Flows.TimeTravel` is the whole onboarding for time
   * travel (https://smithers.sh/api/time-travel). That it typechecks as a
   * yieldable is the acceptance criterion; the durable tag key is what a
   * rename would silently break.
   */
  it("re-exports TimeTravel as a yieldable service key, not a namespace", () => {
    const program = Effect.gen(function*() {
      const timeTravel = yield* Flows.TimeTravel
      return timeTravel
    })
    expect(program).toBeDefined()
    expect(Flows.TimeTravel.key).toBe("@smthrs/time-travel/TimeTravel")
    expect(Flows.TimeTravel.layer).toBeDefined()
  })
})
