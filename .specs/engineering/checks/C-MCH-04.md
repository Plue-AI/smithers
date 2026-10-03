# C-MCH-04 Capacity formula on 24, 32 and 64 GB; the owner can lower it but not exceed it; capacity 0 names its fix

Proves: mvp.md M-06, §6.7 Capacity and queue · spec.md §8.2.1, §8.2.1a, §8.2.2, §5.2 (install settings: owner) · Layer: unit · Stage: S2 · Tickets: T-MCH-01
Automation: `packages/backend/microsandbox/hostprofile_test.go` (new), `packages/backend/internal/services/install_capacity_integration_test.go` (new; the owner-setting cases run against real PostgreSQL) · Runs in: CI

## Setup

- `Sizing(HostProfile)` and `Clamp(owner, formula)` from `packages/backend/microsandbox/hostprofile.go` (new), implementing the §8.2.1 formula with reserve 8 GiB and machine memory 8/6 GiB, or the values C-SPK-05 calibrated; the test pins smithers-8a-approved constants and literal expected outputs in independent fixtures; it never reads spec files or implementation constants to derive expectations at runtime.
- Synthetic profiles only: memory as exact byte counts the way `hw.memsize` reports them, performance and physical core counts, free disk bytes. No Mac model names.
- Owner-setting cases: real PostgreSQL 18 (`SMITHERS_REQUIRE_DATABASE_TESTS=1`), an owner, a maintainer and a member, and a profile injected into `microVMConfig` (`apps/backend/isolation.go:147`).

## Steps

1. Table test of `Sizing` over the three §8.2.1 example profiles and these edge profiles (memory GiB / performance cores / free disk GiB): 16/8/200, 23/8/200, 64/12/136, 128/4/2,000, 32/10/60, 32/10/100, 13/8/200, 16/1/200, and a sweep of memory 8–192, performance cores 2–16 and free disk 40–2,000.
2. Table test of `Clamp` with formula 3 and owner values 1, 2, 3, 4, 0 and −1.
3. Integration: the owner sets capacity 1 on the 32/10/400 profile. Read it back. Restart with the 24/8/200 profile. Read it back.
4. Integration: the owner sets capacity 4 on the 32/10/400 profile.
5. Integration: the maintainer and the member each try to set capacity.
6. `microVMConfig` with a profile detector that returns an error.
7. `rg -n 'hw\.model' packages/backend apps/backend` and `rg -n 'SMITHERS_MICROVM_(CPUS|MEMORY_MIB|DISK_MIB|MAX_RUNNING)' packages apps`.
8. Start a fresh install (no owner) on each zero-capacity profile of step 1 (32/10/60, 13/8/200, 16/1/200). Then start an install that has an owner on 32/10/60 and request a machine.

9. Exercise built-bundle smthrs host start/status, the authenticated install-settings HTTP route through the production router, the Settings Container and a real home subscription; inject only host detection. Check the literal expected limits and owner-only writes. T-MCH-06 owns queue-position checks; they do not block T-MCH-01.

## Pass when

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

## Fail when

- A value is chosen by Mac model or by a size lookup table instead of by the formula.
- Capacity ignores the core or disk term, so 128/4/2,000 yields 15.
- Capacity is floored at 1, so a host that can't run one machine boots one anyway.
- Raising above the formula is stored and clamped silently at read time, so the owner believes capacity is 4.
- GB and GiB are mixed, so a spec column's row differs.

## Evidence

`.artifacts/checks/C-MCH-04/<UTC timestamp>/`: `go test -json` output for both files, the generated table of inputs and outputs (CSV), the `rg` output of step 7, the commit, and the coverage profile for `hostprofile.go` (100% of statements).
