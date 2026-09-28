/**
 * The sandbox contract, platform by platform.
 *
 * Fake hosts check Linux argv on macOS and seatbelt profiles on Linux. A
 * native enforcement probe verifies credential denial and explicit grants
 * using only synthetic files; broader end-to-end suites live in @smthrs/build-cli.
 */
import { spawnSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as ExecSandbox from "../src/ExecSandbox.ts"
import { Sandbox } from "../src/WorkspaceDeclaration.ts"

const root = "/work/ws"

const writeFixture = () => {
  const base = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "smthrs-write-grants-")))
  const workspaceRoot = NodePath.join(base, "workspace")
  const outside = NodePath.join(base, "outside")
  NodeFs.mkdirSync(workspaceRoot)
  NodeFs.mkdirSync(outside)
  const facts: ExecSandbox.Host = {
    ...ExecSandbox.host(),
    platform: "linux",
    executable: (name) => `/usr/bin/${name}`
  }
  const plan = (writes: ReadonlyArray<string>, writeFiles: ReadonlyArray<string> = []) =>
    ExecSandbox.plan(
      { policy: {}, reads: [], writes, writeFiles },
      { workspaceRoot, cwd: workspaceRoot, tmp: NodePath.join(workspaceRoot, ".tmp") },
      facts
    )
  return { base, workspaceRoot, outside, plan, facts }
}

describe("write grant symlink confinement", () => {
  it.each(
    [
      ["external directory", "out", false],
      ["missing directory below an external link", "out/missing/deep", false],
      ["existing directory below a linked ancestor", "out/existing", false],
      ["missing file below a linked ancestor", "out/missing/result.txt", true],
      ["linked file", "out/result.txt", true]
    ] as const
  )("refuses a write through an %s", (_, output, file) => {
    const { base, workspaceRoot, outside, plan } = writeFixture()
    try {
      NodeFs.mkdirSync(NodePath.join(outside, "existing"))
      NodeFs.writeFileSync(NodePath.join(outside, "result.txt"), "private")
      NodeFs.symlinkSync(outside, NodePath.join(workspaceRoot, "out"), "dir")
      const result = file ? plan([], [output]) : plan([output])
      // Port of security/1: refusing the plan prevents its grant becoming a
      // writable Docker or bubblewrap bind source outside the workspace.
      expect(ExecSandbox.isUnenforceable(result)).toBe(true)
      expect(NodeFs.existsSync(NodePath.join(outside, "missing"))).toBe(false)
    } finally {
      NodeFs.rmSync(base, { recursive: true, force: true })
    }
  })

  it.each(["internal", "dangling", "loop"] as const)("refuses a %s symlink component", (kind) => {
    const { base, workspaceRoot, outside, plan } = writeFixture()
    try {
      const out = NodePath.join(workspaceRoot, "out")
      const target = kind === "internal" ? workspaceRoot : kind === "loop" ? out : NodePath.join(outside, "missing")
      NodeFs.symlinkSync(target, out, "dir")
      expect(ExecSandbox.isUnenforceable(plan(["out/deep"]))).toBe(true)
    } finally {
      NodeFs.rmSync(base, { recursive: true, force: true })
    }
  })

  it.each([false, true])("checks a linked file before widening to its parent (writeFiles=%s)", (file) => {
    const { base, workspaceRoot, outside, plan } = writeFixture()
    try {
      const target = NodePath.join(outside, "result.txt")
      NodeFs.writeFileSync(target, "private")
      NodeFs.symlinkSync(target, NodePath.join(workspaceRoot, "result.txt"))
      expect(ExecSandbox.isUnenforceable(file ? plan([], ["result.txt"]) : plan(["result.txt"]))).toBe(true)
      expect(NodeFs.readFileSync(target, "utf8")).toBe("private")
    } finally {
      NodeFs.rmSync(base, { recursive: true, force: true })
    }
  })

  it("refuses unresolved existing write components and unavailable workspace roots", () => {
    const { base, workspaceRoot, facts } = writeFixture()
    try {
      NodeFs.mkdirSync(NodePath.join(workspaceRoot, "out"))
      for (
        const realpath of [() => undefined, () => {
          throw new Error("unreadable")
        }, (path: string) => path === workspaceRoot ? workspaceRoot : undefined]
      ) {
        expect(ExecSandbox.isUnenforceable(ExecSandbox.plan(
          { policy: {}, reads: [], writes: ["out"] },
          { workspaceRoot, cwd: workspaceRoot, tmp: NodePath.join(workspaceRoot, ".tmp") },
          { ...facts, realpath }
        ))).toBe(true)
      }
    } finally {
      NodeFs.rmSync(base, { recursive: true, force: true })
    }
  })

  it("canonicalizes a linked workspace root and uses real probes when optional probes are omitted", () => {
    const { base, workspaceRoot, facts } = writeFixture()
    try {
      const alias = NodePath.join(base, "alias")
      NodeFs.symlinkSync(workspaceRoot, alias, "dir")
      const result = ExecSandbox.plan(
        { policy: {}, reads: [], writes: ["out/new"] },
        { workspaceRoot: alias, cwd: workspaceRoot, tmp: NodePath.join(workspaceRoot, ".tmp") },
        { ...facts, realpath: undefined, isSymbolicLink: undefined }
      )
      if (result === undefined || ExecSandbox.isUnenforceable(result)) throw new Error("expected a plan")
      expect(result.workspaceRoot).toBe(workspaceRoot)
      expect(result.writes).toEqual([NodePath.join(workspaceRoot, "out/new")])
      expect(() => ExecSandbox.validateWrites(result)).not.toThrow()
    } finally {
      NodeFs.rmSync(base, { recursive: true, force: true })
    }
  })

  it("revalidates missing outputs before the caller creates directories", () => {
    const { base, workspaceRoot, outside, plan } = writeFixture()
    try {
      NodeFs.mkdirSync(NodePath.join(workspaceRoot, "out"))
      const result = plan(["out/new/deep"])
      if (result === undefined || ExecSandbox.isUnenforceable(result)) throw new Error("expected a plan")
      NodeFs.rmdirSync(NodePath.join(workspaceRoot, "out"))
      NodeFs.symlinkSync(outside, NodePath.join(workspaceRoot, "out"), "dir")
      expect(() => {
        ExecSandbox.validateWrites(result)
        for (const write of result.writes) NodeFs.mkdirSync(write, { recursive: true })
      }).toThrow()
      expect(NodeFs.readdirSync(outside)).toEqual([])
    } finally {
      NodeFs.rmSync(base, { recursive: true, force: true })
    }
  })

  it.each(["directory", "file"] as const)(
    "refuses a %s write when a path becomes a symlink during planning",
    (kind) => {
      const { base, workspaceRoot, outside, facts } = writeFixture()
      try {
        const output = NodePath.join(workspaceRoot, "output")
        NodeFs.mkdirSync(output)
        let probes = 0
        const changing: ExecSandbox.Host = {
          ...facts,
          isSymbolicLink: (path) => {
            if (path === output && ++probes === 2) {
              NodeFs.rmdirSync(output)
              NodeFs.symlinkSync(outside, output, "dir")
            }
            try {
              return NodeFs.lstatSync(path).isSymbolicLink()
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false
              throw cause
            }
          }
        }
        const result = ExecSandbox.plan(
          {
            policy: {},
            reads: [],
            writes: kind === "directory" ? ["output"] : [],
            writeFiles: kind === "file" ? ["output/result.txt"] : []
          },
          { workspaceRoot, cwd: workspaceRoot, tmp: NodePath.join(workspaceRoot, ".tmp") },
          changing
        )
        expect(probes).toBe(2)
        if (!ExecSandbox.isUnenforceable(result)) throw new Error("expected a write-path refusal")
        expect(result.missing).toBe("canonical workspace write path")
        expect(result.message).toContain(`write path ${output} has a symbolic link`)
        expect(NodeFs.readdirSync(outside)).toEqual([])
      } finally {
        NodeFs.rmSync(base, { recursive: true, force: true })
      }
    }
  )

  it.each(["directory", "ancestor", "workspace"] as const)("revalidates a replaced %s before rendering", (replaced) => {
    const { base, workspaceRoot, outside, plan } = writeFixture()
    try {
      NodeFs.mkdirSync(NodePath.join(workspaceRoot, "out/deep"), { recursive: true })
      const result = plan(["out/deep"])
      if (result === undefined || ExecSandbox.isUnenforceable(result)) throw new Error("expected a plan")
      const path = replaced === "workspace"
        ? workspaceRoot
        : NodePath.join(workspaceRoot, replaced === "ancestor" ? "out" : "out/deep")
      NodeFs.rmSync(path, { recursive: true })
      NodeFs.symlinkSync(outside, path, "dir")
      expect(() => ExecSandbox.bubblewrap(result, ["true"])).toThrow()
      expect(() =>
        ExecSandbox.docker(
          {
            ...result,
            mechanism: { _tag: "docker", executable: "/usr/bin/docker", image: "fixture" }
          },
          ["true"],
          {}
        )
      ).toThrow()
      expect(() =>
        ExecSandbox.seatbelt({
          ...result,
          mechanism: { _tag: "seatbelt", executable: "/usr/bin/sandbox-exec" }
        })
      ).toThrow()
    } finally {
      NodeFs.rmSync(base, { recursive: true, force: true })
    }
  })

  it("admits regular existing and missing output directories within the canonical workspace", () => {
    const { base, workspaceRoot, plan } = writeFixture()
    try {
      NodeFs.mkdirSync(NodePath.join(workspaceRoot, "out"))
      const result = plan(["out", "dist.new/nested"])
      if (result === undefined || ExecSandbox.isUnenforceable(result)) throw new Error("expected a plan")
      expect(result.writes).toEqual([
        NodePath.join(workspaceRoot, "out"),
        NodePath.join(workspaceRoot, "dist.new/nested")
      ])
      for (const write of result.writes) NodeFs.mkdirSync(write, { recursive: true })
      for (const write of result.writes) {
        expect(NodeFs.realpathSync(write).startsWith(workspaceRoot + NodePath.sep)).toBe(true)
      }
      expect(ExecSandbox.bubblewrap(result, ["true"])).toContain("--bind")
      const argv = ExecSandbox.docker(
        {
          ...result,
          mechanism: { _tag: "docker", executable: "/usr/bin/docker", image: "fixture" }
        },
        ["true"],
        {}
      )
      for (const write of result.writes) expect(argv).toContain(`type=bind,src=${write},dst=${write}`)
    } finally {
      NodeFs.rmSync(base, { recursive: true, force: true })
    }
  })
})

