---
title: "The invocation pipeline"
description: "What happens between a shell typing smithers-build and a target running: the loader, the argv rewrite, the credential capture, the signal handlers, and the exit code."
sidebar:
  order: 1
---

One invocation passes through five stages, and each one is a seam a test can
replace. Knowing them tells you where a symptom comes from.

## 1. The loader

The `bin` entry is `src/main.js`, plain JavaScript, because it has to run
before any TypeScript exists. It installs the Effect module resolution hooks
and then imports `src/main.ts` through the programmatic `tsx` loader.

The resolution hooks are not a convenience. Declarations, the planner, and the
flow engine exchange values branded by Effect's runtime symbols, so a linked
workspace that loads a second physical `effect` installation, even at the same
version, hands the engine schemas it cannot interpret. Every bare `effect`
import from a declaration resolves to the copy the CLI owns. `@smthrs/targets`
resolves the same way, which is what lets a globally installed
`smithers-build` bootstrap a repository before its dependencies exist.

## 2. The process entry

`src/main.ts` builds a `Host` from the real process and calls `Entry.main`.
The `Host` is the whole slice of `process` the CLI touches: `argv`, `env`, two
terminals, signal registration, and a setter for the exit code. Everything the
process does beyond loading lives behind that interface, so a test drives a
whole invocation with a fake process and in-memory terminals.

`Entry.main` does three things before the command runs.

**It captures and clears the cache credentials.** `SMITHERS_CACHE_URL` and
`SMITHERS_CACHE_TOKEN` are read once and deleted from the host environment.
Declarations evaluate afterward, so no `WORKSPACE.ts` or `PACKAGE.ts` module
can read them.

**It wires both signals to one `AbortController`.** `SIGINT` and `SIGTERM`
abort every running target and set the exit code to 1, whatever the command
was about to report. The listeners are persistent, never one-shot: the service
supervisor's orphan backstop decides whether to hard-kill the process by
asking `listenerCount(signal)`, and Node removes a one-shot listener before
invoking it. A `once` registration surrendered the signal at exactly the
moment the backstop looked, the process died instantly, and every write-set
revert, scratch cleanup, and graceful service stop was skipped. Each listener
removes itself in a microtask instead, so the second interrupt still stops the
process at once.

**It normalizes the argv.** `normalizeArgv` rewrites a first token starting
with `//` or `:` into `target <label>`. Every other argv passes through
unchanged. That one rule is the whole bare-label form.

## 3. The command surface

`makeCli(config)` builds the [incur](https://github.com/wevm/incur) CLI. The
[command reference](../cli.md) lists its commands, arguments, and options. The
`RuntimeConfig` it takes is everything process-scoped that a command must not
reach for on its own: the CLI's own name, version and description, the remote
cache credentials, the interruption signal, the environment, both terminals,
the audience policy, and the exit hook.
[`RuntimeConfig`](../api.md#runtimeconfig) lists every field and what it
replaces.

`exit` is the interesting one. Deciding a process's exit code is a choice only
a process owner may make, so `makeCli` never sets one itself. The entry point
supplies the setter; a library embedding the CLI leaves it out and reads the
structured error instead.

## 4. The workspace index

Every workspace command opens the target index before doing its own
work:

1. Resolve `--workspace` to an absolute path and walk up for the nearest
   directory holding a workspace declaration.
2. Evaluate that one declaration first. Its cache directory and its opaque
   child repositories are both discovery boundaries, so the walk cannot start
   without them.
3. Resolve the cache directory: `--cache-dir`, then the declaration, then
   `.flows`.
4. Walk the tree for `PACKAGE.ts` modules, load them, and build the index.

See [Workspace discovery](./discovery.md) for what the walk admits and what it
refuses.

## 5. Settling

A command returns data, and incur prints it as the envelope on standard
output. An execution command returns a summary instead, and how that summary
settles depends on who is reading:

- A red summary becomes the structured `targets_failed` error, exit code 1.
  When a human renderer already drew the failure on standard error, the
  command records only the exit code, so nothing is printed twice.
- A green summary is the envelope's data, unless the same renderer already
  drew it, in which case standard output stays empty.
- A plan report from `--plan` is always data, for a person and a program
  alike.

The reporter is closed however the run ends, in a `finally`, so a live
renderer always hands the terminal back. See
[Output and renderers](./output.md).

## What this buys a test

Because each stage is an argument rather than an ambient fact, a test can
assert on things a real process hides: that the credentials left the
environment, that no signal listener survived the run, that a red run set
exactly one exit code, and that a fake terminal received exactly the lines the
renderer claims to draw.
