# @smthrs/platform-node

## [Unreleased]

### Fixed

- A `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` that names a missing or unusable
  helper is refused with the variable's name and the same install hint as a
  missing helper, instead of a bare `ENOENT`.
- `AtomicFileSystem.stat` now reports `birthtime` on Linux. CPython carries the
  creation time on `os.stat_result` only on macOS and the BSDs, so the helper
  answered `Option.none` on Linux while `@effect/platform-node` answered the
  instant it read through `statx`. The helper now reads `statx` itself, through
  the C library already mapped into the process, and still answers
  `Option.none` on any host that has no creation time to give.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added `AtomicFileSystem`, the descriptor-relative filesystem `NodeHost` puts
  in its filesystem slot. Every operation pins the workspace root, walks each
  component with `O_NOFOLLOW`, and performs the final syscall relative to a
  pinned parent descriptor, so a symlink swapped in after authorization cannot
  redirect it. **It is a new host prerequisite**: a POSIX host with CPython 3 at
  `/usr/bin/python3` whose `os` module supports `dir_fd` for `open`, `mkdir`,
  `readlink`, `rename`, `rmdir`, `stat`, and `unlink`. The layer builds without
  one and then fails every guarded filesystem call closed with
  `PermissionDenied`; `AtomicFileSystem.layerWith({ executable })` points it at
  an interpreter installed elsewhere. Windows is unsupported. `open`, `stream`,
  `sink`, `watch`, `copy`, `copyFile`, `link`, `symlink`, `access`, `chmod`,
  `chown`, `truncate`, `utimes`, and the `makeTemp*` family are refused under the
  capability decorator rather than reverting to a path-based call.
- Added `ProcessReaper`, which kills the process groups a crashed incarnation of
  the same host abandoned, and `HostLiveness`, which answers whether a recorded
  run owner is still running on this host.
- Added `NodeHost.layerAt` and `NodeHost.layerContainedAt`, the two layers with
  `Jj` bound to one absolute repository root rather than the process working
  directory, and `NodeHost.layerContained`, which turns on process containment.
- Added `AtomicFileSystem.Options.concurrency` and
  `AtomicFileSystem.Options.timeoutMs`, with `defaultConcurrency`
  (`os.availableParallelism()`) and `defaultTimeoutMs` (300000). Each operation
  is one CPython fork, so without a ceiling an unbounded fan-out started one
  interpreter per entry; without a timeout a helper that never answered held the
  fiber until the run itself was interrupted.
- Added `ProcessReaper.StartTime`, `ProcessReaper.SystemOptions`,
  `ProcessReaper.posixSystemWith`, `ProcessReaper.defaultPsExecutable`, and
  `System.refuseTarget`.
- Added `NodeHost.ContainedOptions`.

### Changed

- Extracted the package from the dissolved `@smthrs/host`. `NodeHost` moved here
  unchanged in behaviour; `NodeJj` had already moved to `@smthrs/jj` and is
  composed from there.
- `AtomicFileSystem.stat` now reports the raw `st_mode`, file-type bits
  included, matching `@effect/platform-node`. It previously masked the value
  down to its permission bits, so `mode & S_IFMT` answered zero through the
  atomic path and correctly through the raw one.
- Atomic system errors now carry `syscall`, which `@effect/platform-node` sets
  on every system error it reports. It names the operation's own syscall,
  narrowed where an operation has two (`remove` reports `unlink` or `rmdir`),
  rather than whichever of that operation's calls raised.
- `AtomicFileSystem.glob` now implements the grammar rather than translating it
  into a regular expression: brace alternation, trailing-slash directory-only
  matching, `**` spanning zero segments, the dotfile rule, subtree-pruning
  exclusions, and absolute excludes rewritten against the glob root all now
  agree with `node:fs.glob`. Matching is linear in the candidate's length, so a
  pattern of repeated `*x` fragments no longer costs exponential backtracking. A
  pattern past 4096 characters or 64 brace alternatives is a `BadArgument`; a
  character class that opens and never closes is literal text, and `[]]` is a
  class holding one bracket rather than an error.
