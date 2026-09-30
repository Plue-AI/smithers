import { describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import { Effect, Fiber, Latch, Ref } from "effect"
import * as FastCheck from "fast-check"
import * as CapabilitySets from "../src/CapabilitySet.ts"

const actions = [
  "fs:read",
  "fs:write",
  "net:get",
  "net:post",
  "proc:spawn",
  "jj:status",
  "jj:diff",
  "jj:snapshot",
  "jj:restore",
  "jj:workspace-add",
  "jj:workspace-forget"
] as const

const patternActions = [
  ...actions,
  "fs:*",
  "net:*",
  "proc:*",
  "jj:*",
  "*"
] as const

const patternResources = [
  "**",
  "src/**",
  "test/**",
  "*.ts",
  "src/*.ts",
  "src/?ain.ts",
  "/workspace/**",
  "*.example.com",
  "api.example.com",
  "git",
  "npm *",
  "jj"
] as const

const capabilityResources = [
  "src/index.ts",
  "src/main.ts",
  "test/CapabilitySet.test.ts",
  "README.md",
  "/workspace/file.txt",
  "api.example.com",
  "www.example.com",
  "git",
  "npm test",
  "jj"
] as const

const patternArbitrary = FastCheck
  .tuple(
    FastCheck.constantFrom(...patternActions),
    FastCheck.constantFrom(...patternResources)
  )
  .map(([action, resource]) => new CapabilityPattern({ action, resource }))

const capabilityArbitrary = FastCheck
  .tuple(
    FastCheck.constantFrom(...actions),
    FastCheck.constantFrom(...capabilityResources)
  )
  .map(([action, resource]) => new Capability({ action, resource }))

const unrestricted = Effect.runSync(CapabilitySets.current)

const setArbitrary = FastCheck
  .array(FastCheck.array(patternArbitrary, { maxLength: 5 }), { maxLength: 4 })
  .map((groups) =>
    groups.reduce(
      (set, group) => CapabilitySets.intersect(set, CapabilitySets.fromPatterns(group)),
      unrestricted
    )
  )

const check = <Ts extends [unknown, ...unknown[]]>(
  arbitraries: { [K in keyof Ts]: FastCheck.Arbitrary<Ts[K]> },
  predicate: (...values: Ts) => boolean
): void => {
  FastCheck.assert(
    FastCheck.property(...arbitraries, predicate),
    { numRuns: 200 }
  )
}

describe("CapabilitySet", () => {
  it("normalizes pattern and group ordering and removes duplicates", () => {
    const read = new CapabilityPattern({ action: "fs:read", resource: "src/**" })
    const get = new CapabilityPattern({ action: "net:get", resource: "*.example.com" })
    const left = CapabilitySets.fromPatterns([get, read, read])
    const right = CapabilitySets.fromPatterns([read, get])

    expect(CapabilitySets.equals(left, right)).toBe(true)
    expect(left.groups).toEqual([[read, get]])
    expect(CapabilitySets.intersect(left, right).groups).toHaveLength(1)
  })

  it("compares both the number and contents of authority groups", () => {
    const read = new CapabilityPattern({ action: "fs:read", resource: "src/**" })
    const write = new CapabilityPattern({ action: "fs:write", resource: "src/**" })
    const one = CapabilitySets.fromPatterns([read])
    const two = CapabilitySets.intersect(one, CapabilitySets.fromPatterns([write]))
    const different = CapabilitySets.fromPatterns([write])
    expect(CapabilitySets.equals(one, two)).toBe(false)
    expect(CapabilitySets.equals(one, different)).toBe(false)
  })

  it("snapshots and freezes every authority pattern", () => {
    const input = new CapabilityPattern({ action: "net:get", resource: "safe.example" })
    const set = CapabilitySets.fromPatterns([input])
    const safe = new Capability({ action: "net:get", resource: "safe.example" })
    const evil = new Capability({ action: "net:get", resource: "evil.example" })
    ;(input as { resource: string }).resource = "**"
    expect(CapabilitySets.allows(set, safe)).toBe(true)
    expect(CapabilitySets.allows(set, evil)).toBe(false)
    expect(() => {
      ;(set.groups[0]![0] as { resource: string }).resource = "**"
    }).toThrow(TypeError)
    expect(CapabilitySets.allows(set, evil)).toBe(false)
  })

  it("requires every group to match while each group is any-of", () => {
    const set = CapabilitySets.intersect(
      CapabilitySets.fromPatterns([
        new CapabilityPattern({ action: "fs:read", resource: "src/**" }),
        new CapabilityPattern({ action: "net:get", resource: "*.example.com" })
      ]),
      CapabilitySets.fromPatterns([
        new CapabilityPattern({ action: "fs:*", resource: "src/**" })
      ])
    )

    expect(CapabilitySets.allows(
      set,
      new Capability({ action: "fs:read", resource: "src/index.ts" })
    )).toBe(true)
    expect(CapabilitySets.allows(
      set,
      new Capability({ action: "net:get", resource: "api.example.com" })
    )).toBe(false)
  })

  it("intersect is commutative", () => {
    check([setArbitrary, setArbitrary], (left, right) =>
      CapabilitySets.equals(
        CapabilitySets.intersect(left, right),
        CapabilitySets.intersect(right, left)
      ))
  })

  it("intersect is associative", () => {
    check([setArbitrary, setArbitrary, setArbitrary], (left, middle, right) =>
      CapabilitySets.equals(
        CapabilitySets.intersect(CapabilitySets.intersect(left, middle), right),
        CapabilitySets.intersect(left, CapabilitySets.intersect(middle, right))
      ))
  })

  it("intersect is idempotent", () => {
    check([setArbitrary], (set) => CapabilitySets.equals(CapabilitySets.intersect(set, set), set))
  })

  it("unrestricted is the identity", () => {
    check([setArbitrary], (set) =>
      CapabilitySets.equals(
        CapabilitySets.intersect(set, unrestricted),
        set
      ) &&
      CapabilitySets.equals(
        CapabilitySets.intersect(unrestricted, set),
        set
      ))
  })

  it("none is absorbing", () => {
    check([setArbitrary], (set) =>
      CapabilitySets.equals(
        CapabilitySets.intersect(set, CapabilitySets.none),
        CapabilitySets.none
      ) &&
      CapabilitySets.equals(
        CapabilitySets.intersect(CapabilitySets.none, set),
        CapabilitySets.none
      ))
  })

  it("intersection never admits a capability rejected by either operand", () => {
    check(
      [setArbitrary, setArbitrary, capabilityArbitrary],
      (left, right, capability) =>
        !CapabilitySets.allows(
          CapabilitySets.intersect(left, right),
          capability
        ) ||
        (
          CapabilitySets.allows(left, capability) &&
          CapabilitySets.allows(right, capability)
        )
    )
  })

  it.effect("attenuate nesting only shrinks child authority", () =>
    Effect.gen(function*() {
      const parentPatterns = [
        new CapabilityPattern({ action: "fs:*", resource: "src/**" }),
        new CapabilityPattern({ action: "net:get", resource: "*.example.com" })
      ]
      const childPatterns = [
        new CapabilityPattern({ action: "fs:read", resource: "src/**" }),
        new CapabilityPattern({ action: "proc:spawn", resource: "**" })
      ]
      const capabilities = [
        new Capability({ action: "fs:read", resource: "src/index.ts" }),
        new Capability({ action: "fs:write", resource: "src/index.ts" }),
        new Capability({ action: "net:get", resource: "api.example.com" }),
        new Capability({ action: "proc:spawn", resource: "git" }),
        new Capability({ action: "fs:read", resource: "README.md" })
      ]

      const result = yield* (
        Effect.gen(function*() {
          const root = yield* CapabilitySets.current
          const nested = yield* CapabilitySets.attenuate(parentPatterns)(
            Effect.gen(function*() {
              const parent = yield* CapabilitySets.current
              const child = yield* CapabilitySets.attenuate(childPatterns)(
                CapabilitySets.current
              )
              return { parent, child }
            })
          )
          const after = yield* CapabilitySets.current
          return { after, nested, root }
        })
      )

      expect(CapabilitySets.equals(result.root, unrestricted)).toBe(true)
      expect(CapabilitySets.equals(result.after, result.root)).toBe(true)
      expect(capabilities.every((capability) =>
        !CapabilitySets.allows(result.nested.child, capability) ||
        CapabilitySets.allows(result.nested.parent, capability)
      )).toBe(true)
      expect(CapabilitySets.allows(
        result.nested.child,
        new Capability({ action: "fs:read", resource: "src/index.ts" })
      )).toBe(true)
      expect(CapabilitySets.allows(
        result.nested.child,
        new Capability({ action: "net:get", resource: "api.example.com" })
      )).toBe(false)
    }))

  it.effect("isolates parallel sibling attenuation through fork and join", () =>
    Effect.gen(function*() {
      const filePatterns = [new CapabilityPattern({ action: "fs:read", resource: "src/**" })]
      const networkPatterns = [new CapabilityPattern({ action: "net:get", resource: "*.example.com" })]
      const file = new Capability({ action: "fs:read", resource: "src/index.ts" })
      const network = new Capability({ action: "net:get", resource: "api.example.com" })

      const result = yield* (
        Effect.gen(function*() {
          const arrived = yield* Ref.make(0)
          const barrier = yield* Latch.make(false)
          const child = (patterns: ReadonlyArray<CapabilityPattern>) =>
            CapabilitySets.attenuate(patterns)(
              Effect.gen(function*() {
                const count = yield* Ref.updateAndGet(arrived, (value) => value + 1)
                if (count === 2) yield* Latch.open(barrier)
                yield* Latch.await(barrier)
                return yield* CapabilitySets.current
              })
            )
          const left = yield* child(filePatterns).pipe(Effect.forkChild({ startImmediately: true }))
          const right = yield* child(networkPatterns).pipe(Effect.forkChild({ startImmediately: true }))
          const children = yield* Effect.all([Fiber.join(left), Fiber.join(right)])
          const parent = yield* CapabilitySets.current
          return { children, parent }
        })
      )

      expect(CapabilitySets.allows(result.children[0], file)).toBe(true)
      expect(CapabilitySets.allows(result.children[0], network)).toBe(false)
      expect(CapabilitySets.allows(result.children[1], file)).toBe(false)
      expect(CapabilitySets.allows(result.children[1], network)).toBe(true)
      expect(CapabilitySets.equals(result.parent, unrestricted)).toBe(true)
    }))

  it.effect("attenuateGroups intersects every group and preserves the parent scope", () =>
    Effect.gen(function*() {
      const read = new Capability({ action: "fs:read", resource: "src/index.ts" })
      const write = new Capability({ action: "fs:write", resource: "src/index.ts" })
      const other = new Capability({ action: "fs:read", resource: "test/index.ts" })
      const parent = [new CapabilityPattern({ action: "fs:*", resource: "src/**" })]
      const groups = [
        [new CapabilityPattern({ action: "fs:read", resource: "**" })],
        [new CapabilityPattern({ action: "*", resource: "src/index.ts" })]
      ]
      const scoped = yield* CapabilitySets.attenuate(parent)(
        CapabilitySets.attenuateGroups(groups)(CapabilitySets.current)
      )
      expect(CapabilitySets.allows(scoped, read)).toBe(true)
      expect(CapabilitySets.allows(scoped, write)).toBe(false)
      expect(CapabilitySets.allows(scoped, other)).toBe(false)
      expect(CapabilitySets.equals(yield* CapabilitySets.current, unrestricted)).toBe(true)
    }))

  it.effect("an empty group denies, while zero groups inherit", () =>
    Effect.gen(function*() {
      const allowed = new Capability({ action: "fs:read", resource: "src/index.ts" })
      const parent = [new CapabilityPattern({ action: "fs:read", resource: "src/**" })]
      const inherited = yield* CapabilitySets.attenuate(parent)(
        CapabilitySets.attenuateGroups([])(CapabilitySets.current)
      )
      const denied = yield* CapabilitySets.attenuate(parent)(
        CapabilitySets.attenuateGroups([[]])(CapabilitySets.current)
      )
      expect(CapabilitySets.allows(inherited, allowed)).toBe(true)
      expect(CapabilitySets.equals(denied, CapabilitySets.none)).toBe(true)
    }))

  it("allows every capability on a fiber with no ambient capability set (B8)", () => {
    // Recorded as intended, not merely observed. The default is `unrestricted`
    // because it is the identity element of `intersect`, and `intersect` is the
    // only way authority ever moves: `CurrentCapabilities` is module-private
    // and `attenuate` is its only writer. `none` is the absorbing element of
    // the same operation, so defaulting to it would close the ceiling
    // permanently — the sibling cell below pins that no exported operation can
    // widen a fiber back. A fail-closed ceiling needs a root grant primitive,
    // not a different default.
    //
    // The ceiling is not what makes the kernel fail closed: `GrantStore.check`
    // consults it and then evaluates the ruleset, whose default verdict is
    // `ask`, which an unattended store turns into `PermissionRequired`.
    const ambient = Effect.runSync(CapabilitySets.current)

    for (const action of actions) {
      for (const resource of capabilityResources) {
        expect(CapabilitySets.allows(ambient, new Capability({ action, resource }))).toBe(true)
      }
    }
    // It is the identity element: attenuating from it yields exactly the
    // patterns attenuated with, so nothing is inherited from the default.
    const scoped = CapabilitySets.intersect(ambient, CapabilitySets.fromPatterns([]))
    expect(CapabilitySets.equals(scoped, CapabilitySets.none)).toBe(true)
  })

  it("fromGroups normalizes transported groups exactly as intersect does", () => {
    const read = new CapabilityPattern({ action: "fs:read", resource: "src/**" })
    const get = new CapabilityPattern({ action: "net:get", resource: "*.example.com" })
    const intersected = CapabilitySets.intersect(
      CapabilitySets.fromPatterns([get, read]),
      CapabilitySets.fromPatterns([read])
    )
    const transported = CapabilitySets.fromGroups([[read], [read, get], [read]])
    expect(CapabilitySets.equals(transported, intersected)).toBe(true)
    expect(CapabilitySets.equals(CapabilitySets.fromGroups([]), unrestricted)).toBe(true)
    expect(CapabilitySets.equals(CapabilitySets.fromGroups([[read], []]), CapabilitySets.none)).toBe(true)
    check([setArbitrary], (set) => CapabilitySets.equals(CapabilitySets.fromGroups(set.groups), set))
  })

  it("within proves containment and never proves a wider inner authority", () => {
    const universal = new CapabilityPattern({ action: "*", resource: "**" })
    const read = new CapabilityPattern({ action: "fs:read", resource: "src/**" })
    const readAll = new CapabilityPattern({ action: "fs:read", resource: "**" })
    const write = new CapabilityPattern({ action: "fs:write", resource: "src/**" })
    const readSrc = CapabilitySets.fromPatterns([read])
    const declared = CapabilitySets.fromPatterns([universal])
    // Omitted and declared `*` are both the whole authority.
    expect(CapabilitySets.within(declared, unrestricted)).toBe(true)
    expect(CapabilitySets.within(unrestricted, declared)).toBe(true)
    // Narrower within wider, not the reverse.
    expect(CapabilitySets.within(readSrc, CapabilitySets.fromPatterns([readAll]))).toBe(true)
    expect(CapabilitySets.within(CapabilitySets.fromPatterns([readAll]), readSrc)).toBe(false)
    expect(CapabilitySets.within(readSrc, unrestricted)).toBe(true)
    expect(CapabilitySets.within(unrestricted, readSrc)).toBe(false)
    // Empty authority is within everything; nothing wider is within it.
    expect(CapabilitySets.within(CapabilitySets.none, readSrc)).toBe(true)
    expect(CapabilitySets.within(readSrc, CapabilitySets.none)).toBe(false)
    // Any one inner group may prove a group of outer; every outer group must be proven.
    const both = CapabilitySets.intersect(readSrc, CapabilitySets.fromPatterns([read, write]))
    expect(CapabilitySets.within(both, readSrc)).toBe(true)
    expect(CapabilitySets.within(CapabilitySets.fromPatterns([read, write]), readSrc)).toBe(false)
    expect(CapabilitySets.within(readSrc, CapabilitySets.intersect(readSrc, CapabilitySets.fromPatterns([write]))))
      .toBe(false)
    // An unprovable glob relationship is refused rather than guessed.
    const star = CapabilitySets.fromPatterns([new CapabilityPattern({ action: "fs:read", resource: "src/*.ts" })])
    expect(CapabilitySets.within(readSrc, star)).toBe(false)
    check([setArbitrary], (set) => CapabilitySets.within(set, set))
    // Soundness: a proven containment never admits a capability outer rejects.
    check(
      [setArbitrary, setArbitrary, capabilityArbitrary],
      (inner, outer, capability) =>
        !CapabilitySets.within(inner, outer) || !CapabilitySets.allows(inner, capability) ||
        CapabilitySets.allows(outer, capability)
    )
  })

  it("exports no authority-widening API", () => {
    expect(Object.keys(CapabilitySets).sort()).toEqual([
      "allows",
      "attenuate",
      "attenuateGroups",
      "current",
      "equals",
      "fromGroups",
      "fromPatterns",
      "intersect",
      "none",
      "within"
    ])
  })
})
