import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import * as ToolBuild from "../src/ToolBuild.ts"
import * as ToolRun from "../src/ToolRun.ts"

const Leaf = Target.make("RuleTestLeaf", {
  attrs: Schema.Struct({}),
  kinds: ["build"],
  implementation: () => Target.notImplemented("RuleTestLeaf")
})

describe("Target metadata traversal", () => {
  it("constructs immutable, narrowly-scoped dependency selectors", () => {
    const selector = Target.subtree("//packages/...", "lib")
    expect(selector).toEqual({
      _tag: "TargetDependencySelector",
      pattern: "//packages/...",
      target: "lib"
    })
    expect(Object.isFrozen(selector)).toBe(true)
    expect(Target.isDependencySelector(selector)).toBe(true)
    for (
      const [pattern, target] of [
        ["packages/...", "lib"],
        ["//packages/*", "lib"],
        ["//packages/...", ""],
        ["//packages/...", "bad/name"]
      ]
    ) {
      expect(() => Target.subtree(pattern!, target!)).toThrow()
    }
  })

  it("rejects malformed dependency selectors without invoking proxy traps", () => {
    let invoked = false
    const proxy = new Proxy({ _tag: "TargetDependencySelector", pattern: "//...", target: "lib" }, {
      getOwnPropertyDescriptor: () => {
        invoked = true
        return undefined
      }
    })
    expect(Target.isDependencySelector(proxy)).toBe(false)
    expect(invoked).toBe(false)
    expect(Target.isDependencySelector(null)).toBe(false)
    expect(Target.isDependencySelector({ _tag: "Other", pattern: "//...", target: "lib" })).toBe(false)
    expect(Target.isDependencySelector({
      _tag: "TargetDependencySelector",
      pattern: `//${"x".repeat(4_096)}/...`,
      target: "lib"
    })).toBe(false)
    expect(Target.isDependencySelector({
      _tag: "TargetDependencySelector",
      pattern: "//...",
      target: "x".repeat(257)
    })).toBe(false)
  })

  it("recognizes only an own, immutable, well-formed target marker", () => {
    const target = Leaf({})
    expect(Target.isTarget(target)).toBe(true)

    let invoked = false
    const accessor = (): void => undefined
    Object.defineProperty(accessor, Target.TargetTypeId, {
      configurable: false,
      enumerable: false,
      get: () => {
        invoked = true
        return Target.metadata(target)
      }
    })
    expect(Target.isTarget(accessor)).toBe(false)
    expect(invoked).toBe(false)

    const malformed = (): void => undefined
    Object.defineProperty(malformed, Target.TargetTypeId, {
      configurable: false,
      enumerable: false,
      value: { target: "forged" },
      writable: false
    })
    expect(Target.isTarget(malformed)).toBe(false)
    expect(() => Target.metadata(malformed as never)).toThrow(/not a well-formed smithers build target/)
  })

  /**
   * A marker whose metadata is well formed except for one field. `{ target:
   * "forged" }` is refused by the first field it reads, so every collection
   * field below it went unchecked; each case here starts from real metadata
   * and breaks exactly one thing, which is the shape a forgery that copied a
   * genuine target and edited it would have.
   */
  const forged = (overrides: Readonly<Record<string, unknown>>): unknown => {
    const marker = (): void => undefined
    Object.defineProperty(marker, Target.TargetTypeId, {
      configurable: false,
      enumerable: false,
      value: { ...Target.metadata(Leaf({})), ...overrides },
      writable: false
    })
    return marker
  }

  it.each([
    ["accepts metadata copied from a real target", {}, true],
    ["refuses a kinds field that is not an array", { kinds: "build" }, false],
    ["refuses a kind the build system does not define", { kinds: ["deploy"] }, false],
    ["refuses a hole where a kind should be", { kinds: [, "build"] }, false],
    ["refuses a verb gate that is not an array of kinds", { verbGate: "build" }, false],
    ["refuses a verb gate naming an undefined kind", { verbGate: ["deploy"] }, false],
    ["refuses outputs that are not an object", { outputs: "dist" }, false],
    ["refuses outputs without a string cwd", { outputs: { cwd: 1, paths: [] } }, false],
    ["refuses outputs whose paths are not strings", { outputs: { cwd: ".", paths: [1] } }, false],
    ["accepts well-formed outputs and verb gate", {
      outputs: { cwd: ".", paths: ["dist/index.js"] },
      verbGate: ["build"]
    }, true]
  ])("%s", (_description, overrides, accepted) => {
    expect(Target.isTarget(forged(overrides))).toBe(accepted)
  })

  it("rejects target proxies without invoking their traps", () => {
    let invoked = false
    const proxy = new Proxy(Leaf({}), {
      getOwnPropertyDescriptor: () => {
        invoked = true
        return undefined
      },
      has: () => {
        invoked = true
        return true
      }
    })
    expect(Target.isTarget(proxy)).toBe(false)
    expect(invoked).toBe(false)
  })

  it("defaults arbitrary target implementations to non-cacheable", () => {
    expect(Target.metadata(Leaf({})).cacheable).toBe(false)
  })

  it("requires a target implementation to opt into cache replay explicitly", () => {
    const Deterministic = Target.make("RuleTestDeterministic", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      cache: true,
      implementation: () => Target.notImplemented("RuleTestDeterministic")
    })
    expect(Target.metadata(Deterministic({})).cacheable).toBe(true)
  })

  it("re-derives dependencies from verb-effective attrs", () => {
    const declared = Leaf({})
    const mapped = Leaf({})
    const declaredSelector = Target.subtree("//packages/...", "lib")
    const mappedSelector = Target.subtree("//apps/...", "lib")
    const Parent = Target.make("RuleTestMappedDependencies", {
      attrs: Schema.Struct({ dependency: Target.Target, selector: Target.DependencySelector }),
      kinds: ["build", "lint"],
      attrsForKind: (kind, attrs) => kind === "lint" ? { dependency: mapped, selector: mappedSelector } : attrs,
      implementation: () => Target.notImplemented("RuleTestMappedDependencies")
    })

    const metadata = Target.metadata(Parent({ dependency: declared, selector: declaredSelector }))
    expect(metadata.dependencies).toEqual([declared])
    expect(metadata.dependencySelectors).toEqual([declaredSelector])
    expect(metadata.forKind("build").dependencies).toEqual([declared])
    expect(metadata.forKind("build").dependencySelectors).toEqual([declaredSelector])
    expect(metadata.forKind("lint").dependencies).toEqual([mapped])
    expect(metadata.forKind("lint").dependencySelectors).toEqual([mappedSelector])
  })

  it("deduplicates structurally equal dependency selectors", () => {
    const Holder = Target.make("RuleTestSelectorDeduplication", {
      attrs: Schema.Struct({ dependencies: Schema.Array(Target.Dependency) }),
      kinds: ["build"],
      implementation: () => Target.notImplemented("RuleTestSelectorDeduplication")
    })
    const metadata = Target.metadata(Holder({
      dependencies: [
        Target.subtree("//packages/...", "lib"),
        Target.subtree("//packages/...", "lib")
      ]
    }))
    expect(metadata.dependencySelectors).toEqual([Target.subtree("//packages/...", "lib")])
  })

  it("does not recurse forever through a cyclic array", () => {
    const cyclic: Array<unknown> = []
    cyclic.push(cyclic)
    const Holder = Target.make("RuleTestCycle", {
      attrs: Schema.Struct({ value: Schema.Unknown }),
      kinds: ["build"],
      implementation: () => Target.notImplemented("RuleTestCycle")
    })

    expect(() => Holder({ value: cyclic })).not.toThrow()
  })

  it("refuses a Proxy without executing its traversal traps", () => {
    let invoked = false
    const proxy = new Proxy({}, {
      ownKeys: () => {
        invoked = true
        return []
      }
    })
    const Holder = Target.make("RuleTestProxy", {
      attrs: Schema.Struct({ value: Schema.Unknown }),
      kinds: ["build"],
      implementation: () => Target.notImplemented("RuleTestProxy")
    })

    expect(() => Holder({ value: proxy })).toThrow(/must not contain a Proxy/)
    expect(invoked).toBe(false)
  })

  it("changes implementation identity when a runtime contract changes", () => {
    const implementation = () => Target.notImplemented("RuleTestSchemaIdentity")
    const StringResult = Target.make("RuleTestSchemaIdentity", {
      attrs: Schema.Struct({ value: Schema.String }),
      kinds: ["build"],
      success: Schema.String,
      error: Target.NotImplemented,
      implementation
    })
    const NumberResult = Target.make("RuleTestSchemaIdentity", {
      attrs: Schema.Struct({ value: Schema.String }),
      kinds: ["build"],
      success: Schema.Number,
      error: Target.NotImplemented,
      implementation
    })

    expect(Target.metadata(StringResult({ value: "x" })).implementationDigest)
      .not.toBe(Target.metadata(NumberResult({ value: "x" })).implementationDigest)
  })

  it("keeps implementation identity stable across separately created, textually identical definitions", () => {
    // Content-key material: the same definition evaluated by two processes
    // (here, two separate function objects with one source) must agree, or a
    // cache filled by one run is unreadable by the next.
    const first = Target.make("RuleTestStableIdentity", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      implementation: () => Target.notImplemented("RuleTestStableIdentity")
    })
    const second = Target.make("RuleTestStableIdentity", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      implementation: () => Target.notImplemented("RuleTestStableIdentity")
    })
    expect(Target.metadata(first({})).implementationDigest).toBe(Target.metadata(second({})).implementationDigest)
    const changed = Target.make("RuleTestStableIdentity", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      implementation: () => Target.notImplemented("RuleTestStableIdentityChanged")
    })
    expect(Target.metadata(changed({})).implementationDigest).not.toBe(Target.metadata(first({})).implementationDigest)
  })

  it("changes implementation identity when cache admission policy changes", () => {
    const definition = (cache: boolean) =>
      Target.make("RuleTestCacheIdentity", {
        attrs: Schema.Struct({}),
        kinds: ["build"],
        cache,
        implementation: () => Target.notImplemented("RuleTestCacheIdentity")
      })
    expect(Target.metadata(definition(false)({})).implementationDigest)
      .not.toBe(Target.metadata(definition(true)({})).implementationDigest)
  })

  it("changes implementation identity when declared captures change", () => {
    const definition = (tool: string) =>
      Target.make("RuleTestCapturedIdentity", {
        attrs: Schema.Struct({}),
        kinds: ["build"],
        implementation: Node.capture({ tool }, () => Target.notImplemented(tool))
      })

    expect(Target.metadata(definition("first")({})).implementationDigest)
      .not.toBe(Target.metadata(definition("second")({})).implementationDigest)
  })
})

