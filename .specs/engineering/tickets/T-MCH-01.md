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
- Reshape, host-profile readers 3 → 1: the Go profile is the only hardware reader. The duplicate check runner’s hardware probe and ops-health-line parser are removed; receipts that need host facts read them from the install API. `packages/testing/src/HostSuite.ts:57` `HostProfile` declares host capabilities for a conformance suite, not hardware, and stays.
- Reuse `scripts/spikes/mch-01-memory/` for the calibration run; delete the harness after the verdict is recorded, keeping the verdict file.
- New: none.

## Tests

C-MCH-04 (folded steps and assertions):
1. Table test of `Sizing` over the three §8.2.1 example profiles and these edge profiles (memory GiB / performance cores / free disk GiB): 16/8/200, 23/8/200, 64/12/136, 128/4/2,000, 32/10/60, 32/10/100, 13/8/200, 16/1/200, and a sweep of memory 8–192, performance cores 2–16 and free disk 40–2,000.
2. Table test of `Clamp` with formula 3 and owner values 1, 2, 3, 4, 0 and −1.
3. Integration: the owner sets capacity 1 on the 32/10/400 profile. Read it back. Restart with the 24/8/200 profile. Read it back.
4. Integration: the owner sets capacity 4 on the 32/10/400 profile.
5. Integration: the maintainer and the member each try to set capacity.
6. `microVMConfig` with a profile detector that returns an error.
7. `rg -n 'hw\.model' packages/backend apps/backend` and `rg -n 'SMITHERS_MICROVM_(CPUS|MEMORY_MIB|DISK_MIB|MAX_RUNNING)' packages apps`.
8. Start a fresh install (no owner) on each zero-capacity profile of step 1 (32/10/60, 13/8/200, 16/1/200). Then start an install that has an owner on 32/10/60 and request a machine.
9. Exercise built-bundle smthrs host start/status, the authenticated install-settings HTTP route through the production router, the Settings Container and a real home subscription; inject only host detection. Check the literal expected limits and owner-only writes. T-MCH-06 owns queue-position checks; they do not block T-MCH-01.

Pass when:
- Step 1, the spec columns (machine memory, vCPUs, capacity, layer budget): 24/8/200 → 8, 4, 2, 48; 32/10/400 → 8, 4, 3, 48; 64/12/1,024 → 8, 4, 6, 48.
- Step 1, edges: 16/8/200 → 6, 4, 1, 48; 23/8/200 → 6, 4, 2, 48; 64/12/136 → 8, 4, 3, 34; 128/4/2,000 → 8, 2, 2, 48; 32/10/60 → 8, 4, 0, 15 (disk); 32/10/100 → 8, 4, 1, 25; 13/8/200 → 6, 4, 0, 48 (memory); 16/1/200 → 6, 2, 0, 48 (cores).
- Step 1, sweep: every output equals the formula computed independently in the test, and capacity is 0 exactly when one term is 0, with `Sizing` naming that term.
- Step 2 keeps 1, 2 and 3, reduces 4 to 3, and refuses 0 and −1 with a `user` error.
- Step 3 reads 1, then 1 after restart.
- Step 4 is refused with a `user` error naming the maximum (3), and the stored value is unchanged.
- Step 5 is refused with `permission` class for both.
- Step 6 refuses start with a typed message and never falls back to a constant.
- Step 7 finds nothing outside tests.
- Step 8: each fresh start refuses with the limiting term and its fix; the install with an owner starts at capacity 0, `smthrs host status` and the Settings model show the term and fix, and no machine is granted; queue-position assertions run with T-MCH-06.

Fail when:
- A value is chosen by Mac model or by a size lookup table instead of by the formula.
- Capacity ignores the core or disk term, so 128/4/2,000 yields 15.
- Capacity is floored at 1, so a host that can't run one machine boots one anyway.
- Raising above the formula is stored and clamped silently at read time, so the owner believes capacity is 4.
- GB and GiB are mixed, so a spec column's row differs.

- Use as is: `hostprofile_test.go` (synthetic profiles incl. the three §8.2.1 examples and every edge), `capacity_unit_test.go` and `install_capacity_integration_test.go` (owner lowers capacity, non-owner refused, stored value clamped on a smaller host). These are the C-MCH-04 evidence.
- Spike, two hosts: C-SPK-05 with swap and pressure recorded at the formula's sizes; each artifact records the host profile.
- Regression: no script or package outside `microsandbox/` runs `sysctl hw.memsize` or reads `os.totalmem()` to size machines (`git grep` in the check).

## Acceptance
- [C-SPK-05](../checks/C-SPK-05.md): the calibration runs fix the reserve and per-machine memory, with swap and pressure inside the thresholds.
- [C-MCH-04](../checks/C-MCH-04.md): the profile, formula and clamp hold across synthetic hosts; the owner can lower but not exceed.

## Risks and notes
- Risk: one reserve does not fit both hosts. Confirmed if C-SPK-05's effective reserve differs by more than 2 GiB between hosts. The tech lead records new constants; the formula's shape stays.
- Retained disks can exceed free disk after many merged TODOs; T-MCH-06's per-grant disk re-check and T-MCH-09's cleanup cover it.
