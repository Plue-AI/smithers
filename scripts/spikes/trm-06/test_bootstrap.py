"""Real shell/loader controls in an unprivileged Linux user/mount namespace.

No host root privilege, root prototype, VM, signer or acceptance is supplied.
The gateway boundary is an OS true executable; these are loader receipts only.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("assemble", SOURCE / "assemble.py")
assemble = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assemble)


def namespace_campaign(temporary):
    # Namespace UID 0 maps solely to the calling unprivileged host UID. None
    # of these mounts, ownership changes or canaries can reach the host install.
    assert os.geteuid() == 0
    os.umask(0o022)
    templates = {name: assemble.render_entry(SOURCE.parents[2], name,
                    hashlib.sha256(Path("/bin/true").read_bytes()).hexdigest(), "a" * 40)
                 for name in ("run.sh", "revoke.sh", "flow.sh")}
    bootstrap = (SOURCE / "bootstrap.py").read_text()
    bootstrap = bootstrap.replace("@TRM06_LAUNCHER_SHA256@", hashlib.sha256((SOURCE / "launcher.py").read_bytes()).hexdigest())
    bootstrap = bootstrap.replace("@TRM06_GATEWAY_SHA256@", hashlib.sha256(Path("/bin/true").read_bytes()).hexdigest())
    bootstrap = bootstrap.replace("@TRM06_REVISION@", "a" * 40)
    loader = (SOURCE / "launcher.py").read_bytes()
    gateway = Path("/bin/true").read_bytes()
    root = Path(temporary)
    for location in ("usr/bin", "usr/lib", "lib", "lib64", "bin"):
        source = Path("/" + location)
        if source.exists():
            destination = root / location
            destination.mkdir(parents=True, exist_ok=True)
            subprocess.run(["/bin/mount", "--bind", str(source), str(destination)], check=True)
    (root / "usr/local/lib/smithers").mkdir(parents=True)
    os.chroot(root)
    os.chdir("/")
    bundle = Path("/usr/local/lib/smithers/current")
    sentinel = Path("/sentinel")
    sentinel.write_bytes(b"outside-fixture\0")
    before = (b"outside-fixture\0", 0, stat.S_IFREG | 0o644)
    assert (sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode) == before
    # Prove the literal shell payload is executable on this boundary before
    # using its absence as a refusal assertion. Restore only sentinel bytes;
    # owner and mode must remain identical through the positive control too.
    canary = Path("/canary.sh")
    canary.write_bytes(b"#!/bin/sh\nprintf canary >> /sentinel\n")
    canary.chmod(0o755)
    positive = subprocess.run(["/bin/sh", str(canary)], capture_output=True, timeout=2)
    assert positive.returncode == 0 and sentinel.read_bytes() == before[0] + b"canary"
    assert (sentinel.stat().st_uid, sentinel.stat().st_mode) == before[1:]
    sentinel.write_bytes(before[0])
    canary.unlink()
    controls = 0
    samples = []

    def fixture():
        if bundle.exists(): shutil.rmtree(bundle)
        entries = []
        for name, body in [("share/trm06/launcher.py", loader),
                           ("bin/trm06-gateway", gateway)] + [("share/trm06/"+n, b) for n, b in templates.items()]:
            path = bundle / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
            mode = 0o644 if name.endswith(".py") else 0o755
            path.chmod(mode)
            entries.append({"path": name, "mode": mode, "sha256": hashlib.sha256(body).hexdigest()})
        (bundle / "manifest.json").write_text(json.dumps({"version": 1, "platform": "darwin-arm64", "revision": "a" * 40, "files": entries}))

    def invoke(script="run.sh", poison=None, passed=False):
        nonlocal controls
        argv = ["/bin/sh", str(bundle / "share/trm06" / script)]
        result = subprocess.run(argv, env=poison or {"PATH": "/usr/bin:/bin"}, capture_output=True, timeout=2)
        if passed:
            assert result.returncode == 0, (argv, result.stderr)
            assert result.stdout == b"", result.stdout
        else:
            assert result.returncode == 78, (argv, result.returncode, result.stderr)
            assert result.stdout == b"", result.stdout
            assert json.loads(result.stderr)["code"] == "prototype_authority_unavailable", result.stderr
        assert (sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode) == before
        controls += 1

    # Actual installed shell entry, Python bootstrap and production loader.
    poisons = {"PATH": "/sentinel", "HOME": "/sentinel", "PYTHONPATH": "/sentinel",
               "PYTHONHOME": "/sentinel", "PYTHONSTARTUP": "/sentinel",
               "LD_PRELOAD": "/missing.so", "LD_LIBRARY_PATH": "/sentinel",
               "DYLD_INSERT_LIBRARIES": "/missing.dylib", "DYLD_LIBRARY_PATH": "/sentinel",
               "BASH_ENV": "/sentinel", "ENV": "/sentinel", "MSB_BACKEND": "remote"}
    for script in templates:
        for poison in [{}] + [dict([item]) for item in poisons.items()] + [poisons]:
            fixture()
            invoke(script, poison, True)

    # Use an unchanged shell entry as the main-pinned launch authority;
    # replacing the executing shell itself requires the outer bundle/OS gate.
    for target in ("manifest.json", "share/trm06/launcher.py", "bin/trm06-gateway",
                   "share/trm06/run.sh", "share/trm06/revoke.sh", "share/trm06/flow.sh"):
        for mutation in ("contents", "same-size", "symlink", "fifo", "hardlink", "writable", "directory"):
            fixture()
            path = bundle / target
            if mutation == "contents":
                path.write_bytes(b"open('/sentinel','ab').write(b'canary')\n" if target.endswith(".py") else b"#!/bin/sh\nprintf canary >> /sentinel\n")
            elif mutation == "same-size": path.write_bytes(b"x" * path.stat().st_size)
            elif mutation == "writable": path.chmod(0o777)
            elif mutation == "hardlink": os.link(path, bundle / "hardlink")
            else:
                path.rename(bundle / "original")
                if mutation == "symlink": path.symlink_to(bundle / "original")
                elif mutation == "fifo": os.mkfifo(path)
                else: path.mkdir()
            invoke("revoke.sh" if target.endswith("run.sh") else "run.sh")
    for target in ("bin", "share", "share/trm06"):
        for mutation in ("symlink", "writable"):
            fixture()
            path = bundle / target
            if mutation == "writable": path.chmod(0o777)
            else:
                path.rename(bundle / "original")
                path.symlink_to(bundle / "original")
            invoke()
    # A forged manifest and matching replacement gateway must still refuse.
    fixture()
    path = bundle / "bin/trm06-gateway"
    path.write_bytes(b"#!/bin/sh\nprintf canary >> /sentinel\n")
    manifest = json.loads((bundle / "manifest.json").read_bytes())
    for entry in manifest["files"]:
        if entry["path"] == "bin/trm06-gateway": entry["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    (bundle / "manifest.json").write_text(json.dumps(manifest))
    invoke()
    # Execute the rendered production bootstrap with a trace barrier immediately
    # after initial digest/metadata validation at each startup phase. The trace
    # barrier grants no policy bypass:
    # a separate process performs literal replacements, then normal bootstrap
    # validation and launcher execution resume. Namespace root maps only to this
    # lane's UID; none of these are native installation acceptance receipts.
    barrier = next(index for index, line in enumerate(bootstrap.splitlines(), 1)
                   if line.strip().startswith('current = os.open("/"'))
    launcher_barrier = next(index for index, line in enumerate(loader.decode().splitlines(), 1)
                            if line.strip().startswith('operation = sys.argv[1]'))
    schedules = [("bootstrap", target, mutation)
                 for target in (".", "share", "share/trm06", "share/trm06/launcher.py")
                 for mutation in ("positive", "preserved-inode", "copy", "symlink", "writable", "contents", "hardlink")
                 if target == "share/trm06/launcher.py" or mutation not in ("contents", "hardlink")]
    leaves = ("manifest.json", "share/trm06/launcher.py", "share/trm06/run.sh",
              "share/trm06/revoke.sh", "share/trm06/flow.sh", "bin/trm06-gateway")
    schedules += [("launcher", target, mutation) for target in leaves
                  for mutation in ("positive", "preserved-inode", "copy", "symlink", "writable",
                                   "contents", "hardlink", "fifo", "directory", "canary")]
    schedules += [("launcher", target, mutation)
                  for target in ("/usr/local", "/usr/local/lib", "/usr/local/lib/smithers",
                                 ".", "bin", "share", "share/trm06")
                  for mutation in ("positive", "preserved-inode", "copy", "symlink", "writable")]
    for phase, target, mutation in schedules:
        # The launcher boundary runs the same rendered bootstrap, then holds
        # after all initial artifact hashes and before its final path checks.
        fixture()
        wrapper = """import os, sys, time, json, shutil
