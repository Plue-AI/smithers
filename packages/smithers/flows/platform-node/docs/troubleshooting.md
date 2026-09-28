---
title: "Troubleshooting"
description: "The failures this Node bundle reports: filesystem refusals from the atomic helper, liveness verdicts that look wrong, reaper outcomes that will not retire a record, and Windows behaviour."
---

The failures here come from three places: the atomic filesystem helper, the
host liveness probe, and the process reaper. Each answers deliberately, and
several answers that look like bugs are the safe choice.

## A filesystem call fails with `ENOTSUP`

**Symptom.** An atomic operation fails with:

```text
atomic operation is unsupported
```

**Cause.** The helper was asked for an operation it does not implement. Every
operation is named explicitly, so an unrecognized one is refused rather than
approximated.

**Fix.** Use one of the supported operations. If you reached this through a
higher-level API, the operation name in the error identifies which call needs
a different route.

## A glob fails with `EFBIG`

**Symptom.**

```text
glob result exceeds the response limit
```

**Cause.** The match set was larger than the helper's response limit. The
limit is enforced while matches accumulate, not after, so a runaway pattern
fails fast instead of buffering without bound.

**Fix.** Narrow the pattern, or root it at a deeper directory. See
[match files with a glob pattern](./guides/match-files-with-glob.md).

## Every filesystem call fails on Windows

**Cause.** This is intended. Windows is an unsupported platform, and
`AtomicFileSystem` fails every filesystem call closed there rather than
half-working.

**Fix.** Run the durable engine on a supported platform. There is no flag to
enable a partial Windows path: a filesystem that confines some operations and
not others is worse than one that says it confines none.

## A run's owner reads as alive when the process is gone

**Cause.** The liveness probe fails safe. Only `ESRCH` from a signal-0 probe
counts as gone. `EPERM` means the pid exists and belongs to another user,
which is still a live owner. A throw carrying no code at all, including a
thrown string or `null`, is an answer nobody gave, and so also reads as alive.

This matters because the engine consults the probe before taking a run whose
recorded owner it is not: a wrong `true` strands a run, and a wrong `false`
runs it twice. Stranding is the cheaper mistake, so ambiguity resolves to
alive.

**Fix.** Nothing here is broken. If a run is genuinely stranded, retire the
owner record rather than weakening the probe. See
[answer whether a run owner is alive](./guides/answer-run-ownership.md).

## The liveness probes disagree on a foreign host

**Cause.** Both probes use the same `ESRCH`-only death rule.
`EPERM`, `EINVAL`, and unknown signal errors preserve liveness.
For a valid same-host pid, signal errors do not distinguish the probes.

`HostLiveness.isAlive` compares the owner's host with its configured `hostId`
and reports foreign owners as alive. `Ownership.sameHostPidProbe` compares
with `context.claimant.hostId` and returns `false` for a foreign owner without
probing its pid. The engine consults it after lease expiry, and the store
verifies that expiry before allowing a steal.

**Fix.** Choose the cross-host policy deliberately. `HostLiveness.isAlive`
leaves foreign-host recovery to an operator or another liveness source;
`sameHostPidProbe` lets the expired lease govern reclaiming foreign-host runs.
`HostLiveness.isAlive` ignores the context argument the sibling reads. See
[answer whether a run owner is alive](./guides/answer-run-ownership.md).

## The reaper answers `failed` and keeps the record

**Cause.** `failed` means the signal was refused and the record must be tried
again later. The reaper refuses a target rather than signalling something it
cannot prove it owns. On POSIX it refuses when:

- the record has no process group (`no-group`)
- the pid or pgid is not a safe integer, or is `1` or lower
- the pgid does not equal the pid, so the record does not name a group leader
- the target is this process's own pid or group, or the owner's

**Fix.** Read the record. A record failing the group-leader check was written
by something that did not spawn through the contained spawner, and reaping it
would signal a group this host does not own. See
[contain child processes](./guides/contain-child-processes.md).

## The reaper answers `unknown` rather than `dead`

**Cause.** `unknown` is not `dead`. `ESRCH` is the only answer that means
gone; a pid this host may not signal answers `EPERM`, and that is not
evidence of death.

**Fix.** Treat `unknown` as "ask again". Retiring on `unknown` would drop a
record describing a live process.

## A pid start-time lookup is `unavailable` rather than `gone`

**Cause.** The three negative answers are distinct because they authorize
different decisions. `gone` is evidence: the pid does not exist, so the record
describes nothing and is retired unsignalled. `unavailable` is the absence of
evidence: `ps` is missing, unanswerable, or printed something unrecognized.

**Fix.** Only `gone` may retire a record. `unavailable` must not, or a host
without `ps` would retire every record it holds.

## Reaping on Windows is weaker

**Cause.** Windows has no process groups and no `lstart`, so two guards cannot
be answered: the identity check falls back to boot-time comparison alone, and
there is no own-group refusal to make. The path runs
`%SystemRoot%\System32\taskkill.exe /T /F` by pid, by absolute path with an
inert working directory, so a `taskkill.exe` planted in the host's directory
never runs.

**Fix.** Nothing, and do not rely on it. Windows is unsupported; this path is
best-effort so that a win32 record is not silently retired as if reaped.
