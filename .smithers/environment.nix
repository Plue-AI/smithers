# The Smithers Cloud machine for this repository.
#
# Owner decision (2026-09-15): Cloud machines are NixOS built from a
# per-repository `.smithers/environment.nix`, and Cloud CI moves off the Debian
# runner pool onto NixOS guests booted from this closure. This module is
# imported after `nix/modules/base.nix` in the plue repository (see that repo's
# `nix/README.md`); it adds to the base and never replaces it. Only the file
# itself reaches the builder, so it carries no relative imports.
#
# Everything `scripts/ci/cloud.sh` and `.github/workflows/ci.yml` install at run
# time is pinned here instead, at the exact release the repository declares, so
# a gate starts with its toolchain already on PATH and downloads nothing:
#
#   Node       .node-version / package.json engines.node
#   npm        PACKAGE.ts `CiToolchain.Node({ npmRelease })`
#   pnpm       package.json packageManager
#   Bun        .smithers/WORKSPACE.ts bunVersion
#   jj         .smithers/WORKSPACE.ts jjVersion
#   Rust       rust-toolchain.toml (channel, components, targets)
#   Go         PACKAGE.ts `CiToolchain.Go`
#   PostgreSQL PACKAGE.ts `CiToolchain.Postgres` (major release)
#   Foundry    PACKAGE.ts `CiToolchain.Foundry` / cloud.sh ensure_foundry
#   ripgrep    PACKAGE.ts `CiToolchain.Ripgrep` (the base pin already matches)
#
# `scripts/ci/environment-nix.test.ts` reads those files and this one and fails
# on drift, so a version moves in one place.
#
# The base module already ships bash, coreutils, curl, git, jq, python3,
# ripgrep 14.1.1, rsync, procps and the language servers. Node, npm, Bun and jj
# are in the base too, at the versions the platform picked rather than the ones
# this repository pins, so each of those four is `lib.hiPrio` here: NixOS builds
# the system profile with `buildEnv { ignoreCollisions = true; }`, which settles
# a colliding `bin/` entry by `meta.priority` before order, and the base module
# is imported first.
{ pkgs, lib, ... }:
let
  inherit (pkgs) fetchurl;

  # Every guest is x86_64-linux (plue's nix/toplevel.nix evaluates only that
  # system), so each pin below is one release artifact and one digest.

  # Node for every gate: the whole pipeline is `pnpm exec smthrs …`.
  # Checksum: the linux-x64 .tar.xz line of
  # https://nodejs.org/dist/v26.5.0/SHASUMS256.txt.
  nodejs = pkgs.stdenv.mkDerivation rec {
    pname = "nodejs";
    version = "26.5.0";
    src = fetchurl {
      url = "https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.xz";
      sha256 = "9f619528f1db5ddc41dccf54211066fb42228d69a156733c69cb9d6cc92e358c";
    };
    nativeBuildInputs = [ pkgs.autoPatchelfHook ];
    buildInputs = [ pkgs.stdenv.cc.cc.lib pkgs.zlib ];
    dontConfigure = true;
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -a . $out
      runHook postInstall
    '';
    meta.platforms = [ "x86_64-linux" ];
  };

  # The certified npm both CI files install (`npm@11.16.0`). Node 26.5.0 bundles
  # 11.17.0, so this one has to win `bin/npm` against the Node package as well
  # as against the base: a priority below `lib.hiPrio`'s -10 does that.
  npm = pkgs.stdenvNoCC.mkDerivation rec {
    pname = "npm";
    version = "11.16.0";
    src = fetchurl {
      url = "https://registry.npmjs.org/npm/-/npm-${version}.tgz";
      sha256 = "30fc15697c771002878665c29f49dddde9aa8667fa5719854b2f52d3cd19230b";
    };
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib/node_modules/npm $out/bin
      cp -a . $out/lib/node_modules/npm
      chmod +x $out/lib/node_modules/npm/bin/npm-cli.js $out/lib/node_modules/npm/bin/npx-cli.js
      ln -s $out/lib/node_modules/npm/bin/npm-cli.js $out/bin/npm
      ln -s $out/lib/node_modules/npm/bin/npx-cli.js $out/bin/npx
      runHook postInstall
    '';
  };

  # pnpm at exactly `packageManager`: every gate runs through `pnpm exec`, and
  # the same tarball and digest are already pinned in flake.nix. A channel's
  # moving pnpm would not satisfy a build tool that asserts an exact version.
  pnpm = pkgs.stdenvNoCC.mkDerivation rec {
    pname = "pnpm";
    version = "11.25.0";
    src = fetchurl {
      url = "https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz";
      hash = "sha256-M90HSPJ+eRbE8ci2lDRhmD40U7BrvaYxKmKAEwtIgeU=";
    };
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib/pnpm $out/bin
      cp -r . $out/lib/pnpm
      chmod +x $out/lib/pnpm/bin/pnpm.cjs $out/lib/pnpm/bin/pnpx.cjs
      ln -s $out/lib/pnpm/bin/pnpm.cjs $out/bin/pnpm
      ln -s $out/lib/pnpm/bin/pnpx.cjs $out/bin/pnpx
      runHook postInstall
    '';
  };

  # Bun runs `//apps/app:unitTests`, the app's e2e web server, and the
  # `cloud-contract` gate (`bun test scripts/ci/cloud.test.ts`). The zip is the
  # release oven-sh publishes, which is what nixpkgs repackages too.
  bun = pkgs.stdenv.mkDerivation rec {
    pname = "bun";
    version = "1.4.1";
    src = fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-linux-x64.zip";
      sha256 = "74c1c3bee7cd998500c8f969cd8972355ac6a07207e94a39eece1999b56ffabf";
    };
    nativeBuildInputs = [ pkgs.unzip pkgs.autoPatchelfHook ];
    buildInputs = [ pkgs.stdenv.cc.cc.lib ];
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      install -Dm755 bun $out/bin/bun
      ln -s $out/bin/bun $out/bin/bunx
      runHook postInstall
    '';
    meta.platforms = [ "x86_64-linux" ];
  };

  # jj at the release the repository pins, for every gate whose toolchain list
  # names `jj` (`workspace`, `packages`, `examples`, `scripts`, `server`,
  # `faults`, the `ui-*` gates, `factory-harness`, `swebench`). The base module
  # ships jujutsu from the platform's unstable pin, which is a different
  # release; cloud.sh's `ensure_jj` re-downloads unless `jj --version` is
  # exactly this, so the pin belongs here.
  jujutsu = pkgs.stdenvNoCC.mkDerivation rec {
    pname = "jujutsu";
    version = "0.39.0";
    src = fetchurl {
      url = "https://github.com/jj-vcs/jj/releases/download/v${version}/jj-v${version}-x86_64-unknown-linux-musl.tar.gz";
      sha256 = "8da8d96e9c8696c21ad47847a63d533e249acb0449d9af0f0562b5ea7b024f04";
    };
    # The tarball has no top-level directory: ./jj, ./README.md, ./LICENSE.
    sourceRoot = ".";
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      install -Dm755 jj $out/bin/jj
      runHook postInstall
    '';
    meta.platforms = [ "x86_64-linux" ];
  };

  # The `rust-lint`, `rust-test`, `third-party-notices` and `scripts` gates, and
  # the wasm artifact the `wasm-repro` job rebuilds byte for byte.
  #
  # rust-toolchain.toml pins channel 1.98.0, profile minimal, components clippy
  # and rustfmt, target wasm32-wasip1 — assembled here from the same standalone
  # installers rustup would fetch, so no rustup and no run-time channel
  # download. `rust-src` stays out on purpose: rust-toolchain.toml explains that
  # installing it moves std spans off their `/rustc/<hash>` form and changes the
  # committed wasm bytes. rust-docs is dropped for size; nothing reads it.
  #
  # Digests: the `xz_hash` entries of
  # https://static.rust-lang.org/dist/channel-rust-1.98.0.toml.
  rust =
    let
      version = "1.98.0";
      date = "2026-08-20";
      dist = name: sha256: fetchurl {
        url = "https://static.rust-lang.org/dist/${date}/${name}";
        inherit sha256;
      };
    in
    pkgs.stdenv.mkDerivation {
      pname = "rust";
      inherit version;
      srcs = [
        (dist "rust-${version}-x86_64-unknown-linux-gnu.tar.xz"
          "ed8ee2df70909c88cbaf87a6cfa3920dac00b537de12a6abe6906641e0f5952f")
        (dist "clippy-${version}-x86_64-unknown-linux-gnu.tar.xz"
          "646c6bd2450ea4c32a3c78ad7a3727294eea1f1519718a3f1487424021695ffa")
        (dist "rustfmt-${version}-x86_64-unknown-linux-gnu.tar.xz"
          "8922a03e68265a74a8040590e28b173fb5d9d49655bb6eacfd880fbd3bef0dc3")
        (dist "rust-std-${version}-wasm32-wasip1.tar.xz"
          "07af7da4d9e943226c438cd5b60ba2b1f23a88c077eb09ccb227a385529c8b08")
      ];
      sourceRoot = ".";
      nativeBuildInputs = [ pkgs.autoPatchelfHook ];
      buildInputs = [ pkgs.stdenv.cc.cc.lib pkgs.zlib ];
      dontBuild = true;
      # Stripping an rlib removes its .rmeta section (see nixpkgs' rust
      # binary.nix), which breaks every crate that links it.
      dontStrip = true;
      # A standalone installer is a directory per component plus a `components`
      # file naming them; copying the components is install.sh without its
      # manifest bookkeeping, which is what lets four of them share one prefix.
      installPhase = ''
        runHook preInstall
        mkdir -p $out
        for pkgdir in */; do
          [ -f "$pkgdir/components" ] || continue
          while read -r component; do
            case "$component" in rust-docs*) continue ;; esac
            [ -d "$pkgdir$component" ] || continue
            cp -a "$pkgdir$component/." "$out/"
            chmod -R u+w "$out"
          done < "$pkgdir/components"
        done
        rm -f $out/manifest.in
        runHook postInstall
      '';
      meta.platforms = [ "x86_64-linux" ];
    };

  # `//packages/smithers/build/build-cli:test` builds a real Go package tree
  # (PACKAGE.ts says so, and ci.yml installs Go for the jobs that run it). The
  # pinned nixpkgs only carries Go 1.23, so take the release tarball.
  # Checksum: https://go.dev/dl/?mode=json&include=all.
  go = pkgs.stdenvNoCC.mkDerivation rec {
    pname = "go";
    version = "1.26.8";
    src = fetchurl {
      url = "https://go.dev/dl/go${version}.linux-amd64.tar.gz";
      sha256 = "d0f743b33e8d8945e6b1f432edd15785c70507121d6e2a723b21285eddf8b57b";
    };
    dontBuild = true;
    dontStrip = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/share/go $out/bin
      cp -a . $out/share/go
      ln -s $out/share/go/bin/{go,gofmt} $out/bin/
      runHook postInstall
    '';
    meta.platforms = [ "x86_64-linux" ];
  };

  # The same `//packages/smithers/build/build-cli:test` cases build and test a
  # Foundry package and assert `forge fmt --check` drift; cloud.sh's
  # `ensure_foundry` names this exact release. No published checksum file, so
  # the digest is of the release asset itself.
  foundry = pkgs.stdenv.mkDerivation rec {
    pname = "foundry";
    version = "1.8.1";
    src = fetchurl {
      url = "https://github.com/foundry-rs/foundry/releases/download/v${version}/foundry_v${version}_linux_amd64.tar.gz";
      sha256 = "37b45855232e57624d90113b049ca54f0c92055bb5c1997fcbdc3076c7b89c10";
    };
    sourceRoot = ".";
    nativeBuildInputs = [ pkgs.autoPatchelfHook ];
    buildInputs = [ pkgs.stdenv.cc.cc.lib ];
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      for tool in forge cast anvil chisel solar; do
        install -Dm755 "$tool" "$out/bin/$tool"
      done
      runHook postInstall
    '';
    meta.platforms = [ "x86_64-linux" ];
  };

  # What a Playwright-downloaded Chromium dynamically links. The browsers ship
  # as prebuilt binaries that open /lib64/ld-linux-x86-64.so.2, which nix-ld
  # answers with these libraries, so `ui-browser` needs no root and no
  # `playwright install --with-deps`.
  playwrightLibraries = with pkgs; [
    alsa-lib at-spi2-atk at-spi2-core atk cairo cups dbus expat
    fontconfig freetype gdk-pixbuf glib gtk3 libdrm libglvnd mesa
    libxkbcommon nspr nss pango udev
    xorg.libX11 xorg.libXcomposite xorg.libXdamage xorg.libXext xorg.libXfixes
    xorg.libXrandr xorg.libxcb xorg.libxshmfence
  ];
