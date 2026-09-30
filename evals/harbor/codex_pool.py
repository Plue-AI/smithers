"""Harbor's stock Codex CLI agent, drawing one Codex login per trial.

    harbor run … -a evals.harbor.codex_pool:PooledCodex -m openai/gpt-6-sol \
        --ak version=0.155.1 --ak reasoning_effort=max

Harbor's `codex` agent takes one `auth.json` for the whole job
(`CODEX_FORCE_AUTH_JSON` / `CODEX_AUTH_JSON_PATH`). This subclass leases the
next account from `accounts.Pool` for each trial instead, records the label
(never the email) beside the trial's logs, and applies the same policy as
`SmithersAgent`: a usage limit takes the account out of rotation and re-runs
the trial whole on the next healthy account (every re-run in `requeue.log`),
and when none is left the pool pauses and then raises, so a dry seat is never
scored. Everything else is Harbor's Codex agent unchanged.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from . import accounts

ACCOUNT_FILE = "codex-account.json"


def usage_limit_in(output: str) -> str | None:
    """The usage-limit line in the CLI's output, if any."""
    for line in output.splitlines():
        if accounts.mentions_usage_limit(line):
            return line.strip()[:500]
    return None


def container_commands(output: str) -> dict[str, int]:
    """Codex `command_execution` items the CLI completed inside the task
    container, and how many exited 0. The CLI runs in the container, so every
    command it ran is a container command."""
    attempted = succeeded = 0
    for line in output.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        item = event.get("item") if isinstance(event, dict) else None
        if event.get("type") != "item.completed" or not isinstance(item, dict):
            continue
        if item.get("type") == "command_execution":
            attempted += 1
            if item.get("exit_code") == 0:
                succeeded += 1
    return {"attempted": attempted, "succeeded": succeeded}


class PooledCodex(Codex):
    def __init__(self, logs_dir: Path, model_name: str | None = None, **kwargs: Any) -> None:
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        self._pool = accounts.Pool.from_environment()
        self._account: accounts.Account | None = None
        self._requeues: list[dict[str, Any]] = []
        self._metadata: dict[str, Any] = {}

    @staticmethod
    def name() -> str:
        return "codex"

    async def setup(self, environment: BaseEnvironment) -> None:
        # Waits here while the pool is paused, before the CLI is installed.
        self._account = await asyncio.to_thread(self._pool.lease, self.logs_dir.parent.name)
        self._write_account()
        await super().setup(environment)

    def _write_account(self, **extra: Any) -> None:
        (self.logs_dir / ACCOUNT_FILE).write_text(json.dumps(
            {"account": self._account.label if self._account else None, "requeues": self._requeues, **extra}, indent=2))

    def _resolve_auth_json_path(self) -> Path | None:
        if self._account is None:
            raise RuntimeError("PooledCodex.run before setup: no account leased")
        return self._account.auth

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        attempt = 0
        while True:
            attempt += 1
            failure: BaseException | None = None
            try:
                await super().run(instruction, environment, context)
            except Exception as error:  # a dry seat may surface as a failed command
                failure = error
            output = self.logs_dir / self._OUTPUT_FILENAME
            await self._fetch_output(environment, output)
            try:
                text = output.read_text(errors="replace")
            except OSError:
                text = ""
            limit = usage_limit_in(text) or (usage_limit_in(str(failure)) if failure else None)
            if limit is None:
                if failure is not None:
                    raise failure
                break
            assert self._account is not None
            reset_at = accounts.reset_time_of(text)
            previous = self._account.label
            self._pool.disable(previous, limit, reset_at)
            if output.is_file():
                shutil.move(str(output), str(self.logs_dir / f"codex-attempt-{attempt}.txt"))
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            with (self.logs_dir / "requeue.log").open("a", encoding="utf-8") as log:
                log.write(f"{now} attempt {attempt} on {previous} ended in a usage limit (resets {reset_at or 'unknown'}): {limit}\n")
            self._account = await asyncio.to_thread(self._pool.lease, self.logs_dir.parent.name)
            self._requeues.append({"attempt": attempt, "from": previous, "to": self._account.label,
                                   "cause": limit, "resetAt": reset_at})
            self._write_account()
            with (self.logs_dir / "requeue.log").open("a", encoding="utf-8") as log:
                log.write(f"{now} requeued as attempt {attempt + 1} on {self._account.label}\n")
        reached = container_commands(text)
        self._write_account(attempt=attempt, containerCommands=reached)
        # Kept off the context until Harbor has filled it: Harbor reads the
        # session's token usage only into an empty context.
        self._metadata = {"account": self._account.label if self._account else None,
                          "attempt": attempt, "requeues": self._requeues, "container_commands": reached}
        if reached["succeeded"] == 0:
            raise accounts.ContainerUnreachable(
                f"codex ran no command with exit 0 in the task container ({reached['attempted']} attempted)")

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Harbor's usage and trajectory from the Codex session, then the pool's
        record. Harbor calls this after `run`, raised or not, only while the
        context is still empty."""
        super().populate_context_post_run(context)
        context.metadata = {**(context.metadata or {}), **self._metadata}

    async def _fetch_output(self, environment: BaseEnvironment, output: Path) -> None:
        """On an environment that does not mount the logs directory (plue),
        the CLI's output is still in the container when `run` returns; the
        runner copies it only afterwards. Fetch it now so the usage-limit
        check and the container gate read what the CLI printed."""
        capabilities = getattr(environment, "capabilities", None)
        if getattr(capabilities, "mounted", True):
            return
        try:
            await environment.download_file(f"/logs/agent/{self._OUTPUT_FILENAME}", output)
        except Exception:  # absent when the CLI never started; the gate then sees nothing
            pass
