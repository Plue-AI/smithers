---
title: "Host capacity"
description: "Detected host resources and owner-controlled machine capacity."
---

The install measures memory, performance and physical cores, free bytes on its
state volume, macOS version and Hypervisor availability at startup. It derives
machine memory, vCPUs, capacity and the layer budget from these resources.
It stores no Mac model.

The 8 GiB reserve and 8/6 GiB machine-memory constants are an
uncalibrated default (see #3659). All sizes below use GiB:

```
machine memory = 8; 6 below 24 GiB of host memory
vCPUs          = clamp(performance cores / 2, 2, 4)
capacity       = min(floor((memory - 8) / machine memory),
                     floor(performance cores / 2),
                     floor((free disk - 40) / 32))
layer budget   = min(48, free disk / 4)
```

Negative capacity terms become zero. Every machine has a 32 GiB disk; the
free-space floor is 40 GiB. A prepare or verification machine uses the same
shape and counts against capacity until its stop or deletion is confirmed.
Runtime configuration requires explicit sizes.

The owner may lower capacity. A write above the formula is refused; every
read clamps the saved value, including after restore onto a smaller host.
Lowering prevents another boot and leaves held machines running.
The authenticated owner can PUT `/api/install` with `{ "capacity": 1 }`;
tokens require `write:user`. Invalid values are refused before persistence.

`GET /api/install` (owner only) serves the host in `this_mac`: `memory_gb`,
`disk_free_gb`, `perf_cores` and the formula `capacity`, beside the owner's
`capacity`. At formula capacity zero, `this_mac.limit` names the limiting
term (`memory`, `cores` or `disk`) and its fix, such as
`free 12 GiB on the state volume`; Settings shows both on its This Mac row,
and Home's machines line shows the owner's capacity. A fresh install refuses to start;
an install with an owner keeps serving actions that need no machine.

From a fixed checkout, run the memory calibration with prepared layers and
the host service running:

```sh
sh scripts/spikes/mch-01-memory/run.sh --state "$STATE" \
  --out "$PWD/.artifacts/checks/C-SPK-05/$(date -u +%Y%m%dT%H%M%SZ)"
```

The default loads the formula's memory term. `--machines 2 --fresh` measures
two machines with fresh disks on a third host profile. Missing pnpm and Bun
are installed at this checkout's declared versions. The script records each VM's RSS, swap,
pressure, guest memory, CPU idle, readiness latency and workload exits,
then removes only its `lane-cap-*` machines. It stops below 8 GiB free.
Results on a shared host are observations; the controlled 24 and 32 GiB
runs, idle baseline and prepare repeat remain required by C-SPK-05.
