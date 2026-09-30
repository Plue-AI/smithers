/**
 * The unsupported half of the host suite, and the scratch directory the supported
 * half owns.
 *
 * Only the all-supported profile ran, so the branch that asserts an
 * unsupported capability fails with its declared stable code -- the branch the
 * whole "tickets, not exceptions" rule rests on -- never executed, and neither
 * did the mismatched-code report.
 */
import * as TestHost from "@smthrs/testing/TestHost"
import { Cause, Effect, Exit, FileSystem } from "effect"
import { describe, expect, it } from "vitest"
import * as HostSuite from "../../src/HostSuite.ts"
import * as TestLayers from "../../src/TestLayers.ts"

/** Every capability declared unsupported, with the code TestHost really raises. */
const declaredUnsupported: HostSuite.HostProfile = {
  fileSystem: { supported: false, code: "NotFound" },
  path: { supported: false, code: "BadArgument" },
  shell: { supported: false, code: "spawn_denied" },
  jj: { supported: false, code: "not_installed" },
  httpTransport: { supported: false, code: "TransportError" },
  clock: { supported: false, code: "capability_contract_violation" },
  random: { supported: false, code: "capability_contract_violation" }
}

/** The same profile with every declared code wrong. */
const wrongCodes: HostSuite.HostProfile = {
  ...declaredUnsupported,
  fileSystem: { supported: false, code: "not-the-code-it-raises" },
  path: { supported: false, code: "not-the-code-it-raises" },
  jj: { supported: false, code: "not-the-code-it-raises" }
}

const byName = (profile: HostSuite.HostProfile) =>
  new Map(HostSuite.hostSuite(TestHost.TestHost, profile).map((suiteCase) => [suiteCase.name, suiteCase]))

const outcome = (suiteCase: HostSuite.HostSuiteCase): Promise<"passed" | HostSuite.HostSuiteError> =>
  Effect.runPromise(
    suiteCase.run.pipe(
      Effect.map(() => "passed" as const),
      Effect.catch((error: HostSuite.HostSuiteError) => Effect.succeed(error))
    )
  )

describe("a capability declared unsupported must fail with its declared code", () => {
  const cases = byName(declaredUnsupported)

  it.each([
    "FileSystem round-trips",
    "Jj has a declared capability result",
    "HttpTransport has a declared capability result"
  ])("%s", async (name) => {
    expect(await outcome(cases.get(name)!)).toBe("passed")
  })

  // TestHost really does normalize paths, really does spawn, and really does
  // supply a `TestClock` and a seeded `Random`, so declaring any of them
  // unsupported is a wrong profile and the suite says so rather than accepting
  // the declaration.
  it.each([
    ["Path normalizes", "Path", "fromFileUrl"],
    ["Shell behavior is deterministic", "ChildProcessSpawner", "spawn"],
    ["Clock is monotonic", "Clock", "currentTimeMillis"],
    ["Random produces a valid value", "Random", "next"]
  ])("%s reports a capability the host actually has", async (name, capability, operation) => {
    expect(await outcome(cases.get(name)!)).toMatchObject({
      _tag: "CapabilityContractError",
      capability,
      operation
    })
  })

  it("reports the code it actually observed when the declaration is wrong", async () => {
    const observed = await outcome(byName(wrongCodes).get("Jj has a declared capability result")!)
    expect(observed).not.toBe("passed")
    expect(observed).toMatchObject({
      _tag: "CapabilityContractError",
      capability: "Jj",
      operation: "status",
      expectedCode: "not-the-code-it-raises"
    })
  })

  it("reports a file-system code that differs from the one the host raises", async () => {
    const observed = await outcome(byName(wrongCodes).get("FileSystem round-trips")!)
    expect(observed).toMatchObject({
      _tag: "CapabilityContractError",
      capability: "FileSystem",
      operation: "readFileString",
      expectedCode: "not-the-code-it-raises",
      actualCode: "NotFound"
    })
  })
})

// `Clock` and `Random` are `Context.Reference`s, so a bundle that supplies
// neither leaves the suite's poisoned base in force, and that base raises a
// DEFECT rather than a recoverable failure. `assertCapabilityError` used to
// inspect the recoverable channel only, so this shape -- the one the profile's
// `clock`/`random` unsupported branch exists for -- could not be asserted at
// all: the case died with the poisoned defect instead of reporting the code it
// observed.
describe("a bundle that supplies no Clock or Random can declare them unsupported", () => {
  // Every Host service is present and refuses; no `Clock` and no `Random` are
  // supplied, which is the whole point of the bundle here.
  const bare: HostSuite.HostBundle = TestLayers.poisoned

  const profile = (code: string): HostSuite.HostProfile => ({
    ...declaredUnsupported,
    clock: { supported: false, code },
    random: { supported: false, code }
  })

  const caseNamed = (code: string, name: string) =>
    HostSuite.hostSuite(bare, profile(code)).find((suiteCase) => suiteCase.name === name)!

  it.each(["Clock is monotonic", "Random produces a valid value"])(
    "%s accepts the declaration when the raised code matches",
    async (name) => {
      expect(await outcome(caseNamed("capability_contract_violation", name))).toBe("passed")
    }
  )

  it.each([
    ["Clock is monotonic", "Clock", "currentTimeMillis"],
    ["Random produces a valid value", "Random", "next"]
  ])("%s reports the code it observed when the declaration is wrong", async (name, capability, operation) => {
    expect(await outcome(caseNamed("not-the-code-it-raises", name))).toMatchObject({
      _tag: "CapabilityContractError",
      capability,
      operation,
      expectedCode: "not-the-code-it-raises",
      actualCode: "capability_contract_violation"
    })
  })
})

describe("the file-system probe owns its scratch directory", () => {
  const supported: HostSuite.HostProfile = { ...declaredUnsupported, fileSystem: { supported: true } }

  it("refuses to write over a file it did not create, and leaves it alone", async () => {
    const scratchPath = "/host-suite/pre-existing.txt"
    const run = Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(scratchPath, "not the suite's")
      const suiteCase = HostSuite.hostSuite(TestHost.TestHost, {
        ...supported,
        fileSystemScratchPath: scratchPath
      })[0]!
      const exit = yield* Effect.exit(suiteCase.run)
      return { exit, survivor: yield* fs.readFileString(scratchPath) }
    }).pipe(Effect.provide(TestHost.TestHost))
    const { exit, survivor } = await Effect.runPromise(run)
    expect(exit._tag).toBe("Failure")
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toMatchObject({ capability: "FileSystem", operation: "scratchPath" })
    }
    expect(survivor).toBe("not the suite's")
  })

  it("defaults to an absolute path outside the caller's working directory", async () => {
    const suiteCase = HostSuite.hostSuite(TestHost.TestHost, supported)[0]!
    expect(await outcome(suiteCase)).toBe("passed")
    // Two suites over one bundle must not collide on a fixed name.
    const [first, second] = await Promise.all([
      outcome(HostSuite.hostSuite(TestHost.TestHost, supported)[0]!),
      outcome(HostSuite.hostSuite(TestHost.TestHost, supported)[0]!)
    ])
    expect([first, second]).toEqual(["passed", "passed"])
  })
})
