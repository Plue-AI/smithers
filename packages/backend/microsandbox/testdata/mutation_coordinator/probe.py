"""Real coordinator/cgroup/pipe lifecycle with ordinary-user identity fixtures.

No branch executable runs as root. Credential drop and protected ownership are
substituted; the production coordinator, journal, fork, pipes and cgroups run.
"""
import base64
import io
import fcntl
import ctypes
import hashlib
import importlib.util
import json
import os
import pathlib
import signal
import sys
import tempfile
import time
import types

uid, gid = os.getuid(), os.getgid()
assert uid != 0
scope = pathlib.Path("/sys/fs/cgroup" + pathlib.Path("/proc/self/cgroup").read_text().strip().split("::")[1])
assert scope.name.startswith("run-") and scope.name.endswith(".service"), "use a new delegated user service"
spec = importlib.util.spec_from_file_location("guest", sys.argv[1])
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
H = lambda data: hashlib.sha256(data).hexdigest()
results = []
owned = set()


def eventually(check, message, seconds=10):
    deadline = time.monotonic() + seconds
    while not check():
        assert time.monotonic() < deadline, message
        time.sleep(.01)


def reap(pid, expected):
    status = []

    def done():
        found, value = os.waitpid(pid, os.WNOHANG)
        if found:
            status.append(os.waitstatus_to_exitcode(value))
        return bool(found)

    eventually(done, "child did not finish")
    owned.remove(pid)
    assert status == [expected], status


