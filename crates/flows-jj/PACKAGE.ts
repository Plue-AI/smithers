/**
 * Targets for the `flows-jj` crate and the WebAssembly artifact it produces.
 *
 * The Rust gates and the wasm reproducibility gate are declared here, beside the
 * crate that owns them, so `smithers-build lint '//crates/flows-jj:cargoClippy'` is the
 * same command a pipeline runs. The cargo flags that make a check a gate live in
 * the target implementations, not here.
 *
 * The two lanes are addressed by exact label rather than by a recursive pattern
 * on purpose. The cargo gates need only a Rust toolchain; the wasm rebuild needs
 * an uncached one and takes minutes, so it is a separate CI job and a bare
 * `//crates/flows-jj` under the test verb would pull it into both.
 */
import { Smithers } from "@smthrs/targets"

/**
 * The crate sources, the workspace manifest, and the lockfile.
 *
 * The jj fork the crate builds against is a cargo git dependency pinned to one
 * rev, so the lockfile is the whole of its declaration here and a fresh checkout
 * needs nothing beyond `cargo fetch`.
 */
const sources = [
  Smithers.glob("//crates/flows-jj/**/*.rs"),
  Smithers.file("//Cargo.toml"),
  Smithers.file("//Cargo.lock"),
  Smithers.file("//rust-toolchain.toml")
]

/**
 * The crates.io index and download hosts (with the CDN names they resolve
 * through) and the GitHub hosts the jj fork's git dependency is fetched from.
 */
const destinations = [
  "index.crates.io",
  "fastly-index.crates.io",
  "static.crates.io",
  "fastly-static.crates.io",
  "dualstack.k.sni.global.fastly.net",
  "crates.io",
  "github.com",
  "codeload.github.com"
]

/**
 * Refuses any crate source `rustfmt` would rewrite.
 *
 * @since 0.1.0
 * @category lint
 */
const cargoFmt = Smithers.Cargo.Fmt({
  workspace: true,
  data: sources,
  changes: ["crates/flows-jj/**/*.rs"]
})

/**
 * Runs clippy over every target with warnings promoted to errors.
 *
 * @since 0.1.0
 * @category lint
 */
const cargoClippy = Smithers.Cargo.Clippy({
  package: "flows-jj",
  allTargets: true,
  locked: true,
  denyWarnings: true,
  data: sources,
  destinations
})

/**
 * Runs the crate's native test suite against the pinned jj-lib.
 *
 * @since 0.1.0
 * @category test
 */
const cargoTest = Smithers.Cargo.Test({
  package: "flows-jj",
  locked: true,
  data: sources,
  destinations
})

/**
 * Checks the build script's own helpers: path remapping, the host guard, and
 * the reproducibility comparison.
 *
 * @since 0.1.0
 * @category test
 */
const buildScript = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//crates/flows-jj/build-wasm.test.mjs")]),
  srcs: [Smithers.file("//crates/flows-jj/build-wasm.mjs")],
  deps: []
})

/**
 * Rebuilds `flows_jj.wasm` from source and byte-compares it against the
 * committed artifact.
 *
 * The committed module is a reproducibility contract: rebuilding it from source
 * with the pinned toolchain must give the same bytes. `--verify` is what makes
 * that one target — the script rebuilds into a scratch directory, compares, and
 * never overwrites the committed bytes. A scratch `CARGO_TARGET_DIR` keeps the
 * rebuild clean-room and exercises the script's own handling of it.
 *
 * This runner's host triple is part of the contract, so the script refuses to
 * run anywhere but the canonical host rather than report a byte diff.
 *
 * @since 0.1.0
 * @category test
 */
const wasmReproducibility = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("//crates/flows-jj/build-wasm.mjs"), ["--verify"]),
  srcs: [...sources, Smithers.file("//packages/smithers/flows/jj/wasm/flows_jj.wasm")],
  deps: [],
  env: { CARGO_TARGET_DIR: "target/wasm-reproducibility" },
  cwd: "."
})

/**
 * Security review of the wasm ABI, the jj ops it dispatches, and the build
 * script that produces the committed artifact.
 *
 * @since 0.1.0
 * @category security
 */
