---
title: "Run the test suite and attribute a failure"
description: "Declare how the project under test runs its suite, select what to run, and use against:'base' to separate the failures your edit introduced from the ones that were already there."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/std/docs/guides/run-the-test-suite.md"
---

The `test` flow answers three questions a shell command cannot: what the suite
reported, which of the failures are yours, and whether the run failed about the
code at all.

## Declare the runner once

A caller of `test` selects **which** tests, never **how** to run them. The
invocation is a host declaration, bound through the `TestRunner` service:

```ts
import * as TestRunner from "@smthrs/std/TestRunner"

const runner = TestRunner.layer({
  command: "python -m pytest -q",
  cwd: "/testbed",
  root: "/workspace/repo",
  container: "testbed",
  env: { PYTHONDONTWRITEBYTECODE: "1" },
  timeoutMs: 900_000
})
```

| Field       | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `command`   | The runner command line, with no test selection in it.               |
| `cwd`       | Where the runner runs. The container's path when `container` is set. |
| `root`      | The host path of the git repository, when it differs from `cwd`.     |
| `container` | A container to route the run through, via the `Container` transport. |
| `env`       | Environment the runner needs.                                        |
| `baseRef`   | The ref whose commit is the pristine base.                           |
| `timeoutMs` | Default wall-clock budget for one run.                               |

`cwd` and `root` differ exactly when the runner runs in a container: the
container sees the repository at `cwd`, the host sees it at `root`, and a
baseline checkout created at `<root>/.flows-test-base/run-<lease>` is visible to the runner
at `<cwd>/.flows-test-base/run-<lease>`, because it is one directory under two names.

A host with no runner binds `TestRunner.layerNoop`. The flow then fails with
`provider_unavailable` and tells the caller to use `bash` with the command the
project's own documentation gives.

## Run a selection

```ts
import * as TestRun from "@smthrs/std/TestRun"

const result = TestRun.run({
  selection: ["tests/test_admin.py::AdminViewBasicTest::test_change_list"]
})
```

Selection entries reach the runner as arguments, never as text spliced into the
command line. The invocation is `bash -lc '<command> "$@"' <command> id...`, so a
test id holding `::`, `[`, `]`, spaces, or shell metacharacters stays data.
Omitting `selection` runs everything.

The result is a reading, not a log:

| Field                               | Meaning                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `command`                           | The logical invocation, without container transport arguments.             |
| `exitCode`                          | The runner's exit code.                                                    |
| `passed`                            | Tests reported passing. Zero when `parsed` is false.                       |
| `failed`                            | Ids of the tests reported failing or erroring.                             |
| `parsed`                            | Whether the runner's complete report could be read.                        |
| `tail`                              | The end of the runner's combined output.                                   |
| `tailTruncated`, `tailDroppedBytes` | Whether `tail` is a fragment, and by how much.                             |
| `invalidProbe`                      | Present when the exit code describes the command, not the code under test. |

When `parsed` is false, `tail` is all there is, and base attribution is omitted
rather than guessed at.

Unittest skips and expected failures, and TAP skips and TODO failures, do not
count as passing or failing tests. A successful TAP TODO counts as passing.
Unittest unexpected successes count as failures; attribution requires their
reported ids. Python 3.10 class-only headers and Python 3.11+ full test ids are
both supported. Missing failure ids or unknown unittest summary fields leave
`parsed` false.

## Who the failure belongs to

A non-zero exit is a runner's verdict about the code it ran, not about the
command it was handed. A run that names a test, a file, a module, an
environment, or a program that does not exist never reaches any code and still
exits non-zero, so it reads the same before and after a correct fix.
`invalidProbe` is present when this run was one of those, with a `reason` from
that closed list and a `message` saying what the result does and does not
prove.

Jev makes that attribution. The flow asks the `probe/attribution` classifier
through the `Evaluator` service of [`@smthrs/model`](https://model.smithers.sh/reference/api/), so a host
binds an evaluator on a subscription seat. Only a zero exit is attributed without a judge. Exit codes 126 and 127
also go through attribution: a runner can return them after executing tests.
A judge that cannot
be reached, refuses, times out, or answers something unusable fails the call
with `provider_unavailable`, `timeout`, or `request_failed`, because a guess at
whether a reproduction reproduced is worth less than no answer at all.

## Attribute a failure to your own edit

`against: "base"` runs the same selection a second time against the pristine
base commit, in a scratch checkout, and differences the two failure sets:

```ts
const result = TestRun.run({
  selection: ["tests/test_admin.py"],
  against: "base"
})

result.introduced // failing here and not on the base tree: yours
result.preexisting // failing on both: not yours, and not worth investigating
result.fixed // failing on the base tree and passing here
result.base // the base run's own outcome, plus its ref and commit
```

That is the whole of attribution, in one call. Without it, the same question
costs a revert of the very work it was meant to prove.

The baseline commit is resolved from the runner's `baseRef`, then from
`TestRunner.captureBase` (`refs/flows/capture-base`), then from `HEAD`. A
`baseRef` that does not resolve is an error rather than a fallback, because a
baseline against the wrong tree answers the attribution question wrong.

The baseline is a detached checkout at `<root>/.flows-test-base/run-<lease>`, under
`TestRun.scratchDirectory`. Each call gets a unique lease. Existing checkouts
are left alone; a `SIGKILL` can leave one behind. Inside the repository is the only place that works:
a runner reaching the repository through a container mount sees a scratch
checkout anywhere else on the host as a path that does not exist. It is removed
when the call ends, however it ends. It is written from a temporary shadow
`GIT_DIR`, like a checkpoint, so no hook or filter driver in the workspace's
`.git` runs on the host and the repository's format is never changed.

`against: "base"` needs a repository directory. A runner declaring neither `root`
nor `cwd` fails with `invalid_input`.

## Bound the run

`timeoutMs` on the call overrides the runner's own, which overrides
`TestRun.DEFAULT_TIMEOUT_MS` (ten minutes). The run holds at most
`TestRun.MAX_CAPTURE_BYTES` of output in memory, and `tail` carries the last
30,000 bytes of it, so `tail` holds the part of a long run that says what
failed. A timeout is a `timeout` failure, not a result.
