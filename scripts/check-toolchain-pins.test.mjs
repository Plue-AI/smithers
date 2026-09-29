import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { check, environmentFindings, findings, rustFindings, satisfies } from "./check-toolchain-pins.mjs"
import { compare, floorOf, toolchainRefusal } from "./require-toolchain.mjs"

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

const environmentIndex = (toolchain) =>
  JSON.stringify([{ label: "//:docs", rule: "Generate" }, { label: "//:environmentToolchain", rule: "Environment.Toolchain", toolchain }])
const environmentPins = {
  downloads: {
    node: { version: "26.4.0" },
    pnpm: { version: "11.21.0" },
    bun: { version: "1.3.14" },
    jj: { version: "0.39.0" },
    go: { version: "1.26.8" }
  },
  rust: { channel: "1.98.0", components: ["rustfmt", "clippy"], targets: ["wasm32-wasip1"] }
}
const environmentSources = {
  workspace,
  nodeVersion,
  goMod: "module x\n\ngo 1.26.8\n",
  toolchain: "[toolchain]\nchannel = \"1.98.0\"\ncomponents = [\"clippy\", \"rustfmt\"]\ntargets = [\"wasm32-wasip1\"]\n"
}

test("the environment toolchain row agrees with every file that pins the same release", () => {
  assert.deepEqual(environmentFindings({ ...environmentSources, index: environmentIndex(environmentPins) }), [])
  const drifted = {
    downloads: { ...environmentPins.downloads, node: { version: "26.5.0" }, go: { version: "1.26.0" } },
    rust: { channel: "1.97.0", components: ["clippy"], targets: ["wasm32-wasip1"] }
  }
  assert.deepEqual(environmentFindings({ ...environmentSources, index: environmentIndex(drifted) }), [
    "//:environmentToolchain pins node 26.5.0; .node-version pins 26.4.0",
    "//:environmentToolchain pins go 1.26.0; go.mod pins 1.26.8",
    "//:environmentToolchain pins Rust 1.97.0; rust-toolchain.toml pins 1.98.0",
    "//:environmentToolchain pins Rust components clippy; rust-toolchain.toml pins clippy,rustfmt"
  ])
  const missing = { downloads: { node: { version: "26.4.0" } } }
  assert.deepEqual(environmentFindings({ ...environmentSources, index: environmentIndex(missing) }), [
    "//:environmentToolchain pins pnpm undefined; WORKSPACE.ts pins 11.21.0",
    "//:environmentToolchain pins bun undefined; WORKSPACE.ts pins 1.3.14",
    "//:environmentToolchain pins jj undefined; WORKSPACE.ts pins 0.39.0",
    "//:environmentToolchain pins go undefined; go.mod pins 1.26.8",
    "//:environmentToolchain pins Rust undefined; rust-toolchain.toml pins 1.98.0",
    "//:environmentToolchain pins Rust components ; rust-toolchain.toml pins clippy,rustfmt",
    "//:environmentToolchain pins Rust targets ; rust-toolchain.toml pins wasm32-wasip1"
  ])
  assert.deepEqual(environmentFindings({ ...environmentSources, index: "[]" }), [
    ".smithers/target-index.json has 0 Environment.Toolchain rows; expected one"
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

for (const [requirement, expected] of [
  [">=26.4.0", [26, 4, 0]],
  ["  26.10.12 \n", [26, 10, 12]],
  [">=1.4.0-canary.3", [1, 4, 0]],
  ["1.4.2+build.7", [1, 4, 2]]
]) {
  test(`runtime floors read numeric release components from ${JSON.stringify(requirement)}`, () => {
    assert.deepEqual(floorOf(requirement), expected)
  })
}

for (const requirement of ["", "latest", "26", "26.4", "^26.4.0", "v26.4.0"]) {
  test(`runtime floors refuse unreadable requirements ${JSON.stringify(requirement)}`, () => {
    assert.throws(() => floorOf(requirement), {
      message: `unreadable version requirement: ${JSON.stringify(requirement)}`
    })
  })
}

for (const [left, right, expected] of [
  [[26, 4, 0], [26, 4, 0], 0],
  [[26, 4, 0], [26, 4, 1], -1],
  [[26, 4, 1], [26, 4, 0], 1],
  [[26, 4, 99], [26, 10, 0], -1],
  [[26, 10, 0], [26, 4, 99], 1],
  [[25, 99, 99], [26, 0, 0], -1],
  [[27, 0, 0], [26, 99, 99], 1]
]) {
  test(`runtime comparison orders ${left.join(".")} against ${right.join(".")}`, () => {
    assert.equal(compare(left, right), expected)
  })
}

for (const bun of [undefined, "1.3.99", "1.4.0", "2.0.0"]) {
  for (const node of [undefined, "26.3.99", "26.4.0", "27.0.0"]) {
    test(`runtime admission combines Bun ${bun} and Node ${node} independently`, () => {
      const result = toolchainRefusal({ bun: ">=1.4.0", node: ">=26.4.0" }, { bun, node })
      if (bun !== "1.3.99" && node !== "26.3.99") {
        assert.equal(result, null)
        return
      }
      const measured = []
      if (bun !== undefined) measured.push(`Bun ${bun}`)
      if (node !== undefined) measured.push(`Node ${node}`)
      assert.equal(result, `Smithers requires Bun >=1.4.0 and Node >=26.4.0; found ${measured.join(", ")}.`)
    })
  }
}

test("Bun measures real Node on PATH and omits an absent Node from the refusal", () => {
  const probe = spawnSync("bun", ["--eval", "console.log(JSON.stringify({path:process.execPath,version:process.versions.bun}))"], {
    encoding: "utf8", timeout: 10_000
  })
  assert.equal(probe.status, 0, `${probe.error?.message ?? ""} ${probe.stderr}`)
  const bun = JSON.parse(probe.stdout)
  const root = mkdtempSync(join(tmpdir(), "require-toolchain-bun-"))
  const manifest = join(root, "package.json")
  const entry = new URL("./require-toolchain.mjs", import.meta.url).href
  const run = (engines, path) => {
    writeFileSync(manifest, JSON.stringify({ engines }))
    return spawnSync(bun.path, ["--eval", `const m = await import(${JSON.stringify(entry)}); m.requireToolchain(${JSON.stringify(manifest)}); console.log("ran")`], {
      cwd: root,
      env: { ...process.env, PATH: path },
      encoding: "utf8",
      timeout: 10_000
    })
  }
  try {
    const refused = run({ bun: ">=1.0.0", node: ">=999.0.0" }, dirname(process.execPath))
    assert.equal(refused.status, 1, refused.stderr)
    assert.equal(refused.stdout, "")
    assert.equal(refused.stderr, `Smithers requires Bun >=1.0.0 and Node >=999.0.0; found Bun ${bun.version}, Node ${process.versions.node}.\n`)
    const allowed = run({ bun: ">=1.0.0", node: ">=1.0.0" }, dirname(process.execPath))
    assert.equal(allowed.status, 0, allowed.stderr)
    assert.equal(allowed.stdout, "ran\n")
    assert.equal(allowed.stderr, "")
    const absentNode = run({ bun: ">=1.0.0", node: ">=999.0.0" }, "")
    assert.equal(absentNode.status, 0, absentNode.stderr)
    assert.equal(absentNode.stdout, "ran\n")
    assert.equal(absentNode.stderr, "")
    const refusedBun = run({ bun: ">=999.0.0", node: ">=999.0.0" }, "")
    assert.equal(refusedBun.status, 1, refusedBun.stderr)
    assert.equal(refusedBun.stdout, "")
    assert.equal(refusedBun.stderr, `Smithers requires Bun >=999.0.0 and Node >=999.0.0; found Bun ${bun.version}.\n`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
