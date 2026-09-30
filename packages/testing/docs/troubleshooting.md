---
title: "Troubleshooting"
description: "The failures @smthrs/testing reports in practice: the symptom you see, the cause behind it, and the change that fixes it."
---

Every entry here is a failure this package actually raises. Each one gives the
symptom, the cause, and the fix.

## A conformance case hangs until the vitest timeout

**Symptom.** A `race/*` or `interrupt/fiber-abort` case never finishes and the
runner kills it at its own timeout. No assertion failed.

**Cause.** The case was registered under the real clock. Those pins advance
virtual time, so under `.live` they wait on a clock nothing is moving.

**Fix.** Register through `Vitest.testEffect(...).effect` or its `scoped`
alias, or through `it.effect` and `it.scoped`. Both supply a `TestClock`.
`.live` does not.

## The model died with UnscriptedModelError

**Symptom.** A test fails with a defect naming a `modelId`, a `messageCount`,
and a list of `toolNames`. `Effect.catchTag` did not catch it, and a retry
schedule did not retry it.

**Cause.** `RecordedModel` received a request the fixture does not describe.
The request shape changed: a different prompt, a different tool set, different
generation params, or a `toolChoice` that is now set.

**Fix.** Re-record the fixture, or find what changed in the request. It is a
defect on purpose: a fixture that does not describe the run is a defect in the
test rather than an outcome the code under test can handle, and a retry against
a fixture that will never match would pass or hang for the wrong reason.

The error carries a bounded identity rather than the request. To see what the
run actually asked, log the request at the call site.

## The model died with ReplayHarnessMismatchError

**Symptom.** A defect carrying `expected` and `actual` model ids.

**Cause.** The request shape matched a recorded call, but that call was
recorded against a different model. `RecordedModel` matches by shape with
`modelId` erased, then checks the model.

**Fix.** Re-record against the model the test now uses, or switch the test
back. If the intent is to tolerate a model change, use `CachedModel`, which
keys on the whole request including `modelId` and records the new model as an
ordinary miss.

## A recording run produced an empty or short fixture

**Symptom.** The fixture file exists but has no `calls`, or fewer than the run
made.

**Cause.** The recorder refuses two kinds of call. An interrupted call, or one
that died, has a truncated stream with no `settle` event and would replay as an
aborted turn. A call the kernel refused (`PermissionRequired`,
`PermissionDenied`, `GrantStoreError`) never reached the provider, so there is
no exchange to record.

**Fix.** Look for the interruption or the permission refusal first. A recording
run under a kernel that denies the model call records nothing by design, and
the failure still reaches the caller.

## A replay reads a stale set of calls

**Symptom.** A call recorded during the run is not found by the next identical
call.

**Cause.** `Fixture.index` memoizes its digest-keyed map on the fixture
**object**. `FixtureStore` replaces the whole fixture on every append rather
than mutating it, so the next lookup sees a new object and a fresh index. A
caller that mutates a fixture's `calls` array in place keeps the old object and
reads the old index.

**Fix.** Append through a `FixtureStore` rather than mutating `fixture.calls`.

## FixtureEncodingError with reason non-plain-object

**Symptom.** A recording fails with a `path` such as `$.tools[0].parameters` and
the reason `non-plain-object`.

**Cause.** Something in the request is a class instance rather than plain data.
The production `ModelRequest` is a `Schema.Class` whose messages, tools, and
params are class instances, and the canonical digest rejects any value that is
not a plain object.

**Fix.** Project the request through `Fixture.recordedRequest` before storing
or digesting it. The other reasons name their own problem: `cycle`,
`non-finite-number`, `symbol-key`, `unsupported-type`, and `too-deep` at more
than 128 levels of nesting.

## A pure plan assertion fails with purity_violation

**Symptom.** `PlanAssertions.expectPure` fails with `purity_violation` and the
`actual` field holds a `CapabilityContractError`.

**Cause.** The plan computation reached a capability under
`TestLayers.poisoned`. The error's `capability` and `operation` fields name
exactly which one: `filesystem`, `path`, `shell`, `jj`, `httpTransport`,
`model`, `clock`, or `random`.

**Fix.** Move the capability touch out of plan time. Planning must be pure, and
the poisoned services throw rather than fail precisely so an
`Effect.catch`-shaped fallback in the plan body cannot swallow the violation.

If `actual` holds a `SchemaError` instead, the input failed to decode and no
plan was ever built.

## A plan assertion fails with key_golden_mismatch

**Symptom.** `expectKeyGoldens` reports that a `key1_` digest changed.

**Cause.** Canonical key serialization drifted. Step keys are cache identity,
so the same logical input must keep producing byte-identical keys.

**Fix.** Treat it as a cache-identity break rather than a stale golden. Find
what changed in the key material before updating the golden file: a key change
invalidates every cached result recorded under the old one.

## A journal assertion fails with effect_kind_mismatch

