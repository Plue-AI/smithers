---
title: "What a sandbox does and does not prevent"
description: "This package supplies coherence, lifetime, and honest refusal. Isolation belongs to the backend, differs per provider, and does not cover the host process that starts the machine."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sandbox/docs/concepts/isolation.md"
---

`@smthrs/sandbox` implements no isolation. It adapts whatever a backend
already provides, and the strength of that boundary ranges from a microVM down
to a directory on the machine you are sitting at. Decide what you need from
the provider, and read this page as the list of things the package will not do
for you.

## What the package does guarantee

Each of these is enforced in code and stated as behavior by a conformance
check or a test.

- **One machine per session.** A session's file operations and its processes
  see the same tree. `SandboxConformance` proves it in both directions:
  `files-reach-processes` writes with `writeFile` and measures the file with
  `wc -c` in a process, and `processes-reach-files` has a process produce a
  file that `readFile` must return.
- **Teardown is a finalizer.** Acquisition registers teardown on the acquiring
  scope, so an interruption tears the machine down. There is no `destroy`
  method a caller can forget.
- **Unsupported semantics are refused, not dropped.** A command that supplies
  standard input to a transport that cannot deliver it, extra file
  descriptors, `stdin: "inherit"`, a shell path, `detached: true`, non-default
  pipeline routing, and `kill` on a provider that declares none all fail with
  a `BadArgument` `PlatformError` before anything starts.
- **Standard input is bounded.** 16 MiB, counted as the bytes arrive, so an
  endless producer is stopped at the bound rather than after it finishes.
- **Environment names that would vanish are refused.** A POSIX shell rebuilds
  its environment from names matching `[A-Za-z_][A-Za-z0-9_]*` when it starts,
  so `a-b=1` reaches the process and is then discarded by the shell that
  interprets the command. Dash drops it and bash keeps it, which makes the loss
  a platform difference invisible to the host. The seam fails closed instead.
- **A declared `kill` must end the work.** The conformance check watches the
  machine, not the call: a `kill` that returns success and leaves the command
  running is a violation, and a fixture may name a `survivor` probe so a signal
  that stops only the wrapper shell is caught too.
- **Provider messages are bounded before they are logged.** A health verdict
  carries at most 512 characters with control characters collapsed, and the
  `ProviderError` and its `cause` never reach a logger from the probe, because
  adapters attach raw vendor errors there and those can quote credentials,
  headers, or response bodies.

None of that is confinement. It is coherence, lifetime, and honesty about what
crossed the seam.

## What each provider's boundary actually is

| Provider              | The boundary                                                                            | Shaping options it forwards                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DirectorySandbox`    | no filesystem, user, or network boundary. Real host processes with a narrow environment | child env inherits `PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, and `SHELL`, plus declared names |
| `JustBashSandbox`     | none. Commands are interpreted in process against a shared virtual filesystem           | none                                                                                                          |
| `ContainerSandbox`    | the container runtime's                                                                 | `image`, `network` (`none` by default; another mode opts into egress), `env`, `createArgs`                    |
| `KubernetesSandbox`   | the cluster's: the image, the service account, and the namespace's policies             | `image`, `serviceAccount`, `namespace`, `nodeSelector`, `resources`, `labels`, `createArgs`                   |
| `MicrosandboxSandbox` | a local microVM                                                                         | `image` or `snapshot`, `cpus`, `memoryMib`, `maxDurationSecs`, `idleTimeoutSecs`, `security`, `network`       |
| `VercelSandbox`       | Vercel's sandbox tenancy                                                                | `runtime`, `timeoutMs`, `maxDurationMs`, `network`                                                            |
| `DaytonaSandbox`      | Daytona's sandbox tenancy                                                               | `startTimeoutSeconds`, `deleteTimeoutSeconds`, `network`                                                      |
| `AwsSandbox`          | the Fargate task, its task role, and its security groups                                | `image` or `taskDefinition`, `taskRoleArn`, `securityGroups`, `subnets`, `assignPublicIp`, `cpu`, `memory`    |
| `CloudflareSandbox`   | the Durable Object and its container, deployed by you                                   | `sleepAfter`, `keepAlive`                                                                                     |

The first two rows say there is no confinement deliberately. `DirectorySandbox`
is a trusted local workspace backend and the conformance reference; its child
environment withholds undeclared ambient credentials, but a spawned process can
still address whatever its host user, filesystem, and network permit.
`JustBashSandbox` is a workspace
boundary for hosts that cannot spawn at all; an interpreted command can address
anything its shared virtual filesystem permits. Neither is a security boundary,
and neither becomes one by being wrapped in `Sandbox.layerHost`.

## Network policy

Every provider takes the neutral option
`network: "none" | { allow: string[] }`. `"none"` gives the guest no network.
`{ allow }` denies egress except to the listed hosts: exact DNS names such as
`registry.npmjs.org`, or `*.` and a name, such as `*.npmjs.org`, for every name
below it. List the apex of a `*.` entry separately when it must be reachable:
Microsandbox and Vercel deny it unless listed, and Daytona does not document
whether it admits it. Microsandbox and Vercel answer DNS only for listed names,
and an empty list denies all egress, DNS included; Daytona does not document
its DNS handling. A provider that cannot enforce the policy throws when `make`
is called, before any machine exists.

