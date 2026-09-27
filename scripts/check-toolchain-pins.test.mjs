import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { check, findings, rustFindings, satisfies } from "./check-toolchain-pins.mjs"
import { toolchainRefusal } from "./require-toolchain.mjs"

const workspace = {
  runtime: { version: ">=26.4.0" },
  packageManager: { version: "11.21.0" },
  bunRuntime: { version: ">=1.3.0" },
  bunVersion: "1.3.14",
  jjVersion: "0.39.0"
}
const packageJson = JSON.stringify({
  packageManager: "pnpm@11.21.0",
  engines: { node: ">=26.4.0", bun: ">=1.3.0" }
})
const flake = `pnpmPinned = pkgs: pkgs.stdenvNoCC.mkDerivation rec {
  pname = "pnpm";
  version = "11.21.0";
};
packages = [ pkgs.nodejs_26 (pnpmPinned pkgs) ];
assert pkgs.bun.version == "1.3.14";
assert pkgs.jujutsu.version == "0.39.0";`
// Quoted keys and values, because that is what the generator emits; a fixture
// in bare YAML let the ci.yml half of this gate pass while matching nothing.
const ci = `      - uses: "actions/setup-node@v4"
        with:
          "node-version-file": ".node-version"
      - uses: "oven-sh/setup-bun@v2"
        with:
          "bun-version": "1.3.14"
 "tool": "jj-cli@0.39.0"`
const nodeVersion = "26.4.0\n"

test("an exact release satisfies its floor only within the declared major", () => {
  assert.equal(satisfies("26.4.0", ">=26.4.0"), true)
  assert.equal(satisfies("26.10.0", ">=26.4.0"), true)
  assert.equal(satisfies("26.3.0", ">=26.4.0"), false)
  assert.equal(satisfies("27.0.0", ">=26.4.0"), false)
})

test("files that agree with the workspace declaration produce no findings", () => {
  assert.deepEqual(findings({ workspace, packageJson, flake, ci, nodeVersion }), [])
})

test("every file that disagrees is named with both values", () => {
  const drifted = findings({
    workspace,
    packageJson: JSON.stringify({ packageManager: "pnpm@11.20.0", engines: { node: ">=22.0.0", bun: ">=1.2.0" } }),
    flake: flake.replace("11.21.0", "11.19.0").replace("nodejs_26", "nodejs_24"),
    ci: ci.replace("1.3.14", "1.2.9"),
    nodeVersion: "20.11.0\n"
  })
  assert.deepEqual(drifted, [
    "package.json packageManager is \"pnpm@11.20.0\"; WORKSPACE.ts declares pnpm@11.21.0",
    "package.json engines.node is \">=22.0.0\"; WORKSPACE.ts declares >=26.4.0",
    "package.json engines.bun is \">=1.2.0\"; WORKSPACE.ts declares >=1.3.0",
    "flake.nix pins pnpm 11.19.0; WORKSPACE.ts declares 11.21.0",
    "flake.nix uses nodejs_24; WORKSPACE.ts declares Node >=26.4.0",
    ".node-version pins node 20.11.0; WORKSPACE.ts declares >=26.4.0",
    "ci.yml installs bun 1.2.9; WORKSPACE.ts declares >=1.3.0",
    "ci.yml pins bun 1.2.9; WORKSPACE.ts declares 1.3.14"
  ])
})

test("a flake without the pnpm pin or a Node package is a finding, not a pass", () => {
  assert.deepEqual(findings({ workspace, packageJson, flake: "{ }", ci, nodeVersion }), [
    "flake.nix pins no pnpm tarball (expected pname = \"pnpm\"; version = \"...\")",
    "flake.nix names no nodejs_<major> package",
    "flake.nix pins no bun version assertion",
    "flake.nix pins no jujutsu version assertion"
  ])
})

test("the workflow must read the node file rather than name a release itself", () => {
  // A literal here is exactly how ci.yml came to install 22.19.0 while the
  // Cloud bootstrap downloaded 24.21.0 and package.json asked for >=22.19.0.
  const inline = ci.replace('"node-version-file": ".node-version"', '"node-version": "26.4.0"')
  assert.deepEqual(findings({ workspace, packageJson, flake, ci: inline, nodeVersion }), [
    "ci.yml sets up node without node-version-file",
    "ci.yml pins node 26.4.0 inline; it must read .node-version"
  ])
  const elsewhere = ci.replace('".node-version"', '".nvmrc"')
  assert.ok(findings({ workspace, packageJson, flake, ci: elsewhere, nodeVersion })
    .includes("ci.yml reads node from .nvmrc; the repository pins .node-version"))
})

test("the node file must hold one exact release", () => {
  for (const held of ["", "lts/*", "26", ">=26.4.0"]) {
    assert.ok(findings({ workspace, packageJson, flake, ci, nodeVersion: held })
      .some((item) => item.startsWith(".node-version must hold one exact Node release")), JSON.stringify(held))
  }
})

