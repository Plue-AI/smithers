import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { Package as flowsJjPackage } from "../../crates/flows-jj/PACKAGE.ts"
import { Package as machinedPackage } from "../../crates/smithers-machined/PACKAGE.ts"
import { Package as scriptPackage } from "../../scripts/PACKAGE.ts"
import { Package as backendPackage } from "../backend/PACKAGE.ts"

const tuiSources = Smithers.Filegroup({
  cwd: "apps/tui",
  srcs: [Smithers.glob("src/**/*.ts"), Smithers.glob("src/**/*.tsx")]
})

const { check, circular, docs, docsFiles, fmt, lib, lint } = BuildAndCheckTypeScriptPackage({
  deps: [tuiSources],
  cwd: "packages/smithers",
  // On the Node 22 CI hosts this complete process-boundary suite took
  // 1166.5 s on macOS and was killed at 1200.1 s on Ubuntu. Keep its
  // aggregate coverage gate in one run, with twice the observed completed
  // duration available; individual test deadlines remain unchanged.
  testTimeoutMs: 40 * 60_000,
  // `scripts/build.mjs` bundles the TUI that `smthrs tui` runs.
  buildInputs: [
    Smithers.glob("vendor/opentui-native/**"),
    Smithers.file("scripts/build-tui.mjs"),
    Smithers.file("scripts/tui-native-editor.mjs")
  ],
  tests: Smithers.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] })
})

/** The history suite needs a real PostgreSQL server on the Linux CI runner. */
const historyPostgresDatabase = Smithers.Docker.Service({
  image: "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
  env: { POSTGRES_PASSWORD: "smithers-history-test", POSTGRES_DB: "smithers_history_test" },
  ports: { "5432": 55435 },
  readiness: {
    exec: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "smithers_history_test"],
    timeout: "120s"
  },
  stop: { signal: "SIGTERM", grace: "10s" }
})

const vitest = "pnpm exec vitest run --config vitest.config.ts --environment node"

/**
 * One lane of the suite: its results and raw coverage go to a blob, and it
 * prints no coverage report and checks no thresholds of its own.
 */
const lane = `${vitest} --reporter=blob --coverage.reporter=json` +
  " --coverage.thresholds.lines=0 --coverage.thresholds.functions=0" +
  " --coverage.thresholds.branches=0 --coverage.thresholds.statements=0"

/** The two longest files: 964 s and 402 s (real lease expiries). */
const laneOne = ["test/Bin.test.ts", "test/NativeControlExternalPeerRecovery.test.ts"]

/** The next longest files, 46 s to 265 s each. */
const laneTwo = [
  "test/ModuleSourceSnapshotCli.test.ts",
  "test/EndToEnd.test.ts",
  "test/NativeCancellationCli.test.ts",
  "test/FileFlowInputCli.test.ts",
  "test/CloudSandbox.test.ts",
  "test/DetachedHostResume.test.ts",
  "test/NativeControlPortable.test.ts",
  "test/UnifiedCli.test.ts",
  "test/HistoryVerify.test.ts",
  "test/ObserveMode.test.ts",
  "test/TuiRuntimes.test.ts",
  "test/McpModeCli.test.ts",
  "test/ModuleHumanWaitBudget.test.ts"
]

/**
 * C-J6-02's composed-install file. Its Go cases need a backend database and
 * the Go modules, which `delegatedLogin` below declares; this suite has neither.
 */
const delegatedLoginTest = "test/DelegatedLogin.integration.test.ts"

/** Every other file, so a new file joins the third lane without an edit here. */
const laneThree = [...laneOne, ...laneTwo, delegatedLoginTest].map((file) => `--exclude ${file}`).join(" ")