describe("Target implementation contract", () => {
  it("preserves inferred results when schemas are omitted", () => {
    const Inferred = Target.make("InferredResult", {
      attrs: Schema.Struct({}),
      kinds: ["test"],
      implementation: () => Node.succeed("report")
    })
    const target = Inferred({})
    expectTypeOf(Target.plan(target)).toEqualTypeOf<Node.Node<string>>()
    expect(Target.metadata(target).decodeSuccess("report")).toBe("report")
  })

  it("infers catalog refusal errors when no error schema is supplied", () => {
    const plan = Target.plan(Leaf({}))
    expectTypeOf<Node.Success<typeof plan>>().toEqualTypeOf<never>()
    expectTypeOf<Node.Error<typeof plan>>().toEqualTypeOf<Target.NotImplemented>()
  })

  it("infers either omitted channel while retaining the supplied schema", () => {
    const implementation = () => Exec.runTool({ cwd: ".", argv: ["true"], env: {} })
    const SuccessOnly = Target.make("SuccessOnly", {
      attrs: Schema.Struct({}),
      kinds: ["test"],
      success: Exec.Result,
      implementation
    })
    const ErrorOnly = Target.make("ErrorOnly", {
      attrs: Schema.Struct({}),
      kinds: ["test"],
      error: Exec.ExecError,
      implementation
    })
    expectTypeOf(Target.plan(SuccessOnly({}))).toEqualTypeOf<ReturnType<typeof implementation>>()
    expectTypeOf(Target.plan(ErrorOnly({}))).toEqualTypeOf<ReturnType<typeof implementation>>()
    const report = { exitCode: 0, stdout: "report", stderr: "" }
    expect(Target.metadata(SuccessOnly({})).decodeSuccess(report)).toEqual(report)
    expect(() => Target.metadata(SuccessOnly({})).decodeSuccess("wrong")).toThrow()
    expect(Target.metadata(ErrorOnly({})).decodeSuccess(report)).toEqual(report)
  })

  it("infers every implementation branch with or without a supplied schema", () => {
    const attrs = Schema.Struct({ numeric: Schema.Boolean })
    const implementation = (value: typeof attrs.Type) => {
      if (value.numeric) return Node.succeed(42)
      return Node.succeed("report")
    }
    const Inferred = Target.make("InferredBranches", { attrs, kinds: ["test"], implementation })
    const Declared = Target.make("DeclaredBranches", {
      attrs,
      kinds: ["test"],
      success: Schema.Union([Schema.Number, Schema.String]),
      implementation
    })
    expectTypeOf(Target.plan(Inferred({ numeric: true }))).toEqualTypeOf<Node.Node<number | string>>()
    expectTypeOf(Target.plan(Declared({ numeric: false }))).toEqualTypeOf<Node.Node<number | string>>()
    expect(Target.metadata(Inferred({ numeric: true })).decodeSuccess(42)).toBe(42)
    expect(Target.metadata(Declared({ numeric: false })).decodeSuccess("report")).toBe("report")
  })

  it("retains the declared tool rule contracts", () => {
    const run = Target.plan(ToolRun.ToolRun({ command: "true", args: [], inputs: [], deps: [] }))
    expectTypeOf<Node.Success<typeof run>>().toEqualTypeOf<Exec.Result>()
    expectTypeOf<Node.Error<typeof run>>().toEqualTypeOf<Exec.ExecError>()
    const build = Target.plan(ToolBuild.ToolBuild({
      tool: "true",
      command: "true",
      args: [],
      inputs: [],
      deps: [],
      outputs: [],
      env: {},
      cache: false
    }))
    expectTypeOf<Node.Success<typeof build>>().toEqualTypeOf<ToolBuild.Outputs>()
    expectTypeOf<Node.Error<typeof build>>().toEqualTypeOf<typeof ToolBuild.BuildError.Type>()
  })

  it("preserves Shell result and error types", () => {
    const plan = Target.plan(Shell.Test({ shell: "true" }))
    expectTypeOf<Node.Success<typeof plan>>().toEqualTypeOf<Exec.Result>()
    expectTypeOf<Node.Error<typeof plan>>().toEqualTypeOf<Exec.ExecError>()
    expectTypeOf(plan).toEqualTypeOf<ReturnType<typeof Exec.runTool>>()
  })
})

