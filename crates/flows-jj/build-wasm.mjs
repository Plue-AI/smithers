/**
 * Builds `flows_jj.wasm` — the wasm32-wasip1 reactor module behind
 * `BrowserJj` — and copies it to `packages/smithers/flows/jj/wasm/flows_jj.wasm`.
 *
 * The Rust side lives in this crate (`crates/flows-jj`), which depends on the
 * single vendored jj fork pinned to one upstream revision. The build runs through
 * the repo-root Cargo workspace so native tests and the wasm artifact share one
 * lockfile, and it builds `--locked` so the artifact always reflects the
 * committed Cargo.lock.
 *
 * The committed artifact is a reproducibility contract: CI rebuilds it with
 * the toolchain pinned in `rust-toolchain.toml` and fails on any byte drift.
 * rustc embeds source paths in panic locations, so the build remaps every
 * machine-specific prefix — the repository checkout, `CARGO_HOME`, and the
 * toolchain sysroot — to fixed tokens. Without the remapping, the same
 * commit produces different bytes on every machine and checkout path.
 *
 * The contract is scoped to one host triple, because no flag remaps the host.
 * Cargo compiles build scripts for the host, so the `-C metadata` hash of
 * every crate that has one — and of everything above it, which here reaches
 * jj-lib and flows-jj — carries the host triple. rustc folds `-C metadata`
 * into the crate's `StableCrateId`, which seeds every symbol hash, and it
 * orders codegen items by symbol name, so a different host reorders the
 * module and LLVM then optimizes it differently. Measured on 1.89.0 from
 * identical sources: aarch64-apple-darwin, x86_64-unknown-linux-gnu, and
 * aarch64-unknown-linux-gnu each produce a different artifact, differing in
 * function count and code size, not just in symbol names. The committed
 * bytes therefore belong to the declared host below — the one CI runs — and
 * this script refuses to build them anywhere else rather than write bytes CI
 * cannot match.
 *
 * Honors `CARGO_TARGET_DIR`; a relative value resolves against the workspace
 * root, exactly as cargo resolves it for the build itself. It needs no token
 * of its own: an out-of-tree target directory builds the same bytes as the
 * in-tree default, verified on the canonical host and on macOS.
 *
 * `--verify` rebuilds without writing and compares the result against the
 * committed artifact, which is the reproducibility gate itself. Without it the
 * gate was three shell steps — copy the committed bytes aside, rebuild over
 * them, `cmp` — that only a workflow file could sequence.
 *
 * Run it from anywhere: `node crates/flows-jj/build-wasm.mjs`.
 * Prerequisite: rustup — `rust-toolchain.toml` supplies the toolchain,
 * the `wasm32-wasip1` target, and the components. Off the canonical host,
 * run it in a container; `foreignHostError` prints the command.
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..")

/**
 * The cargo target directory: `CARGO_TARGET_DIR` when set, the workspace
 * default otherwise. Cargo resolves a relative `CARGO_TARGET_DIR` against
 * its invocation directory, which for this build is the workspace root.
 */
export const targetDir = (env, workspaceRoot) =>
  env.CARGO_TARGET_DIR !== undefined && env.CARGO_TARGET_DIR !== ""
    ? resolve(workspaceRoot, env.CARGO_TARGET_DIR)
    : join(workspaceRoot, "target")

/** The `commit-hash` line of `rustc -vV`, the token std paths are keyed on. */
export const rustcCommitHash = (verboseVersion) => {
  const match = verboseVersion.match(/^commit-hash: ([0-9a-f]+)$/m)
  if (match === null) {
    throw new Error(`rustc -vV output has no commit-hash line:\n${verboseVersion}`)
  }
  return match[1]
}

/** The `host` line of `rustc -vV`, the triple the artifact's bytes are keyed on. */
export const rustcHost = (verboseVersion) => {
  const match = verboseVersion.match(/^host: (\S+)$/m)
  if (match === null) {
    throw new Error(`rustc -vV output has no host line:\n${verboseVersion}`)
  }
  return match[1]
}

/**
 * The host triple the committed artifact is built on: the one CI's
 * `ubuntu-latest` runner reports, and the only one whose bytes the
 * `wasm-repro` job can reproduce.
 */
export const canonicalHost = "x86_64-unknown-linux-gnu"

/**
 * The refusal for a host whose build CI could never match, or `undefined` on
 * the canonical host. The container command it prints is the one CI runs,
 * one layer down: a Node image, rustup reading `rust-toolchain.toml`, and
 * this script.
 */
export const foreignHostError = (host) =>
  host === canonicalHost ? undefined : [
    `error: the committed flows_jj.wasm is built on ${canonicalHost}, and this host is ${host}.`,
    "Cargo builds every build script for the host, so the metadata hash of each crate that has",
    "one — and of everything above it — carries the host triple, and rustc turns that into a",
    "different module. Building here would produce bytes CI cannot reproduce.",
    "",
    "Rebuild the committed artifact on the canonical host, from the repository root:",
    "  docker run --rm --platform linux/amd64 -v \"$PWD\":/repo -w /repo \\",
    "    -e CARGO_TARGET_DIR=/tmp/wasm-target node:22-bookworm sh -c \\",
    "    'curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null \\",
    "      && . \"$HOME/.cargo/env\" && rustup toolchain install \\",
    "      && node crates/flows-jj/build-wasm.mjs'",
    "",
    "For a scratch module to run locally, build the crate directly and read it out of the",
    "target directory instead of committing it:",
    "  cargo build --locked --release --target wasm32-wasip1 --package flows-jj"
  ].join("\n")

