---
title: "Quickstart"
description: "Scaffold a project, plan a flow, approve the plan, run it, and read the run back, using the smthrs command line end to end."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/quickstart.md"
---

This quickstart takes one directory from empty to a settled run. Every command
here is a real `smthrs` process against one real project.

By the end you will have a project with `.flows/control.db` and
`.flows/engine.db` on disk, one flow discovered from `flows/`, and one durable
run you can list, read, and delete.

## Before you start

Install the CLI and check the machine, as described in
[Installation](/installation/):

```bash
mkdir hello-smithers && cd hello-smithers
smthrs doctor
```

`doctor` inspects discovery and existing state without creating execution databases. It reports the project root it resolved, both database
files, the supported Node range (26.4.0 or later), whether `jj` is on the
`PATH`, and which provider keys are set. A `fail` line is a fact that will stop
the next command you run; fix those first.

## Scaffold a flow

```bash
smthrs init hello
```

`init` creates workspace declarations, a package manifest when absent, and
`flows/hello/flow.mdx`. Existing declarations are retained. It adds `.flows/`
to `.gitignore` in a repository; execution databases are acquired by runtime
commands, not by generating a flow.

For an existing npm or Bun workspace, use the supported flow-only path:

```bash
smthrs generate flow hello
```

This preserves `packageManager` and adds the flow without inventing an npm
workspace executor. `init` refuses an unsupported package manager before
writing project files and points to this command. A `bun@` manager is refused
the same way, because Smithers cannot install `node_modules` with Bun; write
`WORKSPACE.ts` by hand to run tools under Bun.

The scaffold declares a model seat chosen from the provider credentials this
environment sets, in the order `doctor` reports them:

```text
---
description: A starter Smithers flow.
capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:*"]
model: anthropic:claude-sonnet-4-5
---
```

The directory supplies the flow's name. The starter requests file reads,
file writes, and process spawning for its editing and testing instructions;
narrow those capabilities when the task needs less authority.

Connect a subscription and choose its model in the flow's `model:` field:

```bash
codex login
export SMITHERS_OPENAI_AUTH=chatgpt
```

For Codex, use `model: openai:gpt-6-astra`. Claude subscription seats use
`ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`. Team hosts use their
connected accounts. The completion judge uses the same subscription resolver;
no provider API key or gateway key is required. Missing seats and invalid
judgments fail the run without an API-key fallback.

Confirm the flow is discoverable:

```bash
smthrs flow list
```

```text
{
  "_tag": "flows",
  "items": [
    {
      "description": "A starter Smithers flow.",
      "flowId": "hello"
    }
  ]
}
```

Members are ordered by UTF-16 code unit in every document the CLI prints, which
is why `description` comes before `flowId`.

## Plan the flow

```bash
smthrs flow plan hello
```

`flow plan` creates no run. It asks the control plane to plan the flow and prints
the plan card: the plan id, the content digest, the canonical summary of the
input, the capability envelope, the node graph, and an `approval` member. That
`approval` member is the payload `approvals approve`, `approvals deny`, and `flow execute` accept
unchanged.

Capture it for the next two steps:

```bash
approval="$(smthrs flow plan hello --json | jq -c '.approval')"
```

## Submit it, and watch it park

```bash
smthrs flow execute "$approval"
echo "exit: $?"
```

```text
{"_tag":"Parked","planId":"<plan-id>","receiptId":"<receipt-id>","status":"waiting-approval"}
exit: 3
```

The plan carries no grant yet, so the control plane parks it instead of
launching. Exit 3 is the one outcome a caller cannot read from the payload
alone: the run did not fail, it is waiting for a decision.

## Approve it, then run it

```bash
smthrs approvals approve "$approval" --scope run
```

```text
{"_tag":"Accepted","receiptId":"approve:plan-1"}
```

`approvals approve` records the grant. It does not launch: the receipt carries no
`runId`, and `smthrs runs list` still lists nothing. Submit the same payload again,
and this time the grant is there:

```bash
smthrs flow execute "$approval"
echo "exit: $?"
```

`--scope run` grants this launch and the whole run it starts, which is the same
grant `smthrs flow start` makes for itself. `once` grants a single ask, and
`remembered` grants every later run.

Because this process owns the executor, `flow execute` stays attached after the receipt
is accepted, waits for the run to settle, and reports the run's outcome as its
own exit status: 0 for `completed`, 1 for `failed`, 130 for `cancelled`, 3 if
it parks again on an in-run ask.

With no resolvable provider credential the launch is refused rather than left
hanging, and the run row settles `failed`:

```text
LaunchFailed: Set OPENAI_API_KEY to run the openai:gpt-6-sol seat
```

## Read the run back

```bash
smthrs runs list
```

`runs list` lists durable runs with their status, and `--status` filters on the seven
statuses the release pins: `accepted`, `running`, `parked`,
`waiting-approval`, `cancelled`, `completed`, and `failed`. An eighth value is
a usage error, not an empty list.

Take the run id from that listing and read what happened:

```bash
smthrs runs show <run-id>     # the diagnosis: what it did, and what to do next
smthrs runs logs <run-id>     # the transcript; --json is the raw event stream
smthrs runs output <run-id>   # every registered node output
```

`runs logs --follow` streams events as they land instead of rendering a transcript.
`runs output <run-id> <node-id>` prints one node's output; a node id the run does
not have is a usage error naming the run, not an empty document.

## Do it in one command next time

The plan, approve, execute sequence collapses into one command when the plan needs no
human review:

```bash
smthrs flow start hello --data '{"args":"Describe how durable runs work"}'
```

`flow start` plans the flow, grants the plan's own approval at `run` scope, and submits
it. Attached, it waits for the run to settle and exits with the run's status.
With `-d` it launches a child process that outlives it and prints the run id
and log path instead. See [Launch a detached run](/guides/launch-a-detached-run/).

## Clean up

```bash
smthrs runs cancel-all                 # cancel every non-terminal run
smthrs gc --older-than 1s --dry-run    # report what retention would delete
smthrs gc --older-than 1s              # delete it
```

`runs cancel-all` is a list followed by a cancel, so running it twice is a no-op rather
than an error. `gc` refuses `--older-than 0s`: deleting everything is not a
retention policy, and it is the easiest value to type by accident.

## What just happened

One project directory anchored every command on the same two SQLite files, so
the run `flow execute` started is the run `runs list` listed and `gc` deleted.
The approval you passed to `flow execute` and `approvals approve` was the same
serialized payload `flow plan` printed,
which is why another local operator process or explicitly delegated remote
operator can decide a park this shell created. The MCP surface can inspect
pending approvals but refuses approval and denial decisions.

## Next steps

- [Script the CLI](/guides/script-the-cli/): `--json`, exit codes, and the
  idempotency keys that make a retried command safe.
- [Diagnose a run](/guides/diagnose-a-run/): what `status`, `logs`, and
  `output` each answer, and how to file a bug with a run digest attached.
- [Output and exit codes](/concepts/output-and-exit-codes/): the rendering
  rules and the status vocabulary a script branches on.
