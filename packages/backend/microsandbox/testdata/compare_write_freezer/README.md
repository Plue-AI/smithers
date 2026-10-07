# Supplemental writer-pause probe

This tests one prerequisite of a possible repair to the disabled S1 file writer
(#3508). It does not implement or qualify a mutation provider. It runs only as
an unprivileged user on Linux with cgroup v2 delegation and io_uring available.
Never run branch-built probes as root.

From this directory, compile into a disposable directory:

```sh
probe_dir=$(mktemp -d)
cc -Wall -Wextra -Werror -O2 queued-write.c -o "$probe_dir/queued-write"
systemd-run --user --quiet --wait --pipe --collect --property=Delegate=yes --property=RuntimeMaxSec=25s python3 "$PWD/probe.py" "$probe_dir/queued-write" ordinary
systemd-run --user --quiet --wait --pipe --collect --property=Delegate=yes --property=RuntimeMaxSec=25s python3 "$PWD/probe.py" "$probe_dir/queued-write" sqpoll
rm "$probe_dir/queued-write"
rmdir "$probe_dir"
```

The Python supervisor creates only its own child cgroup inside the new delegated
user service. Its
writer enters that child before submitting a linked poll-and-write request to
io_uring. After `cgroup.events` reports `frozen 1`, the supervisor makes the pipe
readable. The file must remain `original\n` for two seconds while frozen and
become `outside-latest\n` after thaw. The latter is a positive control: an
unsupported or broken queued write cannot produce a passing result. Cleanup
thaws and reaps the writer and removes the child cgroup and file directory.

Both modes passed on the supplemental Linux host as uid 1000, kernel
`7.0.0-38-generic`, on 2026-10-06. This checks queued poll-and-write requests,
not every kernel I/O path. It is not evidence for the production guest kernel,
already executing direct I/O, whole-patch recovery, or fresh/retained-machine
privilege and startup boundaries. No production gate is affected.
