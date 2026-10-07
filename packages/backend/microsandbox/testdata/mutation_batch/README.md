# Mutation worker and journal

This supplemental probe invokes the private batch worker against real files
while a real Linux cgroup freeze holds a competing writer. It checks a stale
later path, an ancestor move delayed until commit, and recovery after killing
the mutation worker during a partial patch. Each case resumes the outside
writer after settlement as a positive control.

Run only as an ordinary user in a new delegated systemd user service:

```sh
systemd-run --user --quiet --wait --pipe -p Delegate=yes \
  /usr/bin/python3 \
  "$PWD/packages/backend/microsandbox/testdata/mutation_batch/probe.py" \
  "$PWD/packages/backend/microsandbox/guest/smithers-guest.py"
```

For a saved execution environment, use `smthrs environment exec NAME --` with
those arguments and paths in that environment. Processes, cgroups and fixture
directories are removed after the run. `result.json` records the `beaver` run.

The probe supplies exclusion manually and substitutes the supplementary-group
query. It does not exercise an installed privileged coordinator, credential
drop, authenticated HTTP/coding transport, machine restart, services launched
through external IPC, or already executing kernel I/O. The private worker has
no production caller. These results are not C-COL-01 or security qualification;
compare-and-write remains disabled.
