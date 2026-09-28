# OpenTUI native editor

This directory supplies the corrected native editor for
[#2403](https://github.com/smithersai/smithers/issues/2403). OpenTUI 0.5.11
can reorder separately typed combining marks, omit them from editing ranges,
and leave standalone marks undeletable. `native.patch` repairs the existing
Zig editor and retains its regression tests. There is no JavaScript editor or
Unicode normalization layer.

`manifest.json` pins the upstream commit/archive, source patch, vendored Zig
dependencies, Zig 0.16.0 toolchain and macOS 15.5 SDK metadata. Each of the eight
native artifacts has a SHA-256 digest. `build-receipt.json` records build and
validation bounds; `licenses/` contains upstream and bundled dependency notices.

The CLI's `@smthrs/cli/tui-native` export selects these files. The interactive
TUI registers the selected path through OpenTUI's `setRenderLibPath` before
creating a renderer. Help and print mode do not initialize it. Missing files
and unsupported targets fail; they do not select an unpatched library.
Node uses package-relative file URLs. Bun uses its standard file loader, and
the compiled build maps OpenTUI's platform imports to the same file to avoid
embedding another native implementation.

Installation needs no scripts, compiler, private files or services. The
committed artifacts are included in the public CLI package. The CLI build
verifies their digests, and recording inputs include this directory.

## Verify and rebuild

From the repository root:

```sh
node packages/smithers/vendor/opentui-native/verify.mjs
node packages/smithers/vendor/opentui-native/rebuild.mjs \
  --out /tmp/opentui-artifacts \
  --zig /path/to/zig-0.16.0/zig \
  --sdk /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
```

Install Zig from the archive and checksum recorded in `manifest.json`. The
recipe checks the executable digest on the recorded macOS arm64 build host,
the Zig version, SDK metadata, source archive, patch, dependency archive, and
rebuilt artifact digests. It retains its temporary source/build directory.
`--target darwin-arm64` selects one target; `--source-archive /path/to/source.tar.gz`
uses an already downloaded, digest-checked upstream archive. Targets build
serially with at most two compiler jobs. No installed dependency is replaced.

The explicit `-Dstrip-native=true` option makes distribution builds independent
of debug source paths; upstream's default symbol-bearing build is unchanged.
Two clean macOS arm64 builds from different paths produced identical bytes.
All eight targets cross-built here: macOS, Linux glibc 2.17, Linux musl, and
Windows, each on arm64 and x64. Only macOS arm64 was executed locally. Native
tests passed 2,158 cases with 34 upstream skips; public-editor and real-terminal
regressions qualify the shipped host artifact. Cross-builds do not establish
runtime behavior on the other platforms. Fable review was requested but both
available authentication routes were quota-blocked; that review is outstanding.

## Update

Apply upstream fixes to this one dependency path. Update the pins and patch,
rebuild all artifacts, retain native/public-editor/terminal/packaging evidence,
and refresh recording inputs and receipts. When an upstream release contains
all retained regressions' fixes, replace this directory and loader wiring in
the same change; do not keep a fallback to the defective native library.