with tempfile.TemporaryDirectory(prefix="smithers-coordinator-") as directory:
    base = pathlib.Path(directory)
    workspace = base / "workspace"
    workspace.mkdir()
    target = workspace / "a"
    writers, mutators = scope / "writers", scope / "mutators"
    for path in (writers, mutators):
        path.mkdir(mode=0o700)
    guest.CGROUP_ROOT, guest.MUTATION_CGROUP_ROOT = str(writers), str(mutators)
    guest.ROOT_UID = uid
    guest.PROTECTED_BASE = str(base)
    guest.MUTATION_TIMEOUT = 10
    guest.mutation_account = lambda: (types.SimpleNamespace(pw_uid=uid), gid)
    original_directory = guest.safe_directory

    def delegated(path, trusted=False, create=True):
        if path == "/workspace":
            return os.open(workspace, os.O_RDONLY | os.O_DIRECTORY)
        candidate = pathlib.Path(path)
        if candidate in (writers, mutators) or candidate.parent in (writers, mutators):
            if create:
                candidate.mkdir(mode=0o700, exist_ok=True)
            info = candidate.stat()
            assert info.st_uid == uid and not info.st_mode & 0o022
            return os.open(candidate, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        return original_directory(path, trusted=trusted, create=create)

    guest.safe_directory = delegated

    def same_identity(entry, group):
        assert os.getuid() == uid and entry.pw_uid == uid and group == gid
        guest.os.geteuid = lambda: uid
        guest.os.getgroups = lambda: []
        # Exercise non-dumpability, but not an actual root credential transition.
        assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0

    guest.drop_mutation_identity = same_identity
    guest.os.geteuid = lambda: 0
    pending = base.joinpath(*guest.WRITER_COORDINATOR, "pending")

    def prepare():
        return [("a", H(b"alpha"), b"ALPHA", 0o644)]

    try:
        # Input and output each exceed a pipe buffer. The real caller belongs to
        # the frozen aggregate, so either incorrect ordering would deadlock.
        target.write_bytes(b"alpha")
        input_r, input_w = os.pipe()
        output_r, output_w = os.pipe()
        caller_group = writers / "caller"
        caller_group.mkdir(mode=0o700)
        payload, response = b"request" * 40000, b"response" * 40000
        caller = os.fork()
        if caller == 0:
            try:
                os.close(input_r)
                os.close(output_w)
                (caller_group / "cgroup.procs").write_text(str(os.getpid()))
                view = memoryview(payload)
                while view:
                    view = view[os.write(input_w, view):]
                os.close(input_w)
                body = bytearray()
                while len(body) < len(response):
                    part = os.read(output_r, 65536)
                    assert part, "response closed early"
                    body.extend(part)
                assert bytes(body) == response
                os._exit(0)
            except BaseException:
                import traceback
                traceback.print_exc()
                os._exit(125)
        owned.add(caller)
        os.close(input_w)
        os.close(output_r)
        stdin, stdout = os.dup(0), os.dup(1)
        sys.stdout.flush()
        os.dup2(input_r, 0)
        os.dup2(output_w, 1)
        os.close(input_r)
        os.close(output_w)
        try:
            def streamed_input():
                body = bytearray()
                while len(body) < len(payload):
                    part = os.read(0, 65536)
                    assert part
                    body.extend(part)
                assert bytes(body) == payload
                return prepare()

            def streamed_reply(result):
                assert result == {"a": H(b"ALPHA")}
                assert (writers / "cgroup.freeze").read_text().strip() == "0"
                view = memoryview(response)
                while view:
                    view = view[os.write(1, view):]

            assert guest.coordinate_mutation(streamed_input, streamed_reply, 4096) == 0
        finally:
            os.dup2(stdin, 0)
            os.dup2(stdout, 1)
            os.close(stdin)
            os.close(stdout)
        reap(caller, 0)
        guest.cgroup_kill(str(caller_group))
        assert target.read_bytes() == b"ALPHA" and not pending.exists()
        results.append({"case": "streaming-caller", "input_bytes": len(payload), "reply_bytes": len(response), "passed": True})

        # Exercise the real batch envelope, mode preservation and stale path
        # response against kernel cgroups (identity remains instrumented).
        def submit(changes):
            original_input = sys.stdin
            sys.stdout.flush()
            original_output, original_error = os.dup(1), os.dup(2)
            output, error = base / "batch-output", base / "batch-error"
            try:
                sys.stdin = types.SimpleNamespace(buffer=io.BytesIO(json.dumps({"changes": changes}).encode()))
                with output.open("w") as out, error.open("w") as err:
                    os.dup2(out.fileno(), 1)
                    os.dup2(err.fileno(), 2)
                    code = guest.coordinated_compare_write(["fs", "agent", "compare-write", "/workspace", "4096"])
            finally:
                sys.stdout.flush()
                sys.stderr.flush()
                os.dup2(original_output, 1)
                os.dup2(original_error, 2)
                os.close(original_output)
                os.close(original_error)
                sys.stdin = original_input
            assert not pending.exists() and (writers / "cgroup.freeze").read_text().strip() == "0"
            return code, output.read_text(), error.read_text()

        target.write_bytes(b"alpha")
        target.chmod(0o751)
        source = workspace / "source"
        source.write_bytes(b"move me")
        data = bytes(range(256)) * 8
        batch = [{"path": "a", "base_digest": H(b"alpha"), "content": base64.b64encode(data).decode(), "encoding": "base64"},
                 {"path": "source", "base_digest": H(b"move me"), "content": None},
                 {"path": "nested/destination", "base_digest": "absent", "content": "move me"}]
        code, output, error = submit(batch)
        assert code == 0 and not error, (code, output, error)
        assert json.loads(output) == {"changes": [{"path": "a", "digest": H(data)},
                                                  {"path": "source", "digest": "absent"},
                                                  {"path": "nested/destination", "digest": H(b"move me")}]}
        assert target.read_bytes() == data and target.stat().st_mode & 0o777 == 0o751
        assert not source.exists() and (workspace / "nested/destination").read_bytes() == b"move me"
        results.append({"case": "batch-envelope-exact-bytes-move-mode", "passed": True})
        code, output, error = submit([{"path": "a", "base_digest": H(data), "content": "new"},
                                     {"path": "never-created/file", "base_digest": "absent", "content": "new"},
                                     {"path": "nested/destination", "base_digest": "absent", "content": None}])
        assert code == 6 and not output, (code, output, error)
        assert json.loads(error.removeprefix("smithers-guest: stale:")) == {"path": "nested/destination", "current_digest": H(b"move me")}
        assert target.read_bytes() == data and not (workspace / "never-created").exists()
        assert (workspace / "nested/destination").read_bytes() == b"move me"
        results.append({"case": "batch-envelope-later-stale", "passed": True})

        # A stale path can exceed a pipe buffer. Its caller belongs to the
        # writer aggregate: reporting before thaw would deadlock settlement.
        target.write_bytes(b"alpha")
        long_path = "/".join(["😀" * 62] * 16)
        error_r, error_w = os.pipe()
        fcntl.fcntl(error_w, fcntl.F_SETPIPE_SZ, 4096)
        error_group = writers / "error-caller"
        error_group.mkdir(mode=0o700)
        error_ready, error_received = base / "error-ready", base / "error-received"
        error_caller = os.fork()
        if error_caller == 0:
            try:
                os.close(error_w)
                (error_group / "cgroup.procs").write_text(str(os.getpid()))
                error_ready.touch()
                with os.fdopen(error_r, "rb") as stream:
                    body = stream.read()
                error_received.write_bytes(body)
                os._exit(0)
            except BaseException:
                os._exit(125)
        owned.add(error_caller)
        os.close(error_r)
        eventually(error_ready.exists, "error caller did not enroll")
        original_input, original_error = sys.stdin, os.dup(2)
        try:
            os.dup2(error_w, 2)
            os.close(error_w)
            sys.stdin = types.SimpleNamespace(buffer=io.BytesIO(json.dumps({"changes": [
                {"path": "a", "base_digest": H(b"alpha"), "content": "NEW"},
                {"path": long_path, "base_digest": H(b"missing"), "content": None}]}).encode()))
            code = guest.coordinated_compare_write(["fs", "agent", "compare-write", "/workspace", "4096"])
            assert code == 6 and target.read_bytes() == b"alpha"
        finally:
            sys.stderr.flush()
            os.dup2(original_error, 2)
            os.close(original_error)
            sys.stdin = original_input
        reap(error_caller, 0)
        guest.cgroup_kill(str(error_group))
        diagnostic = error_received.read_text()
        assert len(diagnostic) > 4096 and not pending.exists()
        assert json.loads(diagnostic.removeprefix("smithers-guest: stale:")) == {"path": long_path, "current_digest": "absent"}
        results.append({"case": "stale-diagnostic-after-thaw", "pipe_bytes": 4096,
                        "diagnostic_bytes": len(diagnostic.encode()), "passed": True})

        # Kill the coordinator while its worker survives outside the frozen tree.
        # A fresh coordinator must kill that worker and recover without relying
        # on the dead supervisor's finally blocks or in-memory transaction state.
        for stage in ("input", "partial", "settled-before-thaw", "after-thaw", "kill-all"):
            target.write_bytes(b"alpha")
            marker = base / "crash-stage"
            marker.unlink(missing_ok=True)
            supervisor = os.fork()
            if supervisor == 0:
                try:
                    def stop():
                        marker.touch()
                        while True:
                            time.sleep(1)

                    request = prepare
                    if stage == "input":
                        request = stop
                    elif stage in ("partial", "kill-all"):
                        replace = guest.os.replace

                        def replacing(source, destination, **kwargs):
                            replace(source, destination, **kwargs)
                            if destination == "a":
                                stop()

                        guest.os.replace = replacing
                    else:
                        freeze = guest.mutation_freeze

                        def freezing(fd, value):
                            if not value and stage == "settled-before-thaw":
                                stop()
                            freeze(fd, value)
                            if not value and stage == "after-thaw":
                                stop()

                        guest.mutation_freeze = freezing
                    guest.coordinate_mutation(request, lambda result: None, 4096)
                    os._exit(87)
                except BaseException:
                    import traceback
                    traceback.print_exc()
                    os._exit(125)
            owned.add(supervisor)
            eventually(marker.exists, "coordinator did not reach crash boundary")
            expected_frozen = stage in ("partial", "settled-before-thaw", "kill-all")
            assert (writers / "cgroup.freeze").read_text().strip() == ("1" if expected_frozen else "0")
            if stage == "kill-all":
                guest.main(["kill-all"])
                reap(supervisor, 125)
            else:
                os.kill(supervisor, signal.SIGKILL)
                reap(supervisor, -signal.SIGKILL)
            assert pending.exists()
            if stage == "after-thaw":
                target.write_bytes(b"outside after thaw")
            try:
                guest.main(["recover-files"])
            except SystemExit as error:
                assert error.code == 0, error.code
            else:
                raise AssertionError("startup recovery did not propagate status")
            expected = (b"alpha" if stage in ("input", "partial", "kill-all") else
                        b"ALPHA" if stage == "settled-before-thaw" else b"outside after thaw")
            assert target.read_bytes() == expected
            assert not pending.exists() and (writers / "cgroup.freeze").read_text().strip() == "0"
            assert not any(path.is_dir() for path in mutators.iterdir())
            results.append({"case": "coordinator-death-" + stage, "passed": True,
                            "recovered_without_old_supervisor": True,
                            "recovery_entry": "recover-files"})
    finally:
        for root in (writers, mutators):
            (root / "cgroup.kill").write_text("1")
        for pid in owned:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        for root in (writers, mutators):
            eventually(lambda: "populated 0" in (root / "cgroup.events").read_text(), "cleanup left processes")
            for path in root.iterdir():
                if path.is_dir():
                    path.rmdir()
            root.rmdir()

print(json.dumps({"uid": uid, "kernel": os.uname().release,
                  "helper_sha256": H(pathlib.Path(sys.argv[1]).read_bytes()), "results": results}, indent=2))
