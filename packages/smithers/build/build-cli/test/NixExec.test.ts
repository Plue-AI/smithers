/**
 * Resolving a declared Nix environment and keying targets on it.
 *
 * Most cases drive a fake `nix` on PATH that answers the three commands the
 * resolver runs with canned output, so the contract is exercised without a
 * Nix store: refusals are typed, resolution is memoized, declared versions
 * are asserted against the closure, and the planner folds the closure into
 * every spawning target's key. No case runs the real `nix`.
 */
import * as Input from "@smthrs/targets/Input"
import * as Nix from "@smthrs/targets/Nix"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as NixExec from "../src/NixExec.ts"

const rulesModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
/** A 32-character store hash from the Nix base-32 alphabet. */
const hash = "0123456789abcdfghijklmnpqrsvwxyz"

let root: string
let store: string
let fakeBin: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const script = (body: string): string => `#!/bin/sh\n${body}\n`

/**
 * Installs a fake `nix` plus a fake closure holding `node` and `pnpm`.
 *
 * `nix build` prints the closure's store path, `print-dev-env` exports its
 * `bin` on PATH and one carried variable, `path-info --recursive` lists two
 * paths. Every `build` appends to a counter so a test can prove the memo
 * skipped evaluation.
 */
const installFakeNix = async (options: { readonly node?: string; readonly pnpm?: string } = {}): Promise<void> => {
  store = NodePath.join(root, "store")
  const closure = NodePath.join(store, `${hash}-fake-env`)
  const dependency = NodePath.join(store, `${hash.split("").reverse().join("")}-fake-dep`)
  await Fs.mkdir(NodePath.join(closure, "bin"), { recursive: true })
  await Fs.mkdir(dependency, { recursive: true })
  await Fs.writeFile(
    NodePath.join(closure, "bin", "node"),
    script(`echo "${options.node ?? "v22.19.0"}"`),
    { mode: 0o755 }
  )
  await Fs.writeFile(
    NodePath.join(closure, "bin", "pnpm"),
    script(`echo "${options.pnpm ?? "11.21.0"}"`),
    { mode: 0o755 }
  )
  fakeBin = NodePath.join(root, "fake-bin")
  await Fs.mkdir(fakeBin, { recursive: true })
  const counter = NodePath.join(root, "nix-build-count")
  await Fs.writeFile(
    NodePath.join(fakeBin, "nix"),
    script(
      [
        `case "$1" in --version) echo "nix (Nix) 2.99.0"; exit 0;; esac`,
        `sub=""`,
        `for a in "$@"; do case "$a" in build|print-dev-env|path-info) sub="$a"; break;; esac; done`,
        `case "$sub" in`,
        `  build) echo x >> ${JSON.stringify(counter)}; echo ${JSON.stringify(closure)};;`,
        `  print-dev-env) printf '%s' '{"variables":{"PATH":{"type":"exported","value":"${closure}/bin"},` +
        `"SSL_CERT_FILE":{"type":"exported","value":"/etc/ssl/cert.pem"},` +
        `"NIX_BUILD_CORES":{"type":"exported","value":"4"}}}';;`,
        `  path-info) printf '%s\\n%s\\n' ${JSON.stringify(dependency)} ${JSON.stringify(closure)};;`,
        `  *) echo "fake nix: unknown command $*" >&2; exit 2;;`,
        `esac`
      ].join("\n")
    ),
    { mode: 0o755 }
  )
}

const buildCount = async (): Promise<number> => {
  try {
    return (await Fs.readFile(NodePath.join(root, "nix-build-count"), "utf8")).split("x").length - 1
  } catch {
    return 0
  }
}

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-nix-"))
  root = await Fs.realpath(root)
  await write("flake.nix", "{ outputs = { self }: { }; }\n")
  await write("flake.lock", "{ \"nodes\": {}, \"root\": \"root\", \"version\": 7 }\n")
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Fs.rm(root, { recursive: true, force: true })
})

const declaration = (): Nix.Environment => Nix.Environment({ flake: Input.file("//flake.nix") })