const securityReview = Smithers.SecurityReview({
  cwd: "crates/flows-jj",
  include: ["src/**", "build-wasm.mjs", "Cargo.toml", "//Cargo.toml"],
  checks: [
    {
      id: "abi-memory-safety",
      title: "The wasm exports never read or write outside a live allocation",
      threat: "A host bridge bug or a hostile page script corrupts the module heap and turns one jj request into silent corruption of the user's repository.",
      lookFor: [
        "flows_jj_call building a slice from req_ptr/req_len with no check that the range lies inside linear memory.",
        "flows_jj_free deallocating with a size that differs from the allocation, or the bridge freeing the same pointer twice.",
        "A response pointer or length packed into the u64 return that does not match the buffer copied by copy_nonoverlapping."
      ],
      paths: ["src/abi.rs"]
    },
    {
      id: "abi-no-panic-escape",
      title: "Every request, however malformed, returns a JSON err instead of aborting the instance",
      threat: "A flow sends a crafted request that panics the reactor, which aborts on wasm32-wasip1 and kills the browser Jj instance mid-operation.",
      lookFor: [
        "An unwrap, expect, slice index or arithmetic overflow reachable from dispatch, since catch_unwind cannot catch it on wasm32-wasip1.",
        "A jj-lib call in ops.rs whose documented panics are reachable from request fields (empty names, malformed hex, huge prefixes)."
      ],
      paths: ["src/abi.rs", "src/ops.rs", "src/protocol.rs"]
    },
    {
      id: "workspace-path-containment",
      title: "Request-supplied root and workspaceAdd path stay inside the intended repository slice",
      threat: "A flow or model-chosen request creates or checks out a workspace at an arbitrary path, bounded only by the WASI preopen, overwriting unrelated state in the slice.",
      lookFor: [
        "workspace_add passing `path` to create_dir_all and init_workspace_with_existing_repo with no normalization or prefix check against root.",
        "`root` or `path` accepted when relative or containing `..` components.",
        "workspace_add accepting a path inside root/.jj, which nests a working copy inside the repository store."
      ],
      paths: ["src/ops.rs", "src/protocol.rs"]
    },
    {
      id: "checkout-symlink-escape",
      title: "Snapshot, restore and checkout never follow a symlink out of the working copy",
      threat: "A snapshot containing a symlink plus a file beneath it makes restore write outside the workspace root, since the crate relies on BrowserJj's assertNoSymlinks for this.",
      lookFor: [
        "restore or snapshot checking out a tree without jj-lib's symlink/parent-directory guard.",
        "Symlink tree entries accepted by the crate itself rather than refused before check_out."
      ],
      paths: ["src/ops.rs"]
    },
    {
      id: "revision-resolution-scope",
      title: "Revision strings resolve only to `@`, change id prefixes, or commit id prefixes",
      threat: "A model-supplied revision string resolves to an unintended commit and restore overwrites the user's working copy with its content.",
      lookFor: [
        "resolve_revision accepting anything beyond `@`, reverse-hex change ids and hex commit ids.",
        "A string that is both a valid reverse-hex change id prefix and a hex commit id prefix resolving to a different commit than the caller meant.",
        "The commit-id branch resolving hidden (abandoned) commits while the change-id branch refuses them."
      ],
      paths: ["src/ops.rs"]
    },
    {
      id: "snapshot-secret-capture",
      title: "Snapshots do not silently track and emit secret files",
      threat: "A credential file dropped in the working copy is tracked by snapshot and returned in diff output to a model or log.",
      lookFor: [
        "snapshot_options using an empty base_ignores and EverythingMatcher, so files such as .env are tracked unless a .gitignore excludes them.",
        "git_diff or status returning full contents of newly added files with no size or name filter."
      ],
      paths: ["src/ops.rs", "src/diff_render.rs", "src/status_render.rs"]
    },
    {
      id: "diff-output-forgery",
      title: "Rendered diff and status text cannot forge headers from file names or contents",
      threat: "A repository file whose name contains a newline or terminal escape forges `diff --git` headers or status lines that a reviewer, agent or patch applier trusts.",
      lookFor: [
        "as_internal_file_string interpolated into `diff --git`, `---`, `+++`, rename/copy or A/M/D lines without quoting control characters.",
        "Raw ANSI escape bytes from file content passed through String::from_utf8_lossy into output shown in a terminal or TUI."
      ],
      paths: ["src/diff_render.rs", "src/status_render.rs"]
    },
    {
      id: "snapshot-resource-bounds",
      title: "Snapshot and diff cannot exhaust wasm memory on large or numerous files",
      threat: "A flow drops a huge file in the working copy and the snapshot or diff materializes it into memory, crashing the browser tab.",
      lookFor: [
        "snapshot_options setting max_new_file_size to u64::MAX with no other ceiling.",
        "git_diff accumulating every materialized file into one String with no size cap."
      ],
      paths: ["src/ops.rs", "src/diff_render.rs"]
    },
    {
      id: "wasm-build-integrity",
      title: "The committed wasm is built only from locked, pinned inputs",
      threat: "A tampered dependency or ambient build environment injects code into flows_jj.wasm that every browser user then runs.",
      lookFor: [
        "cargo invoked without --locked, or the jj-lib git dependency in //Cargo.toml not pinned to a full rev.",
        "buildEnvironment inheriting RUSTC_WRAPPER, RUSTC, CARGO_BUILD_RUSTC_WRAPPER or CARGO_TARGET_*_LINKER from the ambient env.",
        "The --verify path writing over the committed artifact instead of comparing."
      ],
      paths: ["build-wasm.mjs", "Cargo.toml", "//Cargo.toml"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { buildScript, cargoClippy, cargoFmt, cargoTest, wasmReproducibility, ...securityReview }
})