from pathlib import Path
request_r, request_w = os.pipe()
reply_r, reply_w = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(request_w); os.close(reply_r)
    assert os.read(request_r, 1) == b'1'
    start = time.monotonic_ns()
    path = Path(TARGET)
    if MUTATION == 'preserved-inode':
        original = path.with_name(path.name + '-held')
        path.rename(original)
        if original.is_dir():
            path.mkdir()
            for child in original.iterdir(): child.rename(path / child.name)
        else:
            # Keep bytes and inode but change link metadata.
            os.link(original, path)
    elif MUTATION == 'copy':
        original = path.with_name(path.name + '-held')
        path.rename(original)
        if original.is_dir(): shutil.copytree(original, path)
        else: shutil.copy2(original, path)
    elif MUTATION == 'symlink':
        original = path.with_name(path.name + '-held')
        path.rename(original); path.symlink_to(original)
    elif MUTATION == 'writable': path.chmod(0o777)
    elif MUTATION == 'contents': path.write_bytes(b'x' * path.stat().st_size)
    elif MUTATION == 'hardlink': os.link(path, '/hardlink')
    elif MUTATION in ('fifo', 'directory'):
        path.rename(path.with_name(path.name + '-held'))
        if MUTATION == 'fifo': os.mkfifo(path)
        else: path.mkdir()
    elif MUTATION == 'canary':
        path.write_bytes(b"#!/bin/sh\\nprintf canary >> /sentinel\\n")
        path.chmod(0o755)
    end = time.monotonic_ns()
    Path('/race.json').write_text(json.dumps({'worker_pid': os.getpid(), 'worker_uid': os.geteuid(), 'start_ns': start, 'end_ns': end}))
    os.write(reply_w, b'1'); os._exit(0)
