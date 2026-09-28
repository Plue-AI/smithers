#!/usr/bin/env python3
"""A `docker` that reaches a Smithers Cloud workspace.

The harness's `bash` flow delivers every containerised command as
`docker exec [-i] [-w cwd] [-e KEY]... -- <container> <file> <args…>`
(`packages/smithers/agent/std/src/Container.ts`). On plue the "container" is
a workspace id, so `smithers_agent.py` puts this file first on the CLI's PATH
under the name `docker` and every exec becomes one public CLI call:

    <cli> workspace exec <id> --repo <repo> --user root [--cwd …]
        [--env KEY=VALUE …] --timeout 0 --format json --command 'exec <file> <args…>'

Standard input is forwarded when `-i` was asked for, the command's stdout and
stderr are replayed, and its exit code is this process's. An exec without
stdin carries a durable `--exec-id` (plue CLI 71c3ed6a+): when OpenSSH or the
gateway loses the transport, the same id is reattached, so the command is
neither lost nor run twice. An exec with stdin stays one connection. Without
`-w` the command runs in `workdir` from the config (the image's WORKDIR). Any other docker
verb is refused with exit 125: nothing but exec is expected here.

Configuration comes from `plue-docker.json` beside the invoked `docker` link,
written per run by `shim_config` / `shim_directory` below (Harbor's
`smithers_agent.py` and the SWE-bench rig's `lib/plue.py shim`): `repo` (owner/name), `cli`
(absolute path of the plue CLI) and `env` (what that CLI needs, such as
SMITHERS_TOKEN and XDG_CONFIG_HOME). Never from the ambient environment: the
harness spawns this shim with a least-authority environment (PATH, HOME, USER,
LANG, TERM, TMPDIR, SHELL; `flows/kernel/src/ChildProcessEnvironment.ts`), so
PLUE_REPO and SMITHERS_CLI never arrive, and `smithers` on PATH is the flows
CLI, not the plue one. The ambient environment is read only for the `-e KEY`
values the harness forwards on purpose, and never for SMITHERS_TOKEN.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import outcome  # noqa: E402
import plue_env  # noqa: E402

CONFIG_NAME = "plue-docker.json"
SHIM = Path(__file__).resolve()

# plue_env.EGRESS_PREFIX: the SSH session does not carry the sandbox's egress
# proxy, so the command sources it first, plus the guest defaults.
EGRESS_ENV = plue_env.EGRESS_ENV
EGRESS_PREFIX = plue_env.EGRESS_PREFIX


# What the plue CLI itself needs from the harness host's environment.
SHIM_ENV_NAMES = ("SMITHERS_TOKEN", "XDG_CONFIG_HOME", "HOME")
# Of those, the ones a `-e KEY` never copies from the host into the task
# container, where the model under test would read them.
CLI_CREDENTIALS = frozenset({"SMITHERS_TOKEN"})


def shim_config(base: dict[str, str], workdir: str | None = None) -> dict:
    """Everything `plue_docker.py` needs, taken from the harness host's
    environment now, because the harness spawns the shim with a
    least-authority environment that drops PLUE_REPO, SMITHERS_CLI and the
    token (`flows/kernel/src/ChildProcessEnvironment.ts`). The CLI is resolved
    to an absolute path the same way `plue_env` runs it."""
    repo = base.get("PLUE_REPO", "").strip()
    if "/" not in repo:
        raise RuntimeError("PLUE_REPO must be owner/name for a plue run")
    name = base.get("SMITHERS_CLI", "smithers")
    cli = shutil.which(name, path=base.get("PATH"))
    if cli is None:
        raise RuntimeError(f"SMITHERS_CLI {name!r} does not resolve to an executable")
    env = {key: base[key] for key in SHIM_ENV_NAMES if base.get(key)}
    config: dict = {"repo": repo, "cli": os.path.abspath(cli), "env": env}
    if workdir:
        config["workdir"] = workdir  # the image's WORKDIR: `docker exec` without -w runs there
    return config


def shim_directory(directory: Path, config: dict) -> Path:
    """A directory whose `docker` is `plue_docker.py`, to go first on PATH,
    with the shim's configuration beside it (owner-only: it holds the token).
    Keep it outside the trial's kept workspace and delete it afterwards."""
    directory = directory / "bin"
    directory.mkdir(parents=True, exist_ok=True)
    link = directory / "docker"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(SHIM)
    SHIM.chmod(SHIM.stat().st_mode | 0o111)
    target = directory / CONFIG_NAME
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(config, handle)
    return directory


def load_config(invoked: str) -> dict:
    """The per-trial configuration beside the `docker` link that was run.

    `invoked` is the path this process was started as (`sys.argv[0]`), not its
    symlink target, so each trial's shim directory carries its own file."""
    path = Path(os.path.abspath(invoked)).parent / CONFIG_NAME
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"plue docker shim: no readable {path}: {error}") from error
    if not isinstance(config, dict):
        raise ValueError(f"plue docker shim: {path} is not an object")
    return config


