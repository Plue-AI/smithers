# Third-party notices for @smthrs/jj

This distribution contains third-party software. The notices below are
reproduced to satisfy the terms of the licenses those components are
distributed under. They are in addition to, and do not replace, this
package's own `LICENSE` (MIT).

`wasm/flows_jj.wasm` is a `wasm32-wasip1` reactor module built from
`crates/flows-jj` (`cargo build --release --target wasm32-wasip1 --package
flows-jj`). That crate statically links `jj-lib` — taken from a fork of
Jujutsu that `crates/flows-jj/Cargo.toml` pins as a git dependency at one
rev — and every crate in `jj-lib`'s and `flows-jj`'s Rust closure. This
file enumerates that closure, resolved from the repo's `Cargo.lock` with
`cargo metadata` / `cargo tree -e normal,build --target wasm32-wasip1
--package flows-jj`, and groups it by license. Dev-only dependencies (for
example the `tempfile` edge that comes from `flows-jj`'s own
`[dev-dependencies]`, used only by its native `cargo test` binaries) are
excluded because `cargo build --release` never compiles them into the wasm
artifact; `tempfile` still appears below because `jj-lib` itself also
depends on it as a normal (non-dev) dependency. Proc-macro crates are
included because they compile into code that is generated into, and shipped
as part of, the artifact.

## jj-lib (Apache-2.0)

- Upstream repository: <https://github.com/jj-vcs/jj>
- Fork: <https://github.com/smithersai/jj>, branch `flows-wasm`, pinned as a
  cargo git dependency at rev `47589ada70c12b3e829b5c98ab32503abad49eac`
  (see `crates/flows-jj/Cargo.toml` and `Cargo.lock`)
- Crates: `jj-lib` and `jj-lib-proc-macros`, both under `lib/` in that fork
- Version statically linked into `wasm/flows_jj.wasm`: 0.44.0
- Copyright 2020–2026 The Jujutsu Authors (per-file copyright headers
  throughout the fork's `lib/src`; its `AUTHORS` file additionally credits
  Google LLC as a significant contributor)
- The fork ships no separate `NOTICE` file; there is no attribution
  content beyond the per-file copyright headers and the Apache License 2.0
  text below.

jj-lib and jj-lib-proc-macros are distributed under the Apache License,
Version 2.0. Apache-2.0 §4(a) requires that any redistribution of the Work
give recipients a copy of the License; the full text is reproduced below.

## Apache License, Version 2.0

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

Generated inventory: run `node scripts/generate-third-party-notices.mjs` after
changing Cargo dependencies. CI checks it with `--check`. Attribution prose and
license text are maintained in `scripts/third-party-notices.template.md`.

## All statically linked crates, by license

### Apache-2.0 (no alternate license offered)

jj-lib and jj-lib-proc-macros are covered by the Apache License 2.0 text
above; `prost`, `prost-derive`, and `unicode-bom` are separate crates in the
dependency closure that are also Apache-2.0–only.

| Crate                | Version | Copyright                                                                                                                                     | Repository                                 |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `bytesize`           | 2.7.0   | Hyunsik Choi <hyunsik.choi@gmail.com>; MrCroxx <mrcroxx@outlook.com>; Rob Ede <robjtede@icloud.com>                                           | <https://github.com/bytesize-rs/bytesize>  |
| `gix-imara-diff`     | 0.2.5   | pascalkuthe <pascalkuthe@pm.me>; Sebastian Thiel <sebastian.thiel@icloud.com>                                                                 | <https://github.com/GitoxideLabs/gitoxide> |
| `jj-lib-proc-macros` | 0.44.0  | (see repository)                                                                                                                              | <https://github.com/jj-vcs/jj>             |
| `jj-lib`             | 0.44.0  | (see repository)                                                                                                                              | <https://github.com/jj-vcs/jj>             |
| `prost-derive`       | 0.14.4  | Dan Burkert <dan@danburkert.com>; Lucio Franco <luciofranco14@gmail.com>; Casper Meijn <casper@meijn.net>; Tokio Contributors <team@tokio.rs> | <https://github.com/tokio-rs/prost>        |
| `prost`              | 0.14.4  | Dan Burkert <dan@danburkert.com>; Lucio Franco <luciofranco14@gmail.com>; Casper Meijn <casper@meijn.net>; Tokio Contributors <team@tokio.rs> | <https://github.com/tokio-rs/prost>        |
| `unicode-bom`        | 2.0.3   | Phil Booth <pmbooth@gmail.com>                                                                                                                | <https://gitlab.com/philbooth/unicode-bom> |

