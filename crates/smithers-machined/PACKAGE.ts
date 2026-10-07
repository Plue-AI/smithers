import { Smithers } from "@smthrs/targets"
import { Package as jjPackage } from "../flows-jj/PACKAGE.ts"
import { Package as backendPackage } from "../../packages/backend/PACKAGE.ts"

const buildInputs = Smithers.Filegroup({ cwd: "crates/smithers-machined", srcs: [Smithers.glob("**/*")] })

const ffiInputs = Smithers.Filegroup({ cwd: "crates/smithers-ffi", srcs: [Smithers.glob("**/*")] })
const documentComponents = Smithers.Shell.Test({
  shell: "cargo test --locked -p smithers-machined --test documents && cargo build --locked -p smithers-ffi --example live_document_interop && YJS_MODULE=../../../node_modules/.pnpm/yjs@13.6.32/node_modules/yjs DOCUMENT_INTEROP_BIN=\"${CARGO_TARGET_DIR:-target}/debug/examples/live_document_interop\" node crates/smithers-ffi/tests/yjs-interop.ts",
  data: [buildInputs, ffiInputs, Smithers.file("//Cargo.toml"), Smithers.file("//Cargo.lock"),
    Smithers.file("//rust-toolchain.toml"), Smithers.file("//pnpm-lock.yaml")],
  env: { CARGO_BUILD_JOBS: "2", CARGO_TARGET_DIR: ".artifacts/document-components-target" },
  sandbox: "none",
  exclusive: true,
  timeout: "30m"
})

const sources = [
  Smithers.glob("//crates/smithers-machined/**/*.rs"),
  Smithers.file("//crates/smithers-machined/Cargo.toml"),
  Smithers.file("//Cargo.toml"),
  Smithers.file("//Cargo.lock"),
  backendPackage.machineContractInputs
]
const destinations = ["index.crates.io", "static.crates.io", "github.com"]
// The image plants this static guest binary after verifying its digest.
// Rust ships the static musl runtime and linker; no host libc is linked.
const linuxArm64 = Smithers.Cargo.Build({
  package: "smithers-machined", bins: ["smithers-machined"],
  locked: true, profile: "release", target: "aarch64-unknown-linux-musl",
  env: { CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER: "rust-lld" },
  data: [...sources, jjPackage.nativeSources,
    Smithers.file("//crates/flows-jj/Cargo.toml"), Smithers.file("//rust-toolchain.toml")],
  destinations
})
const cargoTest = Smithers.Cargo.Test({
  package: "smithers-machined", locked: true, data: sources, destinations
})
const cargoClippy = Smithers.Cargo.Clippy({
  package: "smithers-machined", allTargets: true, locked: true,
  denyWarnings: true, data: sources, destinations
})
export const Package = Smithers.Package({ targets: { buildInputs, ffiInputs, documentComponents, linuxArm64, cargoTest, cargoClippy } })
