import { describe, expect, it } from "vitest"
import * as ExecSandbox from "../src/ExecSandbox.ts"
import { Sandbox } from "../src/WorkspaceDeclaration.ts"

const root = "/work/ws"

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

describe("build policy planning", () => {
  it("returns nothing for an opted-out policy and the refusal for an unenforceable host", () => {
    expect(
      ExecSandbox.plan({ ...request, policy: "none" }, { workspaceRoot: root, cwd: root, tmp: "/t" }, linux)
    ).toBeUndefined()
    const refused = ExecSandbox.plan(request, { workspaceRoot: root, cwd: root, tmp: "/t" }, host("linux"))
    expect(ExecSandbox.isUnenforceable(refused)).toBe(true)
  })
})

describe("build declaration lowering", () => {
  it("lowers loopback and output-file declarations into the shared mechanism", () => {
    const result = ExecSandbox.plan(
      { ...request, policy: { network: "loopback" } },
      { workspaceRoot: root, cwd: root, tmp: "/work/private" },
      darwin
    )
    if (result === undefined || ExecSandbox.isUnenforceable(result)) throw new Error("expected a plan")
    expect(result.network).toBe("loopback")
    expect([...result.writes].sort()).toEqual(["/work/ws/dist", "/work/ws/out"])
    expect(result.mechanism._tag).toBe("seatbelt")
    expect(ExecSandbox.enforceable(request, darwin)).toBe(true)
  })

  it("uses a Docker image declaration with the explicitly opened network", () => {
    const result = ExecSandbox.plan(
      { ...request, policy: { network: true }, mechanism: Sandbox.Docker({ image: "node:22" }) },
      { workspaceRoot: root, cwd: root, tmp: "/work/private" },
      windows
    )
    if (result === undefined || ExecSandbox.isUnenforceable(result)) throw new Error("expected a plan")
    expect(result.network).toBe("open")
    expect(result.mechanism).toEqual({ _tag: "docker", executable: "C:\\docker.exe", image: "node:22" })
  })

  it("keeps explicit mechanism opt-out out of planning", () => {
    expect(ExecSandbox.plan(
      { ...request, mechanism: Sandbox.None() },
      { workspaceRoot: root, cwd: root, tmp: "/work/private" },
      linux
    )).toBeUndefined()
  })
})

describe("build corepack launcher regression", () => {
  it("execs the corepack shim of a Node distribution by its real file, inside the granted node_modules", () => {
    // `<prefix>/bin/pnpm` links into `<prefix>/lib/node_modules/corepack`, which the runtime grant already covers.
    const shim = "/opt/node/bin/pnpm"
    const target = "/opt/node/lib/node_modules/corepack/dist/pnpm.js"
    const facts: ExecSandbox.Host = {
      ...host("linux", { bwrap: "/usr/bin/bwrap", node: "/opt/node/bin/node", [shim]: shim }, [
        "/opt/node/bin/node",
        shim,
        target
      ], ["/opt/node/lib/node_modules", "/home/runner/.cache/node/corepack"]),
      home: "/home/runner",
      realpath: (path) => path === shim ? target : path
    }
    const plan = ExecSandbox.plan({ policy: {}, reads: [], writes: [] }, {
      workspaceRoot: root,
      cwd: root,
      tmp: "/work/private"
    }, facts)
    if (plan === undefined || ExecSandbox.isUnenforceable(plan)) throw new Error("expected a plan")
    const argv = ExecSandbox.bubblewrap(plan, ["pnpm", "exec", "vitest"], facts, "/opt/node/bin")
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual([target, "exec", "vitest"])
    const text = argv.join(" ")
    expect(text).toContain("--ro-bind /opt/node/lib/node_modules /opt/node/lib/node_modules")
    expect(text).toContain("--ro-bind /opt/node/bin/node /opt/node/bin/node")
    expect(text).toContain("--ro-bind /home/runner/.cache/node/corepack /home/runner/.cache/node/corepack")
    expect(text).not.toContain("--ro-bind /opt/node /opt/node")
  })
})