### MIT OR Apache-2.0 (dual-licensed)

This project distributes `wasm/flows_jj.wasm` under the terms of MIT for
every crate below (this package's own `LICENSE` is MIT, and MIT text is
reproduced in the root `THIRD_PARTY_NOTICES.md`).

| Crate                   | Version            | Copyright                                                                                                                                  | Repository                                            |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `allocator-api2`        | 0.2.21             | Zakarum <zaq.dev@icloud.com>                                                                                                               | <https://github.com/zakarumych/allocator-api2>        |
| `anyhow`                | 1.0.104            | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/anyhow>                   |
| `arc-swap`              | 1.9.2              | Michal 'vorner' Vaner <vorner@vorner.cz>                                                                                                   | <https://github.com/vorner/arc-swap>                  |
| `arrayvec`              | 0.7.8              | bluss                                                                                                                                      | <https://github.com/bluss/arrayvec>                   |
| `async-trait`           | 0.1.92             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/async-trait>              |
| `autocfg`               | 1.5.1              | Josh Stone <cuviper@gmail.com>                                                                                                             | <https://github.com/cuviper/autocfg>                  |
| `beef`                  | 0.5.2              | Maciej Hirsz <hello@maciej.codes>                                                                                                          | <https://github.com/maciejhirsz/beef>                 |
| `bitflags`              | 1.3.2              | The Rust Project Developers                                                                                                                | <https://github.com/bitflags/bitflags>                |
| `bitflags`              | 2.13.1             | The Rust Project Developers                                                                                                                | <https://github.com/bitflags/bitflags>                |
| `blake2`                | 0.10.6             | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/hashes>                |
| `block-buffer`          | 0.10.4             | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/utils>                 |
| `block-buffer`          | 0.12.1             | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/utils>                 |
| `bstr`                  | 1.13.1             | Andrew Gallant <jamslam@gmail.com>                                                                                                         | <https://github.com/BurntSushi/bstr>                  |
| `cfg-if`                | 1.0.4              | Alex Crichton <alex@alexcrichton.com>                                                                                                      | <https://github.com/rust-lang/cfg-if>                 |
| `chacha20`              | 0.10.1             | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/stream-ciphers>        |
| `chrono`                | 0.4.45             | (see repository)                                                                                                                           | <https://github.com/chronotope/chrono>                |
| `crc32fast`             | 1.5.2              | Sam Rijs <srijs@airpost.net>; Alex Crichton <alex@alexcrichton.com>                                                                        | <https://github.com/srijs/rust-crc32fast>             |
| `crossbeam-channel`     | 0.5.17             | (see repository)                                                                                                                           | <https://github.com/crossbeam-rs/crossbeam>           |
| `crossbeam-deque`       | 0.8.7              | (see repository)                                                                                                                           | <https://github.com/crossbeam-rs/crossbeam>           |
| `crossbeam-epoch`       | 0.9.20             | (see repository)                                                                                                                           | <https://github.com/crossbeam-rs/crossbeam>           |
| `crossbeam-utils`       | 0.8.22             | (see repository)                                                                                                                           | <https://github.com/crossbeam-rs/crossbeam>           |
| `crypto-common`         | 0.1.7              | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/traits>                |
| `crypto-common`         | 0.2.2              | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/traits>                |
| `defmt-macros`          | 1.1.1              | The Knurling-rs developers                                                                                                                 | <https://github.com/knurling-rs/defmt>                |
| `defmt-parser`          | 1.0.0              | The Knurling-rs developers                                                                                                                 | <https://github.com/knurling-rs/defmt>                |
| `defmt`                 | 1.1.1              | The Knurling-rs developers                                                                                                                 | <https://github.com/knurling-rs/defmt>                |
| `digest`                | 0.10.7             | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/traits>                |
| `digest`                | 0.11.3             | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/traits>                |
| `either`                | 1.17.0             | (see repository)                                                                                                                           | <https://github.com/rayon-rs/either>                  |
| `equivalent`            | 1.0.2              | (see repository)                                                                                                                           | <https://github.com/indexmap-rs/equivalent>           |
| `errno`                 | 0.3.14             | Chris Wong <lambda.fairy@gmail.com>; Dan Gohman <dev@sunfishcode.online>                                                                   | <https://github.com/lambda-fairy/rust-errno>          |
| `etcetera`              | 0.11.0             | (see repository)                                                                                                                           | <https://github.com/lunacookies/etcetera>             |
| `fastrand`              | 2.5.0              | Stjepan Glavina <stjepang@gmail.com>                                                                                                       | <https://github.com/smol-rs/fastrand>                 |
| `filetime`              | 0.2.29             | Alex Crichton <alex@alexcrichton.com>                                                                                                      | <https://github.com/alexcrichton/filetime>            |
| `fnv`                   | 1.0.7              | Alex Crichton <alex@alexcrichton.com>                                                                                                      | <https://github.com/servo/rust-fnv>                   |
| `futures-channel`       | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-core`          | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-executor`      | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-io`            | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-macro`         | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-sink`          | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-task`          | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-util`          | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures`               | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `getrandom`             | 0.4.3              | The Rand Project Developers                                                                                                                | <https://github.com/rust-random/getrandom>            |
| `gix-actor`             | 0.41.2             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-archive`           | 0.34.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-attributes`        | 0.33.2             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-bitmap`            | 0.3.3              | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-blame`             | 0.15.0             | Christoph Rüßler <christoph.ruessler@mailbox.org>; Sebastian Thiel <sebastian.thiel@icloud.com>                                            | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-chunk`             | 0.7.3              | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-command`           | 0.9.2              | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-commitgraph`       | 0.37.1             | Conor Davis <gitoxide@conor.fastmail.fm>; Sebastian Thiel <sebastian.thiel@icloud.com>                                                     | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-config-value`      | 0.18.1             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-config`            | 0.58.0             | Edward Shen <code@eddie.sh>                                                                                                                | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-credentials`       | 0.38.2             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-date`              | 0.15.6             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-diff`              | 0.65.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-dir`               | 0.27.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-discover`          | 0.53.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-error`             | 0.2.5              | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-features`          | 0.48.1             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-filter`            | 0.32.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-fs`                | 0.21.2             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-glob`              | 0.26.1             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-hash`              | 0.25.1             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-hashtable`         | 0.15.2             | Pascal Kuthe <pascal.kuthe@semimod.de>                                                                                                     | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-ignore`            | 0.21.1             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-index`             | 0.53.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-lock`              | 23.0.1             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-mailmap`           | 0.33.2             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-negotiate`         | 0.33.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-object`            | 0.62.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-odb`               | 0.82.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-pack`              | 0.72.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-packetline`        | 0.21.5             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-path`              | 0.12.4             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-pathspec`          | 0.18.1             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-prompt`            | 0.15.1             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-protocol`          | 0.63.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-quote`             | 0.7.2              | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-ref`               | 0.65.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-refspec`           | 0.43.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-revision`          | 0.47.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-revwalk`           | 0.33.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-sec`               | 0.14.2             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-shallow`           | 0.12.1             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-status`            | 0.32.0             | Sebastian Thiel <sebastian.thiel@icloud.com>; Pascal Kuthe <pascal.kuthe@semimod.de>                                                       | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-submodule`         | 0.32.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-tempfile`          | 23.0.2             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-trace`             | 0.1.21             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-transport`         | 0.57.2             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-traverse`          | 0.59.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-url`               | 0.36.2             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-utils`             | 0.3.6              | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-validate`          | 0.11.3             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-worktree-state`    | 0.32.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-worktree-stream`   | 0.34.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-worktree`          | 0.54.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix`                   | 0.85.0             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `hash32`                | 0.3.1              | Jorge Aparicio <jorge@japaric.io>                                                                                                          | <https://github.com/japaric/hash32>                   |
| `hashbrown`             | 0.14.5             | Amanieu d'Antras <amanieu@gmail.com>                                                                                                       | <https://github.com/rust-lang/hashbrown>              |
| `hashbrown`             | 0.16.1             | Amanieu d'Antras <amanieu@gmail.com>                                                                                                       | <https://github.com/rust-lang/hashbrown>              |
| `hashbrown`             | 0.17.1             | (see repository)                                                                                                                           | <https://github.com/rust-lang/hashbrown>              |
| `heapless`              | 0.8.0              | Jorge Aparicio <jorge@japaric.io>; Per Lindgren <per.lindgren@ltu.se>; Emil Fresk <emil.fresk@gmail.com>                                   | <https://github.com/rust-embedded/heapless>           |
| `hybrid-array`          | 0.4.15             | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/hybrid-array>          |
| `indexmap`              | 2.14.0             | (see repository)                                                                                                                           | <https://github.com/indexmap-rs/indexmap>             |
| `io-close`              | 0.3.7              | wufz                                                                                                                                       | <https://gitlab.com/wufz/io-close>                    |
| `itertools`             | 0.14.0             | bluss                                                                                                                                      | <https://github.com/rust-itertools/itertools>         |
| `itertools`             | 0.15.0             | bluss                                                                                                                                      | <https://github.com/rust-itertools/itertools>         |
| `itoa`                  | 1.0.18             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/itoa>                     |
| `kstring`               | 2.0.2              | Ed Page <eopage@gmail.com>                                                                                                                 | <https://github.com/cobalt-org/kstring>               |
| `lazy_static`           | 1.5.0              | Marvin Löbel <loebel.marvin@gmail.com>                                                                                                     | <https://github.com/rust-lang-nursery/lazy-static.rs> |
| `libc`                  | 0.2.189            | (see repository)                                                                                                                           | <https://github.com/rust-lang/libc>                   |
| `lock_api`              | 0.4.14             | Amanieu d'Antras <amanieu@gmail.com>                                                                                                       | <https://github.com/Amanieu/parking_lot>              |
| `log`                   | 0.4.33             | The Rust Project Developers                                                                                                                | <https://github.com/rust-lang/log>                    |
| `logos-codegen`         | 0.15.1             | Maciej Hirsz <hello@maciej.codes>; Jérome Eertmans (maintainer) <jeertmans@icloud.com>                                                     | <https://github.com/maciejhirsz/logos>                |
| `logos-derive`          | 0.15.1             | Maciej Hirsz <hello@maciej.codes>; Jérome Eertmans (maintainer) <jeertmans@icloud.com>                                                     | <https://github.com/maciejhirsz/logos>                |
| `logos`                 | 0.15.1             | Maciej Hirsz <hello@maciej.codes>; Jérome Eertmans (maintainer) <jeertmans@icloud.com>                                                     | <https://github.com/maciejhirsz/logos>                |
| `maplit`                | 1.0.2              | bluss                                                                                                                                      | <https://github.com/bluss/maplit>                     |
| `memmap2`               | 0.9.11             | Dan Burkert <dan@danburkert.com>; Yevhenii Reizner <razrfalcon@gmail.com>; The Contributors                                                | <https://github.com/RazrFalcon/memmap2-rs>            |
| `multiversion_no_op`    | 1.0.0              | Henri Sivonen <hsivonen@hsivonen.fi>                                                                                                       | <https://github.com/hsivonen/multiversion_no_op>      |
| `num-traits`            | 0.2.19             | The Rust Project Developers                                                                                                                | <https://github.com/rust-num/num-traits>              |
| `once_cell`             | 1.21.4             | Aleksey Kladov <aleksey.kladov@gmail.com>                                                                                                  | <https://github.com/matklad/once_cell>                |
| `parking_lot_core`      | 0.9.12             | Amanieu d'Antras <amanieu@gmail.com>                                                                                                       | <https://github.com/Amanieu/parking_lot>              |
| `parking_lot`           | 0.12.5             | Amanieu d'Antras <amanieu@gmail.com>                                                                                                       | <https://github.com/Amanieu/parking_lot>              |
| `percent-encoding`      | 2.3.2              | The rust-url developers                                                                                                                    | <https://github.com/servo/rust-url/>                  |
| `pest_derive`           | 2.8.8              | Dragoș Tiselice <dragostiselice@gmail.com>                                                                                                 | <https://github.com/pest-parser/pest>                 |
| `pest_generator`        | 2.8.8              | Dragoș Tiselice <dragostiselice@gmail.com>                                                                                                 | <https://github.com/pest-parser/pest>                 |
| `pest_meta`             | 2.8.8              | Dragoș Tiselice <dragostiselice@gmail.com>                                                                                                 | <https://github.com/pest-parser/pest>                 |
| `pest`                  | 2.8.8              | Dragoș Tiselice <dragostiselice@gmail.com>                                                                                                 | <https://github.com/pest-parser/pest>                 |
| `pin-project-lite`      | 0.2.17             | (see repository)                                                                                                                           | <https://github.com/taiki-e/pin-project-lite>         |
| `pollster`              | 1.0.1              | Joshua Barretto <joshua@jsbarretto.com>                                                                                                    | <https://github.com/zesterer/pollster>                |
| `ppv-lite86`            | 0.2.21             | The CryptoCorrosion Contributors                                                                                                           | <https://github.com/cryptocorrosion/cryptocorrosion>  |
| `proc-macro2`           | 1.0.107            | David Tolnay <dtolnay@gmail.com>; Alex Crichton <alex@alexcrichton.com>                                                                    | <https://github.com/dtolnay/proc-macro2>              |
| `quote`                 | 1.0.47             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/quote>                    |
| `rand_chacha`           | 0.10.0             | The Rand Project Developers; The Rust Project Developers; The CryptoCorrosion Contributors                                                 | <https://github.com/rust-random/rand>                 |
| `rand_core`             | 0.10.1             | The Rand Project Developers                                                                                                                | <https://github.com/rust-random/rand_core>            |
| `rand`                  | 0.10.2             | The Rand Project Developers; The Rust Project Developers                                                                                   | <https://github.com/rust-random/rand>                 |
| `rayon-core`            | 1.13.0             | (see repository)                                                                                                                           | <https://github.com/rayon-rs/rayon>                   |
| `rayon`                 | 1.12.0             | (see repository)                                                                                                                           | <https://github.com/rayon-rs/rayon>                   |
| `ref-cast-impl`         | 1.0.26             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/ref-cast>                 |
| `ref-cast`              | 1.0.26             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/ref-cast>                 |
| `regex-automata`        | 0.4.18             | The Rust Project Developers; Andrew Gallant <jamslam@gmail.com>                                                                            | <https://github.com/rust-lang/regex>                  |
| `regex-syntax`          | 0.8.11             | The Rust Project Developers; Andrew Gallant <jamslam@gmail.com>                                                                            | <https://github.com/rust-lang/regex>                  |
| `regex`                 | 1.13.1             | The Rust Project Developers; Andrew Gallant <jamslam@gmail.com>                                                                            | <https://github.com/rust-lang/regex>                  |
| `rustc_version`         | 0.4.1              | (see repository)                                                                                                                           | <https://github.com/djc/rustc-version-rs>             |
| `rustversion`           | 1.0.23             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/rustversion>              |
| `scopeguard`            | 1.2.0              | bluss                                                                                                                                      | <https://github.com/bluss/scopeguard>                 |
| `semver`                | 1.0.28             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/semver>                   |
| `serde_core`            | 1.0.229            | Erick Tryzelaar <erick.tryzelaar@gmail.com>; David Tolnay <dtolnay@gmail.com>                                                              | <https://github.com/serde-rs/serde>                   |
| `serde_derive`          | 1.0.229            | Erick Tryzelaar <erick.tryzelaar@gmail.com>; David Tolnay <dtolnay@gmail.com>                                                              | <https://github.com/serde-rs/serde>                   |
| `serde_json`            | 1.0.151            | Erick Tryzelaar <erick.tryzelaar@gmail.com>; David Tolnay <dtolnay@gmail.com>                                                              | <https://github.com/serde-rs/json>                    |
| `serde_spanned`         | 1.1.1              | (see repository)                                                                                                                           | <https://github.com/toml-rs/toml>                     |
| `serde`                 | 1.0.229            | Erick Tryzelaar <erick.tryzelaar@gmail.com>; David Tolnay <dtolnay@gmail.com>                                                              | <https://github.com/serde-rs/serde>                   |
| `sha1-checked`          | 0.10.0             | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/hashes>                |
| `sha1`                  | 0.10.7             | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/hashes>                |
| `sha2`                  | 0.11.0             | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/hashes>                |
| `shell-words`           | 1.1.1              | Tomasz Miąsko <tomasz.miasko@gmail.com>                                                                                                    | <https://github.com/tmiasko/shell-words>              |
| `signal-hook-registry`  | 1.4.8              | Michal 'vorner' Vaner <vorner@vorner.cz>; Masaki Hara <ackie.h.gmai@gmail.com>                                                             | <https://github.com/vorner/signal-hook>               |
| `signal-hook`           | 0.4.4              | Michal 'vorner' Vaner <vorner@vorner.cz>; Thomas Himmelstoss <thimm@posteo.de>                                                             | <https://github.com/vorner/signal-hook>               |
| `smallvec`              | 1.15.2             | The Servo Project Developers                                                                                                               | <https://github.com/servo/rust-smallvec>              |
| `stable_deref_trait`    | 1.2.1              | Robert Grosse <n210241048576@gmail.com>                                                                                                    | <https://github.com/storyyeller/stable_deref_trait>   |
| `static_assertions`     | 1.1.0              | Nikolai Vazquez                                                                                                                            | <https://github.com/nvzqz/static-assertions-rs>       |
| `syn`                   | 2.0.119            | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/syn>                      |
| `syn`                   | 3.0.3              | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/syn>                      |
| `tempfile`              | 3.27.0             | Steven Allen <steven@stebalien.com>; The Rust Project Developers; Ashley Mannix <ashleymannix@live.com.au>; Jason White <me@jasonwhite.io> | <https://github.com/Stebalien/tempfile>               |
| `thiserror-impl`        | 2.0.20             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/thiserror>                |
| `thiserror`             | 2.0.20             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/thiserror>                |
| `toml_datetime`         | 1.1.1+spec-1.1.0   | (see repository)                                                                                                                           | <https://github.com/toml-rs/toml>                     |
| `toml_edit`             | 0.25.13+spec-1.1.0 | (see repository)                                                                                                                           | <https://github.com/toml-rs/toml>                     |
| `toml_parser`           | 1.1.3+spec-1.1.0   | (see repository)                                                                                                                           | <https://github.com/toml-rs/toml>                     |
| `toml_writer`           | 1.1.2+spec-1.1.0   | (see repository)                                                                                                                           | <https://github.com/toml-rs/toml>                     |
| `typenum`               | 1.20.1             | (see repository)                                                                                                                           | <https://github.com/paholg/typenum>                   |
| `ucd-trie`              | 0.1.7              | Andrew Gallant <jamslam@gmail.com>                                                                                                         | <https://github.com/BurntSushi/ucd-generate>          |
| `unicode-normalization` | 0.1.25             | kwantam <kwantam@gmail.com>; Manish Goregaokar <manishsmail@gmail.com>                                                                     | <https://github.com/unicode-rs/unicode-normalization> |
| `version_check`         | 0.9.5              | Sergio Benitez <sb@sergio.bz>                                                                                                              | <https://github.com/SergioBenitez/version_check>      |