const test = Smithers.Shell.Test({
  // The files run one after another (`fileParallelism: false`): 3906 s of
  // them, measured 2026-10-10 on four pinned cores, against the 40-minute cap.
  // As two halves the second half alone took 3305 s there and timed out on
  // the Release gates lane (job 114021383970). Three lanes of about 1300 s
  // each finished in 1574 s, and merging their blobs checks the thresholds
  // over the whole suite as before. The runner shows a target's first 200
  // live lines: `github-actions` prints one line per failed case first, so a
  // red names every failing file before `dot` prints details that may pass
  // the limit.
  shell: [
    "cd packages/smithers && blobs=$(mktemp -d) && {",
    `${lane} --outputFile=$blobs/one.json ${laneOne.join(" ")} & one=$!;`,
    `${lane} --outputFile=$blobs/two.json ${laneTwo.join(" ")} & two=$!;`,
    `${lane} --outputFile=$blobs/three.json ${laneThree}; wait $one $two;`,
    "if test -f $blobs/one.json && test -f $blobs/two.json && test -f $blobs/three.json;",
    `then ${vitest} --merge-reports=$blobs --reporter=github-actions --reporter=dot;`,
    "else echo \"a lane of the suite ended without its report\" >&2; false; fi; };",
    "status=$?; rm -rf \"$blobs\"; exit $status"
  ].join(" "),
  data: [
    lib,
    Smithers.glob("src/**/*.ts"),
    Smithers.glob("test/**/*.test.ts", { exclude: ["test/faults/**", delegatedLoginTest] }),
    Smithers.file("vitest.config.ts"),
    Smithers.file("//packages/repo-targets/test-utils/effect-property.mjs"),
    Smithers.file("//packages/repo-targets/test-utils/effect-property.d.mts"),
    // `EvaluationCli.test.ts` lists the repository's shipped suites.
    scriptPackage.repositoryInputs,
    // `ProductApi.test.ts` checks the generated client against the spec.
    Smithers.file("//docs/api/openapi.yaml")
  ],
  timeout: "40m",
  hosts: ["linux"],
  // The package's PostgreSQL cases read this URL. It is deliberately not
  // `SMITHERS_TEST_PG_URL`: that name switches every `TestDatabase` case into
  // the PostgreSQL matrix, and the CLI announces it as an ignored 0.x setting
  // on stderr, so exporting it here changed every spawned command's output.
  env: {
    SMITHERS_HISTORY_TEST_PG_URL: "postgres://postgres:smithers-history-test@127.0.0.1:55435/smithers_history_test"
  },
  services: [historyPostgresDatabase],
  sandbox: { network: "loopback" }
})

/**
 * The PostgreSQL server C-J6-02's composed-install cases run against; each Go
 * test creates and drops its own database on it, as under the root
 * `backendGo`.
 */
const delegatedLoginPostgresDatabase = Smithers.Docker.Service({
  image: "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
  env: { POSTGRES_USER: "smithers", POSTGRES_PASSWORD: "smithers-delegated-login-test" },
  ports: { "5432": 55433 },
  readiness: {
    exec: ["pg_isready", "-h", "127.0.0.1", "-U", "smithers", "-d", "postgres"],
    timeout: "120s"
  },
  stop: { signal: "SIGTERM", grace: "10s" }
})

/** The Go modules the composed backend tests compile against, on a clean runner. */
const delegatedLoginGoModules = Smithers.Go.ModDownload({
  mod: Smithers.file("//go.mod"),
  sum: Smithers.file("//go.sum"),
  outDirs: ["//.artifacts/delegated-login-go-modcache"],
  sandbox: { network: true },
  destinations: ["proxy.golang.org", "sum.golang.org", "storage.googleapis.com"]
})

/**
 * C-J6-02: a delegated laptop login requests a review_merge card and cannot
 * merge.
 *
 * `DelegatedLogin.integration.test.ts` runs the backend's composed-install Go
 * cases whenever `CI` is set, and those refuse to run without a PostgreSQL
 * server. Inside `test` it had neither that server nor the Go modules, so it
 * failed there with "PostgreSQL tests are required" behind that suite's
 * timeout. This target declares both. The file's reference-install case still
 * needs `SMITHERS_DELEGATED_LOGIN_TEST=1` and is not run here.
 */
const delegatedLogin = Smithers.Shell.Test({
  shell: "export GOMODCACHE=\"$PWD/.artifacts/delegated-login-go-modcache\"; cd packages/smithers && " +
    `${vitest} --coverage.enabled=false ${delegatedLoginTest}`,
  data: [
    delegatedLoginGoModules,
    lib,
    Smithers.glob("src/**/*.ts"),
    Smithers.file(delegatedLoginTest),
    Smithers.file("test/setup.ts"),
    Smithers.file("vitest.config.ts"),
    Smithers.file("//go.mod"),
    Smithers.file("//go.sum"),
    backendPackage.buildInputs
  ],
  timeout: "20m",
  hosts: ["linux"],
  env: {
    GOFLAGS: "-buildvcs=false -mod=readonly",
    GOPROXY: "off",
    SMITHERS_TEST_DATABASE_URL:
      "postgres://smithers:smithers-delegated-login-test@127.0.0.1:55433/postgres?sslmode=disable"
  },
  services: [delegatedLoginPostgresDatabase],
  sandbox: { network: "loopback" }
})

