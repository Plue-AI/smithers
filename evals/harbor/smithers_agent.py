"""The Smithers flows harness as a Harbor (and Pier) external agent.

    harbor run -p <tasks> -a evals.harbor.smithers_agent:SmithersAgent -m openai/gpt-6-sol
    pier run -p <tasks> --agent-import-path evals.harbor.smithers_agent:SmithersAgent -m openai/gpt-6-sol

Harbor starts the task's container and hands this class the instruction. The
agent runs OUR harness on the host, the `smthrs` CLI out of this checkout, with
the instruction as the flow's whole task and the task container as the only
thing its `bash` flow may touch: every command is delivered by `docker exec`
(`packages/smithers/agent/std/src/Container.ts`), which is the same seam the
SWE-bench rig uses. The model is reached from the host, so the container needs
no network and the task's `no-network` seal is kept.

One prompt for every task, `prompt.md` beside this file. It carries the
instruction verbatim and how to reach the container, nothing else: no
task-specific hints, no `tests/` or `solution/` directory is ever read or
uploaded, and nothing is written into the container after the run except, in
commit mode, the commit itself.

What every trial records under its Harbor logs directory:

    smithers-run.json   seat, auth mode, route binding, harness revision, subject
                        fingerprint, wall clock, tokens, exit status
    trajectory.json     ATIF-v1.8 trajectory folded from the harness journal
    smithers-run.log    the CLI's own stdout and stderr
    workspace/          the flow file and `.flows/control.db`, the journal itself

The chatgpt route is proven, not assumed: when the seat authenticates through
the ChatGPT subscription the CLI is started with `OPENAI_API_KEY` removed from
its environment, so an api-key fallback cannot succeed silently, and the
journal's `model-requested` binding is copied into `smithers-run.json`.

On Smithers Cloud (`-e evals.harbor.plue_env:PlueEnvironment`) the task
lives in a plue workspace instead of a local container. The "container" the
prompt names is then the workspace id, and `plue_docker.py` is placed first on
the CLI's PATH under the name `docker`, so the same `docker exec` seam reaches
the workspace through the public `smithers workspace exec` command.

The ChatGPT seat is drawn per trial from `accounts.Pool`: every logged-in
Codex subscription on the host in round-robin (`CODEX_HOME` of the CLI), the
label recorded in `smithers-run.json`, and an account that reports a usage
limit taken out of rotation.

Environment:

    SMITHERS_ROOT          the Smithers checkout to run; default: this file's
    SMITHERS_OPENAI_AUTH   `chatgpt` (default for openai seats) or `api-key`
    SMITHERS_BENCH_DOCKER  the docker CLI; default `docker`
    SMITHERS_CLI, PLUE_REPO, SMITHERS_TOKEN, XDG_CONFIG_HOME
                           the plue CLI and its account, on Smithers Cloud

Agent kwargs (`--ak key=value`):

    commit=1        commit the container's repository after the run (DeepSWE
                    grades `git diff base..HEAD`; default on under Pier)
    cwd=/app        working directory inside the container; default: the
                    task's `workdir`, else `/app`
    budget_sec=N    wall-clock budget for the run; default: the trial's agent
                    timeout minus a minute, else 3600
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from . import accounts, plue_docker
except ImportError:  # imported by file path (fixtures)
    import accounts  # type: ignore[no-redef]
    import plue_docker  # type: ignore[no-redef]

# Pier ships Harbor as a dependency, so under Pier both import; the runner
# that calls `install_spec()` and `network_allowlist()` is Pier's, and its
# `BaseAgent` is the one to subclass there. Harbor alone has no `pier`.
try:
    from pier.agents.base import BaseAgent  # type: ignore[import-not-found]
    from pier.environments.base import BaseEnvironment  # type: ignore[import-not-found]
    from pier.models.agent.context import AgentContext  # type: ignore[import-not-found]

    AgentCapabilities = None
    FRAMEWORK = "pier"
except ImportError:
    try:
        from harbor.agents.base import BaseAgent  # type: ignore[no-redef]
        from harbor.agents.capabilities import AgentCapabilities  # type: ignore[no-redef]
        from harbor.environments.base import BaseEnvironment  # type: ignore[no-redef]
        from harbor.models.agent.context import AgentContext  # type: ignore[no-redef]

        FRAMEWORK = "harbor"
    except ImportError:
        # Neither runner is installed: the module still imports so the offline
        # fixtures can exercise the prompt, the journal fold and the trajectory.
        from abc import ABC

        class BaseAgent(ABC):  # type: ignore[no-redef]
            def __init__(self, logs_dir: "Path", model_name: "str | None" = None, **kwargs: "Any") -> None:
                self.logs_dir = logs_dir
                self.model_name = model_name

        AgentCapabilities = None
        BaseEnvironment = Any  # type: ignore[assignment,misc]
        AgentContext = Any  # type: ignore[assignment,misc]
        FRAMEWORK = "none"

HERE = Path(__file__).resolve().parent
PROMPT_PATH = HERE / "prompt.md"
PLUE_SHIM = plue_docker.SHIM
CLI_RELATIVE = Path("packages/smithers/bin/smithers.mjs")
BUILT_RELATIVE = Path("packages/smithers/dist/esm/bin.js")
SUBJECT_RELATIVE = Path("evals/swebench/lib/subject.mjs")
FLOW_NAME = "task"

COMMIT_PARAGRAPH = """
- The task directory is a git repository, and only committed work counts:
  anything left uncommitted when you complete is discarded. Commit everything
  you changed before completing (`git add -A && git commit -m "<summary>"`,
  with `-c user.name=agent -c user.email=agent@localhost` if git asks for an
  identity).
