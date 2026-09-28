import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Runtime from "../src/Runtime.ts"
import * as ExecutableFixture from "./ExecutableFixture.ts"
import { writeExecutable } from "./ExecutableFixture.ts"

const platform = { os: "linux", arch: "x64", libc: null }

/** Runs an effect that is expected to fail, and returns the typed error. */
const refusalOf = <A>(effect: Effect.Effect<A, Runtime.RuntimeError, never>): Promise<Runtime.RuntimeError> =>
  Effect.runPromise(Effect.flip(effect))

const withFixture = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-runtime-")))
  try {
    return await use(root)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}

describe("Runtime.satisfies", () => {
  it("accepts an exact version and rejects any other", () => {
    expect(Runtime.satisfies("24.9.0", "24.9.0")).toBe(true)
    expect(Runtime.satisfies("=24.9.0", "24.9.0")).toBe(true)
    expect(Runtime.satisfies("24.9.0", "24.9.1")).toBe(false)
    expect(Runtime.satisfies("24.9.0", "24.10.0")).toBe(false)
  })

  it("compares each comparator form", () => {
    expect(Runtime.satisfies(">=22.19.0", "24.9.0")).toBe(true)
    expect(Runtime.satisfies(">=22.19.0", "22.19.0")).toBe(true)
    expect(Runtime.satisfies(">=22.19.0", "22.18.9")).toBe(false)
    expect(Runtime.satisfies(">22", "24.0.0")).toBe(true)
    expect(Runtime.satisfies(">22", "22.0.0")).toBe(false)
    expect(Runtime.satisfies("<=24", "24.0.0")).toBe(true)
    expect(Runtime.satisfies("<=24", "24.0.1")).toBe(false)
    expect(Runtime.satisfies("<25", "24.9.0")).toBe(true)
    expect(Runtime.satisfies("<25", "25.0.0")).toBe(false)
  })

  it("treats a shorter version as zero-padded", () => {
    expect(Runtime.satisfies(">=22", "22.0.0")).toBe(true)
    expect(Runtime.satisfies("22", "22.0.0")).toBe(true)
    expect(Runtime.satisfies("22.0", "22.0.0")).toBe(true)
  })

  it("refuses a prerelease against an exact pin on the release", () => {
    expect(Runtime.satisfies("1.3.0", "1.3.0-canary.2")).toBe(false)
    expect(Runtime.satisfies("=1.3.0", "1.3.0-canary.2")).toBe(false)
    expect(Runtime.satisfies("1.3.0", "1.3.0")).toBe(true)
  })

  it("accepts the prerelease an exact pin names, and no other", () => {
    expect(Runtime.satisfies("=1.3.0-canary.2", "1.3.0-canary.2")).toBe(true)
    expect(Runtime.satisfies("1.3.0-canary.2", "v1.3.0-canary.2")).toBe(true)
    expect(Runtime.satisfies("=1.3.0-canary.2", "1.3.0-canary.3")).toBe(false)
    expect(Runtime.satisfies("=1.3.0-canary.2", "1.3.0")).toBe(false)
    expect(Runtime.satisfies("=1.3.0-canary.2", "1.3.0-canary.2+build.7")).toBe(true)
  })

  it("orders prereleases by semver precedence when the bound names one", () => {
    expect(Runtime.satisfies(">=1.0.0-rc.2", "1.0.0-rc.1")).toBe(false)
    expect(Runtime.satisfies(">=1.0.0-rc.2", "1.0.0-rc.2")).toBe(true)
    expect(Runtime.satisfies(">=1.0.0-rc.2", "1.0.0-rc.10")).toBe(true)
    expect(Runtime.satisfies(">=1.0.0-rc.2", "1.0.0")).toBe(true)
    expect(Runtime.satisfies(">1.0.0-rc.2", "1.0.0-rc.2")).toBe(false)
    expect(Runtime.satisfies("<1.0.0-rc.2", "1.0.0-rc.1")).toBe(true)
    expect(Runtime.satisfies("<1.0.0-rc.2", "1.0.0")).toBe(false)
    expect(Runtime.satisfies("<=1.0.0-beta", "1.0.0-alpha.9")).toBe(true)
    expect(Runtime.satisfies("<=1.0.0-beta", "1.0.0-beta.1")).toBe(false)
    expect(Runtime.satisfies(">=1.0.0-rc.2", "0.9.0")).toBe(false)
  })

  it("orders prerelease identifiers by numeric value, kind, and length", () => {
    expect(Runtime.satisfies("<1.0.0-rc.2", "1.0.0-rc.1.alpha")).toBe(true)
    expect(Runtime.satisfies(">1.0.0-rc.1", "1.0.0-rc.1.alpha")).toBe(true)
    expect(Runtime.satisfies("<1.0.0-rc.alpha", "1.0.0-rc.9")).toBe(true)
    expect(Runtime.satisfies(">1.0.0-rc.9", "1.0.0-rc.alpha")).toBe(true)
    expect(Runtime.satisfies("<1.0.0-rc.zeta", "1.0.0-rc.alpha")).toBe(true)
    expect(Runtime.satisfies(">1.0.0-rc.alpha", "1.0.0-rc.zeta")).toBe(true)
  })

  it("orders arbitrarily long prerelease numbers exactly, including zero", () => {
    const beyondNumberRange = "9".repeat(310)
    const nextMagnitude = `1${"0".repeat(310)}`
    for (
      const [requirement, measured, expected] of [
        [">=1.0.0-rc.9007199254740993", "1.0.0-rc.9007199254740992", false],
        [">1.0.0-rc.9007199254740992", "1.0.0-rc.9007199254740993", true],
        ["<1.0.0-rc.1000000000000000000000", "1.0.0-rc.999999999999999999999", true],
        [">1.0.0-rc.999999999999999999999", "1.0.0-rc.1000000000000000000000", true],
        ["<1.0.0-rc.1000000000000000000001", "1.0.0-rc.1000000000000000000000", true],
        ["<=1.0.0-rc.1000000000000000000000", "1.0.0-rc.1000000000000000000000", true],
        ["=1.0.0-rc.9007199254740993", "1.0.0-rc.9007199254740993", true],
        ["=1.0.0-rc.9007199254740993", "1.0.0-rc.9007199254740992", false],
        [">1.0.0-rc.0", "1.0.0-rc.1", true],
        ["<1.0.0-rc.1", "1.0.0-rc.0", true],
        ["<1.0.0-rc.0.beta", "1.0.0-rc.0.alpha", true],
        ["<1.0.0-rc.alpha", "1.0.0-rc.9007199254740993", true],
        ["<1.0.0-rc.a", "1.0.0-rc.Z", true],
        [`<1.0.0-rc.${nextMagnitude}`, `1.0.0-rc.${beyondNumberRange}`, true]
      ] as const
    ) {
      expect(Runtime.satisfies(requirement, measured), `${measured} vs ${requirement}`).toBe(expected)
    }
  })

  it("keeps accepted zero-padded suffixes distinct for exact pins while comparing numeric rank", () => {
    expect(Runtime.satisfies("<=1.0.0-rc.2", "1.0.0-rc.02")).toBe(true)
    expect(Runtime.satisfies(">=1.0.0-rc.2", "1.0.0-rc.02")).toBe(true)
    expect(Runtime.satisfies("<1.0.0-rc.2", "1.0.0-rc.02")).toBe(false)
    expect(Runtime.satisfies(">1.0.0-rc.2", "1.0.0-rc.02")).toBe(false)
    expect(Runtime.satisfies("<1.0.0-rc.2.2", "1.0.0-rc.0002.1")).toBe(true)
    expect(Runtime.satisfies(">1.0.0-rc.2.0", "1.0.0-rc.0002.1")).toBe(true)
    expect(Runtime.satisfies("=1.0.0-rc.2.1", "1.0.0-rc.0002.1")).toBe(false)
    expect(Runtime.satisfies("=1.0.0-rc.0002.1", "1.0.0-rc.0002.1")).toBe(true)
  })

  it("refuses a version component outside JavaScript's exact integer range", () => {
    expect(Runtime.satisfies(">=1.0.0", "9007199254740992.0.0")).toBe("unsupported_requirement")
    expect(Runtime.satisfies(">=9007199254740992", "1.0.0")).toBe("unsupported_requirement")
  })

  it("compares a prerelease as its release version under a comparator", () => {
    expect(Runtime.satisfies(">=1.4.0", "1.4.0-canary.2")).toBe(true)
    expect(Runtime.satisfies("<1.5.0", "1.4.0-canary.2")).toBe(true)
    expect(Runtime.satisfies("<1.4.0", "1.3.0-canary.2")).toBe(true)
    // Only the suffix is ignored. The release core still orders, so a canary
    // of a lower release stays below the floor. Moving the bun floor from
    // 1.3.0 to 1.4.0 without moving the measured version alongside it is what
    // turned this case red, and this line is the assertion that edit inverted.
    expect(Runtime.satisfies(">=1.4.0", "1.3.0-canary.2")).toBe(false)
  })

  it("treats build metadata as the release it annotates", () => {
    expect(Runtime.satisfies(">=1.4.0", "1.4.0+build.7")).toBe(true)
    expect(Runtime.satisfies("1.3.0", "1.3.0+build.7")).toBe(true)
    expect(Runtime.satisfies(">=1.4.0", "1.3.0+build.7")).toBe(false)
  })

  it("accepts a leading v on either side", () => {
    expect(Runtime.satisfies("24.9.0", "v24.9.0")).toBe(true)
    expect(Runtime.satisfies("v24.9.0", "24.9.0")).toBe(true)
  })

  it("reports an unsupported requirement rather than passing it", () => {
    expect(Runtime.satisfies("^24.0.0", "24.9.0")).toBe("unsupported_requirement")
    expect(Runtime.satisfies("~24.9", "24.9.0")).toBe("unsupported_requirement")
    expect(Runtime.satisfies(">=22 <25", "24.9.0")).toBe("unsupported_requirement")
    expect(Runtime.satisfies("latest", "24.9.0")).toBe("unsupported_requirement")
    expect(Runtime.satisfies("", "24.9.0")).toBe("unsupported_requirement")
    expect(Runtime.satisfies("24.9.0", "not-a-version")).toBe("unsupported_requirement")
  })

  it.each([
    ">=22.0.0-rc.1 <23",
    ">=22.0.0+build <23",
    ">=22.0.0-rc.1 || <23",
    ">=22.0.0+build || <23",
    "22.0.0-rc.1 24.11.0",
    "22.0.0-",
    "22.0.0+",
    "22.0.0-rc..1",
    "22.0.0-rc.",
    "22.0.0+build..1",
    "22.0.0+build.",
    "22.0.0-rc!1",
    "22.0.0+build+other"
  ])("refuses the entire malformed version token %s", (requirement) => {
    expect(Runtime.satisfies(requirement, "24.11.0")).toBe("unsupported_requirement")
    expect(Runtime.satisfies(">=22", requirement.replace(/^>=/, ""))).toBe("unsupported_requirement")
  })
})