### Unlicense OR MIT

| Crate                | Version | Copyright                                 | Repository                                                         |
| -------------------- | ------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `aho-corasick`       | 1.1.5   | Andrew Gallant <jamslam@gmail.com>        | <https://github.com/BurntSushi/aho-corasick>                       |
| `byteorder`          | 1.5.0   | Andrew Gallant <jamslam@gmail.com>        | <https://github.com/BurntSushi/byteorder>                          |
| `globset`            | 0.4.20  | Andrew Gallant <jamslam@gmail.com>        | <https://github.com/BurntSushi/ripgrep/tree/master/crates/globset> |
| `jiff-core`          | 0.1.1   | Andrew Gallant <jamslam@gmail.com>        | <https://github.com/BurntSushi/jiff>                               |
| `jiff-static`        | 0.2.37  | Andrew Gallant <jamslam@gmail.com>        | <https://github.com/BurntSushi/jiff>                               |
| `jiff-tzdb-platform` | 0.1.3   | Andrew Gallant <jamslam@gmail.com>        | <https://github.com/BurntSushi/jiff>                               |
| `jiff-tzdb`          | 0.1.8   | Andrew Gallant <jamslam@gmail.com>        | <https://github.com/BurntSushi/jiff>                               |
| `jiff`               | 0.2.37  | Andrew Gallant <jamslam@gmail.com>        | <https://github.com/BurntSushi/jiff>                               |
| `memchr`             | 2.8.3   | Andrew Gallant <jamslam@gmail.com>; bluss | <https://github.com/BurntSushi/memchr>                             |
| `same-file`          | 1.0.6   | Andrew Gallant <jamslam@gmail.com>        | <https://github.com/BurntSushi/same-file>                          |
| `walkdir`            | 2.5.0   | Andrew Gallant <jamslam@gmail.com>        | <https://github.com/BurntSushi/walkdir>                            |