/**
 * `--remap-path-prefix` flags that replace every machine-specific source
 * prefix with a fixed token, so the artifact's bytes do not depend on where
 * the repository, the cargo registry, or the toolchain happen to live.
 *
 * The sysroot's `rust-src` layout maps back to `/rustc/<commit-hash>` — the
 * token prebuilt std paths already carry — so a toolchain with `rust-src`
 * installed (rustc rewrites std spans to local paths when it is) produces
 * the same bytes as the minimal toolchain CI installs.
 */
export const remapFlags = ({ cargoHome, commitHash, sysroot, workspaceRoot }) => [
  `--remap-path-prefix=${workspaceRoot}=/flows`,
  `--remap-path-prefix=${cargoHome}=/cargo`,
  `--remap-path-prefix=${join(sysroot, "lib", "rustlib", "src", "rust")}=/rustc/${commitHash}`
]

/**
 * The child cargo environment, authored rather than inherited.
 *
 * `RUSTFLAGS` is set from the remap flags alone: an ambient value would bake
 * extra codegen into the artifact. `CARGO_ENCODED_RUSTFLAGS` is deleted
 * because cargo prefers it over `RUSTFLAGS` entirely — an ambient value
 * would silently drop the remap flags and embed machine paths. The
 * byte-compare would catch the damage one step later on CI, but a build on
 * the canonical host must produce the canonical bytes on the first try.
 */
export const buildEnvironment = (env, flags) => {
  const environment = { ...env, RUSTFLAGS: flags.join(" ") }
  delete environment.CARGO_ENCODED_RUSTFLAGS
  return environment
}

/**
 * The reproducibility failure between the committed artifact and a fresh
 * build, or undefined when the two are byte-identical.
 *
 * The message names the one host the committed bytes belong to, because a
 * mismatch on any other host is expected and is not a source problem.
 */
export const reproductionFailure = (committed, rebuilt) =>
  committed.equals(rebuilt) ? undefined : [
    "error: packages/smithers/flows/jj/wasm/flows_jj.wasm does not reproduce from source.",
    `  committed ${committed.length} bytes, rebuilt ${rebuilt.length} bytes`,
    `  Rebuild it with the pinned toolchain on ${canonicalHost} and commit the result:`,
    "    node crates/flows-jj/build-wasm.mjs",
    "  On any other host the same script prints the container command."
  ].join("\n")

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const artifact = join(targetDir(process.env, repoRoot), "wasm32-wasip1", "release", "flows_jj.wasm")
  const destinationDir = join(repoRoot, "packages", "smithers", "flows", "jj", "wasm")
  const destination = join(destinationDir, "flows_jj.wasm")

  const rustc = (args) => {
    const result = spawnSync("rustc", args, { cwd: repoRoot, encoding: "utf8" })
    if (result.error?.code === "ENOENT") {
      console.error("error: `rustc` not found on PATH — install a Rust toolchain (rustup) first")
      process.exit(1)
    }
    if (result.status !== 0) {
      console.error(result.stderr ?? "")
      console.error(`error: rustc ${args.join(" ")} failed`)
      process.exit(result.status ?? 1)
    }
    return result.stdout
  }

  const verboseVersion = rustc(["-vV"])
  const foreignHost = foreignHostError(rustcHost(verboseVersion))
  if (foreignHost !== undefined) {
    console.error(foreignHost)
    process.exit(1)
  }

  const flags = remapFlags({
    cargoHome: process.env.CARGO_HOME ?? join(homedir(), ".cargo"),
    commitHash: rustcCommitHash(verboseVersion),
    sysroot: rustc(["--print", "sysroot"]).trim(),
    workspaceRoot: repoRoot
  })

  const environment = buildEnvironment(process.env, flags)
  const build = spawnSync(
    "cargo",
    ["build", "--locked", "--release", "--target", "wasm32-wasip1", "--package", "flows-jj"],
    {
      cwd: repoRoot,
      // RUSTFLAGS applies to wasm32-wasip1 units only (cargo exempts host
      // units when --target is passed), so proc macros build untouched.
      env: environment,
      stdio: "inherit"
    }
  )
  if (build.error?.code === "ENOENT") {
    console.error("error: `cargo` not found on PATH — install a Rust toolchain (rustup) first")
    process.exit(1)
  }
  if (build.status !== 0) {
    console.error(
      "error: cargo build failed" +
        " — if the target is missing, run `rustup target add wasm32-wasip1`"
    )
    process.exit(build.status ?? 1)
  }

  if (process.argv.slice(2).includes("--verify")) {
    const failure = reproductionFailure(readFileSync(destination), readFileSync(artifact))
    if (failure !== undefined) {
      console.error(failure)
      process.exit(1)
    }
    console.log(`verified ${destination} reproduces from source`)
  } else {
    mkdirSync(destinationDir, { recursive: true })
    copyFileSync(artifact, destination)
    const { size } = statSync(destination)
    console.log(`built ${destination} (${(size / 1024 / 1024).toFixed(2)} MiB)`)
  }
}
