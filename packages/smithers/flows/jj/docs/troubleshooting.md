---
title: "Troubleshooting"
description: "Every failure @smthrs/jj reports, grouped by code: the symptom you see, what caused it, and what to change."
---

Every failure this package produces is a `JjError` with one of six codes.
Find the code, then the message, and read the matching section. Two of them,
`not_installed` and `unsupported_version`, can fail a CLI layer while it is
built rather than an operation, so the program never receives `Jj` at all. The
codes and how they are assigned are in
[How a jj failure is reported](./concepts/failures.md).

## not_installed

### "No jj on PATH. Install jj ... or set SMITHERS_JJ_PATH."

**What happened.** The Node or Bun layer spawned `jj` and the operating system
found nothing by that name. The resolver already knew why, so the failure says
it rather than leaving you to run `doctor` for the same fact. The `cause`
carries `code: "ENOENT"`.

**What to change.** Install jj, or set `SMITHERS_JJ_PATH` to a working binary.
See [Installation](./installation.md).

### "Cannot execute the jj binary at ... Run: chmod +x ..."

**What happened.** `SMITHERS_JJ_PATH` names a file that exists but the
operating system will not execute. The override stays authoritative on purpose,
so a broken explicit path is reported instead of a different binary being
silently substituted.

**What to change.** Run the `chmod` the message prints. On macOS the message
also prints the `xattr -d com.apple.quarantine` command, because a downloaded
binary refuses to run with an error that names neither the attribute nor the
fix. Or point `SMITHERS_JJ_PATH` at a working jj. See
[Choose which jj binary runs](./guides/choose-the-jj-binary.md).

### "jj is not available in the browser"

**What happened.** One of two things, and the failing `method` tells you which.

If the method is `revert`, you called the one contract operation the compiled
WebAssembly ABI has no operation for. Every other operation on
`BrowserJj.layer` works.

If the method is anything else, the composition provided
`BrowserJj.layerUnsupported`, the layer for a host that ships no wasm module. In
both cases the `command` field names the jj command the CLI adapter would have
run.

**What to change.** For `revert`, either use `restore` to rewind to a recorded
change id, or run the operation on a host with the jj command line. For the
rest, if the page should be able to run jj, provide
`BrowserJj.layer({ fs, wasm })` with a compiled module and a synchronous
filesystem. See [Run jj in a browser tab](./guides/run-jj-in-a-browser.md). If
the host genuinely cannot, this is the intended answer and callers should treat
the code as "unsupported here".

### "not_installed: Jj.\<method>: jj is not available on this host"

**What happened.** A test reached a method that `makeNoop` or `layerNoop` did
not override. The failing default is deliberate: it names the call the test
never meant to allow, instead of returning a silent success.

**What to change.** Add the method to the overrides object, or fix the code
under test if the call was not supposed to happen. See
[Test code that depends on Jj](./guides/testing.md).

## invalid_ref

### "jj \<method>: empty revision string"

**What happened.** An empty string was passed as a revision to `restore`,
`diff`, `revert`, or `workspaceAdd`. It is refused before jj is spawned,
because jj's own answer would be an argument-parser usage error that classifies
as `unknown`, and the two layers must agree on durable error identity. The
`command` names the operation that would have run.

**What to change.** Pass a commit id, a change id, `@`, or `@-`. Check the upstream code path that produced the empty string: a change
id read from an empty journal field is the usual source.

### "jj \<method>: \"...\" is not a commit id or change id"

**What happened.** The revision was neither `@`, `@-`, a hex commit id, nor a
reverse-hex (`k`-`z`) change id. The Node and Bun layers refuse it before jj is
spawned, because jj would read it as a revset and could act on commits other
than the one the journal recorded.

**What to change.** Pass the `commitId` that `snapshot` returned. Resolve a
bookmark or revset to its commit id yourself before handing it to `Jj`.

### "jj \<method>: refusing to run with unmigrated repository config"

