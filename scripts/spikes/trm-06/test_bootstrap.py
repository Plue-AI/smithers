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
    before = (sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode)
    controls = 0

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
    print(json.dumps({"loader_controls": controls, "accepted": False}))


class BootstrapBoundary(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "linux" and shutil.which("unshare"), "Linux user/mount namespace required")
    def test_shell_loader_artifact_and_environment_controls(self):
        capability = subprocess.run(["unshare", "-Ur", "-m", "true"], capture_output=True)
        if capability.returncode: self.skipTest("unprivileged namespaces unavailable")
        with tempfile.TemporaryDirectory(prefix="trm06-loader-") as temporary:
            result = subprocess.run(["unshare", "-Ur", "-m", sys.executable, "-I", "-S", str(Path(__file__).resolve()), "--namespace", temporary], capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["loader_controls"], 91)
        self.assertFalse(receipt["accepted"])

    def test_rendering_requires_main_identity_and_bootstrap_marker(self):
        for digest, revision in [("x" * 64, "a" * 40), ("a" * 64, "a" * 39)]:
            with self.subTest(digest=digest, revision=revision):
                with self.assertRaises(ValueError):
                    assemble.render_entry(SOURCE.parents[2], "run.sh", digest, revision)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--namespace": namespace_campaign(sys.argv[2])
    else: unittest.main()
