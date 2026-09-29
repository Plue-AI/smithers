/**
 * The build's policy over the operating-system sandbox.
 *
 * The mechanism contract itself (planning, symlink refusal, the bubblewrap,
 * seatbelt and docker renderings, diagnosis) is @smthrs/platform-node's
 * `ProcessSandbox` and is covered there. This suite covers what the build adds:
 * the policy vocabulary, the workspace mechanism declarations, and the advice
 * every refusal carries.
 */
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

describe("plan", () => {
  it("returns nothing for an opted-out policy and the refusal for an unenforceable host", () => {
    expect(
      ExecSandbox.plan({ ...request, policy: "none" }, { workspaceRoot: root, cwd: root, tmp: "/t" }, linux)
    ).toBeUndefined()
    const refused = ExecSandbox.plan(request, { workspaceRoot: root, cwd: root, tmp: "/t" }, host("linux"))
    expect(ExecSandbox.isUnenforceable(refused)).toBe(true)
    if (ExecSandbox.isUnenforceable(refused)) expect(refused.message).toContain("never runs unconfined")
    expect(
      ExecSandbox.plan({ ...request, mechanism: Sandbox.None() }, { workspaceRoot: root, cwd: root, tmp: "/t" }, linux)
    ).toBeUndefined()
    expect(ExecSandbox.plan(request, { workspaceRoot: root, cwd: `${root}/pkg`, tmp: "/t" }, linux)).toMatchObject({
      mechanism: { _tag: "bubblewrap" },
      network: "none",
      cwd: "/work/ws/pkg"
    })
  })
})
