/**
 * `smthrs doctor` on a local project, straight off the discovery snapshot.
 *
 * `Cli.ts` takes `fromRegistry` for every local invocation, and the one suite
 * that reaches that branch, `UnifiedRootCommands.test.ts`, replaces the module
 * with a stub, so nothing executed the function itself. Two promises are worth
 * pinning: the report is built from the registry's own snapshot, descriptors
 * and warnings alike, and reading it opens no execution database, which is the
 * whole reason local diagnostics take this path instead of `fromControl`.
 */
import type * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import * as RegistryError from "@smthrs/registry/RegistryError"
import { Cause, Effect, Exit, Layer } from "effect"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as DoctorCmd from "../src/commands/Doctor.ts"
import type * as Doctor from "../src/Doctor.ts"
import * as Project from "../src/Project.ts"

const staged: Array<string> = []

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

const project = (): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-doctor-registry-"))
  staged.push(root)
  return root
}

/**
 * `fromRegistry` projects a descriptor onto `{ flowId, description }` and reads
 * nothing else, so the discovery metadata a real scan carries is left out on
 * purpose. This is the same shape `control/test/TestStack.ts` hands `ControlLive`.
 */
const descriptor = (name: string, description: string): Descriptor.FlowDescriptor =>
  ({ name, description }) as unknown as Descriptor.FlowDescriptor

const warning = (
  path: string,
  code: Descriptor.DiscoveryWarningCode,
  message: string
): Descriptor.DiscoveryWarning => ({ path, code, message }) as unknown as Descriptor.DiscoveryWarning

const check = (report: Doctor.Report, name: string) => report.checks.find((entry) => entry.name === name)

const runWith = (
  globals: Parameters<typeof DoctorCmd.fromRegistry>[0],
  root: string,
  descriptors: ReadonlyArray<Descriptor.FlowDescriptor>,
  warnings: ReadonlyArray<Descriptor.DiscoveryWarning>
): Promise<Doctor.Report> =>
  Effect.runPromise(
    DoctorCmd.fromRegistry(
      globals,
      () => Registry.layerNoop({ list: () => Effect.succeed(descriptors), warnings: () => Effect.succeed(warnings) })
    ).pipe(
      Effect.provideService(Project.ProjectRoot, root),
      Effect.provideService(Project.LegacyState, [])
    )
  )

const run = (
  root: string,
  descriptors: ReadonlyArray<Descriptor.FlowDescriptor>,
  warnings: ReadonlyArray<Descriptor.DiscoveryWarning>
): Promise<Doctor.Report> => runWith({ environment: {} }, root, descriptors, warnings)

describe("local diagnostics off the registry snapshot", () => {
  it("counts the discovered flows and leaves the reserved ones out", async () => {
    const root = project()
    const report = await run(root, [
      descriptor("review", "Review the working copy"),
      descriptor("release", "Cut a release"),
      // Reserved flows have no body, so counting one would report a flow that
      // can never run. `report` drops them before `Doctor.inspect` sees them.
      descriptor("system/steer", "Reserved")
    ], [])
    expect(check(report, "registry")).toMatchObject({ level: "ok", detail: "2 flows discovered" })
    // The snapshot is authoritative: no filesystem fallback ran against a root
    // that holds no `flows/` directory at all.
    expect(existsSync(Project.flowsDirectory(root))).toBe(false)
  })

  it("warns when the snapshot is empty rather than walking the project", async () => {
    const root = project()
    const report = await run(root, [], [])
    expect(check(report, "registry")).toMatchObject({
      level: "warn",
      detail: `${Project.flowsDirectory(root)} yielded no discovered flows; discovery finds nothing`
    })
  })

  it("carries each discovery warning into its own check", async () => {
    const root = project()
    const report = await run(root, [descriptor("review", "Review the working copy")], [
      warning("flows/broken/flow.mdx", "missing_description", "A flow needs a description")
    ])
    expect(check(report, "registry flows/broken/flow.mdx")).toMatchObject({
      level: "warn",
      detail: "missing_description: A flow needs a description"
    })
  })

  it("inspects the hidden --backend flag, and the process environment when the invocation carries none", async () => {
    // `doctor` reports an unsupported backend as a check instead of refusing,
    // so the flag has to reach the environment `Doctor.inspect` reads.
    const flagged = await runWith({ environment: {}, backend: "mysql" }, project(), [], [])
    expect(check(flagged, "backend")).toMatchObject({ level: "fail" })
    vi.stubEnv("SMITHERS_BACKEND", "pglite")
    try {
      const inherited = await runWith({}, project(), [], [])
      expect(check(inherited, "backend")).toMatchObject({ level: "fail" })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  const withRegistry = (registry: Layer.Layer<Registry.Registry>, root: string) =>
    DoctorCmd.fromRegistry({ environment: {} }, () => registry).pipe(
      Effect.provideService(Project.ProjectRoot, root),
      Effect.provideService(Project.LegacyState, [])
    )

  it("reports a registry discovery cannot build as a failed check and keeps the rest of the report", async () => {
    const root = project()
    const failure = RegistryError.discoveryError({
      code: "read_failed",
      method: "scan",
      description: "smithers-jj-export is missing"
    })
    const report = await Effect.runPromise(
      withRegistry(Layer.effect(Registry.Registry)(Effect.die(failure)), root)
    )
    expect(check(report, "registry")).toEqual({ name: "registry", level: "fail", detail: failure.message })
    expect(check(report, "node")).toBeDefined()
  })

  it("still crashes on a defect that is not a discovery failure", async () => {
    const defect = new Error("unrelated defect")
    const exit = await Effect.runPromiseExit(
      withRegistry(Layer.effect(Registry.Registry)(Effect.die(defect)), project())
    )
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(defect)
  })

  it("opens no execution database", async () => {
    const root = project()
    await run(root, [descriptor("review", "Review the working copy")], [])
    expect(existsSync(join(root, ".flows"))).toBe(false)
  })
})
