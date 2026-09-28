#!/usr/bin/env python3
"""Checks the plue transport (`SWB_TRANSPORT=plue`) offline.

    python3 fixtures/check-plue-transport.py

A fake `smithers` CLI stands in for Smithers Cloud. It answers `workspace
create / exec / cp / delete / list` and runs every exec with `bash` over a
temporary directory that plays the guest's filesystem, so the rig's real
capture scripts run against a real git testbed, as they do in a workspace.

- `up` holds its ledger slot in the named holder's pid, creates the workspace
  from the instance image with `--network none` and `--idle-timeout 0`, and
  `down` deletes it with `--yes` and frees the slot;
- the network condition is read back twice, off plue's record and off the
  guest: `none` only when the mode is `none` and no connection opens, and
  `testbed-network.sh assert` refuses anything else;
- `snapshot` + `capture` report the agent's edit and nothing the image churned,
  list scratch as untracked, and leave no rig files in the guest;
- the evaluator's container is a workspace from `test_spec.instance_image_key`,
  its timeout is told apart from the command's own status, an unsealed grading
  workspace is refused and deleted, and `lib/grade.py` installs every one of
  those over the evaluator's docker calls and nothing else;
- `reap` deletes only this host's testbeds whose owning pid is gone;
- `SWB_TRANSPORT` is validated, the codex arm refuses plue, and the plue prompt
  seals the run to the workspace while the docker prompt is untouched.

Spends nothing: no network, no docker, no model, no evaluator venv.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import types
from pathlib import Path

RIG = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RIG / "lib"))
import plue  # noqa: E402

FAKE_CLI = r'''#!/usr/bin/env python3
import json, os, re, shutil, subprocess, sys
root, calls = os.environ["FAKE_ROOT"], os.environ["FAKE_CALLS"]
argv = sys.argv[1:]
with open(calls, "a") as log:
    log.write(json.dumps(argv) + "\n")
def guest(text):
    return re.sub(r"(?<![\w.])/(testbed|tmp/swb-rig|eval\.sh)", lambda m: f"{root}/{m.group(1)}", text)
def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default
verb = argv[1]
if verb == "create":
    counter = os.path.join(root, ".ids")
    n = int(open(counter).read()) + 1 if os.path.exists(counter) else 1
    open(counter, "w").write(str(n))
    print(json.dumps({"id": f"ws-{n}", "status": "running"}))
elif verb == "exec":
    command = opt("--command")
    command = re.sub(r"^.*?umask 022; export KMP_AFFINITY=\"\$\{KMP_AFFINITY:-disabled\}\"; ", "", command)
    if "boot_id" in command:
        out, err, code = "boot-1\n", "", 0
    elif "/dev/tcp/" in command:
        out, err, code = os.environ.get("FAKE_OPEN", ""), "", 0
    elif "sleep-forever" in command:
        out, err, code = "", "", 124
    else:
        command = re.sub(r"^timeout -s TERM \d+ ", "", command)
        cwd = guest(opt("--cwd", "/"))
        run = subprocess.run(["bash", "-c", guest(command)], cwd=cwd if os.path.isdir(cwd) else root,
                             capture_output=True, text=True)
        out, err, code = run.stdout, run.stderr, run.returncode
    print(json.dumps({"data": {"stdout": out, "stderr": err, "exit_code": code}}))
elif verb == "cp":
    source, target = argv[2], argv[3]
    source = guest(source.split(":", 1)[1]) if source.startswith("ws-") else source
    target = guest(target.split(":", 1)[1]) if target.startswith("ws-") else target
    if source.endswith("/."):
        shutil.copytree(source[:-2], target, dirs_exist_ok=True)
    else:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy(source, target)
    print("{}")
elif verb == "view":
    print(json.dumps({"id": argv[2], "network": {"mode": os.environ.get("FAKE_MODE", "none"), "allow": []}}))
elif verb == "delete":
    print("{}")
elif verb == "list":
    print(open(os.environ["FAKE_ROWS"]).read() if os.environ.get("FAKE_ROWS") else "[]")
else:
    print(json.dumps({"error": {"code": "unexpected", "message": " ".join(argv)}}))
    sys.exit(1)
'''


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def calls(env: dict) -> list[list[str]]:
    path = Path(env["FAKE_CALLS"])
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def cli(env: dict, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    run = subprocess.run([sys.executable, str(RIG / "lib" / "plue.py"), *args], env=env,
                         capture_output=True, text=True)
    if check and run.returncode != 0:
        raise AssertionError(f"plue.py {' '.join(args)} exited {run.returncode}: {run.stderr}")
    return run


def check_up_and_down(env: dict, directory: Path) -> None:
    holder = subprocess.Popen(["sleep", "60"])
    try:
        up = json.loads(cli(env, "up", "django__django-1-r91", "swebench/sweb.eval.x86_64.django_1776_django-1:latest",
                            "--holder", str(holder.pid)).stdout)
        assert up["id"] == "ws-1" and up["bootId"] == "boot-1", up
        name = f"swb-{plue.host_tag()}-{holder.pid}-django-django-1-r91"
        assert up["key"] == f"{holder.pid}:{name}", up
        ledger = json.loads(Path(env["PLUE_SLOT_LEDGER"]).read_text())
        assert ledger["holders"][up["key"]]["pid"] == holder.pid, "the slot is held in the run script's name"
        create = next(c for c in calls(env) if c[1] == "create")
        for flag, value in (("--image", "swebench/sweb.eval.x86_64.django_1776_django-1:latest"), ("--network", "none"),
                            ("--idle-timeout", "0"), ("--cpus", "2.0"), ("--name", name), ("--repo", "acme/bench")):
            assert create[create.index(flag) + 1] == value, (flag, create)
        assert "--disk" not in create and "--memory" not in create, "plue's defaults unless asked"
        cli(env, "down", up["id"], "--key", up["key"])
        delete = [c for c in calls(env) if c[1] == "delete"]
        assert delete and delete[-1][2] == "ws-1" and "--yes" in delete[-1], delete
        assert not json.loads(Path(env["PLUE_SLOT_LEDGER"]).read_text())["holders"], "down frees the slot"
    finally:
        holder.kill()
        holder.wait()


def check_network(env: dict) -> None:
    assert plue.observed("none", "") == "none"
    assert plue.observed("none", "open 1.1.1.1/80\n") == "unsealed", "a connection that opens is a breach"
    assert plue.observed("proxy", "") == "unsealed", "the platform's record must say none"
    assert cli(env, "network", "ws-1").stdout.strip() == "none"
    shell = {**env, "SWB_TRANSPORT": "plue"}
    sealed = subprocess.run([str(RIG / "lib" / "testbed-network.sh"), "assert", "ws-1", "none"],
                            env=shell, capture_output=True, text=True)
    assert sealed.returncode == 0 and sealed.stdout.strip() == "none", sealed
    for leak in ({"FAKE_OPEN": "open example.com/80\n"}, {"FAKE_MODE": "proxy"}):
        leaky = subprocess.run([str(RIG / "lib" / "testbed-network.sh"), "assert", "ws-1", "none"],
                               env={**shell, **leak}, capture_output=True, text=True)
        assert leaky.returncode == 1, (leak, "an unsealed guest stops the run")
    bridge = subprocess.run([str(RIG / "lib" / "testbed-network.sh"), "resolve"],
                            env={**shell, "SWB_TESTBED_NETWORK": "bridge"}, capture_output=True, text=True)
    assert bridge.returncode == 2, "plue has no bridge to offer"


def check_capture(env: dict, root: Path, directory: Path) -> None:
    testbed = root / "testbed"
    testbed.mkdir()
    git(testbed, "init", "--quiet")
    git(testbed, "config", "user.name", "image")
    git(testbed, "config", "user.email", "image@localhost")
    (testbed / "src.py").write_text("value = 1\n")
    (testbed / "tox.ini").write_text("commands=\n    pytest --durations 25\n")
    git(testbed, "add", "-A")
    git(testbed, "commit", "--quiet", "-m", "base")
    (testbed / "tox.ini").write_text("commands=\n    pytest -rA --durations 25\n")  # pre_install churn, unstaged
    base = cli(env, "snapshot", "ws-1").stdout.strip()
    assert git(testbed, "rev-parse", "refs/flows/capture-base") == base, "the capture base is recorded in the guest"
    assert not (root / "tmp" / "swb-rig").exists(), "no rig files are left in the guest after the snapshot"

    (testbed / "src.py").write_text("value = 2\n")
    (testbed / "scratch.py").write_text("assert False\n")
    out = directory / "patches" / "django__django-1.patch"
    cli(env, "capture", "ws-1", str(out))
    patch = out.read_text()
    assert "+value = 2" in patch and "src.py" in patch, patch
    assert "tox.ini" not in patch, "the image's own churn is not the agent's"
    assert "scratch.py" not in patch
    assert Path(f"{out}.untracked").read_text().split() == ["scratch.py"]
    assert not (root / "tmp" / "swb-rig").exists(), "no rig files are left in the guest after the capture"


def check_evaluator(env: dict) -> None:
    os.environ.update(env)
    ledger = Path(env["PLUE_SLOT_LEDGER"])
    logger = types.SimpleNamespace(info=lambda *_: None)
    spec = types.SimpleNamespace(instance_id="django__django-1",
                                 instance_image_key="swebench/sweb.eval.x86_64.django_1776_django-1:latest")
    container = plue.evaluator_container(spec, None, "luna-plue", logger, False)
    create = [c for c in calls(env) if c[1] == "create"][-1]
    assert create[create.index("--image") + 1] == spec.instance_image_key
    assert create[create.index("--network") + 1] == "none"
    assert create[create.index("--name") + 1].startswith(f"swbg-{plue.host_tag()}-{os.getpid()}-")
    assert json.loads(ledger.read_text())["holders"], "the grader holds a slot while it grades"
    container.start()
    result = container.exec_run("echo applied; echo warned >&2; exit 3", workdir="/testbed", user="root")
    assert result.exit_code == 3 and result.output == b"applied\nwarned\n", result
    assert plue.evaluator_exec_with_timeout(container, "echo ran", 1800)[:2] == ("ran\n", False)
    assert plue.evaluator_exec_with_timeout(container, "sleep-forever", 5)[1] is True, "124 is the timeout"
    # A destination path is data: its shell metacharacters reach mkdir quoted.
    guest_root = Path(env["FAKE_ROOT"])
    marker = guest_root.parent / "injected"
    source = guest_root.parent / "patch.diff"
    source.write_text("diff\n")
    hostile = f"/testbed/evil;touch {marker};$(touch {marker})/patch.diff"
    plue.evaluator_copy(container, source, hostile)
    assert not marker.exists(), "a hostile evaluator path ran a command in the guest"
    assert (guest_root / hostile.removeprefix("/")).read_text() == "diff\n", "the file lands at the literal path"
    plue.evaluator_cleanup(None, container, logger)
    assert [c for c in calls(env) if c[1] == "delete"][-1][2] == container.id
    assert not json.loads(ledger.read_text())["holders"], "cleanup frees the grader's slot"

    os.environ["FAKE_OPEN"] = "open 1.1.1.1/80\n"
    try:
        plue.evaluator_container(spec, None, "luna-plue", logger, False)
    except plue.PlueError as error:
        assert error.code == "network", error
    else:
        raise AssertionError("an unsealed grading workspace is refused")
    finally:
        os.environ.pop("FAKE_OPEN")
    assert [c for c in calls(env) if c[1] == "delete"][-1][2] == f"ws-{len([c for c in calls(env) if c[1] == 'create'])}"
    assert not json.loads(ledger.read_text())["holders"]


def check_grade_wiring() -> None:
    """`lib/grade.py` under plue replaces the evaluator's docker calls with
    `lib/plue.py`'s, against stand-in modules so no venv is needed."""
    names = ("docker", "swebench", "swebench.harness", "swebench.harness.docker_build",
             "swebench.harness.docker_utils", "swebench.harness.reporting")
    saved = {name: sys.modules.get(name) for name in names}
    for name in names:
        sys.modules[name] = types.ModuleType(name)
    reported = []
    sys.modules["swebench.harness.reporting"].make_run_report = lambda p, d, r, client=None: reported.append(client)
    try:
        import grade
        grade._install_plue_transport()
        build = sys.modules["swebench.harness.docker_build"]
        utils = sys.modules["swebench.harness.docker_utils"]
        assert build.build_container is plue.evaluator_container
        assert utils.copy_to_container is plue.evaluator_copy
        assert utils.exec_run_with_timeout is plue.evaluator_exec_with_timeout
        assert utils.cleanup_container is plue.evaluator_cleanup
        assert utils.list_images(None) == set() and utils.clean_images(None, set(), "env", False) is None
        assert sys.modules["docker"].from_env().images.list(all=True) == []
        sys.modules["swebench.harness.reporting"].make_run_report({}, [], "run", object())
        assert reported == [None], "the run report asks no docker client about images"
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def check_reap(env: dict, directory: Path) -> None:
    dead = subprocess.Popen(["true"])
    dead.wait()
    tag = plue.host_tag()
    other = "000000" if tag != "000000" else "111111"
    rows = [{"id": "a", "name": f"swb-{tag}-{dead.pid}-django-django-1-r91", "status": "running"},
            {"id": "b", "name": f"swbg-{tag}-{dead.pid}-abcd1234-django-django-1", "status": "running"},
            {"id": "c", "name": f"swb-{tag}-{os.getpid()}-live", "status": "running"},
            {"id": "d", "name": f"swb-{other}-{dead.pid}-another-host", "status": "running"},
            {"id": "e", "name": "wal-recovery-ordering-abc-env", "status": "running"}]
    Path(env["FAKE_ROWS"]).write_text(json.dumps(rows))
    before = len([c for c in calls(env) if c[1] == "delete"])
    reaped = cli(env, "reap").stdout.split()
    assert sorted(reaped) == sorted([rows[0]["name"], rows[1]["name"]]), reaped
    deleted = [c[2] for c in calls(env) if c[1] == "delete"][before:]
    assert sorted(deleted) == ["a", "b"], deleted