test("the node file may run ahead of the floor the workspace declares", () => {
  // The floor is the oldest Node the code supports; the file is the exact
  // release every environment runs, and the maintainer's is newer than that.
  assert.deepEqual(findings({ workspace, packageJson, flake, ci, nodeVersion: "26.10.0\n" }), [])
})

test("every Rust toolchain a build file names is the rust-toolchain.toml channel", () => {
  const toolchain = '[toolchain]\nchannel = "1.98.0"\nprofile = "minimal"\n'
  const agreeing = {
    "ci.yml": "rustup toolchain install '1.98.0' --profile minimal\ncargo +1.98.0 build --locked\nrustup toolchain install",
    "Dockerfile": "FROM rust:1.98.0-bookworm AS smithers-rust",
    "PACKAGE.ts": 'toolchain: "1.98.0",'
  }
  assert.deepEqual(rustFindings({ toolchain, files: agreeing }), [])
  // Issue #2199: rust-toolchain.toml pinned 1.89.0 while the FFI crate and
  // every native build named 1.98.0, so a plain `cargo build` failed.
  assert.deepEqual(rustFindings({
    toolchain,
    files: {
      "release.yml": "- run: rustup toolchain install 1.89.0 1.98.0",
      "Dockerfile": "FROM --platform=linux/amd64 rust:1.89.0-bookworm AS flows-jj",
      "build-native.ts": '["rustup", "run", "1.89.0", "rustc"], { RUSTUP_TOOLCHAIN: "1.89.0" }',
      "cloud.sh": "cargo +1.91 build"
    }
  }), [
    "release.yml names Rust 1.89.0; rust-toolchain.toml pins 1.98.0",
    "Dockerfile names Rust 1.89.0; rust-toolchain.toml pins 1.98.0",
    "build-native.ts names Rust 1.89.0; rust-toolchain.toml pins 1.98.0",
    "build-native.ts names Rust 1.89.0; rust-toolchain.toml pins 1.98.0",
    "cloud.sh names Rust 1.91; rust-toolchain.toml pins 1.98.0"
  ])
  assert.deepEqual(rustFindings({ toolchain: 'channel = "stable"', files: {} }), [
    "rust-toolchain.toml must pin one exact release as x.y.z; it pins \"stable\""
  ])
})

test("the real repository is in sync", async () => {
  assert.deepEqual(await check(), [])
})

test("Bun and jj pins are required in the flake and CI", () => {
  const declared = { ...workspace, bunVersion: "1.3.14", jjVersion: "0.39.0" }
  for (const [flakeText, ciText, expected] of [
    ["", "", "ci.yml sets up node without node-version-file"],
    ["", "", "flake.nix pins no bun"],
    ["", "", "flake.nix pins no jujutsu"],
    ["", "", "ci.yml installs no jj-cli"],
    ['\nassert pkgs.bun.version == "1.2.0";', ci, "flake.nix pins bun 1.2.0"],
    ['\nassert pkgs.jujutsu.version == "0.38.0";', ci, "flake.nix pins jujutsu 0.38.0"],
    [flake, ci + '\n tool: jj-cli@0.38.0', "ci.yml installs jj 0.38.0"]
  ]) {
    assert.ok(findings({ workspace: declared, packageJson, flake: flakeText, ci: ciText, nodeVersion }).some((item) => item.startsWith(expected)), expected)
  }
})

test("a toolchain below the engines floors is refused in one line naming both", () => {
  const engines = { node: ">=26.4.0", bun: ">=1.4.0" }
  assert.equal(toolchainRefusal(engines, { bun: "1.4.1", node: "26.10.0" }), null)
  assert.equal(toolchainRefusal(engines, { bun: "1.4.0-canary.3", node: undefined }), null)
  assert.equal(
    toolchainRefusal(engines, { bun: "1.2.20", node: "26.10.0" }),
    "Smithers requires Bun >=1.4.0 and Node >=26.4.0; found Bun 1.2.20, Node 26.10.0."
  )
  assert.equal(
    toolchainRefusal(engines, { bun: undefined, node: "24.4.1" }),
    "Smithers requires Bun >=1.4.0 and Node >=26.4.0; found Node 24.4.1."
  )
})

test("requireToolchain stops the process with that line before anything else runs", () => {
  const root = mkdtempSync(join(tmpdir(), "require-toolchain-"))
  const run = (node) => {
    const manifest = join(root, "package.json")
    writeFileSync(manifest, JSON.stringify({ engines: { bun: ">=1.4.0", node } }))
    const entry = new URL("./require-toolchain.mjs", import.meta.url).href
    return spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(entry)}); m.requireToolchain(${JSON.stringify(manifest)}); console.log("ran")`], { encoding: "utf8" })
  }
  try {
    const refused = run(">=999.0.0")
    assert.equal(refused.status, 1)
    assert.equal(refused.stdout, "")
    assert.equal(refused.stderr, `Smithers requires Bun >=1.4.0 and Node >=999.0.0; found Node ${process.versions.node}.\n`)
    const allowed = run(">=1.0.0")
    assert.equal(allowed.status, 0)
    assert.equal(allowed.stdout, "ran\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
