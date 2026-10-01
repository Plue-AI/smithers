/**
 * Local microVM placement for `issue-sweep/work`: one Microsandbox microVM per
 * issue on this Mac, booted from a prepared Smithers snapshot.
 *
 `work/flow.ts` passes `provider()` to `Sandbox.run` with the session
 * `issue-sweep:<repo>#<issue>`, exactly where a Cloud run passes CloudSandbox;
 * the session's work comes back as a diff that `SandboxMerge.apply` lands.
 *
 * The guest contract is the Cloud one: a jj-colocated checkout of
 * smithersai/smithers at `guestCheckout` (`/home/developer/workspace`), HOME
 * `/home/developer`, `git`, `jj`, Node 26, pnpm, `gh`, `codex`, `claude`, and the
 * Go and Rust toolchains the checkout pins on PATH, dependencies installed. At
 * acquire the checkout moves to a fresh `main` (`refresh`). Closing the scope
 * removes the microVM, on success, failure and interruption; `reapOrphans` removes the microVMs of a host
 * process that died without closing its scopes. `provider()` is one
 * process-wide instance whose `maxVms` gate (default 32) queues acquires beyond
 * the host's measured capacity.
 *
 * Capabilities: the Microsandbox SDK is a native module running in the flow
 * host process, so booting and driving a microVM spawns nothing through the
 * flow's confined spawner and needs no `proc:spawn` or `fs:read` grant. Guest
 * commands run through the session's spawner, not the host's. Building the
 * snapshot (`buildImage`) needs the guest network, never a host grant.
 *
 * Build the snapshot once per Smithers main (about two minutes):
 *   node flows/issue-sweep/test/vm-image.ts
 */
