/**
 * Package-mode planning of the aomi-shaped cargo graph.
 *
 * The fixture is the shape the aomi-sdk design partner declares, reduced to
 * what one assertion needs: a toolchain-only workspace, a fetch resource with
 * declared deliverables, a package build that names a bin, a crate set built
 * by subtracting one `S.Cargo.AppSet` from another, and a `S.Shell.Build`
 * that takes the built binary as its tool edge.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as PackageTree from "../src/PackageTree.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const workspaceModule = `import { Smithers as S } from "@smthrs/targets"
const rust = S.Rust.Toolchain({ workspace: S.file("//Cargo.toml"), channel: "1.91" })
export const Workspace = S.Workspace("cargo-fixture", {
  repository: "git+https://example.invalid/cargo.git",
  cache: S.Cache({ directory: ".flows" }),
  toolchains: [rust],
  host: S.Host({ bins: ["cargo"] })
})
`

const rootPackage = `import { Smithers as S } from "@smthrs/targets"
import { Package as sdk } from "./sdk/PACKAGE.js"
const plugins = S.Shell.Build({
  bin: sdk.buildCli,
  args: ["compile"],
  data: [sdk.fetch],
  outDirs: ["plugins"]
})
export const Package = S.Package({ targets: { plugins } })
`

// The sources are globbed as `*.rs` rather than `**` so that an assertion
// about one attr — which cargo home the fetch delivers to — is not also an
// assertion about this file's own bytes landing in the source set.
const sdkPackage = `import { Smithers as S } from "@smthrs/targets"
const srcs = S.Filegroup({ srcs: S.glob(["**/*.rs"]) })
const fetch = S.Cargo.Fetch({
  workspace: S.file("//Cargo.toml"),
  outFiles: ["//Cargo.lock"],
  outDirs: ["//.cargo-home"],
  sandbox: { network: true }
})
const buildCli = S.Cargo.Build({
  package: "aomi-sdk",
  features: ["cli"],
  bins: ["aomi-build"],
  locked: true,
  offline: true,
  data: [srcs, fetch],
  outDirs: ["//target"]
})
const clippy = S.Cargo.Clippy({
  workspace: true,
  lib: true,
  denyWarnings: true,
  locked: true,
  offline: true,
  data: [srcs, fetch]
})
const format = S.Cargo.Fmt({ workspace: true, data: [srcs], changes: ["**/*.rs"] })
export const Package = S.Package({ targets: { buildCli, clippy, fetch, format, srcs } })
`

const appsPackage = `import { Smithers as S } from "@smthrs/targets"
const srcs = S.Filegroup({ srcs: S.glob(["**", "!target/**"]) })
const allApps = S.Cargo.AppSet({ manifests: S.glob(["*/Cargo.toml"]) })
const skippedApps = S.Cargo.AppSet({
  manifests: S.glob(["*/Cargo.toml"]),
  metadata: { aomi: { skip: true } }
})
const crates = S.Files.difference(allApps, skippedApps)
// Every app crate is its own lockfile domain, so the crate set is what the
// fetch locks: one workspace manifest cannot deliver what 35 excluded crates
// resolve against.
const fetch = S.Cargo.Fetch({ crates, outDirs: ["//.cargo-home"], sandbox: { network: true } })
const format = S.Cargo.Fmt({ crates, data: [srcs], changes: ["**/*.rs"] })
const compile = S.Cargo.Build({ crates, lib: true, locked: true, offline: true, data: [srcs, fetch] })
export const Package = S.Package({ targets: { compile, fetch, format, srcs } })
`

const manifest = (name: string, skip: boolean): string =>
  `[package]\nname = ${JSON.stringify(name)}\nversion = "0.1.0"\n` +
  (skip ? `\n[package.metadata.aomi]\nskip = true\n` : "")

const fixture = async (options: { readonly cargoHome?: string } = {}): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-cargo-plan-")))
  temporaryDirectories.push(root)
  await write(root, "WORKSPACE.ts", workspaceModule)
  await write(root, "PACKAGE.ts", rootPackage)
  await write(
    root,
    "sdk/PACKAGE.ts",
    options.cargoHome === undefined
      ? sdkPackage
      : sdkPackage.replace("\"//.cargo-home\"", JSON.stringify(`//${options.cargoHome}`))
  )
  await write(root, "apps/PACKAGE.ts", appsPackage)
  await write(root, "Cargo.toml", "[workspace]\nmembers = [\"sdk\"]\n")
  await write(root, "sdk/Cargo.toml", manifest("aomi-sdk", false))
  await write(root, "sdk/src/lib.rs", "pub fn ok() {}\n")
  await write(root, "apps/alpha/Cargo.toml", manifest("aomi-app-alpha", false))
  await write(root, "apps/beta/Cargo.toml", manifest("aomi-app-beta", true))
  return root
}

