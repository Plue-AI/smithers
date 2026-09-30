"""Out-of-sandbox ALE deployer using the built Smithers CLI and ALE MCP bridges."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import signal
import sqlite3
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from ale_run.base_interface.agent_deployer import AgentRunResult, BaseAgentDeployer
from ale_run.base_interface.trajectory import (
    ContentPart,
    ImageSource,
    Observation,
    StepMetrics,
    ToolCall,
    ToolResult,
)

try:
    from .config import SmithersConfig
except ImportError:  # unittest discovery imports this file directly
    from config import SmithersConfig


CLI = Path("packages/smithers/dist/esm/bin.js")
HELPER = Path("target/release/smithers-jj-export")


def subscription_environment(base: dict[str, str], helper: Path, seal: str, pool_url: str = "") -> dict[str, str]:
    """Refuse API fallback and host filesystem/shell access, as the Harbor arm does."""
    env = {key: value for key, value in base.items()
           if not key.endswith("_API_KEY") and not key.startswith("SMITHERS_")}
    # Jev owns completion checking, independently of the subscription model seat.
    if base.get("AI_GATEWAY_API_KEY"):
        env["AI_GATEWAY_API_KEY"] = base["AI_GATEWAY_API_KEY"]
    env.update(SMITHERS_OPENAI_AUTH="chatgpt", SMITHERS_ASKS="refuse",
               SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=str(helper), SMITHERS_BASH_CONTAINER=seal)
    if pool_url:
        env["SMITHERS_ACCOUNT_POOL_URL"] = pool_url
        env["SMITHERS_ACCOUNT_POOL_PROVIDERS"] = "chatgpt"
        env["SMITHERS_ACCOUNT_POOL_KEY"] = base.get("SMITHERS_ACCOUNT_POOL_KEY", "")
    for key in ("CODEX_HOME", "SMITHERS_MCP_CONFIG", "OPENAI_BASE_URL", "OPENAI_API_BASE"):
        env.pop(key, None)
    return env


def _journal(work_dir: Path) -> list[tuple[str, dict]]:
    # Engine checkpoints and control completion receipts live in separate databases.
    merged: list[tuple[int, int, int, str, dict]] = []
    facts_seen: set[str] = set()
    for database_index, name in enumerate(("control.db", "engine.db")):
        path = work_dir / "workspace" / ".flows" / name
        if not path.is_file():
            continue
        try:
            with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
                rows = db.execute(
                    "SELECT seq,emitted_at_ms,event_type,payload_json FROM flows_journal_events ORDER BY seq"
                ).fetchall()
        except (sqlite3.Error, OSError):
            continue
        for seq, emitted_at_ms, tag, raw in rows:
            if type(seq) is not int or type(emitted_at_ms) is not int or not isinstance(tag, str):
                continue
            try:
                payload = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if tag == "control.engine.event":
                if (not isinstance(payload, dict) or payload.get("version") != 1 or
                        payload.get("eventType") != "flows.harness.step-fact.v1"):
                    continue
                tag, payload = payload["eventType"], payload.get("payload")
            if tag == "flows.harness.step-fact.v1":
                if (not isinstance(payload, dict) or payload.get("version") != 1 or
                        not isinstance(payload.get("eventType"), str) or
                        not payload["eventType"].startswith("control.agent.") or
                        not isinstance(payload.get("payload"), dict)):
                    continue
                step = payload.get("step")
                if not isinstance(step, dict):
                    continue
                identity = json.dumps([step, payload.get("generation"), payload.get("sourceSequence"),
                    payload["eventType"]], sort_keys=True)
                if identity in facts_seen:
                    continue
                facts_seen.add(identity)
                tag, payload = payload["eventType"], payload["payload"]
            if isinstance(payload, dict):
                merged.append((emitted_at_ms, database_index, seq, tag, payload))
    merged.sort(key=lambda event: event[:3])
    events = [(tag, payload) for _, _, _, tag, payload in merged]
    return events if any(tag.startswith("control.agent.") for tag, _ in events) else []


def _content(value: object) -> list[ContentPart]:
    """Keep MCP screenshots as ALE image parts rather than JSON strings."""
    if isinstance(value, dict) and isinstance(value.get("content"), list):
        parts = []
        for block in value["content"]:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "image" and isinstance(block.get("data"), str):
                parts.append(ContentPart(type="image", image=ImageSource(
                    type="base64", data=block["data"], media_type=block["mimeType"] if isinstance(block.get("mimeType"), str) and block["mimeType"].strip() else "image/png")))
            elif block.get("type") == "text" and isinstance(block.get("text"), str):
                parts.append(ContentPart(type="text", text=block["text"]))
        if parts:
            return parts
    return [ContentPart(type="text", text=value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))]


class SmithersDeployer(BaseAgentDeployer):
    default_executor = "local"
    supported_executors = frozenset({"local", "docker"})
    hot_artifacts = ("smithers-run.log", "smithers-run.json")

    @property
    def version(self) -> str:
        return "ale-smithers-1"

    async def install(self) -> None:
        cfg: SmithersConfig = self.config
        if not cfg.root:
            raise ValueError("Smithers root must name a built checkout on the executor host")
        self.root = Path(cfg.root).resolve()
        self.cli = self.root / CLI
        self.helper = self.root / HELPER
        compiled = (
            self.cli, self.helper,
            self.root / "evals/ale/runtime.mjs",
        )
        for path in compiled:
            if not path.is_file():
                raise FileNotFoundError(f"required built artifact missing: {path}")
        if not os.access(self.helper, os.X_OK):
            raise ValueError("smithers-jj-export must be executable")
        pool = urlsplit(cfg.account_pool_url)
        if pool.scheme not in ("http", "https") or not pool.netloc or pool.username or pool.password:
            raise ValueError("subscription account pool URL must be HTTP(S) without embedded credentials")
        if not os.environ.get("SMITHERS_ACCOUNT_POOL_KEY"):
            raise ValueError("subscription account pool credential missing")
        if not os.environ.get("AI_GATEWAY_API_KEY"):
            raise ValueError("completion judge credential AI_GATEWAY_API_KEY missing")
        work = Path(self.executor.work_dir)
        work.mkdir(parents=True, exist_ok=True)
        from ale_run.agents._bootstrap import (
            cua_bridge_env,
            ensure_cua_mcp_server_at,
            ensure_node_npm,
            ensure_vm_mcp_server,
            vm_bridge_env,
        )
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        self.node, _ = await ensure_node_npm()
        process = await asyncio.create_subprocess_exec(self.node, "--version", stdout=asyncio.subprocess.PIPE)
        output, _ = await process.communicate()
        try:
            version = tuple(int(part) for part in output.decode().strip().lstrip("v").split(".")[:2])
        except ValueError:
            version = ()
        if process.returncode != 0 or version < (26, 4):
            raise ValueError("ALE requires Node 26.4 or newer")
        process = await asyncio.create_subprocess_exec(self.node, str(self.root / "evals/ale/runtime.mjs"), "--bindings", stdout=asyncio.subprocess.PIPE)
        output, _ = await process.communicate()
        if process.returncode != 0:
            raise ValueError("trusted runtime package bindings unavailable")
        bindings = json.loads(output)
        expected = {"@smthrs/flow", "@smthrs/agent/AgentAction", "@smthrs/agent/EventSink", "effect"}
        if not isinstance(bindings, dict) or set(bindings) != expected:
            raise ValueError("trusted runtime package bindings incomplete")

        self.harness_artifacts: dict[str, object] = {
            str(path.relative_to(self.root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in compiled
        }
        self.harness_artifacts["node_version"] = ".".join(map(str, version))
        self.harness_artifacts["package_bindings"] = bindings
        bridges = [
            ("vm", await ensure_vm_mcp_server(str(work / "mcp" / "vm")), vm_bridge_env(self.executor)),
            ("cua", await ensure_cua_mcp_server_at(str(work / "mcp" / "cua")), cua_bridge_env(self.executor)),
        ]
        self.servers = []
        self.flows: list[str] = []
        for name, directory, env in bridges:
            entry = {"server": name, "command": self.node,
                     "args": [str(Path(directory) / "src" / "index.js")], "env": env}
            # Enumerate the actual catalog, never guess bridge tool names.
            bridge_env = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}
            bridge_env.update(env)
            async with stdio_client(StdioServerParameters(command=self.node, args=entry["args"], env=bridge_env)) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = await session.list_tools()
            if not tools.tools:
                raise ValueError(f"ALE {name} MCP bridge offers no tools")
            self.flows.extend(f"mcp/{name}/{tool.name}" for tool in tools.tools)
            self.servers.append(entry)

    async def _command(self, args: list[str], workspace: Path, env: dict[str, str], log) -> tuple[int, str]:
        process = await asyncio.create_subprocess_exec(
            self.node, "--import", str(self.root / "evals/ale/runtime.mjs"), str(self.cli), *args, "--root", str(workspace),
            "--mcp-config", str(workspace / "mcp.json"), "--format", "json",
            cwd=workspace, env=env, stdout=asyncio.subprocess.PIPE, stderr=log,
            start_new_session=True,
        )
        try:
            output, _ = await process.communicate()
        except BaseException:
            # ALE owns the episode timeout. Reap CLI and its MCP children before returning.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), timeout=2)
            except asyncio.TimeoutError:
                pass
            finally:
                # A parent can exit on TERM while a grandchild ignores it.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await process.wait()
            raise
        text = output.decode(errors="replace")
        log.write(text.encode())
        log.flush()
        assert process.returncode is not None
        return process.returncode, text

    async def launch(self, prompt: str) -> AgentRunResult:
        started = time.monotonic()
        error: str | None
        work = Path(self.executor.work_dir)
        workspace = work / "workspace"
        # Never mix an earlier attempt's journal with a new episode.
        try:
            workspace.mkdir(exist_ok=False)
        except FileExistsError:
            error = "workspace already exists; use a fresh episode work directory"
            self._receipt(work, "prepare", None, started, error, read_journal=False)
            return AgentRunResult(status="failed", error=error, duration_s=time.monotonic() - started)
        (workspace / "flows" / "ale").mkdir(parents=True)
        (workspace / "mcp.json").write_text(json.dumps(self.servers))
        # Named TypeScript flow, the same public authoring model used by the factory.
        # Imports resolve against the immutable built checkout, without a second install.
        source = (
            'import { Flow } from "@smthrs/flow";\n'
            'import * as AgentAction from "@smthrs/agent/AgentAction";\n'
            'import { Schema } from "effect";\n'
            'const Task = AgentAction.make("ale/task", {\n'
            '  payload: { instruction: Schema.String }, output: Schema.String,\n'
            f'  seat: {json.dumps(self.config.model.replace("/", ":", 1))}, modelParams: {{ reasoningEffort: "max" }},\n'
            '  system: [' + json.dumps("Use vm MCP tools for shell and files and cua MCP tools for computer use. "
                "All task work happens on the remote machine. Verify outputs before completing. "
                "Available remote tools: " + ", ".join(self.flows)) + '],\n'
            '  prompt: ({ instruction }) => instruction\n'
            '});\nexport const layer = Task.layer;\n'
            'export default Flow.make("ale", {\n'
            '  description: "Complete the ALE task through its remote tools.",\n'
            # Same explicit authority declaration as @smthrs/mcp/McpFlows;
            # opaque remote tools require all known actions, never the bare sentinel.
            '  capabilities: ' + json.dumps([action + ":**" for action in (
                "fs:read", "fs:write", "net:get", "net:post", "net:private", "model:call",
                "memory:read", "memory:write", "proc:spawn", "jj:status", "jj:diff",
                "jj:snapshot", "jj:restore", "jj:workspace-add", "jj:workspace-forget",
                "jj:root", "jj:revert", "jj:op-restore")]) + ', effects: { reads: ["**"], writes: ["**"], '
            'mode: "expected", onConflict: "serialize", tier: "irreversible" },\n'
            '  payload: {}, success: Schema.String, error: AgentAction.AgentFailure,\n'
            f'  body: () => Task.call({{ instruction: {json.dumps(prompt)} }})\n'
            '});\n'
        )
        (workspace / "flows" / "ale" / "flow.ts").write_text(source)
        env = subscription_environment(dict(os.environ), self.helper, "ale-unreachable-" + uuid.uuid4().hex, self.config.account_pool_url)
        codex_home = workspace / ".codex-disabled"
        codex_home.mkdir()
        env["CODEX_HOME"] = str(codex_home)
        phase, code, error = "run", None, None
        with (work / "smithers-run.log").open("wb") as log:
            try:
                code, _ = await self._command(["flow", "start", "ale", "--wait"], workspace, env, log)
                if code != 0:
                    error = f"Smithers {phase} exited {code}"
            except asyncio.CancelledError:
                self._receipt(work, phase, None, started, "cancelled")
                raise
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
        events = _journal(work)
        terminal = [payload for tag, payload in events if tag == "control.run.completed"]
        if error is None and not terminal:
            error = "missing completed control journal receipt"
        requests = [payload for tag, payload in events if tag == "control.agent.model-requested"]
        if error is None and (not requests or any(
                p.get("routeId") != "openai-chatgpt" or p.get("modelId") != "gpt-6-sol" or
                not isinstance(p.get("params"), dict) or p["params"].get("reasoningEffort") != "max"
                for p in requests)):
            error = "missing or mismatched subscription model-route evidence"
        self._receipt(work, phase, code, started, error)
        return AgentRunResult(status="failed" if error else "completed", exit_code=code,
                              error=error, duration_s=time.monotonic() - started,
                              transcript_path=str(work / "smithers-run.log"))

    def _receipt(self, work: Path, phase: str, code: int | None, started: float, error: str | None, *, read_journal: bool = True) -> None:
        events = _journal(work) if read_journal else []
        bindings = [payload for tag, payload in events if tag == "control.agent.model-requested"]
        (work / "smithers-run.json").write_text(json.dumps({
            "model": self.config.model, "reasoning_effort": self.config.reasoning_effort,
            "auth_mode": "chatgpt", "phase": phase, "exit_code": code,
            "duration_s": time.monotonic() - started, "error": error,
            "bindings": bindings, "harness_artifacts": getattr(self, "harness_artifacts", {}),
        }, indent=2))

    @classmethod
    def parse_artifacts(cls, *, work_dir: Path, config, run_result: AgentRunResult, builder) -> None:
        if run_result.status == "failed" and run_result.error == "workspace already exists; use a fresh episode work directory":
            builder.add_step("system", message=run_result.error)
            return
        events = _journal(work_dir)
        if not events:
            builder.add_step("system", message="Smithers journal missing or unreadable; no agent evidence.")
            return
        for tag, payload in events:
            if tag == "control.agent.model-settled":
                usage = payload.get("usage")
                usage = usage if isinstance(usage, dict) else {}
                mapping = {"input_tokens": "inputTokens", "output_tokens": "outputTokens",
                           "cache_read_tokens": "cachedInputTokens"}
                metrics = {out: usage[key] for out, key in mapping.items()
                           if type(usage.get(key)) is int and usage[key] >= 0}
                if type(payload.get("durationMillis")) is int and payload["durationMillis"] >= 0:
                    metrics["duration_ms"] = payload["durationMillis"]
                builder.add_step("agent", message=payload.get("text") if isinstance(payload.get("text"), str) else json.dumps(payload.get("text"), ensure_ascii=False), metrics=StepMetrics(**metrics))
            elif tag == "control.agent.cell-call-started":
                call_id = str(payload.get("callId") or "")
                arguments = payload.get("input")
                builder.add_step("agent", tool_calls=[ToolCall(id=call_id,
                    name=str(payload.get("flowName") or "unknown"),
                    arguments=arguments if isinstance(arguments, dict) else {"input": arguments})])
            elif tag == "control.agent.cell-call-settled":
                failed = payload.get("outcome") == "failure"
                builder.add_step("environment", observation=Observation(results=[ToolResult(
                    tool_call_id=str(payload.get("callId") or ""), is_error=failed,
                    content=_content(payload.get("message") if failed else payload.get("value")))]))
            elif tag == "control.agent.cell-printed":
                builder.add_step("agent", message=payload.get("text") if isinstance(payload.get("text"), str) else json.dumps(payload.get("text"), ensure_ascii=False))
        if not builder.trajectory.steps:
            builder.add_step("system", message="Smithers journal has no readable agent steps.")