import { MicrosandboxSandbox, RemoteChildProcessSpawner, type Sandbox } from "@smthrs/sandbox"
import { type Duration, Effect, Semaphore, Stream } from "effect"
import * as Microsandbox from "microsandbox"
import { existsSync, readdirSync, statfsSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Every microVM runs at a lower CPU priority than this host: under 32 busy
 * guests a host that misses its 19 s run-lease heartbeat parks the whole sweep
 * (#3328). The SDK runs whatever binary `MSB_PATH` names, so it names
 * `msb-nice.sh`, which execs the bundled `msb` under `nice`. An operator's own
 * `MSB_PATH` is left alone.
 */
export const niceWrapper = fileURLToPath(new URL("./msb-nice.sh", import.meta.url))
if (process.env.MSB_PATH === undefined) {
  // The SDK's platform package sits beside it, as Node resolution finds it.
  const sdk = fileURLToPath(new URL("..", import.meta.resolve("microsandbox")))
  const platform = join(dirname(sdk), "@superradcompany", `microsandbox-${process.platform}-${process.arch}`)
  const bundled = join(platform, "bin", "msb")
  if (!existsSync(bundled)) throw new Error(`issue-sweep vm: no bundled msb at ${bundled}`)
  // msb looks for libkrunfw beside the binary MSB_PATH names, which is now the wrapper.
  const krunfw = readdirSync(join(platform, "lib")).find((name) => name.startsWith("libkrunfw."))
  if (krunfw === undefined) throw new Error(`issue-sweep vm: no libkrunfw in ${platform}/lib`)
  process.env.ISSUE_SWEEP_MSB = bundled
  process.env.MSB_LIBKRUNFW_PATH ??= join(platform, "lib", krunfw)
  process.env.MSB_PATH = niceWrapper
}

/** The guest checkout the work flow edits, the same path CloudSandbox uses. */
export const guestCheckout = "/home/developer/workspace"
/** The guest HOME, where a borrowed login goes. */
export const guestHome = "/home/developer"
/** The snapshot family every prepared Smithers image belongs to. */
export const imageFamily = "issue-sweep"
/** The image the snapshot is built from: Debian trixie (git 2.47, which jj 0.39 needs) with Node 26. */
export const baseImage = "node:26-trixie"
/** The label every issue-sweep machine records, so `reapOrphans` sweeps only these. */
export const owner = "issue-sweep"

/**
 * Hosts an agent microVM may reach: GitHub (fetch main, gh), the npm registry
 * (lockfile changes), and the OpenAI and Anthropic model and login endpoints.
 */
export const agentHosts: ReadonlyArray<string> = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "chatgpt.com",
  "*.chatgpt.com",
  "*.openai.com",
  "*.anthropic.com",
  "claude.ai",
  // Go modules and crates an agent's change adds beyond the prefetched ones.
  "proxy.golang.org",
  "sum.golang.org",
  "index.crates.io",
  "static.crates.io"
]

/**
 * Toolchain state an agent writes lives inside the checkout, under paths the
 * repository ignores (rustup's proxies too: rustup refuses a CARGO_HOME it is
 * not installed in): Codex's workspace-write sandbox writes only there and in
 * /tmp, and the snapshot carries the prefetched modules and warm caches.
 * `.backend-go-modcache` is the module cache the backend test target reads.
 */
export const toolchainEnv: Readonly<Record<string, string>> = {
  GOTOOLCHAIN: "local",
  GOMODCACHE: `${guestCheckout}/.backend-go-modcache`,
  GOCACHE: `${guestCheckout}/.cache/go-build`,
  // The guest /tmp is too small for linking backend test binaries.
  GOTMPDIR: `${guestCheckout}/.cache/go-tmp`,
  RUSTUP_HOME: "/usr/local/rustup",
  CARGO_HOME: `${guestCheckout}/.cache/cargo`,
  // Browsers are only read at test time, so they live outside the checkout.
  PLAYWRIGHT_BROWSERS_PATH: "/usr/local/ms-playwright"
}

/** The guest PATH: the Go and Rust toolchains before the system directories. */
export const guestPath =
  `/usr/local/go/bin:${guestCheckout}/.cache/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`

// Prints the SHA-256 go.dev publishes for the file named by argv[1] (go.dev's release JSON on stdin).
const goChecksum = "let s=\"\";process.stdin.on(\"data\",(d)=>s+=d).on(\"end\",()=>{" +
  "const f=JSON.parse(s).flatMap((r)=>r.files).find((f)=>f.filename===process.argv[1]);" +
  "if(!f)process.exit(1);console.log(f.sha256)})"

/**
 * The shell commands that turn `baseImage` into the Smithers image. Go is the
 * release go.mod names (its `toolchain` line, else its `go` line), checked
 * against go.dev's published SHA-256; Rust is the channel rust-toolchain.toml
 * pins, installed by a checksum-verified rustup. Modules and crates are
 * prefetched and the backend packages compiled, so an agent's first `go test`
 * or `cargo test` downloads nothing. Playwright's Chromium, with its system
 * libraries, is the version apps/app pins.
 */
export const provisionScript = (revision: string): string =>
  `set -eux
mkdir -p ${guestHome}/.config/jj
printf '[user]\\nname = "issue-sweep agent"\\nemail = "issue-sweep@smithers.invalid"\\n' > ${guestHome}/.config/jj/config.toml
curl -fsSL https://github.com/jj-vcs/jj/releases/download/v0.39.0/jj-v0.39.0-aarch64-unknown-linux-musl.tar.gz | tar -xz -C /usr/local/bin ./jj
curl -fsSL https://github.com/cli/cli/releases/download/v2.83.0/gh_2.83.0_linux_arm64.tar.gz | tar -xz -C /tmp
install -m755 /tmp/gh_2.83.0_linux_arm64/bin/gh /usr/local/bin/gh
npm install -g pnpm@11.25.0 bun@1.4.1 @openai/codex @anthropic-ai/claude-code
npm cache clean --force
rm -rf ${guestCheckout}
git clone -q https://github.com/smithersai/smithers.git ${guestCheckout}
cd ${guestCheckout}
git checkout -q ${revision}
${Object.entries(toolchainEnv).map(([name, value]) => `export ${name}=${value}`).join("\n")}
export PATH=${guestPath}
go_version=$(sed -n 's/^toolchain go//p' go.mod)
[ -n "$go_version" ] || go_version=$(sed -n 's/^go //p' go.mod)
go_file=go$go_version.linux-arm64.tar.gz
go_sha=$(curl -fsSL 'https://go.dev/dl/?mode=json&include=all' | node -e '${goChecksum}' "$go_file")
curl -fsSL -o /tmp/go.tar.gz "https://go.dev/dl/$go_file"
echo "$go_sha  /tmp/go.tar.gz" | sha256sum -c -
tar -xzf /tmp/go.tar.gz -C /usr/local
rustup_init=https://static.rust-lang.org/rustup/dist/aarch64-unknown-linux-gnu/rustup-init
curl -fsSL -o /tmp/rustup-init "$rustup_init"
echo "$(curl -fsSL "$rustup_init.sha256" | cut -d' ' -f1)  /tmp/rustup-init" | sha256sum -c -
chmod +x /tmp/rustup-init
/tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain none
rustup toolchain install
jj git init --colocate
CI=1 pnpm install --frozen-lockfile
mkdir -p "$GOTMPDIR"
go mod download
go build ./packages/backend/...
cargo fetch --locked
pnpm --filter ./apps/app exec playwright install --with-deps chromium
go version
cargo --version
jj st >/dev/null
rm -rf /tmp/* /root/.npm
# The capture stops the machine; unflushed pages would be captured as empty files.
sync
`

/** A guest command's whole output and exit status. */
export interface Ran {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

/** Runs one shell line in a session and collects its output. */
export const sh = (
  session: Pick<Sandbox.Session, "spawn">,
  line: string,
  options: RemoteChildProcessSpawner.RemoteOptions = {}
): Effect.Effect<Ran, RemoteChildProcessSpawner.ProviderError> =>
  Effect.scoped(Effect.gen(function*() {
    const process = yield* session.spawn(line, options)
    const [stdout, stderr, code] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(process.stdout)),
        Stream.mkString(Stream.decodeText(process.stderr)),
        process.exitCode
      ],
      { concurrency: "unbounded" }
    )
    return { stdout, stderr, code }
  }))