describe.skipIf(process.platform === "win32")("NixExec.resolveEnvironment", () => {
  it("refuses a host without nix", async () => {
    vi.stubEnv("PATH", NodePath.join(root, "empty"))
    await expect(NixExec.resolveEnvironment({ root, declaration: declaration() })).rejects.toMatchObject({
      _tag: "smithers-build/NixEnvironmentError",
      code: "nix_absent"
    })
  })

  it("refuses a flake without its lock and names the fix", async () => {
    await installFakeNix()
    vi.stubEnv("PATH", fakeBin)
    await Fs.rm(NodePath.join(root, "flake.lock"))
    await expect(NixExec.resolveEnvironment({ root, declaration: declaration() })).rejects.toMatchObject({
      code: "nix_input_missing",
      message: expect.stringContaining("nix flake lock")
    })
  })

  it("resolves the closure, its PATH, the carried variables, and the transitive closure", async () => {
    await installFakeNix()
    vi.stubEnv("PATH", fakeBin)
    const resolved = await NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" })
    expect(resolved.storePath).toBe(NodePath.join(store, `${hash}-fake-env`))
    expect(resolved.hash).toBe(hash)
    expect(resolved.path).toEqual([NodePath.join(store, `${hash}-fake-env`, "bin")])
    expect(resolved.variables).toEqual({ SSL_CERT_FILE: "/etc/ssl/cert.pem" })
    expect(resolved.closure).toHaveLength(2)
    expect(resolved.closure).toContain(resolved.storePath)
    expect(resolved.nix.version).toBe("nix (Nix) 2.99.0")
    expect(resolved.inputs.map((input) => input.path)).toEqual(["flake.nix", "flake.lock"])
    expect(NixExec.layer(resolved)).toBe(`nix:${hash}`)
    expect(NixExec.toolEnvironment(resolved)).toEqual({
      path: NodePath.join(store, `${hash}-fake-env`, "bin"),
      variables: { SSL_CERT_FILE: "/etc/ssl/cert.pem" }
    })
    expect(NixExec.hostEnvironmentWith(resolved, { PATH: "/usr/bin", HOME: "/home/x" })).toEqual({
      PATH: NodePath.join(store, `${hash}-fake-env`, "bin"),
      HOME: "/home/x",
      SSL_CERT_FILE: "/etc/ssl/cert.pem"
    })
  })

  it("memoizes a resolution under the cache directory and reuses it while the store path exists", async () => {
    await installFakeNix()
    vi.stubEnv("PATH", fakeBin)
    const first = await NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" })
    expect(await buildCount()).toBe(1)
    const second = await NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" })
    expect(second).toEqual(first)
    expect(await buildCount()).toBe(1)
    const memos = await Fs.readdir(NodePath.join(root, ".flows", "nix"))
    expect(memos).toHaveLength(1)
    // An edited lock re-keys the memo, so the closure is evaluated again.
    await write("flake.lock", "{ \"nodes\": {}, \"root\": \"root\", \"version\": 8 }\n")
    await NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" })
    expect(await buildCount()).toBe(2)
    // A store path that vanished invalidates the memo rather than answering for it.
    await Fs.rm(first.storePath, { recursive: true, force: true })
    await write("flake.lock", "{ \"nodes\": {}, \"root\": \"root\", \"version\": 7 }\n")
    await expect(NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" }))
      .resolves.toMatchObject({ hash })
    expect(await buildCount()).toBe(3)
  })

  it("asserts declared tool versions against the closure alone", async () => {
    await installFakeNix({ node: "v22.20.1" })
    vi.stubEnv("PATH", fakeBin)
    const resolved = await NixExec.resolveEnvironment({ root, declaration: declaration() })
    await expect(NixExec.assertToolVersion(resolved, { name: "node", requirement: ">=22.19.0" }, { root }))
      .resolves.toBe("22.20.1")
    await expect(NixExec.assertToolVersion(resolved, { name: "pnpm", requirement: "11.21.0" }, { root }))
      .resolves.toBe("11.21.0")
    await expect(NixExec.assertToolVersion(resolved, { name: "node", requirement: ">=24.0.0" }, { root }))
      .rejects.toMatchObject({
        code: "nix_version_mismatch",
        message: expect.stringContaining("declares node >=24.0.0 but the Nix environment provides node 22.20.1")
      })
    await expect(NixExec.assertToolVersion(resolved, { name: "bun", requirement: ">=1.4.0" }, { root }))
      .rejects.toMatchObject({ code: "nix_tool_absent" })
  })
})

describe("NixExec pure helpers", () => {
  it("compares versions the way declarations spell requirements", () => {
    expect(NixExec.satisfies("22.19.0", ">=22.19.0")).toBe(true)
    expect(NixExec.satisfies("22.18.9", ">=22.19.0")).toBe(false)
    expect(NixExec.satisfies("23.0.0", ">=22.19.0")).toBe(true)
    expect(NixExec.satisfies("11.21.0", "11.21.0")).toBe(true)
    expect(NixExec.satisfies("11.21.1", "11.21.0")).toBe(false)
    expect(NixExec.satisfies("0.0.1", ">=0.0.0")).toBe(true)
  })

  it("names the host system the way a flake does", () => {
    expect(NixExec.hostSystem("linux", "x64")).toBe("x86_64-linux")
    expect(NixExec.hostSystem("linux", "arm64")).toBe("aarch64-linux")
    expect(NixExec.hostSystem("darwin", "arm64")).toBe("aarch64-darwin")
  })
})