/**
 * The PostgreSQL server the Go-backed durability cases (C-DUR-01 to C-DUR-04)
 * and case40 run against; each Go suite creates and drops its own databases
 * on it, as under the root `backendGo`.
 */
const faultPostgresDatabase = Smithers.Docker.Service({
  image: "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
  env: { POSTGRES_USER: "smithers", POSTGRES_PASSWORD: "smithers-fault-test" },
  ports: { "5432": 55439 },
  readiness: {
    exec: ["pg_isready", "-h", "127.0.0.1", "-U", "smithers", "-d", "postgres"],
    timeout: "120s"
  },
  stop: { signal: "SIGTERM", grace: "10s" }
})

/**
 * PostgreSQL 18 programs for the private-cluster cases
 * (`postgres_kill_fault_test.go` and case40's K5 crossing), which start, kill
 * and restart their own server and never the shared one. Built from the checksum-pinned 18.0 source
 * with pgcrypto, which the product migrations create, as the harness user: no
 * system install. The 18.0 archive ships no generated parser, so the host
 * needs a C toolchain, bison, flex and OpenSSL headers, as hosted runners
 * have. The runner passes a case no host variable, so the directory a workflow
 * exported never reached the case (#3459); the fault target names this output.
 */
const faultPostgresPrograms = Smithers.Shell.Build({
  shell:
    "prefix=\"$PWD/.artifacts/fault-postgres\"; src=\"$prefix/build\"; rm -rf \"$src\" && mkdir -p \"$src\" || exit $?; ssl=''; if [ \"$(uname -s)\" = Darwin ] && command -v brew >/dev/null; then openssl=$(brew --prefix openssl@3) && ssl=\"--with-includes=$openssl/include --with-libraries=$openssl/lib\"; fi; curl --fail --location --retry 3 --silent --show-error https://ftp.postgresql.org/pub/source/v18.0/postgresql-18.0.tar.bz2 --output \"$src/postgresql-18.0.tar.bz2\" && printf '%s  %s\\n' 0d5b903b1e5fe361bca7aa9507519933773eb34266b1357c4e7780fdee6d6078 \"$src/postgresql-18.0.tar.bz2\" | shasum -a 256 -c && tar -xjf \"$src/postgresql-18.0.tar.bz2\" -C \"$src\" && (cd \"$src/postgresql-18.0\" && ./configure --quiet --prefix=\"$prefix\" --without-icu --without-readline --without-zlib --with-ssl=openssl $ssl && make -s -j\"$(getconf _NPROCESSORS_ONLN)\" && make -s install && make -s -C contrib/pgcrypto install) && \"$prefix/bin/postgres\" --version; status=$?; rm -rf \"$src\"; exit $status",
  outDirs: ["//.artifacts/fault-postgres"],
  sandbox: { network: true },
  timeout: "30m"
})

/**
 * Native programs the long tier's cases drive, built from this checkout: the
 * FFI library, the trusted-process `smithers-jj-export` the composed install
 * rehearsals bind a TODO's checkout with, machined's rehearsal daemon, and the
 * same daemon with its fault hooks (`--features killpoints`), which K7 kills
 * at its points. The hooks compile only into debug builds, never a release.
 * A workflow's exported paths never reached a case, and the CI-installed
 * `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` that does reach it lacks the
 * trusted-process binding, so the fault target names these outputs (#3459).
 */
const faultNative = Smithers.Shell.Build({
  shell:
    "out=\"$PWD/.artifacts/fault-native\"; build=\"$out/build\"; debug=\"$build/target/debug\"; mkdir -p \"$build\" || exit $?; export RUSTUP_HOME=\"$build/rustup\" CARGO_TARGET_DIR=\"$build/target\"; rustup toolchain install && cargo build --locked -p smithers-ffi --bin smithers-jj-export --features trusted-process-binding && cp \"$debug/smithers-jj-export\" \"$out/\" && cargo build --locked -p smithers-ffi --lib && { cp \"$debug/libsmithers_ffi.so\" \"$out/\" 2>/dev/null || cp \"$debug/libsmithers_ffi.dylib\" \"$out/\"; } && cargo build --locked -p smithers-machined --example rehearsal_daemon && cp \"$debug/examples/rehearsal_daemon\" \"$out/\" && cargo build --locked -p smithers-machined --example rehearsal_daemon --features killpoints && cp \"$debug/examples/rehearsal_daemon\" \"$out/machined-fault-daemon\"; status=$?; rm -rf \"$build\"; exit $status",
  outDirs: ["//.artifacts/fault-native"],
  data: [
    Smithers.file("//Cargo.toml"),
    Smithers.file("//Cargo.lock"),
    Smithers.file("//rust-toolchain.toml"),
    Smithers.file("//crates/flows-jj/Cargo.toml"),
    flowsJjPackage.nativeSources,
    machinedPackage.ffiInputs,
    machinedPackage.buildInputs,
    backendPackage.machineContractInputs
  ],
  sandbox: { network: true },
  timeout: "30m"
})