"""


def _truthy(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def compose_project_name(session_id: str) -> str:
    """Docker Compose's sanitization of a project name; Harbor and Pier both
    name the task project after the environment's session id."""
    name = session_id.lower()
    if not re.match(r"^[a-z0-9]", name):
        name = "0" + name
    return re.sub(r"[^a-z0-9_-]", "-", name)


def seat_of(model_name: str | None) -> str:
    """`openai/gpt-6-sol` (Harbor's spelling) to `openai:gpt-6-sol` (the CLI's)."""
    if not model_name:
        raise ValueError("SmithersAgent needs a model, e.g. -m openai/gpt-6-sol")
    if "/" in model_name:
        provider, model = model_name.split("/", 1)
        return f"{provider}:{model}"
    if ":" in model_name:
        return model_name
    return f"openai:{model_name}"


def render_prompt(instruction: str, *, seat: str, container: str, cwd: str, commit: bool) -> str:
    """The one flow file, with the instruction verbatim."""
    template = PROMPT_PATH.read_text(encoding="utf-8")
    return (
        template.replace("{{seat}}", seat)
        .replace("{{container}}", container)
        .replace("{{cwd}}", cwd)
        .replace("{{commit}}", COMMIT_PARAGRAPH if commit else "")
        .replace("{{instruction}}", instruction.strip() + "\n")
    )


HELPER_VARIABLE = "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"

# Nobody answers a benchmark run, so an in-run `ask` is refused at once with a
# typed failure the cell reads, instead of parking the run until the agent
# timeout (luna-A-smoke2 mp-checkpoint tGyE6hv waited at `waiting-approval`
# from frame 46 to 3534 s). Nothing is approved on anyone's behalf.
ASKS_VARIABLE = "SMITHERS_ASKS"
ASKS = "refuse"
HELPER_DEFAULT = Path("/usr/local/bin/smithers-jj-export")
HELPER_BUILT_RELATIVE = Path("target/release/smithers-jj-export")


def helper_binary(root: Path, base: dict[str, str]) -> Path | None:
    """The atomic filesystem helper the CLI shells out to
    (`platform-node/src/AtomicFileSystem.ts`): the configured one, else the
    installed one, else this checkout's release build."""
    configured = base.get(HELPER_VARIABLE)
    for candidate in (Path(configured) if configured else None, HELPER_DEFAULT, root / HELPER_BUILT_RELATIVE):
        if candidate is not None and candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


# The shim's configuration and directory belong to the shim (`plue_docker.py`),
# which the SWE-bench rig's plue transport writes the same way.
SHIM_ENV_NAMES = plue_docker.SHIM_ENV_NAMES
shim_config = plue_docker.shim_config
shim_directory = plue_docker.shim_directory


def container_commands(events: list[dict[str, Any]], container: str) -> dict[str, int]:
    """Commands the agent sent to the task container, and how many exited 0.

    A `cell-call-started` whose input names the container, joined by call id
    to its `cell-call-settled`. Zero successes means the agent never reached
    the task: the trial measured the transport, not the model."""
    targeted: set[str] = set()
    attempted = succeeded = 0
    for event in events:
        payload = event["payload"]
        if event["type"] == "control.agent.cell-call-started":
            given = payload.get("input")
            if isinstance(given, dict) and given.get("container") == container:
                targeted.add(str(payload.get("callId")))
        elif event["type"] == "control.agent.cell-call-settled" and str(payload.get("callId")) in targeted:
            attempted += 1
            value = payload.get("value")
            if payload.get("outcome") == "success" and isinstance(value, dict) and value.get("exitCode") == 0:
                succeeded += 1
    return {"attempted": attempted, "succeeded": succeeded}