- `AtomicFileSystem.glob` now refuses the three constructs it does not implement,
  in an exclude as well as in the pattern: extglob (`+(a|b)`), POSIX classes
  (`[[:digit:]]`), and brace ranges (`{1..3}`) are a
  `BadArgument`. They were read as ordinary characters, which does not fail, it
  answers a different question: `exclude: ["+(private|secret)/**"]` excluded
  nothing and the caller received every file under the directories it had just
  forbidden.
- Backslashes now follow Node's POSIX glob behavior: absolute selectors and
  every exclusion drop them while leaving following wildcard magic active;
  relative selectors containing one return no matches.
- `AtomicFileSystem.glob` now enforces the 64-alternative brace bound before it
  expands anything. The bound was checked as each expanded pattern was appended,
  so a pattern of many brace groups exhausted the interpreter's recursion limit
  before the first one existed: `"{,a}"` repeated 1024 times, which is exactly
  the 4096-character pattern ceiling, answered `PermissionDenied` with
  "descriptor-relative filesystem isolation failed closed: maximum recursion
  depth exceeded" instead of the documented `BadArgument`. Caller input inside
  the contract now reports as caller input.
- `AtomicFileSystem.glob` now applies an exclusion that names the glob ROOT
  before it walks. The root is the one directory the walk never lists, so
  nothing applied the rule to it: `exclude: ["."]`, `[""]`, and the absolute
  root in either spelling dropped the root's own entry and then returned every
  path below it, charging the entry and response ceilings for a tree the caller
  had forbidden. All four now answer with nothing and walk nothing.
- `AtomicFileSystem.glob` now reads a one-member positive character class as the
  literal it is, so `[.]` is a `.` path segment rather than a name no directory
  holds. As the LAST segment it names whatever the segments before it addressed,
  under the rule a trailing `**` already followed, with one addition: a `**`
  immediately before it addresses nothing, so `**/[.]` names nothing while
  `**/deep/[.]` names the directory. Anywhere else, and in an exclusion, it
  names nothing.
- `AtomicFileSystem.glob` no longer names a non-directory anchor from a trailing
  `**` reached through a wildcard. `*/**` returned every top-level FILE as well
  as the directories, `t*.txt/**` returned `top.txt`, and `**/mid.txt/**`
  returned `nested/mid.txt`, where `node:fs.glob` returns only directories,
  nothing, and nothing. A trailing `**` names its anchor when the anchor is a
  directory, or when every segment before it is literal, which is the shortcut
  the native globber takes when it can address the path directly.
- `AtomicFileSystem.glob` now reads a character class as a class when it looks
  for the extglob syntax it refuses. `[!(]*` is a negated class holding one
  paren, and `node:fs.glob` answers it with real matches; it was refused as
  `BadArgument` because the scan saw `!` followed by `(`.
- `AtomicFileSystem.glob` exclusions now prune the walk instead of filtering
  its result. An excluded directory was listed in full first, so its names were
  counted against the 100000-entry ceiling and charged against the response
  ceiling: a glob whose answer was two paths could fail `BadResource` because of
  a directory the caller had excluded.
- `AtomicFileSystem.glob` matching is case-sensitive on every host, and says so
  in the documentation. `node:fs.glob` passes `nocase: isMacOS || isWindows`
  with `nocaseMagicOnly: true`, so the same pattern means different things on
  macOS and on Linux, and a magic segment means something different from a
  literal one on macOS. One host-independent rule is pinned instead, alongside
  the exclusion's trailing-`**` answer, which Node itself gives differently
  depending on the selecting pattern's shape.
- `AtomicFileSystem.Options.timeoutMs` now refuses a value above 2147483647.
  `setTimeout` clamps a longer delay to one millisecond, so asking for a longer
  backstop produced no backstop at all: every operation failed instantly with
  "atomic helper did not answer within 2147483648 ms".
