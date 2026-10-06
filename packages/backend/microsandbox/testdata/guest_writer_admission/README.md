# Managed guest writer admission

This supplemental Linux probe exercises the production `run_managed_child`
supervisor with real processes and cgroup v2. A filesystem write and home
initialization launched into an already frozen parent make no changes until
thaw. Cancellation kills a writer that detached with `setsid`, and the helper
collects its cgroup before returning.

The probe also exercises the root metadata mode and real root-recipe dispatch,
with instrumented root identity and a test recipe pin. The kernel uid remains
ordinary throughout. Root metadata waits for thaw; cancelling a recipe or
finishing it collects detached descendants. Killing its supervisor leaves a
writer that the aggregate freeze still stops, followed by explicit collection.

Run as an ordinary user on a Linux host with a delegated systemd user manager,
from the repository root:

```sh
systemd-run --user --quiet --wait --pipe -p Delegate=yes \
  /usr/bin/python3 \
  "$PWD/packages/backend/microsandbox/testdata/guest_writer_admission/probe.py" \
  "$PWD/packages/backend/microsandbox/guest/smithers-guest.py"
```

For a saved remote environment, use `smthrs environment exec NAME --` with
the same argv and absolute paths in that environment. The probe refuses root
and requires a new disposable delegated service. It removes its processes,
cgroups and temporary files on completion or failure.

`result.json` records the run on the saved `beaver` environment. The directory
ownership and credential-drop seams are explicitly substituted for the user
delegation; this is not a privileged guest or microVM acceptance receipt.
It proves lifecycle behavior with substituted credentials, not real privileged
setup or package installation. It does not prove exclusion of services started
through external IPC, already executing kernel I/O, whole-patch settlement,
transaction crash recovery, or the fresh/retained security boundary.
Compare-and-write remains disabled.
