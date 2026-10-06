import { Smithers } from "@smthrs/targets"
import { Package as backendPackage } from "../../packages/backend/PACKAGE.ts"

const buildInputs = Smithers.Filegroup({ cwd: "crates/smithers-machined", srcs: [Smithers.glob("**/*")] })

const sources = [
  Smithers.glob("//crates/smithers-machined/**/*.rs"),
  Smithers.file("//crates/smithers-machined/Cargo.toml"),
  Smithers.file("//Cargo.toml"),
  Smithers.file("//Cargo.lock"),
  backendPackage.machineContractInputs
]
const destinations = ["index.crates.io", "static.crates.io", "github.com"]
const cargoTest = Smithers.Cargo.Test({
  package: "smithers-machined", locked: true, data: sources, destinations
})
const cargoClippy = Smithers.Cargo.Clippy({
  package: "smithers-machined", allTargets: true, locked: true,
  denyWarnings: true, data: sources, destinations
})
export const Package = Smithers.Package({ targets: { buildInputs, cargoTest, cargoClippy } })
