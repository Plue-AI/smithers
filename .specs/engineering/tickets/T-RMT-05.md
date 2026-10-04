# T-RMT-05 Cloud boxes as remote hosts

Stage S2 · Size M · Depends on T-RMT-01, T-RMT-03, T-RMT-04 · Unblocks — · Issue: [#3706](https://github.com/smithersai/smithers/issues/3706)
Spec: spec.md §8.13.8, M-09 · Product: #3706 Product position (M-40 pending in mvp.md)

Added 2026-10-04 by smithers-8a for Will's sandbox-placement ruling (#3706). Behind `remoteSandboxes`, off by default.


**ON HOLD (2026-10-04, Will via smithers-56, #3706):** remote machines reuse the Plue Cloud controller and `microsandbox-worker`; this ticket's SSH mechanism is superseded until spec §8.13 is reconciled (§8.13.0). Do not start.

## Goal
The owner adds a Smithers Cloud box as a machine host behind the same flag, without Cloud billing.

## Scope
In: per T-RMT-01's verdict: either (a) register a Cloud box as a remote host through `CloudSandbox`'s SSH grant, or (b) a second `WorkspaceRuntime` adapter where the Cloud box is the machine.
Out: Cloud billing, Cloud identity changes, hosted installs.

## Changes
- (a) Reuse `packages/smithers/src/CloudSandbox.ts` for the SSH grant; no stored key. (b) New adapter over the Cloud workspaces API. smithers-8a picks (a) or (b) in spec §8.13.8 from the verdict before this starts.

## Decisions and pre-review
- smithers-3f approves the Cloud credential path. smithers-98 confirms billing stays out.

## Tests

C-RMT-05:
1. Register one Cloud box with the flag on; run C-RMT-03 steps 1 to 4 against it.
2. Revoke the Cloud grant mid-step.

Pass when:
- Step 1 passes as for an SSH host. Step 2 fails the step with class `computer_unreachable`; the row reads "Signed out · Sign in".

## Acceptance
- [C-RMT-05](../checks/C-RMT-05.md)

## Risks and notes
- Nested KVM may be unavailable on Cloud boxes; then path (b) applies.
