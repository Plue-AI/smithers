/**
 * The structural slice of the Microsandbox SDK used by this provider.
 *
 * The SDK is injected by callers so this package remains browser-bundleable
 * and owns no vendor dependency. The private shapes below mirror the vendor's
 * fluent builders, streaming command handle, lifecycle handles, label-scoped
 * listing, default-backend selection, and guest filesystem operations.
 *
 * @since 0.1.0
 */

interface GuestFs {
  write(path: string, data: Uint8Array | string): Promise<void>
  read(path: string): Promise<Uint8Array>
  readToString(path: string): Promise<string>
  mkdir(path: string): Promise<void>
}

/** One event of a streamed command, in the order the guest produced it. */
type ExecEvent =
  | { readonly kind: "started"; readonly pid: number }
  | { readonly kind: "stdout"; readonly data: Uint8Array }
  | { readonly kind: "stderr"; readonly data: Uint8Array }
  | { readonly kind: "exited"; readonly code: number }

interface ExecHandle {
  /**
   * The next event, or `null` once the command's stream has ended. The vendor
   * answers `undefined` for a guest event it does not normalise; the one the
   * guest agent sends today is its report that the command could not be
   * started at all, such as a missing program or working directory.
   */
  recv(): Promise<ExecEvent | null | undefined>
  /** Delivers a Linux signal number to the command's process group. */
  signal(signal: number): Promise<void>
  kill(): Promise<void>
}

interface ExecBuilder {
  args(args: Array<string>): this
  cwd(cwd: string): this
  envs(vars: Record<string, string>): this
  stdinBytes(data: Uint8Array): this
}

interface DestroyOptions {
  /** How long the stop and removal may take to converge. */
  readonly timeoutMs: number
  /** Stop the machine without the graceful shutdown first. */
  readonly force?: boolean
}

interface Sandbox {
  readonly name: string
  readonly backendKind: "local" | "cloud"
  fs(): GuestFs
  execStreamWith(command: string, configure: (builder: ExecBuilder) => ExecBuilder): Promise<ExecHandle>
  destroy(options: DestroyOptions): Promise<void>
}

interface SandboxHandle {
  readonly name: string
  readonly status: string
  /** Stops the machine gracefully, keeping its disk. */
  stop(): Promise<void>
  /** Captures a stopped machine's disk as a named snapshot. */
  snapshot(name: string): Promise<unknown>
  /** The persisted configuration as JSON, labels included. */
  readonly configJson: string
  connect(): Promise<Sandbox>
  start(): Promise<Sandbox>
  startDetached(): Promise<Sandbox>
  refresh(): Promise<SandboxHandle>
  modify(options: {
    readonly labels: Record<string, string>
    readonly policy: "next_start"
  }): Promise<{ readonly applied: boolean }>
  destroy(options: DestroyOptions): Promise<void>
}

interface SandboxList {
  label(key: string, value: string): this
  cursor(cursor: string): this
}

interface SandboxPage {
  readonly sandboxes: ReadonlyArray<SandboxHandle>
  readonly nextCursor?: string | undefined
}

/**
 * One ordered egress or ingress rule of a guest network policy, in the
 * vendor's own shape.
 */
interface NetworkRule {
  readonly direction: "egress" | "ingress" | "any"
  readonly destination:
    | { readonly kind: "any" }
    | { readonly kind: "cidr"; readonly cidr: string }
    | { readonly kind: "domain"; readonly domain: string }
    | { readonly kind: "domainSuffix"; readonly suffix: string }
    | { readonly kind: "group"; readonly group: string }
  readonly protocols: ReadonlyArray<"tcp" | "udp" | "icmpv4" | "icmpv6">
  readonly ports: ReadonlyArray<{ readonly start: number; readonly end: number }>
  readonly action: "allow" | "deny"
}

/**
 * A guest network policy: per-direction defaults and ordered first-match
 * rules, as the vendor evaluates them.
 *
 * @category models
 * @since 1.0.0
 */
export interface NetworkPolicy {
  readonly defaultEgress: "allow" | "deny"
  readonly defaultIngress: "allow" | "deny"
  readonly rules: ReadonlyArray<NetworkRule>
}

interface NetworkBuilder {
  policy(policy: NetworkPolicy): this
}

interface SnapshotEntry {
  readonly name: string | null
  readonly createdAt: Date
}

interface SandboxBuilder {
  image(image: string): this
  fromSnapshot(pathOrName: string): this
  rootDisk(sizeMib: number): this
  network(configure: (builder: NetworkBuilder) => NetworkBuilder): this
  cpus(count: number): this
  maxCpus(count: number): this
  memory(mib: number): this
  maxMemory(mib: number): this
  security(profile: "default" | "restricted"): this
  pullPolicy(policy: string): this
  labels(labels: Record<string, string>): this
  maxDuration(seconds: number): this
  idleTimeout(seconds: number): this
  ephemeral(enabled: boolean): this
  detached(enabled: boolean): this
  disableNetwork(): this
  create(): Promise<Sandbox>
}

/**
 * The Microsandbox SDK entry point required by the provider.
 *
 * `defaultBackendKind` is what the provider reads before it provisions, so it
 * can refuse to run anywhere but this machine; `setDefaultBackend` is the
 * vendor's own pin, and a composition that must never leave this machine calls
 * `sdk.setDefaultBackend("local")` once at startup, which overrides the
 * `MSB_BACKEND`, `MSB_API_KEY`, and `MSB_PROFILE` environment selection.
 *
 * @category models
 * @since 0.1.0
 */
export interface Sdk {
  readonly Sandbox: {
    builder(name: string): SandboxBuilder
    get(name: string): Promise<SandboxHandle>
    listWith(configure: (list: SandboxList) => SandboxList): Promise<SandboxPage>
  }
  readonly Snapshot: {
    /** The indexed snapshot of that name; rejects when there is none. */
    get(name: string): Promise<SnapshotEntry>
    list(): Promise<ReadonlyArray<SnapshotEntry>>
    remove(name: string, options?: { readonly force?: boolean }): Promise<void>
  }
  defaultBackendKind(): "local" | "cloud"
  setDefaultBackend(backend: "local"): void
}
