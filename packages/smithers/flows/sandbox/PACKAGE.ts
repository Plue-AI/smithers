import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * A package that declares a `PACKAGE.ts` opts out of the workspace's default
 * target synthesis, so the standard targets are declared here explicitly:
 * without them the package has no `lib`, and the release pack, which depends
 * on every package `lib`, ships a stale `dist/cjs`. `cwd` anchors every
 * emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/flows/sandbox"
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd: "packages/smithers/flows/sandbox" })

/**
 * Security review of the sandbox providers: guest command construction, host
 * CLI argv, isolation defaults, credential flow, and snapshot scrubbing.
 */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/sandbox",
  include: ["src/**"],
  checks: [
    {
      id: "guest-shell-quoting",
      title: "Every caller-supplied path, env entry, and command crosses into a guest shell script quoted exactly once",
      threat:
        "A flow body or model-chosen file path injects shell into provider plumbing (read, write, kill, prepare) and runs commands the caller never asked for on the machine.",
      lookFor: [
        "A path, cwd, workdir, env name, or env value interpolated into a script string without CommandLine.quote.",
        "A value quoted and then re-embedded inside another quoted script so the outer quote breaks or double-evaluates it.",
        "environmentInput's eval of decoded operands running anything other than a `set --` of already-quoted words.",
        "An env name that bypasses checkEnvironmentNames before reaching env(1), `-u`, or an SDK env field.",
        "RemoteChildProcessSpawner rendering an Effect ChildProcess argv into one shell string where an argument, cwd, or pipeline segment is not quoted as a single word."
      ],
      paths: [
        "src/RemoteChildProcessSpawner/layer.ts",
        "src/internal/execSession.ts",
        "src/internal/envPrefix.ts",
        "src/internal/environmentCommand.ts",
        "src/internal/environmentInput.ts",
        "src/internal/environmentNames.ts",
        "src/internal/killScript.ts",
        "src/internal/stdinRedirect.ts",
        "src/internal/linuxFileSystem.ts",
        "src/Sandbox/fileSystem.ts",
        "src/AwsSandbox/make.ts",
        "src/CloudflareSandbox/make.ts",
        "src/DaytonaSandbox/make.ts",
        "src/MicrosandboxSandbox/make.ts",
        "src/MicrosandboxSandbox/snapshots.ts"
      ]
    },
    {
      id: "host-cli-argv-options",
      title: "Session keys, names, cwds, images, and namespaces cannot become flags of docker, kubectl, or aws",
      threat:
        "A caller controlling a session key or cwd smuggles an option such as --privileged or --volume into the host container CLI and escapes the machine onto the host.",
      lookFor: [
        "A container, pod, or task name derived from sessionSlug or machineName that can begin with `-` and sits in a positional argv slot.",
        "A `--workdir` or `--command` value that is not rooted to an absolute guest path before it reaches the CLI.",
        "createArgs or globalArgs merged after caller-derived positional values so they change how those values parse.",
        "Environment values placed on host argv instead of the stdin env-file or manifest, where `ps` on the host shows them."
      ],
      paths: [
        "src/CommandSandbox/make.ts",
        "src/ContainerSandbox/make.ts",
        "src/KubernetesSandbox/make.ts",
        "src/AwsSandbox/make.ts",
        "src/internal/sessionSlug.ts",
        "src/internal/machineName.ts"
      ]
    },
    {
      id: "isolation-defaults-and-reattach",
      title:
        "Providers default to no network and no host access, and reattach only to a machine whose configuration matches",
      threat:
        "An attacker who pre-creates a privileged or host-mounted machine under a predictable name gets a flow's commands and secrets run inside it on reattach.",
      lookFor: [
        "A default network mode other than `none`, or an AWS default that assigns a public IP.",
        "A reattach path that accepts a container or Pod without comparing the fingerprint label, image, workdir, network, privileged, binds, and hostNetwork.",
        "A fingerprint that omits a security-relevant option (env, createArgs, serviceAccount, networkPolicy).",
        "Microsandbox booting with the vendor's default egress when neither networkDisabled nor networkPolicy was set, without the docs saying so."
      ],
      paths: [
        "src/ContainerSandbox/make.ts",
        "src/KubernetesSandbox/make.ts",
        "src/AwsSandbox/make.ts",
        "src/MicrosandboxSandbox/make.ts",
        "src/internal/configurationFingerprint.ts"
      ]
    },
    {
      id: "host-secret-leak-to-guest",
      title: "Host environment and vendor credentials never reach guest code or vendor logs unasked",
      threat:
        "Untrusted code in a sandbox reads the host's API keys or the provider's vendor token from its environment or files.",
      lookFor: [
        "globalThis.process.env passed to a guest or a vendor SDK instead of the caller's explicit env.",
        "guestEnvironment forwarding a host-only value, or a credential copied into Session env, labels, or the fingerprint.",
        "Vercel, Daytona, Cloudflare, or AWS credentials resolved from ambient process state rather than options.",
        "DirectorySandbox handing the child more than ChildProcessEnvironment's narrow bootstrap set plus caller env."
      ],
      paths: [
        "src/RemoteChildProcessSpawner/layer.ts",
        "src/DirectorySandbox/make.ts",
        "src/VercelSandbox/**",
        "src/DaytonaSandbox/**",
        "src/CloudflareSandbox/**",
        "src/AwsSandbox/**",
        "src/MicrosandboxSandbox/make.ts"
      ]
    },
    {
      id: "snapshot-secret-scrub",
      title: "A captured Microsandbox snapshot holds no credential the preparation machine was given",
      threat: "Every later session restored from a snapshot reads a token or sign-in file left on the prepared disk.",
      lookFor: [
        "A credential file an agent CLI or package manager writes that is missing from credentialFiles.",
        "A grep exit code or partial-read case treated as clean, or a capture that proceeds after scrubbed fails.",
        "A secret stored transformed (base64, URL-encoded, split) that the fixed-string longest-line search cannot find.",
        "A failed capture path that leaves the stopped machine or a partial snapshot undestroyed."
      ],
      paths: ["src/MicrosandboxSandbox/snapshots.ts"]
    },
    {
      id: "signal-and-reap-targeting",
      title: "Kill and reap reach only the session's own processes and machines",
      threat:
        "A stale pidfile, a forged label, or a guest-written pid makes kill or reap stop another tenant's machine or a host process.",
      lookFor: [
        "A pidfile directory not wiped on acquire, or a pid read from the guest used in a host-side kill.",
        "hostKillScript or killScript receiving a non-numeric or caller-controlled pid string.",
        "reap removing a machine without filtering on both providerLabel and the caller's ownerLabel and re-reading the holder.",
        "DirectorySandbox signalling by raw pid instead of through the contained handle's lifecycle."
      ],
      paths: [
        "src/internal/killScript.ts",
        "src/internal/pidDirectory.ts",
        "src/internal/execSession.ts",
        "src/internal/microsandboxProcess.ts",
        "src/MicrosandboxSandbox/reap.ts",
        "src/DirectorySandbox/make.ts",
        "src/AwsSandbox/make.ts"
      ]
    },
    {
      id: "in-band-status-forgery",
      title: "A guest command cannot forge the exit status or output framing of provider plumbing",
      threat:
        "Code inside an ECS task prints a fake sentinel so a failed write, read, or preparation step is reported as success to the host.",
      lookFor: [
        "A sentinel nonce that is a predictable counter rather than unguessable random bytes.",
        "unframe taking the last sentinel match when a detached guest child can still write to the session after the wrapper.",
        "readFile or writeFile trusting stdout framing without a separate integrity signal."
      ],
      paths: ["src/AwsSandbox/make.ts"]
    },
    {
      id: "directory-sandbox-not-a-boundary",
      title: "Nothing treats DirectorySandbox, JustBashSandbox, or rootedAt as a confinement boundary",
      threat:
        "A composition picks DirectorySandbox or JustBashSandbox for untrusted code and a model-chosen absolute or `..` path reads or overwrites host files or another session's workspace.",
      lookFor: [
        "rootedAt passing absolute and `..` paths through unchanged, relied on by a caller as containment.",
        "DirectorySandbox or JustBashSandbox readFile, writeFile, or files overrides operating on paths outside workdir with no refusal.",
        "JustBashSandbox sessions sharing one interpreter filesystem so one session key can read or delete a sibling session's workspace under root.",
        "The scratch directory removed recursively on release after a symlink inside it points outside the root."
      ],
      paths: [
        "src/DirectorySandbox/make.ts",
        "src/JustBashSandbox/make.ts",
        "src/internal/rootedPath.ts",
        "src/Sandbox/fileSystem.ts"
      ]
    },
    {
      id: "staged-stdin-and-error-text",
      title: "Staged stdin files and provider error messages do not expose caller secrets",
      threat:
        "Another process on the machine or a log reader recovers a credential blob fed as stdin or quoted in a vendor error.",
      lookFor: [
        "A stdin staging file with a predictable name, world-readable mode, or no removal on every scope exit.",
        "A ProviderError or health verdict quoting a vendor error or stderr that may contain request headers or tokens without boundedMessage.",
        "Captured secret values printed in a snapshot refusal instead of only the file paths."
      ],
      paths: [
        "src/internal/stdinRedirect.ts",
        "src/internal/boundedMessage.ts",
        "src/SandboxHealth/**",
        "src/SandboxSupervision/**",
        "src/RemoteChildProcessSpawner/ProviderError.ts",
        "src/MicrosandboxSandbox/snapshots.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { bunTest, check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
