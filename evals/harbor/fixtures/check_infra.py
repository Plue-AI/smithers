"""Offline checks of infrastructure containment on Smithers Cloud.

    python3 fixtures/check_infra.py          # structural checks
    HARBOR_PYTHON=<harbor python> verify.sh  # plus the checks that need Harbor

What is pinned, and the failure each one stops:

  - A trial is healthy only when it was graded, or graded after a whitelisted
    agent outcome (AgentTimeoutError; NonZeroAgentExitCodeError whose output
    carries no SSH or gateway transport error). Everything else is infra:
    retried, never scored. The 2026-09-23 pass counted VerifierTimeoutError,
    CancelledError and `ssh: connect to host … port 22` exits as healthy.
  - An SSH client transport failure (exit 255 plus OpenSSH's own message) is a
    PlueError, never the agent's exit status; the agent's own exit 255 is.
  - The host ledger caps running workspaces (the plan's concurrent-sandbox
    limit) as well as vCPU slots, and a trial's agent workspace hands its slot
    to that trial's verifier workspace instead of the queue: 66 of 66 TB4
    tasks verify in a separate workspace, and queueing it behind fresh trials
    inside Harbor's build timer was every VerifierTimeoutError of that pass.
  - The separate verifier workspace is reserved before Harbor's build timer.
  - No plue failure escapes a trial: an environment the plue backend cannot
    hold (a GPU task) is constructed and fails at reserve() with
    PlueUnplaceable, where Harbor records it; the 06:02 and 06:45 crashes were
    that RuntimeError raised inside Trial.create, which kills the job. Any
    non-plue exception inside an environment method becomes a PlueError, and
    stop() never raises: a workspace it could not delete is logged as leaked.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import tempfile
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import outcome  # noqa: E402
import plue_env  # noqa: E402


def result(exception: str | None = None, message: str = "", reward: float | None = None,
           finished: bool = True) -> dict:
    return {
        "finished_at": "2026-09-23T12:00:00Z" if finished else None,
        "exception_info": {"exception_type": exception, "exception_message": message} if exception else None,
        "verifier_result": {"rewards": {"reward": reward}} if reward is not None else None,
    }


SSH_CONNECT = ("Command failed (exit 255): ln -sf /tmp/codex-secrets/auth.json \"$CODEX_HOME/auth.json\"\n\n"
               "stdout: None\nstderr: ssh: connect to host ssh.jjhub.tech port 22: Operation timed out\n")
SSH_CLOSED = "Command failed (exit 255): codex exec …\nstderr: Connection to ssh.jjhub.tech closed by remote host.\r\n"
SSH_READ = ("Command failed (exit 255): codex exec …\nstderr: Read from remote host ssh.jjhub.tech: Operation timed out\r\n"
            "client_loop: send disconnect: Broken pipe\r\n")
AGENT_EXIT = "Command failed (exit 1): codex exec …\nstderr: error: model refused to continue\n"


def check_classification() -> None:
    cases = [
        (result(reward=1.0), "graded"),
        (result(reward=0.0), "graded"),
        (result("AgentTimeoutError", "Agent execution timed out after 28800 seconds", reward=0.0), "agent"),
        (result("NonZeroAgentExitCodeError", AGENT_EXIT, reward=0.0), "agent"),
        # The agent's own failure with no grade is not a score either.
        (result("NonZeroAgentExitCodeError", AGENT_EXIT), "infra"),
        (result("AgentTimeoutError", "timed out"), "infra"),
        (result("NonZeroAgentExitCodeError", SSH_CONNECT), "infra"),
        (result("NonZeroAgentExitCodeError", SSH_CLOSED, reward=0.0), "infra"),
        (result("NonZeroAgentExitCodeError", SSH_READ), "infra"),
        (result("VerifierTimeoutError", "Verifier execution timed out after 180.0 seconds"), "infra"),
        (result("CancelledError"), "infra"),
        (result("PlueError", "workspace not started"), "infra"),
        (result("EnvironmentStartTimeoutError", "Environment start timed out after 600.0 seconds"), "infra"),
        (result("AgentSetupTimeoutError"), "infra"),
        (result("ContainerUnreachable"), "infra"),
        (result("ModelRouteError"), "infra"),
        # A run held at waiting-approval was the harness's, never a 0.
        (result("RunParked", "run ended at waiting-approval", reward=0.0), "infra"),
        (result("RuntimeError", "anything unforeseen"), "infra"),
        # A grade next to an infrastructure exception is still infra.
        (result("PlueError", "delete failed", reward=1.0), "infra"),
        (result("PlueUnplaceable", "task asks for 8 vCPU"), "unplaceable"),
        (result(finished=False), "running"),
        ({}, "running"),
    ]
    for row, expected in cases:
        got = outcome.classify(row)
        assert got == expected, (expected, got, row)
    assert outcome.is_healthy("graded") and outcome.is_healthy("agent")
    assert not any(outcome.is_healthy(k) for k in ("infra", "unplaceable", "running"))
    # The retry filter Harbor needs: every infra exception type seen above.
    for name in ("VerifierTimeoutError", "CancelledError", "PlueError", "EnvironmentStartTimeoutError",
                 "AgentSetupTimeoutError", "ContainerUnreachable", "ModelRouteError", "RunParked",
                 # vba-userform-port, 2026-09-23: npm ECONNRESET through the egress
                 # proxy aborted test.sh before it wrote a reward.
                 "RewardFileNotFoundError", "RewardFileEmptyError", "VerifierOutputParseError",
                 "DownloadVerifierDirError", "AddTestsDirError"):
        assert name in outcome.INFRA_EXCEPTIONS, name
    assert "PlueUnplaceable" not in outcome.INFRA_EXCEPTIONS
    flags = outcome.retry_flags().split()
    assert flags[:2] == ["-r", "3"] and flags.count("--retry-include") == len(outcome.INFRA_EXCEPTIONS)
    assert outcome.ssh_transport_error(SSH_READ) and outcome.ssh_transport_error(SSH_CONNECT)
    assert outcome.ssh_transport_error(AGENT_EXIT) is None


def check_ledger() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "slots.json"
        ledger = plue_env.SlotLedger(path, capacity=6, max_holders=3)
        for key in ("a__env", "b__env", "c__env"):
            ledger.enqueue(key, 1)
            assert ledger.try_grant(key), key
        ledger.enqueue("d__env", 1)
        assert ledger.try_grant("d__env") is False, "3 workspaces is the plan's cap though 3 slots are free"

        # a's agent workspace ends; its verifier is next, not d.
        ledger.release("a__env", heir="a__verifier__")
        assert ledger.try_grant("d__env") is False, "the slot is held for a's verifier"
        ledger.enqueue("a__verifier__trial", 2)
        state = json.loads(path.read_text())
        assert state["waiters"][0]["key"] == "a__verifier__trial", "an heir queues first"
        assert ledger.try_grant("a__verifier__trial") is True, "the heir takes the slot at once"
        state = json.loads(path.read_text())
        assert set(state["holders"]) == {"a__verifier__trial", "b__env", "c__env"}, state["holders"]
        assert state["used"] == 4

        # An unclaimed handover expires instead of leaking the slot.
        ledger.release("b__env", heir="b__verifier__", ttl=0)
        assert ledger.try_grant("d__env") is True, "an expired handover frees the slot"

        # No cap: behaviour is the plain vCPU ledger.
        free = plue_env.SlotLedger(Path(directory) / "free.json", capacity=2)
        for key in ("x", "y"):
            free.enqueue(key, 1)
            assert free.try_grant(key)

    os.environ.update(PLUE_SLOTS="6", PLUE_MAX_WORKSPACES="3", PLUE_SLOT_LEDGER=str(Path(tempfile.gettempdir()) / "l.json"))
    try:
        assert plue_env.SlotLedger.from_environment().max_holders == 3
    finally:
        for name in ("PLUE_SLOTS", "PLUE_MAX_WORKSPACES", "PLUE_SLOT_LEDGER"):
            os.environ.pop(name, None)
    assert plue_env.heir_of("wal__gRv__env") == "wal__gRv__verifier__"
    assert plue_env.heir_of("wal__gRv__verifier__trial") is None


def fake_ops(cli: Path, workspace: str = "ws-1") -> "plue_env._PlueOps":
    os.environ["SMITHERS_CLI"] = str(cli)
    os.environ["PLUE_REPO"] = "acme/bench"
    ops = plue_env._PlueOps()
    ops._workspace_id = workspace
    ops.logger = logging.getLogger("check")
    ops.task_env_config = types.SimpleNamespace(workdir=None, cpus=2)
    ops.session_id = "t1__env"
    ops.environment_dir = "/nonexistent/environment"
    return ops


def check_transport_and_containment() -> None:
    with tempfile.TemporaryDirectory() as directory:
        cli = Path(directory) / "smithers"
        cli.write_text("#!/bin/sh\n"
                       "case \"$*\" in\n"
                       "  *connectfail*) printf '%s' '{\"data\":{\"stdout\":\"\",\"stderr\":\"ssh: connect to host ssh.jjhub.tech port 22: Operation timed out\\r\\n\",\"exit_code\":255}}'; exit 255;;\n"
                       "  *dropped*) printf '%s' '{\"data\":{\"stdout\":\"half\",\"stderr\":\"\",\"exit_code\":255}}'; printf 'Connection to ssh.jjhub.tech closed by remote host.\\r\\n' >&2; exit 255;;\n"
                       "  *own255*) printf '%s' '{\"data\":{\"stdout\":\"\",\"stderr\":\"fatal: bad object\\n\",\"exit_code\":255}}'; exit 255;;\n"
                       "  *notjson*) printf 'not json {'; exit 0;;\n"
                       "  *delete*--yes*) printf '%s' '{\"error\":{\"code\":\"UNKNOWN\",\"message\":\"502 bad gateway\"}}'; exit 1;;\n"
                       "  *delete*) printf '%s' '{\"error\":{\"code\":\"UNKNOWN\",\"message\":\"requires --yes when stdin is not a TTY\"}}'; exit 1;;\n"
                       "  *) printf '%s' '{\"data\":{\"stdout\":\"ok\",\"stderr\":\"\",\"exit_code\":0}}';;\n"
                       "esac\n")
        cli.chmod(0o755)
        leaks = Path(directory) / "leaks.log"
        os.environ["PLUE_LEAK_LOG"] = str(leaks)
        plue_env._EXEC_REATTACH_BACKOFF_SEC = (0, 0)  # reattach twice, then give up
        try:
            ops = fake_ops(cli)
            for command in ("connectfail", "dropped"):
                try:
                    asyncio.run(ops._plue_exec(command))
                except plue_env.PlueError as error:
                    assert error.code == "ssh_transport", (command, error.code)
                else:
                    raise AssertionError(f"{command}: an SSH client transport failure is a PlueError")
            assert asyncio.run(ops._plue_exec("own255")) == ("", "fatal: bad object\n", 255), "the command's own 255 is its exit"
            try:
                asyncio.run(ops._plue_exec("notjson"))
            except plue_env.PlueError:
                pass
            else:
                raise AssertionError("an unreadable CLI reply is a PlueError, not a ValueError")

            # A CLI that cannot be spawned is a PlueError, not an OSError.
            missing = fake_ops(Path(directory) / "absent")
            try:
                asyncio.run(missing._plue_exec("true"))
            except plue_env.PlueError:
                pass
            else:
                raise AssertionError("a missing CLI is a PlueError")

            # stop() never raises; the undeleted workspace is logged, the slot freed.
            ledger_path = Path(directory) / "slots.json"
            os.environ.update(PLUE_SLOTS="6", PLUE_SLOT_LEDGER=str(ledger_path))
            ops = fake_ops(cli, workspace="ws-leak")
            ops._plue_ledger_key = "k1__env"
            ledger = plue_env.SlotLedger(ledger_path, 6)
            ledger.enqueue("k1__env", 1)
            assert ledger.try_grant("k1__env")
            plue_env._DELETE_BACKOFF_SEC = 0
            asyncio.run(ops._plue_stop())
            assert "ws-leak" in leaks.read_text()
            assert "502 bad gateway" in leaks.read_text(), "delete passes --yes: the CLI refuses it off a TTY"
            assert not json.loads(ledger_path.read_text())["holders"], "the slot is released"
            assert ops._workspace_id == ""
        finally:
            for name in ("SMITHERS_CLI", "PLUE_REPO", "PLUE_LEAK_LOG", "PLUE_SLOTS", "PLUE_SLOT_LEDGER"):
                os.environ.pop(name, None)


def check_image_tmp() -> None:
    """The guest's /tmp is the image's /tmp, as under Docker. The microsandbox
    guest init mounts a 512 MiB tmpfs over it, which hid layout-config-
    recreation2's /tmp/google_fonts_cache (1393 fonts) from its own oracle."""
    with tempfile.TemporaryDirectory() as directory:
        calls = Path(directory) / "calls"
        cli = Path(directory) / "smithers"
        cli.write_text("#!/bin/sh\n"
                       f"printf '%s\\n' \"$*\" >> {calls}\n"
                       "printf '%s' '{\"data\":{\"stdout\":\"\",\"stderr\":\"\",\"exit_code\":0}}'\n")
        cli.chmod(0o755)
        try:
            ops = fake_ops(cli)
            ops._plue_reserved = True
            ops._plue_image = ""
            ops._plue_copies, ops._plue_chmods = [], []
            asyncio.run(ops._plue_start())
        finally:
            for name in ("SMITHERS_CLI", "PLUE_REPO"):
                os.environ.pop(name, None)
        first = calls.read_text().splitlines()[0]
        assert "umount -l /tmp" in first and "mkdir -p /logs/agent" in first, first
        assert first.index("umount -l /tmp") < first.index("mkdir -p /logs/agent"), first
        assert len(calls.read_text().splitlines()) == 1, "one exec, no extra round trip"