- `ProcessReaper` now requires its own process group to be printed as decimal
  digits and nothing else. `Number.parseInt` reads a PREFIX, so a `ps` answering
  `"2147483646 x"` produced a number that is not this host's group: the
  own-group comparison passed on a false identity, and because the answer was
  not `null` the `own-group-unknown` refusal that reports an unmade comparison
  never fired either, leaving a `SIGKILL` authorized by a guard that never ran.
- `AtomicFileSystem.remove(path, { force: true })` now succeeds for a path whose
  ancestors do not exist, as `fs.rm` does. Recursive removal walks iteratively
  with an explicit descriptor stack, bounded at 512 levels and 100000 entries,
  counted as each directory is read, so a hostile wide directory is refused
  rather than allocated whole.
- `AtomicFileSystem` reads every option except `executable` once, when the layer
  is built, so a mutated options object cannot change a ceiling under a running
  host. The concurrency ceiling is one semaphore per layer.
- `NodeHost.layerContained` and `layerContainedAt` no longer accept
  `ContainedSpawner.Options.platform`. A caller-supplied `"win32"` used to win
  the option spread on a POSIX host, recording `pgid: null` for a child that
  really did lead a group; the reaper then refused that record as `no-group` and
  the orphan outlived every incarnation.
- `ProcessReaper` refuses a record it cannot verify instead of signalling it. An
  absent, unanswerable, or unparseable `ps` used to read as "no refusal" and a
  recycled process group was `SIGKILL`ed on the strength of a record the host
  could not check. `System.startedAtMs` now returns a tagged `StartTime`, the
  probe runs from an absolute `/bin/ps` with `LC_ALL=C`, an empty-ish
  environment, and a finite timeout, and the new `identity-unverified` refusal
  keeps the record for an incarnation that can answer. A nonzero `ps` exit is
  confirmed against the kernel before a record is retired as `process-gone`,
  because it is also how a `ps` that rejected the column answers about a live
  pid.
- `ProcessReaper` refuses a record with the new `own-group-unknown` when it could
  not read its OWN process group. That comparison is what stops the sweep
  signalling the shell this host runs in, and it is read from `ps` like the start
  time, so it can go unanswered on its own; the record is kept for an incarnation
  that can make the comparison rather than signalled on a guard that did not run.
- `ProcessReaper` validates a durable record's numbers before signalling them.
  `pgid: 0` reached `process.kill(-0, "SIGKILL")`, which signals this host's own
  process group; POSIX now requires a safe `pgid` above 1 equal to `pid`, and
  Windows requires `pgid: null`, with the check repeated inside each `killTree`.
- Windows records now reach `taskkill` through `reap`. They carry `pgid: null`,
  which was refused as `no-group` before `killTree` was consulted, so
  `windowsSystem` was unreachable and every Windows orphan was retired
  unsignalled. Windows remains outside the 1.0.0-rc.0 support contract and this
  path is unsupported best-effort.
- Moved the package's published documentation into `docs/` and `docs/Manifest.ts`.
  `docs/pages/api/platform-node.md` is generated from package sources and said,
  until now, that the package "adds no implementation of its own".

### Removed

- `NodeHttpTransport` is gone. An outgoing request is Effect's `HttpClient`,
  and `NodeHost.layer` now provides `@effect/platform-node`'s
  `NodeHttpClient.layerUndici` directly. Undici installs no redirect
  interceptor, so every hop stays a separate request `@smthrs/kernel` can
  authorize. `NodeHost` re-exports `NodeHttpClient` for selective wiring.
- `NodeShell` is gone. Process execution is Effect's `ChildProcessSpawner`, and
  `NodeHost.layer` now provides `@effect/platform-node`'s implementation of it
  directly. The wrapper's one extra feature, `timeoutMs`, is `Effect.timeout`
  around any effect.
