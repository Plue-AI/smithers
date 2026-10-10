import { Smithers } from "@smthrs/targets"
import { Package as flowsJjPackage } from "../crates/flows-jj/PACKAGE.ts"
import { Package as machinedPackage } from "../crates/smithers-machined/PACKAGE.ts"
import { Package as backendPackage } from "../packages/backend/PACKAGE.ts"

export const nativeFfiInputs = [
  Smithers.file("//Cargo.toml"),
  Smithers.file("//Cargo.lock"),
  Smithers.file("//rust-toolchain.toml"),
  Smithers.file("//crates/flows-jj/Cargo.toml"),
  flowsJjPackage.nativeSources,
  Smithers.glob("//crates/smithers-ffi/**/*.rs"),
  Smithers.file("//crates/smithers-ffi/Cargo.toml")
]
// Native FFI builds with the toolchain rust-toolchain.toml pins, installed
// into a private rustup home so the declared output carries it. backendGo
// needs only the library, so it depends on this build alone: a clippy or
// cargo test failure in //:nativeFfi must not skip the Go backend suite.
export const nativeFfiLib = Smithers.Shell.Build({
  shell: "mkdir -p .native-ffi; export RUSTUP_HOME=\"$PWD/.native-ffi/rustup\" CARGO_TARGET_DIR=\"$PWD/.native-ffi/target\"; rustup toolchain install && cargo build -p smithers-ffi --lib --locked",
  outDirs: ["//.native-ffi"],
  data: nativeFfiInputs,
  sandbox: { network: true },
  timeout: "30m"
})

// The trusted-process rehearsals (compose's newRehearsal) bind a TODO's
// checkout through a test-only build of smithers-jj-export and run machined's
// rehearsal daemon. Release builds never enable trusted-process-binding, so
// the installed helper CI exports starts no rehearsal TODO, and the confined
// Go suites cannot run Cargo. Both binaries are built here, from this
// checkout, and the suites name them in SMITHERS_REHEARSAL_* variables. The
// private toolchain and target directory are removed after the build: only
// the two executables are the output.
export const rehearsalNative = Smithers.Shell.Build({
  shell: "build=\"$PWD/.rehearsal-native/build\"; mkdir -p \"$build\" || exit $?; export RUSTUP_HOME=\"$build/rustup\" CARGO_TARGET_DIR=\"$build/target\"; rustup toolchain install && cargo build --locked -p smithers-ffi --bin smithers-jj-export --features trusted-process-binding && cargo build --locked -p smithers-machined --example rehearsal_daemon && cp \"$build/target/debug/smithers-jj-export\" \"$build/target/debug/examples/rehearsal_daemon\" .rehearsal-native/; status=$?; rm -rf \"$build\"; exit $status",
  outDirs: ["//.rehearsal-native"],
  data: [...nativeFfiInputs, machinedPackage.buildInputs, backendPackage.machineContractInputs],
  sandbox: { network: true },
  timeout: "30m"
})