def check_sidecars() -> None:
    """A task whose compose file adds services beside `main` cannot run on one
    plue workspace: sidecars need their own filesystems (freight-dispatch-
    shift's event feed hides future records from the agent) and container
    networking plue workspaces do not have. It is unplaceable, never a 0."""
    with tempfile.TemporaryDirectory() as directory:
        env_dir = Path(directory)
        assert plue_env.compose_sidecars(env_dir) == []
        (env_dir / "docker-compose.yaml").write_text(
            "services:\n  main:\n    environment:\n    - A=1\n"
            "  event-feed:\n    image: x\n  kafka:\n    image: y\n")
        assert plue_env.compose_sidecars(env_dir) == ["event-feed", "kafka"]
        (env_dir / "docker-compose.yaml").write_text("services:\n  main:\n    cap_add: [SYS_PTRACE]\n")
        assert plue_env.compose_sidecars(env_dir) == []
        (env_dir / "docker-compose.yaml").write_text("services:\n  main:\n  loadgen:\n    image: z\n")
        ops = plue_env._PlueOps()
        ops.environment_dir = str(env_dir)
        ops.task_env_config = types.SimpleNamespace(docker_image="img")
        try:
            ops._validate_definition()
        except plue_env.PlueUnplaceable as error:
            assert error.code == "sidecars" and "loadgen" in str(error), error
        else:
            raise AssertionError("a task with sidecars is unplaceable on plue")


