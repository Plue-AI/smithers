"""Use the pinned ALE package on PYTHONPATH; dependencies must be real."""
import asyncio
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ale_run.base_interface.agent_deployer import AgentRunResult, BaseAgentDeployer
from ale_run.base_interface.trajectory import TrajectoryBuilder
from config import SmithersConfig
from deployer import (
    CLI,
    HELPER,
    SmithersDeployer,
    _content,
    _journal,
    subscription_environment,
)


def step_fact(tag, payload):
    # Source contract: flows/journal/src/StepFact.ts Fact + NativeControlJudged.readJournal.
    return {"version": 1, "step": {"stepId": "a" * 64, "executionId": "execution",
        "action": "ale/task", "attempt": 1, "ask": 0, "retry": 1, "scope": "ale"},
        "generation": 0, "frame": 0, "ordinal": 0, "cell": "cell", "at": 1,
        "eventType": tag, "sourceSequence": 0, "payload": payload}


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("ALE_TEST_SCRATCH"))
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.config = SmithersConfig(root=str(self.work))
        self.result = AgentRunResult(status="completed", exit_code=0)

    def parse(self):
        builder = TrajectoryBuilder(agent_name="smithers", task_path="docker/a", variant_index=0)
        SmithersDeployer.parse_artifacts(work_dir=self.work, config=self.config,
                                        run_result=self.result, builder=builder)
        self.assertIsNone(builder.trajectory.final_metrics)
        return builder.trajectory.steps

    def journal(self, events, name="control.db"):
        folder = self.work / "workspace" / ".flows"
        folder.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(folder / name) as db:
            db.execute("CREATE TABLE flows_journal_events(seq INTEGER, emitted_at_ms INTEGER, event_type TEXT, payload_json TEXT)")
            for seq, (tag, payload) in enumerate(events, 1):
                db.execute("INSERT INTO flows_journal_events VALUES(?,?,?,?)", (seq, seq * 1000, tag, json.dumps(payload)))

    def test_real_ale_interface_and_defaults(self):
        self.assertTrue(issubclass(SmithersDeployer, BaseAgentDeployer))
        self.assertEqual(self.config.model, "openai/gpt-6-sol")
        self.assertEqual(self.config.reasoning_effort, "max")
        self.assertIn(SmithersDeployer.default_executor, SmithersDeployer.supported_executors)

    def test_missing_journal_is_one_gap_without_fabricated_reward(self):
        steps = self.parse()
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0].source, "system")
        self.assertTrue(steps[0].message)
        self.assertEqual(steps[0].tool_calls, [])

    def test_corrupt_or_wrong_schema_journal_is_one_gap(self):
        folder = self.work / "workspace" / ".flows"
        folder.mkdir(parents=True)
        path = folder / "control.db"
        for content in (b"not sqlite", b""):
            with self.subTest(content=content):
                path.write_bytes(content)
                steps = self.parse()
                self.assertEqual([s.source for s in steps], ["system"])

    def test_actual_control_events_preserve_text_and_tool_observation(self):
        self.journal([
            ("control.agent.turn-opened", {"turnId": "turn-1"}),
            ("control.agent.model-settled", {"turnId": "turn-1", "text": "Inspecting files", "usage": {"inputTokens": 7, "outputTokens": 3}}),
            ("control.agent.cell-call-started", {"turnId": "turn-1", "callId": "call-1", "flowName": "mcp/vm/read", "input": {"path": "/tmp/input"}}),
            ("control.agent.cell-call-settled", {"turnId": "turn-1", "callId": "call-1", "value": {"text": "contents"}, "outcome": "success"}),
        ])
        steps = self.parse()
        self.assertTrue(any(s.source == "agent" and s.message == "Inspecting files" for s in steps))
        calls = [call for step in steps for call in step.tool_calls]
        self.assertEqual([(c.id, c.name, c.arguments) for c in calls], [("call-1", "mcp/vm/read", {"path": "/tmp/input"})])
        results = [r for s in steps if s.observation for r in s.observation.results]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].tool_call_id, "call-1")
        self.assertFalse(results[0].is_error)
        self.assertIn("contents", " ".join(p.text or "" for p in results[0].content))
        self.assertLess(next(i for i,s in enumerate(steps) if s.tool_calls), next(i for i,s in enumerate(steps) if s.observation))

    def test_engine_journal_fallback_and_tool_failure(self):
        self.journal([
            ("control.agent.cell-call-started", {"callId": "bad", "flowName": "mcp/vm/read", "input": {}}),
            ("control.agent.cell-call-settled", {"callId": "bad", "outcome": "failure", "code": "ENOENT", "message": "missing file"}),
        ], "engine.db")
        steps = self.parse()
        results = [r for s in steps if s.observation for r in s.observation.results]
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].is_error)
        self.assertIn("missing file", " ".join(p.text or "" for p in results[0].content))

    def test_parallel_calls_settle_by_id_in_reverse_order(self):
        self.journal([
            ("control.agent.cell-call-started", {"callId": "a", "flowName": "mcp/vm/read", "input": {"path": "a"}}),
            ("control.agent.cell-call-started", {"callId": "b", "flowName": "mcp/vm/read", "input": {"path": "b"}}),
            ("control.agent.cell-call-settled", {"callId": "b", "value": "second", "outcome": "success"}),
            ("control.agent.cell-call-settled", {"callId": "a", "value": "first", "outcome": "success"}),
        ])
        steps = self.parse()
        results = [r for step in steps if step.observation for r in step.observation.results]
        self.assertEqual([(r.tool_call_id, r.content[0].text) for r in results], [("b", "second"), ("a", "first")])

    def test_split_engine_and_control_journals_preserve_agent_evidence(self):
        self.journal([("control.run.completed", {"status": "completed"})], "control.db")
        self.journal([
            ("control.agent.model-requested", {"routeId": "openai-chatgpt", "modelId": "gpt-6-sol", "params": {"reasoningEffort": "max"}}),
            ("control.agent.cell-call-started", {"callId": "split", "flowName": "mcp/vm/read", "input": {"path": "remote"}}),
            ("control.agent.cell-call-settled", {"callId": "split", "value": "remote contents", "outcome": "success"}),
        ], "engine.db")
        steps = self.parse()
        self.assertEqual([s.source for s in steps], ["agent", "environment"])
        self.assertEqual(steps[0].tool_calls[0].id, "split")
        self.assertEqual(steps[1].observation.results[0].tool_call_id, "split")
        self.assertEqual(steps[1].observation.results[0].content[0].text, "remote contents")

    def test_merged_journal_orders_by_time_then_database_and_sequence(self):
        self.journal([("control.agent.cell-printed", {"text": "control-late"}),
                      ("control.agent.cell-printed", {"text": "control-tie"})], "control.db")
        self.journal([("control.agent.cell-printed", {"text": "engine-early"}),
                      ("control.agent.cell-printed", {"text": "engine-tie"})], "engine.db")
        folder = self.work / "workspace" / ".flows"
        with sqlite3.connect(folder / "control.db") as db:
            db.execute("UPDATE flows_journal_events SET emitted_at_ms=3000 WHERE seq=1")
        before = {path: path.read_bytes() for path in folder.iterdir()}
        self.assertEqual([p["text"] for _, p in _journal(self.work)],
                         ["engine-early", "control-tie", "engine-tie", "control-late"])
        self.assertEqual(before, {path: path.read_bytes() for path in folder.iterdir()})

    def test_malformed_row_does_not_discard_valid_other_database(self):
        self.journal([("control.run.completed", {})], "control.db")
        self.journal([("control.agent.cell-printed", {"text": "valid"})], "engine.db")
        with sqlite3.connect(self.work / "workspace" / ".flows" / "control.db") as db:
            for seq, payload in ((2, "not json"), (3, "[]"), (4, "null")):
                db.execute("INSERT INTO flows_journal_events VALUES(?,?,?,?)", (seq,seq,"control.agent.cell-printed",payload))
        events = _journal(self.work)
        self.assertEqual(len(events), 2)
        self.assertTrue(any(p.get("text") == "valid" for _,p in events))

    def test_truncated_text_and_malformed_usage_preserve_partial_trajectory(self):
        text = {"truncated": True, "preview": "partial model output"}
        printed = {"truncated": True, "preview": "partial print"}
        self.journal([
            ("control.agent.model-settled", {"text": text, "usage": ["malformed"]}),
            ("control.agent.cell-printed", {"text": printed}),
        ])
        steps = self.parse()
        self.assertEqual([step.source for step in steps], ["agent", "agent"])
        self.assertEqual(json.loads(steps[0].message), text)
        self.assertEqual(json.loads(steps[1].message), printed)
        self.assertIsNone(steps[0].metrics.input_tokens)
        self.assertIsNone(steps[0].metrics.output_tokens)

    def test_native_step_facts_unwrap_real_producer_contract(self):
        self.journal([("control.run.completed", {})], "control.db")
        self.journal([("flows.harness.step-fact.v1", step_fact(tag, payload)) for tag,payload in [
            ("control.agent.model-requested", {"routeId": "codex", "modelId": "gpt-6-sol", "params": {"reasoningEffort": "max"}}),
            ("control.agent.model-settled", {"text": "native subscription"}),
            ("control.agent.cell-call-started", {"callId": "native", "flowName": "mcp/vm/read", "input": {}}),
            ("control.agent.cell-call-settled", {"callId": "native", "value": "read", "outcome": "success"}),
        ]], "engine.db")
        events = _journal(self.work)
        self.assertTrue(any(tag == "control.run.completed" for tag,_ in events))
        self.assertTrue(any(tag == "control.agent.model-requested" and p["routeId"] == "codex" for tag,p in events))
        steps = self.parse()
        self.assertEqual(steps[0].message, "native subscription")
        self.assertEqual(steps[2].observation.results[0].tool_call_id, "native")

    def test_mirrored_facts_project_once_without_collapsing_distinct_observations(self):
        fact = step_fact("control.agent.model-settled", {"text": "same text"})
        repeated = dict(fact, sourceSequence=1)
        control_only = dict(fact, sourceSequence=2, payload={"text": "control only"})
        envelope = lambda value: {"version": 1, "eventType": "flows.harness.step-fact.v1",
            "executionId": "execution", "generation": 0, "sequence": 1,
            "sourceId": "step-fact-v1:" + "a" * 64 + ":1:0:1",
            "sourceSequence": value["sourceSequence"], "emittedAtMs": 1000, "payload": value}
        self.journal([("control.engine.event", envelope(fact)),
                      ("control.engine.event", envelope(repeated)),
                      ("control.engine.event", envelope(control_only)),
                      ("control.run.completed", {})], "control.db")
        self.journal([("flows.harness.step-fact.v1", fact),
                      ("flows.harness.step-fact.v1", repeated)], "engine.db")
        self.assertEqual([step.message for step in self.parse()], ["same text", "same text", "control only"])

    def test_malformed_journal_coordinates_and_envelopes_cannot_fabricate_steps(self):
        self.journal([("control.agent.cell-printed", {"text": "valid"})])
        path = self.work / "workspace" / ".flows" / "control.db"
        invalid = [
            (None, 0, "control.agent.cell-printed", {"text": "invalid seq"}),
            (10, None, "control.agent.cell-printed", {"text": "invalid time"}),
            (11, 0, None, {"text": "invalid type"}),
            (12, 0, "control.engine.event", {"version": 2}),
            (13, 0, "flows.harness.step-fact.v1", {"version": 1}),
            (14, 0, "flows.harness.step-fact.v1", dict(step_fact("control.agent.cell-printed", {}), step=None)),
        ]
        with sqlite3.connect(path) as db:
            for seq,time,tag,payload in invalid:
                db.execute("INSERT INTO flows_journal_events VALUES(?,?,?,?)", (seq,time,tag,json.dumps(payload)))
        self.assertEqual([step.message for step in self.parse()], ["valid"])

    def test_partial_agent_journal_without_readable_steps_reports_gap(self):
        self.journal([("control.agent.turn-opened", {"turnId": "partial"})])
        steps = self.parse()
        self.assertEqual([step.source for step in steps], ["system"])
        self.assertIn("no readable", steps[0].message)

    def test_model_duration_uses_top_level_producer_field(self):
        self.journal([("control.agent.model-settled", {"text": "response", "durationMillis": duration,
            "usage": {"inputTokens": 7, "outputTokens": 3, "cachedInputTokens": 2, "durationMillis": 999}})
            for duration in (0, 42, None, -1, "42", True)])
        steps = self.parse()
        self.assertEqual([step.metrics.duration_ms for step in steps], [0, 42, None, None, None, None])
        for step in steps:
            self.assertEqual(step.metrics.input_tokens, 7)
            self.assertEqual(step.metrics.output_tokens, 3)
            self.assertEqual(step.metrics.cache_read_tokens, 2)

    def test_unrelated_events_do_not_become_success(self):
        self.journal([("run.completed", {"reward": 1}), ("control.approval.granted", {})])
        steps = self.parse()
        self.assertEqual([s.source for s in steps], ["system"])