| Provider              | `"none"`                  | `{ allow }`                                                                      | Reattaching an existing machine                     |
| --------------------- | ------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| `VercelSandbox`       | `networkPolicy: deny-all` | Vercel's egress firewall `networkPolicy: { allow }`; an empty list is `deny-all` | the policy is updated before any guest command runs |
| `DaytonaSandbox`      | `networkBlockAll: true`   | the runner's iptables `domainAllowList`                                          | the policy is updated before any guest command runs |
| `MicrosandboxSandbox` | boots without networking  | deny ingress; deny egress, DNS included, but the hosts                           | refused unless it was created with the same policy  |
| `ContainerSandbox`    | `--network none`          | refused: an engine network mode is not a host firewall                           | the network mode is part of the fingerprint         |
| every other provider  | refused                   | refused                                                                          | not applicable                                      |

`ContainerSandbox` also accepts a raw engine network mode string, which opts
into that mode's egress. `MicrosandboxSandbox` also accepts `networkPolicy` in
the vendor's own rule shape; it and `network` are exclusive. Under `{ allow }`
Microsandbox matches each DNS query's name against the listed hosts and
answers any other name with `NXDOMAIN`, so an unlisted lookup cannot carry
data out; the policy carries no `Rule.allowDns()` resolver rule, which would
admit every name. The denied apex of a `*.` entry matches a connection only
by a TLS SNI naming the apex or by an apex lookup the same rule refuses, so a
listed subdomain that shares the apex's address stays reachable.

## What no provider here prevents

**The host process is not confined.** A sandbox confines the guest command, not
the code that starts it. `ContainerSandbox` runs `docker` on your host through
an injected spawner, `KubernetesSandbox` runs `kubectl`, and `AwsSandbox` runs
the `aws` CLI and `session-manager-plugin`, all with the credentials of the
process composing the provider. Provisioning is an unconfined host operation
by construction.

**The services are served bare.** `Sandbox.layerHost` provides
`ChildProcessSpawner`, `FileSystem`, and `Path` without a kernel capability
decorator, because the machine boundary is meant to be the thing denying
ambient access. When the provider supplies no boundary, nothing else does, and
a placed body reaches the whole host. There is no path guard to fall back on.

**The derived filesystem is the same authority as the shell.** Everything
`Sandbox.fileSystem` does not serve natively through `Session.files` is a POSIX
`sh` probe running in the session. It is a convenience over the same access the
guest command already has, never a restriction on it.

**Credentials handed to a session are readable inside it.** Provider `env` on
`ContainerSandbox` is applied at container creation and reaches every command;
on `KubernetesSandbox` it reaches the whole Pod; on `AwsSandbox` it arrives as
container overrides. Any command in the session can read them.

**The session key is not enforced.** Two holders of one key are served the same
machine, so one body can read and overwrite another's files, and the first
scope to close ends the machine under the other. See
[Sessions and their keys](/concepts/sessions/).

**There is no resource ceiling of the package's own.** CPU, memory, wall clock,
and disk are bounded only where a provider exposes an option for it, and the
package adds nothing when it does not. A body that fills the disk of a
`DirectorySandbox` fills your disk.

**Conformance does not check isolation.** Both suites state contract behavior:
output, exit codes, standard input, files, the workdir, environment delivery,
liveness, and signalling. No check asserts that a command failed to reach the
host, and a passing suite says nothing about confinement.

**Some backends change a command's output bytes.** Output is byte-exact
through `DirectorySandbox`, `ContainerSandbox`, `KubernetesSandbox`,
`MicrosandboxSandbox`. It is not through `JustBashSandbox`, `VercelSandbox`,
`DaytonaSandbox`, or `CloudflareSandbox`, whose APIs report a
command's output as a string that is re-encoded as UTF-8, and `AwsSandbox`
reframes output through a pseudo-terminal, which normalizes line endings and
interleaves standard error. File transfer is byte-exact on all nine, so a
caller that needs bytes out of a command has the command write a file and reads
that back. The full table is on [Limits](/limits/).

**A `Healthy` verdict can mean nothing is watching.** A session that declares
no `ping` gets the noop probe, which always answers `Healthy`. Even a real
answer only says the machine responded within the deadline; it makes no claim
about what is running inside it.

## Choosing a boundary

Ask the question in this order.

1. **Do you trust the code that will run?** If yes, `DirectorySandbox` gives
   you coherence and lifetime with no provisioning cost, and that is a
   legitimate use.
2. **Do you need the code contained on this machine?** Use
   `ContainerSandbox` (which defaults to `network: "none"`) or `MicrosandboxSandbox` with
   `network: "none"`, and accept the boundary each one actually has: a container
   shares the host kernel, and a microVM does not.
3. **Do you need it off this machine?** Use `KubernetesSandbox`,
   `AwsSandbox`, `VercelSandbox`, `DaytonaSandbox`, or `CloudflareSandbox`, and
   configure the boundary where it lives: namespace policy and service account,
   task role and security groups, or the Worker's binding.
4. **Whatever you chose, keep the provisioning credentials small.** They are
   held by the unconfined half.

## Read next

- [Choose a provider](/guides/choose-a-provider/): the nine, side by side,
  with what each costs to run.
- [Limits](/limits/): what this package bounds and what it buffers whole.