async def container_lost(environment: Any, timeout_sec: int = 180) -> str | None:
    """Why the task container can no longer be graded, or None when it answers.

    Probed once after the run. A container that died mid-run (a plue VM that
    "no longer exists", a removed docker container) leaves the verifier grading
    an empty tree, so the trial is infrastructure, never a score."""
    try:
        result = await environment.exec("true", timeout_sec=timeout_sec)
    except Exception as error:  # noqa: BLE001 - any transport failure means the task is gone
        return f"{type(error).__name__}: {str(error)[:300]}"
    code = getattr(result, "return_code", None)
    if code != 0:
        stderr = (getattr(result, "stderr", "") or "").strip()
        return f"liveness probe exited {code}: {stderr[:300]}"
    return None


def cli_environment(base: dict[str, str], *, auth_mode: str, helper: Path | None = None,
                    shim: Path | None = None, codex_home: Path | None = None,
                    container: str | None = None) -> dict[str, str]:
    """The environment the CLI runs under.

    The chatgpt mode removes `OPENAI_API_KEY` so the seat can only be served by
    the ChatGPT session: an unset `SMITHERS_OPENAI_AUTH` means api-key
    (`NativeEquipment.ts`), which is exactly the silent fallback this guards
    against. The `test` flow's variables are dropped because no benchmark task
    declares a runner; a stale one from the caller's shell would bind a `test`
    flow against the wrong container. The helper is named explicitly so the
    run does not depend on what `/usr/local/bin` holds.

    `container` seals the run to the task container (`SMITHERS_BASH_CONTAINER`):
    a `bash` call naming no container, which would run on this host beside
    every task's `tests/` and `solution/`, fails with `outside_container`, and
    the host filesystem flows are not offered. The stock Codex arm is sealed
    the same way by running inside the container.
    """
    env = dict(base)
    for name in ("SMITHERS_TEST_COMMAND", "SMITHERS_TEST_CONTAINER", "SMITHERS_TEST_CWD", "SMITHERS_TEST_TIMEOUT_MS"):
        env.pop(name, None)
    env["SMITHERS_OPENAI_AUTH"] = auth_mode
    env[ASKS_VARIABLE] = ASKS
    if auth_mode == "chatgpt":
        env.pop("OPENAI_API_KEY", None)
    if helper is not None:
        env[HELPER_VARIABLE] = str(helper)
    if shim is not None:
        env["PATH"] = f"{shim}{os.pathsep}{env.get('PATH', '')}"
    if codex_home is not None:
        env["CODEX_HOME"] = str(codex_home)
    if container is not None:
        env["SMITHERS_BASH_CONTAINER"] = container
    else:
        env.pop("SMITHERS_BASH_CONTAINER", None)
    return env


JOURNAL_FILES = ("control.db", "engine.db")


def journal_path(flows_dir: Path) -> Path | None:
    """The database under `.flows/` that holds the agent's control events.

    rc.1 writes them to `control.db`; the SWE-bench rig's archived journals
    are `engine.db`. Whichever file carries a `control.agent.*` row is the
    journal; a file that exists but carries none is not it.
    """
    for name in JOURNAL_FILES:
        candidate = flows_dir / name
        if not candidate.is_file():
            continue
        try:
            connection = sqlite3.connect(f"file:{candidate}?mode=ro", uri=True)
            try:
                row = connection.execute(
                    "select 1 from flows_journal_events where event_type like 'control.agent.%' limit 1"
                ).fetchone()
            finally:
                connection.close()
        except sqlite3.Error:
            continue
        if row is not None:
            return candidate
    return None


def read_journal(path: Path) -> list[dict[str, Any]]:
    """Every event of the run's journal, in sequence, payloads decoded."""
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "select seq, emitted_at_ms, event_type, payload_json from flows_journal_events order by seq"
        ).fetchall()
    finally:
        connection.close()
    events = []
    for seq, emitted_at_ms, event_type, payload_json in rows:
        try:
            payload = json.loads(payload_json)
        except ValueError:
            payload = {}
        events.append({"seq": seq, "at": emitted_at_ms, "type": event_type, "payload": payload if isinstance(payload, dict) else {}})
    return events


