/**
 * The build-system cargo surface: `S.Cargo.Fetch/Build/Test/Clippy/Fmt/Doc`
 * and the `S.Cargo.AppSet` crate set.
 *
 * The flags that make a check a gate live in the target, not at the call site,
 * so the assertions here are about argv: what each declaration renders, in
 * which order, and which selector it renders it for.
 */
import { describe, expect, it } from "vitest"
import * as Cargo from "../src/Cargo.ts"
import * as Compose from "../src/Compose.ts"
import * as Input from "../src/Input.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"

const workspaceSelection = { _tag: "Workspace" } as const
const attrsOf = (target: unknown): Record<string, unknown> =>
  Target.metadata(target as never).attrs as Record<string, unknown>

/**
 * The argv a declaration renders. The selection comes from the declaration
 * itself when it fixes one, exactly as the planner derives it; a crate-set
 * declaration takes the selection the caller passes, one crate at a time.
 */
const args = (
  target: unknown,
  selection: Cargo.CrateSelection = workspaceSelection,
  mode: "check" | "write" | "execute" = "execute"
): ReadonlyArray<string> =>
  Cargo.packageArgs(
    Target.metadata(target as never).target,
    attrsOf(target),
    Cargo.selectionOf(attrsOf(target)) ?? selection,
    mode
  )

describe("Cargo.Fetch", () => {
  const fetch = Cargo.Fetch({
    workspace: Input.file("//Cargo.toml"),
    outFiles: ["//Cargo.lock"],
    outDirs: ["//.cargo-home"],
    sandbox: { network: true }
  })

  it("renders the one network step and names its deliverables", () => {
    expect(Target.metadata(fetch as never).target).toBe("Cargo.Fetch")
    // The declared manifest is the selection; the planner passes the path it
    // resolved the `//`-anchored declaration to.
    expect(Cargo.selectionOf(attrsOf(fetch))).toEqual({ _tag: "Manifest", path: "//Cargo.toml" })
    expect(Cargo.packageArgs("Cargo.Fetch", attrsOf(fetch), { _tag: "Manifest", path: "Cargo.toml" }))
      .toEqual(["fetch", "--manifest-path", "Cargo.toml"])
    expect(Cargo.packageArgs("Cargo.Fetch", attrsOf(fetch), { _tag: "Workspace" })).toEqual(["fetch"])
    expect(attrsOf(fetch)["outFiles"]).toEqual(["//Cargo.lock"])
    expect(attrsOf(fetch)["outDirs"]).toEqual(["//.cargo-home"])
    // The workspace manifest it locks against is key material.
    expect(Target.metadata(fetch as never).inputs).toEqual([{ _tag: "File", path: "//Cargo.toml" }])
  })

  it("participates in the build verb, because its product is its deliverables", () => {
    expect(Target.metadata(fetch as never).kinds).toEqual(["build"])
  })

  it("renders the bare form for a fetch that names neither a manifest nor a set", () => {
    // `cargo fetch` with no `--manifest-path` resolves the manifest in the
    // directory it runs from, which is the workspace root every target spawns
    // from. The declaration is legal and the rendering says so.
    const bare = Cargo.Fetch({ outDirs: ["//.cargo-home"], sandbox: { network: true } })
    expect(Cargo.selectionOf(attrsOf(bare))).toBeUndefined()
    expect(Cargo.packageArgs("Cargo.Fetch", attrsOf(bare), { _tag: "Workspace" })).toEqual(["fetch"])
  })

  it.each(
    [
      [null, undefined],
      [{ workspace: true }, { _tag: "Workspace" }],
      [{ package: "api" }, { _tag: "Package", name: "api" }]
    ] as const
  )("derives the selection represented by %o", (attrs, expected) => {
    expect(Cargo.selectionOf(attrs)).toEqual(expected)
  })

  it("refuses a fetch that names both a manifest and a crate set", () => {
    // Both are selectors and they say different things about what is locked;
    // silently preferring one would lock a domain the declaration did not name.
    expect(() =>
      Cargo.Fetch({
        workspace: Input.file("//Cargo.toml"),
        crates: Cargo.AppSet({ manifests: Input.glob(["*/Cargo.toml"]) }),
        outDirs: ["//.cargo-home"]
      })
    ).toThrow(/at most one of workspace, crates/)
  })
})