**What happened.** The checkout holds `.jj/repo/config.toml` without
`.jj/repo/config-id`, or `.jj/workspace-config.toml` without
`.jj/workspace-config-id`. jj would import that file into its trusted config
store on its next command. Anything running in the checkout can write it, so
the Node and Bun layers refuse to run rather than let it choose aliases or
templates for the engine's commands.

**What to change.** Read the named file. If you wrote it, run any jj command in
the checkout yourself to import it, then retry. Otherwise delete it.

### "jj snapshot: ... are not a commit id, change id, and operation id"

**What happened.** jj printed something other than ids for `snapshot`'s
templates. A `template-aliases` entry in jj's config for this repository
redefines `commit_id` or `change_id`.

**What to change.** Run `jj config path --repo` and remove the alias.

### A revision that does not resolve

**What happened.** The id does not name exactly one commit in this repository:
it matches nothing, a prefix matches several, or a change id is divergent. The
Node and Bun layers look an id up with `exactly(commit_id(…), 1)` or
`exactly(change_id(…), 1)`, so a bookmark or tag named after the id is never
used in its place. A `revset-aliases` entry for `commit_id(x)` or `change_id(x)`
in jj's config for this repository does change the lookup; check
`jj config list revset-aliases`.

**What to change.** Confirm the id exists in the repository the layer is bound
to. A bound layer and an unbound one can be looking at different checkouts;
`NodeJj.layerAt(root)` makes that explicit. On the browser layer, a mistyped
`root` silently creates a fresh empty repository, so a known change id then
reports `invalid_ref` rather than "no repo".

## conflict

**What happened.** The repository refused because the operation would conflict.
The message carries jj's own diagnostic line.

**What to change.** Resolve the conflict in the working copy, or pick a
different target revision. The classification matches only on a line jj opened
with `Error:` or `Caused by:` and only where `conflict` is a whole word, so a
branch named `conflict-fix` or a path named `docs/conflict-resolution.md` does
not produce this code.

## snapshot_refused

### "Warning: Refused to snapshot some files: ..."

**What happened.** jj skipped at least one file while capturing the working
copy, and exited successfully anyway. The Node and Bun layers read that warning
and fail the operation with `snapshot_refused`: a snapshot that quietly dropped
a file is not one a run can restore from. Both layers already pass
`--config snapshot.max-new-file-size=0` on every command, so the default 1 MiB
new-file limit is not what produced it.

**What to change.** Read the list jj printed in the message: it names every
file it skipped and why. Fix or remove those files and snapshot again. The
change jj did record is missing them, so a later `restore` cannot bring them
back.

## unsupported_version

### "jj requires version 0.39.0 or newer; found ..."

**What happened.** A CLI layer probed `jj --version` before exposing `Jj`, and
the binary it resolved is older than `NodeJj.minimumVersion` or printed a
version string this package cannot parse. The failure is in the layer, so no
operation ran and the program never received the service.

**What to change.** Upgrade jj with `brew upgrade jj` or
`cargo install --locked jj-cli`, or point `SMITHERS_JJ_PATH` at a newer binary.
Probe results are cached per absolute path for the lifetime of the process, so
restart it after replacing a binary in place. See
[Choose which jj binary runs](./guides/choose-the-jj-binary.md).

## unknown

`unknown` is everything jj reported that the vocabulary does not classify. Read
the message: it carries jj's own text.

### "There is no jj repo in ..."

**What happened.** The Node layer ran in a directory that is not inside a jj
repository.

**What to change.** Run `jj git init` there, or bind the layer to a real
repository root with `NodeJj.layerAt(root)`. The browser layer behaves
differently on purpose and creates a repository instead.

### "jj \<method>: cannot run in \<path>: not a directory"

**What happened.** The bound repository root is gone, or names a file. The
adapter probes the working directory before it blames the binary, because
`spawn` reports a missing directory as `ENOENT`, which is indistinguishable
from a missing binary.

**What to change.** Fix the path passed to `layerAt` or `layerSpawnerAt`, or
recreate the checkout.

