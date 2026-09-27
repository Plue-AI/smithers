/**
 * The toolchain drift gate.
 *
 * `.smithers/WORKSPACE.ts` declares the Node and Bun runtimes and the pnpm
 * version once. Three other files spell the same facts in their own syntax:
 * package.json (`engines`, `packageManager`), flake.nix (the pinned pnpm
 * tarball and the Node major), `.node-version` (the exact Node every
 * environment runs), and the generated CI workflow (the releases the runners
 * install). This gate reads the declaration and fails on the first file that
 * disagrees with it, so the workspace declaration is the one place a version
 * moves.
 *
 * Rust has the same shape with a different source: `rust-toolchain.toml` pins
 * the one channel, and every workflow, script and image that names a Rust
 * release must name that one. `rustFindings` is that comparison.
 *
 * Run as `node scripts/check-toolchain-pins.mjs`; `findings` is the pure
 * comparison the test drives with fixtures.
 */
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { compare, floorOf } from "./require-toolchain.mjs"
import { isMain, repoRoot } from "./workspace-packages.mjs"

/**
 * A `with:` pin in the generated workflow, whose keys and values are quoted.
 *
 * The generator emits `"bun-version": "1.4.1"`, so a pattern written for bare
 * YAML (`bun-version:`) matched nothing and the pin went unchecked, while
 * `jj-cli@([^\s]+)` captured the closing quote and reported every job as drift
 * against the version it actually agreed with.
 */
const inlinePin = (key) => new RegExp(`"?${key}"?:\\s*"?([^"\\s]+)"?`, "g")

/** The file that holds the one Node release every environment runs. */
export const nodeVersionFile = ".node-version"

/** Whether an exact release satisfies the declared `>=` requirement within its major. */
export const satisfies = (release, requirement) => {
  const floor = floorOf(requirement)
  const version = floorOf(release)
  return version[0] === floor[0] && compare(version, floor) >= 0
}

/**
 * The disagreements between the workspace declaration and the other files,
 * each one line naming the file and both values. Empty means in sync.
 */