/**
 * What every Go-backed fault case reads. The runner passes a case only the
 * host bootstrap environment, so the database URL, the host class and the
 * programs a workflow exported never arrived and every Go-backed case failed
 * with "Real PostgreSQL is required" (#3459). The targets declare them. Program
 * paths are workspace-relative because a declaration holds a fixed string; the
 * harness makes them absolute before a case starts. `linux` is the host class
 * of every runner these targets serve; the approved reference host needs its
 * own declaration, with its bundle, when its matrix entry stops refusing.
 */
const faultEnv = {
  SMITHERS_FAULT_HOST: "linux",
  SMITHERS_FAULT_POSTGRES_BIN: ".artifacts/fault-postgres/bin",
  SMITHERS_TEST_DATABASE_URL: "postgres://smithers:smithers-fault-test@127.0.0.1:55439/postgres?sslmode=disable",
  SMITHERS_REQUIRE_DATABASE_TESTS: "1"
}

/**
 * The package's fault-injection cases.
 *
 * A package opts into the matrix by declaring this key, so
 * `//packages/...:faults` is the whole matrix and nothing central lists which
 * packages are in it. The tier is separate from `test` because its cases are
 * machine-global — they kill process groups, bind ephemeral ports, and read
 * the process table — so they run serially, without coverage, from
 * `vitest.faults.config.ts`, and unconfined.
 *
 * This is the release tier, the gate's "Exclusive fault matrix": everything
 * under `test/faults` except `test/faults/long/`. Its file cases took 945 s on
 * the release runner (2026-10-10) and its Go cases add a compile of the
 * compose tests and about two minutes of route kills, so it declares 40
 * minutes rather than the Vitest default 20; nightly reliability's 60-minute
 * job still fits its setup and the PostgreSQL build around it.
 */
const faults = Smithers.FaultSuite({
  cwd: "packages/smithers",
  tests: Smithers.glob("test/faults/**/*.test.ts", { exclude: ["test/faults/long/**"] }),
  deps: [faultPostgresPrograms],
  env: faultEnv,
  services: [faultPostgresDatabase],
  sandbox: "none",
  timeoutMs: 40 * 60_000
})

/**
 * The long fault tier: `test/faults/long/`, cases measured in tens of minutes
 * or budgeted in hours (the packaged pause/resume, GitHub outbound, machined
 * K4/K4b/K7, rebase and case40 host-kill cases). Scheduled reliability runs it
 * nightly; the release gate does not wait on it. `harness/goFaultCases.ts`
 * assigns each Go case a tier and `test/FaultTiers.test.ts` checks every case
 * is in exactly one. The budget sits under a hosted runner's six-hour job
 * ceiling; the reference-only cases budgeted beyond it refuse in seconds off
 * the reference host.
 */
const faultsLong = Smithers.FaultSuite({
  cwd: "packages/smithers",
  tests: Smithers.glob("test/faults/long/**/*.test.ts"),
  config: Smithers.file("vitest.faults-long.config.ts"),
  // case40's K5 crossing kills its own private cluster, as the release
  // tier's PostgreSQL case does.
  deps: [faultNative, faultPostgresPrograms],
  env: {
    ...faultEnv,
    SMITHERS_FFI_LIBRARY_PATH: ".artifacts/fault-native/libsmithers_ffi.so",
    SMITHERS_REHEARSAL_JJ_EXPORT_BINARY: ".artifacts/fault-native/smithers-jj-export",
    SMITHERS_REHEARSAL_MACHINED_BINARY: ".artifacts/fault-native/rehearsal_daemon",
    SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY: ".artifacts/fault-native/machined-fault-daemon"
  },
  services: [faultPostgresDatabase],
  sandbox: "none",
  timeoutMs: 345 * 60_000
})

/** The corrected native editor and its reproducible source used by the TUI. */
const nativeSources = Smithers.Filegroup({
  srcs: [Smithers.glob("vendor/opentui-native/**")],
  cwd: "packages/smithers"
})

