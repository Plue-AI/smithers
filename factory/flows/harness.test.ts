import { afterEach, describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { libraryPackages } from "../../scripts/workspace-packages.mjs"
import { agentPermissionRules, agentSpawnSpec, listWorkspacePackages, makeConfinementValidator, REPO_ROOT, runProcess, selectPackages } from "./harness.ts"

const temporaryRoots: string[] = []
afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true })
})

describe("factory harness guards", () => {
  test("workspace package identities are read from exact manifests", () => {
    const packages = listWorkspacePackages()
    expect(packages.length).toBeGreaterThan(0)
    expect(packages).toEqual(libraryPackages().map(({ dir, name }) => ({ dir, name })))
    expect(packages).toContainEqual({ dir: "packages/smithers", name: "@smthrs/cli" })
    expect(packages).toContainEqual({ dir: "packages/smthrs-deprecation", name: "smthrs" })
    expect(packages).toContainEqual({ dir: "packages/smithers/flows/flow", name: "@smthrs/flow" })
    for (const pkg of packages) {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, pkg.dir, "package.json"), "utf8"))
      expect(pkg.name).toBe(manifest.name)
    }
  })

  test("unsafe process ids fail as defects within the process timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-unsafe-id-"))
    temporaryRoots.push(root)
    const logDir = join(root, "logs")
    const result = await Effect.runPromise(
      runProcess({
        id: "../unsafe id",
        command: "true",
        args: [],
        cwd: root,
        timeoutMs: 1_000,
        logDir
      }).pipe(Effect.exit, Effect.timeoutOption(1_000))
    )
    expect(Option.isSome(result)).toBe(true)
    if (Option.isNone(result)) throw new Error("unsafe id did not settle within the process timeout")
    expect(Exit.isFailure(result.value)).toBe(true)
    if (Exit.isFailure(result.value)) {
      expect(Cause.hasDies(result.value.cause)).toBe(true)
      expect(Cause.pretty(result.value.cause)).toContain('Unsafe process id: "../unsafe id"')
    }
    expect(existsSync(logDir)).toBe(false)
  })

  test("structured arguments are never interpreted by a shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-args-"))
    temporaryRoots.push(root)
    const injected = join(root, "injected")
    const result = await Effect.runPromise(
      runProcess({
        id: "structured",
        command: "printf",
        args: [`$(touch ${injected})`],
        cwd: root,
        timeoutMs: 10_000,
        logDir: root
      })
    )
    expect(result.exitCode).toBe(0)
    expect(existsSync(injected)).toBe(false)
  }, 15_000)

  test("successful agents still require a machine-readable completion marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-marker-"))
    temporaryRoots.push(root)
    const result = await Effect.runPromise(
      runProcess({
        id: "marker",
        command: "printf",
        args: ["finished without receipt"],
        cwd: root,
        timeoutMs: 10_000,
        logDir: root,
        completionMarker: "DONE"
      })
    )
    expect(result.exitCode).toBe(-2)
    expect(JSON.parse(readFileSync(result.manifestPath, "utf8"))).toMatchObject({
      id: "marker",
      exitCode: -2,
      logPath: result.logPath
    })
  }, 15_000)

  test("each invocation owns fresh log and manifest artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-artifacts-"))
    temporaryRoots.push(root)
    const spec = { id: "fresh", command: "printf", args: ["current"], cwd: root, timeoutMs: 10_000, logDir: root }
    const first = await Effect.runPromise(runProcess(spec))
    const second = await Effect.runPromise(runProcess(spec))
    expect(first.logPath).not.toBe(second.logPath)
    expect(readFileSync(first.logPath, "utf8")).toContain("current")
    expect(readFileSync(second.logPath, "utf8")).toContain("current")
  })

  test("package selection rejects missing, empty, duplicate, and unknown names", () => {
    const all = ["agent", "flow", "std"]
    expect(selectPackages([], all)).toEqual(all)
    expect(selectPackages(["--packages", "flow,std"], all)).toEqual(["flow", "std"])
    expect(() => selectPackages(["--packages"], all)).toThrow("requires")
    expect(() => selectPackages(["--packages", "flow,"], all)).toThrow("empty")
    expect(() => selectPackages(["--packages", "flow,flow"], all)).toThrow("duplicates")
    expect(() => selectPackages(["--packages", "missing"], all)).toThrow("Valid packages")
  })

  test("agent reads are scoped to the working tree, never the maintainer's home", () => {
    const rules = agentPermissionRules("/work/repo", ["/work/repo/pkg"])
    expect(rules).toEqual([
      "Read(//work/repo)",
      "Read(//work/repo/**)",
      "Edit(//work/repo/pkg)",
      "Edit(//work/repo/pkg/**)"
    ])
    expect(rules.filter((rule) => !rule.includes("("))).toEqual([])
  })

  test("the launched claude argv overrides the operator's permission mode and denies credential reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-agent-argv-"))
    temporaryRoots.push(root)
    const bin = join(root, "bin")
    mkdirSync(bin)
    const argvFile = join(root, "argv")
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\nfor arg in "$@"; do printf '%s\\0' "$arg"; done > ${JSON.stringify(argvFile)}\necho DONE\n`
    )
    chmodSync(join(bin, "claude"), 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}:${previousPath ?? ""}`
    let spec
    try {
      spec = agentSpawnSpec(
        {
          id: "argv",
          prompt: "read ~/.ssh/id_ed25519",
          cwd: root,
          model: "opus",
          timeoutMs: 10_000,
          logDir: join(root, "logs"),
          completionMarker: "DONE",
          allowedPaths: [join(root, "pkg")]
        },
        "/home/operator"
      )
    } finally {
      process.env.PATH = previousPath
    }
    const result = await Effect.runPromise(runProcess(spec))
    expect(result.exitCode).toBe(0)
    const argv = readFileSync(argvFile, "utf8").split("\0").slice(0, -1)
    const mode = argv.indexOf("--permission-mode")
    expect(mode).toBeGreaterThan(-1)
    expect(argv[mode + 1]).toBe("default")
    const denied = argv.indexOf("--disallowedTools")
    const allowed = argv.indexOf("--allowedTools")
    expect(denied).toBeGreaterThan(mode)
    expect(allowed).toBeGreaterThan(denied)
    expect(argv.slice(denied + 1, allowed)).toEqual(
      expect.arrayContaining(["Read(//home/operator/.ssh/**)", "Read(//home/operator/.claude/**)"])
    )
    expect(argv.slice(allowed + 1)).toEqual(agentPermissionRules(root, [join(root, "pkg")]))
    expect(argv.slice(allowed + 1).some((rule) => rule.startsWith("Read(//home/operator"))).toBe(false)
  }, 15_000)

  test("post-run confinement rejects writes outside declared roots", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-confinement-"))
    temporaryRoots.push(root)
    execFileSync("git", ["init", "-q", root])
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"])
    execFileSync("git", ["-C", root, "config", "user.name", "Test"])
    mkdirSync(join(root, "allowed"))
    writeFileSync(join(root, "tracked.txt"), "base")
    execFileSync("git", ["-C", root, "add", "tracked.txt"])
    execFileSync("git", ["-C", root, "commit", "-qm", "base"])
    const validate = makeConfinementValidator(root, [join(root, "allowed")])
    writeFileSync(join(root, "outside.txt"), "escaped")
    expect(validate()).toContain("outside.txt")
  })

  test("mutating drivers fail closed and publish reports only after green gates", () => {
    const flows = import.meta.dir
    for (const filename of ["coverage-baseline.ts", "slop-sweep.ts", "bazel-review.ts"]) {
      const source = readFileSync(join(flows, filename), "utf8")
      expect(source).toContain("process.exitCode = 1")
    }
    expect(readFileSync(join(flows, "coverage-baseline.ts"), "utf8")).toContain("reportPath}.partial")
    expect(readFileSync(join(flows, "slop-sweep.ts"), "utf8")).toContain("reportPath}.partial")
  })
})