/** Fails the acquire with the guest's own words when a preparation command exits non-zero. */
const required = (session: Sandbox.Session, what: string, line: string) =>
  Effect.flatMap(sh(session, line), (ran) =>
    ran.code === 0 ? Effect.succeed(ran) : Effect.fail(
      new RemoteChildProcessSpawner.ProviderError({
        code: "unavailable",
        message: `issue-sweep vm: ${what} exited ${ran.code}: ${ran.stderr.trim().split("\n").slice(-5).join("\n")}`
      })
    ))

/** Moves the checkout to the current `main` and installs any new dependencies. */
export const refreshLine = "jj git fetch --remote origin --branch main --quiet && jj new main@origin --quiet && " +
  "CI=1 pnpm install --frozen-lockfile --prefer-offline --reporter=silent"

/**
 * How the agent microVMs are shaped.
 */
export interface Options {
  /** The Microsandbox SDK. Default: the `microsandbox` package. */
  readonly sdk?: MicrosandboxSandbox.Sdk | undefined
  /** The prepared snapshot to boot. Default: the newest of `imageFamily`. */
  readonly snapshot?: string | undefined
  /** Virtual CPUs per microVM. Default 2. */
  readonly cpus?: number | undefined
  /**
   * Memory per microVM in MiB. Default 4096: compiling the backend's
   * internal/services tests peaks near 2.9 GiB, which 3072 killed, and the
   * guest overlay cannot hold a swap file.
   */
  readonly memoryMib?: number | undefined
  /** Hard lifetime per microVM in seconds. Default 3 hours. */
  readonly maxDurationSecs?: number | undefined
  /** The guest network. Default `{ allow: agentHosts }`. */
  readonly network?: Sandbox.NetworkPolicy | undefined
  /** Move the checkout to the current `main` at acquire. Default true. */
  readonly refresh?: boolean | undefined
  /**
   * Microvms alive at once; further acquires wait. Default 32: on this 16-core,
   * 64 GiB Mac, 32 held microVMs at 3 GiB ran an agent-shaped workload without
   * swapping; 48 swapped 1.8 GiB and 64 swapped 20 GiB (test/vm-capacity.sh).
   */
  readonly maxVms?: number | undefined
  /**
   * Microvms booting at once. Microsandbox prepares concurrent boots host-wide
   * in lockstep, so a wide burst finishes together and, past about 48, its
   * boots outlast the vendor's start timeout. Default 8.
   */
  readonly bootConcurrency?: number | undefined
  /** Recorded on each machine so `reapOrphans` can tell a dead holder. Default `<host>:<pid>`. */
  readonly holder?: string | undefined
  /**
   * Free host disk, in bytes, below which a new microVM waits to boot. Every
   * guest writes its own copy-on-write layer (dependency refreshes, build
   * caches), and 23 guests took the host from 46 to 20 GiB free in half an
   * hour. Default 25 GiB.
   */
  readonly minFreeBytes?: number | undefined
  /** Reads free host disk in bytes. Default: `statfs` of the Microsandbox home. */
  readonly freeBytes?: (() => number) | undefined
}

const microsandboxHome = join(homedir(), ".microsandbox")
const statfsFree = () => {
  const stats = statfsSync(existsSync(microsandboxHome) ? microsandboxHome : homedir())
  return stats.bavail * stats.bsize
}

/** Waits, polling every `interval`, while the host has less than `minimum` bytes free. */
export const awaitDisk = (freeBytes: () => number, minimum: number, interval: Duration.Input = "30 seconds") =>
  Effect.gen(function*() {
    while (freeBytes() < minimum) yield* Effect.sleep(interval)
  })

const defaultHolder = () => `${hostname()}:${process.pid}`

/** The newest snapshot of `imageFamily`, or a failure naming the build command. */
export const latestImage = (
  sdk: MicrosandboxSandbox.Sdk
): Effect.Effect<string, RemoteChildProcessSpawner.ProviderError> =>
  Effect.tryPromise({
    try: () => sdk.Snapshot.list(),
    catch: (cause) =>
      new RemoteChildProcessSpawner.ProviderError({
        code: "unavailable",
        message: "issue-sweep vm: snapshots could not be listed",
        cause
      })
  }).pipe(
    Effect.flatMap((entries) => {
      const newest = entries
        .filter((entry) => entry.name !== null && MicrosandboxSandbox.snapshotFamily(entry.name) === imageFamily)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0]
      return newest?.name != null ? Effect.succeed(newest.name) : Effect.fail(
        new RemoteChildProcessSpawner.ProviderError({
          code: "unavailable",
          message: `issue-sweep vm: no ${imageFamily} snapshot; build one with node flows/issue-sweep/test/vm-image.ts`
        })
      )
    })
  )