class EnvironmentTests(unittest.TestCase):
    def test_metered_credentials_and_overrides_removed_without_mutation(self):
        original = dict(PATH="/bin", OPENAI_API_KEY="metered", ANTHROPIC_API_KEY="metered",
                        AI_GATEWAY_API_KEY="judge", OPENAI_BASE_URL="override",
                        OPENAI_API_BASE="override", SMITHERS_TEST_MODEL="fake",
                        SMITHERS_MCP_CONFIG="host", SMITHERS_MEMORY_DB="shared",
                        SMITHERS_REMOTE="remote", SMITHERS_TOKEN="credential", SMITHERS_CODING_FALLBACK_MODEL="openai:gpt-6-sol", CODEX_HOME="/login")
        before = original.copy()
        env = subscription_environment(original, Path("/helper"), "sealed")
        self.assertEqual(original, before)
        for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL",
                    "OPENAI_API_BASE", "SMITHERS_TEST_MODEL", "SMITHERS_MCP_CONFIG",
                    "SMITHERS_MEMORY_DB", "SMITHERS_REMOTE", "SMITHERS_TOKEN", "SMITHERS_CODING_FALLBACK_MODEL"):
            self.assertNotIn(key, env)
        self.assertEqual(env["AI_GATEWAY_API_KEY"], "judge")
        self.assertEqual(env["SMITHERS_OPENAI_AUTH"], "chatgpt")
        self.assertEqual(env["SMITHERS_BASH_CONTAINER"], "sealed")
        self.assertNotIn("CODEX_HOME", env)
        pooled = subscription_environment(dict(original, SMITHERS_ACCOUNT_POOL_KEY="pool-key"), Path("/helper"), "sealed", "https://pool.example")
        self.assertEqual(pooled["SMITHERS_ACCOUNT_POOL_URL"], "https://pool.example")
        self.assertEqual(pooled["SMITHERS_ACCOUNT_POOL_KEY"], "pool-key")
        self.assertEqual(pooled["SMITHERS_ACCOUNT_POOL_PROVIDERS"], "chatgpt")

    def test_comparison_pins_fail_closed(self):
        for kwargs in ({"model": "openai/gpt-6.1-sol"}, {"reasoning_effort": "high"},
                       {"model": None}, {"reasoning_effort": None}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                SmithersConfig(**kwargs)

    def test_malformed_mcp_blocks_preserve_valid_text_and_image(self):
        parts = _content({"content": [None, {"type": "text", "text": {}},
            {"type": "image", "data": 12}, {"type": "image", "data": "aGVsbG8=", "mimeType": None},
            {"type": "text", "text": "intact"}]})
        self.assertEqual([part.type for part in parts], ["image", "text"])
        self.assertEqual(parts[0].image.media_type, "image/png")
        self.assertEqual(parts[0].image.data, "aGVsbG8=")
        self.assertEqual(parts[1].text, "intact")

    def test_empty_or_unrecognized_mcp_content_retains_raw_evidence(self):
        for value in ({"content": []}, {"content": [{"type": "audio", "data": "raw"}]}):
            with self.subTest(value=value):
                parts = _content(value)
                self.assertEqual(len(parts), 1)
                self.assertEqual(parts[0].type, "text")
                self.assertEqual(json.loads(parts[0].text), value)

    def test_screenshot_and_text_content_use_real_ale_models(self):
        parts = _content({"content": [{"type": "image", "data": "aGVsbG8=", "mimeType": "image/jpeg"},
                                       {"type": "text", "text": "screen"}, None]})
        self.assertEqual([p.type for p in parts], ["image", "text"])
        self.assertEqual(parts[0].image.type, "base64")
        self.assertEqual(parts[0].image.media_type, "image/jpeg")
        self.assertEqual(parts[0].image.data, "aGVsbG8=")
        self.assertEqual(parts[1].text, "screen")
        self.assertEqual(_content("plain")[0].text, "plain")
        self.assertEqual(json.loads(_content({"answer": 1})[0].text), {"answer": 1})


class InstallTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("ALE_TEST_SCRATCH"))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.work = self.root / "work"
        self.env = { "AI_GATEWAY_API_KEY": "unit-judge", "SMITHERS_ACCOUNT_POOL_KEY": "unit-pool", "PATH": "/unit/bin", "HOME": str(self.root)}
        self.agent = SmithersDeployer(SimpleNamespace(work_dir=str(self.work), config=SmithersConfig(root=str(self.root), account_pool_url="https://pool.example")))
    def artifacts(self):
        for relative in (CLI, HELPER):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("unit artifact")
        runtime = self.root / "evals/ale/runtime.mjs"
        runtime.parent.mkdir(parents=True, exist_ok=True)
        # Unit manifest fixture isolates MCP/npm network bootstrap; the runtime
        # loader test independently hashes and imports real host packages.
        manifest = {name: {"path": str(self.root / CLI), "sha256": "a" * 64}
                    for name in ("@smthrs/flow", "@smthrs/agent/AgentAction", "@smthrs/agent/EventSink", "effect")}
        runtime.write_text("console.log(" + json.dumps(json.dumps(manifest)) + ");")
        (self.root / HELPER).chmod(0o700)

    async def test_missing_root_fails_before_bootstrap_import(self):
        self.agent.config.root = ""
        with patch.dict(os.environ, self.env, clear=True), self.assertRaisesRegex(ValueError, "root"):
            await self.agent.install()

    async def test_missing_artifacts_fail_before_bootstrap_import(self):
        self.artifacts()
        for relative in (CLI, HELPER, Path("evals/ale/runtime.mjs")):
            with self.subTest(relative=relative):
                path = self.root / relative
                content = path.read_bytes()
                path.unlink()
                with patch.dict(os.environ, self.env, clear=True), self.assertRaises(FileNotFoundError):
                    await self.agent.install()
                path.write_bytes(content)
                if relative == HELPER:
                    path.chmod(0o700)

    async def test_nonexecutable_helper_missing_pool_and_judge_fail_closed(self):
        self.artifacts()
        helper = self.root / HELPER
        helper.chmod(0o600)
        with patch.dict(os.environ, self.env, clear=True), self.assertRaisesRegex(ValueError, "executable"):
            await self.agent.install()
        helper.chmod(0o700)
        pool_env = dict(self.env)
        del pool_env["SMITHERS_ACCOUNT_POOL_KEY"]
        with patch.dict(os.environ, pool_env, clear=True), self.assertRaisesRegex(ValueError, "pool credential"):
            await self.agent.install()
        env = dict(self.env)
        del env["AI_GATEWAY_API_KEY"]
        with patch.dict(os.environ, env, clear=True), self.assertRaisesRegex(ValueError, "judge"):
            await self.agent.install()

    def bootstrap_modules(self, empty=False):
        # Unit exception: npm installation and remote MCP transport would write
        # node_modules and require network credentials. Catalog/protocol handling
        # is isolated here; launch subprocess and ALE model tests remain real.
        bootstrap = SimpleNamespace(
            ensure_node_npm=AsyncMock(return_value=(shutil.which("node"), "/unit/npm")),
            ensure_vm_mcp_server=AsyncMock(side_effect=lambda path: path),
            ensure_cua_mcp_server_at=AsyncMock(side_effect=lambda path: path),
            vm_bridge_env=lambda executor: {"VM_URL": "remote-vm"},
            cua_bridge_env=lambda executor: {"CUA_URL": "remote-cua"})
        sessions = []
        params = []

        @asynccontextmanager
        async def stdio_client(parameter):
            params.append(parameter)
            yield parameter, None

        class Session:
            def __init__(self, read, write):
                self.initialize = AsyncMock()
                name = "read" if "VM_URL" in read.env else "screenshot"
                self.list_tools = AsyncMock(return_value=SimpleNamespace(tools=[] if empty else [SimpleNamespace(name=name)]))
                sessions.append(self)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        modules = {"ale_run.agents._bootstrap": bootstrap,
                   "mcp": SimpleNamespace(ClientSession=Session, StdioServerParameters=SimpleNamespace),
                   "mcp.client.stdio": SimpleNamespace(stdio_client=stdio_client)}
        return modules, bootstrap, sessions, params

    async def test_bootstrap_enumerates_both_remote_catalogs_and_hashes_artifacts(self):
        self.artifacts()
        modules, bootstrap, sessions, params = self.bootstrap_modules()
        with patch.dict(os.environ, self.env, clear=True), patch.dict(sys.modules, modules):
            await self.agent.install()
        self.assertEqual(self.agent.flows, ["mcp/vm/read", "mcp/cua/screenshot"])
        self.assertEqual([s["server"] for s in self.agent.servers], ["vm", "cua"])
        bootstrap.ensure_vm_mcp_server.assert_awaited_once_with(str(self.work / "mcp" / "vm"))
        bootstrap.ensure_cua_mcp_server_at.assert_awaited_once_with(str(self.work / "mcp" / "cua"))
        for session in sessions:
            session.initialize.assert_awaited_once()
            session.list_tools.assert_awaited_once()
        self.assertTrue(all("AI_GATEWAY_API_KEY" not in parameter.env for parameter in params))
        self.assertEqual(len(self.agent.harness_artifacts[str(CLI)]), 64)
        self.assertEqual(len(self.agent.harness_artifacts[str(HELPER)]), 64)

    async def test_invalid_account_pool_url_fails_before_network(self):
        self.artifacts()
        for url in ("", "file:///login", "https://user:key@example.test"):
            with self.subTest(url=url):
                self.agent.config.account_pool_url = url
                with patch.dict(os.environ, self.env, clear=True), self.assertRaisesRegex(ValueError, "URL"):
                    await self.agent.install()

    async def test_node_version_and_runtime_manifest_fail_before_bridge_bootstrap(self):
        self.artifacts()
        for index, (version, manifest, code, error) in enumerate([
            ("v26.3.0", "{}", 0, "Node 26.4"),
            ("bad-version", "{}", 0, "Node 26.4"),
            ("v26.4.0", "{}", 0, "bindings incomplete"),
            ("v26.4.0", "{}", 1, "bindings unavailable"),
        ]):
            with self.subTest(version=version, code=code):
                node = self.root / ("node-fixture-" + str(index))
                node.write_text("#!" + sys.executable + "\nimport sys\nif '--version' in sys.argv:\n print(" + repr(version) + ")\nelse:\n print(" + repr(manifest) + ")\n sys.exit(" + str(code) + ")\n")
                node.chmod(0o700)
                modules, bootstrap, _, _ = self.bootstrap_modules()
                bootstrap.ensure_node_npm.return_value = (str(node), "/unit/npm")
                with patch.dict(os.environ, self.env, clear=True), patch.dict(sys.modules, modules), self.assertRaisesRegex(ValueError, error):
                    await self.agent.install()
                bootstrap.ensure_vm_mcp_server.assert_not_awaited()

    async def test_empty_remote_catalog_refused(self):
        self.artifacts()
        modules, _, _, _ = self.bootstrap_modules(empty=True)
        with patch.dict(os.environ, self.env, clear=True), patch.dict(sys.modules, modules), self.assertRaisesRegex(ValueError, "no tools"):
            await self.agent.install()