/**
 * The command sources, README, package docs, and the manifest whose version
 * the docs pin. The site's `//apps/site:cliData` generator lists this group in
 * `data`, so a help string, a removed-command anchor, or the version moves the
 * docs' key.
 */
const docsSources = Smithers.Filegroup({
  srcs: [
    Smithers.glob("src/**/*.ts"),
    Smithers.file("README.md"),
    Smithers.file("package.json"),
    Smithers.glob("docs/*.md")
  ],
  cwd: "packages/smithers"
})

/**
 * Security review of the CLI's own sources. Nested packages (agent, build,
 * control, flows, gateway, ...) carry their own declarations.
 */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers",
  include: ["src/**", "bin/**", "scripts/**"],
  checks: [
    {
      id: "cli-login-callback",
      title: "Browser login callbacks accept only the state-bound loopback handoff",
      threat:
        "A web page or local process the operator visits plants its own token or steals the operator's Smithers or Observe session during `auth login`.",
      lookFor: [
        "A callback server in Auth.ts that binds to anything but 127.0.0.1 or accepts a POST before the constant-time callback_state compare.",
        "The /callback POST handler lacking an Origin or Host check that openObserve applies, so a DNS-rebound page can race the handoff.",
        "A token or ticket echoed into the bridge HTML, a query string, or a log instead of staying in the URL fragment."
      ],
      paths: ["src/internal/backend/Auth.ts"]
    },
    {
      id: "token-origin-binding",
      title: "A saved Smithers token is sent only to the origin it was saved for",
      threat:
        "A malicious repository, remote, or redirect receives the operator's Smithers bearer token and acts on their repositories and workspaces.",
      lookFor: [
        "Client.response sending `authorization` to an origin other than the one Session.resolve bound the token to, or following redirects.",
        "Session.record or resolve returning a token when the auth file's api_url or host does not match the requested origin.",
        "Session.keyring building the macOS `security -i` script from a token or host that can contain quotes or newlines.",
        "auth.json or its temp file written with a mode wider than 0600, or into a directory wider than 0700."
      ],
      paths: ["src/internal/backend/Session.ts", "src/internal/backend/Client.ts", "src/internal/backend/Auth.ts"]
    },
    {
      id: "workspace-ssh-injection",
      title: "Server-supplied SSH commands and remote scripts cannot run attacker-chosen local or remote code",
      threat:
        "A compromised or spoofed backend runs arbitrary commands on the operator's machine through ssh options, or on the workspace through unquoted paths.",
      lookFor: [
        "sshArgs accepting an -o directive such as ProxyCommand, LocalCommand, or a flag besides -p/-i/-l and the listed booleans.",
        "An -i identity path or destination word that can start with '-' or contain shell metacharacters reaching ssh.",
        "A remote script in SSH.ts, Copy.ts, or Workspaces.ts that interpolates a path, env value, or exec id without quote() or the id regex."
      ],
      paths: ["src/internal/backend/SSH.ts", "src/internal/backend/Copy.ts", "src/internal/backend/Workspaces.ts"]
    },
    {
      id: "workspace-copy-containment",
      title: "`workspace cp` downloads write only inside the requested local destination",
      threat:
        "A compromised workspace sends a tar stream that writes or overwrites files outside the operator's destination, such as ~/.ssh or shell rc files.",
      lookFor: [
        "archiveFilter admitting an absolute path, a '..' segment, or a hard link whose target leaves the requested root.",
        "A SymbolicLink entry extracted into scratch and then followed by a later entry or by merge() rename into the destination.",
        "merge() or the parent walk writing through a symlinked destination component created between check and rename."
      ],
      paths: ["src/internal/backend/Copy.ts"]
    },
    {
      id: "subscription-credential-export",
      title:
        "Local Codex subscription credentials and Anthropic API keys leave the machine only to the named workspace or backend",
      threat:
        "A backend or SSH endpoint the operator did not intend receives their ChatGPT OAuth refresh tokens or Anthropic API key and spends their account. A Claude subscription token is never read, stored, or sent (#2777).",
      lookFor: [
        "seed() in Workspaces.ts writing auth.json or the API-key claude-env.sh to a host chosen by the server's ssh_command without StrictHostKeyChecking beyond accept-new.",
        "providerLogin or auth connect posting refresh tokens to an origin taken from SMITHERS_API_ORIGIN or --hostname without confirmation.",
        "Any read of Claude's .credentials.json or keychain entry. A token read from ~/.codex/auth.json that is not passed to c.protect before output streams."
      ],
      paths: ["src/internal/backend/Workspaces.ts", "src/internal/backend/Auth.ts"]
    },
    {
      id: "codex-vendor-login",
      title: "Codex alone holds its subscription credentials",
      threat: "Smithers reads or forwards a vendor login, or silently replaces a subscription with an ambient API key.",
      lookFor: [
        "A read or rewrite of Codex auth.json outside the vendor binary.",
        "A Codex key or token in child environment overrides, command arguments, model errors or journal receipts.",
        "An unbounded vendor process or a process group left alive after cancellation."
      ],
      paths: ["src/internal/CodexCode.ts", "src/Providers.ts", "src/internal/NativeEquipment.ts"]
    },
    {
      id: "serve-bind-auth",
      title: "`smthrs serve` never exposes an unauthenticated control plane off loopback",
      threat:
        "A host on the operator's LAN launches agents and approves plans with the operator's credentials through the gateway.",
      lookFor: [
        "Serve.refuse accepting a non-loopback host such as 0.0.0.0, ::, or a LAN address without both --listen and a non-empty credential.",
        "The serve composition handing the gateway an empty or undefined bearer for a non-loopback bind, or dropping the loopback Host and Origin policy a DNS-rebound browser page would hit.",
        "The gateway approval authority in NativeControl.ts granting Plan or Node approval to a principal other than local or the configured bearer."
      ],
      paths: ["src/Serve.ts", "src/internal/NativeControl.ts", "src/NodeControl.ts"]
    },
    {
      id: "approved-envelope-enforcement",
      title: "Native flow handlers run only under their owning approved plan's capability envelope",
      threat:
        "An agent or flow author runs code or capabilities the operator never approved by forking, resuming, or editing a module after approval.",
      lookFor: [
        "ModuleAuthority.owner admitting an execution whose root plan is not approved or whose planDigest or executionDigest no longer matches.",
        "A handler registration path in ModuleAuthority.ts or NativeControl.ts that skips CapabilitySet.attenuate with the envelope's capabilities.",
        "A delegate executable admitted when card.envelope.flows does not name it."
      ],
      paths: ["src/internal/ModuleAuthority.ts", "src/internal/ModuleAdmission.ts", "src/internal/NativeControl.ts"]
    },
    {
      id: "open-runs-untrusted-checkout",
      title: "`smthrs open` never runs package scripts from a checkout the operator does not trust",
      threat:
        "An attacker repository whose remote merely names smithersai/smithers on any host gets `pnpm dev` executed on the operator's machine by `smthrs .`.",
      lookFor: [
        "smithersCheckout deciding on the owner/repo path of a remote without checking the remote host.",
        "host.launch running pnpm, open, or another binary with arguments derived from the checkout's remote or files."
      ],
      paths: ["src/commands/Open.ts"]
    },
    {
      id: "bug-report-redaction",
      title: "`smthrs bug` sends only redacted context to the configured endpoint",
      threat:
        "A maintainer or a spoofed SMITHERS_BUG_ENDPOINT receives the operator's API keys, tokens, or connection strings from a bug report.",
      lookFor: [
        "A report field in Bug.ts or commands/Bug.ts added after Redaction.redact runs, or read from env or journal without redaction.",
        "The endpoint taken from the environment over plain http or without showing it to the operator before posting."
      ],
      paths: ["src/Bug.ts", "src/commands/Bug.ts"]
    },
    {
      id: "local-credential-store",
      title: "Operator credentials stored by `credentials` commands are encrypted and never printed",
      threat:
        "Anyone who reads the project's control database or command output recovers the operator's stored provider secrets.",
      lookFor: [
        "A write path in operator/Credentials.ts that uses CredentialCipher.makeNoop instead of the SMITHERS_CREDENTIAL_KEY cipher.",
        "--secret-file resolved relative to an untrusted root or following a symlink into another user's file, or the secret echoed in output."
      ],
      paths: ["src/operator/Credentials.ts", "src/operator/Store.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: {
    tuiSources,
    check,
    circular,
    delegatedLogin,
    delegatedLoginGoModules,
    delegatedLoginPostgresDatabase,
    docs,
    docsFiles,
    faultNative,
    faultPostgresDatabase,
    faultPostgresPrograms,
    faults,
    faultsLong,
    fmt,
    lib,
    lint,
    nativeSources,
    test,
    historyPostgresDatabase,
    docsSources,
    ...securityReview
  }
})