def _iso(millis: int | None) -> str | None:
    if millis is None:
        return None
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def summarize(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Tokens, calls, route bindings and the run's own verdict, off the journal."""
    usage = {"inputTokens": None, "cachedInputTokens": None, "outputTokens": None, "reasoningTokens": None}
    missing_usage = {name: False for name in usage}
    seat = None
    frames = model_calls = calls = asks_refused = 0
    bindings: list[Any] = []
    efforts: list[str] = []
    status = None
    output = None
    cause = None
    for event in events:
        kind, payload = event["type"], event["payload"]
        if kind == "control.agent.turn-opened":
            frames += 1
            seat = payload.get("seat", seat)
        elif kind == "control.agent.model-requested":
            # rc.1 journals the resolved route as `routeId`/`protocolId`/
            # `modelId`; an older host names it `binding`. Either is the proof
            # of which backend served the call, so both are kept.
            binding = {
                key: payload[key]
                for key in ("routeId", "protocolId", "modelId", "binding")
                if payload.get(key) is not None
            }
            if binding and binding not in bindings:
                bindings.append(binding)
            params = payload.get("params")
            effort = params.get("reasoningEffort") if isinstance(params, dict) else None
            if isinstance(effort, str) and effort not in efforts:
                efforts.append(effort)
        elif kind == "control.agent.model-settled":
            model_calls += 1
            counters = payload.get("usage") or {}
            for name in usage:
                value = counters.get(name)
                if isinstance(value, (int, float)):
                    usage[name] = (usage[name] or 0) + int(value)
                else:
                    missing_usage[name] = True
        elif kind == "control.agent.cell-call-started":
            calls += 1
        elif kind == "control.agent.cell-call-settled":
            if payload.get("flowName") == "ask" and payload.get("outcome") != "success":
                asks_refused += 1
        elif kind == "control.agent.transition-applied":
            transition = payload.get("transition") or {}
            if transition.get("_tag") == "complete":
                output = transition.get("output")
        elif kind.startswith("control.run."):
            status = kind[len("control.run."):]
            if kind == "control.run.failed":
                cause = payload.get("cause")
    for name in usage:
        if missing_usage[name]:
            usage[name] = None
    return {
        "cause": (cause.split("\n", 1)[0][:500] if isinstance(cause, str) else None),
        "seat": seat,
        "frames": frames,
        "modelCalls": model_calls,
        "calls": calls,
        "asksRefused": asks_refused,
        "usage": usage,
        "bindings": bindings,
        "efforts": efforts,
        "status": status,
        "output": output,
        "spanMillis": (events[-1]["at"] - events[0]["at"]) if events else 0,
    }


def trajectory(events: list[dict[str, Any]], *, agent_name: str, agent_version: str, seat: str, instruction: str,
               session_id: str | None, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """Folds the harness journal into one ATIF-v1.8 trajectory.

    One `user` step carries the instruction. Each model turn becomes one `agent`
    step: its message is the reply the model settled with, its tool calls are
    the flow calls the cell made, and the observation holds each call's result
    in call order. Tokens ride on the step's metrics and are summed into
    `final_metrics`, so Harbor's usage columns read them back without a
    per-agent parser.
    """
    steps: list[dict[str, Any]] = [{
        "step_id": 1,
        "timestamp": _iso(events[0]["at"]) if events else None,
        "source": "user",
        "message": instruction,
    }]
    turn: dict[str, Any] | None = None
    started: list[dict[str, Any]] = []
    settled: list[dict[str, Any]] = []
    totals = {"prompt": None, "completion": None, "cached": None}
    missing = {"prompt": False, "completion": False, "cached": False}

    def close_turn() -> None:
        nonlocal turn, started, settled
        if turn is None:
            return
        tool_calls = []
        results = []
        for index, call in enumerate(started):
            call_id = f"call-{turn['seq']}-{index}"
            arguments = call.get("input")
            tool_calls.append({
                "tool_call_id": call_id,
                "function_name": str(call.get("flowName") or "?"),
                "arguments": arguments if isinstance(arguments, dict) else {"input": arguments},
            })
            if index < len(settled):
                result = settled[index]
                content = result.get("message") if result.get("outcome") == "failure" else result.get("value")
                results.append({
                    "source_call_id": call_id,
                    "content": _text(content),
                    "extra": {"outcome": result.get("outcome"), "code": result.get("code")},
                })
        step: dict[str, Any] = {
            "step_id": len(steps) + 1,
            "timestamp": turn.get("timestamp"),
            "source": "agent",
            "message": turn.get("message") or "",
        }
        if turn.get("cell"):
            step["extra"] = {"cell": turn["cell"]}
        if tool_calls:
            step["tool_calls"] = tool_calls
        if results:
            step["observation"] = {"results": results}
        if turn.get("metrics"):
            step["metrics"] = turn["metrics"]
        steps.append(step)
        turn = None
        started, settled = [], []

    for event in events:
        kind, payload = event["type"], event["payload"]
        if kind == "control.agent.turn-opened":
            close_turn()
            turn = {"seq": event["seq"], "timestamp": _iso(event["at"]), "message": "", "cell": None, "metrics": None}
        elif turn is None:
            continue
        elif kind == "control.agent.model-settled":
            counters = payload.get("usage") or {}
            prompt = counters.get("inputTokens")
            completion = counters.get("outputTokens")
            cached = counters.get("cachedInputTokens")
            for key, value in (("prompt", prompt), ("completion", completion), ("cached", cached)):
                if isinstance(value, (int, float)):
                    totals[key] = (totals[key] or 0) + int(value)
                else:
                    missing[key] = True
            turn["message"] = _text(payload.get("text"))
            turn["metrics"] = {
                "prompt_tokens": prompt,
                "completion_tokens": completion,
                "cached_tokens": cached,
                "extra": {
                    "reasoning_tokens": counters.get("reasoningTokens"),
                    "duration_millis": payload.get("durationMillis"),
                },
            }
        elif kind == "control.agent.cell-produced":
            cell = payload.get("cell") or {}
            turn["cell"] = cell.get("text") if isinstance(cell, dict) else _text(cell)
        elif kind == "control.agent.cell-call-started":
            started.append(payload)
        elif kind == "control.agent.cell-call-settled":
            settled.append(payload)
    close_turn()
    for key in totals:
        if missing[key]:
            totals[key] = None

    return {
        "schema_version": "ATIF-v1.8",
        "session_id": session_id,
        "agent": {"name": agent_name, "version": agent_version, "model_name": seat, "extra": extra or {}},
        "steps": steps,
        "final_metrics": {
            "total_prompt_tokens": totals["prompt"],
            "total_completion_tokens": totals["completion"],
            "total_cached_tokens": totals["cached"],
            "cached_share": (
                totals["cached"] / totals["prompt"]
                if totals["prompt"] is not None and totals["prompt"] > 0 and totals["cached"] is not None
                else None
            ),
            "total_steps": len(steps),
        },
    }


def harness_revision(root: Path) -> str | None:
    """The commit the checkout under `root` is at, from jj where it is a jj
    workspace and from git otherwise. jj reads the repository without
    snapshotting: a stale or orphaned working copy (another workspace's
    `jj op abandon`) refuses every snapshotting command, and a trial must not
    record a null revision for it."""
    for command in (
        ["jj", "--ignore-working-copy", "log", "-r", "@-", "--no-graph", "-T", "commit_id"],
        ["git", "rev-parse", "HEAD"],
    ):
        try:
            result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return None


def subject_fingerprint(root: Path) -> dict[str, Any] | None:
    """The SWE-bench rig's fingerprint of the exact CLI bytes, when it can be
    taken. Refusals are recorded, never hidden."""
    script = root / SUBJECT_RELATIVE
    if not script.is_file():
        return None
    try:
        result = subprocess.run(["node", str(script), "--json"], cwd=root, capture_output=True, text=True, timeout=300)
        document = json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
    return {"stamp": document.get("stamp"), "head": document.get("head"), "refusals": document.get("refusals", [])}


def plue_workspace_of(environment: Any) -> str | None:
    """The workspace id when `environment` is a running plue environment."""
    kind = getattr(environment, "type", None)
    if not callable(kind) or kind() != "plue":
        return None
    return str(getattr(environment, "_workspace_id", "") or "") or None


def failure_cause(log_text: str, summary: dict[str, Any]) -> str | None:
    """What the run failed on: the journal's `control.run.failed` cause,
    else the CLI's last `status: failed` line, else nothing."""
    if summary.get("cause"):
        return summary["cause"]
    for line in reversed(log_text.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            document = json.loads(line)
        except ValueError:
            continue
        if isinstance(document, dict) and document.get("status") == "failed" and document.get("cause"):
            return str(document["cause"]).split("\n", 1)[0][:500]
    return None


def parked(summary: dict[str, Any]) -> str | None:
    """Why the run is waiting rather than finished, when it is. A benchmark
    host answers no wait, so a run that ends at one was held by the harness."""
    status = summary.get("status")
    if isinstance(status, str) and status.startswith("waiting"):
        return f"run ended at {status} after {summary.get('frames')} frames; nobody answers a benchmark run"
    return None


def verdict(log_text: str, summary: dict[str, Any], events: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    """(`seat` | `infra` | None, cause): whether the run's end was the
    infrastructure's and not the model's. A `quota_exceeded` retry in the
    journal is a seat verdict even when the run went on to fail otherwise."""
    cause = failure_cause(log_text, summary)
    kind = accounts.classify_cause(cause)
    if kind is None:
        for event in events:
            if event["type"] == "control.agent.model-retried" and event["payload"].get("code") == "quota_exceeded":
                return "seat", f"quota_exceeded: model-retried (attempt {event['payload'].get('attempt')})"
        for line in log_text.splitlines():
            if accounts.mentions_usage_limit(line):
                return "seat", line.strip()[:500]
    return kind, cause


class SmithersAgent(BaseAgent):
    """The Smithers flows harness, driven from the host against the task container."""

    if AgentCapabilities is not None:
        capabilities = AgentCapabilities(atif=True)
    else:  # Pier still reads the flag
        SUPPORTS_ATIF = True

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        *,
        agent_timeout_sec: float | None = None,
        commit: Any = None,
        cwd: str | None = None,
        budget_sec: Any = None,
        **kwargs: Any,
    ) -> None:
        # Harbor hands the task and trial paths to every agent; this one never
        # opens them, which is how it stays blind to tests/ and solution/.
        kwargs.pop("task_dir", None)
        kwargs.pop("trial_paths", None)
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        self._agent_timeout_sec = agent_timeout_sec
        self._commit = _truthy(commit) if commit is not None else FRAMEWORK == "pier"
        self._cwd_override = cwd
        self._budget_sec = float(budget_sec) if budget_sec is not None else None
        self.root = Path(os.environ.get("SMITHERS_ROOT") or HERE.parent.parent).resolve()
        self.docker = os.environ.get("SMITHERS_BENCH_DOCKER", "docker")
        self.seat = seat_of(self.model_name)
        provider = self.seat.split(":", 1)[0]
        configured = os.environ.get("SMITHERS_OPENAI_AUTH", "").strip()
        self.auth_mode = configured or ("chatgpt" if provider == "openai" else "api-key")
        self._summary: dict[str, Any] | None = None
        self._plue = False
        self._pool: accounts.Pool | None = None
        self._account: accounts.Account | None = None
        self._requeues: list[dict[str, Any]] = []

    @staticmethod
    def name() -> str:
        return "smithers"

    def version(self) -> str | None:
        manifest = self.root / "packages/smithers/package.json"
        try:
            return str(json.loads(manifest.read_text())["version"])
        except (OSError, ValueError, KeyError):
            return None

    def network_allowlist(self):  # Pier: the container needs no egress, the model is called from the host
        try:
            from pier.models.agent.network import NetworkAllowlist  # type: ignore[import-not-found]
        except ImportError:
            return None
        return NetworkAllowlist()

    async def setup(self, environment: BaseEnvironment) -> None:
        built = self.root / BUILT_RELATIVE
        if not built.is_file():
            raise RuntimeError(
                f"{built} is missing: build the CLI first (cd {self.root} && pnpm --filter @smthrs/cli build)"
            )
        if helper_binary(self.root, dict(os.environ)) is None:
            raise RuntimeError(
                f"no atomic filesystem helper: build it with (cd {self.root} && cargo build --release "
                f"-p smithers-ffi --bin smithers-jj-export) or set {HELPER_VARIABLE}"
            )
        if self.auth_mode == "chatgpt":
            self._pool = accounts.Pool.from_environment()
            if self._pool.accounts:
                # Waits here while the pool is paused, before any agent work.
                self._account = await asyncio.to_thread(self._pool.lease, self.logs_dir.parent.name)
            store = (self._account.auth if self._account
                     else Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "auth.json")
            if not store.is_file():
                raise RuntimeError(f"SMITHERS_OPENAI_AUTH=chatgpt but {store} does not exist; run `codex login`")

    def container_of(self, environment: BaseEnvironment) -> str:
        """The task container's id: the plue workspace id on Smithers Cloud,
        else the container found through the compose project Harbor named
        after the environment's session id."""
        override = os.environ.get("SMITHERS_BENCH_CONTAINER")
        if override:
            return override
        workspace_id = plue_workspace_of(environment)
        if workspace_id:
            self._plue = True
            return workspace_id
        project = compose_project_name(environment.session_id)
        result = subprocess.run(
            [self.docker, "ps", "-q", "--filter", f"label=com.docker.compose.project={project}",
             "--filter", "label=com.docker.compose.service=main"],
            capture_output=True, text=True, timeout=60, check=True,
        )
        ids = result.stdout.split()
        if len(ids) != 1:
            raise RuntimeError(f"expected one running `main` container for compose project {project}, found {ids}")
        return ids[0]

    def container_cwd(self, environment: BaseEnvironment) -> str:
        if self._cwd_override:
            return self._cwd_override
        config = getattr(environment, "task_env_config", None)
        workdir = getattr(config, "workdir", None)
        # On plue the environment read the image's WORKDIR from its registry.
        return workdir or getattr(environment, "_plue_workdir", None) or "/app"

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        container = self.container_of(environment)
        cwd = self.container_cwd(environment)
        budget = self._budget_sec
        if budget is None:
            budget = max(60.0, self._agent_timeout_sec - 60.0) if self._agent_timeout_sec else 3600.0
        helper = helper_binary(self.root, dict(os.environ))
        kept = self.logs_dir / "workspace"
        if kept.exists():
            shutil.rmtree(kept)
        trial = self.logs_dir.parent.name

        # One attempt per account: a seat that runs dry is not the model's
        # failure, so the trial is re-run whole on the next healthy account
        # and every re-run is on the record. A route fault raises so the
        # runner records an exception, never a reward.
        attempt = 0
        while True:
            attempt += 1
            # The CLI runs in a scratch directory outside any checkout: it
            # walks up from its working directory for project state, and a
            # jobs directory inside this repository would put the run under
            # the repository's own `.smithers`. It is moved under the trial's
            # logs when the attempt is over.
            workspace = Path(tempfile.mkdtemp(prefix="smithers-bench-"))
            flow_dir = workspace / "flows" / FLOW_NAME
            flow_dir.mkdir(parents=True)
            (flow_dir / "flow.mdx").write_text(
                render_prompt(instruction, seat=self.seat, container=container, cwd=cwd, commit=self._commit),
                encoding="utf-8",
            )
            shim_home = Path(tempfile.mkdtemp(prefix="smithers-shim-")) if self._plue else None
            shim = shim_directory(shim_home, shim_config(dict(os.environ), getattr(environment, "_plue_workdir", None))) \
                if shim_home else None
            env = cli_environment(dict(os.environ), auth_mode=self.auth_mode, helper=helper, shim=shim,
                                  codex_home=self._account.home if self._account else None,
                                  container=container)
            record: dict[str, Any] = {
                "framework": FRAMEWORK,
                "seat": self.seat,
                "authMode": self.auth_mode,
                "account": self._account.label if self._account else None,
                "attempt": attempt,
                "requeues": list(self._requeues),
                "transport": "plue" if self._plue else "docker",
                "openaiApiKeyInCliEnvironment": "OPENAI_API_KEY" in env,
                "asks": env.get(ASKS_VARIABLE),
                "helper": str(helper) if helper else None,
                "container": container,
                "cwd": cwd,
                "commit": self._commit,
                "budgetSec": budget,
                "harnessRoot": str(self.root),
                "harnessRevision": harness_revision(self.root),
                "subject": subject_fingerprint(self.root),
                "startedAt": _iso(int(time.time() * 1000)),
            }
            (self.logs_dir / "smithers-run.json").write_text(json.dumps(record, indent=2))

            started = time.monotonic()
            try:
                exit_status, phase = await asyncio.to_thread(self._drive, workspace, env, budget)
            finally:
                if shim_home is not None:
                    shutil.rmtree(shim_home, ignore_errors=True)
            wall = time.monotonic() - started
            shutil.move(str(workspace), str(kept))
            workspace = kept

            journal = journal_path(workspace / ".flows")
            events = read_journal(journal) if journal is not None else []
            summary = summarize(events)
            try:
                log_text = (self.logs_dir / "smithers-run.log").read_text(errors="replace")
            except OSError:
                log_text = ""
            kind, cause = verdict(log_text, summary, events)
            reached = container_commands(events, container)
            record.update({
                "verdict": kind,
                "cause": cause,
                "containerCommands": reached,
                "phase": phase,
                "exitStatus": exit_status,
                "wallSec": round(wall, 3),
                "journal": str(journal) if journal is not None else None,
                "run": summary,
                "finishedAt": _iso(int(time.time() * 1000)),
            })
            (self.logs_dir / "smithers-run.json").write_text(json.dumps(record, indent=2))

            if kind == "seat" and self._account is not None and self._pool is not None:
                reset_at = accounts.reset_time_of(cause or "") or accounts.reset_time_of(log_text)
                self._pool.disable(self._account.label, cause or "usage limit", reset_at)
                previous = self._account.label
                shutil.move(str(kept), str(self.logs_dir / f"workspace-attempt-{attempt}"))
                (self.logs_dir / "smithers-run.log").rename(self.logs_dir / f"smithers-run-attempt-{attempt}.log")
                with (self.logs_dir / "requeue.log").open("a", encoding="utf-8") as log:
                    log.write(f"{_iso(int(time.time() * 1000))} attempt {attempt} on {previous} ended in a usage limit"
                              f" (resets {reset_at or 'unknown'}): {cause}\n")
                # Waits while the pool is paused; raises NoSeatLeft after the wait.
                self._account = await asyncio.to_thread(self._pool.lease, trial)
                self._requeues.append({"attempt": attempt, "from": previous, "to": self._account.label,
                                       "cause": cause, "resetAt": reset_at})
                with (self.logs_dir / "requeue.log").open("a", encoding="utf-8") as log:
                    log.write(f"{_iso(int(time.time() * 1000))} requeued as attempt {attempt + 1} on {self._account.label}\n")
                continue
            break

        if self._commit:
            record["commitResult"] = await self._commit_work(environment, cwd)
            (self.logs_dir / "smithers-run.json").write_text(json.dumps(record, indent=2))
        if events:
            document = trajectory(
                events,
                agent_name=self.name(),
                agent_version=self.version() or "unknown",
                seat=self.seat,
                instruction=instruction,
                session_id=getattr(self, "session_id", None) or environment.session_id,
                extra={"authMode": self.auth_mode, "bindings": summary["bindings"],
                       "harnessRevision": record["harnessRevision"], "account": record["account"],
                       "requeues": record["requeues"]},
            )
            (self.logs_dir / "trajectory.json").write_text(json.dumps(document, indent=2))

        context.n_input_tokens = summary["usage"]["inputTokens"]
        context.n_cache_tokens = summary["usage"]["cachedInputTokens"]
        context.n_output_tokens = summary["usage"]["outputTokens"]
        # The subscription is billed by the month, not the token, so no USD.
        context.cost_usd = None
        context.metadata = {
            "seat": self.seat,
            "auth_mode": self.auth_mode,
            "account": record["account"],
            "attempt": attempt,
            "requeues": record["requeues"],
            "transport": record["transport"],
            "verdict": kind,
            "cause": cause,
            "bindings": summary["bindings"],
            "efforts": summary["efforts"],
            "harness_revision": record["harnessRevision"],
            "subject": (record["subject"] or {}).get("stamp"),
            "wall_sec": record["wallSec"],
            "exit_status": exit_status,
            "phase": phase,
            "run_status": summary["status"],
            "frames": summary["frames"],
            "calls": summary["calls"],
            "container_commands": reached,
        }
        self._summary = summary
        held = parked(summary)
        if held is not None:
            raise accounts.RunParked(held)
        if kind == "infra":
            raise accounts.ModelRouteError(cause or "model route failed")
        if kind == "seat":
            raise accounts.SeatExhausted(record["account"] or "?", cause or "usage limit")
        if reached["succeeded"] == 0:
            raise accounts.ContainerUnreachable(
                f"no command reached {container} with exit 0 ({reached['attempted']} attempted)")
        lost = await container_lost(environment)
        if lost is not None:
            record["containerLost"] = lost
            (self.logs_dir / "smithers-run.json").write_text(json.dumps(record, indent=2))
            raise accounts.ContainerUnreachable(f"task container {container} gone after the run: {lost}")

    def _cli(self, *args: str) -> list[str]:
        return ["node", str(self.root / CLI_RELATIVE), "--json", *args]

    def _drive(self, workspace: Path, env: dict[str, str], budget: float) -> tuple[int, str]:
        """plan, approve, run; the same three verbs the SWE-bench lane uses."""
        log = (self.logs_dir / "smithers-run.log").open("a", encoding="utf-8")
        try:
            plan = subprocess.run(self._cli("plan", FLOW_NAME), cwd=workspace, env=env,
                                  capture_output=True, text=True, timeout=300)
            log.write(plan.stderr)
            if plan.returncode != 0:
                log.write(plan.stdout)
                return plan.returncode, "plan"
            try:
                approval = json.dumps(json.loads(plan.stdout)["approval"])
            except (ValueError, KeyError):
                log.write(plan.stdout)
                return 1, "plan"
            approve = subprocess.run(self._cli("approve", approval, "--scope", "run"), cwd=workspace, env=env,
                                     capture_output=True, text=True, timeout=300)
            log.write(approve.stderr)
            if approve.returncode != 0:
                log.write(approve.stdout)
                return approve.returncode, "approve"
            try:
                run = subprocess.run(self._cli("run", approval), cwd=workspace, env=env,
                                     stdout=log, stderr=subprocess.STDOUT, text=True, timeout=budget)
            except subprocess.TimeoutExpired:
                log.write(f"\nsmithers_agent: run exceeded its {budget:.0f}s budget and was killed\n")
                return 124, "run"
            return run.returncode, "run"
        finally:
            log.close()

    async def _commit_work(self, environment: BaseEnvironment, cwd: str) -> dict[str, Any]:
        """Commit whatever the run left, so a grader that reads HEAD sees it.
        A model that already committed leaves nothing to add and this is a
        no-op; nothing here changes file contents."""
        command = (
            "git add -A && "
            "(git diff --cached --quiet && echo 'smithers_agent: nothing left to commit' || "
            "git -c user.name=smithers -c user.email=smithers@localhost commit -q -m 'smithers: task work' "
            "&& echo 'smithers_agent: committed remaining work')"
        )
        result = await environment.exec(command=command, cwd=cwd, timeout_sec=300)
        return {"returnCode": result.return_code, "stdout": (result.stdout or "")[-2000:],
                "stderr": (result.stderr or "")[-2000:]}