class RuntimeLoaderTests(unittest.TestCase):
    def test_real_binding_receipt_hashes_resolved_host_entries(self):
        root = Path(__file__).resolve().parents[3]
        result = subprocess.run([shutil.which("node"), str(root / "evals/ale/runtime.mjs"), "--bindings"], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        bindings = json.loads(result.stdout)
        self.assertEqual(set(bindings), {"@smthrs/flow", "@smthrs/agent/AgentAction", "@smthrs/agent/EventSink", "effect"})
        for binding in bindings.values():
            path = Path(binding["path"])
            self.assertTrue(path.is_absolute())
            self.assertEqual(binding["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())

    def test_loader_does_not_override_unrelated_module_resolution(self):
        root = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory(dir=os.environ.get("ALE_TEST_SCRATCH")) as directory:
            workspace = Path(directory)
            outside = workspace / "outside.mjs"
            outside.write_text("try{await import('effect');console.log('unexpected')}catch(error){console.log(error.code)}")
            result = subprocess.run([shutil.which("node"), "--import", str(root / "evals/ale/runtime.mjs"), str(outside)], capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            baseline = subprocess.run([shutil.which("node"), str(outside)], capture_output=True, text=True, timeout=20)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (baseline.returncode, baseline.stdout, baseline.stderr))

    def test_real_host_bindings_resolve_from_workspace_without_install(self):
        root = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory(dir=os.environ.get("ALE_TEST_SCRATCH")) as directory:
            workspace = Path(directory)
            script = workspace / "flows/ale/loader-check.mjs"
            script.parent.mkdir(parents=True)
            script.write_text("""import { Flow } from '@smthrs/flow';
import * as AgentAction from '@smthrs/agent/AgentAction';
import { EventSink } from '@smthrs/agent/EventSink';
import { Schema } from 'effect';
import fs from 'node:fs';
let unknown;try{await import('@ale/nonexistent')}catch(error){unknown=error.code}
console.log(JSON.stringify({flow:typeof Flow.make,agent:typeof AgentAction.make,sink:!!EventSink,schema:!!Schema.String,fs:typeof fs.readFileSync,unknown,bindings:['@smthrs/flow','@smthrs/agent/AgentAction','@smthrs/agent/EventSink','effect'].map(name=>import.meta.resolve(name))}));
""")
            result = subprocess.run([shutil.which("node"), "--import", str(root / "evals/ale/runtime.mjs"), str(script)],
                cwd=workspace, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            values = json.loads(result.stdout)
            self.assertEqual(values["flow"], "function")
            self.assertEqual(values["agent"], "function")
            self.assertTrue(values["sink"])
            self.assertTrue(values["schema"])
            self.assertEqual(values["fs"], "function")
            self.assertEqual(values["unknown"], "ERR_MODULE_NOT_FOUND")
            self.assertTrue(all(str(root) in path for path in values["bindings"]))
            self.assertFalse((workspace / "node_modules").exists())


class SubprocessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("ALE_TEST_SCRATCH"))
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.agent = SmithersDeployer(SimpleNamespace(work_dir=str(self.work), config=SmithersConfig(root=str(self.work))))
        self.agent.root = self.work
        loader = self.work / "evals/ale/runtime.mjs"
        loader.parent.mkdir(parents=True)
        loader.write_text("// subprocess protocol fixture; loader tested against real packages separately")
        self.agent.node = shutil.which("node")
        self.assertIsNotNone(self.agent.node, "Node required for public subprocess test")
        self.agent.cli = self.work / "cli.mjs"
        self.agent.helper = self.work / "helper"
        self.agent.servers = [{"server": "vm", "command": "node", "args": ["bridge.js"]}]
        self.agent.flows = ["mcp/vm/read"]

    def script(self, text):
        self.agent.cli.write_text(text)

    async def test_public_launch_waits_for_flow_start_and_requires_receipt(self):
        self.script("""import fs from 'node:fs';
const args=process.argv.slice(2); const phase=args[0];
fs.appendFileSync('phases.jsonl', JSON.stringify({phase,args,auth:process.env.SMITHERS_OPENAI_AUTH,key:process.env.OPENAI_API_KEY,codexHome:process.env.CODEX_HOME})+'\\n');
console.log(JSON.stringify({status:"completed"}));
""")
        with patch.dict(os.environ, {"OPENAI_API_KEY": "metered"}):
            prompt = 'Read "quoted" `backticks` ${globalThis.pwned=true}\ninput'
            result = await self.agent.launch(prompt)
        self.assertEqual(result.status, "failed")
        self.assertIn("missing completed", result.error)
        workspace = self.work / "workspace"
        phases = [json.loads(line) for line in (workspace / "phases.jsonl").read_text().splitlines()]
        self.assertEqual([p["phase"] for p in phases], ["flow"])
        self.assertEqual(phases[0]["args"][:3], ["flow", "start", "ale"])
        self.assertIn("--wait", phases[0]["args"])
        self.assertTrue(all(p["auth"] == "chatgpt" and "key" not in p for p in phases))
        self.assertEqual(phases[0]["codexHome"], str(workspace / ".codex-disabled"))
        self.assertTrue((workspace / ".codex-disabled").is_dir())
        self.assertFalse((workspace / ".codex-disabled/auth.json").exists())
        flow = (workspace / "flows" / "ale" / "flow.ts").read_text()
        self.assertFalse((workspace / "flows" / "ale" / "flow.mdx").exists())
        self.assertIn('Flow.make("ale"', flow)
        self.assertIn('from "@smthrs/flow"', flow)
        self.assertIn('from "@smthrs/agent/AgentAction"', flow)
        self.assertIn('from "effect"', flow)
        self.assertNotIn('from "file:', flow)
        self.assertIn("AgentAction.make", flow)
        self.assertIn("Task.layer", flow)
        self.assertIn("Available remote tools: mcp/vm/read", flow)
        grants = json.loads(re.search(r"capabilities:\s*(\[[^\]]*\])", flow).group(1))
        self.assertNotIn("*", grants)
        action_source = (Path(__file__).resolve().parents[3] / "packages/smithers/flows/capability/src/Action.ts").read_text()
        known_actions = re.findall(r'"([a-z]+:[a-z-]+)"', action_source)
        self.assertEqual(set(grants), {action + ":**" for action in known_actions})
        literal = re.search(r'instruction:\s*("(?:\\.|[^"\\])*")', flow)
        self.assertIsNotNone(literal, "instruction must be a JSON string literal")
        self.assertTrue(json.loads(literal.group(1)).endswith(prompt))
        self.assertEqual(json.loads((workspace / "mcp.json").read_text()), self.agent.servers)
        receipt = json.loads((self.work / "smithers-run.json").read_text())
        self.assertEqual(receipt["phase"], "run")
        self.assertEqual(receipt["exit_code"], 0)

    async def test_success_requires_real_completed_journal(self):
        writer = self.work / "write_journal.py"
        writer.write_text("import sqlite3,json\nfrom pathlib import Path\nPath('.flows').mkdir()\nwith sqlite3.connect('.flows/control.db') as db:\n db.execute('CREATE TABLE flows_journal_events(seq INTEGER, emitted_at_ms INTEGER,event_type TEXT,payload_json TEXT)')\n for i,tag in enumerate(['control.agent.model-requested','control.agent.model-settled','control.run.completed']):\n  db.execute('INSERT INTO flows_journal_events VALUES(?,?,?,?)',(i,i,tag,json.dumps({'routeId':'openai-chatgpt','modelId':'gpt-6-sol','params':{'reasoningEffort':'max'},'text':'done'})))\n")
        self.script("import {spawnSync} from 'node:child_process'; const r=spawnSync(process.env.ALE_PYTHON,[process.env.ALE_WRITER],{stdio:'inherit'}); process.exit(r.status);")
        with patch.dict(os.environ, {"ALE_PYTHON": sys.executable, "ALE_WRITER": str(writer)}):
            result = await self.agent.launch("prompt")
        self.assertEqual(result.status, "completed")
        self.assertIsNone(result.error)
        self.assertEqual(result.exit_code, 0)
        receipt = json.loads((self.work / "smithers-run.json").read_text())
        self.assertIsNone(receipt["error"])

    async def test_success_combines_terminal_and_agent_evidence_from_separate_databases(self):
        writer = self.work / "write_split.py"
        writer.write_text("import sqlite3,json,os\nfrom pathlib import Path\nPath('.flows').mkdir()\nbase=json.loads(os.environ['ALE_FACT'])\nfor name,tags in [('control.db',['control.run.completed']),('engine.db',['control.agent.model-requested','control.agent.model-settled'])]:\n with sqlite3.connect('.flows/'+name) as db:\n  db.execute('CREATE TABLE flows_journal_events(seq INTEGER, emitted_at_ms INTEGER,event_type TEXT,payload_json TEXT)')\n  for i,tag in enumerate(tags):\n   payload={'routeId':'openai-chatgpt','modelId':'gpt-6-sol','params':{'reasoningEffort':'max'},'text':'done'}\n   wrapped=dict(base,eventType=tag,payload=payload) if name=='engine.db' else payload\n   db.execute('INSERT INTO flows_journal_events VALUES(?,?,?,?)',(i,i,'flows.harness.step-fact.v1' if name=='engine.db' else tag,json.dumps(wrapped)))\n")
        self.script("import {spawnSync} from 'node:child_process'; const r=spawnSync(process.env.ALE_PYTHON,[process.env.ALE_WRITER],{stdio:'inherit'}); process.exit(r.status);")
        with patch.dict(os.environ, {"ALE_PYTHON": sys.executable, "ALE_WRITER": str(writer), "ALE_FACT": json.dumps(step_fact("", {}))}):
            result = await self.agent.launch("prompt")
        self.assertEqual(result.status, "completed", result.error)
        receipt = json.loads((self.work / "smithers-run.json").read_text())
        self.assertEqual(len(receipt["bindings"]), 1)
        self.assertEqual(receipt["bindings"][0]["routeId"], "openai-chatgpt")

    async def test_reused_workspace_fails_without_consuming_stale_success(self):
        workspace = self.work / "workspace"
        workspace.mkdir()
        path = workspace / ".flows"
        path.mkdir()
        journal = path / "control.db"
        with sqlite3.connect(journal) as db:
            db.execute("CREATE TABLE flows_journal_events(seq INTEGER,emitted_at_ms INTEGER,event_type TEXT,payload_json TEXT)")
            for i,tag in enumerate(("control.run.completed", "control.agent.model-requested", "control.agent.model-settled")):
                db.execute("INSERT INTO flows_journal_events VALUES(?,?,?,?)", (i,i,tag,json.dumps({"routeId":"codex", "text":"stale earlier answer"})))
        before = journal.read_bytes()
        result = await self.agent.launch("new prompt")
        self.assertEqual(result.status, "failed")
        self.assertIn("workspace", result.error.lower())
        self.assertEqual(journal.read_bytes(), before)
        receipt = json.loads((self.work / "smithers-run.json").read_text())
        self.assertTrue(receipt["error"])
        self.assertEqual(receipt["bindings"], [])
        builder = TrajectoryBuilder(agent_name="smithers", task_path="new attempt", variant_index=0)
        self.agent.parse_artifacts(work_dir=self.work, config=self.agent.config, run_result=result, builder=builder)
        self.assertEqual([step.source for step in builder.trajectory.steps], ["system"])
        self.assertIn("workspace", builder.trajectory.steps[0].message)
        self.assertIsNone(builder.trajectory.final_metrics)

    async def test_completed_run_rejects_wrong_subscription_binding(self):
        writer = self.work / "write_binding.py"
        writer.write_text("import sqlite3,json,os\nfrom pathlib import Path\nPath('.flows').mkdir()\nwith sqlite3.connect('.flows/control.db') as db:\n db.execute('CREATE TABLE flows_journal_events(seq INTEGER, emitted_at_ms INTEGER,event_type TEXT,payload_json TEXT)')\n for i,tag in enumerate(['control.agent.model-requested','control.run.completed']):\n  db.execute('INSERT INTO flows_journal_events VALUES(?,?,?,?)',(i,i,tag,os.environ['ALE_BINDING']))\n")
        self.script("import {spawnSync} from 'node:child_process'; const r=spawnSync(process.env.ALE_PYTHON,[process.env.ALE_WRITER],{stdio:'inherit'}); process.exit(r.status);")
        for index, binding in enumerate([
            {"routeId": "codex", "modelId": "gpt-6-sol", "params": {"reasoningEffort": "max"}},
            {"truncated": True, "bytes": 300000, "digest": "unknown"},
            {"routeId": "openai", "modelId": "gpt-6-sol", "params": {"reasoningEffort": "max"}},
            {"routeId": "openai-chatgpt", "modelId": "gpt-6.1-sol", "params": {"reasoningEffort": "max"}},
            {"routeId": "openai-chatgpt", "modelId": "gpt-6-sol", "params": {"reasoningEffort": "high"}},
        ]):
            with self.subTest(binding=binding):
                run_dir = self.work / str(index)
                run_dir.mkdir()
                self.agent.executor.work_dir = str(run_dir)
                with patch.dict(os.environ, {"ALE_PYTHON": sys.executable, "ALE_WRITER": str(writer), "ALE_BINDING": json.dumps(binding)}):
                    result = await self.agent.launch("prompt")
                self.assertEqual(result.status, "failed")
                self.assertTrue(result.error)

    async def test_spawn_error_returns_failed_receipt_without_completion(self):
        self.agent.node = str(self.work / "missing-node")
        result = await self.agent.launch("prompt")
        self.assertEqual(result.status, "failed")
        self.assertIn("FileNotFoundError", result.error)
        self.assertIsNone(result.exit_code)
        receipt = json.loads((self.work / "smithers-run.json").read_text())
        self.assertEqual(receipt["error"], result.error)
        self.assertEqual(receipt["bindings"], [])

    async def test_cancellation_after_process_exit_handles_lookup_race(self):
        # Deterministic unit exception: kernel process disappearance races cannot
        # be scheduled reliably. Separate tests cancel and reap real Node trees.
        process = SimpleNamespace(pid=123, communicate=AsyncMock(side_effect=asyncio.CancelledError), wait=AsyncMock(return_value=0))
        with (self.work / "race.log").open("wb") as log:
            with patch("deployer.asyncio.create_subprocess_exec", AsyncMock(return_value=process)), patch("deployer.os.killpg", side_effect=ProcessLookupError):
                with self.assertRaises(asyncio.CancelledError):
                    await self.agent._command([], self.work, {}, log)
        self.assertEqual(process.wait.await_count, 2)
        self.assertEqual(self.agent.version, "ale-smithers-1")

    async def test_nonzero_flow_start_reports_failure(self):
        self.script("process.stderr.write('denied'); process.exit(7);")
        result = await self.agent.launch("prompt")
        self.assertEqual(result.status, "failed")
        self.assertEqual(result.exit_code, 7)
        self.assertEqual(result.error, "Smithers run exited 7")
        self.assertIn("denied", (self.work / "smithers-run.log").read_text())

    async def test_cancellation_kills_descendant_that_ignores_sigterm(self):
        self.script("""import fs from 'node:fs'; import {spawn} from 'node:child_process';
spawn(process.execPath,['-e',"require('fs').writeFileSync('child-pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
fs.writeFileSync('pid',String(process.pid));setInterval(()=>{},1000);
""")
        task = asyncio.create_task(self.agent.launch("prompt"))
        pid_file = self.work / "workspace" / "child-pid"
        for _ in range(300):
            if pid_file.exists():
                break
            await asyncio.sleep(.01)
        self.assertTrue(pid_file.exists())
        pid = int(pid_file.read_text())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        for _ in range(200):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            await asyncio.sleep(.01)
        else:
            os.kill(pid, 9)
            self.fail("cancelled CLI descendant remained alive")

    async def test_cancellation_reaps_real_cli_and_records_failure(self):
        self.script("""import fs from 'node:fs';
fs.writeFileSync('pid', String(process.pid)); setInterval(()=>{},1000);
""")
        task = asyncio.create_task(self.agent.launch("prompt"))
        pid_file = self.work / "workspace" / "pid"
        for _ in range(200):
            if pid_file.exists():
                break
            await asyncio.sleep(.01)
        self.assertTrue(pid_file.exists())
        pid = int(pid_file.read_text())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 4)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        receipt = json.loads((self.work / "smithers-run.json").read_text())
        self.assertEqual(receipt["error"], "cancelled")
        self.assertIsNone(receipt["exit_code"])


if __name__ == "__main__":
    unittest.main()
