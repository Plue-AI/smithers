import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers",
  // On the Node 22 CI hosts this complete process-boundary suite took
  // 1166.5 s on macOS and was killed at 1200.1 s on Ubuntu. Keep its
  // aggregate coverage gate in one run, with twice the observed completed
  // duration available; individual test deadlines remain unchanged.
  testTimeoutMs: 40 * 60_000,
  // `scripts/build.mjs` bundles the TUI that `smthrs tui` runs.
  buildInputs: [Smithers.glob("//apps/tui/src/**/*.ts"), Smithers.glob("//apps/tui/src/**/*.tsx")],
  tests: Smithers.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] })
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
      title: "Local Claude and Codex subscription credentials leave the machine only to the named workspace or backend",
      threat:
        "A backend or SSH endpoint the operator did not intend receives their Claude or ChatGPT OAuth refresh tokens and spends their subscription.",
      lookFor: [
        "seed() in Workspaces.ts writing auth.json or claude-env.sh to a host chosen by the server's ssh_command without StrictHostKeyChecking beyond accept-new.",
        "providerLogin or auth connect posting refresh tokens to an origin taken from SMITHERS_API_ORIGIN or --hostname without confirmation.",
        "A token read from ~/.codex/auth.json, .credentials.json, or the keychain that is not passed to c.protect before output streams."
      ],
      paths: ["src/internal/backend/Workspaces.ts", "src/internal/backend/Auth.ts"]
    },
    {
      id: "codex-auth-store-integrity",
      title: "The shared Codex auth store is rewritten atomically at 0600 and never leaks tokens",
      threat:
        "Another local user reads the operator's ChatGPT tokens, or a concurrent refresh burns the refresh token and locks the operator out.",
      lookFor: [
        "A temp or lock file in CodexAuth.ts opened without 'wx' and mode 0600, or renamed across directories.",
        "A token, account id, or refresh response body included in a ModelError message.",
        "The refresh lock removed while its recorded pid is still alive, allowing two refreshes to spend one refresh token."
      ],
      paths: ["src/CodexAuth.ts"]
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
    test,
    docsSources,
    ...securityReview
  }
})