def check_trial_containment() -> None:
    """Harbor's Trial constructor refuses a task whose artifacts name a
    compose sidecar on a provider without compose (payments-pipeline-fix:
    `kafka`). That raise is in Trial.create, outside the trial, and ended the
    2026-09-23 10:3x oracle gate. It is deferred to _prepare()."""
    class Trial:
        def __init__(self):
            self.prepared = False
            self._validate_artifact_configuration()
            self._validate_network_policy_modes()

        def _validate_artifact_configuration(self):
            raise ValueError("Task references compose sidecar services ['kafka'] ...")

        def _validate_network_policy_modes(self):
            pass

        async def _prepare(self):
            self.prepared = True

    try:
        Trial()
    except ValueError:
        pass
    else:
        raise AssertionError("the control: the unpatched constructor raises")
    plue_env.install_trial_containment(Trial)
    plue_env.install_trial_containment(Trial)  # idempotent
    trial = Trial()
    try:
        asyncio.run(trial._prepare())
    except plue_env.PlueUnplaceable as error:
        assert "kafka" in str(error) and error.code == "unsupported", error
    else:
        raise AssertionError("the deferred refusal is raised inside the trial")
    assert not trial.prepared

    class Fine(Trial):
        def _validate_artifact_configuration(self):
            pass
    plue_env.install_trial_containment(Fine)
    fine = Fine()
    asyncio.run(fine._prepare())
    assert fine.prepared


def check_durable_exec_and_workdir() -> None:
    """Every exec carries a unique --exec-id and a lost transport reattaches
    to the same id instead of relaunching (plue durable exec, CLI 71c3ed6a+);
    a VM that is gone is not retried. Commands run in the image's WORKDIR, as
    `docker exec` does (ontology-kg-querying's oracle writes ./pipeline.py and
    ran in the superuser's home on plue)."""
    import image_config
    with tempfile.TemporaryDirectory() as directory:
        calls, count = Path(directory) / "calls", Path(directory) / "count"
        cli = Path(directory) / "smithers"
        # 1st exec call: transport lost; 2nd: reattached result. `vmgone`: 409.
        cli.write_text("#!/bin/sh\n"
                       f"printf '%s\\n' \"$*\" >> {calls}\n"
                       f"n=$(cat {count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {count}\n"
                       "case \"$*\" in\n"
                       "  *vmgone*) printf '%s' '{\"error\":{\"code\":\"UNKNOWN\",\"message\":\"workspace x did not become SSH-ready within 2m0s: GET ... -> 409: workspace VM no longer exists\"}}'; exit 1;;\n"
                       "esac\n"
                       "if [ $n = 1 ]; then printf 'Connection to ssh.jjhub.tech closed by remote host.\\r\\n' >&2; "
                       "printf '%s' '{\"exit_code\":255,\"stdout\":\"\",\"stderr\":\"\"}'; exit 255; fi\n"
                       "printf '%s' '{\"exit_code\":0,\"stdout\":\"done\\n\",\"stderr\":\"\"}'\n")
        cli.chmod(0o755)
        plue_env._EXEC_REATTACH_BACKOFF_SEC = (0,)
        try:
            ops = fake_ops(cli)
            ops._plue_workdir = "/workspace"
            assert asyncio.run(ops._plue_exec("long job")) == ("done\n", "", 0)
            lines = calls.read_text().splitlines()
            assert len(lines) == 2, lines
            ids = [line.split("--exec-id ")[1].split()[0] for line in lines]
            assert ids[0] == ids[1] and ids[0].startswith("t1-env-"), ids
            assert all("--cwd /workspace" in line for line in lines), lines
            calls.write_text("")
            asyncio.run(ops._plue_exec("pwd", cwd="/tmp"))
            assert "--cwd /tmp" in calls.read_text(), "an explicit cwd wins"
            second = asyncio.run(ops._plue_exec("again"))
            assert second == ("done\n", "", 0)
            used = [line.split("--exec-id ")[1].split()[0] for line in calls.read_text().splitlines()]
            assert len(set(used)) == 2, "every exec has its own id"
            calls.write_text("")
            try:
                asyncio.run(ops._plue_exec("vmgone"))
            except plue_env.PlueError as error:
                assert "no longer exists" in str(error)
            else:
                raise AssertionError("a lost VM is a PlueError")
            assert len(calls.read_text().splitlines()) == 1, "a lost VM is not reattached"
        finally:
            for name in ("SMITHERS_CLI", "PLUE_REPO"):
                os.environ.pop(name, None)

        # WORKDIR from the image config, cached by reference.
        cache = Path(directory) / "images.json"
        fetched = []
        def fetch(image):
            fetched.append(image)
            return {"config": {"WorkingDir": "/app", "User": "agent"}}
        assert image_config.working_dir("r/x@sha256:1", cache=cache, fetch=fetch) == "/app"
        assert image_config.working_dir("r/x@sha256:1", cache=cache, fetch=fetch) == "/app"
        assert fetched == ["r/x@sha256:1"], "the second lookup is cached"
        assert image_config.working_dir("r/y@sha256:2", cache=cache, fetch=lambda i: {"config": {}}) is None
        def broken(image):
            raise OSError("registry down")
        assert image_config.working_dir("r/z@sha256:3", cache=cache, fetch=broken) is None, "a lookup failure is no WORKDIR"
        assert image_config.parse("harborframework/terminal-bench:t@sha256:ab") == ("registry-1.docker.io", "harborframework/terminal-bench", "sha256:ab")
        assert image_config.parse("ubuntu:24.04") == ("registry-1.docker.io", "library/ubuntu", "24.04")
        assert image_config.parse("ghcr.io/o/r:1") == ("ghcr.io", "o/r", "1")

    import smithers_agent
    env = types.SimpleNamespace(task_env_config=types.SimpleNamespace(workdir=None), _plue_workdir="/task")
    agent = object.__new__(smithers_agent.SmithersAgent)
    agent._cwd_override = None
    assert agent.container_cwd(env) == "/task", "the arm-A prompt names the image WORKDIR"
    env._plue_workdir = None
    assert agent.container_cwd(env) == "/app"


