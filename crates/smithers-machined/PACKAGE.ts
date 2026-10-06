import { Smithers } from "@smthrs/targets"

const sources = [
  Smithers.glob("//crates/smithers-machined/**/*.rs"),
  Smithers.file("//crates/smithers-machined/Cargo.toml"),
  Smithers.file("//Cargo.toml"),
  Smithers.file("//Cargo.lock"),
  Smithers.glob("//packages/backend/internal/compose/testdata/cocontracts/**")
]
const destinations = ["index.crates.io", "static.crates.io", "github.com"]
const cargoTest = Smithers.Cargo.Test({
  package: "smithers-machined", locked: true, data: sources, destinations
})
const cargoClippy = Smithers.Cargo.Clippy({
  package: "smithers-machined", allTargets: true, locked: true,
  denyWarnings: true, data: sources, destinations
})
export const Package = Smithers.Package({ targets: { cargoTest, cargoClippy } })
