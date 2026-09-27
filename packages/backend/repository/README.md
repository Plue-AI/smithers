# Repository engine

`repository.OpenLocal` embeds the same repository server used by
`repository.NewService`. The local client calls its handler in process and
stores repositories under `Config.StoragePath`. The self-hosted app injects
`Local.Client()` into its existing repository services and keeps its public Git
routes behind the app's authorization. It does not need a repo-host listener or
storage-set lookup. Plue can use `NewRemoteClient` and host `NewService` behind
its own routing and isolation.

The Go service loads `libsmithers_ffi` at `Config.FFILibraryPath`. Build that
library from this repository with the Rust toolchain `rust-toolchain.toml`
pins, then build the Go app. Both Rust crates build with that toolchain and
the same jj-lib revision from the root Cargo workspace.

```sh
cargo build -p smithers-ffi --lib
SMITHERS_FFI_LIBRARY_PATH="$PWD/target/debug/libsmithers_ffi.dylib" \
  go test ./packages/backend/repository ./packages/backend/internal/repohostserver
```

On Linux, use `libsmithers_ffi.so` and a glibc image. The integration suite
creates real repositories and runs Git clone/push, jj diff, expected-head
landing, replay, and fresh-clone checks in both local and hosted modes.

## Per-user refs

`smithers repo push` writes `refs/smithers/users/<user id>/<name>`; only that
user may write there. The engine bounds them on every push that writes one:

| Bound | Default | repo-host variable (`Config` field) |
| --- | --- | --- |
| Refs per user per repository | 20 | `SMITHERS_USER_REF_LIMIT` (`UserRefLimit`) |
| Pack size of such a push | 256 MiB | `SMITHERS_USER_REF_MAX_PUSH_BYTES` (`UserRefMaxPushBytes`) |
| Expiry after the ref's last push | 30 days | `SMITHERS_USER_REF_TTL`, e.g. `720h` (`UserRefTTL`) |

Push times live in the git directory's `smithers-user-refs.json`. An expired
ref is deleted by the next push that writes a user ref, by an hourly sweep,
or when listed or retained; until then git still advertises it, and its
owner's push or renewal revives it. `smithers repo push` renews the
expiry (also for an unchanged commit) and prints `expires_at`;
`smithers repo push --list` shows every ref of yours with its expiry. A fork
does not copy them. A coding run started from one pins its commit under the
workspace's own `refs/smithers/workspaces/<id>/sources/<commit>`, which the
ref's expiry does not remove. Anyone who can read the repository can fetch
these refs.
