# T-RMT-03 Remote `WorkspaceRuntime`: the pinned `msb` on a registered host over one install-dialed SSH connection

Stage S1 · Size L · Depends on T-RMT-01, T-RMT-02, T-INS-02, T-FLW-01 · Unblocks T-RMT-04, T-RMT-05 · Issue: [#3706](https://github.com/smithersai/smithers/issues/3706)
Spec: spec.md §8.13.1, §8.13.3, §8.13.7, §1.3, §8.9 · Product: #3706 Product position (M-40 pending in mvp.md)

Added 2026-10-04 by smithers-8a for Will's sandbox-placement ruling (#3706). Behind `remoteSandboxes`, off by default.


**ON HOLD (2026-10-04, Will via smithers-56, #3706):** remote machines reuse the Plue Cloud controller and `microsandbox-worker`; this ticket's SSH mechanism is superseded until spec §8.13 is reconciled (§8.13.0). Do not start.

## Goal
A workspace runs on a registered remote host with the same lifecycle, execution, terminal, files and isolation as on `this-mac`, while the journal, model proxy, keys and egress relay stay on the install.

## Scope
In: a `WorkspaceRuntime` that drives the existing microsandbox runtime with an SSH command prefix; one supervised SSH connection per host with remote-loopback reverse forwards; guest images per architecture.
Out: choosing the host (T-RMT-04); Cloud boxes (T-RMT-05); any plain-SSH or container execution of repository code.

## Changes
- Reshape `packages/backend/microsandbox`: the `msb` invocation takes an optional command prefix (`ssh -o ...`) and a state directory, so one runtime type serves `this-mac` and remote hosts. Do not fork the package.
- New: a per-host connection supervisor (reconnect 250 ms to 5 s) that owns the reverse forwards for the relay, journal and model-proxy endpoints the guest uses today.
- Reshape the recipe build (§8.6) and `toolchains.json` to produce arm64 and amd64 guest images.

## Decisions and pre-review
- smithers-3f approves the forwards, the egress path and the execution boundary before this lands. smithers-22 owns the lane.

## Tests

C-RMT-03:
1. Production router, flag on, one remote host (`beaver` on the reference rig, a Linux KVM VM in CI): create, start, exec, terminal, read/write file, stop and delete a workspace there.
2. Run a TODO's coding step on the remote workspace; capture the model request at the install's model proxy.
3. From the remote host outside the guest, connect to each forwarded port on a non-loopback address.
4. Search the remote host's disk and process environment for every provider key and the journal superuser credential.
5. Drop the SSH connection for 3 s mid-step.
6. Point the runtime at a host whose `msb` is missing or whose guest fails to boot.

Pass when:
- Step 1 and 2 pass through the same Go contract tests that `this-mac` passes; step 2's model call arrives at the install proxy.
- Step 3 is refused. Step 4 finds no key.
- Step 5 reconnects within 5 s and the step finishes. Step 6 fails with a typed error and runs nothing on the host.

## Acceptance
- [C-RMT-03](../checks/C-RMT-03.md)

## Risks and notes
- Journal traffic crosses SSH; T-RMT-01's timings decide whether that is acceptable for J1/J2 budgets.
