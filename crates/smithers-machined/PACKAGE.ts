/**
 * Native gates for the dark machine daemon crate and its ADR 0004 codecs.
 * Tests include opt-in fixtures; release builds omit fixtures and serde.
 */
import { Smithers } from "@smthrs/targets"

const sources = [
  Smithers.glob("//crates/smithers-machined/**/*.rs"),
  Smithers.file("//crates/smithers-machined/Cargo.toml"),
  Smithers.file("//Cargo.toml"),
  Smithers.file("//Cargo.lock"),
  Smithers.file("//rust-toolchain.toml"),
  Smithers.glob("//packages/backend/internal/compose/testdata/cocontracts/**")
]
const cargoFmt = Smithers.Cargo.Fmt({
  workspace: true,
  data: sources,
  changes: ["crates/smithers-machined/**/*.rs"]
})
const cargoClippy = Smithers.Cargo.Clippy({
  package: "smithers-machined",
  allTargets: true,
  features: ["testing", "killpoints"],
  locked: true,
  denyWarnings: true,
  data: sources
})
const cargoTest = Smithers.Cargo.Test({
  package: "smithers-machined",
  features: ["testing", "killpoints"],
  locked: true,
  data: sources
})
// Cargo.Build has no Zig driver seam. ToolBuild is the explicit uncached
// escape hatch for this static musl binary; executable identity is incomplete.
const muslBuild = Smithers.ToolBuild({
  tool: "cargo-zigbuild",
  command: "cargo",
  args: ["zigbuild", "--locked", "--release", "-p", "smithers-machined", "--bin", "smithers-machined", "--target", "aarch64-unknown-linux-musl"],
  inputs: sources,
  outputs: ["target/aarch64-unknown-linux-musl/release/smithers-machined"],
  deps: [],
  env: {},
  cache: false
})
export const Package = Smithers.Package({ targets: { cargoFmt, cargoClippy, cargoTest, muslBuild } })
