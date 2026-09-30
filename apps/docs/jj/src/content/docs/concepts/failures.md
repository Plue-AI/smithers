---
title: "How a jj failure is reported"
description: "The six JjError codes and what each means, how each layer classifies jj's own output onto them, and why the cause is copied onto plain data before it reaches the journal."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/jj/docs/concepts/failures.md"
---

Every operation on `Jj` fails with a `JjError` carrying a stable `code`, the
`module` and `method` that failed, a human `message`, the `command` that
produced it, and an optional `cause`. Nothing escapes as an untyped throw: a
`node:child_process` spawn that dies synchronously, a Rust panic inside the
WebAssembly module, and a repository that refuses an operation all arrive the
same way.

## The six codes are a closed contract

| Code                  | Meaning                                                         |
| --------------------- | --------------------------------------------------------------- |
| `not_installed`       | No usable jj on this host.                                      |
| `conflict`            | The repository refused: the operation would conflict.           |
| `invalid_ref`         | The change id or revision does not resolve.                     |
| `snapshot_refused`    | jj skipped files while capturing the working copy.              |
| `unsupported_version` | The jj command line is older than the minimum, or unrecognized. |
| `unknown`             | Everything else jj reported.                                    |

Callers branch on these, step keys digest them, and user interfaces map them to
remediation. A code is added and never repurposed. Widening `conflict` to cover
a new situation would silently change what an already-recorded run means.

`conflict`, `invalid_ref`, `snapshot_refused`, and `unknown` always report an
operation. The other two also reach a caller from layer construction, before any
operation runs: a CLI layer probes `jj --version` before it exposes `Jj`, and
that probe fails with `not_installed` when no usable binary was found, and with
`unsupported_version` when the binary is older than `NodeJj.minimumVersion` or
prints a version this package cannot parse. `unsupported_version` is only ever a
construction failure, so `JjError` sits in the layer error channel of all four
CLI layers as well as in every method's.

## Classification is one definition, shared by every layer

The Node adapter reads jj's own stderr vocabulary and maps it onto these
codes, the same way `NodeFileSystem` maps errno. Two details in that mapping
exist because the naive version was wrong:

- The revision vocabulary is anchored. `Path doesn't exist` and
  `Revision "x" doesn't exist` are both jj sentences, and only the second is
  `invalid_ref`.
- The conflict vocabulary matches only on a line jj opened as a diagnostic
  (`Error:` or `Caused by:`) and only where `conflict` is a whole word. A bare
  substring test read a ref named `conflict-fix` or a path named
  `docs/conflict-resolution.md` as a conflicted repository, and it did so ahead
  of the revision check, so a genuinely invalid ref was journaled under the
  wrong durable code.

Some failures never reach jj at all. An empty revision string is `invalid_ref`
before anything is spawned, because jj's own answer would be an argument-parser
usage error that classifies as `unknown`, and the WebAssembly layer guards the
same case in Rust.

That agreement is the point, and it is tested rather than asserted:
[test/LayerParity.test.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/jj/test/LayerParity.test.ts)
drives one table of failures through both the CLI layer and the wasm layer and
requires the same code from each. A run that snapshots through one backend and
replays against the other needs the same code for the same failure, or a branch
on it takes a different arm.

## The cause is data, not an Error

`JjError` round-trips through the journal, and a journal round trip is
`JSON.stringify` at some point. An `Error` stringifies to `{}`, because `name`,
`message`, and `stack` are non-enumerable, so a `cause` holding the live object
would arrive on the other side of a replay with its message gone.

`JjErrorCause` is therefore three plain fields copied out at construction:
`name` (the failure's constructor or tag name), `code` (the errno-style string,
such as `ENOENT`), and `message`. `jjErrorCause(cause)` is the supported
projection from an arbitrary host failure onto that shape.

When the browser layer or the Node diff path refuses on its own check, the
cause carries the `name` `JjInternalFault` and a stable `code` instead of a
message to parse: `reactor_disposed`, `reactor_instantiation_failed`,
`reactor_abi_incomplete`, `reactor_request_allocation_failed`,
`reactor_response_allocation_failed`, `reactor_symlinks_unsupported`,
`patch_path_metadata_invalid`, `patch_path_metadata_incomplete`,
`patch_headers_disagree`, `patch_output_unexpected`, `wasi_not_initialized`, or
`lock_timeout`. The `JjError` `code`
stays `unknown`.

Bounding it is the second job. A live `PlatformError` carries argv, and an
arbitrary object can be cyclic or mutable, so every field is capped at
`causeMessageLimit` (1024 characters, with the ellipsis inside the budget). The
schema enforces the bound in both directions: `new JjError` throws on an
over-length field, and the journal decoder rejects an over-length record.

## Everything else that could be unbounded is bounded too

A diagnostic must not become a payload, so each of these has a stated ceiling:

- The `command` on a Node failure is the argv rendered back as the line a human
  would have typed, capped at 512 characters. A caller-supplied `snapshot`
  message cannot drag an arbitrary payload into a journaled error through it.
- One jj invocation buffers at most 64 MiB of each output stream, counted in
  bytes as they arrive rather than in decoded characters, so the bound is the
  same for a diff of Japanese source as for one of ASCII. Past the ceiling the
  child is killed and the operation fails with `unknown`. Both Node layers
  apply the identical ceiling, because routing jj through the host's spawner
  must not change what a caller observes.
- The WebAssembly layer quotes at most 256 characters of an unusable ABI
  response back in its error message.

## Telling jj's refusal from the kernel's

`JjFailure` is a union, so a caller that wants to branch narrows first:

```ts
import { isJjError, Jj } from "@smthrs/jj"
import * as Effect from "effect/Effect"

const codeOf = Effect.gen(function*() {
  const jj = yield* Jj
  const failure = yield* Effect.flip(jj.restore("nosuchchange"))
  return isJjError(failure) ? failure.code : "denied"
})
```

`isJjError` matches on the durable `_tag`, so it keeps working across the
kernel's decorator and across a journal round trip. Reading `.code` off the
union without narrowing is a type error, which is deliberate: "jj said no" and
"the capability kernel said no" call for different handling.

Every code, its usual causes, and the fix are in
[Troubleshooting](/troubleshooting/).