describe("Target declaration bounds", () => {
  const Bounded = Target.make("RuleTestDeclarationBounds", {
    attrs: Schema.Struct({ value: Schema.Unknown }),
    kinds: ["build"],
    implementation: () => Target.notImplemented("RuleTestDeclarationBounds")
  })

  // The author's object is walked at depth 0, so `nest(levels)` places its
  // innermost object at exactly `levels`.
  const nest = (levels: number): { readonly value: unknown } => {
    let value: unknown = {}
    for (let index = 1; index < levels; index += 1) value = { value }
    return { value }
  }

  // One member per own enumerable key, counted across the whole tree: the
  // `value` key plus every element of the array under it.
  const members = (count: number): { readonly value: unknown } => ({
    value: Array.from({ length: count - 1 }, () => 0)
  })

  it("accepts attrs nested to the depth bound", () => {
    expect(() => Bounded(nest(Target.maximumAttrsDepth - 1))).not.toThrow()
  })

  it("refuses attrs nested one level past the depth bound", () => {
    expect(() => Bounded(nest(Target.maximumAttrsDepth)))
      .toThrow(/attrs nest deeper than the declaration bound/)
  })

  it("accepts attrs carrying the member bound", () => {
    expect(() => Bounded(members(Target.maximumAttrsMembers))).not.toThrow()
  })

  it("refuses attrs carrying one member past the bound", () => {
    expect(() => Bounded(members(Target.maximumAttrsMembers + 1)))
      .toThrow(/attrs carry more members than the declaration bound/)
  })
})