const planOf = async (root: string, pattern: string): Promise<PackageExec.PackagePlan> => {
  const discovery = await PackageDiscovery.discover(root)
  const loaded = await PackageLoader.load(discovery)
  return PackageExec.plan({
    index: PackageIndex.make(loaded),
    cacheDirectory: ".flows",
    verb: "auto",
    patterns: [pattern],
    plan: true
  })
}

const nodeOf = (planned: PackageExec.PackagePlan, label: string): PackageExec.PackageNode => {
  const node = planned.nodes.get(label)
  if (node === undefined) throw new Error(`no planned node ${label} in ${[...planned.nodes.keys()].join(", ")}`)
  return node
}

const commandsOf = (node: PackageExec.PackageNode): ReadonlyArray<ReadonlyArray<string>> => {
  if (node.lane?.kind !== "cargo") throw new Error(`${node.label} planned no cargo lane`)
  return node.lane.commands
}

const hasCargo = PackageTree.findOnPath("cargo") !== undefined

describe.skipIf(!hasCargo)("cargo build-system planning", () => {
  it("plans every cargo rule with no refusal and the resolved cargo executable", async () => {
    const root = await fixture()
    const planned = await planOf(root, "//...")
    const refusals = [...planned.nodes.values()]
      .filter((node) => node.refusal !== undefined)
      .map((node) => `${node.label}: ${node.refusal}`)
    expect(refusals).toEqual([])
    const format = nodeOf(planned, "//sdk:format")
    expect(format.rule).toBe("Cargo.Fmt")
    // The formatter is a check by default; the write form needs --write/--fix.
    expect(format.mode).toBe("check")
    expect(commandsOf(format)).toHaveLength(1)
    expect(commandsOf(format)[0]!.slice(1)).toEqual(["fmt", "--all", "--", "--check"])
    expect(NodePath.basename(commandsOf(format)[0]![0]!)).toBe("cargo")
    expect(NodePath.isAbsolute(commandsOf(format)[0]![0]!)).toBe(true)
  })

  it("renders the offline dependents against the fetch resource's deliverables", async () => {
    const root = await fixture()
    const planned = await planOf(root, "//...")
    const fetch = nodeOf(planned, "//sdk:fetch")
    expect(commandsOf(fetch)[0]!.slice(1)).toEqual(["fetch", "--manifest-path", "Cargo.toml"])
    // The fetch resource owns CARGO_HOME: the registry it downloads is its
    // declared output directory, and every offline dependent reads it there.
    expect(fetch.env["CARGO_HOME"]).toBe(".cargo-home")
    // The declared channel is selected, not hoped for: a host without it fails
    // at the start of the run naming the channel, not mid-compile.
    expect(fetch.env["RUSTUP_TOOLCHAIN"]).toBe("1.91")
    const clippy = nodeOf(planned, "//sdk:clippy")
    expect(commandsOf(clippy)[0]!.slice(1))
      .toEqual(["clippy", "--workspace", "--lib", "--locked", "--offline", "--", "-D", "warnings"])
    expect(clippy.env["CARGO_HOME"]).toBe(".cargo-home")
    // `--offline` says "resolve only from the fetch" to this cargo alone; the
    // environment says it to every cargo the run spawns underneath it.
    expect(clippy.env["CARGO_NET_OFFLINE"]).toBe("true")
    expect(clippy.dependencies).toContain("//sdk:fetch")
  })

  it("locks each crate of a set when the fetch names the set, not one manifest", async () => {
    const root = await fixture()
    const planned = await planOf(root, "//apps:compile")
    expect(commandsOf(nodeOf(planned, "//apps:fetch")).map((command) => command.slice(1))).toEqual([
      ["fetch", "--manifest-path", "apps/alpha/Cargo.toml"]
    ])
    const compile = nodeOf(planned, "//apps:compile")
    expect(compile.env["CARGO_HOME"]).toBe(".cargo-home")
    expect(commandsOf(compile).map((command) => command.slice(1))).toEqual([
      ["build", "--manifest-path", "apps/alpha/Cargo.toml", "--lib", "--locked", "--offline"]
    ])
  })

  it("subtracts the skipped crate set and runs cargo once per remaining crate", async () => {
    const root = await fixture()
    const planned = await planOf(root, "//apps:format")
    const format = nodeOf(planned, "//apps:format")
    expect(commandsOf(format).map((command) => command.slice(1))).toEqual([
      ["fmt", "--manifest-path", "apps/alpha/Cargo.toml", "--all", "--", "--check"]
    ])
  })

  it("keys a crate-set target on the crate set, so an opt-out re-keys it", async () => {
    const root = await fixture()
    const before = nodeOf(await planOf(root, "//apps:format"), "//apps:format").keyPreview
    await write(root, "apps/alpha/Cargo.toml", manifest("aomi-app-alpha", true))
    const after = nodeOf(await planOf(root, "//apps:format"), "//apps:format")
    expect(after.keyPreview).not.toBe(before)
    // Every crate opted out, so the target has no work left to do.
    expect(commandsOf(after)).toEqual([])
  })

  it("keys a fetch dependent on the lockfile content, not on the fetch declaration", async () => {
    const root = await fixture()
    await write(root, "Cargo.lock", "version = 4\n")
    const before = nodeOf(await planOf(root, "//sdk:clippy"), "//sdk:clippy").keyPreview
    await write(root, "Cargo.lock", "version = 4\n\n[[package]]\nname = \"serde\"\n")
    const after = nodeOf(await planOf(root, "//sdk:clippy"), "//sdk:clippy").keyPreview
    expect(after).not.toBe(before)
  })

  it("re-keys the offline dependents when the fetch delivers to a different cargo home", async () => {
    // The cargo home is what `--offline` reads. A fetch that moves it hands
    // every dependent a different registry, so a key that ignored it would
    // replay a verdict the new home never produced.
    const before = nodeOf(await planOf(await fixture(), "//sdk:clippy"), "//sdk:clippy")
    const after = nodeOf(await planOf(await fixture({ cargoHome: ".cargo-elsewhere" }), "//sdk:clippy"), "//sdk:clippy")
    expect(after.env["CARGO_HOME"]).toBe(".cargo-elsewhere")
    expect(before.env["CARGO_HOME"]).toBe(".cargo-home")
    expect(after.keyPreview).not.toBe(before.keyPreview)
  })

  it("plans the bare fetch form for a declaration that names neither manifest nor crate set", async () => {
    const root = await fixture()
    await write(
      root,
      "sdk/PACKAGE.ts",
      sdkPackage.replace("workspace: S.file(\"//Cargo.toml\"),\n  outFiles", "outFiles")
    )
    const fetch = nodeOf(await planOf(root, "//sdk:fetch"), "//sdk:fetch")
    expect(fetch.refusal).toBeUndefined()
    expect(commandsOf(fetch).map((command) => command.slice(1))).toEqual([["fetch"]])
  })

  it("takes a cargo build target as a shell tool edge and spawns the binary it declares", async () => {
    const root = await fixture()
    const planned = await planOf(root, "//:plugins")
    const plugins = nodeOf(planned, "//:plugins")
    expect(plugins.refusal).toBeUndefined()
    // The plan keeps the workspace-relative form so two checkouts of the same
    // tree key alike; the spawn substitutes the absolute root.
    expect(plugins.argv?.[0]).toBe(`${PackageExec.workspaceRootToken}/target/debug/aomi-build`)
    expect(plugins.argv?.slice(1)).toEqual(["compile"])
    expect(plugins.dependencies).toContain("//sdk:buildCli")
  })

  it("refuses an underspecified container build instead of silently running it on the host", async () => {
    const root = await fixture()
    await write(
      root,
      "sdk/PACKAGE.ts",
      sdkPackage.replace(
        "export const Package",
        `const cross = S.Cargo.Build({ package: "aomi-sdk", target: "mips64-unknown-none", container: "docker", data: [], outDirs: ["//target/prestates"] })
export const Package`
      ).replace("targets: { buildCli", "targets: { cross, buildCli")
    )
    expect(nodeOf(await planOf(root, "//sdk:cross"), "//sdk:cross").refusal)
      .toContain("declares no image or container command")
  })

  it("keys cargo plugins when present and refuses a missing one by executable name", async () => {
    const root = await fixture()
    await write(root, "deny.toml", "[licenses]\nallow = []\n")
    await write(
      root,
      "sdk/PACKAGE.ts",
      sdkPackage.replace(
        "export const Package",
        `const deny = S.Cargo.Deny({ config: S.file("//deny.toml"), data: [] })
export const Package`
      ).replace("targets: { buildCli", "targets: { deny, buildCli")
    )
    const deny = nodeOf(await planOf(root, "//sdk:deny"), "//sdk:deny")
    if (PackageTree.findOnPath("cargo-deny") === undefined) {
      expect(deny.refusal).toContain("host binary \"cargo-deny\" is not present on PATH")
    } else {
      expect(deny.refusal).toBeUndefined()
      expect(commandsOf(deny)[0]!.slice(1)).toEqual(["deny", "--config", "deny.toml", "check"])
    }
  })
})