describe("a build target as a tool edge", () => {
  const buildCli = Cargo.Build({ package: "aomi-sdk", bins: ["aomi-build"], data: [] })

  it("spawns the built binary itself, with the declaration's own arguments", () => {
    const payload = Shell.execPayload({ bin: buildCli, args: ["compile"] })
    expect(payload.argv).toEqual([Shell.targetBinToken, "compile"])
  })

  it("refuses runtime flags, which belong to a JavaScript runtime it is not", () => {
    // Dropping them silently would run a different command than the one the
    // declaration spells, so the declaration is rejected instead.
    expect(() => Shell.execPayload({ bin: buildCli, args: ["compile"], runtimeArgs: ["--enable-source-maps"] }))
      .toThrow(/runtimeArgs/)
  })
})

describe("Cargo.Build", () => {
  it.each([
    [{ bins: ["tool"] }, [`target/debug/tool${process.platform === "win32" ? ".exe" : ""}`]],
    [{ bins: ["tool"], target: "aarch64-apple-darwin" }, ["target/aarch64-apple-darwin/debug/tool"]],
    [{ bins: ["tool"], target: "x86_64-pc-windows-msvc", profile: "release" }, [
      "target/x86_64-pc-windows-msvc/release/tool.exe"
    ]],
    [{ bins: ["tool"], target: "aarch64-apple-darwin", profile: "fast" }, ["target/aarch64-apple-darwin/fast/tool"]],
    [{ bins: ["tool"], target: "aarch64-apple-darwin", profile: "test" }, ["target/aarch64-apple-darwin/debug/tool"]],
    [{ bins: ["tool"], target: "aarch64-apple-darwin", profile: "bench" }, [
      "target/aarch64-apple-darwin/release/tool"
    ]],
    [{ bins: [] }, []]
  ])("resolves built binaries for %o", (attrs, expected) => {
    expect(Cargo.binaries(attrs)).toEqual(expected)
  })

  it("renders the workspace form with the resolution flags the declaration asks for", () => {
    const build = Cargo.Build({ workspace: true, locked: true, offline: true, data: [] })
    expect(args(build)).toEqual(["build", "--workspace", "--locked", "--offline"])
  })

  it("renders the cross-compilation target without inventing a container command", () => {
    const build = Cargo.Build({
      package: "kona-client",
      target: "mips64-unknown-linux-gnu",
      container: "docker",
      data: []
    })
    expect(args(build)).toEqual(["build", "-p", "kona-client", "--target", "mips64-unknown-linux-gnu"])
  })

  it("renders the package form with features and named bins, in cargo's own order", () => {
    const buildCli = Cargo.Build({
      package: "aomi-sdk",
      features: ["cli"],
      bins: ["aomi-build"],
      locked: true,
      offline: true,
      data: [],
      outDirs: ["//target"]
    })
    expect(args(buildCli)).toEqual([
      "build",
      "-p",
      "aomi-sdk",
      "--bin",
      "aomi-build",
      "--features",
      "cli",
      "--locked",
      "--offline"
    ])
    // A named bin under the default profile is a known path, which is what
    // lets another target take this one as a tool edge.
    expect(Cargo.binaries(attrsOf(buildCli))).toEqual([
      `target/debug/aomi-build${process.platform === "win32" ? ".exe" : ""}`
    ])
  })

  it("renders a crate-set member against its own manifest", () => {
    const compile = Cargo.Build({
      crates: Cargo.AppSet({ manifests: Input.glob(["*/Cargo.toml"]) }),
      lib: true,
      locked: true,
      offline: true,
      data: []
    })
    expect(args(compile, { _tag: "Manifest", path: "apps/jupiter/Cargo.toml" })).toEqual([
      "build",
      "--manifest-path",
      "apps/jupiter/Cargo.toml",
      "--lib",
      "--locked",
      "--offline"
    ])
  })

  it("spells the release profile the way cargo spells it", () => {
    expect(args(Cargo.Build({ workspace: true, profile: "release", data: [] })))
      .toEqual(["build", "--workspace", "--release"])
    expect(args(Cargo.Build({ workspace: true, profile: "bench", data: [] })))
      .toEqual(["build", "--workspace", "--profile", "bench"])
    expect(Cargo.binaries(attrsOf(Cargo.Build({ package: "a", bins: ["x"], profile: "release", data: [] }))))
      .toEqual([`target/release/x${process.platform === "win32" ? ".exe" : ""}`])
  })

  it("refuses a declaration that names no crate selector, or more than one", () => {
    expect(() => Cargo.Build({ data: [] } as never)).toThrow(/exactly one of workspace, package, crates/)
    expect(() => Cargo.Build({ workspace: true, package: "aomi-sdk", data: [] } as never))
      .toThrow(/exactly one of workspace, package, crates/)
  })

  it("refuses features and allFeatures together, which cargo would reject anyway", () => {
    expect(() => Cargo.Build({ package: "a", features: ["cli"], allFeatures: true, data: [] }))
      .toThrow(/allFeatures/)
  })
})