### MIT

| Crate                | Version | Copyright                                                                                               | Repository                                       |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `bytes`              | 1.12.1  | Carl Lerche <me@carllerche.com>; Sean McArthur <sean@seanmonstar.com>                                   | <https://github.com/tokio-rs/bytes>              |
| `clru`               | 0.6.3   | marmeladema <xademax@gmail.com>                                                                         | <https://github.com/marmeladema/clru-rs>         |
| `dashmap`            | 6.2.1   | Acrimon <joel.wejdenstal@gmail.com>                                                                     | <https://github.com/xacrimon/dashmap>            |
| `faster-hex`         | 0.10.0  | zhangsoledad <787953403@qq.com>                                                                         | <https://github.com/NervosFoundation/faster-hex> |
| `generic-array`      | 0.14.7  | Bartłomiej Kamiński <fizyk20@gmail.com>; Aaron Trent <novacrazy@gmail.com>                              | <https://github.com/fizyk20/generic-array.git>   |
| `human_format`       | 1.2.1   | Bob Chatman <bob.chatman@gmail.com>                                                                     | <https://github.com/BobGneu/human-format-rs>     |
| `interim`            | 0.2.1   | Conrad Ludgate <conradludgate@gmail.com                                                                 | <https://github.com/conradludgate/interim>       |
| `maybe-async`        | 0.2.11  | Guoli Lyu <guoli-lv@hotmail.com>                                                                        | <https://github.com/fMeow/maybe-async-rs>        |
| `nonempty`           | 0.12.0  | Alexis Sellier <self@cloudhead.io>                                                                      | <https://github.com/cloudhead/nonempty>          |
| `prodash`            | 31.0.0  | Sebastian Thiel <sebastian.thiel@icloud.com>                                                            | <https://github.com/GitoxideLabs/prodash>        |
| `slab`               | 0.4.12  | Carl Lerche <me@carllerche.com>                                                                         | <https://github.com/tokio-rs/slab>               |
| `strsim`             | 0.11.1  | Danny Guo <danny@dannyguo.com>; maxbachmann <oss@maxbachmann.de>                                        | <https://github.com/rapidfuzz/strsim-rs>         |
| `tracing-attributes` | 0.1.31  | Tokio Contributors <team@tokio.rs>; Eliza Weisman <eliza@buoyant.io>; David Barsky <dbarsky@amazon.com> | <https://github.com/tokio-rs/tracing>            |
| `tracing-core`       | 0.1.36  | Tokio Contributors <team@tokio.rs>                                                                      | <https://github.com/tokio-rs/tracing>            |
| `tracing`            | 0.1.44  | Eliza Weisman <eliza@buoyant.io>; Tokio Contributors <team@tokio.rs>                                    | <https://github.com/tokio-rs/tracing>            |
| `winnow`             | 1.0.4   | (see repository)                                                                                        | <https://github.com/winnow-rs/winnow>            |
| `zmij`               | 1.0.23  | David Tolnay <dtolnay@gmail.com>                                                                        | <https://github.com/dtolnay/zmij>                |