def check_shim_durable_exec() -> None:
    """Arm A's `docker exec` shim: an exec without stdin carries a durable
    exec id and reattaches after a lost transport; with stdin it stays one
    connection (plue cannot detach a streamed stdin). No -w means the image
    WORKDIR the adapter wrote into the shim config."""
    import subprocess as sp
    import plue_docker
    with tempfile.TemporaryDirectory() as directory:
        calls, count = Path(directory) / "calls", Path(directory) / "count"
        cli = Path(directory) / "smithers"
        cli.write_text("#!/bin/sh\n"
                       f"printf '%s\\n' \"$*\" >> {calls}\n"
                       f"n=$(cat {count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {count}\n"
                       "if [ $n = 1 ]; then printf 'ssh: connect to host ssh.jjhub.tech port 22: Operation timed out\\r\\n' >&2; exit 255; fi\n"
                       "printf '%s' '{\"exit_code\":7,\"stdout\":\"out\",\"stderr\":\"\"}'; exit 7\n")
        cli.chmod(0o755)
        bin_dir = Path(directory) / "bin"
        bin_dir.mkdir()
        (bin_dir / "docker").symlink_to(HERE.parent / "plue_docker.py")
        (bin_dir / plue_docker.CONFIG_NAME).write_text(json.dumps(
            {"repo": "acme/bench", "cli": str(cli), "env": {}, "workdir": "/workspace", "reattach_backoff_sec": [0]}))
        run = sp.run([sys.executable, str(bin_dir / "docker"), "exec", "--", "ws-1", "sh", "-c", "make"],
                     capture_output=True, text=True, stdin=sp.DEVNULL)
        assert run.returncode == 7 and run.stdout == "out", (run.returncode, run.stdout, run.stderr)
        lines = calls.read_text().splitlines()
        assert len(lines) == 2, lines
        ids = [line.split("--exec-id ")[1].split()[0] for line in lines]
        assert ids[0] == ids[1], "the reattach reuses the exec id"
        assert all("--cwd /workspace" in line for line in lines), lines

        calls.write_text("")
        count.write_text("0")
        run = sp.run([sys.executable, str(bin_dir / "docker"), "exec", "-i", "-w", "/src", "--", "ws-1", "cat"],
                     capture_output=True, text=True, input="x")
        lines = calls.read_text().splitlines()
        assert run.returncode == 255 and len(lines) == 1, (run.returncode, lines)
        assert "--exec-id" not in lines[0] and "--cwd /src" in lines[0], lines

        # An SSH gateway denial is waited out, not handed to the agent.
        calls.write_text("")
        count.write_text("0")
        cli.write_text("#!/bin/sh\n"
                       f"printf '%s\\n' \"$*\" >> {calls}\n"
                       f"n=$(cat {count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {count}\n"
                       "if [ $n -le 2 ]; then echo 'x@ssh.jjhub.tech: Permission denied (password,publickey).' >&2; exit 1; fi\n"
                       "printf '%s' '{\"exit_code\":0,\"stdout\":\"ok\",\"stderr\":\"\"}'\n")
        config = json.loads((bin_dir / plue_docker.CONFIG_NAME).read_text())
        (bin_dir / plue_docker.CONFIG_NAME).write_text(json.dumps({**config, "auth_poll_sec": 0.05}))
        run = sp.run([sys.executable, str(bin_dir / "docker"), "exec", "--", "ws-1", "true"],
                     capture_output=True, text=True, stdin=sp.DEVNULL)
        assert run.returncode == 0 and run.stdout == "ok", (run.returncode, run.stdout, run.stderr)
        assert len(calls.read_text().splitlines()) == 3


def check_guest_prelude() -> None:
    """Every exec runs under `docker exec`'s umask, 0022. Intel OpenMP asserts in kmp_affinity.cpp(642) on the plue guest's CPU
    topology (each vCPU its own socket): vllm-deepseek-streaming's oracle
    died with exit 134. Every exec, the shim's included, defaults
    KMP_AFFINITY=disabled (no thread pinning, same results) unless the task
    set it."""
    import subprocess as sp
    import plue_docker
    prelude = plue_env.with_egress("true")
    assert "KMP_AFFINITY" in prelude and plue_docker.EGRESS_PREFIX == plue_env.EGRESS_PREFIX
    run = lambda env: sp.run(["sh", "-c", plue_env.with_egress('printf %s "$KMP_AFFINITY"')],
                             capture_output=True, text=True, env=env).stdout
    assert run({"PATH": os.environ["PATH"]}) == "disabled"
    assert run({"PATH": os.environ["PATH"], "KMP_AFFINITY": "compact"}) == "compact", "a task's own setting wins"
    # data-anonymization, 2026-09-23: plue CLI 71c3ed6a runs durable execs
    # under umask 0077 in that image (0022 with the old CLI), so the oracle's
    # /app/anon.py was 0600 and the verifier's dropped-privilege run could not
    # read it. `docker exec` runs under 0022.
    umask = sp.run(["sh", "-c", "umask 077; " + plue_env.with_egress("umask")], capture_output=True, text=True).stdout.strip()
    assert umask in ("0022", "022"), umask