describe("Runtime.makeNoop", () => {
  it("reports the declaration and the fixed version without spawning", async () => {
    const service = Runtime.makeNoop("node", { requirement: ">=22.19.0", version: "24.9.0", platform })
    expect(service.name).toBe("node")
    expect(service.executable).toBe("node")
    expect(service.requirement).toBe(">=22.19.0")
    expect(service.platform).toEqual(platform)
    expect(await Effect.runPromise(service.version)).toBe("24.9.0")
    expect(await Effect.runPromise(service.verify)).toBe("24.9.0")
  })

  it("honours an executable override", () => {
    const service = Runtime.makeNoop("bun", {
      requirement: "1.3.0",
      version: "1.3.0",
      platform,
      executable: "/opt/bun/bin/bun"
    })
    expect(service.executable).toBe("/opt/bun/bin/bun")
  })

  it("refuses a host that does not satisfy the declaration", async () => {
    const service = Runtime.makeNoop("node", { requirement: ">=24.0.0", version: "22.19.0", platform })
    const error = await refusalOf(service.verify)
    expect(error.code).toBe("unsatisfied")
    expect(error.message).toMatch(/this host runs node 22\.19\.0, and the workspace declares >=24\.0\.0/)
  })

  /**
   * The double used to collapse the third outcome into the second, so it
   * reported `unsatisfied` and the sentence "this host runs node 24.9.0, and
   * the workspace declares ^24.0.0" for a host that does satisfy `^24.0.0`.
   * That sends an operator to upgrade Node when the legacy declaration declaration is
   * what needs fixing, and it makes the two codes indistinguishable in every
   * composition that asserts the refusal path through the double.
   */
  it("reports an unsupported requirement as itself, not as an unsatisfied host", async () => {
    const service = Runtime.makeNoop("node", { requirement: "^24.0.0", version: "24.9.0", platform })
    const error = await refusalOf(service.verify)
    expect(error.code).toBe("unsupported_requirement")
    expect(error.message).toMatch(/is not an exact version or a single comparator/)
  })

  it("refuses construction options the measuring implementation would refuse", () => {
    const base = { requirement: ">=22.19.0", version: "24.9.0", platform }
    expect(() => Runtime.makeNoop("node", { ...base, timeoutMs: 5 } as never)).toThrow(/unknown property/)
    expect(() => Runtime.makeNoop("node", { ...base, requirement: "" })).toThrow(/requirement must be/)
    expect(() => Runtime.makeNoop("node", { ...base, version: "" })).toThrow(/version must be/)
    expect(() => Runtime.makeNoop("node", { ...base, platform: { ...platform, os: "" } })).toThrow(/os and arch/)
    expect(() => Runtime.makeNoop("node", { ...base, platform: { ...platform, libc: "" } })).toThrow(/libc/)
    expect(() => Runtime.makeNoop("node", { ...base, executable: "" })).toThrow(/executable must be/)
    const withGetter = { ...base }
    Object.defineProperty(withGetter, "requirement", { enumerable: true, get: () => ">=22.19.0" })
    expect(() => Runtime.makeNoop("node", withGetter)).toThrow(/enumerable data property/)
  })

  it.each([0, -1, 1.5, NaN, Infinity, 30_001, "100"])("refuses invalid probeTimeoutMs %s", (probeTimeoutMs) => {
    expect(() =>
      Runtime.makeNoop("node", {
        requirement: "1.0.0",
        version: "1.0.0",
        platform,
        probeTimeoutMs
      } as never)
    ).toThrow(/probe timeout must be an integer from 1 to 30000/)
  })

  /**
   * `verify` used to close over the options object and re-read `requirement`
   * when it ran, so a caller that edited the object afterwards left the service
   * reporting one declaration and enforcing another. `platform` was shared by
   * reference and unfrozen, so editing it changed every store manifest minted
   * from the service.
   */
  it("snapshots its options, so a later mutation changes neither the report nor the check", async () => {
    const options = {
      requirement: ">=22.19.0",
      version: "24.9.0",
      platform: { os: "linux", arch: "x64", libc: null as string | null }
    }
    const service = Runtime.makeNoop("node", options)
    options.requirement = ">=99.0.0"
    options.platform.os = "win32"
    expect(service.requirement).toBe(">=22.19.0")
    expect(service.platform.os).toBe("linux")
    expect(await Effect.runPromise(service.verify)).toBe("24.9.0")
    expect(() => {
      ;(service.platform as { os: string }).os = "win32"
    }).toThrow(TypeError)
  })

  it("provides itself as a layer", async () => {
    const layer = Runtime.layerNoop("bun", { requirement: "1.3.0", version: "1.3.0", platform })
    const name = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* Runtime.Runtime
        return runtime.name
      }).pipe(Effect.provide(layer))
    )
    expect(name).toBe("bun")
  })
})