os.close(request_r); os.close(reply_w)
held = None
def trace(frame, event, arg):
    global held
    if event == 'line' and frame.f_code.co_filename == TRACE_FILE and frame.f_lineno == BARRIER and held is None:
        held = time.monotonic_ns()
        os.write(request_w, b'1')
        assert os.read(reply_r, 1) == b'1'
        _, status = os.waitpid(pid, 0)
        assert status == 0
        sample = json.loads(Path('/race.json').read_text())
        sample.update({'held_ns': held, 'resume_ns': time.monotonic_ns()})
        Path('/race.json').write_text(json.dumps(sample))
    return trace
sys.argv = ['bootstrap', 'run']
sys.settrace(trace)
exec(compile(BOOTSTRAP, '<installed-bootstrap>', 'exec'), {'__name__': '__main__'})
"""
        path = bundle if target == "." else bundle / target
        prefix = "TARGET=" + repr(str(path)) + "\nMUTATION=" + repr(mutation) + "\nBARRIER=" + str(barrier if phase == "bootstrap" else launcher_barrier) + "\nTRACE_FILE=" + repr("<installed-bootstrap>" if phase == "bootstrap" else str(bundle / "share/trm06/launcher.py")) + "\nBOOTSTRAP=" + repr(bootstrap) + "\n"
        result = subprocess.run(["/usr/bin/python3", "-I", "-S", "-c", prefix + wrapper],
                                capture_output=True, timeout=5)
        if mutation == "positive":
            assert result.returncode == 0, result.stderr
        else:
            assert result.returncode == 78, (target, mutation, result.stderr)
            assert result.stderr == b'{"class":"unavailable","code":"prototype_authority_unavailable","check":"C-SPK-08"}\n', (target, mutation, result.stderr)
        assert result.stdout == b"", result.stdout
        record = json.loads(Path('/race.json').read_text())
        assert record['worker_pid'] > 0 and record['worker_uid'] == 0
        assert 0 < record['held_ns'] <= record['start_ns'] <= record['end_ns'] <= record['resume_ns']
        assert (sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode) == before
        record.update({"phase": phase, "target": target, "mutation": mutation,
                       "exit": result.returncode, "stderr": result.stderr.decode(),
                       "outside_sha256": hashlib.sha256(sentinel.read_bytes()).hexdigest(),
                       "outside_uid": sentinel.stat().st_uid,
                       "outside_mode": sentinel.stat().st_mode & 0o777})
        samples.append(record)
        # Restore only objects created by this disposable namespace fixture.
        held = path.with_name(path.name + '-held')
        if path.is_symlink(): path.unlink()
        if path.exists():
            if path.is_dir(): shutil.rmtree(path)
            else: path.unlink()
        if held.exists():
            if held.is_dir(): shutil.rmtree(held)
            else: held.unlink()
        if Path('/hardlink').exists(): Path('/hardlink').unlink()
        controls += 1

    print(json.dumps({"loader_controls": controls, "accepted": False, "synchronized_bootstrap_samples": [s for s in samples if s["phase"] == "bootstrap"],
                      "synchronized_launcher_samples": [s for s in samples if s["phase"] == "launcher"]}))


class BootstrapBoundary(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "linux" and shutil.which("unshare"), "Linux user/mount namespace required")
    def test_shell_loader_artifact_and_environment_controls(self):
        capability = subprocess.run(["unshare", "-Ur", "-m", "true"], capture_output=True)
        if capability.returncode: self.skipTest("unprivileged namespaces unavailable")
        with tempfile.TemporaryDirectory(prefix="trm06-loader-") as temporary:
            result = subprocess.run(["unshare", "-Ur", "-m", sys.executable, "-I", "-S", str(Path(__file__).resolve()), "--namespace", temporary], capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["loader_controls"], 208)
        self.assertFalse(receipt["accepted"])
        self.assertEqual(len(receipt["synchronized_bootstrap_samples"]), 22)
        self.assertEqual(len(receipt["synchronized_launcher_samples"]), 95)
        evidence = os.environ.get("TRM06_LOADER_EVIDENCE")
        if evidence:
            # Publish only after behavioral assertions pass; raw NO output is
            # already retained in the unittest failure transcript.
            with open(evidence, "x") as output:
                json.dump(receipt, output, indent=2)
                output.write("\n")

    def test_rendering_requires_main_identity_and_bootstrap_marker(self):
        for digest, revision in [("x" * 64, "a" * 40), ("a" * 64, "a" * 39)]:
            with self.subTest(digest=digest, revision=revision):
                with self.assertRaises(ValueError):
                    assemble.render_entry(SOURCE.parents[2], "run.sh", digest, revision)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--namespace": namespace_campaign(sys.argv[2])
    else: unittest.main()