const host = (
  platform: NodeJS.Platform,
  executables: Readonly<Record<string, string>> = {},
  existing: ReadonlyArray<string> = [],
  directories: ReadonlyArray<string> = []
): ExecSandbox.Host => ({
  platform,
  executable: (name) => executables[name],
  exists: (path) => existing.includes(path) || directories.includes(path),
  isDirectory: (path) => directories.includes(path),
  isSymbolicLink: () => false,
  realpath: (path) => path,
  uid: 501,
  gid: 20
})

const linux = host("linux", { bwrap: "/usr/bin/bwrap" }, ["/work/ws/src/a.ts"], [
  "/work/ws/node_modules",
  "/work/ws/dist"
])
const darwin = host("darwin", { "/usr/bin/sandbox-exec": "/usr/bin/sandbox-exec" }, ["/work/ws/src/a.ts"], [
  "/work/ws/node_modules",
  "/work/ws/dist"
])
const windows = host("win32", { docker: "C:\\docker.exe" })

const request: ExecSandbox.Request = {
  policy: {},
  reads: ["src/a.ts", "node_modules", "missing.txt", "../outside"],
  writes: ["dist"],
  writeFiles: ["out/bundle.js"],
  readOnly: [".flows/cache"]
}

const planned = (hostFacts: ExecSandbox.Host, override: Partial<ExecSandbox.Request> = {}): ExecSandbox.Plan => {
  const plan = ExecSandbox.plan(
    { ...request, ...override },
    { workspaceRoot: root, cwd: `${root}/pkg`, tmp: "/work/ws/.flows/sandbox/run1" },
    hostFacts
  )
  if (plan === undefined || ExecSandbox.isUnenforceable(plan)) throw new Error("expected a plan")
  return plan
}

describe("network", () => {
  it("resolves only the explicit policy to a posture", () => {
    expect(ExecSandbox.network(undefined)).toBe("none")
    expect(ExecSandbox.network({})).toBe("none")
    expect(ExecSandbox.network({ network: false })).toBe("none")
    expect(ExecSandbox.network({ network: "loopback" })).toBe("loopback")
    expect(ExecSandbox.network({ network: true })).toBe("open")
    expect(ExecSandbox.network("none")).toBe("open")
  })
})

describe("selection", () => {
  it("picks the platform mechanism when nothing is declared", () => {
    expect(ExecSandbox.select(request, linux)).toEqual({ _tag: "bubblewrap", executable: "/usr/bin/bwrap" })
    expect(ExecSandbox.select(request, darwin)).toEqual({ _tag: "seatbelt", executable: "/usr/bin/sandbox-exec" })
  })

  it("selects nothing for the explicit opt-outs", () => {
    expect(ExecSandbox.select({ ...request, policy: "none" }, linux)).toEqual({ _tag: "none" })
    expect(ExecSandbox.select({ ...request, mechanism: Sandbox.None() }, linux)).toEqual({ _tag: "none" })
    expect(ExecSandbox.enforceable({ ...request, policy: "none" }, linux)).toBe(false)
  })

  it("refuses a Linux host without bwrap instead of running unconfined", () => {
    const selected = ExecSandbox.select(request, host("linux"))
    expect(ExecSandbox.isUnenforceable(selected)).toBe(true)
    if (!ExecSandbox.isUnenforceable(selected)) return
    expect(selected.missing).toBe("bwrap")
    expect(selected.message).toContain("bubblewrap")
    expect(selected.message).toContain("never runs unconfined")
    expect(ExecSandbox.enforceable(request, host("linux"))).toBe(false)
  })

  it("refuses loopback-only networking on Linux instead of sharing the host network", () => {
    const selected = ExecSandbox.select({ ...request, policy: { network: "loopback" } }, linux)
    expect(ExecSandbox.isUnenforceable(selected)).toBe(true)
    if (!ExecSandbox.isUnenforceable(selected)) return
    expect(selected.platform).toBe("linux")
    expect(selected.mechanism).toBe("bubblewrap")
    expect(selected.missing).toBe("network: true")
    expect(selected.message).toContain("cannot expose only the host loopback interface")
    expect(selected.message).toContain("never runs unconfined")
  })

  it("refuses build confinement under a Microsandbox declaration on every host, naming the runtime seam", () => {
    for (const hostFacts of [linux, darwin, windows]) {
      const selected = ExecSandbox.select({ ...request, mechanism: Sandbox.Microsandbox() }, hostFacts)
      expect(ExecSandbox.isUnenforceable(selected)).toBe(true)
      if (!ExecSandbox.isUnenforceable(selected)) return
      expect(selected.mechanism).toBe("microsandbox")
      expect(selected.missing).toBe("S.Sandbox.Bubblewrap")
      expect(selected.message).toContain("@smthrs/sandbox")
      expect(selected.message).toContain("never runs unconfined")
    }
    expect(ExecSandbox.select({ ...request, policy: "none", mechanism: Sandbox.Microsandbox() }, linux)).toEqual({
      _tag: "none"
    })
  })

  it("refuses Windows without a docker declaration and honors one with docker on PATH", () => {
    const bare = ExecSandbox.select(request, host("win32"))
    expect(ExecSandbox.isUnenforceable(bare)).toBe(true)
    if (ExecSandbox.isUnenforceable(bare)) expect(bare.missing).toBe("S.Sandbox.Docker")
    const declared = ExecSandbox.select({ ...request, mechanism: Sandbox.Docker({ image: "node:22" }) }, windows)
    expect(declared).toEqual({ _tag: "docker", executable: "C:\\docker.exe", image: "node:22" })
    const missing = ExecSandbox.select({ ...request, mechanism: Sandbox.Docker({ image: "node:22" }) }, host("win32"))
    expect(ExecSandbox.isUnenforceable(missing)).toBe(true)
    if (ExecSandbox.isUnenforceable(missing)) expect(missing.missing).toBe("docker")
  })

  it("refuses a bubblewrap declaration off Linux", () => {
    const selected = ExecSandbox.select({ ...request, mechanism: Sandbox.Bubblewrap() }, darwin)
    expect(ExecSandbox.isUnenforceable(selected)).toBe(true)
    if (ExecSandbox.isUnenforceable(selected)) expect(selected.mechanism).toBe("bubblewrap")
  })

  it("refuses macOS when the system seatbelt executable is missing", () => {
    const selected = ExecSandbox.select(request, host("darwin"))
    expect(ExecSandbox.isUnenforceable(selected)).toBe(true)
    if (ExecSandbox.isUnenforceable(selected)) expect(selected.missing).toBe("/usr/bin/sandbox-exec")
  })
})