**Symptom.** `journal.effect(key).atLeastOnce()` or `.journaledAtMostOnce()`
fails, and the message lists the kinds actually found.

**Cause.** The journal carries that key only as an ordinary step, not as an
external effect entry.

**Fix.** This is the assertion working. The effect vocabulary answers about
journaled external effects, so an at-most-once claim cannot be satisfied by a
step that happens to share the key. Either the engine did not journal the
effect, or the assertion should be `journal.executed(key)` instead.

## exactlyOnce always fails

**Symptom.** `journal.effect(key).exactlyOnce()` fails with
`ExactlyOnceUnsupportedError` no matter what the journal says.

**Cause.** It is designed to. An engine can prove at-least-once delivery and
at-most-once journaling, but it cannot prove exactly-once external effect
execution.

**Fix.** Assert `atLeastOnce()` and `journaledAtMostOnce()`, which are the two
claims the engine can actually support. The method is kept and kept failing so
the test vocabulary cannot claim a guarantee that does not exist.

## An engine subject fails everything with engine_unavailable

**Symptom.** Every operation fails with `EngineUnavailableError` and a message
naming the operation.

**Cause.** The subject is `EngineSubject.makeNoop()`, or a `layerNoop` whose
overrides do not cover the operation the case reached.

**Fix.** Provide a real subject, or extend the overrides. `makeNoop` exists so
a partial subject can declare exactly what it supports.

## A run fails with execution_conflict

**Symptom.** `run` fails with `ExecutionConflictError` naming an
`executionId` and a `field` of `flow` or `payload`.

**Cause.** The test reused an execution id with a different flow or a different
payload. Two cases in one file often share a hardcoded id.

**Fix.** Give each case its own execution id. The engine refuses rather than
silently running the original flow on the original payload, because that would
give the caller no signal that its arguments were ignored.

## The host suite fails on the scratch path

**Symptom.** The `FileSystem round-trips` case fails with a
`CapabilityContractError` naming `FileSystem` and `scratchPath`.

**Cause.** Nonrecursive directory creation found an existing scratch path.
This includes dangling symlinks, directories, and files created concurrently.
The suite reports `FileSystem/scratchPath` and leaves the existing path
untouched. Removal is registered only after successful directory creation.

**Fix.** Point the profile at a path that does not exist, or omit
`fileSystemScratchPath` entirely and let the suite build a randomized absolute path
under `/tmp` from the bundle's own `Path` and `Random`.

## The host suite fails on process cleanup

**Symptom.** The cleanup case reports `Scope/interrupt_running` or
`Scope/interrupt_cleanup`.

**Cause.** The declared `shell.interruptCommand` exited before interruption,
or the Host process handle remained running after its consumer was interrupted.

**Fix.** Supply a command that stays pending until cancelled and bind its
resource lifetime to the scope passed to `ChildProcessSpawner.spawn`. The
suite checks the real handle before and after interruption. An unsupported
shell is checked for its refusal code and does not certify cleanup.

## The host suite fails on clock or random

**Symptom.** `Clock is monotonic` or `Random produces a valid value` fails with
a `CapabilityContractError`, even though the bundle type-checks.

**Cause.** `Clock` and `Random` are `Context.Reference`s with ambient defaults,
so they cannot appear in a bundle's output type and the compiler cannot demand
them. The suite runs those two cases over a poisoned base, so a bundle that
supplies neither fails loudly instead of silently using the Effect defaults.

**Fix.** Have the bundle provide its own `Clock` and `Random`.

## killProcess reports the pid was already dead

**Symptom.** `killProcess: pid 4821 was already dead, so SIGKILL injected
nothing`.

**Cause.** The process exited before the fault was injected, usually because
the test did not wait for the state it meant to disturb.

**Fix.** Wait for the condition with `waitFor` and assert it before killing.
The error is deliberate: a suite that "killed" a corpse injected nothing and
would otherwise report green over a fault it never caused.

## CI exits 5 rather than 0 or 1

**Symptom.** `ScoreGate.ciGrade` returns exit code 5 and a summary beginning
`inconclusive:` or `passed every gate with unresolved:`.

**Cause.** The run could not be decided, or it met its gates over fewer
observations than the suite declared. A case runner threw, a judge was
unavailable, or a suite gated nothing at all.

**Fix.** Repair the harness, not the threshold. Exit 5 is not a red: it says
the suite owes an answer it could not give. The reasons list names each fault.

## A permission failure in a test that stubs nothing

**Symptom.** A test under `TestLayers.unit` fails typed on a permission
decision rather than parking on an approval.

**Cause.** The unit tier provides the **real** permission kernel, built
unattended. A sealing violation fails typed instead of suspending.

**Fix.** This is the intended behavior. A permission decision a test stubs out
is a decision the test no longer covers, so grant what the subject needs
through the store rather than removing the kernel.