def check_disk_request_preservation() -> None:
    """TB4 51200-MB disk request preservation: pass the full disk to create
    at an eligible limit; refuse a request above it before calling the CLI."""
    previous = os.environ.get("PLUE_MAX_STORAGE_MB")
    previous_repo = os.environ.get("PLUE_REPO")
    os.environ["PLUE_MAX_STORAGE_MB"] = "51200"
    os.environ["PLUE_REPO"] = "acme/bench"
    try:
        ops = plue_env._PlueOps()
        ops.logger = logging.getLogger("check")
        ops.session_id = "t__x__env"
        ops.task_env_config = types.SimpleNamespace(cpus=4, storage_mb=51200)
        ops._plue_reserved = False
        ops._plue_image = "task-image"
        ops._plue_network = lambda: ("none", [])
        ops._plue_ledger = lambda: None
        calls = []

        async def capture(*args, **kwargs):
            calls.append(args)
            return types.SimpleNamespace(stdout=b'{"id":"ws-1","status":"running"}')

        ops._run = capture
        asyncio.run(ops._plue_reserve())
        assert len(calls) == 1, calls
        args = calls[0]
        assert args[:2] == ("workspace", "create") and args[args.index("--disk") + 1] == "51200", args
        assert ops._workspace_id == "ws-1", ops._workspace_id

        ops._plue_reserved = False
        ops.task_env_config.storage_mb = 51201
        try:
            asyncio.run(ops._plue_reserve())
        except plue_env.PlueUnplaceable as error:
            assert error.code == "unplaceable" and "51201" in str(error) and "51200" in str(error), error
        else:
            raise AssertionError("a disk beyond the eligible host limit must be refused")
        assert len(calls) == 1, "unplaceable requests must not reach workspace create"
    finally:
        if previous is None:
            os.environ.pop("PLUE_MAX_STORAGE_MB", None)
        else:
            os.environ["PLUE_MAX_STORAGE_MB"] = previous
        if previous_repo is None:
            os.environ.pop("PLUE_REPO", None)
        else:
            os.environ["PLUE_REPO"] = previous_repo


def check_retried_attempts_are_kept() -> None:
    """Harbor's in-process retry deletes the failed attempt's directory, so
    the hourly infra rate never saw it and its evidence was lost (arm A's
    r2 preflight: a ModelRouteError attempt vanished). The retry now moves a
    finished attempt to <job>.infra/, and health.py counts it."""
    import health
    from datetime import datetime, timedelta, timezone
    queue = types.SimpleNamespace(shutil=__import__("shutil"))
    plue_env.keep_retried_attempts(queue)
    plue_env.keep_retried_attempts(queue)  # idempotent
    with tempfile.TemporaryDirectory() as directory:
        job = Path(directory) / "tb4-X"
        trial = job / "task__abc"
        trial.mkdir(parents=True)
        (trial / "config.json").write_text("{}")
        recent = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        (trial / "result.json").write_text(json.dumps({**result("ModelRouteError", "call_timeout"), "finished_at": recent}))
        queue.shutil.rmtree(trial, ignore_errors=True)
        assert not trial.exists()
        kept = list((Path(directory) / "tb4-X.infra").iterdir())
        assert len(kept) == 1 and kept[0].name.startswith("task__abc"), kept
        trial.mkdir()
        (trial / "config.json").write_text("{}")
        (trial / "result.json").write_text(json.dumps({**result("ModelRouteError", "again"), "finished_at": recent}))
        queue.shutil.rmtree(trial, ignore_errors=True)
        assert len(list((Path(directory) / "tb4-X.infra").iterdir())) == 2, "a second attempt does not overwrite the first"
        scratch = Path(directory) / "scratch"
        scratch.mkdir()
        queue.shutil.rmtree(scratch)
        assert not scratch.exists(), "anything else is still deleted"
        (job / "ok__1").mkdir()
        (job / "ok__1" / "config.json").write_text("{}")
        (job / "ok__1" / "result.json").write_text(json.dumps({**result(reward=1.0), "finished_at": recent}))
        out = Path(directory) / "h.md"
        assert health.main([directory, str(out), "tb4-X"]) == 3, "2 retried infra attempts of 3 in the hour trip"


def check_guest_restart_watchdog() -> None:
    """A worker replacement restarts the guest; the durable exec's command
    dies with it but the CLI keeps waiting for an exit status that never
    comes (arm B's r2 preflight: 60 min idle, up to --timeout 28800). A
    long exec watches the guest's boot_id and fails as guest_restarted."""
    import time as _time
    with tempfile.TemporaryDirectory() as directory:
        cli = Path(directory) / "smithers"
        cli.write_text("#!/bin/sh\n"
                       "case \"$*\" in\n"
                       "  *boot_id*) printf '%s' '{\"exit_code\":0,\"stdout\":\"boot-2\\n\",\"stderr\":\"\"}';;\n"
                       "  *) sleep 30; printf '%s' '{\"exit_code\":0,\"stdout\":\"late\",\"stderr\":\"\"}';;\n"
                       "esac\n")
        cli.chmod(0o755)
        saved = (plue_env._WATCH_EVERY_SEC, plue_env._WATCH_MIN_SEC)
        plue_env._WATCH_EVERY_SEC, plue_env._WATCH_MIN_SEC = 0.3, 0
        try:
            ops = fake_ops(cli)
            ops._plue_boot_id = "boot-1"
            started = _time.monotonic()
            try:
                asyncio.run(ops._plue_exec("codex exec", timeout_sec=28800))
            except plue_env.PlueError as error:
                assert error.code == "guest_restarted", error.code
                assert not plue_env.reattachable(error)
            else:
                raise AssertionError("a restarted guest fails the exec")
            assert _time.monotonic() - started < 10, "it fails at the next check, not at the timeout"
            ops._plue_boot_id = "boot-2"  # same guest: the exec runs to its end
            plue_env._WATCH_EVERY_SEC = 0.3
            cli.write_text(cli.read_text().replace("sleep 30", "sleep 1"))
            assert asyncio.run(ops._plue_exec("short", timeout_sec=28800))[0] == "late"
        finally:
            plue_env._WATCH_EVERY_SEC, plue_env._WATCH_MIN_SEC = saved
            for name in ("SMITHERS_CLI", "PLUE_REPO"):
                os.environ.pop(name, None)