describe("plan", () => {
  it("anchors paths at the root, drops escapes and missing reads, and opens a file output's directory", () => {
    const plan = planned(linux)
    expect(plan.reads).toEqual(["/work/ws/src/a.ts", "/work/ws/node_modules"])
    expect(plan.writes).toEqual(["/work/ws/out", "/work/ws/dist"])
    expect(plan.readOnly).toEqual(["/work/ws/.flows/cache"])
    expect(plan.network).toBe("none")
    expect(plan.cwd).toBe("/work/ws/pkg")
  })

  /**
   * A declared output directory that the target has not created yet keeps its
   * own name. Reading a dot in the base name as a file extension would bind
   * the parent instead, and for a top-level `.cargo-home`, `.astro` or
   * `dist.new` that parent is the workspace root: bubblewrap then skips the
   * read-only remount and the whole workspace is writable for the run, on the
   * first run only, before the directory exists.
   */
  it("binds a not-yet-created write directory by its own name, dot in it or not", () => {
    const bare = host("linux", { bwrap: "/usr/bin/bwrap" }, [], ["/work/ws", "/work/ws/apps/site"])
    for (const write of [".cargo-home", ".astro", ".turbo", "dist.new"]) {
      const plan = planned(bare, { reads: [], writes: [write], writeFiles: [], readOnly: [] })
      expect(plan.writes).toEqual([`/work/ws/${write}`])
      expect(plan.writes).not.toContain("/work/ws")
      expect(ExecSandbox.bubblewrap(plan, ["true"], linux).join(" ")).toContain("--remount-ro /work/ws")
    }
    const nested = planned(bare, { reads: [], writes: ["apps/site/.astro"], writeFiles: [], readOnly: [] })
    expect(nested.writes).toEqual(["/work/ws/apps/site/.astro"])
    // A declared output file keeps opening its parent, existing or not.
    const file = planned(bare, { reads: [], writes: [], writeFiles: ["apps/site/dist/index.js"], readOnly: [] })
    expect(file.writes).toEqual(["/work/ws/apps/site/dist"])
  })

  /**
   * A write is the one declaration that would open a hole: binding a path
   * that resolves outside the root would give the tool a writable window on
   * the host. It is dropped, not anchored back inside and not refused, which
   * is the same answer an escaping read gets.
   */
  it("drops a declared write and a read-only path that escape the root", () => {
    const plan = planned(linux, {
      writes: ["dist", "../outside", "../../etc/passwd"],
      writeFiles: ["../outside/out.txt"],
      readOnly: [".flows/cache", "../outside"]
    })
    expect(plan.writes).toEqual(["/work/ws/dist"])
    expect(plan.readOnly).toEqual(["/work/ws/.flows/cache"])
  })

  it("collapses a path covered by a broader entry", () => {
    const plan = planned(
      host("linux", { bwrap: "/usr/bin/bwrap" }, ["/work/ws/src/a.ts", "/work/ws/src/b.ts"], [
        "/work/ws/src"
      ]),
      { reads: ["src", "src/a.ts", "src/b.ts"] }
    )
    expect(plan.reads).toEqual(["/work/ws/src"])
  })

  /**
   * A sibling whose name extends the directory's own (`src.ts` against `src`)
   * sorts between the directory and its files under a plain comparison, so a
   * collapse that carries one ancestor forward must order by subtree.
   */
  it("collapses a covered path even when a sibling name sorts between it and its parent", () => {
    const paths = ["/work/ws/src", "/work/ws/src.ts", "/work/ws/src-gen", "/work/ws/src/a.ts", "/work/ws/src/lib/b.ts"]
    const plan = planned(
      host("linux", { bwrap: "/usr/bin/bwrap" }, paths, ["/work/ws/src", "/work/ws/src-gen", "/work/ws/src/lib"]),
      { reads: ["src/lib/b.ts", "src.ts", "src", "src-gen", "src/a.ts"] }
    )
    expect(plan.reads).toEqual(["/work/ws/src", "/work/ws/src.ts", "/work/ws/src-gen"])
  })

  /**
   * Bubblewrap and Docker bind each declared path, so a plan for one package's
   * sources holds thousands of sibling files. Searching the kept set for an
   * ancestor of every one of them made planning quadratic, and planning runs
   * synchronously before each confined execution.
   */
  it("collapses thousands of sibling files without scanning the kept set per path", () => {
    const collapsing = (count: number): number => {
      const relative = Array.from({ length: count }, (_, index) => `src/file${index}.ts`)
      const present = new Set(relative.map((path) => `${root}/${path}`))
      const facts: ExecSandbox.Host = {
        platform: "linux",
        executable: (name) => (name === "bwrap" ? "/usr/bin/bwrap" : undefined),
        exists: (path) => path === root || present.has(path),
        isDirectory: () => false,
        isSymbolicLink: () => false,
        realpath: (path) => path,
        uid: 501,
        gid: 20
      }
      let operations = 0
      const visit = () => {
        operations += 1
        if (operations > count * 100) throw new Error("path collapse exceeded its linear collection budget")
      }
      const counted = <T extends Iterator<unknown>>(iterator: T): T => {
        const next = iterator.next.bind(iterator)
        iterator.next = () => {
          const entry = next()
          if (!entry.done) visit()
          return entry
        }
        return iterator
      }
      // Observe lookups and every visited entry, including spreads, values,
      // entries and forEach. A kept-set scan spends the same budget whether
      // its predicate uses startsWith, slice, a regex or another primitive.
      class CountingSet<T> extends Set<T> {
        override has(value: T): boolean {
          visit()
          return super.has(value)
        }
        override [Symbol.iterator]() {
          return counted(super[Symbol.iterator]())
        }
        override values() {
          return counted(super.values())
        }
        override keys() {
          return counted(super.keys())
        }
        override entries() {
          return counted(super.entries())
        }
        override forEach(callback: (value: T, key: T, set: Set<T>) => void, thisArg?: unknown): void {
          super.forEach((value, key, set) => {
            visit()
            callback.call(thisArg, value, key, set)
          })
        }
      }
      class CountingMap<K, V> extends Map<K, V> {
        override has(key: K): boolean {
          visit()
          return super.has(key)
        }
        override get(key: K): V | undefined {
          visit()
          return super.get(key)
        }
        override [Symbol.iterator]() {
          return counted(super[Symbol.iterator]())
        }
        override values() {
          return counted(super.values())
        }
        override keys() {
          return counted(super.keys())
        }
        override entries() {
          return counted(super.entries())
        }
        override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
          super.forEach((value, key, map) => {
            visit()
            callback.call(thisArg, value, key, map)
          })
        }
      }
      let plan: ExecSandbox.Plan
      vi.stubGlobal("Set", CountingSet)
      vi.stubGlobal("Map", CountingMap)
      try {
        plan = planned(facts, { reads: relative, writes: [], writeFiles: [], readOnly: [] })
      } finally {
        vi.unstubAllGlobals()
      }
      expect(plan.reads).toHaveLength(count)
      expect(new Set(plan.reads)).toEqual(present)
      return operations
    }
    const small = collapsing(2_500)
    const large = collapsing(10_000)
    // Count collection work, including the planner's other probes.
    // A kept-set scan costs sixteen times as much for four times the paths;
    // the sorted sweep scales linearly regardless of host scheduling.
    expect(small).toBeGreaterThan(0)
    expect(large).toBeLessThan(small * 8)
    expect(large).toBeLessThan(10_000 * 100)
  })

  it("records where a read that links out of the workspace really lives, and nothing for the rest", () => {
    const linked: ExecSandbox.Host = {
      ...linux,
      realpath: (path) => path === "/work/ws/node_modules" ? "/tmp/real-ws/node_modules" : path
    }
    expect(planned(linked).externalReads).toEqual(["/tmp/real-ws/node_modules"])
    expect(planned(linux).externalReads).toEqual([])
    const inside: ExecSandbox.Host = {
      ...linux,
      realpath: (path) => path === "/work/ws/node_modules" ? "/work/ws/.store/node_modules" : path
    }
    expect(planned(inside).externalReads).toEqual([])
  })

  it("admits a requested external read only when it is absolute, outside the root, and present", () => {
    const present = host("linux", { bwrap: "/usr/bin/bwrap" }, ["/work/ws/src/a.ts", "/srv/git/one"], [
      "/work/ws/node_modules"
    ])
    const plan = planned(present, {
      externalReads: ["/srv/git/one", "/srv/git/missing", "/work/ws/src/a.ts", "relative/path"]
    })
    expect(plan.externalReads).toEqual(["/srv/git/one"])
  })

  it("returns nothing for an opted-out policy and the refusal for an unenforceable host", () => {
    expect(
      ExecSandbox.plan({ ...request, policy: "none" }, { workspaceRoot: root, cwd: root, tmp: "/t" }, linux)
    ).toBeUndefined()
    const refused = ExecSandbox.plan(request, { workspaceRoot: root, cwd: root, tmp: "/t" }, host("linux"))
    expect(ExecSandbox.isUnenforceable(refused)).toBe(true)
  })
})