### BSD-3-Clause

| Crate    | Version | Copyright                                                                                | Repository                                     |
| -------- | ------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `subtle` | 2.6.1   | Isis Lovecruft <isis@patternsinthevoid.net>; Henry de Valence <hdevalence@hdevalence.ca> | <https://github.com/dalek-cryptography/subtle> |

### Zlib

| Crate      | Version | Copyright                            | Repository                                          |
| ---------- | ------- | ------------------------------------ | --------------------------------------------------- |
| `foldhash` | 0.2.0   | Orson Peters <orsonpeters@gmail.com> | <https://github.com/orlp/foldhash>                  |
| `zlib-rs`  | 0.6.8   | (see repository)                     | <https://github.com/trifectatechfoundation/zlib-rs> |

### MPL-2.0

The crate below is licensed under the Mozilla Public License 2.0. Its
source is linked in the inventory; the license text is available at
<https://www.mozilla.org/en-US/MPL/2.0/>.

| Crate   | Version | Copyright                                                        | Repository                       |
| ------- | ------- | ---------------------------------------------------------------- | -------------------------------- |
| `uluru` | 3.1.0   | The Servo Project Developers; Matt Brubeck <mbrubeck@limpet.net> | <https://github.com/servo/uluru> |

### Combined or multi-option licenses

