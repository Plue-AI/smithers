# T-MCH-01 Qualify machine sizing on 24 and 32 GB hosts; one host-profile reader

Stage W0, S2 · Size S · Depends on W0: — · S2: T-INS-06, T-INS-08 · Unblocks T-MCH-06, T-REL-02 · Issue: [#3470](https://github.com/smithersai/smithers/issues/3470)
Spec: spec.md §8.2.1, §8.2.2, §14.3 (Settings), §20.2 · Delta: delta.md §1 (host profile row), §3 (capacity row) · Product: mvp.md §6.7, §9, M-06

Rescoped by the minimal-code synthesis, 2026-10-03 (v2 "Reuse named in tickets": T-MCH-01 is qualification only; v1 §6 host-profile readers 3 → 1).

## Goal
The sizing code landed in `56c3fb2f4` is qualified on two hosts: recorded runs on 24 GB and 32 GB Macs fix the reserve and per-machine memory, and every machine limit still comes from the one Go host profile.

## Scope
In: the C-SPK-05 calibration runs on two hosts; the C-MCH-04 qualification of the landed formula and owner clamp; collapsing the host-profile readers to one.
Out: admission, positions and release (T-MCH-06); the `parallel` setting (T-STK-03); folding `routes/host_status.go` and `/api/host` into `GET/PUT /api/install`, which is T-INS-06's.

## Changes
- Use as is (landed `56c3fb2f4`): `packages/backend/microsandbox/hostprofile.go` (`HostProfile`, `Detect`, `Sizing`), `capacity.go`, `services/install_capacity.go` and their tests. Change only the calibrated constants if C-SPK-05 requires it, and record them in spec.md §8.2.1.
- Reshape, host-profile readers 3 → 1: the Go profile is the only hardware reader. The `hostProfile()` and health-line parsing in `scripts/checks/run-check.mjs:237-268` (`SMITHERS_CHECK_HEALTH_FILE`, added by `86deb6462`) go with that runner under v2 ruling 3; receipts that need host facts read them from the install API. `packages/testing/src/HostSuite.ts:57` `HostProfile` declares host capabilities for a conformance suite, not hardware, and stays.
- Reuse `scripts/spikes/mch-01-memory/` for the calibration run; delete the harness after the verdict is recorded, keeping the verdict file.
- New: none.

## Tests
- Use as is: `hostprofile_test.go` (synthetic profiles incl. the three §8.2.1 examples and every edge), `capacity_unit_test.go` and `install_capacity_integration_test.go` (owner lowers capacity, non-owner refused, stored value clamped on a smaller host). These are the C-MCH-04 evidence.
- Spike, two hosts: C-SPK-05 with swap and pressure recorded at the formula's sizes; each artifact records the host profile.
- Regression: no script or package outside `microsandbox/` runs `sysctl hw.memsize` or reads `os.totalmem()` to size machines (`git grep` in the check).

## Acceptance
- [C-SPK-05](../checks/C-SPK-05.md): the calibration runs fix the reserve and per-machine memory, with swap and pressure inside the thresholds.
- [C-MCH-04](../checks/C-MCH-04.md): the profile, formula and clamp hold across synthetic hosts; the owner can lower but not exceed.

## Risks and notes
- Risk: one reserve does not fit both hosts. Confirmed if C-SPK-05's effective reserve differs by more than 2 GiB between hosts. The tech lead records new constants; the formula's shape stays.
- Retained disks can exceed free disk after many merged TODOs; T-MCH-06's per-grant disk re-check and T-MCH-09's cleanup cover it.
