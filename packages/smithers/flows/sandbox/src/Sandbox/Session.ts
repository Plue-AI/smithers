/**
 * Defines the provisioned-machine session contract.
 *
 * @since 0.1.0
 */

import type * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type { Scope } from "effect/Scope"
import type { Signal } from "effect/unstable/process/ChildProcess"
import type { RemoteOptions, RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"

/**
 * One provisioned machine, held for the scope that acquired it.
 *
 * A session is what `RemoteChildProcessSpawner.Provider` is not: a machine
 * with a filesystem. The spawner-level provider carries commands to a remote
 * side and nothing else, which is the right contract for a transport but not
 * enough to *place* work — a body that edits a file and then compiles it needs
 * the file operations and the processes to see the same tree. A session
 * therefore adds byte-typed file transfer to the same spawn the narrower
 * contract has, and every richer surface (an Effect `FileSystem`, a host
 * bundle, workspace seeding) is derived from these operations rather than
 * asked of the adapter.
 *
 * The contract's obligations, which `SandboxConformance` states as behavior:
 *
 * - `spawn` without a `cwd` runs in {@link Session.workdir}, and a relative
 *   `cwd` is taken under it, never under whatever directory the transport
 *   happens to start in.
 * - `spawn` refuses an `options.env` name that is not a shell identifier,
 *   rather than delivering a variable the command will not see. The command
 *   is arbitrary shell text, so a shell always runs it, and a shell rebuilds
 *   its environment from the names matching `[A-Za-z_][A-Za-z0-9_]*` when it
 *   starts. Dash, `/bin/sh` on Debian and Ubuntu, drops `a-b`; bash,
 *   `/bin/sh` on macOS, keeps it. Delivery is therefore not portable and the
 *   loss is invisible to the host, so the seam fails closed on every
 *   provider and every platform instead of losing the variable in the guest.
 * - `spawn` delivers `options.stdin` as the command's complete standard
 *   input. A transport with no input channel of its own writes the bytes to a
 *   file in the workspace and redirects the command from it; either way the
 *   command reads what the caller sent.
 * - `writeFile` creates missing parent directories.
 * - `readFile` of an absent path fails with code `not_found`, so a caller can
 *   tell "nothing there" from "session broken".
 * - File contents are bytes and survive a round-trip unchanged. An adapter
 *   whose SDK speaks text encodes; the seam does not.
 * - A declared `kill` ends the command and everything it started, not only
 *   the shell that wrapped it.
 *
 * `kill` and `ping` mean what they mean on the spawner-level provider, and are
 * optional for the same reason. `files` is an adapter's escape hatch: any
 * Effect `FileSystem` operation it can serve natively (a local directory
 * serving real `stat`, an SDK with its own listing call) overrides the
 * portable probe `fileSystem` would otherwise derive from `spawn`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Session {
  /** The provider-neutral session key this machine was acquired under. */
  readonly id: string
  /** The vendor's own identifier, for diagnostics and result filing. */
  readonly remoteId: string
  /** The absolute guest path work happens under; `spawn`'s default `cwd`. */
  readonly workdir: string
  /** Starts one command on the machine; its scope is the process's lifetime. */
  readonly spawn: (
    command: string,
    options: RemoteOptions
  ) => Effect.Effect<RemoteProcess, ProviderError, Scope>
  /** The complete contents at an absolute guest path; `not_found` when absent. */
  readonly readFile: (path: string) => Effect.Effect<Uint8Array, ProviderError>
  /** Writes the complete contents at an absolute guest path, creating parents. */
  readonly writeFile: (path: string, content: Uint8Array) => Effect.Effect<void, ProviderError>
  /** Sends one signal to a process this session started. */
  readonly kill?: ((process: RemoteProcess, signal: Signal) => Effect.Effect<void, ProviderError>) | undefined
  /** A cheap round-trip proving the machine is still alive. */
  readonly ping?: Effect.Effect<void, ProviderError> | undefined
  /** Native overrides for operations `fileSystem` would otherwise probe. */
  readonly files?: Partial<FileSystem.FileSystem> | undefined
}
