# T-RMT-01 Spike: a macOS install runs a microVM workspace on a Linux KVM host over SSH

Stage W0 · Size S · Depends on — · Unblocks T-RMT-02, T-RMT-03, T-RMT-05 · Issue: [#3706](https://github.com/smithersai/smithers/issues/3706)
Spec: spec.md §8.13.3, §8.13.7, §8.13.8 · Product: #3706 Product position (M-40 pending in mvp.md)

Added 2026-10-04 by smithers-8a for Will's sandbox-placement ruling (#3706). Behind `remoteSandboxes`, off by default.


**REPLACED (2026-10-04, Will via smithers-56, #3706):** smithers-56 spikes the Plue Cloud controller and worker on `beaver` instead (§8.13.0). Do not start this SSH spike.

## Goal
A recorded run proves the §8.13 path before any product code: from Will's Mac mini, one SSH connection to `beaver` starts the pinned `msb` guest image (x86_64), the in-guest Flow host reaches the install's journal database and model proxy through reverse forwards on the remote loopback, and egress leaves through the install's egress relay.

## Scope
In: a throwaway harness under `scripts/spikes/rmt-01/`; the x86_64 guest image build from the existing recipe; one Cloud box with nested KVM tried the same way; timings for boot, a `pnpm install` of the Smithers repo and a 1 GiB download through the relay.
Out: any product code, settings, UI or scheduler change.

## Changes
- New, disposable: `scripts/spikes/rmt-01/` (one command). Delete it after the verdict; keep `verdict.md`.
- Reuse: the pinned `msb` 0.6.16 and the recipe of §8.6; `flowhost/journal_database.go` and `flowhost/model_credential.go` endpoints as they are.

## Decisions and pre-review
- smithers-3f reviews the forward binding and the egress path. smithers-8a records the verdict in spec §8.13.7 and §8.13.8.

## Tests

C-RMT-01:
1. Boot the guest on `beaver` over SSH from the Mac mini; run the Flow host health probe inside it.
2. Inside the guest, connect to the journal database and the model proxy through the reverse forwards; from another process on `beaver`, try the same ports on a non-loopback address.
3. `pnpm install` of the Smithers repository inside the guest through the install's egress relay; record wall time against the same install on `this-mac`.
4. Kill the SSH connection mid-run; confirm reconnect within 5 s and that the guest keeps running.
5. Repeat step 1 on one Smithers Cloud box (nested KVM).

Pass when:
- Steps 1, 2 and 4 pass; step 2's non-loopback attempt is refused.
- Step 3 records both timings; `verdict.md` states whether the relay path is within 2x of local.
- Step 5 records yes or no for nested KVM, which picks §8.13.8's branch.

## Acceptance
- [C-RMT-01](../checks/C-RMT-01.md)

## Risks and notes
- `beaver` is x86_64; the guest image and `toolchains.json` need an amd64 build. If the relay path is too slow, the fallback is direct egress from the remote host with relay audit only, which changes §8.13.7 and needs a ruling.
