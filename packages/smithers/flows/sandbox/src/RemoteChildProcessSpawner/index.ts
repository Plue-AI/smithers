/**
 * Remote implementation of Effect's `ChildProcessSpawner` service.
 *
 * A remote session — a micro-VM, a container, a cloud runner — cannot be forked
 * into from this process. What it can do is run a command line for us and hand
 * back the three pieces a child process has: `stdout`, `stderr`, `exitCode`.
 * Provider packages adapt their SDK session to the `Provider` contract; this
 * module adapts that contract into a `ChildProcessSpawner` layer so
 * `ChildProcess` commands work against a remote session the way they do under
 * `NodeChildProcessSpawner`. Opening a provider is scoped, so interruption
 * closes the layer scope and runs the provider's cancellation finalizer — no
 * `AbortSignal` crosses this seam.
 *
 * **The divergences are real and are not hidden.** A remote session is reached
 * by sending it one rendered command line, so there is no local process to hold
 * onto:
 *
 * - **Stdin is a blob, not a pipe.** A provider that declares `stdin: true`
 *   receives a command's standard input collected whole (bounded at 16 MiB)
 *   in `RemoteOptions.stdin`; for any other provider the command is rejected
 *   at spawn time rather than losing its input silently. The handle's own
 *   `stdin` sink always fails: there is no interactive channel either way.
 *   `stdin: "inherit"` is rejected for the same reason a stream is: a local
 *   spawner would hand the child this process's own standard input, and a
 *   remote command reading EOF instead is a silent divergence. `"pipe"`,
 *   `"ignore"`, and `"overlapped"` are accepted, and all three mean the
 *   command reads no input.
 * - **Signals are optional, not impossible.** A remote process ends by closing
 *   its scope, which runs the provider's cancellation finalizer. A provider
 *   that declares `kill` receives `ChildProcessHandle.kill` calls and a signal
 *   for a still-running command whose scope closes; a provider that does not
 *   refuses `kill` with a `BadArgument` rather than pretending to have
 *   delivered a signal.
 * - **No process identity.** `pid` is a synthetic id allocated per spawner
 *   layer, not a pid on either side of the seam, and `unref` is a no-op: this
 *   process holds no reference to a remote one. `isRunning` answers from what
 *   this side has observed, not from the remote process table: the adapter
 *   forks a scoped observer of the provider's exit at spawn and memoizes it,
 *   so liveness turns `false` when that observation lands, which can lag the
 *   remote process by a scheduler tick and never depends on a caller reading
 *   `exitCode` (`RemoteChildProcessSpawner.test.ts` pins this).
 * - **No pipeline routing between processes.** A `PipedCommand` is rendered
 *   into the single command line the remote side parses, so the `|` reaches the
 *   remote shell rather than this adapter. A non-default `from` or `to` cannot
 *   survive that rendering and is rejected.
 * - **No extra file descriptors.** `getInputFd` returns `Sink.drain` and
 *   `getOutputFd` returns `Stream.empty` — the same answer
 *   `NodeChildProcessSpawner` gives for a descriptor that was never configured.
 *   A command that explicitly configures one is rejected at spawn time.
 * - **No custom shell or detached process.** `shell: true` means whatever shell
 *   the remote session runs the rendered line with, but a shell path and
 *   `detached: true` are the local host's vocabulary and are rejected.
 * - **`extendEnv` is ignored.** The ambient environment belongs to the remote
 *   session and this side cannot read it, so only the `env` overrides cross the
 *   seam; `extendEnv: false` cannot clear an environment we never held.
 *
 * The `stdout`/`stderr` handling means what it means under
 * `NodeChildProcessSpawner` — `"inherit"` and `"ignore"` yield an empty stream,
 * and a `Sink` is transduced through.
 *
 * @since 0.1.0
 */

export * from "./layer.ts"
export * from "./Provider.ts"
export * from "./ProviderError.ts"
export * from "./TestRemote.ts"
export * from "./TestRemoteProvider.ts"
export * from "./TestRemoteState.ts"
export * from "./TestScript.ts"
