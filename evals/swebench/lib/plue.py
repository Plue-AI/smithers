#!/usr/bin/env python3
"""One SWE-bench testbed on a Smithers Cloud workspace: the plue transport.

    plue.py up <name> <image> [--holder PID]   -> {"id": …, "key": …}
    plue.py exec <id> [--cwd DIR] [--timeout SEC] -- <command>
    plue.py cp <src> <dst>                    one side is <id>:<path>
    plue.py network <id>                      -> none | unsealed
    plue.py shim <dir>                        -> <dir>/bin, whose `docker` is the shim
    plue.py snapshot <id>                     -> the capture base (lib/snapshot-base.sh)
    plue.py capture <id> <out.patch>          the patch (lib/capture-patch.sh)
    plue.py down <id> [--key KEY]
    plue.py reap                              delete this host's orphaned testbeds

`SWB_TRANSPORT=plue` routes the rig's testbed here instead of local docker.
Everything is the Harbor adapter's seam (`evals/harbor/plue_env.py`,
`evals/harbor/plue_docker.py`), used as a user would: the public `smithers`
CLI, `SMITHERS_CLI` / `PLUE_REPO` / `SMITHERS_TOKEN` from the environment,
workspace slots shared with every other harness process on this host through
the same `PLUE_SLOT_LEDGER`. Nothing here is a second implementation of any of
it; this file only names the two things a SWE-bench testbed needs that a
Harbor trial does not:

- **The ledger holder is the run script, not this process.** `up` exits as
  soon as the workspace runs, so the slot is held in the name of `--holder`
  (run-instance.sh's own pid): the ledger drops a holder whose pid is gone,
  so a run killed with -9 frees its slot without a `down`.
- **The testbed is sealed by construction, and the seal is read back.** Every
  workspace is created with `--network none`. `network` then asks two
  questions, the way `lib/testbed-network.sh` asks `docker inspect` two: the
  platform's record of the workspace (`workspace view`: `network.mode`) and
  the guest itself, which must fail to open a TCP connection to a raw public
  address and to a public name. A plue guest keeps an `eth0` for its SSH
  transport and resolves names, so "only `lo`" is not the test here; a
  refused connection is. Either answer wrong is `unsealed`.

- **Patch capture runs in the guest.** There is no host checkout: the rig's
  own `snapshot-base.sh` / `capture-patch.sh` / `capture-git.sh` are uploaded
  to `/tmp/swb-rig` and run against `/testbed` exactly as they run
  against a local extraction, then removed. The patch comes back to the host,
  where `strip-modes.mjs` (node, which the images lack) finishes it.
- **Names carry their owner.** A testbed is `swb-<host>-<pid>-<run>` (agent)
  or `swbg-<host>-<pid>-<id>` (grader), so `reap` can delete exactly the ones
  whose owning process on this host is gone: a run killed with -9 leaves a
  running workspace that nothing else would ever delete.

The official evaluator reaches the same testbed through `evaluator_*` below,
which `lib/grade.py` installs in place of its docker calls under
`SWB_TRANSPORT=plue`: the evaluator's own `run_instance` applies the patch,
runs `eval.sh` and grades the log, and only the container is a workspace.

Knobs: `SWB_PLUE_CPUS` (default 2, one ledger slot), `SWB_PLUE_MEMORY_MB`,
`SWB_PLUE_DISK_MB` (plue's defaults when unset). Exit status 125 is a plue
failure (`PlueError`), never a command's own status.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import types
from pathlib import Path

HARBOR = Path(__file__).resolve().parents[2] / "harbor"
sys.path.insert(0, str(HARBOR))
import plue_docker  # noqa: E402
import plue_env  # noqa: E402

PlueError = plue_env.PlueError
DEFAULT_CPUS = 2
# The same prelude `plue_env._PlueOps._plue_start` runs: the image's own /tmp
# rather than the guest init's 512 MiB tmpfs, and the guest's boot id.
SETUP = f"{plue_env.IMAGE_TMP}; {plue_env.BOOT_ID}"
# Measured 2026-09-26 in a `--network none` workspace: `eth0` and `dummy0` are
# present, `example.com` resolves, and every connect is refused.
NET_PROBE = ("for target in 1.1.1.1/80 example.com/80; do "
             "if timeout 5 bash -c \"exec 3<>/dev/tcp/$target\" 2>/dev/null; then echo \"open $target\"; fi; "
             "done; true")
RIG = Path(__file__).resolve().parents[1]
GUEST_RIG = "/tmp/swb-rig"
# Every path a guest command names goes through shlex.quote, constants included,
# so no path can add a command to the shell line the guest runs.
Q_RIG = shlex.quote(GUEST_RIG)
CAPTURE_SCRIPTS = ("capture-git.sh", "snapshot-base.sh", "capture-patch.sh")
# The official evaluator's DOCKER_WORKDIR, and the testbed every image ships.
TESTBED = "/testbed"
Q_TESTBED = shlex.quote(TESTBED)


def host_tag() -> str:
    """Six hex digits naming this host, so `reap` never touches another's."""
    return hashlib.sha1(socket.gethostname().encode()).hexdigest()[:6]


