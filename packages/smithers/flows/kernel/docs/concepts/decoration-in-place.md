---
title: "Decoration in place"
description: "Why the kernel guards the platform's own service tags instead of publishing protected copies: the closed port list, what each slot's error channel becomes, and what is deliberately not on the list."
sidebar:
  order: 1
---

A capability kernel has to answer one question before anything else: how does
a caller get the guarded service rather than the raw one? The usual answer is
a second tag. The platform provides `FileSystem`, the kernel provides
`ProtectedFileSystem`, and every consumer is told to ask for the second. That
answer fails the moment a dependency does not know about the kernel, and it
leaves two tag lists to keep in sync.

The kernel does the opposite. Each guarded implementation is a middleware
`Layer` over the very tag the platform adapter provides: it requires
`FileSystem` and it provides `FileSystem`. Composed over a host bundle, the
guarded implementation shadows the raw one for everything downstream. A
library that has never heard of Smithers is guarded because there is nothing
else for it to resolve.

```text
raw platform service
        |
kernel decorator -> GrantStore
        |
flow-visible service
```

`HostServices.layer` is those five middleware layers merged, so one
composition guards the whole surface at once.

## The closed list

Five tags, and everything that touches the outside world enters through one of
them:

| Slot       | Tag                   | Owner                   | Actions checked                                                                                                                         |
| ---------- | --------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem | `FileSystem`          | Effect                  | `fs:read`, `fs:write`                                                                                                                   |
| Paths      | `Path`                | Effect                  | none, by decision                                                                                                                       |
| Processes  | `ChildProcessSpawner` | Effect                  | `proc:spawn`                                                                                                                            |
| Repository | `Jj`                  | [`@smthrs/jj`](/api/jj) | `jj:status`, `jj:diff`, `jj:snapshot`, `jj:restore`, `jj:workspace-add`, `jj:workspace-forget`, `jj:root`, `jj:revert`, `jj:op-restore` |
| Network    | `HttpClient`          | Effect                  | `net:get`, `net:post`, `model:call`                                                                                                     |

`HostServices.HostServiceTags` is that list as values and
`HostServices.HostServiceIds` is the matching stable id per slot
(`"effect/FileSystem"`, `"effect/Path"`,
`"effect/process/ChildProcessSpawner"`, `"@smthrs/jj/Jj"`,
`"effect/HttpClient"`).

Two things depend on the list being closed. A service that is not on it cannot
be attenuated, denied, or audited, so it must not exist. And the list is part
of what a durable run records about itself: [`@smthrs/engine`](/api/engine)
folds the implementations that were in scope into the identity of every step it
caches, so a replay under a different set of them is a different step rather
than a silent substitution. The slot ids are durable for that reason too, and
change only when the service behind a slot changes.

## Four of the five tags are Effect's

Smithers supplies implementations of Effect's `FileSystem`, `Path`,
`ChildProcessSpawner`, and `HttpClient` rather than wrappers around them. That
choice decides where a refusal surfaces.

Where Effect owns the tag, the error channel stays Effect's own, and the
kernel projects its failure into it:

- `FileSystem` and `ChildProcessSpawner` refusals become a `PlatformError`
  whose reason is `PermissionDenied`, carrying the structured kernel failure
  on `cause`. `Permission.fromPlatformError` reads it back.
- `HttpClient` refusals become an `HttpClientError` whose reason is a
  `TransportError`, again carrying the kernel failure.
  `HttpClient.fromHttpClientError` reads it back.

Where Smithers owns the service, the interface names the failure directly:
`Jj` fails with `JjError | PermissionError`, and nothing has to be projected
or read back.

The asymmetry is not an accident. Widening Effect's error channels would mean
forking Effect's service interfaces; hiding the kernel failure inside an
opaque platform error would mean losing the capability, the reason, and the
stable code. Projection with the original on the cause keeps both.

## What is not on the list

**`Path` is on the list and checks nothing.** It is pure string manipulation:
`path.resolve` reads no directory and creates no file, so there is no
authority to guard. The slot exists as an explicit decision rather than an
omission. `Path.layer` resolves relative paths against `Workspace.root`, the
directory `ChildProcessSpawner.layer` runs a command in when it names no
`cwd`, so neither depends on the process's own directory.

**`Clock` and `Random` are Effect core built-ins.** They are already
port-shaped and already swappable with `Effect.provideService`, and neither
carries host authority, so they are not the kernel's to define or decorate.

**There is no Smithers transport port.** Network access is Effect's
`HttpClient` and the kernel decorates it. A raw Smithers transport beneath it
would be a second way to reach the network whose contract never mentions
permission, which is exactly the hole this design closes.

## What decoration cannot see

The kernel checks capabilities at adapter call sites. It does not sandbox the
operating system. Code that imports `node:fs` directly, or a native addon that
opens a socket, never passes through a decorated service and is not observed.
That is a real boundary, not a caveat to bury: confinement against untrusted
code requires an operating-system sandbox as well, and hermetic execution
requires a `StepBoundary` from [`@smthrs/engine`](/api/engine).

## Related

- [How a grant decision is made](./grant-decisions.md): what happens inside
  the check each decorator performs.
- [Guard a host bundle](../guides/guard-a-host-bundle.md): the composition,
  in order, with the layers a real host adds.