describe("Target own __proto__ attrs", () => {
  const Configured = Target.make("RuleTestProtoConfig", {
    attrs: Schema.Struct({ config: Schema.Unknown }),
    kinds: ["build"],
    implementation: () => Target.notImplemented("RuleTestProtoConfig")
  })
  const Strict = Target.make("RuleTestProtoStrict", {
    attrs: Schema.Struct({ ordinary: Schema.String }),
    kinds: ["build"],
    implementation: () => Target.notImplemented("RuleTestProtoStrict")
  })
  const parsed = (json: string) => JSON.parse(json) as Record<string, unknown>
  const config = (target: Target.AnyTarget) =>
    (Target.metadata(target).attrs as { readonly config: Record<string, unknown> }).config

  it("keeps a string __proto__ key as own data", () => {
    const kept = config(Configured({ config: parsed("{\"ordinary\":\"kept\",\"__proto__\":\"kept\"}") }))
    expect(Object.keys(kept)).toEqual(["ordinary", "__proto__"])
    expect(Object.getOwnPropertyDescriptor(kept, "__proto__")?.value).toBe("kept")
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype)
  })

  it("keeps an object __proto__ key as own data and freezes the admitted config", () => {
    const kept = config(Configured({ config: parsed("{\"ordinary\":\"kept\",\"__proto__\":{\"nested\":\"kept\"}}") }))
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype)
    const special = Object.getOwnPropertyDescriptor(kept, "__proto__")?.value as Record<string, unknown>
    expect(special).toEqual({ nested: "kept" })
    expect(Object.isFrozen(kept)).toBe(true)
    expect(Object.isFrozen(special)).toBe(true)
    expect(() => {
      kept["ordinary"] = "changed"
    }).toThrow(TypeError)
  })

  it("keeps a __proto__ key beside presentation", () => {
    const target = Configured(
      { ...parsed("{\"summary\":\"Configured.\"}"), config: parsed("{\"__proto__\":\"kept\"}") } as never
    )
    expect(Target.metadata(target).presentation).toEqual({ summary: "Configured.", featured: false })
    expect(Object.getOwnPropertyDescriptor(config(target), "__proto__")?.value).toBe("kept")
  })

  it("keeps a __proto__ entry in a real record env", () => {
    const target = ToolBuild.ToolBuild({
      tool: "true",
      command: "true",
      args: [],
      inputs: [],
      deps: [],
      outputs: [],
      env: parsed("{\"ORDINARY\":\"kept\",\"__proto__\":\"kept\"}") as Record<string, string>,
      cache: false
    })
    const env = (Target.metadata(target).attrs as { readonly env: Record<string, string> }).env
    expect(Object.keys(env).sort()).toEqual(["ORDINARY", "__proto__"])
    expect(Object.getOwnPropertyDescriptor(env, "__proto__")?.value).toBe("kept")
  })

  it("refuses a __proto__ excess key as a strict schema refuses any unknown key", () => {
    expect(() => Strict(parsed("{\"ordinary\":\"kept\",\"unknown\":\"x\"}") as never)).toThrow(/unknown/)
    expect(() => Strict(parsed("{\"ordinary\":\"kept\",\"__proto__\":\"x\"}") as never)).toThrow(/__proto__/)
    expect(Target.metadata(Strict({ ordinary: "kept" })).attrs).toEqual({ ordinary: "kept" })
  })
})