describe("Runtime measurement", () => {
  it("measures a version and holds the host to the declaration", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "fake-node.mjs")
      await writeExecutable(executable, "process.stdout.write(\"v24.9.0\\n\")")
      const service = await Effect.runPromise(
        Runtime.make("node", { requirement: ">=22.19.0", platform, executable }).pipe(
          Effect.provide(ExecutableFixture.layer)
        )
      )
      expect(await Effect.runPromise(service.version)).toBe("24.9.0")
      expect(await Effect.runPromise(service.verify)).toBe("24.9.0")
    })
  })

  it("memoizes interpreter measurements per layer instance", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "fake-node.mjs")
      const calls = NodePath.join(root, "calls")
      await writeExecutable(
        executable,
        `
        import { appendFileSync } from "node:fs"
        appendFileSync(${JSON.stringify(calls)}, process.argv[2] + "\\n")
        process.stdout.write("v24.9.0\\n")
      `
      )
      const layer = Runtime.layerNode({ requirement: ">=22.19.0", platform, executable })
      const use = Effect.gen(function*() {
        const service = yield* Runtime.Runtime
        expect(yield* Effect.all([service.version, service.verify], { concurrency: "unbounded" }))
          .toEqual(["24.9.0", "24.9.0"])
        expect(yield* service.verify).toBe("24.9.0")
      }).pipe(Effect.provide(layer), Effect.provide(ExecutableFixture.layer))
      await Effect.runPromise(use)
      expect(await Fs.readFile(calls, "utf8")).toBe("--version\n")
      await Effect.runPromise(use)
      expect(await Fs.readFile(calls, "utf8")).toBe("--version\n--version\n")
    })
  })

  it("reads the first version-shaped token on the first line", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "chatty-bun.mjs")
      await writeExecutable(
        executable,
        "process.stdout.write(\"bun 1.3.0 (stable)\\nwebkit 1.2\\ntypescript 5.6\\n\")"
      )
      const service = await Effect.runPromise(
        Runtime.make("bun", { requirement: "1.3.0", platform, executable }).pipe(
          Effect.provide(ExecutableFixture.layer)
        )
      )
      expect(await Effect.runPromise(service.version)).toBe("1.3.0")
    })
  })

  /**
   * `satisfies` matches an exact pin on prerelease identity, but the probe's
   * own parser accepted only `^v?\d+(\.\d+)*$`, so a real interpreter printing
   * `1.3.0-canary.2` was refused as `probe_failed` before the comparator ever
   * saw it. `=1.3.0-canary.2` was therefore a requirement no host could meet,
   * and the unit tests for the comparator could not show it.
   */
  it("measures a prerelease and holds an exact pin to its identity", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "canary-bun.mjs")
      await writeExecutable(executable, "process.stdout.write(\"1.3.0-canary.2\\n\")")
      const pinned = await Effect.runPromise(
        Runtime.make("bun", { requirement: "=1.3.0-canary.2", platform, executable }).pipe(
          Effect.provide(ExecutableFixture.layer)
        )
      )
      expect(await Effect.runPromise(pinned.version)).toBe("1.3.0-canary.2")
      expect(await Effect.runPromise(pinned.verify)).toBe("1.3.0-canary.2")

      const release = await Effect.runPromise(
        Runtime.make("bun", { requirement: "=1.3.0", platform, executable }).pipe(
          Effect.provide(ExecutableFixture.layer)
        )
      )
      const refused = await refusalOf(release.verify)
      expect(refused.code).toBe("unsatisfied")
      expect(refused.message).toMatch(/this host runs bun 1\.3\.0-canary\.2, and the workspace declares =1\.3\.0/)
    })
  })

  it("measures a version carrying build metadata", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "built-node.mjs")
      await writeExecutable(executable, "process.stdout.write(\"v24.9.0+build.7\\n\")")
      const service = await Effect.runPromise(
        Runtime.make("node", { requirement: ">=22.19.0", platform, executable }).pipe(
          Effect.provide(ExecutableFixture.layer)
        )
      )
      expect(await Effect.runPromise(service.version)).toBe("24.9.0+build.7")
      expect(await Effect.runPromise(service.verify)).toBe("24.9.0+build.7")
    })
  })

  it("refuses a measured version the declaration excludes", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "old-node.mjs")
      await writeExecutable(executable, "process.stdout.write(\"v20.11.0\\n\")")
      const service = await Effect.runPromise(
        Runtime.make("node", { requirement: ">=22.19.0", platform, executable }).pipe(
          Effect.provide(ExecutableFixture.layer)
        )
      )
      await expect(Effect.runPromise(service.verify)).rejects.toThrow(
        /this host runs node 20\.11\.0, and the workspace declares >=22\.19\.0/
      )
    })
  })

  it("reports an unsupported requirement against the measured version", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "fake-node.mjs")
      await writeExecutable(executable, "process.stdout.write(\"v24.9.0\\n\")")
      const service = await Effect.runPromise(
        Runtime.make("node", { requirement: "^24.0.0", platform, executable }).pipe(
          Effect.provide(ExecutableFixture.layer)
        )
      )
      await expect(Effect.runPromise(service.verify)).rejects.toThrow(
        /is not an exact version or a single comparator/
      )
    })
  })

  it("bounds a hanging interpreter version probe", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "hanging.mjs")
      await writeExecutable(executable, "setInterval(() => {}, 1000)")
      const error = await refusalOf(
        Runtime.make("node", { requirement: "1.0.0", platform, executable, probeTimeoutMs: 100 }).pipe(
          Effect.flatMap((service) => service.version),
          Effect.provide(ExecutableFixture.layer)
        )
      )
      expect(error.code).toBe("probe_failed")
      expect(error.message).toContain("did not finish within 100ms")
    })
  })

  it("fails when the probe prints no version", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "silent.mjs")
      await writeExecutable(executable, "process.stdout.write(\"no idea\\n\")")
      const service = await Effect.runPromise(
        Runtime.make("node", { requirement: "24.9.0", platform, executable }).pipe(
          Effect.provide(ExecutableFixture.layer)
        )
      )
      await expect(Effect.runPromise(service.version)).rejects.toThrow(/printed no version/)
    })
  })

  it("fails when the probe exits non-zero", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "broken.mjs")
      await writeExecutable(executable, "process.exit(3)")
      const service = await Effect.runPromise(
        Runtime.make("node", { requirement: "24.9.0", platform, executable }).pipe(
          Effect.provide(ExecutableFixture.layer)
        )
      )
      await expect(Effect.runPromise(service.version)).rejects.toThrow(/exited with status 3/)
    })
  })

  it("fails when the executable does not exist", async () => {
    await withFixture(async (root) => {
      const service = await Effect.runPromise(
        Runtime.make("node", {
          requirement: "24.9.0",
          platform,
          executable: NodePath.join(root, "absent")
        }).pipe(Effect.provide(ExecutableFixture.layer))
      )
      await expect(Effect.runPromise(service.version)).rejects.toThrow(/failed/)
    })
  })

  /**
   * The probe's byte bound was exported and documented and applied to nothing:
   * the implementation collected stdout with an unbounded `Stream.mkString`,
   * so a declared interpreter printing megabytes drove the build process's
   * memory through a path the constant said was bounded.
   */
  it("accepts output up to the bound and refuses the first byte past it", async () => {
    await withFixture(async (root) => {
      const bound = Runtime.maximumVersionOutputBytes
      const prefix = "1.0.0\n"
      const atBound = NodePath.join(root, "at-bound.mjs")
      await writeExecutable(
        atBound,
        `process.stdout.write(${JSON.stringify(prefix)} + "a".repeat(${bound - prefix.length}))`
      )
      const accepted = await Effect.runPromise(
        Runtime.make("node", { requirement: "1.0.0", platform, executable: atBound }).pipe(
          Effect.flatMap((service) => service.version),
          Effect.provide(ExecutableFixture.layer)
        )
      )
      expect(accepted).toBe("1.0.0")

      const overBound = NodePath.join(root, "over-bound.mjs")
      await writeExecutable(
        overBound,
        `process.stdout.write(${JSON.stringify(prefix)} + "a".repeat(${bound - prefix.length + 1}))`
      )
      const error = await refusalOf(
        Runtime.make("node", { requirement: "1.0.0", platform, executable: overBound }).pipe(
          Effect.flatMap((service) => service.version),
          Effect.provide(ExecutableFixture.layer)
        )
      )
      expect(error.code).toBe("probe_failed")
      expect(error.message).toMatch(/version output exceeds/)
    })
  })

  it("bounds output that arrives as many small chunks", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "chatty.mjs")
      const chunks = Math.ceil((Runtime.maximumVersionOutputBytes + 1) / 64)
      await writeExecutable(
        executable,
        `for (let index = 0; index < ${chunks}; index += 1) process.stdout.write("a".repeat(64))`
      )
      const error = await refusalOf(
        Runtime.make("node", { requirement: "1.0.0", platform, executable }).pipe(
          Effect.flatMap((service) => service.version),
          Effect.provide(ExecutableFixture.layer)
        )
      )
      expect(error.message).toMatch(/version output exceeds/)
    })
  })

  /**
   * The child ignores EPIPE on purpose. Once the reader refuses the bound and
   * closes its end, the next write raises `error` on `process.stdout`, and an
   * unhandled one exits the child on its own. A child that died that way
   * never wrote the marker whether or not anything killed it, so the earlier
   * form of this test passed against a spawner that dropped the kill. The
   * child records its pid first, and the test polls that pid to a deadline
   * for the positive evidence: the process is gone.
   */
  it("kills a producer that keeps writing after the bound is refused", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "runaway.mjs")
      const marker = NodePath.join(root, "kept-running")
      const pidFile = NodePath.join(root, "pid")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\n` +
          `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n` +
          `process.stdout.on("error", () => {})\n` +
          `const write = () => process.stdout.write("a".repeat(4096))\n` +
          `for (let index = 0; index < ${
            Math.ceil(Runtime.maximumVersionOutputBytes / 4096) + 8
          }; index += 1) write()\n` +
          `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "yes"), 700)`
      )
      const error = await refusalOf(
        Runtime.make("node", { requirement: "1.0.0", platform, executable }).pipe(
          Effect.flatMap((service) => service.version),
          Effect.provide(ExecutableFixture.layer)
        )
      )
      expect(error.message).toMatch(/version output exceeds/)
      const pid = Number(await Fs.readFile(pidFile, "utf8"))
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
      const alive = () => {
        try {
          process.kill(pid, 0)
          return true
        } catch (cause) {
          return (cause as NodeJS.ErrnoException).code !== "ESRCH"
        }
      }
      const deadline = Date.now() + 5_000
      while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
      expect(alive()).toBe(false)
      await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  /**
   * `extendEnv: false` alone selects nothing: `resolveEnvironment` in
   * `@effect/platform-node-shared` returns an absent `env` unchanged, and
   * `spawn` reads an absent `env` as inherit-everything. Supplying an
   * environment is what makes the probe hermetic, and this is the assertion
   * that says which names survive the selection.
   */
  it("gives a supplied environment's lookup names to the probe and nothing else", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "reporting.mjs")
      const observed = NodePath.join(root, "observed.json")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\n` +
          `writeFileSync(${JSON.stringify(observed)}, JSON.stringify(Object.keys(process.env).sort()))\n` +
          `process.stdout.write("1.0.0\\n")`
      )
      const measured = await Effect.runPromise(
        Runtime.make("node", {
          requirement: "1.0.0",
          platform,
          executable,
          environment: {
            PATH: process.env.PATH,
            HOME: "/hidden/home",
            UNRELATED_SECRET: "must-not-leak"
          }
        }).pipe(Effect.flatMap((service) => service.version), Effect.provide(ExecutableFixture.layer))
      )
      expect(measured).toBe("1.0.0")
      // Compare with a direct child given PATH alone: the OS may add bootstrap
      // variables (for example SYSTEMROOT on Windows) below the service seam.
      const names = JSON.parse(await Fs.readFile(observed, "utf8")) as ReadonlyArray<string>
      const baseline = spawnSync(process.execPath, [
        "-e",
        "console.log(JSON.stringify(Object.keys(process.env).sort()))"
      ], {
        env: { PATH: process.env.PATH },
        encoding: "utf8",
        timeout: 10_000
      })
      expect(baseline.error).toBeUndefined()
      expect(baseline.status).toBe(0)
      expect(names).toEqual(JSON.parse(baseline.stdout))
      expect(names).not.toContain("HOME")
      expect(names).not.toContain("UNRELATED_SECRET")
    })
  })

  it("selects only ambient lookup variables when no environment is supplied", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "inheriting.mjs")
      const observed = NodePath.join(root, "observed.json")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\n` +
          `writeFileSync(${
            JSON.stringify(observed)
          }, JSON.stringify(process.env.SMITHERS_BUILD_PROBE_MARKER ?? null))\n` +
          `process.stdout.write("1.0.0\\n")`
      )
      const previous = process.env.SMITHERS_BUILD_PROBE_MARKER
      process.env.SMITHERS_BUILD_PROBE_MARKER = "ambient"
      try {
        await Effect.runPromise(
          Runtime.make("node", { requirement: "1.0.0", platform, executable }).pipe(
            Effect.flatMap((service) => service.version),
            Effect.provide(ExecutableFixture.layer)
          )
        )
      } finally {
        if (previous === undefined) delete process.env.SMITHERS_BUILD_PROBE_MARKER
        else process.env.SMITHERS_BUILD_PROBE_MARKER = previous
      }
      expect(JSON.parse(await Fs.readFile(observed, "utf8"))).toBeNull()
    })
  })

  /**
   * `Action.executeEncoded` encodes a declared error through
   * `Schema.toCodecJson` and `Effect.orDie`s the encode, so an error carrying a
   * raw platform `Error` turned an ordinary probe failure into a defect that
   * killed the run instead of journaling `probe_failed`.
   */
  it("encodes a real probe failure, cause and all, as JSON", async () => {
    await withFixture(async (root) => {
      const error = await refusalOf(
        Runtime.make("node", {
          requirement: "1.0.0",
          platform,
          executable: NodePath.join(root, "absent")
        }).pipe(Effect.flatMap((service) => service.version), Effect.provide(ExecutableFixture.layer))
      )
      const encoded = await Effect.runPromise(
        Schema.encodeEffect(Schema.toCodecJson(Runtime.RuntimeError))(error)
      )
      expect(JSON.parse(JSON.stringify(encoded))).toMatchObject({
        code: "probe_failed",
        cause: { name: "PlatformError", code: "ENOENT" }
      })
    })
  })

  it("builds each runtime layer", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "fake.mjs")
      await writeExecutable(executable, "process.stdout.write(\"1.3.0\\n\")")
      for (
        const [name, layer] of [
          ["node", Runtime.layerNode({ requirement: "1.3.0", platform, executable })],
          ["bun", Runtime.layerBun({ requirement: "1.3.0", platform, executable })]
        ] as const
      ) {
        const measured = await Effect.runPromise(
          Effect.gen(function*() {
            const runtime = yield* Runtime.Runtime
            expect(runtime.name).toBe(name)
            return yield* runtime.verify
          }).pipe(Effect.provide(layer), Effect.provide(ExecutableFixture.layer))
        )
        expect(measured).toBe("1.3.0")
      }
    })
  })
})
