/**
 * No new raw-text failure sites in the flow engine's packages (#2813).
 *
 * A caller of the public API classifies a failure by its tag: a
 * `Schema.TaggedError`, a `PlatformError`, or another tagged value. A plain
 * `new Error("...")`, a bare string handed to `Effect.fail` or `Effect.die`,
 * or a thrown string carries no tag, so it reaches a caller as an unknown
 * failure. Every such site under a package's `src` is counted here per file,
 * with why it is not a public failure; a new site, or a file that drops one
 * without lowering its count, fails. Add a tagged error instead of raising a
 * count.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..")

const raw = /new Error\(|Effect\.(?:fail|die)\(\s*["'`]|throw\s+["'`]/

const wrappedCause = "the Error is the `cause` of a tagged failure; only the tag and its own fields reach a caller"
const invariantDefect = "Effect.die on a broken internal invariant: a defect (a bug), never a typed failure"
const testSupport = "published test support: its failure fails the caller's test"

/** Reviewed files, with the number of raw sites each keeps and why. */
const reviewed: ReadonlyArray<readonly [file: string, count: number, why: string]> = [
  ["capability/src/format.ts", 1, "documented contract of format for an action the Action type already excludes"],
  ["database/src/test/TestDatabase.ts", 1, testSupport],
  [
    "engine-store/src/DurableEngineState.ts",
    4,
    "two invariant defects; two JSON codec failures made defects by Effect.orDie"
  ],
  ["engine-store/src/PlanScheduler.ts", 1, invariantDefect],
  ["engine-store/src/StepBoundary.ts", 3, wrappedCause],
  ["engine-store/src/internal/ActionPersistence.ts", 1, invariantDefect],
  ["engine-store/src/internal/ExecutionSnapshotRead.ts", 1, wrappedCause],
  ["engine-store/src/internal/RunDriver.ts", 3, invariantDefect],
  ["engine/src/FlowEngine/Placed.ts", 1, invariantDefect],
  ["engine/src/PlacedAction.ts", 1, invariantDefect],
  [
    "flow/src/Fault.ts",
    1,
    "a conflicting Fault registration while modules load; a programming error, never at run time"
  ],
  ["flow/src/Flow/make.ts", 1, "a comment naming the throw payloadSchema.make performs"],
  ["flow/src/internal/DeclarationSite.ts", 1, "captures a stack to locate a declaration; never thrown"],
  ["journal/src/RedactedLogger.ts", 1, "an empty Error clone that receives redacted fields; never thrown"],
  ["kernel/src/HttpClient.ts", 1, wrappedCause],
  ["kernel/src/test/HostContract.ts", 1, testSupport],
  ["platform-node/src/ScopedProcess.ts", 1, wrappedCause],
  [
    "src/internal/SandboxedFlowGuest.ts",
    1,
    "guest bundle started without its paths; a host programming error reported by the guest's exit"
  ],
  ["step-cache/src/RemoteCacheStore.ts", 1, "unreachable namespace escape (KeyDigest excludes separators); a defect"],
  ["sync/src/test/TestSocket.ts", 1, testSupport]
]

const packages = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "test")
  .map((entry) => entry.name)

const sources = (directory: string): ReadonlyArray<string> => {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

const scanned = [join(root, "src"), ...packages.map((name) => join(root, name, "src"))].flatMap(sources)

const counts = new Map<string, number>()
for (const path of scanned) {
  const sites = readFileSync(path, "utf8").split("\n").filter((line) => raw.test(line)).length
  if (sites > 0) counts.set(relative(root, path), sites)
}

describe("raw failure sites in the flow engine's packages", () => {
  it("match the reviewed count in every file", () => {
    const expected = Object.fromEntries(reviewed.map(([file, count]) => [file, count]))
    expect(Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)))).toEqual(
      Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b)))
    )
  })

  it("lists each reviewed file once, with at least one site", () => {
    expect(new Set(reviewed.map(([file]) => file)).size).toBe(reviewed.length)
    expect(reviewed.filter(([, count]) => count < 1)).toEqual([])
  })

  it("scans every package's src", () => {
    expect(packages).toEqual(expect.arrayContaining(["database", "engine-store", "flow", "platform-node", "sync"]))
    expect(scanned.map((path) => relative(root, path))).toEqual(
      expect.arrayContaining(["database/src/internal/PostgresSelection.ts", "src/SandboxedFlow.ts"])
    )
  })

  it("detects each raw shape", () => {
    expect(raw.test(`throw new Error("x")`)).toBe(true)
    expect(raw.test(`Effect.fail("x")`)).toBe(true)
    expect(raw.test("Effect.die(`x`)")).toBe(true)
    expect(raw.test(`throw "x"`)).toBe(true)
    expect(raw.test(`throw new UnsupportedDatabase({ code: "postgres_url_invalid", message: "x" })`)).toBe(false)
    expect(raw.test(`throw PlatformError.badArgument({ module: "m", method: "f" })`)).toBe(false)
  })
})
