/**
 * Defines the command transport an AWS session reaches its task through.
 *
 * @since 0.1.0
 */

import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

/**
 * The AWS CLI and its Session Manager plugin, over an injected spawner.
 *
 * ECS Exec is two halves. `ExecuteCommand` on the ECS API opens an SSM session
 * and returns its metadata, and that is all `@aws-sdk/client-ecs` implements.
 * The data channel that carries the command's output and exit status is the
 * Session Manager protocol, which the AWS CLI speaks by delegating to
 * `session-manager-plugin`. A session therefore runs commands the way an
 * operator does at a terminal: `aws ecs execute-command --interactive`, driven
 * through the spawner a host injects, so the package still owns no host access
 * and no dependency.
 *
 * Two consequences of that transport are visible to callers and stated here
 * rather than hidden. The session is a pseudo-terminal, so a command's
 * standard error arrives interleaved on standard output and line endings are
 * normalized; file transfer is byte-exact when the streaming adapter is
 * supplied, because it travels as base64. And the plugin exits zero whatever the remote command did, so the
 * provider wraps every command to print its own exit status and reads that
 * back; a session that ends without it is reported as `aborted`, never as
 * success.
 *
 * What this repository can and cannot prove about it: the framing, the
 * sentinel, the byte paths, and the signal walk are exercised against a fake
 * that reproduces the plugin's banner, footer, carriage returns, and zero exit
 * over a real shell. That the ECS agent hands `--command` to the container's
 * `sh` (which is why the provider sends `sh -c '...'`) is taken from the
 * service's documented behavior, not from a live cluster run here. Sensitive input requires the
 * separate streaming adapter below; it never rides inside `--command`.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExecTransport {
  /** The spawner the AWS CLI runs through. */
  readonly spawner: ChildProcessSpawner["Service"]
  /**
   * Optional data-channel adapter for commands with input. Receives the same
   * AWS CLI command descriptor as `spawner`, with `options.stdin` carrying
   * sensitive bytes. It must deliver that stream byte-exactly to guest stdin,
   * close guest stdin at EOF, and never echo it or put it in process argv.
   * Output follows the same framing contract as the CLI spawner.
   *
   * A plain AWS CLI spawner is not sufficient: its PTY does not provide this
   * contract. Without this adapter, file writes and spawns with stdin or a
   * nonempty environment fail with ProviderError code `unavailable`.
   */
  readonly streamingSpawner?: ChildProcessSpawner["Service"] | undefined
  /** The CLI. Default `aws`. */
  readonly program?: string | undefined
  /** Global CLI arguments placed before the subcommand, such as `--profile`. */
  readonly globalArgs?: ReadonlyArray<string> | undefined
  /**
   * The largest slice sent through streaming stdin, before base64 encoding.
   * Default 3072; acquisition requires a whole number from 1 through 65536.
   * Each slice costs one remote session. This bounds buffering per transfer.
   */
  readonly chunkBytes?: number | undefined
}
