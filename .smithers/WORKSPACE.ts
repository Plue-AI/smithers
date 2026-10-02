import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")
const workspaceConfig = S.file("//pnpm-workspace.yaml")

// The toolchain, declared once. Targets read the runtime and package manager
// from this declaration at plan time, and `scripts/check-toolchain-pins.mjs`
// fails when package.json `engines` and `packageManager`, flake.nix, or the
// generated CI workflow disagree with what is declared here.
export const runtime = S.Runtime.Node({ version: ">=26.4.0" })
export const packageManager = S.PackageManager.Pnpm({ version: "11.25.0", runtime })
export const bunRuntime = S.Runtime.Bun({ version: ">=1.4.0" })
/** Exact Bun release installed by CI and the Nix environment. @since 1.0.0-rc.0 @category configuration */
export const bunVersion = "1.4.1"
/** Exact jj release installed by CI and the Nix environment. @since 1.0.0-rc.0 @category configuration */
export const jjVersion = "0.39.0"
export const bunPackageManager = S.PackageManager.BunPackages({ runtime: bunRuntime })

// The same toolchain as one Nix closure: flake.nix pins pnpm at exactly
// `packageManager.version` and Node at `runtime`'s major. `nix develop` at
// the root enters it on a host; the Microsandbox sandbox below plants it in
// every microVM, so a sandboxed session runs the declared toolchain rather
// than whatever its image shipped.
export const environment = S.Nix.Environment({ flake: S.file("//flake.nix") })

const nodeModules = S.Npm.NodeModules({
  packageJson,
  workspaces: workspaceConfig
})

const rust = S.Rust.Toolchain({
  workspace: S.file("//Cargo.toml"),
  toolchain: S.file("//rust-toolchain.toml"),
  lockfile: S.file("//Cargo.lock")
})

export const Workspace = S.Workspace("smithers", {
  repository: "git+https://github.com/smithersai/smithers.git",
  // SMITHERS_CACHE_URL overrides the endpoint at the process boundary.
  // Only the post-merge CI publisher receives the write credential.
  cache: S.Cache({
    directory: ".flows",
    hostDirectories: [".backend-go-modcache"],
    remote: S.RemoteCache.make({
      endpoint: "https://build.smithers.sh",
      read: S.Secret("SMITHERS_CACHE_READ_TOKEN"),
      write: S.Secret("SMITHERS_CACHE_WRITE_TOKEN")
    })
  }),
  runtime,
  packageManager,
  nodeModules,
  toolchains: [rust],
  host: S.Host({ bins: ["git", "jj", "bun", "cargo", "smithers-jj-export"] }),
  // Build-target confinement stays off: `default` is the mechanism every
  // tool run of the build goes through, and the fail-closed Nix resolver would
  // refuse every host without `nix` on PATH. `microsandbox` is the runtime
  // sandbox agent and flow sessions boot, holding the Nix environment above.
  sandboxes: S.Sandboxes({
    default: S.Sandbox.None(),
    microsandbox: S.Sandbox.Microsandbox({ environment })
  }),
  repos: {
    "fixture-chain-exec": S.LocalRepository("packages/smithers/build/build-cli/test/fixtures/chain-exec"),
    "fixture-force-spec": S.LocalRepository("packages/smithers/build/build-cli/test/fixtures/force-spec"),
    "fixture-multi-repo": S.LocalRepository("packages/smithers/build/build-cli/test/fixtures/multi-repo"),
    "fixture-multi-repo-credentials": S.LocalRepository(
      "packages/smithers/build/build-cli/test/fixtures/multi-repo-credentials"
    ),
    "fixture-steps-form": S.LocalRepository("packages/smithers/build/build-cli/test/fixtures/steps-form"),
    "fixture-target-body": S.LocalRepository("packages/smithers/build/build-cli/test/fixtures/target-body"),
    "fixture-viem-node-spec": S.LocalRepository("packages/smithers/build/build-cli/test/fixtures/viem-node-spec"),
    "ui-e2e-repo-plugin": S.LocalRepository("apps/app/e2e/fixtures/repo-plugin")
  },
  // Gitignored caches with no CACHEDIR.TAG: run evidence, the Go module
  // cache, the pnpm store, and scratch. Discovery is ignore-blind, so each one
  // costs its full size on every `smthrs` verb until it is named here.
  discovery: { prune: [".artifacts", ".backend-go-modcache", ".pnpm-store", "tmp"] },
  // Dependency documentation a wiki refresh imports for agent memory, pinned
  // by the installed version.
  docs: { effect: S.Docs.Package("effect", { files: ["README.md"] }) }
})