describe("native host read confinement", () => {
  it.each(["linux", "darwin"] as const)("closes undeclared host credentials on %s", (platform) => {
    const { base, workspaceRoot, outside, facts } = writeFixture()
    try {
      const credential = NodePath.join(outside, ".aws/credentials")
      NodeFs.mkdirSync(NodePath.dirname(credential))
      NodeFs.writeFileSync(credential, "synthetic-secret")
      const native = { ...facts, platform }
      const render = (externalReads: ReadonlyArray<string>) => {
        const result = ExecSandbox.plan(
          { policy: {}, reads: [], writes: [], externalReads },
          { workspaceRoot, cwd: workspaceRoot, tmp: NodePath.join(workspaceRoot, ".tmp") },
          native
        )
        if (result === undefined || ExecSandbox.isUnenforceable(result)) throw new Error("expected a plan")
        return platform === "linux"
          ? ExecSandbox.bubblewrap(result, ["/bin/cat", credential], native).join(" ")
          : ExecSandbox.seatbelt(result, native)
      }
      const closed = render([])
      const coversCredential = (path: string) =>
        credential === path || credential.startsWith(path.replace(/\/$/, "") + "/")
      if (platform === "linux") {
        // Inspect every bind, so a new broad grant cannot silently reopen the fixture.
        const mounts = [...closed.matchAll(/--(?:ro-bind|bind)(?:-try)? (\S+) (\S+)/g)]
        expect(mounts.some((match) => coversCredential(match[1]!))).toBe(false)
        expect(closed).not.toContain("--ro-bind / / ")
        expect(closed).not.toContain(`--ro-bind ${outside}`)
        expect(render([credential])).toContain(`--ro-bind ${credential} ${credential}`)
      } else {
        expect(closed).toContain("(deny file-read*)")
        const grants = [...closed.matchAll(/\(allow file-read\* ((?:\((?:subpath|literal) "[^"]*"\) *)+)\)/g)]
        for (const grant of grants) {
          const subpaths = [...grant[1]!.matchAll(/\(subpath "([^"]*)"\)/g)]
          expect(subpaths.some((match) => coversCredential(match[1]!))).toBe(false)
        }
        expect(closed).not.toContain(`(subpath "${outside}")`)
        expect(render([credential])).toContain(`(allow file-read* (subpath "${credential}"))`)
      }
    } finally {
      NodeFs.rmSync(base, { recursive: true, force: true })
    }
  })

  it("masks home credentials inside runtime grants and restores only explicit external reads", () => {
    const home = "/usr/local/dev"
    const ssh = `${home}/.ssh`
    const key = `${ssh}/key`
    const npmrc = `${home}/.npmrc`
    const facts: ExecSandbox.Host = {
      ...host("linux", { bwrap: "/usr/bin/bwrap", node: `${home}/bin/node`, bun: "/custom/bun" }, [
        key,
        npmrc,
        `${home}/bin/node`,
        "/custom/bun"
      ], ["/usr", ssh, `${home}/lib/node_modules`]),
      home
    }
    const result = planned(facts, { reads: [], writes: [], writeFiles: [], externalReads: [key] })
    const argv = ExecSandbox.bubblewrap(result, ["true"], facts).join(" ")
    expect(argv).toContain("--ro-bind /usr /usr")
    expect(argv).toContain(`--tmpfs ${ssh} --ro-bind ${key} ${key} --remount-ro ${ssh}`)
    expect(argv).toContain(`--ro-bind /dev/null ${npmrc}`)
    expect(argv).toContain("--ro-bind /custom/bun /custom/bun")
    expect(argv).not.toContain("--ro-bind /custom /custom")
    const broad = ExecSandbox.bubblewrap(planned(facts, { externalReads: [ssh] }), ["true"], facts).join(" ")
    expect(broad).toContain(`--ro-bind ${ssh} ${ssh}`)
    expect(broad).not.toContain(`--tmpfs ${ssh}`)
    const profile = ExecSandbox.seatbelt(
      { ...result, mechanism: { _tag: "seatbelt", executable: "sandbox-exec" } },
      facts
    )
    const deny = profile.indexOf("(deny file-read* (subpath")
    expect(profile.indexOf("(allow file-read* (subpath \"/usr\")")).toBeLessThan(deny)
    expect(profile).toContain(`(subpath "${ssh}")`)
    expect(profile.endsWith(`(allow file-read* (subpath "${key}"))`)).toBe(true)
  })

  it("resolves runtime aliases without admitting their parent or unrelated install files", () => {
    const facts: ExecSandbox.Host = {
      ...host("linux", { bwrap: "/usr/bin/bwrap", node: "/tools/node", bun: "/tools/bun" }, [
        "/tools/node",
        "/tools/bun",
        "/installed/bin/node",
        "/installed/bin/bun"
      ], ["/installed/lib/node_modules", "/home/dev/.cache/node/corepack"]),
      home: "/home/dev",
      realpath: (path) =>
        path === "/tools/node" ? "/installed/bin/node" : path === "/tools/bun" ? "/installed/bin/bun" : path
    }
    const argv = ExecSandbox.bubblewrap(planned(facts), ["true"], facts).join(" ")
    for (
      const path of [
        "/tools/node",
        "/tools/bun",
        "/installed/bin/node",
        "/installed/bin/bun",
        "/installed/lib/node_modules",
        "/home/dev/.cache/node/corepack"
      ]
    ) {
      expect(argv).toContain(`--ro-bind ${path} ${path}`)
    }
    expect(argv).not.toContain("--ro-bind /installed /installed")
    expect(argv).not.toContain("--ro-bind /home/dev /home/dev")
    const unresolved = ExecSandbox.bubblewrap(planned(facts, { writes: [], writeFiles: [] }), ["true"], {
      ...facts,
      realpath: undefined
    }).join(" ")
    expect(unresolved).toContain("--ro-bind /tools/node /tools/node")
  })

  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "enforces default denial and explicit external reads with the native kernel sandbox",
    () => {
      const { base, workspaceRoot, outside } = writeFixture()
      try {
        const credential = NodePath.join(outside, ".aws/credentials")
        NodeFs.mkdirSync(NodePath.dirname(credential))
        NodeFs.writeFileSync(credential, "synthetic-secret")
        const tmp = NodePath.join(workspaceRoot, ".tmp")
        NodeFs.mkdirSync(NodePath.join(tmp, "home"), { recursive: true })
        const run = (
          externalReads: ReadonlyArray<string>,
          broadHome = false,
          command: ReadonlyArray<string> = ["/bin/cat", credential]
        ) => {
          const result = ExecSandbox.plan(
            { policy: {}, reads: broadHome ? ["."] : [], writes: [], externalReads },
            { workspaceRoot: broadHome ? outside : workspaceRoot, cwd: workspaceRoot, tmp },
            { ...ExecSandbox.host(), home: outside }
          )
          if (result === undefined || ExecSandbox.isUnenforceable(result)) throw new Error("native sandbox unavailable")
          const wrapped = ExecSandbox.wrap(result, command, {}, {
            ...ExecSandbox.host(),
            home: outside
          })
          return spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
            encoding: "utf8",
            timeout: 10_000,
            env: { ...process.env, ...wrapped.env }
          })
        }
        const runtime = run([], false, [process.execPath, "-e", "process.stdout.write(\"runtime-ok\")"])
        expect(runtime.error).toBeUndefined()
        expect(runtime.status, runtime.stderr).toBe(0)
        expect(runtime.stdout).toBe("runtime-ok")
        const allowed = run([credential])
        expect(allowed.error).toBeUndefined()
        expect(allowed.status, allowed.stderr).toBe(0)
        expect(allowed.stdout).toBe("synthetic-secret")
        const denied = run([])
        expect(denied.error).toBeUndefined()
        expect(denied.status, denied.stderr).toBe(1)
        expect(denied.stdout).not.toContain("synthetic-secret")
        const masked = run([], true)
        expect(masked.error).toBeUndefined()
        expect(masked.status, masked.stderr).toBe(1)
        expect(masked.stdout).not.toContain("synthetic-secret")
      } finally {
        NodeFs.rmSync(base, { recursive: true, force: true })
      }
    }
  )
})

describe("bubblewrap argv", () => {
  it("starts with an empty root, shadows the workspace, binds the declared set, and remounts read-only last", () => {
    const argv = ExecSandbox.bubblewrap(planned(linux), ["node", "build.js"], linux)
    const text = argv.join(" ")
    expect(argv[0]).toBe("/usr/bin/bwrap")
    expect(text).toContain("--tmpfs / ")
    expect(text).not.toContain("--ro-bind / /")
    expect(text).toContain("--tmpfs /work/ws")
    expect(text).toContain("--ro-bind /work/ws/src/a.ts /work/ws/src/a.ts")
    expect(text).toContain("--bind /work/ws/dist /work/ws/dist")
    expect(text).toContain("--remount-ro /work/ws")
    expect(text).toContain("--unshare-all")
    expect(text).not.toContain("--share-net")
    expect(text).toContain("--chdir /work/ws/pkg")
    expect(argv.slice(-2)).toEqual(["node", "build.js"])
    expect(argv.indexOf("--remount-ro")).toBeGreaterThan(argv.lastIndexOf("--bind"))
  })

  it("binds a linked read's real location before the link itself", () => {
    const linked: ExecSandbox.Host = {
      ...linux,
      realpath: (path) => path === "/work/ws/node_modules" ? "/tmp/real-ws/node_modules" : path
    }
    const argv = ExecSandbox.bubblewrap(planned(linked), ["node", "build.js"], linux)
    const text = argv.join(" ")
    expect(text).toContain("--ro-bind /tmp/real-ws/node_modules /tmp/real-ws/node_modules")
    expect(text).toContain("--ro-bind /work/ws/node_modules /work/ws/node_modules")
    expect(argv.indexOf("/tmp/real-ws/node_modules")).toBeLessThan(argv.indexOf("/work/ws/node_modules"))
    expect(argv.indexOf("/tmp/real-ws/node_modules")).toBeGreaterThan(argv.indexOf("/tmp"))
  })

  it("re-closes a read-only subtree under a writable directory", () => {
    const argv = ExecSandbox.bubblewrap(
      planned(host("linux", { bwrap: "/usr/bin/bwrap" }, [], ["/work/ws/.flows"]), {
        writes: [".flows"],
        readOnly: [".flows/cache"]
      }),
      ["true"],
      linux
    )
    const text = argv.join(" ")
    expect(text).toContain("--bind /work/ws/.flows /work/ws/.flows")
    expect(text).toContain("--ro-bind-try /work/ws/.flows/cache /work/ws/.flows/cache")
    expect(text.indexOf("--ro-bind-try")).toBeGreaterThan(text.indexOf("--bind /work/ws/.flows "))
  })

  it("does not remount the root read-only when the root itself is the declared write directory", () => {
    // A declared output file at the top level opens its parent, the root.
    const rootWrite = planned(host("linux", { bwrap: "/usr/bin/bwrap" }, [], ["/work/ws"]), {
      reads: [],
      writes: [],
      writeFiles: ["out.txt"],
      readOnly: []
    })
    expect(rootWrite.writes).toEqual(["/work/ws"])
    const argv = ExecSandbox.bubblewrap(rootWrite, ["true"], linux)
    const text = argv.join(" ")
    expect(text).toContain("--bind /work/ws /work/ws")
    expect(text).not.toContain("--remount-ro /work/ws")
    expect(text).toContain("--remount-ro / --chdir")
    // A write below the root keeps the tmpfs at the root re-closed.
    const nested = ExecSandbox.bubblewrap(planned(linux), ["true"], linux).join(" ")
    expect(nested).toContain("--remount-ro /work/ws")
  })

  it("unshares the network by default and shares the host network only for an open policy", () => {
    const open = ExecSandbox.bubblewrap(planned(linux, { policy: { network: true } }), ["true"], linux).join(" ")
    expect(open).toContain("--share-net")
    expect(ExecSandbox.bubblewrap(planned(linux), ["true"], linux).join(" ")).not.toContain("--share-net")
    expect(() => ExecSandbox.bubblewrap({ ...planned(linux), network: "loopback" }, ["true"], linux)).toThrow(
      "bubblewrap cannot render loopback-only networking"
    )
  })
})

describe("folding declared files into directories", () => {
  const listing: Readonly<Record<string, ReadonlyArray<string>>> = {
    "/work/ws": ["src", "node_modules", "package.json"],
    "/work/ws/src": ["lib", "c.ts", "d.ts", "__generated__"],
    "/work/ws/src/lib": ["a.ts", "b.ts", "deep"],
    "/work/ws/src/lib/deep": ["e.ts"],
    "/work/ws/src/__generated__": ["x.graphql.ts"]
  }
  const files = ["/work/ws/src/lib/a.ts", "/work/ws/src/lib/b.ts", "/work/ws/src/lib/deep/e.ts", "/work/ws/src/c.ts"]
  const listingHost: ExecSandbox.Host = {
    ...host(
      "darwin",
      { "/usr/bin/sandbox-exec": "/usr/bin/sandbox-exec" },
      [...files, "/work/ws/package.json"],
      Object.keys(listing)
    ),
    entries: (directory) => listing[directory]
  }
  const reads = ["src/lib/a.ts", "src/lib/b.ts", "src/lib/deep/e.ts", "src/c.ts"]

  it("grants a mostly declared subtree whole and re-closes what the declaration left out", () => {
    const plan = planned(listingHost, { reads, writes: [] })
    expect(plan.reads).toEqual(["/work/ws/src"])
    expect(plan.readDenies).toEqual(["/work/ws/src/d.ts", "/work/ws/src/__generated__"])
    const profile = ExecSandbox.seatbelt(plan, linux)
    const grant = profile.indexOf("(subpath \"/work/ws/src\")")
    const close = profile.indexOf(
      "(deny file-read* (subpath \"/work/ws/src/d.ts\") (subpath \"/work/ws/src/__generated__\"))"
    )
    expect(grant).toBeGreaterThan(0)
    expect(close).toBeGreaterThan(grant)
    expect(profile).not.toContain("a.ts")
  })

  it("counts a declared write as covered, never folds the root, and keeps every file when the host cannot list", () => {
    const withWrite = planned(listingHost, { reads, writes: ["src/__generated__"] })
    expect(withWrite.reads).toEqual(["/work/ws/src"])
    expect(withWrite.readDenies).toEqual(["/work/ws/src/d.ts"])
    const rootOnly = planned(listingHost, { reads: ["package.json"], writes: [] })
    expect(rootOnly.reads).toEqual(["/work/ws/package.json"])
    expect(rootOnly.readDenies).toEqual([])
    const blind = planned({ ...listingHost, entries: undefined }, { reads, writes: [] })
    expect([...blind.reads].sort()).toEqual([...files].sort())
    expect(blind.readDenies).toEqual([])
  })

  /**
   * A write two levels down has an undeclared middle directory. Folding its
   * parent whole would list that directory as uncovered, and because later
   * rules win in SBPL the deny would close reads on the output directory the
   * plan grants a write to: `--clean`, `emptyOutDir` and incremental reads
   * would all fail with EPERM inside a granted tree.
   */
  it("never denies an ancestor of a declared write", () => {
    const nested: Readonly<Record<string, ReadonlyArray<string>>> = {
      "/work/ws": ["pkg"],
      "/work/ws/pkg": ["src", "package.json", "tsconfig.json", "dist", "test"],
      "/work/ws/pkg/src": ["a.ts"],
      "/work/ws/pkg/dist": ["esm"],
      "/work/ws/pkg/dist/esm": []
    }
    const nestedHost: ExecSandbox.Host = {
      ...host(
        "darwin",
        { "/usr/bin/sandbox-exec": "/usr/bin/sandbox-exec" },
        ["/work/ws/pkg/src/a.ts", "/work/ws/pkg/package.json", "/work/ws/pkg/tsconfig.json"],
        Object.keys(nested)
      ),
      entries: (directory) => nested[directory]
    }
    const plan = planned(nestedHost, {
      reads: ["pkg/src/a.ts", "pkg/package.json", "pkg/tsconfig.json"],
      writes: ["pkg/dist/esm"],
      writeFiles: [],
      readOnly: []
    })
    expect(plan.writes).toEqual(["/work/ws/pkg/dist/esm"])
    for (const deny of plan.readDenies) {
      expect(plan.writes.some((write) => write === deny || write.startsWith(`${deny}/`))).toBe(false)
    }
    expect(plan.readDenies).toEqual([])
    expect(plan.reads).toEqual(["/work/ws/pkg/src", "/work/ws/pkg/package.json", "/work/ws/pkg/tsconfig.json"])
    expect(ExecSandbox.seatbelt(plan, nestedHost)).not.toContain("(subpath \"/work/ws/pkg/dist\")")
  })

  it("leaves a directory alone when an uncovered entry still holds declared files below it", () => {
    const sparse: ExecSandbox.Host = {
      ...listingHost,
      entries: (
        directory
      ) => (directory === "/work/ws/src/lib" ? ["a.ts", "b.ts", "deep", "n1", "n2", "n3", "n4"] : listing[directory])
    }
    const plan = planned(sparse, { reads, writes: [] })
    // lib: three covered entries (a, b, and the folded deep) against four uncovered ones: not folded.
    expect(plan.reads).not.toContain("/work/ws/src/lib")
    expect(plan.reads).not.toContain("/work/ws/src")
    expect(plan.reads).toContain("/work/ws/src/lib/deep")
  })

  it("keeps a directory's declared files when the host cannot list that one directory", () => {
    // `entries` answers for the workspace but not for one candidate: the
    // deepest directory is neither promoted nor denied, and because it stays
    // uncovered its parents cannot be folded over it either.
    const unlistable: ExecSandbox.Host = {
      ...listingHost,
      entries: (directory) => (directory === "/work/ws/src/lib/deep" ? undefined : listing[directory])
    }
    const plan = planned(unlistable, { reads, writes: [] })
    expect([...plan.reads].sort()).toEqual([...files].sort())
    expect(plan.readDenies).toEqual([])
  })

  it("keeps a directory's declared files when the host lists that directory as empty", () => {
    // An empty listing is not evidence that the declaration covers the
    // directory, so it is treated exactly like an unreadable one.
    const emptied: ExecSandbox.Host = {
      ...listingHost,
      entries: (directory) => (directory === "/work/ws/src/lib/deep" ? [] : listing[directory])
    }
    const plan = planned(emptied, { reads, writes: [] })
    expect([...plan.reads].sort()).toEqual([...files].sort())
    expect(plan.readDenies).toEqual([])
  })

  it("does not fold for bubblewrap, which binds each declared path", () => {
    const linuxListing: ExecSandbox.Host = { ...listingHost, platform: "linux", executable: () => "/usr/bin/bwrap" }
    const plan = planned(linuxListing, { reads, writes: [] })
    expect([...plan.reads].sort()).toEqual([...files].sort())
    expect(plan.readDenies).toEqual([])
  })
})

describe("seatbelt profile", () => {
  it("reads the selected Xcode tree without opening arbitrary Applications paths", () => {
    const developerDirectory = "/Applications/Xcode_26.6.app/Contents/Developer"
    const selected: ExecSandbox.Host = {
      ...darwin,
      developerDirectory,
      exists: (path) => path === developerDirectory || darwin.exists(path)
    }
    const profile = ExecSandbox.seatbelt(planned(darwin), selected)
    expect(profile).toContain(`(subpath "${developerDirectory}")`)
    expect(profile).not.toContain("(subpath \"/Applications\")")
    const untrusted = ExecSandbox.seatbelt(planned(darwin), { ...selected, developerDirectory: "/Users/owner/.ssh" })
    expect(untrusted).not.toContain("(subpath \"/Users/owner/.ssh\")")
  })

  it("denies network and writes, closes reads under the workspace, and reopens the declared set", () => {
    const profile = ExecSandbox.seatbelt(planned(darwin), linux)
    expect(profile.startsWith("(version 1)(allow default)")).toBe(true)
    expect(profile).toContain("(deny network*)")
    expect(profile).toContain("(deny file-write*)")
    expect(profile).toContain(
      "(allow file-write* (subpath \"/dev\") (subpath \"/work/ws/out\") (subpath \"/work/ws/dist\") (subpath \"/work/ws/.flows/sandbox/run1\"))"
    )
    expect(profile).toContain("(deny file-write* (subpath \"/work/ws/.flows/cache\"))")
    expect(profile).toContain("(deny file-read* (subpath \"/work/ws\"))")
    expect(profile).toContain("(allow file-read-metadata (subpath \"/work/ws\"))")
    expect(profile).toContain("(literal \"/work/ws\")")
    expect(profile).toContain("(literal \"/work/ws/src\")")
    expect(profile).toContain("(subpath \"/work/ws/src/a.ts\")")
    expect(profile).toContain("(subpath \"/work/ws/node_modules\")")
    expect(profile).not.toContain("localhost")
  })

  it("opens loopback and the whole network in steps", () => {
    const loopback = ExecSandbox.seatbelt(planned(darwin, { policy: { network: "loopback" } }), linux)
    expect(loopback).toContain("(deny network*)")
    expect(loopback).toContain("(allow network-bind (local ip \"localhost:*\"))")
    const open = ExecSandbox.seatbelt(planned(darwin, { policy: { network: true } }), linux)
    expect(open).not.toContain("(deny network*)")
  })

  it("escapes quotes and backslashes in paths", () => {
    const plan = planned(
      host("darwin", { "/usr/bin/sandbox-exec": "/usr/bin/sandbox-exec" }, [], ["/work/ws/we\"ird"]),
      {
        reads: ["we\"ird"],
        writes: []
      }
    )
    expect(ExecSandbox.seatbelt(plan, linux)).toContain("(subpath \"/work/ws/we\\\"ird\")")
  })
})

describe("docker argv", () => {
  it("names each wrapped run uniquely and returns its removal identity", () => {
    const plan = planned(host("win32", { docker: "docker" }), {
      mechanism: Sandbox.Docker({ image: "node:22" })
    })
    const first = ExecSandbox.wrap(plan, ["true"], {}, linux)
    const second = ExecSandbox.wrap(plan, ["true"], {}, linux)
    expect(first).toHaveProperty("containerName", expect.stringMatching(/^smithers-[0-9a-f-]{36}$/))
    const name = first.containerName
    expect(first.argv.slice(first.argv.indexOf("--name"), first.argv.indexOf("--name") + 2))
      .toEqual(["--name", name])
    expect(second).not.toHaveProperty("containerName", name)
  })

  it("mounts an external read at its host path, read-only", () => {
    const plan = planned(
      host("win32", { docker: "docker" }, ["/work/ws/src/a.ts", "/srv/git/one"], ["/work/ws/node_modules"]),
      { mechanism: Sandbox.Docker({ image: "node:22" }), externalReads: ["/srv/git/one"] }
    )
    const text = ExecSandbox.docker(plan, ["node"], {}, linux).join(" ")
    expect(text).toContain("--mount type=bind,src=/srv/git/one,dst=/srv/git/one,readonly")
  })

  it("mounts the declared set at its host paths, closes the network, and maps the user", () => {
    const plan = planned(
      host("win32", { docker: "docker" }, ["/work/ws/src/a.ts"], ["/work/ws/node_modules", "/work/ws/dist"]),
      {
        mechanism: Sandbox.Docker({ image: "node:22" })
      }
    )
    const argv = ExecSandbox.docker(plan, ["node", "build.js"], { PATH: "/ignored", HOME: "/ignored", CI: "1" }, linux)
    const text = argv.join(" ")
    expect(argv.slice(0, 3)).toEqual(["docker", "run", "--rm"])
    expect(text).toContain("--read-only")
    expect(text).toContain("--network none")
    expect(text).toContain("--workdir /work/ws/pkg")
    expect(text).toContain("--user 501:20")
    expect(text).toContain("--mount type=bind,src=/work/ws/src/a.ts,dst=/work/ws/src/a.ts,readonly")
    expect(text).toContain("--mount type=bind,src=/work/ws/dist,dst=/work/ws/dist ")
    expect(text).toContain("--env CI=1")
    expect(text).not.toContain("PATH=/ignored")
    expect(text).toContain("--env HOME=/tmp/home node:22 node build.js")
  })

  it("quotes mount fields whose path would break Docker's comma-separated mount syntax", () => {
    const plan = planned(
      host("win32", { docker: "docker" }, ["/work/ws/src/a.ts", "/srv/git/one,blue=x", "/srv/say \"hi\""]),
      {
        mechanism: Sandbox.Docker({ image: "node:22" }),
        reads: ["src/a.ts"],
        writes: [],
        writeFiles: [],
        readOnly: [],
        externalReads: ["/srv/git/one,blue=x", "/srv/say \"hi\""]
      }
    )
    const argv = ExecSandbox.docker(plan, ["node"], {}, linux)
    expect(argv).toContain("type=bind,\"src=/srv/git/one,blue=x\",\"dst=/srv/git/one,blue=x\",readonly")
    expect(argv).toContain("type=bind,\"src=/srv/say \"\"hi\"\"\",\"dst=/srv/say \"\"hi\"\"\",readonly")
    // A plain path keeps the unquoted spelling, and an `=` inside a value needs no quoting.
    expect(argv).toContain("type=bind,src=/work/ws/src/a.ts,dst=/work/ws/src/a.ts,readonly")
  })

  it("opens the bridge network only for an open policy", () => {
    const plan = planned(host("win32", { docker: "docker" }), {
      mechanism: Sandbox.Docker({ image: "node:22" }),
      policy: { network: true }
    })
    expect(ExecSandbox.docker(plan, ["true"], {}, linux).join(" ")).toContain("--network bridge")
  })

  it("omits the user mapping when the host reports no uid or no gid", () => {
    // Windows has neither, and `process.getuid` is absent there, so the plan
    // carries `undefined` and the argv must not name a half-formed user.
    const facts = host("win32", { docker: "docker" }, ["/work/ws/src/a.ts"], ["/work/ws/node_modules", "/work/ws/dist"])
    const declared = { mechanism: Sandbox.Docker({ image: "node:22" }) }
    const neither = planned({ ...facts, uid: undefined, gid: undefined }, declared)
    const gidOnly = planned({ ...facts, uid: undefined }, declared)
    const uidOnly = planned({ ...facts, gid: undefined }, declared)
    expect(neither.uid).toBeUndefined()
    for (const plan of [neither, gidOnly, uidOnly]) {
      expect(ExecSandbox.docker(plan, ["node"], {}, linux)).not.toContain("--user")
    }
    expect(ExecSandbox.docker(planned(facts, declared), ["node"], {}, linux)).toContain("--user")
  })
})

/**
 * The renderers are pure: a `Plan` in, a profile or an argv out. Pinning the
 * whole emitted text means neither mechanism can drift on the host that does
 * not run it, which is how a Linux-only or macOS-only change used to reach a
 * release unread.
 */
describe("every mechanism renders the same text on any host", () => {
  it("emits the seatbelt profile verbatim", () => {
    expect(ExecSandbox.seatbelt(planned(darwin), linux)).toBe(
      "(version 1)(allow default)" +
        "(deny network*)(allow network* (local unix-socket))" +
        "(deny file-write*)" +
        "(allow file-write* (subpath \"/dev\") (subpath \"/work/ws/out\") (subpath \"/work/ws/dist\")" +
        " (subpath \"/work/ws/.flows/sandbox/run1\"))" +
        "(deny file-write* (subpath \"/work/ws/.flows/cache\"))" +
        "(deny file-read*)(allow file-read* (literal \"/\") (subpath \"/dev\"))" +
        "(allow file-read* (literal \"/tmp\") (literal \"/var\") (literal \"/etc\"))" +
        "(allow file-read-metadata (literal \"/\") (literal \"/work\"))" +
        "(deny file-read* (subpath \"/work/ws\"))" +
        "(allow file-read-metadata (subpath \"/work/ws\"))" +
        "(allow file-read* (literal \"/work/ws\") (literal \"/work/ws/.flows\") (literal \"/work/ws/.flows/sandbox\")" +
        " (literal \"/work/ws/src\") (subpath \"/work/ws/src/a.ts\") (subpath \"/work/ws/node_modules\")" +
        " (subpath \"/work/ws/out\") (subpath \"/work/ws/dist\") (subpath \"/work/ws/.flows/sandbox/run1\"))"
    )
  })

  it("emits the bubblewrap argv verbatim", () => {
    expect(ExecSandbox.bubblewrap(planned(linux), ["node", "build.js"], linux)).toEqual([
      "/usr/bin/bwrap",
      "--tmpfs",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/tmp/home",
      "--dir",
      "/tmp/cache",
      "--tmpfs",
      "/work/ws",
      "--dir",
      "/work/ws/pkg",
      "--ro-bind",
      "/work/ws/src/a.ts",
      "/work/ws/src/a.ts",
      "--ro-bind",
      "/work/ws/node_modules",
      "/work/ws/node_modules",
      "--bind",
      "/work/ws/out",
      "/work/ws/out",
      "--bind",
      "/work/ws/dist",
      "/work/ws/dist",
      "--remount-ro",
      "/work/ws",
      "--remount-ro",
      "/",
      "--chdir",
      "/work/ws/pkg",
      "--unshare-all",
      "--new-session",
      "--die-with-parent",
      "--",
      "node",
      "build.js"
    ])
  })

  it("emits the docker argv verbatim", () => {
    const plan = planned(
      host("win32", { docker: "docker" }, ["/work/ws/src/a.ts"], ["/work/ws/node_modules", "/work/ws/dist"]),
      { mechanism: Sandbox.Docker({ image: "node:22" }) }
    )
    expect(ExecSandbox.docker(plan, ["node"], { CI: "1" }, linux, "smithers-fixture")).toEqual([
      "docker",
      "run",
      "--rm",
      "--init",
      "--name",
      "smithers-fixture",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,exec",
      "--network",
      "none",
      "--workdir",
      "/work/ws/pkg",
      "--user",
      "501:20",
      "--mount",
      "type=bind,src=/work/ws/src/a.ts,dst=/work/ws/src/a.ts,readonly",
      "--mount",
      "type=bind,src=/work/ws/node_modules,dst=/work/ws/node_modules,readonly",
      "--mount",
      "type=bind,src=/work/ws/out,dst=/work/ws/out",
      "--mount",
      "type=bind,src=/work/ws/dist,dst=/work/ws/dist",
      "--env",
      "CI=1",
      "--env",
      "HOME=/tmp/home",
      "node:22",
      "node"
    ])
  })

  it("refuses to render a mechanism the plan did not select", () => {
    const seatbeltPlan = planned(darwin)
    const bubblewrapPlan = planned(linux)
    expect(() => ExecSandbox.bubblewrap(seatbeltPlan, ["true"], linux)).toThrow(
      /bubblewrap argv needs a bubblewrap plan/
    )
    expect(() => ExecSandbox.seatbelt(bubblewrapPlan, linux)).toThrow(/a seatbelt profile needs a seatbelt plan/)
    expect(() => ExecSandbox.docker(seatbeltPlan, ["true"], {}, linux)).toThrow(/docker argv needs a docker plan/)
  })
})

describe("wrap and environment", () => {
  it("redirects the temporary and home directories into the confinement", () => {
    const seatbelt = ExecSandbox.wrap(planned(darwin), ["true"], {}, linux)
    expect(seatbelt.argv.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"])
    expect(seatbelt.env["TMPDIR"]).toBe("/work/ws/.flows/sandbox/run1")
    expect(seatbelt.env["HOME"]).toBe("/work/ws/.flows/sandbox/run1/home")
    const bubblewrap = ExecSandbox.wrap(planned(linux), ["true"], {}, linux)
    expect(bubblewrap.env["TMPDIR"]).toBe("/tmp")
    expect(bubblewrap.env["HOME"]).toBe("/tmp/home")
    expect(bubblewrap.env["XDG_CACHE_HOME"]).toBe("/tmp/cache")
  })

  it("keeps corepack's binary cache where the host has it, so a shim still finds its package manager", () => {
    const plan = planned(linux)
    expect(ExecSandbox.environment(plan, {}, "/home/dev")["COREPACK_HOME"]).toBe("/home/dev/.cache/node/corepack")
    expect(ExecSandbox.environment(plan, { XDG_CACHE_HOME: "/var/cache/dev" }, "/home/dev")["COREPACK_HOME"]).toBe(
      "/var/cache/dev/node/corepack"
    )
    expect(ExecSandbox.environment(plan, { COREPACK_HOME: "/opt/corepack" }, "/home/dev")["COREPACK_HOME"]).toBe(
      "/opt/corepack"
    )
    expect(ExecSandbox.environment(plan)["COREPACK_HOME"]).not.toBe("/tmp/cache/node/corepack")
  })
})

describe("diagnose", () => {
  it("names the workspace paths a tool was denied and which side of the boundary they fell on", () => {
    const plan = planned(linux)
    const text = [
      "/bin/sh: 1: cannot create /work/ws/pkg/notes.txt: Read-only file system",
      "Error: ENOENT: no such file or directory, open '/work/ws/src/b.ts'",
      "/bin/sh: /work/ws/dist/x.js: Operation not permitted",
      "EACCES: permission denied, open '/etc/passwd'"
    ].join("\n")
    const note = ExecSandbox.diagnose(plan, text)
    expect(note).toContain("sandbox: pkg/notes.txt is outside the declared write set")
    expect(note).toContain("sandbox: src/b.ts is outside the declared read set")
    expect(note).toContain("sandbox: dist/x.js was denied inside the declared set")
    expect(note).not.toContain("/etc/passwd")
    expect(note).toContain("bubblewrap, network none")
  })

  it("stays silent when the output names no workspace path", () => {
    expect(ExecSandbox.diagnose(planned(linux), "everything is fine")).toBeUndefined()
  })

  it("reports an escape bubblewrap never mounted as a write outside the declared set", () => {
    // Under bubblewrap an undeclared path is absent rather than forbidden, and
    // dash reports that absence as "Directory nonexistent" against a bare
    // relative path; seatbelt says EPERM for the same escape.
    const plan = planned(linux, { reads: [], writes: ["out"] })
    const note = ExecSandbox.diagnose(
      plan,
      "/bin/sh: 1: cannot create linkdir/target.txt: Directory nonexistent"
    )
    expect(note).toContain("sandbox: pkg/linkdir/target.txt is outside the declared write set")
    const rootDenied = ExecSandbox.diagnose(plan, "sh: line 1: cannot create out/note.txt: Read-only file system")
    expect(rootDenied).toContain("sandbox: pkg/out/note.txt is outside the declared write set")
  })

  it("reports a write that leaves the workspace through a symlink as outside the write set", () => {
    // The declared output out.txt sits at the top level, so the write
    // directory is the root itself and linkdir/target.txt is lexically
    // covered; linkdir points outside the workspace, so the write escaped.
    const root = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "smthrs-ws-")))
    const elsewhere = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "smthrs-out-")))
    try {
      NodeFs.symlinkSync(elsewhere, NodePath.join(root, "linkdir"))
      const plan: ExecSandbox.Plan = {
        ...planned(linux, { reads: [], writes: [], writeFiles: ["out.txt"] }),
        workspaceRoot: root,
        cwd: root,
        writes: [root]
      }
      const note = ExecSandbox.diagnose(plan, "/bin/sh: 1: cannot create linkdir/target.txt: Directory nonexistent")
      expect(note).toMatch(/sandbox: linkdir\/target\.txt resolves to .* outside the declared write set/)
      const inside = ExecSandbox.diagnose(plan, "/bin/sh: 1: cannot create sub/target.txt: Directory nonexistent")
      expect(inside).toContain("sandbox: sub/target.txt was denied inside the declared set")
    } finally {
      NodeFs.rmSync(root, { recursive: true, force: true })
      NodeFs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it("reads relative paths against the working directory", () => {
    const plan = planned(darwin, { reads: ["src/a.ts"], writes: [] })
    const note = ExecSandbox.diagnose(plan, "sh: line 1: out/esc: Operation not permitted")
    expect(note).toContain(`sandbox: ${NodePath.posix.join("pkg", "out/esc")} is outside the declared read set`)
  })
})

describe("host", () => {
  it("resolves executables on PATH and refuses a missing one", () => {
    const real = ExecSandbox.host()
    expect(real.platform).toBe(process.platform)
    expect(real.executable("definitely-not-a-real-executable-xyz")).toBeUndefined()
    const node = real.executable(NodePath.basename(process.execPath))
    if (node !== undefined) expect(NodePath.isAbsolute(node)).toBe(true)
    expect(real.exists(process.execPath)).toBe(true)
    expect(real.isDirectory(NodePath.dirname(process.execPath))).toBe(true)
    expect(real.isDirectory("/definitely/not/a/real/directory")).toBe(false)
    expect(real.entries?.("/definitely/not/a/real/directory")).toBeUndefined()
    expect(real.realpath?.("/definitely/not/a/real/path")).toBeUndefined()
  })
})
