# Mutation coordinator lifecycle

Run this supplemental probe as an ordinary user in a new delegated Linux service:

```sh
systemd-run --user --quiet --wait --pipe -p Delegate=yes \
  /usr/bin/python3 \
  "$PWD/packages/backend/microsandbox/testdata/mutation_coordinator/probe.py" \
  "$PWD/packages/backend/microsandbox/guest/smithers-guest.py"
```

Use `smthrs environment exec NAME --` for a saved execution environment, with
paths available there. `result.json` records the `beaver` run. The probe removes
its processes, cgroups and fixture directories.

The real coordinator and journal run with kernel cgroups, pipes and forks. A
caller inside the writer cgroup sends 280,000 bytes and receives 320,000 bytes;
freezing before input completes or emitting before thaw would deadlock. Four
more cases kill the coordinator during input, partial mutation, settled commit
before thaw, and after thaw. A fresh coordinator collects the orphan worker and
recovers. An outside save after thaw remains unchanged. A sixth case exercises
the existing `kill-all` entry point: it collects the mutation worker while
preserving the pending fence and freeze for recovery. Control-failure diagnostics
are expected for the intentionally killed processes.

Root identity, account lookup, directory ownership and credential dropping are
substituted for uid1000 delegation; the kernel uid stays ordinary. Non-dumpable
worker state uses the real kernel call, but no root-to-agent transition or
root-owned journal isolation is proved. These are not privileged-machine,
machine-reboot, authenticated HTTP/coding, filesystem-alias, external-service
or already-executing-kernel-I/O receipts. The candidate remains unexposed by the
production write gate.