### "jj \<method>: output exceeded the 67108864-byte ceiling"

**What happened.** One invocation produced more than 64 MiB on a single output
stream. The child was killed rather than read further. The engine is a
long-lived process and a child's output is unbounded, so a command that never
stops printing would otherwise be a memory leak no caller can see.

**What to change.** Narrow the request. A `diff` across a very large range is
the usual cause, and output that size is not something a run can journal
anyway. Both Node layers apply the identical ceiling, so switching to
`layerSpawner` does not raise it.

### A lane directory that could not be created

**What happened.** `workspaceAdd` was given a path jj cannot create, such as a
directory nested under a regular file. The message carries jj's reason.

**What to change.** Pass a path whose parent is a directory you can write. No
workspace is registered and no directory is left behind, so the call is safe to
retry with a corrected path.

### "malformed ABI response" or "failed to instantiate flows_jj.wasm"

**What happened.** The browser layer could not talk to the module it was
handed. Either the bytes are not the `flows_jj` reactor (the message names every
missing export), or the module trapped. A Rust panic arrives on the `onStderr`
sink you passed.

**What to change.** Confirm you are serving this package's
`wasm/flows_jj.wasm` and that the bytes are not truncated by the bundler.
Instantiation is retried per operation, but always with the module read the
first time, so swapping `options.wasm` after the first failure changes nothing.

### "the wasm module could not allocate a request buffer"

**What happened.** The guest ran out of linear memory. The exchange refuses
before touching memory rather than writing at address zero and calling with a
bogus pointer.

**What to change.** Reduce the size of the operation, or give the tab more
headroom. A very large working copy in a page is the usual cause.

## PermissionError instead of JjError

**What happened.** The composition includes the kernel's `Jj.layer`, and the
run has no grant for the capability that operation needs
(`jj:snapshot`, `jj:workspace-add`, and so on). `workspaceAdd` also needs
`fs:write` on the canonicalized destination.

**What to change.** Grant the capability, or narrow what the step tries to do.
Branch on it in code with `isJjError`, which is false for this half of
`JjFailure`. The full list of capabilities and their tiers is in
[Version control as a capability](./concepts/version-control-as-a-capability.md#the-grants-the-kernel-checks).

## Not errors, but surprising

### restore removed work I wanted to keep

`restore` replaces the working copy with the recorded tree. Uncommitted edits
are overwritten and files created after the snapshot are removed. If you meant
"undo that one change and keep the rest", use `revert`. See
[Snapshot a working copy and put it back](./guides/snapshot-and-restore.md#which-one-to-use).

### workspaceForget left the directory behind

Forgetting drops the workspace registration and does not touch the commits made
in the lane or the directory on disk. Removing the directory is the caller's
job, on both backends.

### Browser operations reject real symlinks

Remove real symlinks from the working copy, including ignored directories,
then retry. `BrowserJj` rejects them before any operation that snapshots,
because the shipped reactor would otherwise persist target bytes. Existing
tree symlinks still check out as regular files containing link text. See
[Run jj in a browser tab](./guides/run-jj-in-a-browser.md#real-symlinks-are-rejected).

### Browser changes vanished after a reload

The layer does not own the mount and never syncs for you. ZenFS writes back to
OPFS or IndexedDB asynchronously, so an operation returning does not mean bytes
reached storage. Call your mount's `sync` after operations that must survive a
reload.

### A JjError constructor threw

`new JjError` validates its schema, and a `cause` field longer than
`causeMessageLimit` (1024 characters) is rejected at construction as well as at
journal decode. Project arbitrary host failures with `jjErrorCause`, which
truncates each field to fit.

### layerAt threw a TypeError

```text
TypeError: NodeJj.layerAt requires an absolute repository root: ./checkout
```

A relative repository root is a wiring mistake rather than a runtime condition,
so it is refused at construction instead of failing later. Pass an absolute
path. `layerSpawnerAt` behaves the same way.