in
{
  environment.systemPackages =
    # The four the base also ships: priority, not order, decides the profile.
    (map lib.hiPrio [ nodejs bun jujutsu ])
    ++ [
      # Below hiPrio's -10, so it also outranks the npm inside the Node tarball.
      (lib.setPrio (-20) npm)
      pnpm
      rust
      go
      # Storage matrix tests run initdb and pg_ctl in a task-local cluster.
      pkgs.postgresql_18
      foundry
      # `faults` and every confined target run under bubblewrap, which ci.yml
      # apt-installs and cloud.sh cannot install at all on an unprivileged
      # runner.
      pkgs.bubblewrap
      # Linking for cargo: jj-lib arrives as a git dependency and builds its
      # native halves from source.
      pkgs.gcc
      # `cc` is rustc's default linker and the `cc` crate's compiler; `ar` is
      # what that crate archives its objects with.
      pkgs.binutils
      pkgs.pkg-config
      pkgs.cmake
      pkgs.perl
      pkgs.openssl
      pkgs.openssl.dev
      # A system Chromium for anything that honours CHROME_PATH, beside the
      # libraries above that let Playwright run its own pinned build.
      # apps/tui-docs records and tests with the `chromium` on PATH.
      pkgs.chromium
      # The `docs` gate records every TUI guide: apps/tui-docs encodes each
      # recording's GIF with FFmpeg (palettegen/paletteuse, no display).
      pkgs.ffmpeg-headless
    ];

  programs.nix-ld.libraries = playwrightLibraries;

  environment.variables = {
    # Go: no toolchain switch (the guest has no egress to fetch one) and no VCS
    # stamping (the build-cli fixture trees are not repositories).
    GOTOOLCHAIN = "local";
    GOFLAGS = "-buildvcs=false";
    # Playwright validates host packages through the distribution package
    # manager, which NixOS does not have; the libraries it is checking for are
    # in nix-ld above.
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
    CHROME_PATH = "${pkgs.chromium}/bin/chromium";
    PKG_CONFIG_PATH = "${pkgs.openssl.dev}/lib/pkgconfig";
  };
}
