"""What a finished Harbor trial means for scoring.

A trial is healthy only when it was graded, or graded after a whitelisted
agent outcome: the agent ran out of time (AgentTimeoutError), or the agent's
own process exited nonzero (NonZeroAgentExitCodeError) and was not
OpenSSH's own exit 255 with its transport message. Every other exception, and a
whitelisted one with no grade, is infrastructure: re-run, never scored. That
list is open on purpose: a new exception type is infra until someone argues
it into the whitelist.

    classify(result.json dict) -> "graded" | "agent" | "infra" | "unplaceable" | "running"

`unplaceable` (PlueUnplaceable) is a known capacity limit of the cluster: not
scored, not retried, and not counted in the infra rate.
"""

from __future__ import annotations

import re
from typing import Any

AGENT_OUTCOMES = frozenset({"AgentTimeoutError", "NonZeroAgentExitCodeError"})
UNPLACEABLE = "PlueUnplaceable"

# Exception types Harbor must re-run (`--retry-include` / `jobs resume -f`).
# A type missing here is still classified infra; this list is what the
# harness hands Harbor's type-based filters.
INFRA_EXCEPTIONS = (
    "PlueError", "VerifierTimeoutError", "CancelledError", "EnvironmentStartTimeoutError",
    "AgentSetupTimeoutError", "ContainerUnreachable", "ModelRouteError", "RuntimeError",
    "TimeoutError", "NoSeatLeft", "RunParked",
    # Harbor's verifier plumbing: test.sh never got to write a grade.
    "RewardFileNotFoundError", "RewardFileEmptyError", "VerifierOutputParseError",
    "DownloadVerifierDirError", "AddTestsDirError", "HealthcheckError",
    # Harbor installed-agent transport faults.
    "NetworkConnectionError", "ApiConnectionClosedError", "ApiResponseStalledError",
    "ApiInternalServerError", "ApiOverloadedError",
)


def retry_flags(retries: int = 3) -> str:
    """`harbor run` arguments that re-run every infra exception in-process.

        harbor run ... $(python3 -c 'import outcome; print(outcome.retry_flags())')
    """
    return " ".join([f"-r {retries}", *(f"--retry-include {name}" for name in INFRA_EXCEPTIONS)])

# OpenSSH's own client messages and the workspace gateway's transport errors
# (plue internal/ssh/server.go). Any of them in a command's output means the
# session, not the command, ended it.
_TRANSPORT = re.compile(
    r"(^|\n|: )("
    r"ssh: connect to host |ssh: Could not resolve hostname |"
    r"Connection to \S+ closed by remote host|Connection closed by \S+ port \d+|"
    r"Read from remote host \S+: |client_loop: send disconnect|"
    r"kex_exchange_identification: |Connection reset by \S+ port \d+|"
    r"Timeout, server \S+ not responding|"
    r"ERROR: workspace SSH session failed|ERROR: workspace SSH is unavailable"
    r")"
)


def ssh_transport_error(text: str | None) -> str | None:
    """The first SSH or gateway transport error line in `text`, if any."""
    if not text:
        return None
    match = _TRANSPORT.search(text)
    if not match:
        return None
    start = match.start(2)
    end = text.find("\n", start)
    return text[start:end if end >= 0 else len(text)].strip()


def classify(result: dict[str, Any]) -> str:
    if not result or not result.get("finished_at"):
        return "running"
    exception = result.get("exception_info") or {}
    kind = exception.get("exception_type")
    message = exception.get("exception_message") or ""
    rewards = (result.get("verifier_result") or {}).get("rewards") or {}
    graded = rewards.get("reward") is not None
    if kind is None:
        return "graded" if graded else "infra"
    if kind == UNPLACEABLE:
        return "unplaceable"
    if kind in AGENT_OUTCOMES and graded and not transport_exit(kind, message):
        return "agent"
    return "infra"


# Harbor's NonZeroAgentExitCodeError message starts with its own header,
# `Command failed (exit N): …`, then the agent's stdout and stderr.
_EXIT_HEADER = re.compile(r"Command failed \(exit (-?\d+)\)")


def transport_exit(kind: str, message: str) -> bool:
    """Whether an agent's nonzero exit was OpenSSH's own (exit 255 plus its
    message), not the agent's. The exit code is read from Harbor's header at
    the start of the message: the text after it is the agent's output, which
    the model under test controls, so a transport line there alone never
    turns a failed trial into a re-run."""
    if kind != "NonZeroAgentExitCodeError":
        return False
    header = _EXIT_HEADER.match(message)
    return header is not None and header.group(1) == "255" and ssh_transport_error(message) is not None


def is_healthy(kind: str) -> bool:
    return kind in ("graded", "agent")