def check_shell_edges(env: dict) -> None:
    bad = subprocess.run([str(RIG / "lib" / "transport.sh")], env={**env, "SWB_TRANSPORT": "plu"},
                         capture_output=True, text=True)
    assert bad.returncode == 2, "a typo is a stopped run, not local docker"
    for value in ("", "docker", "plue"):
        ok = subprocess.run([str(RIG / "lib" / "transport.sh")], env={**env, "SWB_TRANSPORT": value},
                            capture_output=True, text=True)
        assert ok.stdout.strip() == (value or "docker"), (value, ok)
    codex = subprocess.run([str(RIG / "run-instance-codex.sh"), "django__django-1"],
                           env={**env, "SWB_TRANSPORT": "plue"}, capture_output=True, text=True)
    assert codex.returncode == 2 and "docker only" in codex.stderr, codex


def check_prompt(directory: Path) -> None:
    dataset = directory / "dataset.json"
    dataset.write_text(json.dumps([{"instance_id": "django__django-1", "repo": "django/django",
                                    "base_commit": "abc123", "problem_statement": "It breaks."}]))
    args = ["node", str(RIG / "lib" / "write-flow.mjs"), str(dataset), "django__django-1", "openai:gpt-6-luna",
            "ws-9", "./tests/runtests.py", "/opt/miniconda3/envs/testbed/bin/python"]
    docker = subprocess.run(args, env={k: v for k, v in os.environ.items() if k != "SWB_TRANSPORT"},
                            capture_output=True, text=True, check=True).stdout
    sealed = subprocess.run(args, env={**os.environ, "SWB_TRANSPORT": "plue"},
                            capture_output=True, text=True, check=True).stdout
    assert "macOS host" in docker and "act on this directory directly" in docker
    assert "macOS host" not in sealed and "There are no file flows" in sealed
    assert 'container: "ws-9", cwd: "/testbed"' in sealed and "The container has no network" in sealed
    for shared in ("./tests/runtests.py", "/opt/miniconda3/envs/testbed/bin/python", "## How to work", "It breaks."):
        assert shared in docker and shared in sealed, shared
    assert docker.split("## How to work")[1] == sealed.split("## How to work")[1], "one way of working, two transports"


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        root = directory / "guest"
        root.mkdir()
        fake = directory / "smithers"
        fake.write_text(FAKE_CLI)
        fake.chmod(0o755)
        env = {**os.environ, "SMITHERS_CLI": str(fake), "PLUE_REPO": "acme/bench", "SMITHERS_TOKEN": "t",
               "PLUE_SLOTS": "6", "PLUE_SLOT_LEDGER": str(directory / "slots.json"),
               "PLUE_LEAK_LOG": str(directory / "leaks.log"), "FAKE_ROOT": str(root),
               "FAKE_CALLS": str(directory / "calls.jsonl"), "FAKE_ROWS": str(directory / "rows.json")}
        env.pop("SWB_TRANSPORT", None)
        for name in ("FAKE_OPEN", "FAKE_MODE"):
            env.pop(name, None)
        check_up_and_down(env, directory)
        check_network(env)
        check_capture(env, root, directory)
        check_evaluator(env)
        check_grade_wiring()
        check_reap(env, directory)
        check_shell_edges(env)
        check_prompt(directory)
    print("check-plue-transport.py: workspace lifecycle and ledger slot, sealed network readback, in-guest "
          "capture, the evaluator's container, grade.py wiring, reap, transport validation and the sealed "
          "prompt hold.")


if __name__ == "__main__":
    main()
