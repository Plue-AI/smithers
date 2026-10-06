import { Smithers } from "@smthrs/targets"
import { Package as backendPackage } from "../../packages/backend/PACKAGE.ts"

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
const documentComponents = Smithers.Shell.Test({
  shell: "cargo test --locked -p smithers-machined --test documents && cargo build --locked -p smithers-ffi --example live_document_interop && YJS_MODULE=../../../node_modules/.pnpm/yjs@13.6.32/node_modules/yjs DOCUMENT_INTEROP_BIN=target/debug/examples/live_document_interop node crates/smithers-ffi/tests/yjs-interop.ts",
  data: [...sources, Smithers.file("//crates/smithers-ffi/tests/yjs-interop.ts"), Smithers.file("//pnpm-lock.yaml")],
  sandbox: "none",
  timeout: "20m"
})
export const Package = Smithers.Package({ targets: { cargoTest, cargoClippy, documentComponents } })
