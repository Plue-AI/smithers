# Watcher overflow fixture

Build this executable from the accepted `main` revision into the trusted guest
image. Never run a branch-built copy as root. It is a test fixture, not production
watch-limit tuning, and executes no repository command.

Start it as root with **no arguments**, keeping stdin open. Wait for `ready` on
stdout before creating the watcher: inotify snapshots `max_queued_events` when
its instance is created. Run C-COL-05's workload through the authenticated
member session. Close helper stdin after the workload; wait for successful exit
before proceeding. EOF, SIGINT, SIGTERM and SIGHUP restore the saved kernel
value. SIGKILL cannot run cleanup; discard that guest rather than reusing it.
Keep a separate control channel for the helper; do not pipe repository output
into it or grant repository processes root access.

Only `/proc/sys/fs/inotify/max_queued_events` is opened. The reduction is the
literal `64`; restoration uses the validated value read from that kernel file.
No arguments or environment settings select a path, value, or executable.

`go test ./scripts/spikes/col-04/overflow-sysctl -run TestWatcherOverflowSysctlInputs`
checks refusal and cleanup with an injected kernel file. It does not change this
host's sysctl or qualify real overflow recovery. The approved-image run must
observe the actual limit, watcher overflow, re-arming, write barrier and moved-off
receipt described in T-COL-04.
