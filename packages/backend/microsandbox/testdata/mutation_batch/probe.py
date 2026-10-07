"""Supplemental worker/journal checks with real Linux writer exclusion.

This probe supplies the coordinator manually. It is NOT production transport,
privilege-drop, crash-recovery orchestration or already-executing-I/O proof.
Run only as an ordinary user in a new disposable delegated systemd service.
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import signal
import sys
import tempfile
import time

if os.geteuid() == 0:
    raise SystemExit("never execute branch probe code as root")
scope = pathlib.Path("/sys/fs/cgroup" + pathlib.Path("/proc/self/cgroup").read_text().strip().split("::")[1])
if not (scope.name.startswith("run-") and scope.name.endswith(".service")):
    raise SystemExit("requires a new disposable delegated user service")
spec = importlib.util.spec_from_file_location("guest", sys.argv[1])
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
# Credentials are not changed by this supplemental user-owned fixture.
guest.os.getgroups = lambda: []
H = lambda body: hashlib.sha256(body).hexdigest()
results = []


def eventually(predicate, reason):
    deadline = time.monotonic() + 5
    while not predicate():
        assert time.monotonic() < deadline, reason
        time.sleep(.01)


for case in ("later-stale", "ancestor-move", "mutation-death"):
    writers = scope / ("writers-" + case)
    writers.mkdir(mode=0o700)
    writer = None
    worker = None
    try:
        with tempfile.TemporaryDirectory(prefix="smithers-mutation-") as directory:
            base = pathlib.Path(directory)
            workspace = base / "workspace"
            workspace.mkdir()
            (workspace / "nested").mkdir()
            (workspace / "nested/a").write_bytes(b"alpha")
            (workspace / "b").write_bytes(b"beta")
            journal = base / "journal"
            journal.mkdir(mode=0o700)
            pulse, ready, request, done = [base / name for name in ("pulse", "ready", "request", "done")]
            outside = base / "outside"
            writer = os.fork()
            if writer == 0:
                try:
                    (writers / "cgroup.procs").write_text(str(os.getpid()))
                    if case == "later-stale":
                        (workspace / "b").write_bytes(b"outside save")
                    ready.touch()
                    while True:
                        pulse.write_text(str(time.monotonic_ns()))
                        if request.exists() and not done.exists():
                            if case == "ancestor-move":
                                (workspace / "nested").rename(outside)
                                (outside / "a").write_bytes(b"outside after thaw")
                            else:
                                (workspace / "b").write_bytes(b"outside after thaw")
                            done.touch()
                        time.sleep(.01)
                except BaseException:
                    import traceback
                    traceback.print_exc()
                    os._exit(125)
            eventually(lambda: ready.exists() and pulse.exists(), "outside writer did not start")
            (writers / "cgroup.freeze").write_text("1")
            eventually(lambda: "frozen 1" in (writers / "cgroup.events").read_text(), "freeze did not settle")
            frozen_pulse = pulse.read_bytes()
            request.touch()  # Outside process will attempt its write/rename after thaw.
            rootfd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY)
            journalfd = os.open(journal, os.O_RDONLY | os.O_DIRECTORY)
            try:
                changes = [("nested/a", H(b"alpha"), b"ALPHA", 0o644),
                           ("b", H(b"beta"), None, 0),
                           ("new/deep/c", "absent", b"beta", 0o644)]
                if case == "later-stale":
                    try:
                        guest.apply_mutation_batch(rootfd, journalfd, changes, 4096)
                    except SystemExit as error:
                        assert error.code == 6, error.code
                    else:
                        raise AssertionError("stale later path was accepted")
                    assert (workspace / "nested/a").read_bytes() == b"alpha"
                    assert (workspace / "b").read_bytes() == b"outside save"
                    assert not (workspace / "new").exists() and not list(journal.iterdir())
                elif case == "ancestor-move":
                    result = guest.apply_mutation_batch(rootfd, journalfd, changes, 4096)
                    assert result == {"nested/a": H(b"ALPHA"), "b": "absent", "new/deep/c": H(b"beta")}
                    assert (workspace / "nested/a").read_bytes() == b"ALPHA"
                    assert (workspace / "new/deep/c").read_bytes() == b"beta"
                    assert not outside.exists() and not (workspace / "b").exists()
                else:
                    worker = os.fork()
                    if worker == 0:
                        try:
                            replace = guest.os.replace

                            def die(source, target, **kwargs):
                                replace(source, target, **kwargs)
                                if kwargs.get("dst_dir_fd") != journalfd:
                                    os.kill(os.getpid(), signal.SIGKILL)

                            guest.os.replace = die
                            guest.apply_mutation_batch(rootfd, journalfd, changes, 4096)
                            os._exit(87)
                        except BaseException:
                            import traceback
                            traceback.print_exc()
                            os._exit(125)
                    _, status = os.waitpid(worker, 0)
                    worker = None
                    assert os.waitstatus_to_exitcode(status) == -signal.SIGKILL
                    assert (workspace / "nested/a").read_bytes() == b"ALPHA", "death did not interrupt a partial patch"
                    assert guest.recover_mutation(rootfd, journalfd, 4096) == "aborted"
                    assert (workspace / "nested/a").read_bytes() == b"alpha"
                    assert (workspace / "b").read_bytes() == b"beta" and not (workspace / "new").exists()
                time.sleep(.2)
                assert pulse.read_bytes() == frozen_pulse and not done.exists(), "outside writer escaped exclusion"
                (writers / "cgroup.freeze").write_text("0")
                eventually(lambda: done.exists(), "outside writer did not resume after thaw")
                if case == "ancestor-move":
                    assert (outside / "a").read_bytes() == b"outside after thaw"
                    assert guest.recover_mutation(rootfd, journalfd, 4096) == "committed"
                    assert (outside / "a").read_bytes() == b"outside after thaw"
                    assert not (workspace / "nested").exists(), "settled recovery recreated an outside-moved ancestor"
                else:
                    assert (workspace / "b").read_bytes() == b"outside after thaw"
                results.append({"case": case, "passed": True, "outside_writer_held_until_settlement": True,
                                "thaw_positive_control": True})
            finally:
                os.close(rootfd)
                os.close(journalfd)
                (writers / "cgroup.kill").write_text("1")
                os.waitpid(writer, 0)
                writer = None
    finally:
        if worker is not None:
            os.kill(worker, signal.SIGKILL)
            os.waitpid(worker, 0)
        (writers / "cgroup.kill").write_text("1")
        if writer is not None:
            os.waitpid(writer, 0)
        eventually(lambda: "populated 0" in (writers / "cgroup.events").read_text(), "writer cleanup did not finish")
        writers.rmdir()

print(json.dumps({"uid": os.getuid(), "kernel": os.uname().release,
                  "helper_sha256": H(pathlib.Path(sys.argv[1]).read_bytes()), "results": results}, indent=2))
