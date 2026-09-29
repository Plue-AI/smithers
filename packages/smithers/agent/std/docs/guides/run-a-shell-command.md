---
title: "Run a shell command"
description: "Send a command line or a script that needs no quoting, route it into a container, declare a hermetic envelope, and read the exit code, the bounded output, and the invalid-probe flag."
sidebar:
  order: 4
---

`bash` runs one command. It takes two shapes, and the difference is where the
payload is parsed.

## A command line

```ts
import * as Bash from "@smthrs/std/Bash"

const result = Bash.run({
  mode: "unhermetic",
  command: "pnpm vitest run src/widen.test.ts",
  cwd: "/workspace",
  timeoutMs: 120_000
})
```

The line goes to the platform shell exactly as written, and it carries its own
arguments.

## A script, delivered as data

```ts
const result = Bash.run({
  mode: "unhermetic",
  interpreter: "python3",
  script: "import sys\nprint(sys.argv[1:])\n",
  args: ["alpha", "beta"],
  cwd: "/workspace"
})
```

`script` is program text delivered to the interpreter on standard input. Nothing
quotes it, escapes it, or terminates it with a heredoc marker, so the class of
failure that eats a quote out of
`docker exec c bash -lc '...python - <<EOF...'` cannot happen. `args` reach the
script as arguments rather than as interpolated text.

`interpreter` defaults to `bash`. `bash`, `zsh`, `sh`, and `dash` are told to
read the program with `-s`; `python` and `python3` with `-`; `node`, `ruby`,
`perl`, and anything else are given no file, which is how they read a program
from standard input.

Six input combinations are refused with `invalid_input`, each naming the fix:
`command` with `script`, neither of the two, `script` with `stdin`, `command`
with `args`, `command` with `interpreter`, and a hermetic containerised call.

## Declare the environment

Host commands inherit a bootstrap allowlist, not the whole Smithers process
environment: `PATH`, `HOME`, `USER`, `LANG`, every `LC_*` locale variable,
`TERM`, `TMPDIR`, and `SHELL`. Add a variable to `env` when the command needs
it. Caller-declared names are applied last, including credential-shaped names,
so declaring one is an explicit decision to make its value readable by the
command. Undeclared provider keys and tokens are withheld.

Containerised commands receive the `env` entries through the container
transport; their remaining environment belongs to the container image. The
Docker and Podman transport supplies each value to the host child as
`SMITHERS_CONTAINER_ENV_KEY`, passes `-e SMITHERS_CONTAINER_ENV_KEY`, and renames
it to `KEY` inside the container with `sh -c`, so the container needs `sh`. A
requested `PATH` or `LD_PRELOAD` therefore never configures the host `docker`
process. An `env` name that is not a POSIX shell name is `invalid_input`. Timeout errors show the logical command without
container transport arguments.

## Route it into a container

```ts
const result = Bash.run({
  mode: "unhermetic",
  container: "testbed",
  command: "python -m pytest tests/test_admin.py",
  cwd: "/testbed"
})
```

`container` names a container the host knows how to reach, and the `Container`
service turns the request into the argv the host spawns. `Container.layerCommand`
builds the `docker exec` form, which `podman` shares.

The transport always goes through a login shell, because the images an agent
meets activate the project's interpreter from `/etc/profile.d`. A program
spawned directly by `docker exec` gets a different Python from the one that owns
the repository's dependencies.

A host that binds no transport refuses the call with `provider_unavailable` and
a message telling the caller to drop the `container` field. That is the honest
answer: this host has no container route.

## Declare a hermetic envelope

`mode: "hermetic"` requires explicit `reads` and `writes`, and the handler
checks the command's explicit path tokens against them before spawning:

```ts
const result = Bash.run({
  mode: "hermetic",
  command: "cp /workspace/src/a.ts /workspace/build/a.ts",
  reads: ["/workspace/src/**"],
  writes: ["/workspace/build/**"]
})
```

A token outside the declaration fails with `outside_declared_reads` or
`outside_declared_writes` before anything runs, and the narrowed envelope makes
the call `compensable` instead of `irreversible`, so a scheduler can run it
beside work that touches other paths.

Read [Hermetic mode is a pre-check, not a sandbox](../concepts/effects-and-capabilities.md#hermetic-mode-is-a-pre-check-not-a-sandbox)
before you rely on this. The check is lexical: it bounds what the caller
declared it would do, not what the process can do.

## Read the result

A non-zero exit code is an ordinary value, not a failure. Only a timeout, a
spawn failure, a permission refusal, and the hermetic pre-check use the error
channel.

| Field                                      | Meaning                                                     |
| ------------------------------------------ | ----------------------------------------------------------- |
| `exitCode`                                 | The command's exit code.                                    |
| `stdout`, `stderr`                         | The captured streams, tail-first when truncated.            |
| `stdoutTruncated`, `stderrTruncated`       | Whether that stream is a fragment.                          |
| `stdoutDroppedBytes`, `stderrDroppedBytes` | Bytes omitted from the start.                               |
| `invalidProbe`                             | Present when the shell refused to start the command at all. |

Each stream is bounded at 30,000 bytes and the tail is kept, because a failing
command prints its verdict last. Never write a truncated stream to a file: it is
the end of a log, not the content it came from. `@smthrs/harness` reads the
`Truncated` flags to refuse exactly that.

`timeoutMs` defaults to `Bash.DEFAULT_TIMEOUT_MS`, ten minutes.

## The invalid-probe flag

A non-zero exit is a runner's verdict about the code it ran. It is not a verdict
about the command it was handed. When a command names a test, a file, a module,
an environment, or a program that does not exist, the runner never reaches any
code and still exits non-zero.

`invalidProbe` names that case, with a `reason` from a closed list
(`unknown-command`, `unknown-test`, `unknown-path`, `unknown-module`,
`unknown-environment`), the `evidence` it rests on, and a `message` stating
what the result does and does not prove.

```ts
if (result.invalidProbe !== undefined) {
  // The exit code is about the command. Fix the names and run it again
  // before drawing any conclusion from it.
}
```

`bash` does not infer a launch failure from exit code 126 or 127: a launched
runner can return either status after running a check. It returns the captured
command result without `invalidProbe` when launch cannot be established. The
`test` flow asks the attribution judge whether a non-zero exit describes the
code under test or an unresolved name. See
[Run the test suite](./run-the-test-suite.md#who-the-failure-belongs-to).

## The Codex-shaped alternative

`shell_command` is a clone of the Codex CLI tool of the same name, for a model
trained on that shape. It takes `command`, `workdir`, and `timeout_ms`, and it
returns Codex's own rendering:

```ts
import * as ShellCommand from "@smthrs/std/ShellCommand"

const result = ShellCommand.run({ command: "ls -la", workdir: "/workspace" })
// result.output: "Exit code: 0\nWall time: 0.1 seconds\nOutput:\n..."
// result.exitCode: 124 when the command timed out
```

The timeout defaults to 10 seconds, not ten minutes, and a timeout is a
successful value with exit code `ShellCommand.TIMEOUT_EXIT_CODE`. Output is
shaped to a 10,000-token budget by truncating the middle rather than the head.
Codex's `sandbox_permissions`, `justification`, and `prefix_rule` approval
parameters are deliberately absent: the permission kernel owns sandboxing and
escalation here.

Prefer `bash` for new work. It carries the effect envelope, the container
transport, the script form, and the per-stream truncation fields that
`shell_command` does not.