def check_auth_denial_waits() -> None:
    """The SSH gateway bans this host's IP for 15 min (doubling) after 5
    workspace logins it could not validate, e.g. while VMs restart; every
    exec and copy then gets `Permission denied (password,publickey)`. That
    is not the trial's failure: exec and cp wait it out (polls during a ban
    do not extend it), then fail as infra."""
    with tempfile.TemporaryDirectory() as directory:
        count = Path(directory) / "count"
        cli = Path(directory) / "smithers"
        cli.write_text("#!/bin/sh\n"
                       f"n=$(cat {count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {count}\n"
                       "if [ $n -le 3 ]; then echo 'msb_1+root:tok@ssh.jjhub.tech: Permission denied (password,publickey).' >&2; exit 1; fi\n"
                       "case \"$*\" in *\" cp \"*|cp\ *) printf '%s' '{\"ok\":true}';; *) printf '%s' '{\"exit_code\":0,\"stdout\":\"in\",\"stderr\":\"\"}';; esac\n")
        cli.chmod(0o755)
        saved = (plue_env._AUTH_WAIT_SEC, plue_env._AUTH_POLL_SEC)
        plue_env._AUTH_WAIT_SEC, plue_env._AUTH_POLL_SEC = 30, 0.05
        try:
            ops = fake_ops(cli)
            assert asyncio.run(ops._plue_exec("true"))[0] == "in", "an exec waits out the denial"
            count.write_text("0")
            asyncio.run(ops._plue_upload(__file__, "/tmp/x"))  # a copy waits too
            assert int(count.read_text()) == 4
            count.write_text("-100")
            plue_env._AUTH_WAIT_SEC = 0.2
            try:
                asyncio.run(ops._plue_exec("true"))
            except plue_env.PlueError as error:
                assert plue_env.auth_denied(error), error
            else:
                raise AssertionError("a denial past the wait is a PlueError")
        finally:
            plue_env._AUTH_WAIT_SEC, plue_env._AUTH_POLL_SEC = saved
            for name in ("SMITHERS_CLI", "PLUE_REPO"):
                os.environ.pop(name, None)


def check_ledger_bins_and_retry() -> None:
    """The 2026-09-24 00:00 stall. (1) A trial retried in-process reuses its
    ledger key; it found the last attempt's handover entry, took it as held,
    and the entry expired 180 s later: a running 4-vCPU VM the ledger no
    longer counted. (2) A flat slot count granted three 4-vCPU guests on two
    7-vCPU hosts; only first-fit bins say what can be placed."""
    with tempfile.TemporaryDirectory() as directory:
        ledger = plue_env.SlotLedger(Path(directory) / "l.json", capacity=6, hosts=2, host_cpus=7)
        ledger.enqueue("t1__env", 2, cpus=4)
        assert ledger.try_grant("t1__env")
        ledger.release("t1__env", heir="t1__verifier__")  # attempt 1 ends
        ledger.enqueue("t1__env", 2, cpus=4)                # attempt 2, same key
        assert ledger.try_grant("t1__env")
        state = json.loads((Path(directory) / "l.json").read_text())
        assert "until" not in state["holders"]["t1__env"] and "heir" not in state["holders"]["t1__env"], \
            "a re-reserved key is held again, not left to expire"

        ledger.enqueue("t2__env", 2, cpus=4)
        assert ledger.try_grant("t2__env"), "second host"
        ledger.enqueue("t3__env", 2, cpus=4)
        assert not ledger.try_grant("t3__env"), "a third 4-vCPU guest fits no 7-vCPU host"
        ledger.release("t3__env")
        ledger.enqueue("t4__env", 1, cpus=2)
        assert ledger.try_grant("t4__env"), "2 vCPU fits beside a 4"
        ledger.enqueue("t5__env", 1, cpus=2)
        assert ledger.try_grant("t5__env")
        ledger.enqueue("t6__env", 1, cpus=2)
        assert not ledger.try_grant("t6__env"), "4+2 on each host leaves 1 vCPU"

        # A handover to a verifier must fit the bins too.
        ledger.release("t1__env", heir="t1__verifier__")
        ledger.enqueue("t1__verifier__trial", 2, cpus=4)
        assert ledger.try_grant("t1__verifier__trial"), "the verifier takes the agent's 4 vCPU"

        flat = plue_env.SlotLedger(Path(directory) / "f.json", capacity=6)
        for k in ("a", "b", "c"):
            flat.enqueue(k, 2, cpus=4)
            assert flat.try_grant(k), "no hosts configured: the plain slot count"

    os.environ.update(PLUE_SLOTS="6", PLUE_HOSTS="2", PLUE_HOST_CPUS="7",
                      PLUE_SLOT_LEDGER=str(Path(tempfile.gettempdir()) / "l2.json"))
    try:
        l = plue_env.SlotLedger.from_environment()
        assert (l.hosts, l.host_cpus) == (2, 7)
    finally:
        for name in ("PLUE_SLOTS", "PLUE_HOSTS", "PLUE_HOST_CPUS", "PLUE_SLOT_LEDGER"):
            os.environ.pop(name, None)


def check_janitor() -> None:
    """Trial workspaces are created with --idle-timeout 0, so a failed or
    suspended one is dead and still holds host CPU and disk (three from
    killed trials held both hosts on 2026-09-24). The janitor deletes those,
    only trial-named ones, and never a running one."""
    import requeue
    with tempfile.TemporaryDirectory() as directory:
        calls = Path(directory) / "calls"
        cli = Path(directory) / "smithers"
        rows = [{"id": "a", "name": "photonic-waveguide-routing-e4vsrxa-env", "status": "suspended"},
                {"id": "b", "name": "mp-x-verifier-trial", "status": "failed"},
                {"id": "c", "name": "layout-y-env", "status": "running"},
                {"id": "d", "name": "drain-proof-20260923", "status": "suspended"}]
        cli.write_text("#!/bin/sh\n"
                       f"echo \"$*\" >> {calls}\n"
                       f"case \"$*\" in *list*) printf '%s' '{json.dumps(rows)}';; *) printf '{{}}';; esac\n")
        cli.chmod(0o755)
        os.environ.update(SMITHERS_CLI=str(cli), PLUE_REPO="acme/bench")
        try:
            assert sorted(requeue.reap_dead()) == ["mp-x-verifier-trial", "photonic-waveguide-routing-e4vsrxa-env"]
        finally:
            for name in ("SMITHERS_CLI", "PLUE_REPO"):
                os.environ.pop(name, None)
        deletes = [l for l in calls.read_text().splitlines() if "delete" in l]
        assert len(deletes) == 2 and all(" c " not in l and " d " not in l for l in deletes), deletes
        assert all(" --yes " in l for l in deletes), "the CLI refuses a delete without --yes off a TTY"