These crates offer more than two alternatives, or combine license terms.
The SPDX expression for each crate remains in its own source metadata;
`encoding_rs` also carries BSD-3-Clause terms.

| Crate             | Version | Copyright                                                                | Repository                                   |
| ----------------- | ------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| `dunce`           | 1.0.5   | Kornel <kornel@geekhood.net>                                             | <https://gitlab.com/kornelski/dunce>         |
| `encoding_rs`     | 0.8.41  | Henri Sivonen <hsivonen@hsivonen.fi>                                     | <https://github.com/hsivonen/encoding_rs>    |
| `rustix`          | 1.1.4   | Dan Gohman <dev@sunfishcode.online>; Jakub Konka <kubkon@jakubkonka.com> | <https://github.com/bytecodealliance/rustix> |
| `tinyvec`         | 1.13.3  | Lokathor <zefria@gmail.com>                                              | <https://github.com/Lokathor/tinyvec>        |
| `unicode-ident`   | 1.0.24  | David Tolnay <dtolnay@gmail.com>                                         | <https://github.com/dtolnay/unicode-ident>   |
| `zerocopy-derive` | 0.8.56  | (see repository)                                                         | <https://github.com/google/zerocopy>         |
| `zerocopy`        | 0.8.56  | (see repository)                                                         | <https://github.com/google/zerocopy>         |

- `unicode-ident` is additionally licensed under Unicode-3.0
  (<https://spdx.org/licenses/Unicode-3.0.html>) for its Unicode
  character-database tables.
- `rustix` offers `Apache-2.0 WITH LLVM-exception` as one of its options,
  in addition to plain `Apache-2.0` and `MIT`.
