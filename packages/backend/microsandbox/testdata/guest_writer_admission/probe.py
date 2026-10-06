"""Supplemental kernel evidence for the production managed-child lifecycle.

Run as an ordinary user in a NEW disposable delegated systemd user service.
The cgroup directory owner and credential-drop seams are explicitly substituted
to use that delegation. Real fork, cgroup admission, freezing, killing, reaping,
filesystem dispatch and home initialization are exercised. No root privileges,
microVM qualification, whole-patch atomicity or provider enablement is implied.
"""
import importlib.util
import io
import json
import os
import pathlib
import pwd
import signal
import sys
import tempfile
import time
import types

if os.geteuid() == 0:
    raise SystemExit("never run branch qualification code as root")
scope = pathlib.Path("/sys/fs/cgroup" + pathlib.Path("/proc/self/cgroup").read_text().strip().split("::")[1])
if not (scope.name.startswith("run-") and scope.name.endswith(".service")):
    raise SystemExit("run only in a new disposable delegated user service")

spec = importlib.util.spec_from_file_location("guest", sys.argv[1])
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
writers = scope / ("smithers-writers-" + str(os.getpid()))
writers.mkdir(mode=0o700)
guest.CGROUP_ROOT = str(writers)
guest.ROOT_UID = os.getuid()
original_safe = guest.safe_directory


def delegated_directory(path, trusted=False, create=True):
    """Substitute only the protected directory for our own delegated tree."""
    candidate = pathlib.Path(path)
    if candidate == writers or candidate.parent == writers:
        if create:
            candidate.mkdir(mode=0o700, exist_ok=True)
        info = candidate.lstat()
        assert info.st_uid == os.getuid() and not info.st_mode & 0o022, (str(candidate),info.st_uid,oct(info.st_mode))
        return os.open(candidate, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    return original_safe(path, trusted=trusted, create=create)


guest.safe_directory = delegated_directory
supervisors = set()
results = []


def eventually(predicate, message, seconds=5):
    deadline = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < deadline, message
        time.sleep(0.01)


def reap(pid, expected):
    status = []

    def ended():
        found, value = os.waitpid(pid, os.WNOHANG)
        if found:
            status.append(os.waitstatus_to_exitcode(value))
        return bool(found)

    eventually(ended, "supervisor did not finish", 15)
    supervisors.remove(pid)
    assert status == [expected], status


def start(name, action):
    sys.stdout.flush()
    pid = os.fork()
    if pid == 0:
        try:
            os._exit(guest.run_managed_child(name, action))
        except BaseException:
            import traceback
            traceback.print_exc()
            os._exit(125)
    supervisors.add(pid)
    return pid


try:
    with tempfile.TemporaryDirectory(prefix="smithers-writer-admission-") as directory:
        root = pathlib.Path(directory)
        home = root / "home"
        home.mkdir()
        tools = root / "tools"
        tools.mkdir()
        (tools / "cached-tool").write_bytes(b"fixture\n")
        entry = types.SimpleNamespace(pw_dir=str(home), pw_uid=os.getuid(), pw_gid=os.getgid())
        guest.TOOL_HOME = str(tools)
        guest.ENV_FILE = str(root / "absent-env")

        def same_identity(user):
            assert user == "agent"
            # Membership is read from the actual kernel, before any action.
            current = pathlib.Path("/proc/self/cgroup").read_text().strip().split("::")[1]
            assert pathlib.Path("/sys/fs/cgroup" + current).parent == writers
            return entry

        guest.drop_to = same_identity
        for name in ("filesystem", "home"):
            target = root / "file"
            target.write_bytes(b"original\n")
            (writers / "cgroup.freeze").write_text("1")
            eventually(lambda: "frozen 1" in (writers / "cgroup.events").read_text(), "freeze timed out")

            def action(member):
                if name == "filesystem":
                    guest.sys.stdin = io.TextIOWrapper(io.BytesIO(b"replacement\n"))
                    guest.run_fs(["fs", "agent", "write", str(root), "file", "644"])
                else:
                    guest.home_defaults(member)

            supervisor = start(name, action)
            procs = writers / name / "cgroup.procs"
            eventually(lambda: procs.exists() and bool(procs.read_text().strip()), "child was not admitted")
            # A launch into an already frozen parent cannot reach its action.
            deadline = time.monotonic() + 0.5
            while time.monotonic() < deadline:
                assert target.read_bytes() == b"original\n"
                assert not (home / "cached-tool").exists()
                time.sleep(0.01)
            (writers / "cgroup.freeze").write_text("0")
            reap(supervisor, 0)
            if name == "filesystem":
                assert target.read_bytes() == b"replacement\n"
            else:
                assert (home / "cached-tool").read_bytes() == b"fixture\n"
            assert not (writers / name).exists(), "child cgroup was not collected"
            results.append({"case": name, "held_before_thaw": True, "finished_after_thaw": True})

        pulse = root / "pulse"
        ready = root / "ready"

        def detached_writer(_entry):
            child = os.fork()
            if child == 0:
                os.setsid()
                ready.write_text(str(os.getpid()))
                while True:
                    pulse.write_text(str(time.monotonic_ns()))
                    time.sleep(0.01)
            while True:
                time.sleep(1)

        supervisor = start("cancel", detached_writer)
        eventually(lambda: ready.exists() and pulse.exists(), "detached writer did not start")
        os.kill(supervisor, signal.SIGTERM)
        reap(supervisor, 143)
        before = pulse.read_bytes()
        time.sleep(0.1)
        assert pulse.read_bytes() == before, "detached writer survived cancellation"
        assert not (writers / "cancel").exists()
        results.append({"case": "cancellation", "detached_writer_stopped": True, "exit_code": 143})

    print(json.dumps({"uid": os.getuid(), "kernel": os.uname().release, "results": results}, indent=2), flush=True)
finally:
    (writers / "cgroup.freeze").write_text("0")
    (writers / "cgroup.kill").write_text("1")
    for pid in supervisors:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    eventually(lambda: "populated 0" in (writers / "cgroup.events").read_text(), "cleanup did not reap writers")
    for path in writers.iterdir():
        if path.is_dir():
            path.rmdir()
    writers.rmdir()