export const findings = ({ workspace, packageJson, flake, ci, nodeVersion }) => {
  const out = []
  const { runtime, packageManager, bunRuntime } = workspace
  const manifest = JSON.parse(packageJson)
  const expectedManager = `pnpm@${packageManager.version}`
  if (manifest.packageManager !== expectedManager) {
    out.push(`package.json packageManager is ${JSON.stringify(manifest.packageManager)}; WORKSPACE.ts declares ${expectedManager}`)
  }
  if (manifest.engines?.node !== runtime.version) {
    out.push(`package.json engines.node is ${JSON.stringify(manifest.engines?.node)}; WORKSPACE.ts declares ${runtime.version}`)
  }
  if (manifest.engines?.bun !== bunRuntime.version) {
    out.push(`package.json engines.bun is ${JSON.stringify(manifest.engines?.bun)}; WORKSPACE.ts declares ${bunRuntime.version}`)
  }
  const pnpmPin = /pname = "pnpm";\s*version = "([^"]+)"/.exec(flake)
  if (pnpmPin === null) out.push("flake.nix pins no pnpm tarball (expected pname = \"pnpm\"; version = \"...\")")
  else if (pnpmPin[1] !== packageManager.version) {
    out.push(`flake.nix pins pnpm ${pnpmPin[1]}; WORKSPACE.ts declares ${packageManager.version}`)
  }
  const nodeMajor = floorOf(runtime.version)[0]
  const nodeAttrs = [...new Set([...flake.matchAll(/nodejs_(\d+)/g)].map((match) => match[1]))]
  if (nodeAttrs.length === 0) out.push("flake.nix names no nodejs_<major> package")
  for (const major of nodeAttrs) {
    if (Number(major) !== nodeMajor) out.push(`flake.nix uses nodejs_${major}; WORKSPACE.ts declares Node ${runtime.version}`)
  }
  // The Node the runners install is `.node-version`, which every other
  // environment reads too: `scripts/ci/cloud.sh` bootstraps from it and fnm,
  // nvm and asdf read it on a developer's machine. So ci.yml must point at that
  // file and carry no literal of its own, and the file must hold one exact
  // release at or above the declared floor. A literal in the workflow is the
  // drift this gate exists to stop: it is how ci.yml came to install 22.19.0
  // while the Cloud bootstrap downloaded 24.21.0.
  const nodeFileMatch = inlinePin("node-version-file").exec(ci)
  if (nodeFileMatch === null) out.push("ci.yml sets up node without node-version-file")
  else if (nodeFileMatch[1] !== nodeVersionFile) {
    out.push(`ci.yml reads node from ${nodeFileMatch[1]}; the repository pins ${nodeVersionFile}`)
  }
  for (const [, release] of ci.matchAll(inlinePin("node-version"))) {
    out.push(`ci.yml pins node ${release} inline; it must read ${nodeVersionFile}`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion.trim())) {
    out.push(`${nodeVersionFile} must hold one exact Node release as x.y.z; it holds ${JSON.stringify(nodeVersion)}`)
  } else if (compare(floorOf(nodeVersion.trim()), floorOf(runtime.version)) < 0) {
    out.push(`${nodeVersionFile} pins node ${nodeVersion.trim()}; WORKSPACE.ts declares ${runtime.version}`)
  }
  for (const [, release] of ci.matchAll(inlinePin("bun-version"))) {
    if (!satisfies(release, bunRuntime.version)) {
      out.push(`ci.yml installs bun ${release}; WORKSPACE.ts declares ${bunRuntime.version}`)
    }
  }
  for (const [name, version] of [["bun", workspace.bunVersion], ["jujutsu", workspace.jjVersion]]) {
    const pin = new RegExp(`assert pkgs\\.${name}\\.version == "([^"\\s]+)";`).exec(flake)
    if (pin === null) out.push(`flake.nix pins no ${name} version assertion`)
    else if (pin[1] !== version) out.push(`flake.nix pins ${name} ${pin[1]}; WORKSPACE.ts declares ${version}`)
  }
  const jjPins = [...ci.matchAll(/jj-cli@([^"\s]+)/g)]
  if (jjPins.length === 0) out.push("ci.yml installs no jj-cli release")
  for (const [, release] of jjPins) {
    if (release !== workspace.jjVersion) out.push(`ci.yml installs jj ${release}; WORKSPACE.ts declares ${workspace.jjVersion}`)
  }
  for (const [, release] of ci.matchAll(inlinePin("bun-version"))) {
    if (release !== workspace.bunVersion) out.push(`ci.yml pins bun ${release}; WORKSPACE.ts declares ${workspace.bunVersion}`)
  }
  return out
}

/**
 * The places a Rust release is spelled: `rustup toolchain install <release>...`,
 * `cargo +<release>`, `rustup run <release>`, a `rust:<release>-` image, and
 * `RUSTUP_TOOLCHAIN` or `toolchain:` values.
 */
const rustPins = [
  /toolchain install((?:\s+'?\d[\w.-]*'?)+)/g,
  /cargo \+(\d[\w.-]*)/g,
  /rustup",? "?run"?,? "?(\d[\w.-]*)/g,
  /\brust:(\d[\w.]*)-/g,
  /RUSTUP_TOOLCHAIN"?[:=]\s*"?(\d[\w.-]*)/g,
  /\btoolchain: "(\d[\w.-]*)"/g
]

/** The files outside `.github/workflows` that name a Rust release. */
export const rustPinFiles = ["PACKAGE.ts", "scripts/ci/cloud.sh", "distribution/Dockerfile", "apps/app/scripts/build-native.ts"]

/**
 * Every Rust release `files` (path to text) names that is not the channel
 * `toolchain` (the text of rust-toolchain.toml) pins, one line each.
 */
export const rustFindings = ({ toolchain, files }) => {
  const channel = /^channel = "([^"]*)"/m.exec(toolchain)?.[1]
  if (channel === undefined || !/^\d+\.\d+\.\d+$/.test(channel)) {
    return [`rust-toolchain.toml must pin one exact release as x.y.z; it pins ${JSON.stringify(channel)}`]
  }
  const out = []
  for (const [path, text] of Object.entries(files)) {
    for (const pattern of rustPins) {
      for (const match of text.matchAll(pattern)) {
        for (const release of match[1].replaceAll("'", "").trim().split(/\s+/)) {
          if (release !== channel) out.push(`${path} names Rust ${release}; rust-toolchain.toml pins ${channel}`)
        }
      }
    }
  }
  return out
}

/** Reads the four files of the real repository and compares them. */
export const check = async (root = repoRoot) => {
  const workspace = await import(pathToFileURL(resolve(root, ".smithers/WORKSPACE.ts")).href)
  return findings({
    workspace,
    packageJson: readFileSync(resolve(root, "package.json"), "utf8"),
    flake: readFileSync(resolve(root, "flake.nix"), "utf8"),
    ci: readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"),
    nodeVersion: readFileSync(resolve(root, nodeVersionFile), "utf8")
  }).concat(rustFindings({
    toolchain: readFileSync(resolve(root, "rust-toolchain.toml"), "utf8"),
    files: Object.fromEntries([
      ...readdirSync(resolve(root, ".github/workflows")).map((name) => `.github/workflows/${name}`),
      ...rustPinFiles
    ].map((path) => [path, readFileSync(resolve(root, path), "utf8")]))
  }))
}

if (isMain(import.meta)) {
  const drift = await check()
  if (drift.length > 0) {
    process.stderr.write(`toolchain pins drift from .smithers/WORKSPACE.ts or rust-toolchain.toml:\n${drift.map((line) => `  ${line}`).join("\n")}\n`)
    process.exit(1)
  }
  process.stdout.write("toolchain pins agree with .smithers/WORKSPACE.ts and rust-toolchain.toml\n")
}
