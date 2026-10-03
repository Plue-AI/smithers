/**
 * The two JavaScript-program targets: what argv each one renders, and which
 * verb each one participates in.
 *
 * These replaced the `node --test …` and `node scripts/….mjs` strings a
 * PACKAGE.ts file used to carry. The interpreter comes from the declared runtime,
 * so switching interpreters changes argv. Explicit deadlines reach Exec without
 * changing the default budget or making the test cacheable.
 */
import { describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as Input from "../src/Input.ts"
import * as NodeBinary from "../src/NodeBinary.ts"
import * as NodeTest from "../src/NodeTest.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Target from "../src/Target.ts"
import { plannedCalls } from "../test-support/plan.ts"
import { packageManager, runtime } from "./toolchain.ts"

const bun = Runtime.Bun({ version: ">=1.4.0" })

const attrsOf = <A>(target: unknown): A => Target.metadata(target as never).attrs as A

describe("NodeTest", () => {
  it("runs declared test files through the runtime's own test runner", () => {
    const attrs = attrsOf<NodeTest.Attrs>(NodeTest.NodeTest({
      runtime,
      runner: NodeTest.testRunner([
        Input.file("//scripts/pack-release.test.mjs"),
        Input.file("//scripts/flows-backup.test.mjs")
      ]),
      srcs: [],
      deps: []
    }))
    expect(NodeTest.runArgv(attrs)).toEqual([
      "node",
      "--test",
      "scripts/pack-release.test.mjs",
      "scripts/flows-backup.test.mjs"
    ])
  })

  it("spells the test runner the way the declared runtime spells it", () => {
    const attrs = attrsOf<NodeTest.Attrs>(NodeTest.NodeTest({
      runtime: bun,
      runner: NodeTest.testRunner([Input.file("//scripts/pack-release.test.mjs")]),
      srcs: [],
      deps: []
    }))
    expect(NodeTest.runArgv(attrs)).toEqual(["bun", "test", "scripts/pack-release.test.mjs"])
    expect(Runtime.test(runtime, ["a.mjs"])).toEqual(["node", "--test", "a.mjs"])
    expect(Runtime.test(bun, ["a.mjs"])).toEqual(["bun", "test", "a.mjs"])
  })

  it("runs a whole suite by directory under the runtime's own runner", () => {
    // The shape of a package's unit gate: `bun test src`, `node --test src`.
    // The paths are filters relative to cwd; the declared srcs carry the key
    // material.
    const attrs = attrsOf<NodeTest.Attrs>(NodeTest.NodeTest({
      runtime: bun,
      runner: NodeTest.testSuite(["src", "scripts"]),
      srcs: [],
      deps: [],
      cwd: "apps/server"
    }))
    expect(NodeTest.runArgv(attrs)).toEqual(["bun", "test", "src", "scripts"])
    expect(attrs.cwd).toBe("apps/server")
    expect(NodeTest.runArgv(attrsOf<NodeTest.Attrs>(NodeTest.NodeTest({
      runtime,
      runner: NodeTest.testSuite(["src"]),
      srcs: [],
      deps: []
    })))).toEqual(["node", "--test", "src"])
  })

  it("plans isolated Bun argv only when the suite opts in", () => {
    for (const isolate of [undefined, false, true]) {
      for (const declared of [bun, runtime]) {
        const runner = isolate === undefined
          ? NodeTest.testSuite(["src"])
          : NodeTest.testSuite(["src"], { isolate })
        const target = NodeTest.NodeTest({
          runtime: declared,
          runner,
          srcs: [],
          deps: [],
          cwd: "apps/app"
        })
        const payload = Exec.Payload.make(plannedCalls(target)[0]!.payload as never)
        expect(payload.argv).toEqual(
          declared === bun
            ? ["bun", "test", ...(isolate === true ? ["--isolate"] : []), "src"]
            : ["node", "--test", "src"]
        )
        expect(payload.cwd).toBe("apps/app")
      }
    }
  })

  it("runs an entry point with its declared arguments", () => {
    const attrs = attrsOf<NodeTest.Attrs>(NodeTest.NodeTest({
      runtime,
      runner: NodeTest.entrypoint(Input.file("//scripts/smoke-release.mjs"), ["dist/release-packs"]),
      srcs: [],
      deps: []
    }))
    expect(NodeTest.runArgv(attrs)).toEqual(["node", "scripts/smoke-release.mjs", "dist/release-packs"])
  })

  it("bounds long-running entrypoints explicitly while keeping the default and fresh execution", () => {
    for (const [timeout, milliseconds] of [[undefined, 600_000], ["30m", 1_800_000], ["125ms", 125]] as const) {
      const target = NodeTest.NodeTest({
        runtime,
        runner: NodeTest.entrypoint(Input.file("scripts/smoke-release.mjs")),
        srcs: [],
        deps: [],
        ...(timeout === undefined ? {} : { timeout })
      })
      expect(Exec.Payload.make(plannedCalls(target)[0]!.payload as never).timeoutMs).toBe(milliseconds)
      expect(Target.metadata(target).cacheable).toBe(false)
    }
  })

  it("refuses invalid or unbounded entrypoint deadlines", () => {
    for (const timeout of ["unbounded", "0ms", "-1s", "1.5m", "never", "25h", `${"9".repeat(400)}s`]) {
      expect(() =>
        NodeTest.NodeTest({
          runtime,
          runner: NodeTest.entrypoint(Input.file("scripts/smoke-release.mjs")),
          srcs: [],
          deps: [],
          timeout
        })
      ).toThrow()
    }
  })

  it("keeps a package-relative entry point relative to its cwd", () => {
    const attrs = attrsOf<NodeTest.Attrs>(NodeTest.NodeTest({
      runtime,
      runner: NodeTest.entrypoint(Input.file("scripts/circular.mjs")),
      srcs: [],
      deps: [],
      cwd: "packages/smithers/flows/plan"
    }))
    expect(NodeTest.runArgv(attrs)).toEqual(["node", "scripts/circular.mjs"])
    expect(attrs.cwd).toBe("packages/smithers/flows/plan")
  })

  /**
   * The runner is a discriminated union, so the fields one form does not have
   * are fields a PACKAGE.ts file cannot write: no argument list on a test-runner
   * run, no file list on an entry-point run, and never both.
   */
  it("refuses a runner that is neither form", () => {
    const declare = (runner: unknown): unknown =>
      NodeTest.NodeTest({ runtime, runner: runner as never, srcs: [], deps: [] })
    expect(() => declare({ name: "test-runner", tests: [] })).toThrow()
    expect(() => declare({ name: "suite", paths: [] })).toThrow()
    expect(() => declare({ name: "entrypoint" })).toThrow()
    expect(() => declare({ name: "shell", command: "node --test a.mjs" })).toThrow()
    // A field the chosen form does not have is a rejected declaration, so it
    // cannot smuggle an interpreter flag past the runner union.
    expect(() =>
      declare({
        name: "test-runner",
        tests: [Input.file("a.mjs")],
        args: ["--experimental-loader", "./evil.mjs"]
      })
    ).toThrow(/excess property/)
  })

  it("participates in the test verb alone", () => {
    expect(NodeTest.NodeTest.kinds).toEqual(["test"])
  })
})

describe("NodeBinary", () => {
  it("runs an entry point under the declared runtime, in the build verb", () => {
    const target = NodeBinary.NodeBinary({
      runtime,
      entry: Input.file("//scripts/pack-release.mjs"),
      args: ["dist/release-packs"],
      srcs: [],
      deps: []
    })
    expect(NodeBinary.runArgv(attrsOf<NodeBinary.Attrs>(target)))
      .toEqual(["node", "scripts/pack-release.mjs", "dist/release-packs"])
    expect(NodeBinary.NodeBinary.kinds).toEqual(["build"])
    // Its product is written through tools the build system does not own, so a
    // stored result would not identify what produced it.
    expect(Target.metadata(target as never).cacheable).toBe(false)
  })

  it("passes a declared environment to the run", () => {
    const attrs = attrsOf<NodeBinary.Attrs>(NodeBinary.NodeBinary({
      runtime,
      entry: Input.file("//crates/flows-jj/build-wasm.mjs"),
      args: [],
      srcs: [],
      deps: [],
      env: { CARGO_TARGET_DIR: "target/scratch" }
    }))
    expect(attrs.env).toEqual({ CARGO_TARGET_DIR: "target/scratch" })
  })

  it("accepts a workspace subtree as a graph dependency", () => {
    const selector = Target.subtree("//packages/...", "lib")
    const target = NodeBinary.NodeBinary({
      runtime,
      entry: Input.file("//scripts/pack-release.mjs"),
      args: [],
      srcs: [],
      deps: [selector]
    })
    expect(Target.metadata(target).dependencies).toEqual([])
    expect(Target.metadata(target).dependencySelectors).toEqual([selector])
  })
})