describe("Target verb gate and kind mapping", () => {
  it("resolves a function verb gate against the declared attrs", () => {
    const Gated = Target.make("RuleTestVerbGateFunction", {
      attrs: Schema.Struct({ reviewed: Schema.Boolean }),
      kinds: ["build", "review"],
      verbGate: (attrs) => attrs.reviewed ? ["review", "review"] : undefined,
      implementation: () => Target.notImplemented("RuleTestVerbGateFunction")
    })

    expect(Target.metadata(Gated({ reviewed: true })).verbGate).toEqual(["review"])
    expect(Target.metadata(Gated({ reviewed: false })).verbGate).toBeUndefined()
  })

  it("digests the verb gate function, so changing it changes implementation identity", () => {
    const definition = (gate: () => ReadonlyArray<Target.Kind>) =>
      Target.make("RuleTestVerbGateIdentity", {
        attrs: Schema.Struct({}),
        kinds: ["build", "review"],
        verbGate: gate,
        implementation: () => Target.notImplemented("RuleTestVerbGateIdentity")
      })

    expect(Target.metadata(definition(() => ["build"])({})).implementationDigest)
      .not.toBe(Target.metadata(definition(() => ["review"])({})).implementationDigest)
  })

  it("names the verb when an attrsForKind mapping fails the attrs schema", () => {
    const Mapped = Target.make("RuleTestKindMappingRejected", {
      attrs: Schema.Struct({ mode: Schema.String }),
      kinds: ["build", "lint"],
      attrsForKind: (kind, attrs) => kind === "lint" ? { mode: 1 } as never : attrs,
      implementation: () => Target.notImplemented("RuleTestKindMappingRejected")
    })
    const metadata = Target.metadata(Mapped({ mode: "write" }))

    expect(metadata.forKind("build").attrs).toEqual({ mode: "write" })
    expect(() => metadata.forKind("lint")).toThrow(/RuleTestKindMappingRejected \(lint\) declaration/)
  })
})