describe("Cargo.Test", () => {
  it("renders the package form, and --no-run for a compile-only crate set", () => {
    expect(args(Cargo.Test({ package: "aomi-sdk", locked: true, offline: true, data: [] })))
      .toEqual(["test", "-p", "aomi-sdk", "--locked", "--offline"])
    expect(args(
      Cargo.Test({
        crates: Cargo.AppSet({ manifests: Input.glob(["*/Cargo.toml"]) }),
        noRun: true,
        locked: true,
        offline: true,
        data: []
      }),
      { _tag: "Manifest", path: "apps/jupiter/Cargo.toml" }
    )).toEqual(["test", "--manifest-path", "apps/jupiter/Cargo.toml", "--no-run", "--locked", "--offline"])
  })
})

describe("Cargo.Nextest and Cargo.Deny", () => {
  it("renders their build-system commands", () => {
    expect(args(Cargo.Nextest({ workspace: true, locked: true, data: [] })))
      .toEqual(["nextest", "run", "--workspace", "--locked"])
    expect(args(Cargo.Deny({ config: Input.file("//deny.toml"), data: [] })))
      .toEqual(["deny", "--config", "//deny.toml", "check"])
  })

  it("renders nextest's compile-only form instead of dropping the declared noRun", () => {
    // NextestAttrs is PackageTestAttrs, so `noRun` is admitted; rendering it
    // is what keeps a compile-only declaration from silently running tests.
    expect(args(Cargo.Nextest({ workspace: true, noRun: true, locked: true, data: [] })))
      .toEqual(["nextest", "run", "--workspace", "--no-run", "--locked"])
  })
})

describe("Cargo.Clippy", () => {
  it("promotes warnings after the rustc separator", () => {
    const clippy = Cargo.Clippy({
      workspace: true,
      lib: true,
      denyWarnings: true,
      locked: true,
      offline: true,
      data: []
    })
    expect(args(clippy)).toEqual([
      "clippy",
      "--workspace",
      "--lib",
      "--locked",
      "--offline",
      "--",
      "-D",
      "warnings"
    ])
  })

  it("renders every feature the declaration names", () => {
    expect(args(Cargo.Clippy({ package: "aomi-ext", allFeatures: true, locked: true, data: [] })))
      .toEqual(["clippy", "-p", "aomi-ext", "--all-features", "--locked"])
  })

  /**
   * `--lib` and `--all-targets` select different work: the default lints the
   * library alone, so a benchmark or an integration test that stops compiling
   * passes the gate until the declaration asks for every target.
   */
  it("lints every cargo target when the declaration asks for it", () => {
    expect(args(Cargo.Clippy({ workspace: true, allTargets: true, locked: true, data: [] })))
      .toEqual(["clippy", "--workspace", "--all-targets", "--locked"])
  })
})

describe("Cargo.packageArgs", () => {
  /**
   * The planner reads attrs off metadata, and a rule with no attrs of its own
   * hands over nothing. Rendering the bare command is the answer; reading
   * fields off a non-object would throw inside the planner instead.
   */
  it.each([[undefined], [null], ["Cargo.toml"]])("renders the bare command for %o attrs", (attrs) => {
    expect(Cargo.packageArgs("Cargo.Fetch", attrs, workspaceSelection)).toEqual(["fetch"])
  })
})

describe("Cargo.Fmt", () => {
  const format = Cargo.Fmt({ workspace: true, data: [], changes: ["**/*.rs"] })

  it("checks by default and writes only when the mode says so", () => {
    expect(args(format, workspaceSelection, "check")).toEqual(["fmt", "--all", "--", "--check"])
    expect(args(format, workspaceSelection, "write")).toEqual(["fmt", "--all"])
  })

  it("accepts an implicit workspace and a rustup toolchain override", () => {
    const nightly = Cargo.Fmt({ toolchain: "nightly", data: [], changes: ["**/*.rs"] })
    expect(args(nightly, workspaceSelection, "check")).toEqual(["+nightly", "fmt", "--all", "--", "--check"])
  })

  it("never resolves dependencies, so it renders no locked or offline flag", () => {
    // rustfmt reads sources; it is the one cargo target with no fetch edge.
    expect(Object.keys(Cargo.FmtAttrs.fields)).not.toContain("locked")
    expect(Object.keys(Cargo.FmtAttrs.fields)).not.toContain("offline")
  })

  it("renders a crate-set member against its own manifest", () => {
    const crateFmt = Cargo.Fmt({
      crates: Cargo.AppSet({ manifests: Input.glob(["*/Cargo.toml"]) }),
      data: [],
      changes: ["**/*.rs"]
    })
    expect(args(crateFmt, { _tag: "Manifest", path: "apps/jupiter/Cargo.toml" }, "check"))
      .toEqual(["fmt", "--manifest-path", "apps/jupiter/Cargo.toml", "--all", "--", "--check"])
  })
})