def testbed_name(kind: str, pid: int, label: str) -> str:
    """`swb-<host>-<pid>-<label>` (agent) or `swbg-…` (grader), sanitized."""
    return plue_env._sanitize_name(f"{kind}-{host_tag()}-{pid}-{label}")


_OWNED = re.compile(r"^(swb|swbg)-([0-9a-f]{6})-(\d+)-")


def orphaned(name: str, alive=plue_env._pid_alive) -> bool:
    """A testbed this host made whose owning process is gone."""
    match = _OWNED.match(name or "")
    return bool(match) and match.group(2) == host_tag() and not alive(int(match.group(3)))


def _positive(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    if not value:
        return None
    if not value.isdigit() or int(value) <= 0:
        raise PlueError(f"{name} must be a positive integer, got {value!r}", "config")
    return value


class Testbed(plue_env._PlueOps):
    """`plue_env._PlueOps` for one named testbed, driven synchronously."""

    def __init__(self, name: str, image: str = "", workspace: str = "") -> None:
        self.session_id = name
        self.environment_dir = "/nonexistent"
        self.logger = logging.getLogger("swb.plue")
        cpus = _positive("SWB_PLUE_CPUS") or str(DEFAULT_CPUS)
        self.task_env_config = types.SimpleNamespace(
            workdir="/testbed", cpus=float(cpus),
            memory_mb=_positive("SWB_PLUE_MEMORY_MB"), storage_mb=_positive("SWB_PLUE_DISK_MB"))
        self._plue_image = image
        self._plue_copies, self._plue_chmods = [], []
        self._workspace_id = workspace

    def _plue_network(self) -> tuple[str, list[str]]:
        return "none", []

    def up(self, holder: int) -> dict:
        """Hold a ledger slot for `holder`, create the workspace, run the prelude."""
        cpus = self.task_env_config.cpus
        limit = os.environ.get("PLUE_MAX_CPUS", "").strip()
        if limit and cpus > float(limit):
            raise plue_env.PlueUnplaceable(f"{cpus} vCPU asked; the largest guest is {limit} vCPU", "unplaceable")
        ledger = plue_env.SlotLedger.from_environment()
        key = f"{holder}:{self.session_id}"
        if ledger is not None:
            ledger.enqueue(key, plue_env.slots_for(cpus), holder, cpus)
            try:
                while not ledger.try_grant(key):
                    time.sleep(plue_env._SLOT_POLL_SEC)
            except BaseException:
                ledger.release(key)
                raise
            self._plue_ledger_key = key
        try:
            asyncio.run(self._plue_create())
            out, err, code = self.exec(SETUP, timeout=120, cwd="/")
            if code != 0:
                raise PlueError(f"guest prelude exited {code}: {err.strip()[-300:]}", "prelude")
        except BaseException:
            asyncio.run(self._plue_stop())
            raise
        return {"id": self._workspace_id, "key": key, "bootId": (out.strip().splitlines() or [""])[-1]}

    def exec(self, command: str, timeout: int = 3600, cwd: str | None = None) -> tuple[str, str, int]:
        return asyncio.run(self._plue_exec(command, cwd=cwd, timeout_sec=timeout, user="root"))

    def upload(self, source: str, target: str) -> None:
        asyncio.run(self._plue_upload(source, target))

    def download(self, source: str, target: str) -> None:
        asyncio.run(self._plue_download(source, target))

    def network(self) -> str:
        """`none` when plue records the workspace as `none` and the guest
        cannot open a connection out; `unsealed` otherwise."""
        result = asyncio.run(self._run("workspace", "view", *self._ws("--format", "json"), timeout=120))
        record = plue_env._envelope(result.stdout.decode(errors="replace"))
        mode = str(((record.get("data", record) or {}).get("network") or {}).get("mode", ""))
        out, err, code = self.exec(NET_PROBE, timeout=60, cwd="/")
        if code != 0:
            raise PlueError(f"the guest's egress probe exited {code}: {err.strip()[-300:]}", "network")
        verdict = observed(mode, out)
        if verdict != "none":
            sys.stderr.write(f"plue.py: workspace network mode {mode!r}; probe: {out.strip() or 'all refused'}\n")
        return verdict

    def down(self, key: str = "") -> None:
        """Delete the workspace and free the slot. Never raises (plue_env)."""
        self._plue_ledger_key = key
        asyncio.run(self._plue_stop())

    def _with_rig(self, command: str, timeout: int = 900) -> tuple[str, str, int]:
        """`command` with the rig's capture scripts at GUEST_RIG/lib, removed after."""
        with tempfile.TemporaryDirectory() as staging:
            for name in CAPTURE_SCRIPTS:
                shutil.copy2(RIG / "lib" / name, Path(staging) / name)
            _, err, code = self.exec(f"rm -rf {Q_RIG} && mkdir -p {Q_RIG}/lib {Q_RIG}/out", 120, "/")
            if code != 0:
                raise PlueError(f"cannot stage {GUEST_RIG}: {err.strip()[-300:]}", "capture")
            asyncio.run(self._plue_upload_contents(staging, f"{GUEST_RIG}/lib"))
        return self.exec(command, timeout, TESTBED)

    def snapshot(self) -> str:
        """The capture base: lib/snapshot-base.sh over the guest's /testbed."""
        out, err, code = self._with_rig(
            f"bash {Q_RIG}/lib/snapshot-base.sh {Q_TESTBED}; code=$?; rm -rf {Q_RIG}; exit $code")
        if code != 0:
            raise PlueError(f"snapshot-base.sh exited {code}: {err.strip()[-300:]}", "capture")
        return out.strip().splitlines()[-1]

    def capture(self, out: Path) -> None:
        """lib/capture-patch.sh over the guest's /testbed, into `out` and
        `out.untracked` on this host, finished by strip-modes.mjs here."""
        _, err, code = self._with_rig(
            f"SWB_CAPTURE_STRIP=host bash {Q_RIG}/lib/capture-patch.sh {Q_TESTBED} {Q_RIG}/out/patch")
        try:
            if code != 0:
                raise PlueError(f"capture-patch.sh exited {code}: {err.strip()[-300:]}", "capture")
            out.parent.mkdir(parents=True, exist_ok=True)
            self.download(f"{GUEST_RIG}/out/patch", str(out))
            self.download(f"{GUEST_RIG}/out/patch.untracked", f"{out}.untracked")
        finally:
            self.exec(f"rm -rf {Q_RIG}", 120, "/")
        subprocess.run(["node", str(RIG / "lib" / "strip-modes.mjs"), str(out)], check=True,
                       stdout=subprocess.DEVNULL)


def reap() -> list[str]:
    """Delete every testbed this host made whose owner is gone."""
    ops = Testbed("reap")
    try:
        result = asyncio.run(ops._run("workspace", "list", "--repo", ops._repo(), "--format", "json", timeout=120))
        text = result.stdout.decode(errors="replace")
        rows = json.loads(text[text.find("["):]) if "[" in text else []
    except (PlueError, ValueError):
        return []
    reaped = []
    for row in rows:
        if row.get("id") and orphaned(str(row.get("name", ""))):
            Testbed(str(row["name"]), workspace=str(row["id"])).down()
            reaped.append(str(row["name"]))
    return reaped


# --- the official evaluator's container, as a workspace ---------------------
#
# `lib/grade.py` installs these over `swebench.harness.docker_build` /
# `docker_utils` under SWB_TRANSPORT=plue. Signatures and return values are the
# evaluator's own (swebench 4.0.4), so its `run_instance` runs unchanged.


class EvaluatorContainer:
    """What `run_instance` calls on a docker container: `start`, `exec_run`, `id`."""

    def __init__(self, testbed: Testbed, key: str) -> None:
        self.testbed = testbed
        self.key = key
        self.id = testbed._workspace_id

    def start(self) -> None:
        """The workspace is running once `up` returns."""

    def exec_run(self, cmd: str, workdir: str | None = None, user: str | None = None, **_: object):
        # docker's exec_run returns stdout and stderr as one stream.
        out, err, code = self.testbed.exec(f"{cmd} 2>&1", 1800, workdir or TESTBED)
        return types.SimpleNamespace(exit_code=code, output=(out + err).encode())


def evaluator_container(test_spec, client, run_id, logger, nocache, force_rebuild=False) -> EvaluatorContainer:
    """`docker_build.build_container`: a workspace booted from the instance image."""
    label = hashlib.sha1(f"{run_id}/{test_spec.instance_id}".encode()).hexdigest()[:8]
    testbed = Testbed(testbed_name("swbg", os.getpid(), f"{label}-{test_spec.instance_id}"),
                      image=test_spec.instance_image_key)
    info = testbed.up(os.getpid())
    try:
        network = testbed.network()
        if network != "none":
            raise PlueError(f"grading workspace {info['id']} is {network}, not sealed", "network")
    except BaseException:
        testbed.down(info["key"])
        raise
    logger.info(f"plue workspace {info['id']} from {test_spec.instance_image_key} (network {network})")
    return EvaluatorContainer(testbed, info["key"])


def evaluator_copy(container: EvaluatorContainer, src, dst) -> None:
    """`docker_utils.copy_to_container`."""
    parent = os.path.dirname(str(dst))
    if parent == "":
        raise ValueError(f"Destination path parent directory cannot be empty!, dst: {dst}")
    container.testbed.exec(f"mkdir -p -- {shlex.quote(parent)}", 120, "/")
    container.testbed.upload(str(src), str(dst))


def evaluator_exec_with_timeout(container: EvaluatorContainer, cmd: str, timeout: int | None = 60):
    """`docker_utils.exec_run_with_timeout`: (output, timed_out, seconds).

    coreutils `timeout` in the guest sends the TERM docker's version sends,
    and its 124 is how a timeout is told from the command's own status."""
    started = time.time()
    wrapped = f"timeout -s TERM {int(timeout)} {cmd}" if timeout else cmd
    budget = int(timeout) + 300 if timeout else plue_env._DEFAULT_EXEC_TIMEOUT_SEC
    out, err, code = container.testbed.exec(f"{wrapped} 2>&1", budget, TESTBED)
    return out + err, bool(timeout) and code == 124, time.time() - started


def evaluator_cleanup(client, container, logger) -> None:
    """`docker_utils.cleanup_container`: delete the workspace, free the slot."""
    if container is not None:
        container.testbed.down(container.key)


def observed(mode: str, probe: str) -> str:
    """The platform's network mode and the guest's probe, to the rig's condition."""
    return "none" if mode == "none" and "open " not in probe else "unsealed"


def split_target(spec: str) -> tuple[str, str]:
    """`<id>:<path>` to (id, path); a host path to ("", path)."""
    head, sep, tail = spec.partition(":")
    if sep and head and not head.startswith(("/", ".")) and tail.startswith("/"):
        return head, tail
    return "", spec


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="plue.py")
    verbs = parser.add_subparsers(dest="verb", required=True)
    up = verbs.add_parser("up")
    up.add_argument("label")
    up.add_argument("image")
    up.add_argument("--holder", type=int, default=os.getppid())
    run = verbs.add_parser("exec")
    run.add_argument("id")
    run.add_argument("--cwd", default="/testbed")
    run.add_argument("--timeout", type=int, default=3600)
    run.add_argument("command", nargs=argparse.REMAINDER)
    cp = verbs.add_parser("cp")
    cp.add_argument("source")
    cp.add_argument("target")
    net = verbs.add_parser("network")
    net.add_argument("id")
    shim = verbs.add_parser("shim")
    shim.add_argument("dir")
    snap = verbs.add_parser("snapshot")
    snap.add_argument("id")
    capture = verbs.add_parser("capture")
    capture.add_argument("id")
    capture.add_argument("out")
    verbs.add_parser("reap")
    down = verbs.add_parser("down")
    down.add_argument("id")
    down.add_argument("--key", default="")
    args = parser.parse_args(argv)
    try:
        if args.verb == "up":
            name = testbed_name("swb", args.holder, args.label)
            print(json.dumps(Testbed(name, image=args.image).up(args.holder)))
        elif args.verb == "exec":
            command = args.command[1:] if args.command[:1] == ["--"] else args.command
            if not command:
                parser.error("exec needs a command after --")
            out, err, code = Testbed("exec", workspace=args.id).exec(" ".join(command), args.timeout, args.cwd)
            sys.stdout.write(out)
            sys.stderr.write(err)
            return code
        elif args.verb == "cp":
            source, target = split_target(args.source), split_target(args.target)
            if bool(source[0]) == bool(target[0]):
                parser.error("exactly one side of cp is <id>:<path>")
            if source[0]:
                Testbed("cp", workspace=source[0]).download(source[1], target[1])
            else:
                Testbed("cp", workspace=target[0]).upload(source[1], target[1])
        elif args.verb == "network":
            print(Testbed("network", workspace=args.id).network())
        elif args.verb == "shim":
            config = plue_docker.shim_config(dict(os.environ), "/testbed")
            print(plue_docker.shim_directory(Path(args.dir), config))
        elif args.verb == "snapshot":
            print(Testbed("snapshot", workspace=args.id).snapshot())
        elif args.verb == "capture":
            Testbed("capture", workspace=args.id).capture(Path(args.out))
        elif args.verb == "reap":
            for name in reap():
                print(name)
        elif args.verb == "down":
            Testbed("down", workspace=args.id).down(args.key)
    except (PlueError, RuntimeError, subprocess.CalledProcessError) as error:
        code = getattr(error, "code", "")
        sys.stderr.write(f"plue.py {args.verb}: {code + ': ' if code else ''}{error}\n")
        return 125
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("SWB_PLUE_LOG", "WARNING"), stream=sys.stderr,
                        format="plue.py: %(message)s")
    sys.exit(main(sys.argv[1:]))