/**
 * A provider of agent microVMs: each `acquire` waits for one of `maxVms`
 * slots, boots the snapshot, refreshes the checkout, and hands back a session
 * rooted at `guestCheckout`. The slot and the microVM are both released when
 * the acquiring scope closes.
 */
export const make = (options: Options = {}): Sandbox.Provider & { readonly slots: Semaphore.Semaphore } => {
  const sdk = options.sdk ?? Microsandbox
  const slots = Semaphore.makeUnsafe(options.maxVms ?? 32)
  const boots = Semaphore.makeUnsafe(options.bootConcurrency ?? 8)
  let inner: Sandbox.Provider | undefined
  const machines = (snapshot: string) =>
    inner ??= MicrosandboxSandbox.make({
      sdk,
      snapshot,
      workdir: guestCheckout,
      env: {
        HOME: guestHome,
        XDG_CONFIG_HOME: `${guestHome}/.config`,
        XDG_CACHE_HOME: `${guestHome}/.cache`,
        ...toolchainEnv,
        PATH: guestPath
      },
      cpus: options.cpus ?? 2,
      memoryMib: options.memoryMib ?? 4096,
      maxDurationSecs: options.maxDurationSecs ?? 3 * 60 * 60,
      network: options.network ?? { allow: agentHosts },
      owner,
      holder: options.holder ?? defaultHolder(),
      labels: { "issue-sweep.snapshot": snapshot }
    })
  return {
    slots,
    acquire: (sessionKey) =>
      Effect.gen(function*() {
        yield* Effect.acquireRelease(slots.take(1), () => slots.release(1))
        yield* awaitDisk(options.freeBytes ?? statfsFree, options.minFreeBytes ?? 25 * 1024 ** 3)
        const snapshot = options.snapshot ?? (yield* latestImage(sdk))
        const session = yield* boots.withPermits(1)(machines(snapshot).acquire(sessionKey))
        if (options.refresh ?? true) yield* required(session, "refreshing the checkout", refreshLine)
        return session
      })
  }
}

let shared: ReturnType<typeof make> | undefined

/** The process-wide provider, so every work flow in this host shares one `maxVms` gate. */
export const provider = (options?: Options): ReturnType<typeof make> => shared ??= make(options)

/** Whether `<host>:<pid>` names a live process on this host. */
export const holderAlive = (holder: string): boolean => {
  const [host, pid] = holder.split(":")
  if (host !== hostname()) return true
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Removes issue-sweep microVMs whose host process is gone; run it before the first acquire. */
export const reapOrphans = (sdk: MicrosandboxSandbox.Sdk = Microsandbox) =>
  MicrosandboxSandbox.reap({ sdk, owner, isAlive: (holder) => Effect.sync(() => holderAlive(holder)) })

/**
 * Builds the Smithers image as the snapshot `issue-sweep.<revision>`: boots
 * `baseImage` with an open network, runs `provisionScript`, and captures the
 * disk, refusing if a credential file was left on it. No credential enters
 * the builder.
 */
export const buildImage = (
  revision: string,
  sdk: MicrosandboxSandbox.Sdk = Microsandbox
) =>
  Effect.gen(function*() {
    const builder = MicrosandboxSandbox.make({
      sdk,
      image: baseImage,
      pullPolicy: "if-missing",
      workdir: guestHome,
      env: { HOME: guestHome },
      persistence: "sticky",
      network: "open",
      cpus: 8,
      memoryMib: 12_288,
      rootDiskMib: 24_576,
      owner
    })
    // The builder is sticky so its disk outlives the session for the capture;
    // a failed provisioning removes it, or the next build would reuse its half-made disk.
    const machine = yield* Effect.scoped(Effect.gen(function*() {
      const session = yield* builder.acquire(`image-${revision}`)
      yield* required(session, "provisioning", provisionScript(revision)).pipe(
        Effect.tapError(() =>
          Effect.promise(() =>
            sdk.Sandbox.get(session.remoteId)
              .then((handle) => handle.destroy({ timeoutMs: 60_000, force: true }))
              .catch(() => undefined)
          )
        )
      )
      return session.remoteId
    }))
    return yield* MicrosandboxSandbox.captureSnapshot({
      sdk,
      machine,
      family: imageFamily,
      member: revision.slice(0, 12),
      secrets: []
    })
  })