describe("Target plan attrs", () => {
  const planned = () => {
    const seen: Array<string> = []
    const Planned = Target.make("RuleTestPlanAttrs", {
      attrs: Schema.Struct({ label: Schema.String }),
      kinds: ["build"],
      implementation: (attrs) => {
        seen.push(attrs.label)
        return Target.notImplemented("RuleTestPlanAttrs")
      }
    })
    return { seen, target: Planned({ label: "declared" }) }
  }

  it("plans the declared attrs when none are supplied", () => {
    const { seen, target } = planned()
    Target.plan(target)
    expect(seen).toEqual(["declared"])
  })

  it("plans explicit attrs in place of the declared ones", () => {
    const { seen, target } = planned()
    Target.plan(target, { label: "override" })
    expect(seen).toEqual(["override"])
  })

  it("refuses explicit plan attrs carrying an unknown key", () => {
    const { seen, target } = planned()
    expect(() => Target.plan(target, { label: "override", typo: true } as never)).toThrow()
    expect(seen).toEqual([])
  })
})

// Compiled by tsconfig.test.json without executing invalid declarations.
const implementationContract = () => {
  Target.make("MismatchedSuccess", {
    attrs: Schema.Struct({}),
    kinds: ["test"],
    success: Schema.Number,
    // @ts-expect-error A string implementation cannot satisfy a Number schema.
    implementation: () => Node.succeed("wrong")
  })
  Target.make("MismatchedError", {
    attrs: Schema.Struct({}),
    kinds: ["test"],
    success: Exec.Result,
    error: Schema.Never,
    // @ts-expect-error An ExecError implementation cannot satisfy a Never schema.
    implementation: () => Exec.runTool({ cwd: ".", argv: ["true"], env: {} })
  })
}
void implementationContract