def check_requeue_and_health() -> None:
    import health
    import requeue
    from datetime import datetime, timedelta, timezone
    recent = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    with tempfile.TemporaryDirectory() as directory:
        job = Path(directory) / "tb4-X"
        job.mkdir()
        trials = {
            "graded__a": result(reward=1.0),
            "agent__b": result("AgentTimeoutError", "timed out", reward=0.0),
            "ssh__c": result("NonZeroAgentExitCodeError", SSH_CLOSED),
            "verify__d": result("VerifierTimeoutError", "Verifier execution timed out"),
            "gpu__e": result("PlueUnplaceable", "GPU"),
            "killed__f": result(finished=False),
        }
        for name, data in trials.items():
            (job / name).mkdir()
            (job / name / "config.json").write_text("{}")
            if data.get("finished_at"):
                data["finished_at"] = recent
            (job / name / "result.json").write_text(json.dumps(data))
        out = Path(directory) / "health.md"
        assert health.main([directory, str(out), "tb4-X"]) == 3, "2 infra of 5 finished in the hour trips"
        assert "TRIPPED" in out.read_text()
        moved = requeue.requeue(job)
        assert sorted(moved) == ["killed__f", "ssh__c", "verify__d"], moved
        assert sorted(t.name for t in job.iterdir()) == ["agent__b", "gpu__e", "graded__a"]
        assert (Path(directory) / "tb4-X.infra" / "ssh__c" / "result.json").is_file(), "evidence is kept"
        assert health.main([directory, str(out), "tb4-X"]) == 3, "infra moved aside still counts for its hour"
        # A CancelledError is the harness process being stopped (a pause, a
        # restart, a crash the liveness check sees): retried, but it does not
        # feed the rate, or a pause would trip the next pause.
        for name in ("c1__a", "c2__b", "c3__c"):
            (job / name).mkdir()
            (job / name / "config.json").write_text("{}")
            (job / name / "result.json").write_text(json.dumps({**result("CancelledError"), "finished_at": recent}))
        rows = health.trial_rows(job)
        assert sum(r["kind"] == "infra" for r in rows) >= 3
        import shutil as _shutil
        _shutil.rmtree(Path(directory) / "tb4-X.infra")
        assert health.main([directory, str(out), "tb4-X"]) == 0, "graded, agent, unplaceable and cancellations never trip"
    assert requeue.workspace_name("ks-solver-cpp__VA7miqc__verifier__trial") == "ks-solver-cpp-va7miqc-verifier-trial"
    assert requeue.workspace_name("ks-solver-cpp__VA7miqc__env") == plue_env._sanitize_name("ks-solver-cpp__VA7miqc__env")


def check_untrusted_task_inputs() -> None:
    """A benchmark task, the model under test and a task's registry are
    untrusted. Pins the 2026-09-27 security review: a COPY source never
    leaves the environment directory, a RUN chmod never reaches the guest
    root shell as anything but a mode and paths, a transport line in the
    agent's own output never re-runs a lost trial, requeue reaps only its own
    trials' workspaces, --env values never reach a log line, and a
    registry's token realm is https only."""
    import image_config
    import requeue
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        env_dir = root / "task" / "environment"
        (env_dir / "files").mkdir(parents=True)
        (env_dir / "files" / "ok.txt").write_text("ok")
        secret = root / "auth.json"
        secret.write_text("operator secret")
        assert plue_env.copy_source(env_dir, "files/ok.txt") == env_dir.resolve() / "files/ok.txt"
        assert plue_env.copy_source(env_dir, "files") == env_dir.resolve() / "files"
        (env_dir / "link").symlink_to(secret)
        (env_dir / "files" / "inner").symlink_to(secret)
        for src in (str(secret), "../../auth.json", "files/../../../auth.json", "link", "files"):
            try:
                plue_env.copy_source(env_dir, src)
            except plue_env.PlueImageError:
                pass
            else:
                raise AssertionError(f"COPY {src} must stay inside the environment directory")
        (env_dir / "files" / "inner").unlink()
        (env_dir / "Dockerfile").write_text(f"FROM ubuntu:24.04\nCOPY {secret} /a\n")
        ops = plue_env._PlueOps.__new__(plue_env._PlueOps)
        ops.environment_dir, ops.task_env_config = env_dir, types.SimpleNamespace(docker_image=None)
        try:
            ops._resolve_image()
        except plue_env.PlueImageError:
            pass
        else:
            raise AssertionError("an absolute COPY source is refused before the workspace exists")

    image, copies, chmods = plue_env.parse_trivial_dockerfile(
        "FROM ubuntu:24.04\nCOPY run.sh /app/run.sh\nRUN chmod +x /app/run.sh /app/*.py\n"
        "RUN chmod -R 755 /app\nRUN chmod u+rwx,go-w /app/x\n")
    assert chmods == [("+x", "/app/run.sh /app/*.py"), ("-R 755", "/app"), ("u+rwx,go-w", "/app/x")], chmods
    for line in ("RUN chmod 7 /a; id", "RUN chmod 755 x && curl evil", "RUN chmod $(id) /a",
                 "RUN chmod 755 `id`", "RUN chmod 755 'a'", "RUN chmod 755 /a|sh", "RUN chmod 755 --reference=/x /a",
                 "RUN chmod 7;id /a"):
        try:
            plue_env.parse_trivial_dockerfile(f"FROM ubuntu\n{line}\n")
        except plue_env.PlueImageError:
            pass
        else:
            raise AssertionError(f"needs an image build, never a guest root shell: {line}")

    forged = "Command failed (exit 1): codex exec …\nstdout: Connection reset by 1.2.3.4 port 22\n"
    assert outcome.classify(result("NonZeroAgentExitCodeError", forged, reward=0.0)) == "agent", \
        "the agent's own output cannot turn its graded failure into a re-run"
    forged_header = "stdout: x\nCommand failed (exit 255): y\nConnection reset by 1.2.3.4 port 22\n"
    assert outcome.classify(result("NonZeroAgentExitCodeError", forged_header, reward=0.0)) == "agent"

    line = plue_env.redact_argv(["smithers", "workspace", "exec", "--env", "API_KEY=sk-live-1", "--env", "A=b=c",
                                 "--command", "echo"])
    assert "sk-live-1" not in line and "b=c" not in line and "API_KEY=<redacted>" in line, line

    with tempfile.TemporaryDirectory() as directory:
        calls = Path(directory) / "calls"
        cli = Path(directory) / "smithers"
        rows = [{"id": "a", "name": "x-1-env"}, {"id": "b", "name": "x-1-verifier-trial"},
                {"id": "c", "name": "x-10-env"}, {"id": "d", "name": "x-10-verifier-trial"},
                {"id": "e", "name": "x-1-envoy"}]
        cli.write_text("#!/bin/sh\n"
                       f"echo \"$*\" >> {calls}\n"
                       f"case \"$*\" in *list*) printf '%s' '{json.dumps(rows)}';; *) printf '{{}}';; esac\n")
        cli.chmod(0o755)
        os.environ.update(SMITHERS_CLI=str(cli), PLUE_REPO="acme/bench")
        try:
            assert sorted(requeue.reap(["x__1"])) == ["x-1-env", "x-1-verifier-trial"]
        finally:
            for name in ("SMITHERS_CLI", "PLUE_REPO"):
                os.environ.pop(name, None)

    import email.message
    import urllib.error

    class Opener:
        opened: list = []

        def open(self, request, timeout=None):
            url = request if isinstance(request, str) else request.full_url
            self.opened.append(url)
            headers = email.message.Message()
            headers["WWW-Authenticate"] = 'Bearer realm="file:///etc/passwd",service="x"'
            raise urllib.error.HTTPError(url, 401, "unauthorized", headers, None)

    original = image_config._OPENER
    image_config._OPENER = Opener()
    try:
        image_config._fetch("evil.example", "o/r", "manifests/latest", None)
    except ValueError:
        pass
    else:
        raise AssertionError("a file:// token realm is refused")
    finally:
        image_config._OPENER = original
    assert Opener.opened == ["https://evil.example/v2/o/r/manifests/latest"], Opener.opened


