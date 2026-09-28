/**
 * Defines the injected Daytona SDK slice.
 *
 * @since 0.1.0
 */

interface ExecuteResponse {
  readonly exitCode: number
  /**
   * The command's output as one string. The wire response carries no
   * separate stderr field, and the execution endpoint merges standard error
   * into this text, so it is the command's combined output rather than pure
   * stdout. (The SDK also mirrors it at `artifacts.stdout`, which this
   * provider does not read.)
   */
  readonly result: string
}

interface FileSystem {
  downloadFile(remotePath: string): Promise<Uint8Array>
  uploadFileStream(source: Uint8Array, remotePath: string): Promise<void>
}

interface Process {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>
  ): Promise<ExecuteResponse>
}

/**
 * Outbound network settings. The runner enforces them as iptables rules on
 * the sandbox container: `networkBlockAll` denies all egress, and
 * `domainAllowList` is a comma-separated list of domains, `*.` wildcards
 * included, that egress is limited to.
 */
interface NetworkSettings {
  readonly networkBlockAll?: boolean | undefined
  readonly domainAllowList?: string | undefined
}

interface SandboxInstance {
  readonly id: string
  readonly name: string
  readonly fs: FileSystem
  readonly process: Process
  /** When the sandbox was created, as an ISO 8601 timestamp. */
  readonly createdAt?: string | undefined
  /** When the sandbox's TTL destroys it, as an ISO 8601 timestamp; absent without a TTL. */
  readonly autoDestroyAt?: string | undefined
  getWorkDir(): Promise<string | undefined>
  updateNetworkSettings(settings: NetworkSettings): Promise<void>
  /** Re-anchors the TTL to this many minutes from now; `0` disables it. */
  setTtl(ttlMinutes: number): Promise<void>
}

interface CreateInput extends NetworkSettings {
  readonly name?: string | undefined
  /** Wall-clock lifetime since creation, in minutes; the sandbox is destroyed when it elapses. */
  readonly ttlMinutes?: number | undefined
}

/**
 * The portion of a configured Daytona client used by this provider.
 *
 * A caller passes an instance created with `new Daytona(...)`. Keeping only
 * this structural slice avoids importing the vendor package or its Node-only
 * transitive dependencies into `@smthrs/sandbox`. The shapes mirror the
 * published `@daytonaio/sdk` 0.207.0 typings: `get`/`create`/`start`/`delete`
 * on the client, `createdAt`, `autoDestroyAt`, `getWorkDir`, `updateNetworkSettings`,
 * and `setTtl` on the sandbox,
 * `networkBlockAll`/`domainAllowList`/`ttlMinutes` on create, `process.executeCommand`
 * returning `{ exitCode, result }`, and `fs.downloadFile` (a `Buffer` is a
 * `Uint8Array`) / `fs.uploadFileStream` (whose `UploadSource` accepts a
 * `Uint8Array`) for file transfer.
 *
 * @category models
 * @since 0.1.0
 */
export interface Sdk {
  get(sandboxIdOrName: string): Promise<SandboxInstance>
  create(params?: CreateInput): Promise<SandboxInstance>
  start(sandbox: SandboxInstance, timeout?: number): Promise<void>
  delete(sandbox: SandboxInstance, timeout?: number, wait?: boolean): Promise<void>
}
