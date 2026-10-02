# T-MCH-01 Measure VM memory on 24 and 32 GB; capacity formula

Stage W0, S2 · Size M · Depends on — · Unblocks T-MCH-06 · Issue: to file
Spec: spec.md §8.2.1, §8.2.2, §8.6.1, §10.3.1, §14.3 (Settings), §18, §20.2 · Delta: delta.md §1 (host profile row), §3 (capacity row) · Product: mvp.md §6.7 Capacity and queue, §9, M-06

## Goal

Every machine limit (capacity, machine memory, vCPUs, layer budget) is computed from the host profile the install detects at start with the spec.md §8.2.1 formula, never from a Mac model, and recorded runs on two hosts calibrate the reserve and the per-machine memory.

## Scope

In:
- A host profile detected at start (§8.2.1): `hw.memsize`, `hw.perflevel0.physicalcpu` (performance cores) plus `hw.physicalcpu`, free disk on the `$STATE` volume, the macOS version and Hypervisor.framework availability. Nothing reads `hw.model` or a table of machine models.
- The §8.2.1 formula, with all sizes in GiB:

  ```
  machine_mem  = 8, or 6 when host memory < 24
  machine_cpus = clamp(perf_cores / 2, 2, 4)
  capacity     = max(1, min(floor((mem − reserve) / machine_mem),
                            floor(perf_cores / 2),
                            floor((free_disk − 40) / 32)))      reserve = 8
  layer_budget = min(48, 25 % of free_disk)
  ```

  The disk term's 32 GiB per machine and 40 GiB floor are the per-machine disk size and the free-space floor the runtime uses. The spec's three example profiles give capacity 2, 3 and 6.
- A layer-prepare VM counts as one machine against capacity while it runs (§8.2.2).
- Owner setting: the owner may lower capacity and may not raise it above the formula (§8.2.1). The clamp applies on every read, so a smaller host after a restore lowers it.
- The profile and the resulting limits appear in Settings (§14.3) and `smthrs host status` (§20.2), and `machines {in_use, capacity}` appears in the `home` topic (§7.2).
- W0 calibration: C-SPK-05 runs on two hosts with different memory sizes (24 and 32 GB are the expected examples). It calibrates the reserve and the per-machine memory, never the formula's shape, and adds no host-specific rule (§8.2.1).

Out:
- The admission queue, positions and release (T-MCH-06).
- The `parallel` setting, its default (§10.3.1) and its clamp (T-STK-03).

## Changes

- `packages/backend/microsandbox/hostprofile.go` (new): `type HostProfile {MemoryBytes, PerfCores, PhysicalCores, DiskFreeBytes, MacOSVersion, Hypervisor}`, `Detect()` (macOS `sysctl` and `statfs`), a pure `Sizing(HostProfile) Sizing` holding the reserve and per-machine memory as the only calibrated constants, and `Clamp(owner, formula int) (int, error)`.
- `apps/backend/isolation.go:147` `microVMConfig`: fill `CPUs`, `MemoryMiB`, `MaxRunningVMs` and `LayerBudgetBytes` from `Sizing`; the per-machine disk (32 GiB) and free floor (40 GiB) are named constants shared with the formula. Delete the `SMITHERS_MICROVM_CPUS`, `_MEMORY_MIB`, `_DISK_MIB`, `_MAX_RUNNING`, `_LAYER_BUDGET_GIB` and `_MIN_FREE_GIB` overrides (`:168-197`). The owner capacity setting, stored with the install settings T-INS-06 adds, replaces the cap override.
- `packages/backend/microsandbox/runtime.go:219-240` `applyDefaults` and `layers.go:76-100` `defaults`: the fixed defaults (4 CPUs, 8,192 MiB, 3 VMs; prepare 6 CPUs and 12,288 MiB; 48 GiB budget) go. A zero value is a programming error, refused at start.
- `scripts/spikes/mch-01-memory/run.sh` (new): the C-SPK-05 calibration run. It moves to `scripts/perf/` (new) if T-REL-01 reuses it.
- Tests that pin the old defaults: `packages/backend/microsandbox/parameters_unit_test.go:169-183`, `apps/backend/isolation_test.go`.
- Docs: `packages/backend/microsandbox/README.md` (VM shape and layer budget sections); `pnpm docs:sync`, `pnpm docs:check`.

## Tests

- unit (`packages/backend/microsandbox/hostprofile_test.go`, new): a table over synthetic profiles, not Mac models, that includes the three §8.2.1 example columns and every edge: memory on both sides of 24 GiB, performance cores from 2 to 16, free disk on both sides of the disk term and of the 25 % layer budget. Every output equals the formula. This is C-MCH-04.
- unit: `Clamp` keeps lower owner values, reduces higher ones, and refuses 0 and negatives.
- unit (`apps/backend/isolation_test.go`): `microVMConfig` uses an injected profile. A detection error refuses start with a typed message and never falls back to a constant.
- integration (real PostgreSQL, `packages/backend/internal/services/install_capacity_integration_test.go`, new): the owner lowers capacity; a non-owner is refused (§5.2); a stored value above a smaller host's formula reads back clamped.
- spike (two hosts): C-SPK-05.

## Acceptance

- [C-SPK-05](../checks/C-SPK-05.md): the calibration runs fix the reserve and per-machine memory, with swap and pressure inside the thresholds at the formula's sizes.
- [C-MCH-04](../checks/C-MCH-04.md): the profile, formula and clamp hold across synthetic hosts, including the three §8.2.1 examples, and the owner can lower but not exceed.

## Risks and notes

- One reserve doesn't fit both hosts: the smaller host needs a larger reserve. Confirmed if C-SPK-05's effective reserve differs by more than 2 GiB between hosts. The tech lead then records new constants in spec.md §8.2.1; the formula's shape stays, and a third host size checks the result.
- Resolved (tech lead): the layer-prepare VM is sized like one machine (§8.2.2). If a layer build fails out of memory, the run reports it and T-MCH-01's calibration revisits the machine memory, not this exception.
- Asleep machines keep their disks (§8.4.3), and disk use grows with branches, not with capacity. The 32 GiB per-machine disk is a ceiling, so N retained disks can exceed free disk. Confirmed by summing allocated disk bytes after 20 merged TODOs within 24 h. Cleanup (T-MCH-09) is the only limit.
- Every perf and spike artifact records the host profile, because the reference host is the team's Mac mini, whatever its size.