describe("Cargo.Doc", () => {
  it("renders the doc build and declares its output tree", () => {
    const doc = Cargo.Doc({ workspace: true, locked: true, offline: true, data: [], outDirs: ["//target/doc"] })
    expect(args(doc)).toEqual(["doc", "--workspace", "--locked", "--offline"])
    expect(Target.metadata(doc as never).kinds).toEqual(["build", "docs"])
  })
})

describe("Cargo.AppSet", () => {
  it("is a crate set, not a run: it declares manifests and participates in no verb", () => {
    const all = Cargo.AppSet({ manifests: Input.glob(["*/Cargo.toml"]) })
    expect(Target.metadata(all as never).target).toBe("Cargo.AppSet")
    expect(Target.metadata(all as never).kinds).toEqual([])
    expect(Cargo.isAppSet(all)).toBe(true)
    expect(Cargo.appSetFilter(attrsOf(all))).toBeUndefined()
  })

  it("carries the metadata filter the compile driver already reads", () => {
    const skipped = Cargo.AppSet({
      manifests: Input.glob(["*/Cargo.toml"]),
      metadata: { aomi: { skip: true } }
    })
    expect(Cargo.appSetFilter(attrsOf(skipped))).toEqual({ aomi: { skip: true } })
  })

  it("composes with the file algebra, so difference subtracts one crate set from another", () => {
    const all = Cargo.AppSet({ manifests: Input.glob(["*/Cargo.toml"]) })
    const skipped = Cargo.AppSet({ manifests: Input.glob(["*/Cargo.toml"]), metadata: { aomi: { skip: true } } })
    const crates = Compose.Files.difference(all, skipped)
    expect(crates._tag).toBe("FilesDifference")
    // Both operands become ordinary dependency edges of the consuming target.
    const clippy = Cargo.Clippy({ crates, lib: true, denyWarnings: true, locked: true, data: [] })
    expect(Target.metadata(clippy as never).dependencies).toEqual([all, skipped])
  })
})

describe("Cargo manifest facts", () => {
  const manifest = [
    "[package]",
    "name = \"aomi-app-jupiter\"",
    "version = \"0.1.0\"",
    "edition = \"2021\"",
    "",
    "[package.metadata.aomi]",
    "skip = true",
    "display = \"Jupiter\"",
    "",
    "[lib]",
    "crate-type = [\"cdylib\", \"rlib\"]",
    "",
    "[dependencies]",
    "aomi-sdk = { path = \"../../sdk\" }",
    ""
  ].join("\n")

  it("reads the crate name and the metadata table, and nothing else", () => {
    expect(Cargo.manifestFacts(manifest)).toEqual({
      name: "aomi-app-jupiter",
      metadata: { aomi: { skip: true, display: "Jupiter" } }
    })
  })

  it("reads a manifest with no metadata table as an empty one", () => {
    expect(Cargo.manifestFacts("[package]\nname = \"plain\"\n")).toEqual({ name: "plain", metadata: {} })
  })

  it("ignores comments, quoted keys, and inline tables it cannot use", () => {
    const noisy = [
      "# [package.metadata.aomi]",
      "[package]",
      "name = \"quoted\" # trailing",
      "[package.metadata.\"aomi\"]",
      "skip = false",
      ""
    ].join("\n")
    expect(Cargo.manifestFacts(noisy)).toEqual({ name: "quoted", metadata: { aomi: { skip: false } } })
  })

  it("matches a filter as a subset of the declared metadata", () => {
    const metadata = { aomi: { skip: true, display: "Jupiter" } }
    expect(Cargo.metadataMatches(metadata, { aomi: { skip: true } })).toBe(true)
    expect(Cargo.metadataMatches(metadata, { aomi: { skip: false } })).toBe(false)
    expect(Cargo.metadataMatches({ aomi: { display: "x" } }, { aomi: { skip: true } })).toBe(false)
    expect(Cargo.metadataMatches({}, {})).toBe(true)
  })
})