def translate(argv: list[str], environ: dict[str, str], config: dict) -> tuple[list[str], bool]:
    """`docker exec …` argv to the plue CLI argv, and whether stdin is forwarded."""
    if not argv or argv[0] != "exec":
        raise ValueError(f"plue docker shim serves `docker exec` only, got: {argv[:1]}")
    rest = argv[1:]
    stdin = False
    cwd: str | None = None
    env: list[str] = []
    index = 0
    while index < len(rest):
        token = rest[index]
        if token == "--":
            index += 1
            break
        if token == "-i":
            stdin = True
        elif token == "-w":
            index += 1
            cwd = rest[index]
        elif token == "-e":
            index += 1
            key = rest[index]
            if "=" in key:
                env.append(key)
            elif key in CLI_CREDENTIALS:
                raise ValueError(f"plue docker shim: refusing to forward the plue CLI credential {key}")
            elif key in environ:
                env.append(f"{key}={environ[key]}")
        elif token.startswith("-"):
            raise ValueError(f"plue docker shim: unsupported docker exec flag {token}")
        else:
            break
        index += 1
    command = rest[index:]
    if len(command) < 2:
        raise ValueError("plue docker shim: expected <container> <file> [args…]")
    container, program = command[0], command[1:]
    repo = str(config.get("repo") or "").strip()
    if "/" not in repo:
        raise ValueError("plue docker shim: config `repo` must be owner/name")
    cli = str(config.get("cli") or "")
    if not os.path.isabs(cli) or not os.access(cli, os.X_OK):
        raise ValueError(f"plue docker shim: config `cli` must be an executable absolute path, got {cli!r}")
    args = [
        cli,
        "workspace", "exec", container, "--repo", repo, "--user", "root",
        "--timeout", "0", "--format", "json",
    ]
    cwd = cwd or config.get("workdir") or None
    if cwd is not None:
        args += ["--cwd", cwd]
    for pair in env:
        args += ["--env", pair]
    args += ["--command", EGRESS_PREFIX + "exec " + shlex.join(program)]
    return args, stdin


def envelope(stdout: str) -> dict:
    text = stdout.strip()
    start = text.find("{")
    return json.loads(text[start:]) if start >= 0 else {}


def main(argv: list[str]) -> int:
    try:
        config = load_config(sys.argv[0])
        args, stdin = translate(argv, dict(os.environ), config)
    except ValueError as error:
        sys.stderr.write(f"{error}\n")
        return 125
    extra = config.get("env") or {}
    waits: list = [None]
    if not stdin:
        args = args[:-2] + ["--exec-id", f"shim-{uuid.uuid4().hex[:16]}"] + args[-2:]
        waits = [*config.get("reattach_backoff_sec", plue_env._EXEC_REATTACH_BACKOFF_SEC), None]
    auth_poll = float(config.get("auth_poll_sec", plue_env._AUTH_POLL_SEC))
    auth_deadline = time.monotonic() + float(config.get("auth_wait_sec", plue_env._AUTH_WAIT_SEC))
    waits = list(waits)
    while waits:
        wait = waits[0]
        result = subprocess.run(
            args,
            stdin=None if stdin else subprocess.DEVNULL,
            capture_output=True,
            env={**os.environ, **{str(k): str(v) for k, v in extra.items()}},
        )
        try:
            data = envelope(result.stdout.decode(errors="replace"))
        except ValueError:
            data = {}
        payload = data.get("data", data) if isinstance(data, dict) else {}
        stderr = (payload.get("stderr") or "") + "\n" + result.stderr.decode(errors="replace")
        if "exit_code" not in payload and plue_env.auth_denied(json.dumps(data) + stderr) \
                and time.monotonic() < auth_deadline:
            # The SSH gateway refused the login (an IP ban); not the command's result.
            time.sleep(auth_poll)
            continue
        lost = None
        if "error" in data and "exit_code" not in payload:
            error = data["error"]
            lost = plue_env.PlueError(error.get("message", ""), error.get("code", ""))
            if wait is None or not plue_env.reattachable(lost):
                sys.stderr.write(f"plue exec failed: {error.get('code', '')} {error.get('message', '')}\n")
                return 126
        elif int(payload.get("exit_code", result.returncode)) == 255 and outcome.ssh_transport_error(stderr):
            if wait is None:
                sys.stderr.write(stderr.strip() + "\n")
                return 255
            lost = True
        if lost is not None:
            waits.pop(0)
            time.sleep(wait)
            continue
        if not payload and result.returncode != 0:
            sys.stderr.write(result.stderr.decode(errors="replace"))
            return result.returncode or 126
        sys.stdout.write(payload.get("stdout") or "")
        sys.stderr.write(payload.get("stderr") or "")
        sys.stdout.flush()
        sys.stderr.flush()
        return int(payload.get("exit_code", result.returncode))
    return 255


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
