import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers",
  // On the Node 22 CI hosts this complete process-boundary suite took
  // 1166.5 s on macOS and was killed at 1200.1 s on Ubuntu. Keep its
  // aggregate coverage gate in one run, with twice the observed completed
  // duration available; individual test deadlines remain unchanged.
  testTimeoutMs: 40 * 60_000,
  // `scripts/build.mjs` bundles the TUI that `smthrs tui` runs.
  buildInputs: [
    Smithers.glob("//apps/tui/src/**/*.ts"),
    Smithers.glob("//apps/tui/src/**/*.tsx"),
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

const test = Smithers.Shell.Test({
  shell: "cd packages/smithers && pnpm exec vitest run --config vitest.config.ts --environment node",
  data: [
    lib,
    Smithers.glob("src/**/*.ts"),
    Smithers.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] }),
    Smithers.file("vitest.config.ts"),
    Smithers.glob("//packages/repo-targets/test-utils/effect-property.*"),
    // `EvaluationCli.test.ts` lists the repository's shipped suites.
    Smithers.glob("//evals/**/*.eval.ts")
  ],
  timeout: "40m",
  hosts: ["linux"],
  // Only `HistoryPostgres.test.ts` reads this URL. It is deliberately not
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
 * The package's fault-injection cases.
 *
 * A package opts into the matrix by declaring this key, so
 * `//packages/...:faults` is the whole matrix and nothing central lists which
 * packages are in it. The tier is separate from `test` because its cases are
 * machine-global — they kill process groups, bind ephemeral ports, and read
 * the process table — so they run serially, without coverage, from
 * `vitest.faults.config.ts`.
 */
const faults = Smithers.FaultSuite({ cwd: "packages/smithers" })

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
    check,
    circular,
    docs,
    docsFiles,
    faults,
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
