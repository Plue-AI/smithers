import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import * as Scope from "effect/Scope"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const login = "/root/.claude/.credentials.json"

const provider = () =>
  Sandbox.TestSession.make({
    session: "main",
    files: { "/sandbox/README.md": "parent tree", [login]: "refresh-token" },
    credentials: [login]
  })

describe("Sandbox.fanOut", () => {
  it.effect("forks children from the parent's tree without its credentials", () =>
    Effect.gen(function*() {
      const machines = provider()
      const scope = yield* Scope.make()
      const children = yield* Effect.gen(function*() {
        const parent = yield* machines.acquire("main")
        yield* parent.writeFile("/sandbox/late.txt", encoder.encode("written before the fork"))
        return yield* Sandbox.fanOut(parent, { count: 3, concurrency: 2 })
      }).pipe(Scope.provide(scope))

      const batch = children[0]!.id.replace(/\/child-0$/, "")
      expect(batch).toMatch(/^main\/[0-9a-f-]{36}$/)
      expect(children.map((child) => child.id)).toEqual([0, 1, 2].map((n) => `${batch}/child-${n}`))
      expect(machines.state.forked).toEqual([`${batch}/base`, ...children.map((child) => child.id)])
      for (const child of children) {
        expect(decoder.decode(yield* child.readFile("/sandbox/README.md"))).toBe("parent tree")
        expect(decoder.decode(yield* child.readFile("/sandbox/late.txt"))).toBe("written before the fork")
        const signedIn = yield* Effect.flip(child.readFile(login))
        expect(signedIn.code).toBe("not_found")
      }

      // Children are separate machines: a child's write stays in the child.
      yield* children[0]!.writeFile("/sandbox/README.md", encoder.encode("child edit"))
      expect(decoder.decode(machines.state.files.get("/sandbox/README.md")!)).toBe("parent tree")
      expect(decoder.decode(machines.state.children.get(`${batch}/child-1`)!.get("/sandbox/README.md")!))
        .toBe("parent tree")

      // Closing the parent's scope releases the base and every child with it.
      yield* Scope.close(scope, Exit.void)
      expect(machines.state.children.size).toBe(0)
      expect(machines.state.released).toBe(5)
    }))

  it.effect("releases the children it forked when a later fork fails", () =>
    Effect.gen(function*() {
      const failure = new ProviderError({ code: "unavailable", message: "no capacity" })
      const refusing = Sandbox.TestSession.make({ forkFailure: failure })
      const outcome = yield* Effect.scoped(
        Effect.flatMap(refusing.acquire("main"), (parent) => Effect.flip(Sandbox.fanOut(parent, { count: 2 })))
      )
      expect(outcome).toBe(failure)
      expect(refusing.state.forked).toEqual([])

      let forks = 0
      const machines = provider()
      const flaky = yield* Effect.scoped(
        Effect.gen(function*() {
          const parent = yield* machines.acquire("main")
          const failing: Sandbox.Session = {
            ...parent,
            fork: (key) =>
              Effect.map(parent.fork!(key), (base): Sandbox.Session => ({
                ...base,
                fork: (child) => ++forks === 3 ? Effect.fail(failure) : base.fork!(child)
              }))
          }
          return yield* Effect.exit(Sandbox.fanOut(failing, { count: 4, concurrency: 1 }))
        })
      )
      expect(Exit.isFailure(flaky)).toBe(true)
      expect(machines.state.forked).toHaveLength(3)
      expect(machines.state.forked[0]).toMatch(/\/base$/)
      expect(machines.state.children.size).toBe(0)
      expect(machines.state.released).toBe(4)
    }))

  it.effect("fails with unavailable when the machine cannot fork", () =>
    Effect.gen(function*() {
      const machines = provider()
      const error = yield* Effect.scoped(
        Effect.flatMap(machines.acquire("main"), (parent) => {
          const { fork: _, ...cannotFork } = parent
          return Effect.flip(Sandbox.fanOut(cannotFork, { count: 1 }))
        })
      )
      expect(error.code).toBe("unavailable")
      expect(error.message).toContain("main")
    }))

  it.effect("forks every child of a batch from one base, and never reuses a batch", () =>
    Effect.gen(function*() {
      const machines = provider()
      yield* Effect.scoped(
        Effect.gen(function*() {
          const parent = yield* machines.acquire("main")
          const [first] = yield* Sandbox.fanOut(parent, { count: 1 })
          const [second] = yield* Sandbox.fanOut(parent, { count: 1 })
          expect(first!.id).not.toBe(second!.id)
          // The base keeps the batch's tree while the parent changes.
          const base = first!.id.replace(/child-0$/, "base")
          yield* parent.writeFile("/sandbox/README.md", encoder.encode("parent moved on"))
          expect(decoder.decode(machines.state.children.get(base)!.get("/sandbox/README.md")!)).toBe("parent tree")
        })
      )
    }))

  it.effect("fails with unavailable when the base cannot fork", () =>
    Effect.gen(function*() {
      const machines = provider()
      const error = yield* Effect.scoped(
        Effect.flatMap(machines.acquire("main"), (parent) => {
          const baseless: Sandbox.Session = {
            ...parent,
            fork: (key) => Effect.map(parent.fork!(key), ({ fork: _, ...base }): Sandbox.Session => base)
          }
          return Effect.flip(Sandbox.fanOut(baseless, { count: 1 }))
        })
      )
      expect(error.code).toBe("unavailable")
      expect(error.message).toContain("/base")
    }))

  it("bounds the count and the concurrency before forking anything", () => {
    const machines = provider()
    const parent = {
      id: "main",
      remoteId: "r",
      workdir: "/sandbox",
      spawn: () => Effect.die("unused"),
      readFile: () => Effect.die("unused"),
      writeFile: () => Effect.die("unused"),
      fork: () => Effect.die("never called")
    } satisfies Sandbox.Session
    for (const count of [0, -1, 1.5, Number.NaN, Sandbox.maxFanOut + 1]) {
      expect(() => Sandbox.fanOut(parent, { count })).toThrow(RangeError)
    }
    for (const concurrency of [0, 2.5]) {
      expect(() => Sandbox.fanOut(parent, { count: 1, concurrency })).toThrow(RangeError)
    }
    expect(Sandbox.maxFanOut).toBe(128)
    expect(machines.state.forked).toEqual([])
  })

  it.effect("forks the full hard cap", () =>
    Effect.gen(function*() {
      const machines = provider()
      const count = yield* Effect.scoped(
        Effect.flatMap(
          machines.acquire("main"),
          (parent) => Effect.map(Sandbox.fanOut(parent, { count: Sandbox.maxFanOut }), (children) => children.length)
        )
      )
      expect(count).toBe(128)
      expect(machines.state.released).toBe(130)
    }))
})