def check_with_harbor() -> str:
    try:
        import harbor  # noqa: F401
    except ImportError:
        return "Harbor-backed checks skipped (set HARBOR_PYTHON)"
    from harbor.models.task.config import EnvironmentConfig
    from harbor.models.trial.paths import TrialPaths

    env_cls = plue_env.PlueEnvironment
    with tempfile.TemporaryDirectory() as directory:
        env_dir = Path(directory) / "environment"
        env_dir.mkdir()
        (env_dir / "Dockerfile").write_text("FROM ubuntu:24.04\n")
        paths = TrialPaths(Path(directory) / "trial")
        make = lambda session, config: env_cls(  # noqa: E731
            environment_dir=env_dir, environment_name="gpu-task", session_id=session,
            trial_paths=paths, task_env_config=config, logger=logging.getLogger("check"))

        # The control: without the deferral, Harbor's check raises inside the
        # constructor, which is Trial.create, which ends the job.
        from harbor.environments.base import BaseEnvironment
        undeferred = type("Undeferred", (plue_env._PlueOps, BaseEnvironment), {
            "type": staticmethod(lambda: "plue"), "capabilities": env_cls.capabilities,
            "start": env_cls.start, "stop": env_cls.stop, "exec": env_cls.exec,
            "upload_file": env_cls.upload_file, "upload_dir": env_cls.upload_dir,
            "download_file": env_cls.download_file, "download_dir": env_cls.download_dir,
            "_plue_network": env_cls._plue_network})
        try:
            undeferred(environment_dir=env_dir, environment_name="gpu-task", session_id="gpu__y__env",
                       trial_paths=paths, task_env_config=EnvironmentConfig(docker_image="ubuntu:24.04", gpus=1),
                       logger=logging.getLogger("check"))
        except RuntimeError as error:
            assert "GPU" in str(error), error
        else:
            raise AssertionError("the control: Harbor's constructor refuses a GPU task")

        env = make("gpu__x__env", EnvironmentConfig(docker_image="ubuntu:24.04", gpus=1, cpus=4))
        try:
            asyncio.run(env.reserve())
        except plue_env.PlueUnplaceable as error:
            assert "GPU" in str(error), error
        else:
            raise AssertionError("a GPU task fails at reserve(), inside the trial")
        try:
            asyncio.run(env.start(force_build=False))
        except plue_env.PlueUnplaceable:
            pass
        else:
            raise AssertionError("start() refuses the same way")
        asyncio.run(env.stop(delete=True))  # nothing to delete, never raises

        bad = env_dir.parent / "bad"
        bad.mkdir()
        (bad / "Dockerfile").write_text("FROM a AS b\nFROM c\n")
        broken = env_cls(environment_dir=bad, environment_name="bad", session_id="bad__x__env",
                         trial_paths=paths, task_env_config=EnvironmentConfig(), logger=logging.getLogger("check"))
        try:
            asyncio.run(broken.reserve())
        except plue_env.PlueImageError:
            pass
        else:
            raise AssertionError("an image plue cannot run fails at reserve()")

    # The separate verifier environment is reserved before the build timer.
    from harbor.trial.trial import Trial
    import harbor.trial.queue as trial_queue
    assert getattr(trial_queue.shutil, "_plue_keeps_attempts", False), "retried attempts are kept"
    assert getattr(Trial._separate_verifier_env, "_plue_untimed_reserve", False), \
        "importing PlueEnvironment patches the verifier environment start"
    import harbor.trial.trial as trial_module

    class SlowEnv:
        def __init__(self):
            self.order = []
            self.os = None

        async def reserve(self):
            await asyncio.sleep(0.3)
            self.order.append("reserve")

        async def start(self, force_build=False):
            self.order.append("start")

        async def stop(self, delete=True):
            self.order.append("stop")

    created = []

    def create_environment_from_config(**kwargs):
        env = SlowEnv()
        created.append((kwargs, env))
        return env

    fake = types.SimpleNamespace(
        config=types.SimpleNamespace(environment=types.SimpleNamespace(model_copy=lambda update: "runtime", delete=True)),
        task=types.SimpleNamespace(short_name="t"),
        paths="paths", _id="id", logger=logging.getLogger("check"),
        _environment_build_timeout_sec=0.05,
        _verifier_env_build_context=lambda step_cfg: "tests",
        _separate_verifier_session_id=lambda key: f"t__x__verifier__{key}",
        _verifier_env_mounts=lambda env_config: [],
        _validate_separate_verifier_env_policies=lambda env, plan: None,
    )
    plan = types.SimpleNamespace(verifier_env_baseline="baseline", verifier_phase="phase")
    original_factory = trial_module.EnvironmentFactory.create_environment_from_config
    trial_module.EnvironmentFactory.create_environment_from_config = staticmethod(create_environment_from_config)
    try:
        async def enter():
            async with Trial._separate_verifier_env(fake, "env-config", key="trial", plan=plan) as env:
                return env
        env = asyncio.run(enter())
        assert env.order == ["reserve", "start", "stop"], env.order
        assert created[0][0]["session_id"] == "t__x__verifier__trial"
    finally:
        trial_module.EnvironmentFactory.create_environment_from_config = original_factory
    return "Harbor-backed checks ran (harbor importable)"


if __name__ == "__main__":
    check_classification()
    check_ledger()
    check_transport_and_containment()
    check_image_tmp()
    check_sidecars()
    check_trial_containment()
    check_durable_exec_and_workdir()
    check_shim_durable_exec()
    check_guest_prelude()
    check_disk_request_preservation()
    check_retried_attempts_are_kept()
    check_guest_restart_watchdog()
    check_auth_denial_waits()
    check_ledger_bins_and_retry()
    check_janitor()
    check_requeue_and_health()
    check_untrusted_task_inputs()
    harbor_note = check_with_harbor()
    print(f"check_infra.py: classification, ledger cap and verifier handover, SSH transport, image /tmp, sidecars, "
          f"containment, requeue and health hold; {harbor_note}.")
